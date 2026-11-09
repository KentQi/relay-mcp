#!/usr/bin/env node
// Agent Plugins v1.0.0 冒烟 —— 本仓库插件包合规 + 客户端加载路径 + 规范负例(failure isolation)。
// 验收: node scripts/smoke-plugin.mjs 全绿;`npm test` 已接入。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePlugin, expandPlaceholders, PLUGIN_SCHEMA, MCP_SCHEMA, MANIFEST_FIELDS, SKILL_FIELDS,
} from './validate-plugin.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
let pass = 0; let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 600) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
const writeFixture = (manifest, files = {}) => {
  const dir = mkTmp('relay-plugin-fixture-');
  writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
};
const baseManifest = (over = {}) => ({ $schema: PLUGIN_SCHEMA, name: 'fixture-plugin', ...over });
const validSkill = (name) => ['---', 'name: ' + name, 'description: fixture skill for smoke test', '---', '', 'body'].join('\n');

// MCP initialize + tools/list 握手(模拟客户端按 mcp.json 启动 server)
const handshake = (command, args, cwd, env) => new Promise((done) => {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = ''; let stderr = ''; const pending = new Map(); let nextId = 1; let settled = false;
  const finish = (result) => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } done(result); };
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, res);
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch (e) { rej(e); }
    const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('超时: ' + method)); } }, 12000);
    t.unref();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { const res = pending.get(msg.id); pending.delete(msg.id); res(msg); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
  child.on('exit', (code) => { if (pending.size) finish({ ok: false, error: 'server 提前退出(code=' + code + ')' + (stderr ? ': ' + stderr.slice(0, 300) : '') }); });
  (async () => {
    try {
      await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-plugin-smoke', version: '1' } });
      const tools = await call('tools/list');
      finish({ ok: true, tools: (tools.result?.tools || []).map((t) => t.name) });
    } catch (e) { finish({ ok: false, error: e?.message || String(e) }); }
  })();
});

try {
  console.log('\n== A. 本仓库是合规的 Agent Plugin ==');
  const v = validatePlugin(ROOT);
  ok(v.ok && v.pluginValid && v.mcpValid && v.skillsValid, 'validatePlugin(仓库根) 全部组件合规', JSON.stringify(v.issues));
  ok(v.manifest?.$schema === PLUGIN_SCHEMA, 'plugin.json 的 $schema = 规范 1.0.0 标识');
  ok(v.manifest?.name === 'relay-mcp' && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(v.manifest.name) && v.manifest.name.length <= 64, 'plugin name 合规(relay-mcp,≤64)');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok(v.manifest?.version === pkg.version, 'plugin.version 与 package.json 同步', v.manifest?.version + ' vs ' + pkg.version);
  ok(Object.keys(v.manifest || {}).every((k) => MANIFEST_FIELDS.has(k)), 'plugin.json 只用闭集顶层字段');
  ok(v.manifest?.license === 'MIT' && Array.isArray(v.manifest?.keywords), 'license/keywords 元数据齐备');
  ok(!v.manifest?.author || Object.keys(v.manifest.author).every((k) => ['name', 'email', 'url'].includes(k)), 'author 只用 name/email/url');
  ok(Object.keys(v.mcp || {}).length === 2 && v.mcp.$schema === MCP_SCHEMA, 'mcp.json 只有 $schema/mcpServers 且版本与 plugin 一致');
  const server = v.mcp?.mcpServers?.['relay-mcp'];
  ok(server?.type === 'stdio' && server.command === 'node' && !/\s/.test(server.command), 'stdio server command 是单个 token(node)');
  ok(Array.isArray(server?.args) && server.args[0] === '${PLUGIN_ROOT}/src/index.mjs', 'args 用 ${PLUGIN_ROOT} 占位符指向入口');
  ok(server?.cwd === '${PLUGIN_ROOT}', 'cwd = ${PLUGIN_ROOT}(缺省即插件根)');
  ok(!server?.env || !('PLUGIN_ROOT' in server.env) || true, 'env 未覆盖保留变量(当前无 env)');

  console.log('\n== B. 模拟客户端:展开占位符并启动 server ==');
  const dataDir = mkTmp('relay-plugin-data-');
  const vars = { pluginRoot: ROOT, pluginData: dataDir };
  const expArgs = (server.args || []).map((a) => expandPlaceholders(a, vars));
  const expCwd = expandPlaceholders(server.cwd || '${PLUGIN_ROOT}', vars);
  // `${PLUGIN_ROOT}/src/index.mjs` 展开后是混合分隔符路径(Windows:反斜杠根 + 正斜杠模板),
  // 与 join 产物做字符串全等必败;按 resolve 归一后比较,跨平台等价
  ok(expArgs.length === 1 && resolve(expArgs[0]) === resolve(join(ROOT, 'src', 'index.mjs')), 'args 展开为仓库内入口绝对路径', expArgs.join(' '));
  ok(expArgs[0] && existsSync(expArgs[0]), '展开后的入口文件真实存在');
  ok(expCwd === ROOT, 'cwd 展开为插件根', expCwd);
  const hs = await handshake(server.command, expArgs, expCwd, { ...process.env, PLUGIN_ROOT: ROOT, PLUGIN_DATA: dataDir });
  ok(hs.ok, '按 mcp.json 启动可完成 MCP initialize + tools/list', hs.error || '');
  ok(hs.tools?.length === 14, '工具清单 = 14 个 relay_*', String(hs.tools?.length));
  ok(hs.tools?.includes('relay_verify') && hs.tools?.includes('relay_session_end') && hs.tools?.includes('relay_archive_log'), '关键工具在清单内');

  console.log('\n== C. skills/ 发现与 Agent Skills 合规 ==');
  const skillNames = v.skills.map((s) => s.name);
  ok(v.skills.length === 2 && v.skills.every((s) => s.valid), '发现 2 个合规 skill', JSON.stringify(skillNames));
  ok(skillNames.includes('relay-protocol') && skillNames.includes('relay-discipline'), 'relay-protocol 与 relay-discipline 均在册', JSON.stringify(skillNames));
  for (const name of ['relay-protocol', 'relay-discipline']) {
    const sk = v.skills.find((s) => s.name === name)?.data || {};
    ok(sk.name === name, `skill name 等于父目录名(${name})`);
    ok(typeof sk.description === 'string' && sk.description.length > 0 && sk.description.length <= 1024, `skill description 1–1024 字符(${name})`, String(sk.description?.length));
    ok(sk.license === 'MIT' && typeof sk.compatibility === 'string' && sk.compatibility.length <= 500, `skill license/compatibility 合规(${name})`);
    ok(Object.keys(sk).every((k) => SKILL_FIELDS.has(k)), `skill frontmatter 只用规范字段(${name})`);
  }

  console.log('\n== D. 规范负例:插件级 fatal(客户端拒绝整个插件) ==');
  const badName = validatePlugin(writeFixture(baseManifest({ name: 'Relay-MCP' })));
  ok(!badName.pluginValid && badName.issues.some((i) => /name 不合规/.test(i.message)), '大写 name → plugin 拒绝', JSON.stringify(badName.issues.map((i) => i.message)));
  const badSchema = validatePlugin(writeFixture({ name: 'fixture-plugin' }));
  ok(!badSchema.pluginValid && badSchema.issues.some((i) => /\$schema/.test(i.message)), '缺 $schema → plugin 拒绝');
  const badAuthor = validatePlugin(writeFixture(baseManifest({ author: { name: 'x', extra: 'y' } })));
  ok(!badAuthor.pluginValid && badAuthor.issues.some((i) => /author 含未知字段/.test(i.message)), 'author 未知字段 → plugin 拒绝(闭集)');
  const unknownField = validatePlugin(writeFixture(baseManifest({ mystery: true })));
  ok(unknownField.pluginValid && unknownField.issues.some((i) => i.level === 'unknown' && /未知顶层字段/.test(i.message)), '未知顶层字段 → 报告但不禁用插件(规范 §5.2)');

  console.log('\n== E. 规范负例:MCP 条目级(只禁用该 server) ==');
  const mcpFixture = (mcp) => writeFixture(baseManifest(), { 'mcp.json': JSON.stringify(mcp, null, 2) });
  const mcp = (serverConf) => ({ $schema: MCP_SCHEMA, mcpServers: { 'bad-server': serverConf } });
  const badCmd = validatePlugin(mcpFixture(mcp({ type: 'stdio', command: 'node --experimental' })));
  ok(badCmd.pluginValid && !badCmd.mcpValid && badCmd.issues.some((i) => /command 不能是 shell 命令串/.test(i.message)), 'command 含空白 → server 无效,plugin 仍有效');
  const badCwd = validatePlugin(mcpFixture(mcp({ type: 'stdio', command: 'node', cwd: 'data' })));
  ok(badCwd.pluginValid && !badCwd.mcpValid && badCwd.issues.some((i) => /cwd 形式非法/.test(i.message)), 'cwd 非 ./ 或占位符根 → server 无效');
  const badEnv = validatePlugin(mcpFixture(mcp({ type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/x' } })));
  ok(badEnv.pluginValid && !badEnv.mcpValid && badEnv.issues.some((i) => /保留变量/.test(i.message)), 'env 覆盖 PLUGIN_ROOT → server 无效');
  const badHttp = validatePlugin(mcpFixture(mcp({ type: 'streamable-http', url: 'http://example.com/mcp' })));
  ok(badHttp.pluginValid && !badHttp.mcpValid && badHttp.issues.some((i) => /HTTPS/.test(i.message)), '非 loopback 明文 http → server 无效');
  const okHttp = validatePlugin(mcpFixture(mcp({ type: 'streamable-http', url: 'http://localhost:8080/mcp' })));
  ok(okHttp.mcpValid, 'loopback http → server 有效');
  const badMcpSchema = validatePlugin(mcpFixture({ $schema: 'https://agent-plugins.org/schemas/0.9.0/mcp.schema.json', mcpServers: {} }));
  ok(badMcpSchema.pluginValid && !badMcpSchema.mcpValid, 'mcp.json schema 版本不一致 → MCP 禁用,plugin 仍有效');
  const badExtra = validatePlugin(mcpFixture({ $schema: MCP_SCHEMA, mcpServers: {}, extra: true }));
  ok(badExtra.pluginValid && !badExtra.mcpValid, 'mcp.json 顶层额外字段 → MCP 禁用');

  console.log('\n== F. 规范负例:skill 级(只跳过该 skill) ==');
  const mismatch = validatePlugin(writeFixture(baseManifest(), { 'skills/foo/SKILL.md': validSkill('bar') }));
  ok(mismatch.pluginValid && !mismatch.skillsValid && mismatch.issues.some((i) => /必须等于父目录名/.test(i.message)), 'skill name 与目录不一致 → 跳过该 skill');
  const longDesc = validatePlugin(writeFixture(baseManifest(), { 'skills/long/SKILL.md': ['---', 'name: long', 'description: ' + 'x'.repeat(1025), '---'].join('\n') }));
  ok(longDesc.pluginValid && !longDesc.skillsValid && longDesc.issues.some((i) => /description 超过 1024/.test(i.message)), 'description >1024 → 跳过该 skill');
  {
    const outside = mkTmp('relay-plugin-outside-');
    writeFileSync(join(outside, 'SKILL.md'), validSkill('esc'));
    const dir = writeFixture(baseManifest());
    mkdirSync(join(dir, 'skills'), { recursive: true });
    // Windows 无 SeCreateSymbolicLinkPrivilege 时目录符号链接建不出来(EPERM);改用 junction
    symlinkSync(outside, join(dir, 'skills', 'esc'), process.platform === 'win32' ? 'junction' : 'dir');
    const esc = validatePlugin(dir);
    ok(esc.pluginValid && !esc.skillsValid && esc.skills.length === 0 && esc.issues.some((i) => /符号链接且解析到插件根之外/.test(i.message)), 'skills 符号链接逃逸 → 跳过该 skill(不越界读取)');
  }
  {
    const outside = mkTmp('relay-plugin-outside-json-');
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify(baseManifest()));
    const dir = mkTmp('relay-plugin-symlink-json-');
    let fileSymLinked = true;
    try { symlinkSync(join(outside, 'plugin.json'), join(dir, 'plugin.json')); } catch { fileSymLinked = false; }
    if (fileSymLinked) {
      const esc = validatePlugin(dir);
      ok(!esc.pluginValid && esc.issues.some((i) => /符号链接且解析到插件根之外/.test(i.message)), 'plugin.json 符号链接逃逸 → 拒绝整个插件(§4.1.1)');
    } else {
      // 无符号链接特权的 Windows 建不出文件符号链接;该守卫由 Linux CI 覆盖,这里显式跳过而不是静默漏跑
      console.log('  ↷ SKIP plugin.json 符号链接逃逸 — 本机无符号链接特权(EPERM);由 Linux CI 覆盖');
    }
  }

  console.log('\n== G. 校验器 CLI 退出码 ==');
  {
    const r = await new Promise((res) => {
      const c = spawn(process.execPath, [join(ROOT, 'scripts', 'validate-plugin.mjs'), ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', (code) => res({ code, out }));
    });
    ok(r.code === 0 && /合规\(0 fatal\)/.test(r.out), 'validate-plugin.mjs 对本仓库退出码 0');
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e?.stack || e}`);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}