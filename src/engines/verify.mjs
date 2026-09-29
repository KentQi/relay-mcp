// relay-mcp — W4 验证引擎:R1–R9 检查器与 relay_verify。
// 依据 CONTRACT.md「检查器规则表」「仓库文件格式」「安全与降级」。
// TASKS 任务行与 LOG 条目标题的正则与契约逐字符一致,绝不改动;
// 每条非 PASS 结果都附一条以「修复:」开头的可执行指令。
import { readFileSafe, isGitRepo, gitRun } from '../util.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// —— 契约正则(逐字符照抄)——
export const TASK_LINE_RE = /^- \[( |~|x)\] (T\d+) (.*?)(?:  \((.*)\))?$/;
export const LOG_TITLE_RE = /^## (.+?) \| model=(.+?) \| task=(.+)$/;
const DOC_NAME_RE = /^[0-9]{2}-(sow|prd|ard|test|delivery)?-.*-v\d+\.\d+\.md$/;
const TIME_WORDS_RE = /TODO|进行中|下周|待办:/;

const DEFAULT_ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

// —— 结果构造:PASS / WARN / ERROR / SKIP,fix 为「修复:」后的指令文本 ——
const pass = (id, detail) => ({ id, result: 'PASS', detail, fix: null });
const bad = (id, result, detail, fix) => ({ id, result, detail, fix: `修复: ${fix}` });
const skip = (id, detail, fix) => ({ id, result: 'SKIP', detail, fix: fix ? `修复: ${fix}` : null });

const readText = async (p) => {
  const t = await readFileSafe(p, null);
  return typeof t === 'string' ? t : null;
};

const readManifest = async (root) => {
  const t = await readText(join(root, '.relay', 'manifest.json'));
  if (t == null) return null;
  try {
    const m = JSON.parse(t);
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
};

// LOG 条目解析(最新在上:文件顺序即时间倒序)
export const parseLogEntries = (text) => {
  const out = [];
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(LOG_TITLE_RE);
    if (m) out.push({ time: m[1], model: m[2], task: m[3] });
  }
  return out;
};

// —— R1 入口文件齐全且带 relay 标记 ——
const checkR1 = async (root, manifest) => {
  if (!manifest) {
    return bad('R1', 'ERROR', '未找到 .relay/manifest.json,无法确定入口文件清单', '先运行 relay_init(0→1 新项目)或 relay_onboard(老项目接入)生成 manifest');
  }
  const files = Array.isArray(manifest.entryFiles) ? manifest.entryFiles.filter((f) => typeof f === 'string') : [];
  if (!files.length) {
    return skip('R1', 'manifest.entryFiles 为空,无入口要求', '如需单源投影,在 manifest.entryFiles 登记入口文件后运行 relay_sync');
  }
  const missing = [];
  const unmarked = [];
  for (const f of files) {
    const t = await readText(join(root, f));
    if (t == null) { missing.push(f); continue; }
    const firstLine = t.split('\n', 1)[0] || '';
    if (!firstLine.includes('<!-- relay:generated')) unmarked.push(f);
  }
  if (missing.length || unmarked.length) {
    const parts = [];
    if (missing.length) parts.push(`缺失: ${missing.join(', ')}`);
    if (unmarked.length) parts.push(`首行无 <!-- relay:generated 标记: ${unmarked.join(', ')}`);
    return bad('R1', 'ERROR', parts.join(';'), `运行 relay_sync {root:"${root}"} 重新生成入口文件(${[...missing, ...unmarked].join(', ')});内容改动请回到模板/规范单源,勿手改入口`);
  }
  return pass('R1', `入口文件齐全且带标记: ${files.join(', ')}`);
};

// —— R2 顶层结构白名单 ——
// 注:git 默认 core.quotePath 会把非 ASCII 路径加引号转义,统一关闭以保证顶层段准确。
const topLevelFromGit = async (root) => {
  const tops = new Set();
  const tracked = await gitRun(root, '-c', 'core.quotePath=false', 'ls-files');
  if (tracked.ok) for (const l of tracked.stdout.split('\n')) { const p = l.trim(); if (p) tops.add(p.split('/')[0]); }
  const untracked = await gitRun(root, '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard');
  if (untracked.ok) for (const l of untracked.stdout.split('\n')) { const p = l.trim(); if (p) tops.add(p.split('/')[0]); }
  return tracked.ok || untracked.ok ? tops : null;
};

const checkR2 = async (root, manifest) => {
  if (!manifest || !Array.isArray(manifest.allowedTopLevel)) {
    return skip('R2', '无 manifest.allowedTopLevel 白名单,跳过', '先 relay_init / relay_onboard 生成 .relay/manifest.json');
  }
  const allowed = new Set(manifest.allowedTopLevel);
  let tops = null;
  let via = '';
  if (isGitRepo(root)) {
    const t = await topLevelFromGit(root);
    if (t) { tops = t; via = 'git ls-files(已跟踪+未跟踪)'; }
  }
  if (!tops) {
    try {
      const entries = await readdir(root);
      tops = new Set(entries.filter((e) => e !== '.git' && e !== 'node_modules'));
      via = 'readdir 降级(非 git 仓库)';
    } catch (e) {
      return skip('R2', `无法列举顶层条目: ${e.message}`, '确认 root 路径存在且可读');
    }
  }
  // relay 自己的备份(*.relay-bak-*)不算越界——它是引擎非破坏写的合法副产物
  const violations = [...tops].filter((t) => !allowed.has(t) && !t.includes('.relay-bak-')).sort();
  if (violations.length) {
    return bad('R2', 'ERROR', `顶层越界(${via}): ${violations.join(', ')} ⊄ allowedTopLevel`, `显式修宪:编辑 .relay/manifest.json 的 allowedTopLevel 加入 [${violations.join(', ')}];或删除/迁移越界条目。未修宪前不得出场`);
  }
  return pass('R2', `顶层结构合规(${via},共 ${tops.size} 项)`);
};

// —— R3 docs 命名 + frontmatter(宽松模式 = manifest 无 strictDocs 标记)——
const listDocsMd = async (docsDir) => {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'templates' || e.name === 'archive') continue; // 契约豁免
        await walk(join(dir, e.name), rel);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (rel === 'README.md') continue; // docs/README.md 是索引,豁免
        out.push(rel);
      }
    }
  };
  await walk(docsDir, '');
  return out.sort();
};

const frontmatterOk = (text) => {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if ((lines[0] || '').trim() !== '---') return false;
  let title = false;
  let status = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === '---') return title && status;
    if (/^title\s*:/.test(l)) title = true;
    if (/^status\s*:/.test(l)) status = true;
  }
  return false;
};

const checkR3 = async (root, manifest) => {
  let docsExists = true;
  try { await readdir(join(root, 'docs')); } catch { docsExists = false; }
  if (!docsExists) {
    return skip('R3', 'docs/ 不存在,跳过', '如需文档一致性检查,先建立 docs/ 五件套(relay_init/onboard 自动装骨架)');
  }
  const strict = manifest && manifest.strictDocs === true; // 宽松模式 = 无 strictDocs 标记
  const files = await listDocsMd(join(root, 'docs'));
  if (!files.length) {
    return skip('R3', 'docs/ 无待检 .md(templates/archive/README 已豁免)', '按五件套阶段(01-sow~05-delivery)建文档后本检查生效');
  }
  const offenders = [];
  for (const f of files) {
    const nameOk = DOC_NAME_RE.test(f.split('/').pop());
    const fmOk = frontmatterOk(await readText(join(root, 'docs', f)));
    const good = strict ? nameOk && fmOk : fmOk;
    if (good) continue;
    let why = '缺 frontmatter(title:/status:)';
    if (strict && !nameOk && !fmOk) why = `命名不匹配 ${DOC_NAME_RE} 且缺 frontmatter`;
    else if (strict && !nameOk) why = `命名不匹配 ${DOC_NAME_RE}`;
    offenders.push(`${f}(${why})`);
  }
  if (offenders.length) {
    const shown = offenders.slice(0, 5).join('; ') + (offenders.length > 5 ? ` 等 ${offenders.length} 个` : '');
    const fix = strict
      ? '重命名为 NN-(sow|prd|ard|test|delivery)?-主题-vX.Y.md 并补 YAML frontmatter(title:/status:)'
      : '在文件头补 YAML frontmatter(--- / title: … / status: 草稿|现行 / ---)';
    return bad('R3', 'ERROR', `docs 不合规(${strict ? '严格:命名+frontmatter' : '宽松:仅 frontmatter'}): ${shown}`, fix);
  }
  return pass('R3', `docs ${strict ? '严格模式' : '宽松模式'}:${files.length} 个 .md 全部合规`);
};

// —— R4 入口/START 无时变词 ——
const checkR4 = async (root, manifest) => {
  const files = [...new Set([
    ...(manifest && Array.isArray(manifest.entryFiles) ? manifest.entryFiles : DEFAULT_ENTRY_FILES),
    'START.md',
  ])].filter((f) => typeof f === 'string');
  const hits = [];
  for (const f of files) {
    const t = await readText(join(root, f));
    if (t == null) continue; // 缺失由 R1 负责报
    // user-rules 保留区是项目自治领土,不参与时变词扫描(N3)——老规范里的 TODO 由项目自己管
    const stripped = stripUserRulesBlock(t).replace(/\r\n/g, '\n').split('\n');
    stripped.forEach((l, i) => {
      if (TIME_WORDS_RE.test(l)) hits.push(`${f}:${i + 1} ${l.trim().slice(0, 40)}`);
    });
  }
  if (hits.length) {
    const shown = hits.slice(0, 5).join(' | ') + (hits.length > 5 ? ` (+${hits.length - 5})` : '');
    return bad('R4', 'ERROR', `入口/START 含时变词(TODO|进行中|下周|待办:,user-rules 保留区除外): ${shown}`, '入口文件必须 timeless:删除时变内容(状态只活在 TASKS/LOG),然后 relay_sync 重新投影;位于 user-rules 保留区内的内容不属本检查管辖');
  }
  return pass('R4', `入口/START 无时变词(已查 ${files.join(', ')},user-rules 保留区豁免)`);
};

// 剔除 user-rules 保留区(标记对及其内容);标记前缀与 sync.mjs 保持一致,勿单独改动
const USER_RULES_START = '<!-- relay:user-rules-start';
const USER_RULES_END = '<!-- relay:user-rules-end';
const stripUserRulesBlock = (text) => {
  const t = String(text || '');
  const i = t.indexOf(USER_RULES_START);
  if (i < 0) return t;
  const j = t.indexOf(USER_RULES_END, i);
  if (j < 0) return t;
  const nl = t.indexOf('\n', j);
  return t.slice(0, i) + t.slice(nl < 0 ? t.length : nl + 1);
};

// —— R5 提交原子性(full only)——
const checkR5 = async (root) => {
  if (!isGitRepo(root)) return skip('R5', '非 git 仓库,跳过', '初始化 git 后本检查自动生效');
  const r = await gitRun(root, '-c', 'core.quotePath=false', 'log', '-1', '--name-only', '--pretty=format:');
  if (!r.ok) return skip('R5', '仓库尚无提交,跳过', '产生首个提交后本检查自动生效');
  const files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const code = files.filter((f) => /^(src|lib|app)\//.test(f));
  const touchProtocol = files.includes('TASKS.md') || files.includes('LOG.md');
  if (code.length && !touchProtocol) {
    return bad('R5', 'WARN', `最近一次提交触碰 ${code.slice(0, 3).join(', ')} 等代码,但未同步 TASKS.md/LOG.md(原子性缺口)`, '补一次提交把 TASKS.md/LOG.md 纳入(git commit --amend,或立即做出场提交);代码与任务状态必须同commit演进');
  }
  return pass('R5', '最近一次提交原子性合规');
};

// —— R6 文档 staleness(full only)——
const checkR6 = async (root) => {
  if (!isGitRepo(root)) return skip('R6', '非 git 仓库,跳过', '初始化 git 后本检查自动生效');
  const r = await gitRun(root, '-c', 'core.quotePath=false', 'log', '-20', '--name-only', '--pretty=format:');
  if (!r.ok) return skip('R6', '仓库尚无提交,跳过', '产生首个提交后本检查自动生效');
  const files = new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const srcChanged = [...files].some((f) => f.startsWith('src/'));
  const docsChanged = [...files].some((f) => f.startsWith('docs/'));
  if (srcChanged && !docsChanged) {
    return bad('R6', 'WARN', '最近 20 次提交 src/ 有改动而 docs/ 零改动(文档滞后)', '在 docs/ 对应阶段补记本次 src 变更(需求→01-sow,设计→03-ard,验收→04-test)');
  }
  return pass('R6', `src/docs 同期性合规(近 20 提交:${srcChanged ? 'src 有改动' : 'src 无改动'}${docsChanged ? ',docs 有改动' : ',docs 无改动'})`);
};

// —— R7 发散报警 ——
// 完成判定的唯一标准:task 字段精确形如「T### 完成」。
// 不用 includes('完成') 子串:「T003 未完成」含「完成」子串,曾击穿过 R7/R9。
export const DONE_TASK_RE = /^T\d+\s*完成$/;
const isDoneTaskField = (t) => DONE_TASK_RE.test(String(t || '').trim());

const checkR7 = async (root) => {
  const t = await readText(join(root, 'LOG.md'));
  if (t == null) return skip('R7', 'LOG.md 不存在', '先 relay_init/onboard 建立 LOG.md;出场会写入首条日志');
  const entries = parseLogEntries(t);
  if (!entries.length) return skip('R7', 'LOG.md 无条目', '首个会话出场后自动产生条目');
  // 维护条目(onboard/开源化/引擎迁移等,task=维护)不计入发散窗口——它们本来就不对应任务
  const relevant = entries.filter((e) => !/^维护/.test(String(e.task || '').trim()));
  const maintenanceCount = entries.length - relevant.length;
  if (!relevant.length) {
    return pass('R7', `最近 ${maintenanceCount} 条均为维护会话,不计入发散窗口`);
  }
  const recent = relevant.slice(0, 3);
  const noDone = recent.filter((e) => !isDoneTaskField(e.task));
  if (recent.length === 3 && noDone.length === 3) {
    return bad('R7', 'ERROR', `发散报警:最近 3 条任务会话 task 均非「T### 完成」(${recent.map((e) => e.task).join(' / ')})`, '停机,升级人类仲裁:对照 SPEC 验收标准裁剪/拆小任务粒度,仲裁前不得继续认领新任务');
  }
  return pass('R7', `最近 ${recent.length} 条任务会话中 ${recent.length - noDone.length} 条为「T### 完成」${maintenanceCount ? `(另排除 ${maintenanceCount} 条维护条目)` : ''},无发散`);
};

// —— R8 风格归一化(full only;不强加工具链)——
const checkR8 = async (root) => {
  let names = new Set();
  try { names = new Set(await readdir(root)); } catch {
    return skip('R8', '无法读取 root', '确认 root 存在且可读');
  }
  const prettierCfg = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];
  const eslintCfg = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslint.config.js'];
  const foundP = prettierCfg.find((c) => names.has(c));
  const foundE = eslintCfg.find((c) => names.has(c));
  let hasFormat = false;
  const pkg = await readText(join(root, 'package.json'));
  if (pkg) { try { hasFormat = typeof JSON.parse(pkg)?.scripts?.format === 'string'; } catch { /* 非法 package.json 不影响本检查 */ } }
  const found = [foundP && `prettier(${foundP})`, foundE && `eslint(${foundE})`, hasFormat && 'package.json scripts.format'].filter(Boolean);
  if (found.length) {
    return bad('R8', 'WARN', `检测到格式化工具链: ${found.join(', ')},出场前应先归一风格`, '运行 npm run format(或 npx prettier --write . / npx eslint --fix)后重跑 relay_verify');
  }
  return skip('R8', '未检测到 prettier/eslint/format 脚本,不强加工具链', '如需统一风格可接入 prettier 并加 scripts.format;接入后本检查转为提示');
};

// —— R9 LOG/TASKS 一致性 ——
const checkR9 = async (root) => {
  const logText = await readText(join(root, 'LOG.md'));
  if (logText == null) return skip('R9', 'LOG.md 不存在,无从对账', '出场(relay_session_end)会同时写 LOG 与 TASKS,自动保持一致');
  const entries = parseLogEntries(logText);
  if (!entries.length) return skip('R9', 'LOG.md 无条目,无从对账', '出场后会自动建立 LOG↔TASKS 关联');
  const newest = entries[0];
  if (!isDoneTaskField(newest.task)) {
    return pass('R9', `最新条目未声明完成(task=${newest.task}),无需对账`);
  }
  const idm = newest.task.match(/^T\d+/);
  if (!idm) {
    return skip('R9', `最新条目 task 字段无任务号(“${newest.task}”)`, 'LOG 条目标题 task 字段应为「Txxx 完成」,请修正该条目');
  }
  const id = idm[0];
  const tasksText = await readText(join(root, 'TASKS.md'));
  if (tasksText == null) {
    return bad('R9', 'ERROR', `LOG 最新条目声明 ${id} 完成,但 TASKS.md 不存在`, `补建 TASKS.md 并将 ${id} 标为 [x](YYYY-MM-DD, sha),或修正 LOG 条目 task 字段`);
  }
  let row = null;
  for (const line of tasksText.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(TASK_LINE_RE);
    if (m && m[2] === id) { row = m; break; }
  }
  if (!row) {
    return bad('R9', 'ERROR', `LOG 最新条目声明 ${id} 完成,但 TASKS.md 找不到 ${id} 任务行`, `在 TASKS.md 补 ${id} 任务行并标 [x](YYYY-MM-DD, sha),或修正 LOG 条目 task 字段`);
  }
  if (row[1] !== 'x') {
    return bad('R9', 'ERROR', `LOG 声明 ${id} 完成,但 TASKS 中该任务仍为 [${row[1]}]`, `确认已完成 → 重跑 relay_session_end {done_task:"${id}"};未完成 → 修正 LOG.md 最新条目的 task 字段`);
  }
  return pass('R9', `LOG/TASKS 一致(${id} 已标 [x])`);
};

// —— 检查编排:fast(默认)跳过 R5/R6/R8 ——
export const runChecks = async (root, { full = false } = {}) => {
  const manifest = await readManifest(root);
  const fastSkip = (id, name) => skip(id, `fast 模式跳过 ${name}`, '出场(relay_session_end)会全量执行;需要立即全量:relay_verify {full:true}');
  return [
    await checkR1(root, manifest),
    await checkR2(root, manifest),
    await checkR3(root, manifest),
    await checkR4(root, manifest),
    full ? await checkR5(root) : fastSkip('R5', '(R5 提交原子性)'),
    full ? await checkR6(root) : fastSkip('R6', '(R6 文档 staleness)'),
    await checkR7(root),
    full ? await checkR8(root) : fastSkip('R8', '(R8 风格归一化)'),
    await checkR9(root),
  ];
};

// —— 结构化结果 → markdown 表格 ——
export const formatChecks = (results, { root = '', full = false } = {}) => {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const counts = { PASS: 0, WARN: 0, ERROR: 0, SKIP: 0 };
  for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  const lines = [
    `### relay verify — ${root || '.'}(模式: ${full ? 'full 全量' : 'fast 快检'})`,
    '',
    '| ID | 结果 | 详情 |',
    '|---|---|---|',
  ];
  for (const r of results) {
    const detail = r.fix ? `${cell(r.detail)}<br>${cell(r.fix)}` : cell(r.detail);
    lines.push(`| ${r.id} | ${r.result} | ${detail} |`);
  }
  const verdict = counts.ERROR > 0 ? '不通过(存在 ERROR)' : '通过';
  lines.push('', `**汇总**: PASS ${counts.PASS} · WARN ${counts.WARN} · ERROR ${counts.ERROR} · SKIP ${counts.SKIP} — ${verdict}`);
  if (counts.ERROR > 0) lines.push('', '存在 ERROR:出场绿闸已阻断。逐条执行上表「修复:」指令后重验。');
  return lines.join('\n');
};

// —— MCP 工具入口 ——
export const relayVerify = async (args = {}) => {
  const root = args.root || process.cwd();
  const full = args.full === true;
  const results = await runChecks(root, { full });
  const hasError = results.some((r) => r.result === 'ERROR');
  return { content: [{ type: 'text', text: formatChecks(results, { root, full }) }], isError: hasError };
};
