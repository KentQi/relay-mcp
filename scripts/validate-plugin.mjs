#!/usr/bin/env node
// Agent Plugins v1.0.0 校验器(零依赖):plugin.json / mcp.json / skills/**/SKILL.md。
// 规范: https://agent-plugins.org/specification  schema: /schemas/1.0.0/{plugin,mcp}.schema.json
// 用法: node scripts/validate-plugin.mjs [pluginRoot]
// 退出码: 0 = 全部组件合规(fatal=0);1 = 存在 fatal(命中规范里的「拒绝/跳过」边界)。
// 本文件既是 CLI,也是可被冒烟脚本 import 的校验库(validatePlugin / expandPlaceholders / parseFrontmatter)。
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

// 规范 §5.2 / §5.4:plugin.json 闭集字段 + author 闭集字段。
export const MANIFEST_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
export const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);
// Agent Skills 规范:SKILL.md frontmatter 已知字段。
export const SKILL_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const issue = (level, scope, message, fix) => ({ level, scope, message, fix });
const fatal = (scope, message, fix) => issue('fatal', scope, message, fix);
const warn = (scope, message, fix) => issue('warn', scope, message, fix);

const readJson = (file) => {
  try { return { data: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
};

// realpath 后在 root 内才合规(规范 §4.1.3:包内路径解析不得逃出插件根)。
const withinRoot = (rootReal, target) => {
  let real;
  try { real = realpathSync(target); } catch { return true; } // 不存在:由调用方的存在性检查负责
  return real === rootReal || real.startsWith(rootReal + sep);
};
const normalizeWithin = (rootReal, target) => {
  const norm = resolve(target);
  return norm === rootReal || norm.startsWith(rootReal + sep);
};

// —— plugin.json ——
export const validateManifest = (root, rootReal) => {
  const issues = [];
  const file = join(root, 'plugin.json');
  if (!existsSync(file)) {
    return { data: null, issues: [fatal('plugin', '缺少插件根 manifest:plugin.json', '创建 plugin.json:{"$schema":"' + PLUGIN_SCHEMA + '","name":"<小写字母/数字/连字符>"}')] };
  }
  let st; try { st = lstatSync(file); } catch { st = null; }
  if (st && st.isSymbolicLink() && !withinRoot(rootReal, file)) {
    return { data: null, issues: [fatal('plugin', 'plugin.json 是符号链接且解析到插件根之外', '换回插件根内的常规文件;客户端按规范会拒绝整个插件')] };
  }
  const parsed = readJson(file);
  if (parsed.error) return { data: null, issues: [fatal('plugin', 'plugin.json 不是合法 JSON: ' + parsed.error, '修复 JSON 语法后重试')] };
  const d = parsed.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { data: null, issues: [fatal('plugin', 'plugin.json 顶层必须是 JSON 对象', '把清单改成对象形式')] };
  }
  for (const key of Object.keys(d)) {
    if (!MANIFEST_FIELDS.has(key)) {
      issues.push(issue('unknown', 'plugin', '未知顶层字段 "' + key + '"(闭集 schema:客户端会报告并忽略,不判插件无效)', '删除该字段;客户端专属数据放 extensions.<reverse.domain>'));
    }
  }
  if (d.$schema !== PLUGIN_SCHEMA) {
    issues.push(fatal('plugin', '$schema 必须是 ' + PLUGIN_SCHEMA + '(收到 ' + JSON.stringify(d.$schema) + ')', '把 plugin.json 的 $schema 改为规范 1.0.0 的规范标识'));
  }
  if (typeof d.name !== 'string' || !d.name) {
    issues.push(fatal('plugin', 'name 必填且必须是非空字符串', '填写 name(小写字母/数字/连字符/句点,1–64 字符)'));
  } else {
    if (d.name.length > 64) issues.push(fatal('plugin', 'name 超过 64 字符(' + d.name.length + ')', '缩短 name 到 ≤64 字符'));
    if (!PLUGIN_NAME_RE.test(d.name)) {
      issues.push(fatal('plugin', 'name 不合规:' + JSON.stringify(d.name) + '(只允许小写字母/数字/-/.,首尾字母数字,禁 -- 与 ..)', '改成如 my-plugin / acme.tools 形式'));
    }
  }
  for (const key of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (d[key] !== undefined && typeof d[key] !== 'string') {
      issues.push(fatal('plugin', key + ' 必须是字符串', '把 ' + key + ' 改为字符串'));
    }
  }
  if (d.author !== undefined) {
    if (!d.author || typeof d.author !== 'object' || Array.isArray(d.author)) {
      issues.push(fatal('plugin', 'author 必须是对象(仅 name/email/url)', '改成 {"name":"..."} 形式'));
    } else {
      for (const [k, v] of Object.entries(d.author)) {
        if (!AUTHOR_FIELDS.has(k)) issues.push(fatal('plugin', 'author 含未知字段 "' + k + '"(闭集)', '删除 author 里 name/email/url 之外的字段'));
        else if (typeof v !== 'string') issues.push(fatal('plugin', 'author.' + k + ' 必须是字符串', '改为字符串'));
      }
    }
  }
  if (d.keywords !== undefined) {
    if (!Array.isArray(d.keywords) || d.keywords.some((k) => typeof k !== 'string')) {
      issues.push(fatal('plugin', 'keywords 必须是字符串数组', '改成 ["mcp","relay"] 形式'));
    }
  }
  if (d.extensions !== undefined) {
    if (!d.extensions || typeof d.extensions !== 'object' || Array.isArray(d.extensions)) {
      issues.push(issue('unknown', 'plugin', 'extensions 不是对象(规范 §8.1:报告并忽略,不判插件无效)', '改为 { "<reverse.domain>": { ... } } 或删除'));
    } else {
      for (const [ns, val] of Object.entries(d.extensions)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) {
          issues.push(warn('plugin', 'extensions.' + ns + ' 不是对象(客户端会忽略该命名空间)', '客户端专属数据改成对象'));
        }
      }
    }
  }
  return { data: d, issues };
};

// —— mcp.json ——
const expand = (value, vars) => String(value).replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g,
  (token) => (token === '${PLUGIN_ROOT}' ? vars.pluginRoot : vars.pluginData));
export const expandPlaceholders = (value, vars = {}) => expand(value, { pluginRoot: vars.pluginRoot || '', pluginData: vars.pluginData || '' });

const isAbsHttps = (raw) => {
  let u; try { u = new URL(raw); } catch { return { ok: false, why: '不是合法 URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: '协议必须是 http/https' };
  if (u.username || u.password) return { ok: false, why: 'URL 不得包含 userinfo' };
  if (u.hash) return { ok: false, why: 'URL 不得包含 fragment' };
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && !LOOPBACK.has(host)) return { ok: false, why: '非 loopback 端点必须用 HTTPS' };
  return { ok: true, url: u };
};

export const validateServer = (name, conf, root, rootReal) => {
  const scope = 'mcp';
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) {
    return [fatal(scope, 'server "' + name + '" 必须是对象', '把该 server 改成 {"type":"stdio",...} 形式的对象')];
  }
  const type = conf.type;
  if (type === 'stdio') {
    const issues = [];
    const allowed = new Set(['type', 'command', 'args', 'env', 'cwd']);
    for (const key of Object.keys(conf)) if (!allowed.has(key)) issues.push(fatal(scope, 'server "' + name + '" 的 stdio 变体含未知字段 "' + key + '"', 'stdio 只允许 type/command/args/env/cwd'));
    if (typeof conf.command !== 'string' || !conf.command) {
      issues.push(fatal(scope, 'server "' + name + '" 缺 command(单个可执行 token)', '填写 command,如 "node" 或 "./bin/server"'));
    } else if (/\s/.test(conf.command)) {
      issues.push(fatal(scope, 'server "' + name + '" 的 command 不能是 shell 命令串(含空白):' + JSON.stringify(conf.command), 'command 只放一个 token,参数拆进 args'));
    } else if (conf.command.includes('${')) {
      issues.push(fatal(scope, 'server "' + name + '" 的 command 不做占位符展开: ' + JSON.stringify(conf.command), '占位符只能用于 args/env/cwd;command 用裸名或 ./ 相对路径'));
    } else if (conf.command.startsWith('./')) {
      if (!normalizeWithin(rootReal, resolve(root, conf.command)) || !withinRoot(rootReal, resolve(root, conf.command))) {
        issues.push(fatal(scope, 'server "' + name + '" 的 command 解析到插件根之外: ' + conf.command, '改成插件根内路径(./ 开头)'));
      }
    } else if (/[\\/]/.test(conf.command)) {
      issues.push(fatal(scope, 'server "' + name + '" 的 command 既不是裸名也不是 ./ 相对路径: ' + JSON.stringify(conf.command), '裸名(platform search)或 ./ 相对路径'));
    }
    if (conf.args !== undefined) {
      if (!Array.isArray(conf.args) || conf.args.some((a) => typeof a !== 'string')) issues.push(fatal(scope, 'server "' + name + '" 的 args 必须是字符串数组', '改成 ["--flag","${PLUGIN_ROOT}/x"]'));
    }
    if (conf.env !== undefined) {
      if (!conf.env || typeof conf.env !== 'object' || Array.isArray(conf.env)) {
        issues.push(fatal(scope, 'server "' + name + '" 的 env 必须是对象', '改成 { "KEY": "value" }'));
      } else {
        for (const [k, v] of Object.entries(conf.env)) {
          if (k === 'PLUGIN_ROOT' || k === 'PLUGIN_DATA') issues.push(fatal(scope, 'server "' + name + '" 的 env 不得覆盖保留变量 ' + k, '删除该 env 条目,客户端会自己提供'));
          else if (typeof v !== 'string') issues.push(fatal(scope, 'server "' + name + '" 的 env.' + k + ' 必须是字符串', '改为字符串'));
        }
      }
    }
    if (conf.cwd !== undefined) {
      if (typeof conf.cwd !== 'string') {
        issues.push(fatal(scope, 'server "' + name + '" 的 cwd 必须是字符串', '用 "./dir" / "${PLUGIN_ROOT}" / "${PLUGIN_DATA}" 形式'));
      } else if (!/^(\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(conf.cwd)) {
        issues.push(fatal(scope, 'server "' + name + '" 的 cwd 形式非法: ' + JSON.stringify(conf.cwd), 'cwd 必须 ./ 开头或以 ${PLUGIN_ROOT}/${PLUGIN_DATA} 为根'));
      } else {
        const expanded = expand(conf.cwd, { pluginRoot: rootReal, pluginData: '' });
        if (!conf.cwd.startsWith('${PLUGIN_DATA}')) {
          if (!normalizeWithin(rootReal, expanded) || !withinRoot(rootReal, expanded)) {
            issues.push(fatal(scope, 'server "' + name + '" 的 cwd 解析到插件根之外: ' + conf.cwd, '改到插件根内'));
          }
        }
      }
    }
    return issues;
  }
  if (type === 'streamable-http' || type === 'sse') {
    const issues = [];
    const allowed = new Set(['type', 'url', 'headers']);
    for (const key of Object.keys(conf)) if (!allowed.has(key)) issues.push(fatal(scope, 'server "' + name + '" 的 ' + type + ' 变体含未知字段 "' + key + '"', type + ' 只允许 type/url/headers'));
    if (typeof conf.url !== 'string') {
      issues.push(fatal(scope, 'server "' + name + '" 缺 url', '填写绝对 http(s) URL'));
    } else {
      if (conf.url.includes('${')) issues.push(fatal(scope, 'server "' + name + '" 的 url 不做占位符展开: ' + conf.url, 'url 用字面值;占位符只在 args/env/cwd'));
      const chk = isAbsHttps(conf.url);
      if (!chk.ok) issues.push(fatal(scope, 'server "' + name + '" 的 url 不合规(' + chk.why + '): ' + conf.url, '改为绝对 https URL(非 loopback);loopback 允许 http'));
    }
    if (conf.headers !== undefined) {
      if (!conf.headers || typeof conf.headers !== 'object' || Array.isArray(conf.headers)) {
        issues.push(fatal(scope, 'server "' + name + '" 的 headers 必须是对象', '改成 { "X-Tenant": "public" }'));
      } else {
        const seen = new Set();
        for (const [k, v] of Object.entries(conf.headers)) {
          if (typeof v !== 'string') issues.push(fatal(scope, 'server "' + name + '" 的 headers.' + k + ' 必须是字符串', '改为字符串'));
          const lower = k.toLowerCase();
          if (seen.has(lower)) issues.push(fatal(scope, 'server "' + name + '" 的 headers 有大小写重复的 ' + lower, '合并同名 header'));
          else seen.add(lower);
        }
      }
    }
    return issues;
  }
  return [fatal(scope, 'server "' + name + '" 的 type 未知: ' + JSON.stringify(type), 'type 只能是 stdio / streamable-http / sse')];
};

export const validateMcp = (root, rootReal) => {
  const file = join(root, 'mcp.json');
  if (!existsSync(file)) return { data: null, issues: [], present: false };
  const issues = [];
  let st; try { st = lstatSync(file); } catch { st = null; }
  if (st && st.isSymbolicLink() && !withinRoot(rootReal, file)) {
    return { data: null, present: true, issues: [fatal('mcp', 'mcp.json 是符号链接且解析到插件根之外', '换回常规文件(客户端会禁用该插件的 MCP)')] };
  }
  const parsed = readJson(file);
  if (parsed.error) return { data: null, present: true, issues: [fatal('mcp', 'mcp.json 不是合法 JSON: ' + parsed.error, '修复 JSON 语法')] };
  const d = parsed.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { data: null, present: true, issues: [fatal('mcp', 'mcp.json 顶层必须是 JSON 对象', '改成 { "$schema": ..., "mcpServers": {...} }')] };
  for (const key of Object.keys(d)) {
    if (key !== '$schema' && key !== 'mcpServers') issues.push(fatal('mcp', 'mcp.json 顶层不允许额外字段 "' + key + '"(闭集)', '只保留 $schema 与 mcpServers'));
  }
  if (d.$schema !== MCP_SCHEMA) issues.push(fatal('mcp', 'mcp.json 的 $schema 必须是 ' + MCP_SCHEMA + '(收到 ' + JSON.stringify(d.$schema) + ')', '改为规范 1.0.0 的 MCP schema 标识(且必须与 plugin.json 的版本一致)'));
  if (!d.mcpServers || typeof d.mcpServers !== 'object' || Array.isArray(d.mcpServers)) {
    issues.push(fatal('mcp', 'mcpServers 必须是对象(可以为空)', '改成 { "server-name": { ... } } 或 {}'));
  } else {
    for (const [name, conf] of Object.entries(d.mcpServers)) issues.push(...validateServer(name, conf, root, rootReal));
  }
  return { data: d, issues, present: true };
};

// —— skills/**/SKILL.md(Agent Skills 规范) ——
const parseMetadataBlock = (block) => {
  const map = {};
  for (const line of block) {
    const m = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
};
export const parseFrontmatter = (text) => {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { error: '缺少 YAML frontmatter(文件必须以 --- 开头并以 --- 结束 frontmatter)' };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!km) { i += 1; continue; }
    const key = km[1]; const rest = km[2].trim();
    if (rest === '>' || rest === '|' || rest === '') {
      const block = []; i += 1;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i].trim() === '')) { block.push(lines[i]); i += 1; }
      while (block.length && block[block.length - 1].trim() === '') block.pop();
      if (key === 'metadata') { data.metadata = parseMetadataBlock(block); }
      else { data[key] = block.map((l) => l.replace(/^\s+/, '')).join(rest === '|' ? '\n' : ' ').trim(); }
      continue;
    }
    let val = rest;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    data[key] = val;
    i += 1;
  }
  return { data };
};

export const validateSkills = (root, rootReal) => {
  const issues = [];
  const skills = [];
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return { skills, issues, present: false };
  if (!withinRoot(rootReal, dir)) return { skills, issues: [fatal('skills', 'skills/ 解析到插件根之外', '换回插件根内的常规目录')], present: true };
  let dstat; try { dstat = lstatSync(dir); } catch { /* ignore */ }
  if (!dstat || !dstat.isDirectory()) return { skills, issues: [fatal('skills', 'skills/ 存在但不是目录(规范 §6.2:skills 组件无效,其他组件继续加载)', '删除该路径或改成目录')], present: true };
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { /* ignore */ }
  for (const entry of entries) {
    const childPath = join(dir, entry.name);
    let cst; try { cst = lstatSync(childPath); } catch { continue; }
    if (cst.isSymbolicLink() && !withinRoot(rootReal, childPath)) {
      issues.push(fatal('skills', 'skills/' + entry.name + ' 是符号链接且解析到插件根之外(该 skill 会被跳过)', '把 skill 目录放进插件根内'));
      continue;
    }
    let isDir = cst.isDirectory();
    if (cst.isSymbolicLink()) { try { isDir = lstatSync(realpathSync(childPath)).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    const skillFile = join(childPath, 'SKILL.md');
    let fst; try { fst = lstatSync(skillFile); } catch { continue; } // 没有 SKILL.md 的子目录不是 skill
    if (!fst.isFile() && !fst.isSymbolicLink()) continue;
    if (fst.isSymbolicLink() && !withinRoot(rootReal, skillFile)) {
      issues.push(fatal('skills', 'skills/' + entry.name + '/SKILL.md 解析到插件根之外(该 skill 会被跳过)', '把 SKILL.md 放进 skill 目录'));
      continue;
    }
    const name = entry.name;
    const skill = { name, dir: childPath, data: null, valid: true, issues: [] };
    let text = '';
    try { text = readFileSync(skillFile, 'utf8'); } catch (e) { skill.issues.push(fatal('skill', name + ': 无法读取 SKILL.md(' + (e && e.message) + ')', '检查文件权限')); }
    const fm = parseFrontmatter(text);
    if (fm.error) { skill.issues.push(fatal('skill', name + ': ' + fm.error, '按 Agent Skills 规范补 frontmatter(name/description)')); }
    else {
      const d = fm.data;
      skill.data = d;
      for (const key of Object.keys(d)) if (!SKILL_FIELDS.has(key)) skill.issues.push(warn('skill', name + ': frontmatter 未知字段 "' + key + '"(当前规范未定义,客户端可能忽略)', '删掉或移入 metadata'));
      if (typeof d.name !== 'string' || !d.name) skill.issues.push(fatal('skill', name + ': 缺 name', '填 name,且必须等于父目录名'));
      else {
        if (d.name !== name) skill.issues.push(fatal('skill', name + ': name 必须等于父目录名(收到 ' + JSON.stringify(d.name) + ')', '把 name 改为 "' + name + '" 或重命名目录'));
        if (d.name.length > 64 || !SKILL_NAME_RE.test(d.name)) skill.issues.push(fatal('skill', name + ': name 不合规(1–64,小写字母/数字/连字符,首尾非连字符,禁 --)', '改成小写连字符形式'));
      }
      if (typeof d.description !== 'string' || !d.description.trim()) skill.issues.push(fatal('skill', name + ': description 必填且非空', '写 1–1024 字符,说明「做什么 + 何时用」'));
      else if (d.description.length > 1024) skill.issues.push(fatal('skill', name + ': description 超过 1024 字符(' + d.description.length + ')', '压缩到 ≤1024 字符'));
      if (d.license !== undefined && typeof d.license !== 'string') skill.issues.push(fatal('skill', name + ': license 必须是字符串', '填 SPDX 标识或 license 文件名'));
      if (d.compatibility !== undefined) {
        if (typeof d.compatibility !== 'string') skill.issues.push(fatal('skill', name + ': compatibility 必须是字符串', '填环境要求,1–500 字符'));
        else if (d.compatibility.length > 500) skill.issues.push(fatal('skill', name + ': compatibility 超过 500 字符', '压缩到 ≤500 字符'));
      }
      if (d.metadata !== undefined) {
        if (!d.metadata || typeof d.metadata !== 'object' || Array.isArray(d.metadata) || Object.values(d.metadata).some((v) => typeof v !== 'string')) skill.issues.push(fatal('skill', name + ': metadata 必须是字符串→字符串映射', '改成 metadata: { author: "...", version: "1.0" }'));
      }
      if (d['allowed-tools'] !== undefined && typeof d['allowed-tools'] !== 'string') skill.issues.push(fatal('skill', name + ': allowed-tools 必须是空格分隔字符串', '如 allowed-tools: Bash(git:*) Read'));
    }
    skill.valid = !skill.issues.some((x) => x.level === 'fatal');
    issues.push(...skill.issues);
    skills.push(skill);
  }
  return { skills, issues, present: true };
};

// —— 汇总 ——
export const validatePlugin = (rootArg = process.cwd()) => {
  const root = resolve(rootArg);
  if (!existsSync(root)) {
    return { ok: false, root, pluginValid: false, mcpValid: false, skillsValid: false, issues: [fatal('layout', '插件根不存在: ' + root, '检查路径')], manifest: null, mcp: null, skills: [] };
  }
  let rootReal; try { rootReal = realpathSync(root); } catch { rootReal = root; }
  const manifestRes = validateManifest(root, rootReal);
  const mcpRes = validateMcp(root, rootReal);
  const skillsRes = validateSkills(root, rootReal);
  const issues = [...manifestRes.issues, ...mcpRes.issues, ...skillsRes.issues];
  const hasFatal = (list) => list.some((x) => x.level === 'fatal');
  const pluginValid = !hasFatal(manifestRes.issues);
  const mcpValid = !hasFatal(mcpRes.issues);
  const skillsValid = !hasFatal(skillsRes.issues);
  return { ok: pluginValid && mcpValid && skillsValid, root: rootReal, pluginValid, mcpValid, skillsValid, manifest: manifestRes.data, mcp: mcpRes.data, skills: skillsRes.skills, issues };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const r = validatePlugin(process.argv[2] || process.cwd());
  const status = (valid) => (valid ? 'PASS' : 'FAIL');
  const lines = ['', '# Agent Plugins v1.0.0 校验 — ' + r.root, ''];
  lines.push('- plugin.json: ' + status(r.pluginValid) + (r.manifest && r.manifest.name ? ' (name=' + r.manifest.name + ', version=' + (r.manifest.version || '-') + ')' : ''));
  if (r.mcp) lines.push('- mcp.json: ' + status(r.mcpValid) + ' (servers: ' + Object.keys(r.mcp.mcpServers || {}).join(', ') + ')');
  else lines.push('- mcp.json: 缺省(合法)');
  lines.push('- skills/: ' + (r.skills.length === 0 ? '缺省(合法)' : r.skills.length + ' 个 (' + r.skills.map((s) => s.name + ' = ' + status(s.valid)).join(', ') + ')'));
  const bad = r.issues.filter((x) => x.level !== 'unknown');
  if (bad.length) {
    lines.push('', '## 问题');
    for (const x of r.issues) lines.push('- [' + x.level + '] ' + x.scope + ': ' + x.message + (x.fix ? '(修复: ' + x.fix + ')' : ''));
  }
  const fatalCount = r.issues.filter((x) => x.level === 'fatal').length;
  lines.push('', '## 汇总: ' + (r.ok ? '合规(0 fatal)' : fatalCount + ' 个 fatal') + ' · ' + r.issues.length + ' 个提示', '');
  console.log(lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}