// relay-mcp — W4 验证引擎:R 系列检查器(R1–R13)与 relay_verify。
// 依据 CONTRACT.md「检查器规则表」「仓库文件格式」「安全与降级」。
// TASKS 任务行与 LOG 条目标题的正则与契约逐字符一致,绝不改动;
// 每条非 PASS 结果都附一条以「修复:」开头的可执行指令。
import { readFileSafe, isGitRepoAsync, gitRun, scanSecrets, formatSecretHits, SECRET_OK_MARKER, assertNoSymlinkComponents } from '../util.mjs';
import { FACT_LINE_RE, parseFactLine, recomputeCommitStats, diffStat } from './facts.mjs';
import { readManifestConfig, underRoots, matchesIgnore, DEFAULT_CODE_ROOTS, DEFAULT_DOCS_ROOTS } from '../config.mjs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

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

// —— 单轮 verify 的读取/子进程快照(T022) ——
// 一次 runChecks 只读一次 LOG.md / TASKS.md / manifest.json,只起必要数量的 git 子进程;
// R7/R9/R10/R11/R12 全部消费同一份快照,避免「同一条日志在两条规则下看到不同版本」。
const collectMeta = async (root) => {
  const t = await readText(join(root, '.relay', 'manifest.json'));
  let manifest = null;
  if (t != null) {
    try { const m = JSON.parse(t); manifest = m && typeof m === 'object' ? m : null; } catch { manifest = null; }
  }
  const cfg = await readManifestConfig(root, { manifest });
  return { manifest, cfg };
};

const collectGit = async (root, { commits = true } = {}) => {
  const isRepo = await isGitRepoAsync(root);
  const ctx = { isRepo, tops: null, commits: [] };
  if (!isRepo) return ctx;
  // 一次 ls-files 同时拿已跟踪 + 未跟踪(R2 原来要两次子进程)
  const ls = await gitRun(root, '-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  if (ls.ok) {
    const tops = new Set();
    for (const p of ls.stdout.split('\0')) {
      const s = p.trim();
      if (s) tops.add(s.split('/')[0]);
    }
    ctx.tops = tops;
  }
  // 任务树结构检查只用 tops(R1/R2/R3/R4/R8),不需要提交历史:省一次 git(P2-11 审计)。
  if (!commits) return ctx;
  // 一次 log-20 同时拿:第 1 条提交(R5)、近 20 条文件并集(R6)、HEAD subject(R10 单根定位)。
  // P0-1(审计):不能用文本哨兵分隔提交——git log --name-only 把文件名混在同一行流里,
  // 名为 __COMMIT__* 的文件会被当成提交头,让 R5 静默失明(base 版无哨兵,是本 PR 引入的回归)。
  // 改用 NUL 作**记录前缀**:文件名不可能含 NUL,因此每个 NUL 之后的第一个行必然是提交头,
  // 路径只可能落在该 chunk 的后续行——文件名再也无法伪造提交边界。
  // 头格式 = sha \t parents(空格分隔) \t subject:%P 让 R5 能识别 merge 提交(N2 复审)。
  const log = await gitRun(root, '-c', 'core.quotePath=false', 'log', '-20', '--name-only', '--pretty=format:%x00%H%x09%P%x09%s');
  if (log.ok) {
    for (const chunk of log.stdout.split('\0')) {
      const rows = chunk.replace(/\r\n/g, '\n').split('\n');
      const header = rows.shift() || '';
      const hm = header.match(/^([0-9a-f]{40})\t([0-9a-f ]*)\t(.*)$/);
      if (!hm) continue; // 空 chunk / 非提交头行(理论上不存在)
      const cur = { sha: hm[1], parents: hm[2].trim() ? hm[2].trim().split(' ') : [], subject: hm[3], files: [] };
      for (const row of rows) {
        const line = row.trim();
        if (line) cur.files.push(line);
      }
      ctx.commits.push(cur);
    }
  }
  return ctx;
};

const collectSnapshot = async (root, preloadedMeta = null, preloadedTexts = null) => {
  const meta = preloadedMeta || await collectMeta(root);
  // T026:调用方(relay_session_start)已经把 LOG/TASKS 读进内存时直接复用,单轮读取恒为 1。
  const logText = preloadedTexts && preloadedTexts.logText !== undefined
    ? preloadedTexts.logText : await readText(join(root, 'LOG.md'));
  const tasksText = preloadedTexts && preloadedTexts.tasksText !== undefined
    ? preloadedTexts.tasksText : await readText(join(root, 'TASKS.md'));
  const git = await collectGit(root);
  return { ...meta, logText, tasksText, git };
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
  // AGENTS.md 是项目规范入口,任何配置都不能把它从必需清单中移除;其余入口只是适配指针。
  const configured = Array.isArray(manifest.entryFiles) ? manifest.entryFiles.filter((f) => typeof f === 'string') : [];
  const files = [...new Set(['AGENTS.md', ...configured])];
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
const checkR2 = async (root, manifest, git) => {
  if (!manifest || !Array.isArray(manifest.allowedTopLevel)) {
    return skip('R2', '无 manifest.allowedTopLevel 白名单,跳过', '先 relay_init / relay_onboard 生成 .relay/manifest.json');
  }
  const allowed = new Set(manifest.allowedTopLevel);
  let tops = null;
  let via = '';
  if (git && git.isRepo && git.tops) { tops = git.tops; via = 'git ls-files(已跟踪+未跟踪,单次调用)'; }
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
const listDocsMd = async (docsDir, ignore = []) => {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'templates' || e.name === 'archive') continue; // 契约豁免(不可配置)
        if (matchesIgnore(ignore, rel, true)) continue;               // manifest.docsIgnore(P3)
        await walk(join(dir, e.name), rel);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (rel === 'README.md') continue; // docs/README.md 是索引,豁免
        if (matchesIgnore(ignore, rel, false)) continue;              // manifest.docsIgnore(P3)
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

const checkR3 = async (root, manifest, cfg) => {
  let docsExists = true;
  try { await readdir(join(root, 'docs')); } catch { docsExists = false; }
  if (!docsExists) {
    return skip('R3', 'docs/ 不存在,跳过', '如需文档一致性检查,先建立 docs/ 五件套(relay_init/onboard 自动装骨架)');
  }
  const strict = manifest && manifest.strictDocs === true; // 宽松模式 = 无 strictDocs 标记
  const ignore = (cfg && cfg.docsIgnore) || [];
  const all = await listDocsMd(join(root, 'docs'));              // 全量,用于如实报出剪掉了多少
  const files = ignore.length ? await listDocsMd(join(root, 'docs'), ignore) : all;
  const ignoredCount = all.length - files.length;
  if (!files.length) {
    return skip('R3', `docs/ 无待检 .md(templates/archive/README 已豁免${ignoredCount ? `;manifest.docsIgnore 另剪 ${ignoredCount} 个` : ''})`, '按五件套阶段(01-sow~05-delivery)建文档后本检查生效');
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
  return pass('R3', `docs ${strict ? '严格模式' : '宽松模式'}:${files.length} 个 .md 全部合规${ignoredCount ? `(manifest.docsIgnore 剪掉 ${ignoredCount} 个)` : ''}`);
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
const checkR5 = async (root, cfg, git) => {
  if (!git || !git.isRepo) return skip('R5', '非 git 仓库,跳过', '初始化 git 后本检查自动生效');
  const newest = git.commits && git.commits[0];
  if (!newest) return skip('R5', '仓库尚无提交,跳过', '产生首个提交后本检查自动生效');
  // N2(复审):merge 提交在 `git log --name-only` 里不列文件 → 旧实现 code.length===0 直接 PASS,
  // 让 R5 在「HEAD 是 merge」时静默空转(本项目提交史里 Merge T0xx 很常见)。
  // merge 是集成提交、不是原子性单元;双根场景由 session_end 的成对证据兜底 —— 这里显式 SKIP,
  // 不再假 PASS(需要逐提交核对时用 `git show --name-only -m <merge-sha>`)。
  if (Array.isArray(newest.parents) && newest.parents.length > 1) {
    return skip('R5', `最近一次提交是 merge 提交(${newest.sha.slice(0, 12)},${newest.parents.length} 个父),` +
      'git log --name-only 不列 merge 文件,原子性无法判定(不是通过)',
      '逐提交核对用 `git show --name-only -m <merge-sha>`;双根场景由 session_end 的成对证据(代码提交 + 控制面提交)校验');
  }
  const files = newest.files;
  const roots = (cfg && cfg.codeRoots) || DEFAULT_CODE_ROOTS;
  const code = files.filter((f) => underRoots(roots, f)); // P4:原 /^(src|lib|app)\// 的配置化形态
  const touchProtocol = files.includes('TASKS.md') || files.includes('LOG.md');
  if (code.length && !touchProtocol) {
    return bad('R5', 'WARN', `最近一次提交触碰 ${code.slice(0, 3).join(', ')} 等代码(按 manifest.codeRoots: ${roots.join(', ') || '无'}),但未同步 TASKS.md/LOG.md(原子性缺口)`, '补一次提交把 TASKS.md/LOG.md 纳入(git commit --amend,或立即做出场提交);代码与任务状态必须同commit演进');
  }
  return pass('R5', `最近一次提交原子性合规(代码前缀:${roots.join(', ') || '无'})`);
};

// —— R6 文档 staleness(full only)——
const checkR6 = async (root, cfg, git) => {
  if (!git || !git.isRepo) return skip('R6', '非 git 仓库,跳过', '初始化 git 后本检查自动生效');
  if (!git.commits || !git.commits.length) return skip('R6', '仓库尚无提交,跳过', '产生首个提交后本检查自动生效');
  const files = new Set(git.commits.flatMap((c) => c.files));
  const croots = (cfg && cfg.codeRoots) || DEFAULT_CODE_ROOTS;
  const droots = (cfg && cfg.docsRoots) || DEFAULT_DOCS_ROOTS;
  const srcChanged = [...files].some((f) => underRoots(croots, f)); // P4:原 f.startsWith('src/')
  const docsChanged = [...files].some((f) => underRoots(droots, f));
  if (srcChanged && !docsChanged) {
    return bad('R6', 'WARN', `最近 20 次提交代码有改动(按 manifest.codeRoots: ${croots.join(', ') || '无'})而文档前缀 ${droots.join(', ') || '无'} 零改动(文档滞后)`, '在 docs/ 对应阶段补记本次代码变更(需求→01-sow,设计→03-ard,验收→04-test)');
  }
  return pass('R6', `src/docs 同期性合规(近 20 提交:${srcChanged ? '代码有改动' : '代码无改动'}${docsChanged ? ',docs 有改动' : ',docs 无改动'};代码前缀:${croots.join(', ') || '无'})`);
};

// —— R7 发散报警 ——
// 完成判定的唯一标准:task 字段精确形如「T### 完成」。
// 不用 includes('完成') 子串:「T003 未完成」含「完成」子串,曾击穿过 R7/R9。
export const DONE_TASK_RE = /^T\d+\s*完成$/;
const isDoneTaskField = (t) => DONE_TASK_RE.test(String(t || '').trim());

const checkR7 = async (root, snap) => {
  const t = snap ? snap.logText : await readText(join(root, 'LOG.md'));
  if (t == null) return skip('R7', 'LOG.md 不存在', '先 relay_init/onboard 建立 LOG.md;出场会写入首条日志');
  const entries = parseLogEntries(t);
  if (!entries.length) return skip('R7', 'LOG.md 无条目', '首个会话出场后自动产生条目');
  // 维护条目不计入发散窗口——它们本来就不对应任务。两种写法都要认:
  //   task=维护(人工维护条目)/ task=无(relay_session_end 无 done_task 的引擎维护出场)。
  // 漏掉「无」会让连续几次维护出场被误判成「3 条任务会话无完成」→ R7 停机误报。
  const relevant = entries.filter((e) => !/^(维护|无)/.test(String(e.task || '').trim()));
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
const checkR9 = async (root, snap) => {
  const logText = snap ? snap.logText : await readText(join(root, 'LOG.md'));
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
  const tasksText = snap ? snap.tasksText : await readText(join(root, 'TASKS.md'));
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

// —— R10 事实对账(T013)——
// 事实行由 relay_session_end 的引擎确定性写入,模型不得手写/改写;本检查负责:
//   10.1 存在性:最新完成条目必须有事实行(缺 → WARN,ERROR 会锁死出场;防手写伪造完成条目);
//   10.2 可解析性:格式坏了即 ERROR(说明被手改或引擎回退);
//   10.3 v2 机检段对账:文件数(managed 另含 ±)从 git 重算,不一致 → ERROR;叙述段不参与;
//   10.4 branch 归属:声称的分支必须真的包含声明的 sha(存在但不含 → ERROR;分支已删除 → WARN);
//   10.5 无法定位提交 → WARN(永不 PASS);v1 旧格式只做结构校验 → WARN(数字权威仅 v2,绝不 PASS)。
// 只跑 controlRoot(executionRoot 里的 LOG 是 baseSha 快照,同 R7/R9 边界)。
// 向后兼容:manifest.facts.enabled 未开 / since 未设 / 条目早于 since → SKIP。
// 分支归属(P1-3 审计):快乐路径只多一次 git branch --contains;只有「不在列表」时才补一次
// rev-parse 区分「分支存在但不含该提交」(ERROR:篡改/张冠李戴)与「分支已删除」(WARN:不可验证)。
const branchContainsSha = async (root, sha, branch) => {
  const r = await gitRun(root, '-c', 'core.quotePath=false', 'branch', '--contains', sha);
  if (!r.ok) return { state: 'unverifiable', detail: (r.stderr || '').split('\n')[0] || 'git branch --contains 失败' };
  // git branch 的标记列:* = 当前分支,+ = 已被某个 linked worktree 检出(任务分支就是这种)
  const names = new Set(r.stdout.split('\n')
    .map((l) => l.replace(/^[*+]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('(')));
  if (names.has(branch)) return { state: 'contains' };
  const exists = await gitRun(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  return exists.ok && exists.stdout.trim() ? { state: 'not-contains' } : { state: 'missing' };
};

// 分支已合并删除是正常生命周期(人工 merge 后删分支;relay 的 cleanup 只保留分支,但人工流程允许删)。
// 此时分支名无法验证,但可以验证两件事:① 该 sha 的提交信息含「<task> 完成」(session_end 的完成提交);
// ② 该 sha 仍在当前分支历史里。两者同时成立才降级为 PASS(带注记),否则维持 WARN——
// 伪造分支名、或引用历史之外的提交,仍然会被拦。
const isMergedCompletionCommit = async (root, sha, taskId) => {
  if (!sha || !taskId) return false;
  const subj = await gitRun(root, '-c', 'core.quotePath=false', 'log', '-1', '--pretty=%s', sha);
  if (!subj.ok || !new RegExp(`${taskId}\\s*完成`).test(subj.stdout)) return false;
  const anc = await gitRun(root, 'merge-base', '--is-ancestor', sha, 'HEAD');
  return anc.ok;
};
const checkR10 = async (root, cfg, snap) => {
  const facts = (cfg && cfg.facts) || { enabled: false, since: null, strict: false };
  if (!facts.enabled) {
    return skip('R10', 'manifest.facts.enabled 未开启,跳过事实对账', '新项目由 relay_init/onboard 开启;旧项目在 .relay/manifest.json 写入 facts.enabled=true 与 facts.since 后生效');
  }
  if (!facts.since) {
    return skip('R10', 'manifest.facts.since 未设置,跳过(避免旧条目误报)', '在 manifest.facts.since 写入启用时刻(YYYY-MM-DD HH:mm)后本检查生效');
  }
  const t = snap ? snap.logText : await readText(join(root, 'LOG.md'));
  if (t == null) return skip('R10', 'LOG.md 不存在', '出场会写入首条日志');
  const lines = t.replace(/\r\n/g, '\n').split('\n');
  // P1-16:找**最新完成条目**,而不是最新条目。LOG 顶部常是 task=无 的维护条目,
  // 若只看第一条,伪造/裁剪过的完成条目会被整条跳过(与 10.1「防手写伪造完成条目」的目的相反)。
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(LOG_TITLE_RE);
    if (mm && isDoneTaskField(mm[3])) { start = i; break; }
  }
  if (start < 0) return pass('R10', 'LOG 中暂无完成条目,无需事实对账');
  for (let i = start + 1; i < lines.length; i++) {
    if (LOG_TITLE_RE.test(lines[i])) { end = i; break; }
  }
  const m = lines[start].match(LOG_TITLE_RE);
  const entry = { time: m[1], model: m[2], task: m[3] };
  if (entry.time < facts.since) {
    return skip('R10', `最新完成条目(${entry.time})早于 facts.since(${facts.since}),跳过(升级兼容)`, null);
  }
  const block = lines.slice(start + 1, end);
  const factIdx = block.findIndex((l) => FACT_LINE_RE.test(l));
  if (factIdx < 0) {
    // P1-14:这里若判 ERROR,出场绿闸会永久卡死,而唯一的修复动作(重跑 session_end)
    // 正是被阻断的那个调用,且引擎从不回填历史条目 —— 死锁。降为 WARN 并给可执行出路。
    return bad('R10', 'WARN', `最新完成条目(${entry.time} ${entry.task})缺少机器写入的「事实(v2)」行`,
      '该条目由旧版本引擎或手工写入,引擎不会回填历史条目;把 .relay/manifest.json 的 facts.since 前移到该条目之后即可豁免,或人工补一行格式正确的 事实(v2) 行');
  }
  const parsed = parseFactLine(block[factIdx]);
  if (!parsed) {
    return bad('R10', 'ERROR', `「事实(v1/v2)」行格式不可解析:${block[factIdx].slice(0, 80)}`,
      '删除该行后重跑 relay_session_end 由引擎重写(该行是机器产物,不允许手改)');
  }
  if (parsed.version === 1) {
    // P0-2(审计):v1 旧行没有可信的 range 来源——行自带的 base/sha 由被校验方提供,
    // 用它算出来的「一致」是自证。数字对账一律不做,只保留结构校验并 WARN(绝不 PASS)。
    return bad('R10', 'WARN', `最新完成条目(${entry.time} ${entry.task})的事实行是 v1 旧格式,只做结构校验(数字对账仅 v2 机检段权威)`,
      '该行由旧版本引擎写入;删除后重跑 relay_session_end 会写入 v2(机检段可独立对账),或把 manifest.facts.since 前移到该条目之后豁免');
  }
  // T023:机检段结构自洽(mode 决定 base/sha 是否必须存在;managed 分支恒为 relay/T###)。
  // 这条不依赖 git —— 篡改 mode/branch 会直接暴露,而不是靠「± 恰好没被检查」的偶然性。
  const struct = [];
  if (parsed.mode === 'managed') {
    if (!parsed.base) struct.push('mode=managed 但 base 缺失');
    if (!parsed.sha) struct.push('mode=managed 但 sha 缺失');
    if (!/^relay\//.test(parsed.branch)) struct.push(`mode=managed 但 branch=${parsed.branch || '(空)'} 不是 relay/T### 任务分支`);
  } else {
    if (parsed.base) struct.push('mode=single 却带 base(单根出场时代码尚未提交)');
    if (parsed.sha) struct.push('mode=single 却带 sha(单根出场时代码尚未提交)');
    if (!parsed.branch) struct.push('branch 缺失');
  }
  if (struct.length) {
    return bad('R10', 'ERROR', `事实行机检段自相矛盾:${struct.join('; ')}`,
      '事实行是引擎产物,不允许手改;删除该行后重跑 relay_session_end 重写(机检段=mode/文件数/base/sha/branch)');
  }
  // 复用快照里的 git 结果:不再单独起 isGitRepo / git log(R10 只需一次 diff)
  // 单根 v2 事实行没有 sha:按「<T###> 完成」反查完成提交(1 次 git),否则完成之后的普通提交会让 R10 失去定位。
  let completionSha = '';
  if (parsed.mode === 'single' && !parsed.sha) {
    const taskId = (String(entry.task).match(/^T\d+/) || [])[0];
    if (taskId) {
      // 审计 P2:只取第一条 grep 命中会被「提交消息里恰好含 T### 完成」的无关提交劫持;
      // 取最多 10 个候选,选「diff 文件数与事实行声明一致」的那一个(真正的完成提交)。
      const g = await gitRun(root, '-c', 'core.quotePath=false', 'log', '-10', '--fixed-strings', '--format=%H', '--grep', `${taskId} 完成`);
      const candidates = g.ok ? g.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
      for (const sha of candidates) {
        const st = await diffStat(root, [`${sha}^`, sha]);
        if (st && st.files === parsed.files) { completionSha = sha; break; }
      }
    }
  }
  const stats = await recomputeCommitStats(root, parsed, {
    isRepo: snap && snap.git ? snap.git.isRepo : undefined,
    headSubject: snap && snap.git && snap.git.commits[0] ? snap.git.commits[0].subject : null,
    completionSha,
  });
  if (!stats) {
    // T023:fail-open 修复 —— 「算不了」绝不能 PASS(未验证的确信比空白更危险);
    // 伪造 sha / 提交被重写 / 历史被裁剪都会走到这里,降 WARN 并给出可执行出路。
    return bad('R10', 'WARN', `事实行存在(声明 ${parsed.files} 文件),但无法定位对应提交,数字对账无法完成`,
      '确认该条目引用的 base/sha 仍在仓库历史中;若是旧版本引擎写入或历史被重写,把 manifest.facts.since 前移到该条目之后豁免');
  }
  // P1-3(审计):branch 必须真的与 git 对得上。
  // managed:声称的分支必须包含声明的 sha(存在但不含 → ERROR;已删除/不可读 → WARN)。
  // single:代码尚未提交,无法校验 sha 归属;但分支名至少必须真实存在(zzz/zzz、relay/T999 这类伪造 → WARN)。
  let branchNote = '';
  if (parsed.mode === 'managed') {
    const bc = await branchContainsSha(root, parsed.sha, parsed.branch);
    if (bc.state === 'not-contains') {
      return bad('R10', 'ERROR', `事实行机检段 branch=${parsed.branch} 不包含声明的 sha=${String(parsed.sha).slice(0, 12)}(分支与提交不匹配)`,
        '事实行是引擎产物,不允许手改;删除该行后重跑 relay_session_end 重写');
    }
    if (bc.state === 'missing' || bc.state === 'unverifiable') {
      // 合并后删分支是正常生命周期:若完成提交仍在当前分支历史且提交信息含「T### 完成」,
      // 说明分支确实被合并后删除 → 降级为 PASS(带注记);否则维持 WARN(伪造/历史外提交)。
      const taskId = (String(entry.task).match(/^T\d+/) || [])[0];
      if (await isMergedCompletionCommit(root, parsed.sha, taskId)) {
        branchNote = `,分支 ${parsed.branch} 已合并删除(完成提交 ${String(parsed.sha).slice(0, 12)} 仍在当前分支历史)`;
      } else {
        return bad('R10', 'WARN', `事实行 branch=${parsed.branch} 无法验证(${bc.state === 'missing' ? '分支不存在且完成提交不在当前分支历史' : bc.detail}),数字对账无法完成`,
          '若分支已按人工流程合并删除且完成提交已进 main,本检查会放行;否则事实行被篡改,删除该行后重跑 relay_session_end 重写');
      }
    }
  } else if (parsed.branch && parsed.branch !== '无 git' && parsed.branch !== '未知' && (!snap || !snap.git || snap.git.isRepo)) {
    const exists = await gitRun(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${parsed.branch}`);
    if (!(exists.ok && exists.stdout.trim())) {
      return bad('R10', 'WARN', `事实行 branch=${parsed.branch} 在仓库中不存在(单根模式只校验分支存在性,不校验 sha 归属)`,
        '若该分支已按人工流程删除,把 manifest.facts.since 前移到该条目之后豁免;否则事实行被篡改,删除该行后重跑 relay_session_end 重写');
    }
  }
  // 机检段逐字段对账(叙述段=验收/verify/耗时,写时快照不可重算,刻意不校验;
  // single 的 ± 是写时近似——未跟踪文件在写时还没进 numstat,提交后才可得——故只对 managed 对账 ±)。
  const fails = [];
  if (stats.files !== parsed.files) fails.push(`文件数 声明 ${parsed.files} / 实测 ${stats.files}`);
  if (parsed.mode === 'managed' && (stats.insertions !== parsed.insertions || stats.deletions !== parsed.deletions)) {
    fails.push(`±行数 声明 +${parsed.insertions}/-${parsed.deletions} / 实测 +${stats.insertions}/-${stats.deletions}`);
  }
  if (fails.length) {
    return bad('R10', 'ERROR', `事实行机检段与 git 事实不一致:${fails.join('; ')}`,
      '事实行是引擎产物,不允许手改;删除该行后重跑 relay_session_end 重写(机检段=mode/文件数/base/sha/branch,managed 另含 ±,叙述段=验收/verify/耗时)');
  }
  return pass('R10', `事实对账一致(v2 机检段:${parsed.files} 文件${parsed.mode === 'managed' ? `,±+${parsed.insertions}/-${parsed.deletions}` : ''},${parsed.branch || '单根'}${parsed.mode === 'managed' ? ` 含 sha ${String(parsed.sha).slice(0, 12)}` : ''}${branchNote})`);
};

// —— R11 协议文件敏感内容 ——
// 路径级守卫见 findSensitiveChanges(H3);本检查补内容级:密钥写进 LOG 就进了 git 历史,事后不可撤回。
// 只扫 controlRoot 的协议文件;executionRoot 里的 TASKS/LOG 只是 baseSha 快照(同 R7/R9 的边界)。
const checkR11 = async (root, snap) => {
  const hits = [];
  let exempted = 0;
  // 审计 P2:密钥闸不能只扫 TASKS/LOG——入口/协议文档同样是「会进 git 历史」的协议面。
  const SECRET_SCAN_FILES = ['TASKS.md', 'LOG.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'START.md', 'SPEC.md', 'DECISIONS.md'];
  const texts = { 'TASKS.md': snap ? snap.tasksText : null, 'LOG.md': snap ? snap.logText : null };
  for (const f of SECRET_SCAN_FILES) {
    // 快照只有 TASKS/LOG;其他协议面文件必须读盘(不能因为 snap 存在就跳过)。
    const t = snap && texts[f] !== undefined ? texts[f] : await readText(join(root, f));
    if (t == null) continue;
    // 探测器允许 relay:secret-ok 豁免(写入原语不接受),但豁免必须可见:行数写进输出。
    for (const h of scanSecrets(t, { allowMarker: true })) hits.push({ file: f, ...h });
    // 只统计「真的会命中密钥、但因标记被放行」的行;单纯提到标记名的普通行不算豁免。
    exempted += String(t).split('\n')
      .filter((l) => l.includes(SECRET_OK_MARKER) && scanSecrets(l).length > 0).length;
  }
  // T001:归档文件也是协议面的一部分(从 LOG.md 搬出的历史条目),必须同样过密钥闸;
  // 归档工具写盘前也会扫一次,这里兜住「人工 git mv / 手改归档文件」的路径。
  let archiveFiles = [];
  try {
    const names = await readdir(join(root, 'docs', 'archive'));
    // 审计 P2:归档目录里任何 .md 都是协议历史(不只 LOG-*.md),手写 notes.md 同样要扫。
    archiveFiles = names.filter((n) => /\.md$/.test(n)).sort();
  } catch { /* 无归档目录 → 跳过 */ }
  for (const name of archiveFiles) {
    const t = await readText(join(root, 'docs', 'archive', name));
    if (t == null) continue;
    for (const h of scanSecrets(t, { allowMarker: true })) hits.push({ file: `docs/archive/${name}`, ...h });
  }
  if (hits.length) {
    const shown = hits.slice(0, 3).map((h) => formatSecretHits([h], h.file)).join('; ');
    return bad('R11', 'ERROR',
      `协议文件含疑似密钥内容(${hits.length} 处): ${shown}${hits.length > 3 ? ` 等 ${hits.length} 处` : ''}`,
      '删除或替换为 [REDACTED];若该串曾进入 git 历史,立即轮换该密钥。确属误报可在同一行标注 relay:secret-ok 豁免');
  }
  return pass('R11', `协议面(${SECRET_SCAN_FILES.length + archiveFiles.length} 个文件:入口/协议/归档)无密钥样式内容${archiveFiles.length ? `(含归档 ${archiveFiles.length} 个)` : ''}${exempted ? `(另有 ${exempted} 行标注 relay:secret-ok 被豁免,请人工复核)` : ''}`);
};

// —— R12 LOG 边界(T024 / T001 最小触发)——
// LOG 只增不减与「有限上下文」公理冲突;本检查只报警,归档动作留给人工(不自动搬移/删除)。
// 活跃区 = 归档指针之前的行;行数轴与完成条目轴**共用同一个活跃区**(审计 P1-7:两轴口径必须一致)。
// 指针必须指向真实存在的 docs/archive/*.md 才被承认——否则一行字就能把活跃区归零,比调大阈值更容易消音。
export const R12_MAX_LOG_LINES = 150;
export const R12_MAX_DONE_ENTRIES = 20;
const LOG_ARCHIVE_POINTER_RE = /^\s*<!--\s*relay:log-archive:\s*(\S+)\s*-->\s*$/;
const ARCHIVE_REL_RE = /^docs\/archive\/[^/\\]+\.md$/;
const findArchiveBoundary = async (root, lines) => {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LOG_ARCHIVE_POINTER_RE);
    if (!m) continue;
    const rel = m[1];
    if (!ARCHIVE_REL_RE.test(rel)) continue;
    try {
      const st = await stat(join(root, rel));
      if (!st.isFile() || st.size <= 0) continue;
      // 审计 P2:指针目标不得经符号链接逃出仓库(否则「承认」的是仓库外的一行字)。
      // 只查父目录组件(文件本身由下面的 stat/realpath 判定):断言函数不适用于文件叶子。
      const relDir = rel.split('/').slice(0, -1).join('/');
      try { if (relDir) await assertNoSymlinkComponents(root, relDir, '归档文件目录'); } catch { continue; }
      const rootReal = await realpath(root);
      const fileReal = await realpath(join(root, rel));
      if (!(fileReal === rootReal || fileReal.startsWith(rootReal + sep))) continue;
      return i;
    } catch { /* 指针目标不存在 → 不承认它划定的边界 */ }
  }
  return -1;
};
const checkR12 = async (root, cfg, snap) => {
  const t = snap ? snap.logText : await readText(join(root, 'LOG.md'));
  if (t == null) return skip('R12', 'LOG.md 不存在,无从度量', '出场(relay_session_end)会写入首条日志');
  const lines = t.replace(/\r\n/g, '\n').split('\n');
  const boundary = await findArchiveBoundary(root, lines);
  const area = boundary < 0 ? lines : lines.slice(0, boundary);
  const activeLines = area.filter((l, i) => !(i === area.length - 1 && l === '')).length; // 去掉末尾换行造成的空行
  const doneEntries = parseLogEntries(area.join('\n')).filter((e) => isDoneTaskField(e.task)).length;
  // 审计 INFO:悬空指针不能静默 PASS —— 失效指针本身就是需要修的漂移(fail-closed 可见化)。
  if (boundary < 0 && lines.some((l) => LOG_ARCHIVE_POINTER_RE.test(l))) {
    return bad('R12', 'WARN', '归档指针未被承认(目标文件不存在/为空/越出 docs/archive/ 或经符号链接指向仓库外),活跃区按全文计算',
      '修复:让指针指向真实存在且非空的 docs/archive/*.md(运行 relay_archive_log 会自动维护),或删除失效指针后重跑 relay_verify');
  }
  const overLines = activeLines > R12_MAX_LOG_LINES;
  const overDone = doneEntries > R12_MAX_DONE_ENTRIES;
  if (!overLines && !overDone) {
    return pass('R12', `LOG 活跃区 ${activeLines} 行 / 完成条目 ${doneEntries} 条,在边界内(>${R12_MAX_LOG_LINES} 行或 >${R12_MAX_DONE_ENTRIES} 条才告警)`);
  }
  const over = [
    overLines ? `活跃区 ${activeLines} 行 > ${R12_MAX_LOG_LINES}` : '',
    overDone ? `完成条目 ${doneEntries} 条 > ${R12_MAX_DONE_ENTRIES}` : '',
  ].filter(Boolean).join(';');
  const fix = '归档较早条目:运行 relay_archive_log {confirm:true}(默认 dry-run,只从尾部搬、保留至少 3 条、边界早于最新完成条目;或人工 git move 到 docs/archive/LOG-YYYY.md 并在 LOG.md 留一行指针 <!-- relay:log-archive: docs/archive/LOG-YYYY.md -->,指针目标必须真实存在且位于仓库内);manifest.logBoundary.strict=true 可升级为 ERROR';
  return (cfg && cfg.logBoundary && cfg.logBoundary.strict)
    ? bad('R12', 'ERROR', `LOG 边界超限:${over}`, fix)
    : bad('R12', 'WARN', `LOG 边界超限:${over}`, fix);
};

// —— R13 协议结构(T031):任务行/LOG 条目标题契约 ——
// 解析器对不匹配的协议行是静默跳过:拼错的任务行从简报/待办枚举消失,拼错的 LOG 标题从
// R7/R9/R10 窗口消失——「没有任务」与「任务写错了」不可区分,属于协议面的 fail-open。
// 误报防线:先剥离 HTML 注释块(模板示例在注释里),再只认第 0 列;缩进行不属协议行。
const HTML_COMMENT_BLOCK_RE = /<!--[\s\S]*?-->/g;
const stripHtmlComments = (text) => String(text ?? '').replace(HTML_COMMENT_BLOCK_RE, '');
const TASK_LINE_LIKE_RE = /^- \[/;
const TRIM_META_RE = /^.+,\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DONE_META_RE = /^\d{4}-\d{2}-\d{2}$/;
const looksLikeLogEntry = (line) => /^## \d{4}-\d{2}-\d{2}/.test(line) || /\bmodel=/.test(line) || /\btask=/.test(line);

const checkR13 = async (root, cfg, snap) => {
  const tasksText = snap ? snap.tasksText : await readText(join(root, 'TASKS.md'));
  const logText = snap ? snap.logText : await readText(join(root, 'LOG.md'));
  if (tasksText == null && logText == null) {
    return skip('R13', 'TASKS.md 与 LOG.md 均不存在,无从检查协议结构', '先 relay_init / relay_onboard 建立协议文件');
  }
  const violations = [];
  if (tasksText != null) {
    const lines = stripHtmlComments(tasksText).replace(/\r\n/g, '\n').split('\n');
    const seen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!TASK_LINE_LIKE_RE.test(line)) continue;
      const m = line.match(TASK_LINE_RE);
      if (!m) { violations.push(`TASKS.md:${i + 1} 疑似任务行无法解析(检查空格/任务号格式):${line.trim().slice(0, 80)}`); continue; }
      const [, status, id, title, metaRaw] = m;
      const meta = String(metaRaw ?? '').trim();
      const at = seen.get(id);
      if (at) violations.push(`TASKS.md:${i + 1} 任务号 ${id} 重复(首次出现于第 ${at} 行)`);
      else seen.set(id, i + 1);
      if (!String(title).trim()) violations.push(`TASKS.md:${i + 1} ${id} 任务标题为空`);
      if (status === '~' && !TRIM_META_RE.test(meta)) violations.push(`TASKS.md:${i + 1} ${id} 已认领但缺少「(model, YYYY-MM-DD HH:mm)」`);
      if (status === 'x' && !DONE_META_RE.test(meta)) violations.push(`TASKS.md:${i + 1} ${id} 已完成但缺少完成日期「(YYYY-MM-DD)」`);
    }
  }
  if (logText != null) {
    const lines = stripHtmlComments(logText).replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('## ')) continue;
      if (LOG_TITLE_RE.test(line)) continue;
      if (!looksLikeLogEntry(line)) continue; // 非条目形态的二级标题不属治理面
      violations.push(`LOG.md:${i + 1} 疑似条目标题不符合契约:${line.trim().slice(0, 80)}`);
    }
  }
  if (!violations.length) {
    return pass('R13', '协议结构合规(TASKS 任务行/LOG 条目均匹配契约;HTML 注释与缩进行豁免)');
  }
  const detail = `协议结构不合规 ${violations.length} 处:${violations.slice(0, 4).join('; ')}${violations.length > 4 ? `;等 ${violations.length} 处` : ''}`;
  const fix = '按契约修正:TASKS 任务行「- [ ] T004 标题」「- [~] T003 标题  (model, YYYY-MM-DD HH:mm)」「- [x] T002 标题  (YYYY-MM-DD)」,任务号全局唯一;LOG 条目「## YYYY-MM-DD HH:mm | model=<名> | task=<T### 动词短语>」;历史遗留人工核对后修,不做静默豁免;manifest.structure.strict=true 时本项为 ERROR';
  return (cfg && cfg.structure && cfg.structure.strict)
    ? bad('R13', 'ERROR', detail, fix)
    : bad('R13', 'WARN', detail, fix);
};

// —— 双根:任务树结构检查(R1/R2/R3/R4/R8)——
// managed 场景下真正待提交的代码在 executionRoot,结构检查必须覆盖它;
// 协议面检查(R5/R6/R7/R9)属于 controlRoot,这里刻意不跑——worktree 里的
// TASKS/LOG 只是 baseSha 快照,跑 R7/R9 会得到陈旧甚至相反的结论。
export const runTaskTreeChecks = async (executionRoot, controlRoot = executionRoot, { meta: preloadedMeta = null } = {}) => {
  // 白名单/入口清单以 controlRoot 为准(修宪只认协议面);git 上下文取 executionRoot(真正待提交的任务树)
  const meta = preloadedMeta || await collectMeta(controlRoot);
  const git = await collectGit(executionRoot, { commits: false }); // 任务树只用 tops,不取提交历史(P2-11)
  return [
    await checkR1(executionRoot, meta.manifest),
    await checkR2(executionRoot, meta.manifest, git),
    await checkR3(executionRoot, meta.manifest, meta.cfg),
    await checkR4(executionRoot, meta.manifest),
    await checkR8(executionRoot),
  ];
};

// —— 检查编排:fast(默认)跳过 R5/R6/R8 ——
export const runChecks = async (root, { full = false, meta: preloadedMeta = null, texts: preloadedTexts = null } = {}) => {
  // T022:单轮 verify 只读一次 LOG/TASKS/manifest,git 子进程收敛到必要数量;
  // 所有检查消费同一份快照(同一条日志不会在 R7 与 R10 下看到不同版本)。
  // T026:relay_session_start 已把 LOG/TASKS/manifest 读进内存时,通过 { meta, texts } 透传,避免二次读盘。
  const snap = await collectSnapshot(root, preloadedMeta, preloadedTexts);
  const { manifest, cfg } = snap;
  const fastSkip = (id, name) => skip(id, `fast 模式跳过 ${name}`, '出场(relay_session_end)会全量执行;需要立即全量:relay_verify {full:true}');
  return [
    await checkR1(root, manifest),
    await checkR2(root, manifest, snap.git),
    await checkR3(root, manifest, cfg),
    await checkR4(root, manifest),
    full ? await checkR5(root, cfg, snap.git) : fastSkip('R5', '(R5 提交原子性)'),
    full ? await checkR6(root, cfg, snap.git) : fastSkip('R6', '(R6 文档 staleness)'),
    await checkR7(root, snap),
    full ? await checkR8(root) : fastSkip('R8', '(R8 风格归一化)'),
    await checkR9(root, snap),
    await checkR10(root, cfg, snap),
    await checkR11(root, snap),
    await checkR12(root, cfg, snap),
    await checkR13(root, cfg, snap),
  ];
};

// —— 结构化结果 → markdown 表格 ——
export const formatChecks = (results, { root = '', full = false, mode = '' } = {}) => {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const counts = { PASS: 0, WARN: 0, ERROR: 0, SKIP: 0 };
  for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  const lines = [
    `### relay verify — ${root || '.'}(模式: ${mode || (full ? 'full 全量' : 'fast 快检')})`,
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
// 双根感知:root 落在任务 worktree 内时,同时检查 controlRoot(协议面全量)与
// executionRoot(任务树结构),避免「在 worktree 里 verify 出绿、出场绿闸却查 controlRoot」的分裂结论。
export const relayVerify = async (args = {}) => {
  const inputRoot = args.root || process.cwd();
  const full = args.full === true;
  let roots;
  try {
    const { resolveRelayRoots } = await import('./worktree.mjs'); // 动态导入避免 verify↔worktree 循环
    roots = await resolveRelayRoots(inputRoot);
  } catch {
    roots = { controlRoot: inputRoot, executionRoot: inputRoot, managed: false, linkedWorktree: false, registryState: 'not-applicable' };
  }
  if (roots.controlRoot === roots.executionRoot) {
    const results = await runChecks(roots.controlRoot, { full });
    const hasError = results.some((r) => r.result === 'ERROR');
    return { content: [{ type: 'text', text: formatChecks(results, { root: roots.controlRoot, full }) }], isError: hasError };
  }
  // 双根:meta 只解析一次,两套检查共用(manifest 读取次数恒为 1)
  const meta = await collectMeta(roots.controlRoot);
  const controlResults = await runChecks(roots.controlRoot, { full, meta });
  const taskResults = await runTaskTreeChecks(roots.executionRoot, roots.controlRoot, { meta });
  const hasError = [...controlResults, ...taskResults].some((r) => r.result === 'ERROR');
  const lines = [
    '# relay verify — 双根模式',
    '',
    `- controlRoot(协议面全量检查): ${roots.controlRoot}`,
    `- executionRoot(任务树结构检查 R1/R2/R3/R4/R8): ${roots.executionRoot}`,
    `- 状态: ${roots.managed ? '受管任务 worktree(registry 已登记)' : `linked worktree 未登记(registryState=${roots.registryState})`}`,
    '',
    formatChecks(controlResults, { root: roots.controlRoot, full, mode: 'controlRoot 全量' }),
    '',
    formatChecks(taskResults, { root: roots.executionRoot, full: false, mode: 'executionRoot 任务树(R5/R6/R7/R9/R10/R11/R12 只在 controlRoot 跑)' }),
  ];
  if (roots.linkedWorktree && !roots.managed) {
    lines.push('', `> ⚠ 该 worktree 未被 relay 注册(registryState=${roots.registryState});session_end 的完成出场会 fail-closed 拒绝。`);
    lines.push(roots.registryState === 'corrupt'
      ? '> 修复或删除 `.relay/worktrees.json`(建议先备份)后重试。'
      : '> 若确为 relay 任务树,运行 relay_claim { root: controlRoot, task: "T###", worktree: true } 重建登记。');
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: hasError };
};
