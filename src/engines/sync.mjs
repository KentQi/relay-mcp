// relay-mcp · W3 — relay_sync + 入口文件生成(供 init/onboard 复用)
// 依据 CONTRACT.md「仓库文件格式」「安全与降级」「工具清单」:
// - 入口文件模板在运行时从 templates/<name>.tpl 读取,占位符
//   {{PROJECT_NAME}} / {{TODAY}} / __RELAY_HOME__ 由本引擎替换,.tpl 去后缀落盘;
// - relay 标记 = `<!-- relay:generated`(R1 只认这个前缀);
// - sync:对 manifest.entryFiles 逐个对账,缺失→重建,漂移/缺标记→先备份再重写并给差异摘要;
// - 非破坏:任何重写前先 backupFile,永不删除用户文件;manifest 缺失/损坏 → isError。
// 零依赖:仅 node: 内置。

import { basename, dirname, join, relative, resolve } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { acquireRepoLock, backupFile, readFileSafe, releaseRepoLock, stamp, templatesDir } from '../util.mjs';

const MARKER_PREFIX = '<!-- relay:generated';
const MARKER = '<!-- relay:generated v1 -->';
const USER_START_PREFIX = '<!-- relay:user-rules-start';
const USER_END_PREFIX = '<!-- relay:user-rules-end';
const USER_START_LINE = '<!-- relay:user-rules-start(本区为项目自定义规范,relay_sync 只保留不改写) -->';
const USER_END_LINE = '<!-- relay:user-rules-end -->';
const DEFAULT_ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

// 提取用户保留区(标记对及其内容,不含尾随换行);无标记返回 null
const extractUserBlock = (text) => {
  const i = String(text || '').indexOf(USER_START_PREFIX);
  if (i < 0) return null;
  const j = String(text).indexOf(USER_END_PREFIX, i);
  if (j < 0) return null;
  const nl = String(text).indexOf('\n', j);
  return nl < 0 ? String(text).slice(i) : String(text).slice(i, nl);
};

// 投影合成(M2):模板再生结果 + 现有文件中的用户保留区。
// 模板自带空保留区则原位替换;无标记区(纯指针文件)则不加;用户区存在而模板无区则追加。
const composeProjection = (generated, current) => {
  const cur = extractUserBlock(current);
  if (!cur) return generated;
  const gen = extractUserBlock(generated);
  if (gen != null) return gen === cur ? generated : generated.replace(gen, cur);
  return `${generated.replace(/\s*$/, '')}\n\n${cur}`;
};

const ok = (text) => ({ content: [{ type: 'text', text }], isError: false });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

const pathExists = async (p) => {
  try { await access(p); return true; } catch { return false; }
};

const firstLine = (s) => (String(s || '').trim().split('\n')[0] || '').slice(0, 160);

const relOf = (root, p) => (p ? relative(root, p) : '(无)');

const buildVars = (root, ctx = {}) => ({
  projectName: ctx.projectName || basename(resolve(root || process.cwd())),
  today: ctx.today || stamp().slice(0, 10),
  relayHome: ctx.relayHome || dirname(templatesDir()),
});

const render = (raw, vars) => raw
  .replaceAll('{{PROJECT_NAME}}', vars.projectName)
  .replaceAll('{{TODAY}}', vars.today)
  .replaceAll('__RELAY_HOME__', vars.relayHome);

const renderTemplate = async (tplRel, vars) => {
  const raw = await readFileSafe(join(templatesDir(), tplRel), null);
  return raw === null ? null : render(raw, vars);
};

// 行级差异摘要:掐掉公共前后缀,报告中间变动段(示例最多 3 行,每行截 80 字符)
const diffSummary = (oldText, newText) => {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - suf
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const oldMid = a.slice(pre, a.length - suf);
  const newMid = b.slice(pre, b.length - suf);
  const sample = (lines) => {
    const shown = lines.filter((l) => l.trim() !== '').slice(0, 3)
      .map((l) => `  ${l.trim().slice(0, 80)}`);
    return shown.length ? shown.join('\n') : '  (空)';
  };
  const parts = [`第 ${pre + 1} 行起:旧 ${oldMid.length} 行 / 新 ${newMid.length} 行`];
  if (oldMid.length) parts.push(`旧:\n${sample(oldMid)}`);
  if (newMid.length) parts.push(`新:\n${sample(newMid)}`);
  return parts.join('\n');
};

// 生成/接管入口文件(init 与 onboard 的公共路径)。
// ctx:
//   mode      'init' | 'onboard' | 'sync'(默认 'init')
//   force     bool,仅 init 模式生效:已存在的入口文件备份后重写
//   entryFiles 入口文件名列表,默认 ['AGENTS.md','CLAUDE.md','GEMINI.md'](sync 传 manifest.entryFiles)
//   projectName / today / relayHome 可选,缺省按 root 与 templatesDir() 推导
// 返回 { created: string[], kept: {file,reason}[], rewritten: {file,backup,note,diff?}[], notes: string[] }
export const generateEntryFiles = async (root, ctx = {}) => {
  const mode = ctx.mode || 'init';
  const force = ctx.force === true;
  const takeover = ctx.takeover === true;
  const vars = buildVars(root, ctx);
  // P5:空数组是合法取值(「本仓不投影任何入口文件」),不再被当成「未配置」回落默认三份
  const files = Array.isArray(ctx.entryFiles) ? ctx.entryFiles : [...DEFAULT_ENTRY_FILES];
  const result = { created: [], kept: [], rewritten: [], drift: [], notes: [] };

  for (const name of files) {
    if (typeof name !== 'string' || !name) continue;
    const generated = await renderTemplate(`${name}.tpl`, vars);
    if (generated === null) {
      result.notes.push(`templates/${name}.tpl 缺失,${name} 跳过`);
      continue;
    }
    const target = join(root, name);
    const current = await readFileSafe(target, null);

    if (current === null) {
      await writeFile(target, generated, 'utf8');
      result.created.push(name);
      continue;
    }
    const hasMarker = current.includes(MARKER_PREFIX);
    // M2:重投影永不冲掉项目自定义规范——先合成(模板 + 用户保留区)再比较/落盘
    const projection = composeProjection(generated, current);
    if (current === projection) {
      result.kept.push({ file: name, reason: '与模板再生内容一致(含用户保留区)' });
      continue;
    }

    if (mode === 'init') {
      if (force) {
        const backup = await backupFile(target);
        await writeFile(target, projection, 'utf8');
        result.rewritten.push({ file: name, backup, note: 'force 重新初始化,原文件已备份(用户保留区已携带)' });
      } else {
        result.kept.push({ file: name, reason: '已存在,未改动(非破坏)' });
      }
    } else if (mode === 'onboard') {
      if (hasMarker) {
        result.kept.push({ file: name, reason: '已带 relay 标记,视为已接管' });
      } else if (name === 'AGENTS.md') {
        // 规范入口(canonical):备份后,原正文整体包进「用户保留区」——relay_sync 重投影时只保留不改写
        const backup = await backupFile(target);
        const merged = [
          MARKER,
          '开工前先读 ./START.md',
          '',
          '# 项目自定义规范(下方保留区:relay_sync 重投影时原样保留)',
          USER_START_LINE,
          String(current).trimEnd(),
          USER_END_LINE,
          '',
        ].join('\n');
        await writeFile(target, merged, 'utf8');
        result.rewritten.push({
          file: name,
          backup,
          note: '备份后将原正文包进用户保留区(user-rules),顶部插入 relay 标记与「开工前先读 ./START.md」',
        });
      } else {
        result.kept.push({ file: name, reason: '已存在,未接管(仅在缺失时生成)' });
      }
    } else if (!hasMarker && !takeover) {
      // P5 默认路径:已存在但无 relay 标记 = 项目自有文件,relay 不接管。
      // 改写它会把老规范(如 2000+ 行 CLAUDE.md)冲成 2 行指针,而用户从未要求过投影 ——
      // 契约「非破坏:永不删除用户文件」在此被提升为「不主动改写」。
      result.kept.push({ file: name, reason: '已存在且无 relay 标记,未接管(非破坏)' });
      result.drift.push({ file: name, diff: diffSummary(current, projection) });
    } else { // sync:带标记 → 强制对齐模板投影(用户保留区原样携带);重写前必先备份
      const backup = await backupFile(target);
      await writeFile(target, projection, 'utf8');
      result.rewritten.push({
        file: name,
        backup,
        note: `${hasMarker ? '带 relay 标记但与模板投影漂移' : 'manifest.entryFilesTakeover=true,强制接管(无标记)'}${extractUserBlock(current) ? '(用户保留区已携带)' : ''}`,
        diff: diffSummary(current, projection),
      });
    }
  }
  return result;
};

export const relaySync = async (args = {}) => {
  const root = resolve((args && args.root) || process.cwd());
  try {
    const manifestPath = join(root, '.relay', 'manifest.json');
    const raw = await readFileSafe(manifestPath, null);
    if (raw === null) {
      return err([
        '未找到 .relay/manifest.json,无法对账入口文件。',
        '- 新项目请先运行 relay_init',
        '- 现有项目请先运行 relay_onboard',
      ].join('\n'));
    }
    let manifest = null;
    try { manifest = JSON.parse(raw); }
    catch (e) {
      return err(`.relay/manifest.json 解析失败:${firstLine(e && e.message)}。请人工修复,或重新 relay_init / relay_onboard。`);
    }
    // P5:manifest.entryFiles 原样取用;空数组 = 「不投影任何入口文件」,不再回落默认三份
    const entryFiles = Array.isArray(manifest.entryFiles) ? manifest.entryFiles : [...DEFAULT_ENTRY_FILES];
    const takeover = manifest.entryFilesTakeover === true;

    // 仓库级写锁:入口重投影期间独占(与 session_end / claim 同一把)
    const sLock = await acquireRepoLock(root, 'sync');
    if (!sLock.ok) return err(`另一会话(**${sLock.holder}**)正在本仓库出场/认领,请稍后重试。`);
    let res;
    try {
    const res = await generateEntryFiles(root, {
      mode: 'sync',
      entryFiles,
      takeover,
      projectName: typeof manifest.projectName === 'string' && manifest.projectName
        ? manifest.projectName : undefined,
      relayHome: typeof manifest.relayHome === 'string' && manifest.relayHome
        ? manifest.relayHome : undefined,
    });

    const rows = [];
    for (const f of res.created) rows.push(`| ${f} | 重建(原缺失) |`);
    for (const k of res.kept) rows.push(`| ${k.file} | 一致(${k.reason}) |`);
    for (const r of res.rewritten) rows.push(`| ${r.file} | 重写(${r.note};备份: ${relOf(root, r.backup)}) |`);
    for (const n of res.notes) rows.push(`| — | 跳过:${n} |`);

    const lines = [
      `## relay:sync — 入口文件对账(${entryFiles.length} 个${entryFiles.length === 0 ? ',manifest.entryFiles 为空数组:本次不投影任何入口文件' : ''})`,
      '',
      '| 文件 | 结果 |',
      '|---|---|',
      ...rows,
    ];
    if (res.drift.length) {
      lines.push('', '### 未接管(已存在、无 relay 标记)—— relay 未改写这些文件', '',
        ...res.drift.map((d) => `- ${d.file}:与模板投影有出入,relay 未改写。如需接管:先加 \`<!-- relay:generated v1 -->\` 或在 manifest 置 \`"entryFilesTakeover": true\`,再跑 relay_sync`));
    }
    if (res.rewritten.length) {
      lines.push('', '### 漂移摘要');
      for (const r of res.rewritten) {
        lines.push(`- ${r.file}(原文件已备份至 ${relOf(root, r.backup)})`);
        if (r.diff) lines.push(...r.diff.split('\n').map((l) => `  ${l}`));
      }
    } else if (!res.created.length) {
      // P5:存在「未接管但与模板有出入」的项时,不得谎报「全部一致,无漂移」
      lines.push('', res.drift.length
        ? '未新建任何入口文件;其余入口文件要么已被 relay 投影,要么按非破坏原则保持原样(见上方「未接管」小节)。'
        : '全部入口文件与模板再生内容一致,无漂移。');
    } else {
      lines.push('', '存在缺失文件,已按模板重建。');
    }
    if (res.notes.length) lines.push('', '### 说明', ...res.notes.map((n) => `- ${n}`));
    lines.push('', '下一步:可运行 relay_verify 复核 R1(入口文件标记)。');
    return ok(lines.join('\n'));
    } finally {
      await releaseRepoLock(root);
    }
  } catch (e) {
    return err(`relay_sync 执行失败:${firstLine(e && e.message) || String(e)}`);
  }
};
