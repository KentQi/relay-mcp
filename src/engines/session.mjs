// relay-mcp — W4 会话协议引擎:入场简报 / 出场绿闸 / 任务认领。
// 依据 CONTRACT.md「仓库文件格式」「安全与降级」与 W4 分工。
// 任务行/日志条目正则统一取自 verify.mjs(与契约逐字符一致)。
// 出场绿闸铁律:verify 全量有 ERROR → 不改任何文件、不提交;
//   此外绿闸实际执行可执行验收(H1):test: 路径跑 node --test、package.json 有 scripts.test 就跑 npm test。
//   安全边界:只执行这两类已知入口,绝不解析执行「验收:」行里的自由文本命令。
// 受保护路径(verify/.relay//tests//*.test.*/*.spec.*):文件照常更新,但不自动 commit(需人类批准,isError 不置位)。
//   注意:护栏只看未提交 diff——模型中途自行 git commit 即可绕过,该边界写明在 README。
// 疑似密钥文件(.env*/*secret*/*credential*/*.key/*.pem/id_rsa)在场:同护栏处理,不自动提交(H3)。
import { acquireRepoLock, readFileSafe, isGitRepo, gitIdentityArgs, gitRun, findSensitiveChanges, releaseRepoLock, stamp, nowIso, templatesDir, ensureDir } from '../util.mjs';
import { writeFile, open as fsOpen, stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runChecks, formatChecks, TASK_LINE_RE, LOG_TITLE_RE, parseLogEntries } from './verify.mjs';

const execFileAsync = promisify(execFile);

const SECTION_ORDER = ['进行中', '待办', '已完成'];

// —— 小助手(一切读取走 readFileSafe,缺文件全部防御)——
const readText = async (p) => {
  const t = await readFileSafe(p, null);
  return typeof t === 'string' ? t : null;
};
const readLines = async (p) => {
  const t = await readText(p);
  return t == null ? null : t.replace(/\r\n/g, '\n').split('\n');
};
const tidy = (lines) => `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;

const parseTaskLine = (line) => {
  const m = String(line).match(TASK_LINE_RE);
  if (!m) return null;
  return { status: m[1], id: m[2], title: m[3], meta: m[4] || '' };
};
const findTaskIdx = (lines, id) => {
  for (let i = 0; i < lines.length; i++) {
    const p = parseTaskLine(lines[i]);
    if (p && p.id === id) return i;
  }
  return -1;
};
// 任务块 = 任务行 + 紧随的两空格缩进续行(验收:/备注:/阻塞:)
const taskBlockRange = (lines, idx) => {
  let end = idx + 1;
  while (end < lines.length && /^ {2}\S/.test(lines[end])) end++;
  return { start: idx, end };
};
const findSection = (lines, name) => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `## ${name}`) return i;
  }
  return -1;
};
const insertIntoSection = (lines, name, blockLines) => {
  const h = findSection(lines, name);
  if (h >= 0) { lines.splice(h + 1, 0, ...blockLines); return; }
  const pos = SECTION_ORDER.indexOf(name);
  for (const later of SECTION_ORDER.slice(pos + 1)) {
    const i = findSection(lines, later);
    if (i >= 0) { lines.splice(i, 0, `## ${name}`, ...blockLines, ''); return; }
  }
  lines.push('', `## ${name}`, ...blockLines);
};
const nextTaskId = (lines) => {
  let max = 0;
  for (const l of lines) {
    const m = l.match(TASK_LINE_RE);
    if (m) max = Math.max(max, parseInt(m[2].slice(1), 10) || 0);
  }
  return `T${String(max + 1).padStart(3, '0')}`;
};
const shortSha = async (root) => {
  if (!isGitRepo(root)) return 'nogit';
  const r = await gitRun(root, 'rev-parse', '--short', 'HEAD');
  return r.ok ? r.stdout.trim() : 'nogit';
};
// 模板兜底:运行时读 templates/,绝不硬编码模板内容(读不到才用最小骨架降级)
const baseTemplateLines = async (name) => {
  const t = await readText(join(templatesDir(), name));
  if (t != null) return t.replace(/\r\n/g, '\n').split('\n');
  if (name === 'TASKS.md') return ['# 任务队列', '', '## 进行中', '', '## 待办', '', '## 已完成', ''];
  return ['# 会话日志(最新在上)', ''];
};

// —— 受保护路径(护栏):本会话改动 → 不自动 commit ——
const PROTECTED_RULES = [
  ['verify 脚本', (p) => p === 'verify' || p === 'verify.sh'],
  ['.relay/**', (p) => (p === '.relay' || p.startsWith('.relay/')) && !p.startsWith('.relay/claims/')],
  ['tests/**', (p) => p.split('/').includes('tests')],
  ['*.test.*', (p) => (p.split('/').pop() || '').includes('.test.')],
  ['*.spec.*', (p) => (p.split('/').pop() || '').includes('.spec.')],
];
const findProtectedChanges = (statusLines) => {
  const hits = new Map();
  for (const line of statusLines || []) {
    if (line.length < 4) continue;
    for (const raw of line.slice(3).split(' -> ')) {
      let p = raw.trim();
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      const rule = PROTECTED_RULES.find(([, f]) => f(p));
      if (rule) hits.set(p, rule[0]);
    }
  }
  return [...hits.entries()].map(([path, why]) => ({ path, why })).sort((a, b) => a.path.localeCompare(b.path));
};

// —— 受保护路径细则:认领锁是本地运行时文件,不算护栏事件 ——
// (PROTECTED_RULES 的 .relay/** 规则在上方定义处排除 .relay/claims/)

// —— 命令执行(仅限两类已知入口;自由文本验收绝不执行)——
const runCmd = async (cmd, args, cwd, timeoutMs = 180000) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: `${stdout || ''}\n${stderr || ''}`.trim() };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: null, out: `未找到可执行文件 ${cmd}` };
    if (e && (e.killed || e.signal === 'SIGTERM')) return { ok: false, out: `超时(${timeoutMs / 1000}s)被终止` };
    return { ok: false, out: `${e?.stdout || ''}\n${e?.stderr || e?.message || '执行失败'}`.trim() };
  }
};
const tailOf = (s, n = 500) => {
  const t = String(s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};
const existsFile = async (p) => (await readFileSafe(p, null)) !== null;

// —— 验收测试路径安检(H-A):交接单上的 test: 路径必须是一枚"真测试文件"——
// 不能是伪装成路径的命令行选项(--require=… 会让 node 加载任意预载脚本,绿灯语义被击穿),
// 也不能用 ../ 逃出项目目录。安检不过 = 拒绝出场,而不是降级人工。
const inspectTestPath = (root, p) => {
  const raw = String(p || '').trim();
  if (!raw) return { bad: '验收 test: 路径为空' };
  if (raw.startsWith('-')) return { bad: `路径不得以 '-' 开头(会被当作 node 命令行选项执行): ${raw}` };
  const abs = resolve(root, raw);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return { bad: `路径必须位于项目目录内: ${raw}` };
  if (!/\.(m|c)?[jt]sx?$/i.test(raw)) return { bad: `只接受 js/ts 测试文件,其他类型不予执行: ${raw}` };
  return { abs, raw };
};

// —— 验收执行门(H1):完成声明必须有可执行的绿灯背书 ——
// 返回 { lines: string[](已执行并通过), fails: string[](任何一条即拒绝出场), executed: number, notes: string[] }
const acceptanceGate = async (root, doneTask) => {
  const lines = [];
  const fails = [];
  const notes = [];
  let executed = 0;
  let testPath = null;
  if (doneTask) {
    const tLines = await readLines(join(root, 'TASKS.md'));
    if (tLines) {
      const idx = findTaskIdx(tLines, doneTask);
      if (idx >= 0) {
        // 验收行可在任务块的任一续行(备注/阻塞行不挡在前面),扫整个任务块
        const range = taskBlockRange(tLines, idx);
        for (let k = idx + 1; k < range.end; k++) {
          const am = String(tLines[k]).match(/^ {2}验收:\s*(.*)$/);
          if (am && am[1].trim().startsWith('test:')) { testPath = am[1].trim().slice(5).trim(); break; }
        }
      }
    }
  }
  // a) test: 验收——先过安检(H-A),再查存在;js 系用 node --test 实跑,完成时必须绿(红灯协议的"绿"端执法)
  if (doneTask && testPath) {
    const chk = inspectTestPath(root, testPath);
    if (chk.bad) {
      fails.push(`验收 test: 安检未通过——${chk.bad}(裁判只执行真正的测试文件)`);
    } else if (!(await existsFile(chk.abs))) {
      fails.push(`验收 \`${testPath}\` 的测试文件不存在——完成声明无法证实(红灯协议:完成时该测试必须存在且通过)`);
    } else if (/\.(m|c)?js$/i.test(chk.raw)) {
      executed += 1;
      const r = await runCmd('node', ['--test', chk.raw], root);
      if (r.ok === null) notes.push(`验收 test:${testPath} 存在,但无法执行(${r.out})——人工确认`);
      else if (!r.ok) fails.push(`\`node --test ${testPath}\` 失败(验收 test: 不绿):\n${tailOf(r.out)}`);
      else lines.push(`- 验收 \`test:\`:node --test ${testPath} 通过`);
    } else {
      lines.push(`- 验收 \`test:\`:${testPath} 存在(ts 系测试,未自动执行,人工确认其通过)`);
    }
  }
  // b) 项目测试入口:package.json scripts.test → npm test
  const pkg = await readText(join(root, 'package.json'));
  let hasTestScript = false;
  if (pkg) { try { hasTestScript = typeof JSON.parse(pkg)?.scripts?.test === 'string'; } catch { /* 非法 package.json 不影响本门 */ } }
  if (hasTestScript) {
    executed += 1;
    const r = await runCmd('npm', ['test', '--silent'], root, 180000);
    if (r.ok === null) notes.push(`发现 scripts.test 但无法执行(${r.out})——人工跑测试后手动提交`);
    else if (!r.ok) fails.push(`\`npm test\` 失败(项目测试入口不绿):\n${tailOf(r.out)}`);
    else lines.push('- 项目测试入口:`npm test` 通过');
  }
  if (!executed) notes.push('未发现可执行验收(无 test: 路径、无 package.json scripts.test)——本次绿闸仅做结构检查,代码事实由人工验收兜底');
  return { lines, fails, executed, notes };
};

// —— 红灯核验(出场时对 next.acceptance=test: 的提示,不阻断)——
const redLightCheck = async (root, next) => {
  if (!next || !String(next.acceptance ?? '').trim().startsWith('test:')) return [];
  const p = String(next.acceptance).trim().slice(5).trim();
  const chk = inspectTestPath(root, p);
  if (chk.bad) {
    return [`- 红灯 \`${p}\`:安检未通过(${chk.bad})——请先修正 TASKS 中的验收行`];
  }
  if (!(await existsFile(chk.abs))) {
    return [`- 红灯 \`${p}\`:测试文件尚不存在——接班者第一件事是编写该失败测试(先红后绿)`];
  }
  if (/\.(m|c)?js$/i.test(chk.raw)) {
    const r = await runCmd('node', ['--test', chk.raw], root);
    if (r.ok === true) return [`- 红灯 \`${p}\`:当前是绿的——下一任务可能已被完成,请人工确认意图`];
    return [`- 红灯 \`${p}\`:确认当前为失败状态(接班者以让它变绿为目标)`];
  }
  return [];
};

// —— 认领锁(M3):.relay/claims/T###.lock,O_EXCL 原子创建,TTL 到期可接管 ——
const CLAIM_TTL_MIN = 240;
const lockPathOf = (root, task) => join(root, '.relay', 'claims', `${task}.lock`);
const acquireClaimLock = async (root, task, model, ttlMin = CLAIM_TTL_MIN) => {
  await ensureDir(join(root, '.relay', 'claims'));
  const p = lockPathOf(root, task);
  for (;;) {
    try {
      const h = await fsOpen(p, 'wx');
      await h.writeFile(`${model}\n${nowIso()}\n`, 'utf8');
      await h.close();
      return { ok: true, created: true };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let holder = '';
      let ageMin = Infinity;
      try {
        const st = await fsStat(p);
        ageMin = (Date.now() - st.mtimeMs) / 60000;
        holder = String(await readFileSafe(p, '')).split('\n')[0].trim() || '(未知持有者)';
      } catch { /* 锁文件刚好消失 → 重试抢位 */ continue; }
      if (holder === model) return { ok: true, created: false };
      if (ageMin < ttlMin) return { ok: false, holder, ageMin, ttlMin };
      // TTL 接管:unlink + wx 重新竞争(原子落位;并发接管时只有一个 wx 成功,败者读到新持有者)
      try { await fsUnlink(p); } catch { /* 已被他人接管 */ }
      // 立即重试 wx:成功=接管;EEXIST=读到的已是别人 → 走正常判定
    }
  }
};
const releaseClaimLock = async (root, task) => {
  try { await fsUnlink(lockPathOf(root, task)); return true; } catch { return false; }
};

const text = (s) => (Array.isArray(s) ? s.join('\n') : s);

// ============================================================
// relay_session_start — 入场简报
// ============================================================
export const relaySessionStart = async (args = {}) => {
  const root = args.root || process.cwd();
  const startText = await readText(join(root, 'START.md'));
  if (startText == null) {
    return {
      content: [{ type: 'text', text: text([
        `# 接力简报 — ${root}`,
        '',
        '未找到 START.md:该仓库尚未接入接力协议。',
        '',
        `- 0→1 新项目:先 \`relay_init { "root": "${root}", "name": "<项目名>" }\``,
        `- 已有项目:先 \`relay_onboard { "root": "${root}" }\``,
        '',
        '接入完成后重新运行 relay_session_start。',
      ]) }],
      isError: true,
    };
  }

  const specText = await readText(join(root, 'SPEC.md'));
  const tasksLines = (await readLines(join(root, 'TASKS.md'))) || [];
  const logText = await readText(join(root, 'LOG.md'));
  const decisionsText = await readText(join(root, 'DECISIONS.md'));

  // START/SPEC 摘录
  const startBrief = startText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l)).slice(0, 2).join(' / ') || '(无正文)';
  const specBriefLines = () => {
    if (specText == null) return ['(SPEC.md 缺失:验收标准无处安放,尽快补齐)'];
    const lines = specText.replace(/\r\n/g, '\n').split('\n');
    let picked = [];
    const h = lines.findIndex((l) => /^#+\s*意图/.test(l));
    const from = h >= 0 ? h + 1 : 0;
    for (let i = from; i < lines.length && picked.length < 5; i++) {
      const t = lines[i].trim();
      if (/^#/.test(t)) { if (picked.length) break; continue; }
      if (t) picked.push(t);
    }
    if (!picked.length) picked = lines.filter((l) => l.trim() && !/^#/.test(l)).slice(0, 5).map((l) => l.trim());
    const title = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s*/, '');
    return [title, ...picked].filter(Boolean).slice(0, 6);
  };

  // TASKS:进行中 + 待办前 3(带验收行)
  const inProgress = [];
  const todos = [];
  for (let i = 0; i < tasksLines.length; i++) {
    const p = parseTaskLine(tasksLines[i]);
    if (!p) continue;
    let acceptance = '';
    if (i + 1 < tasksLines.length) {
      const am = tasksLines[i + 1].match(/^ {2}验收:\s*(.*)$/);
      if (am) acceptance = am[1];
    }
    if (p.status === '~') inProgress.push(p);
    else if (p.status === ' ') todos.push({ ...p, acceptance });
  }
  const firstTodo = todos[0] || null;

  // LOG 最近 3 条(标题 + 摘要)
  const logBrief = () => {
    if (logText == null) return ['(LOG.md 缺失)'];
    const entries = parseLogEntries(logText);
    if (!entries.length) return ['(尚无日志条目)'];
    const lines = logText.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let count = 0;
    for (let i = 0; i < lines.length && count < 3; i++) {
      const m = lines[i].match(LOG_TITLE_RE);
      if (!m) continue;
      count++;
      let summary = '';
      let neg = '';
      let handoff = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (/^## /.test(lines[j])) break;
        const sm = lines[j].match(/^- 摘要:\s*(.*)$/);
        if (sm && !summary) summary = sm[1];
        // 负结果/留给下一个是 LOG 的存在理由(认知审计 H-E):接班者大概率不重开 LOG.md,
        // 至少把最新一条带进简报,防止重踩坑
        const ng = lines[j].match(/^- 负结果:\s*(.*)$/);
        if (ng && !neg) neg = ng[1];
        const hf = lines[j].match(/^- 留给下一个:\s*(.*)$/);
        if (hf && !handoff) handoff = hf[1];
      }
      out.push(`- ${m[1]} | ${m[2]} | ${m[3]}${summary ? ` — ${summary}` : ''}`);
      if (neg) out.push(`  ⚠ 负结果: ${neg.slice(0, 120)}`);
      if (handoff) out.push(`  → 留给下一个: ${handoff.slice(0, 120)}`);
    }
    return out;
  };

  // DECISIONS 最近 3 条(按条目日期倒序)
  const decisionBrief = () => {
    if (decisionsText == null) return [];
    const heads = decisionsText.replace(/\r\n/g, '\n').split('\n')
      .filter((l) => /^## /.test(l)).map((l) => l.replace(/^##\s*/, ''));
    heads.sort((a, b) => String(b.match(/\d{4}-\d{2}-\d{2}/) || '').localeCompare(String(a.match(/\d{4}-\d{2}-\d{2}/) || '')));
    return heads.slice(0, 3);
  };

  // git 对账
  const isRepo = isGitRepo(root);
  let dirty = null;
  let recentCommits = [];
  if (isRepo) {
    const st = await gitRun(root, '-c', 'core.quotePath=false', 'status', '--porcelain');
    if (st.ok) dirty = st.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const lg = await gitRun(root, 'log', '--oneline', '-5');
    if (lg.ok) recentCommits = lg.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  // verify 快检(fast:跳过 R5/R6/R8)
  const checks = await runChecks(root, { full: false });
  const errors = checks.filter((c) => c.result === 'ERROR');
  // SKIP 项折叠为单行(认知审计:R5/R6/R8 三条重复提示占简报中部注意力,信息增益≈0)
  const skips = checks.filter((c) => c.result === 'SKIP');
  const briefChecks = [
    ...checks.filter((c) => c.result !== 'SKIP').map((c) => {
      const d = c.result === 'PASS' ? '' : ` — ${c.detail}${c.fix ? `。${c.fix}` : ''}`;
      return `- \`${c.id}\` ${c.result}${d}`;
    }),
    ...(skips.length ? [`- \`${skips.map((s) => s.id).join('/')}\` SKIP(出场时全量执行)`].map((l) => l) : []),
  ].join('\n');

  // 建议第一动作
  let firstAction;
  if (errors.length) {
    firstAction = ['检查存在 ERROR,先修复再开工:', ...errors.map((e) => `- ${e.id}:${e.fix}`)].join('\n');
  } else if (inProgress.length) {
    // 崩溃恢复优先(认知审计 H-E):进行中任务 + 崩溃的持有者 = 孤儿任务,简报不得静默绕过
    const t = inProgress[0];
    const metaTime = (t.meta || '').match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    const heldHours = metaTime ? ((Date.now() - new Date(metaTime[0].replace(' ', 'T') + ':00').getTime()) / 3600000) : null;
    const stale = heldHours != null && !Number.isNaN(heldHours) && heldHours >= 4;
    firstAction = [
      `⚠ 存在进行中任务 **${t.id} ${t.title}**(${t.meta || '认领信息缺失'})——这是上一棒留下的现场,先处理它再谈新任务:`,
      `- 若持有者还活着(并行会话):不要动,选待办区其他任务;`,
      stale
        ? `- 认领已超过 TTL(4 小时):持有者大概率已崩溃,**可直接 relay_claim 接管**(自动覆盖过期锁,认领时注明接管):`
        : `- 认领未超 TTL:联系/等待持有者;确信崩溃需等满 4 小时后 relay_claim 接管;`,
      '',
      '```json',
      `{ "root": "${root}", "task": "${t.id}", "model": "<你的模型标识>" }`,
      '```',
    ].join('\n');
  } else if (firstTodo) {
    firstAction = [
      `认领待办区第一条 **${firstTodo.id} ${firstTodo.title}** —— 调用 relay_claim(注意把 model 换成你的真实模型标识,占位符会被拒收):`,
      '',
      '```json',
      `{ "root": "${root}", "task": "${firstTodo.id}", "model": "<你的模型标识>" }`,
      '```',
      '',
      `认领后该任务标记为 \`[~]\` 并附 (model, 时间);并行会话中其他人不得再动此任务。完成判定:见任务行「验收:」→ ${firstTodo.acceptance || '(未写验收行,认领前先补)'}`,
    ].join('\n');
  } else {
    firstAction = '待办区与进行中区均空:与人类确认下一步,在 TASKS 待办区定义新任务(必须带「验收:」行)后再 relay_claim。';
  }

  const out = [
    `# 接力简报 — ${root}`,
    `生成于 ${stamp()}`,
    '',
    '## 目标',
    ...specBriefLines().map((l) => `- ${l}`),
    `- 引导(START.md): ${startBrief}`,
    ...decisionBrief().map((d) => `- 决策: ${d}`),
    '',
    '## 当前任务',
    ...(inProgress.length ? inProgress.map((t) => `- [~] ${t.id} ${t.title}${t.meta ? `  (${t.meta})` : ''}`) : ['- 无(无并行持有任务)']),
    '待办(前 3):',
    ...(todos.slice(0, 3).map((t) => `- [ ] ${t.id} ${t.title}${t.acceptance ? `(验收: ${t.acceptance})` : ''}`)),
    ...(todos.length === 0 ? ['- 无——待办区空,出场时必须留 next'] : []),
    '',
    '## 最近日志',
    ...logBrief(),
    '',
    '## git 状态',
    `- 仓库: ${isRepo ? '是' : '否(非 git 仓库,出场将降级为只更新文件)'}`,
    ...(isRepo
      ? [
          `- 工作区: ${dirty == null ? '无法读取 status' : dirty.length === 0 ? '干净' : `${dirty.length} 处未提交改动`}`,
          ...dirty?.slice(0, 5).map((l) => `  - \`${l}\``),
          ...(recentCommits.length ? recentCommits.map((c) => `- 提交: ${c}`) : ['- 提交: 尚无提交']),
        ]
      : []),
    '',
    '## 检查结果(fast 模式,跳过 R5/R6/R8)',
    briefChecks,
    ...(errors.length ? ['', '> 存在 ERROR:按上方「修复:」指令处理后重跑 relay_verify,再开工。'] : []),
    '',
    '## 建议第一动作',
    firstAction,
    '',
    '入场即核对了 git 与 verify;改代码前先认领,出场前必过绿闸。',
  ];
  return { content: [{ type: 'text', text: out.join('\n') }], isError: false };
};

// ============================================================
// relay_claim — 并行模式任务认领
// ============================================================
export const relayClaim = async (args = {}) => {
  const root = args.root || process.cwd();
  const task = String(args.task ?? '').trim();
  const model = String(args.model ?? '').trim();
  const fail = (msg, extra = []) => ({
    content: [{ type: 'text', text: [`# 任务认领 — ${task || '(空)'}`, '', msg, ...extra].join('\n') }],
    isError: true,
  });
  if (!task || !model) {
    return fail('`task` 与 `model` 均必填:task 形如 "T004",model 为你的模型标识(认领即署名)。');
  }
  // 占位符拒收(认知审计):简报里的示例参数被原样照抄会静默成功,署名被污染
  if (/[<>]/.test(model) || /你的模型|your model/i.test(model)) {
    return fail(`model="${model}" 是简报里的占位示例,不能直接使用。`, ['', '修复: 把 model 替换为你的真实模型标识(如 "claude"、"gpt-5.2"、"glm-4.7")再认领。']);
  }
  // 仓库级写锁:TASKS 的读改写必须独占,否则并发 claim 互相吞更新(H-C)
  const claimLock = await acquireRepoLock(root, `claim:${model}`);
  if (!claimLock.ok) {
    return fail(`另一会话(**${claimLock.holder}**)正在本仓库出场/认领,请稍后重试(锁持有约 ${Math.round(claimLock.ageMs / 1000)}s;超 2 分钟自动可接管)。`);
  }
  try {
  const lines = await readLines(join(root, 'TASKS.md'));
  if (lines == null) {
    return fail('未找到 TASKS.md:该仓库尚未接入接力协议。', ['', '修复: 先 relay_init(0→1)或 relay_onboard(老项目)。']);
  }
  const idx = findTaskIdx(lines, task);
  if (idx < 0) {
    return fail(`TASKS.md 中未找到任务 ${task}:任务行须匹配契约正则 \`/^- \\[( |~|x)\\] (T\\d+) (.*?)(?:  \\((.*)\\))?$/\`。`, ['', `修复: 核对任务号(注意补零,如 T004 不是 T4);若任务尚不存在,先在待办区定义并写明「验收:」行。`]);
  }
  const p = parseTaskLine(lines[idx]);
  if (p.status === 'x') {
    return fail(`${task} 已完成(${p.meta || '无完成信息'}),不能认领。`, ['', '修复: 从待办区选择其他任务,或让人类定义新任务。']);
  }
  if (p.status === '~' && p.meta) {
    const prevModel = p.meta.split(',')[0].trim();
    if (prevModel && prevModel !== model) {
      return fail(`${task} 已被 **${prevModel}** 认领(${p.meta})。并行协议下不得抢占。`, ['', '修复: 选择待办区其他未被认领的任务([ ] 状态)。']);
    }
  }
  const range = taskBlockRange(lines, idx);
  // 认领锁(M3):O_EXCL 原子创建,同模型幂等,TTL 到期可接管;防并行 read-modify-write 竞态
  const ttlMin = Number(args.ttl_minutes) > 0 ? Number(args.ttl_minutes) : CLAIM_TTL_MIN;
  const lock = await acquireClaimLock(root, task, model, ttlMin);
  if (!lock.ok) {
    return fail(`${task} 的认领锁被 **${lock.holder}** 持有(已持有约 ${Math.round(lock.ageMin)} 分钟,TTL ${lock.ttlMin} 分钟)。并行协议下不得抢占。`, [
      '',
      `修复: 选择待办区其他未被认领的任务;确信持有方已崩溃,等锁超过 TTL(${lock.ttlMin} 分钟)后自动可接管,或传 ttl_minutes 覆盖。`,
    ]);
  }
  const blockLines = [`- [~] ${p.id} ${p.title}  (${model}, ${stamp()})`, ...lines.slice(idx + 1, range.end)];
  lines.splice(idx, range.end - idx);
  insertIntoSection(lines, '进行中', blockLines);
  await writeFile(join(root, 'TASKS.md'), tidy(lines));
  return {
    content: [{ type: 'text', text: [
      `# 任务认领 — ${task}`,
      '',
      `- 任务: ${p.id} ${p.title}`,
      `- 认领: ${model} @ ${stamp()}`,
      `- 认领锁: \`.relay/claims/${task}.lock\`${lock.created ? '(已创建' : '(同模型复领,已持有'}${lock.tookOver ? `,接管自 ${lock.tookOver}` : ''},TTL ${ttlMin} 分钟)`,
      '- 状态: 任务行已改为 `[~]` 并挪入「进行中」区(TASKS.md 已更新;认领不产生 git 提交)',
      '',
      '提醒(并行模式):',
      `- 自此刻起,其他会话不得修改 ${task} 的任务行与相关代码;冲突以认领锁 + TASKS.md 认领标记为准。`,
      `- 完成时出场:\`relay_session_end { "root": "${root}", "model": "${model}", "summary": "…", "done_task": "${task}", "next": { "title": "…", "acceptance": "…" } }\`(出场成功自动释放认领锁)`,
    ].join('\n') }],
    isError: false,
  };
  } finally {
    await releaseRepoLock(root);
  }
};

// ============================================================
// relay_session_end — 出场协议(绿闸铁律)
// ============================================================
export const relaySessionEnd = async (args = {}) => {
  const root = args.root || process.cwd();
  const model = String(args.model ?? '').trim().replace(/\|/g, '/') || 'unknown';
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  const out = [`# relay 出场 — ${root}`, ''];

  // 1. 参数校验(summary 必填)
  if (!summary) {
    out.push('## 参数校验失败', '', '`summary` 必填:出场必须留下会话摘要——这是无信任交接的最低要求。', '', '修复: 补上 summary(做了什么/结果如何/留给下一棒什么)后重跑 relay_session_end。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const doneTask = String(args.done_task ?? '').trim();
  if (doneTask && !/^T\d+$/.test(doneTask)) {
    out.push('## 参数校验失败', '', `\`done_task\` 须形如 T003,收到:“${doneTask}”。`, '', '修复: 传入 TASKS.md 中存在的任务号,或省略 done_task(无完成任务的会话)。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const blocked = String(args.blocked ?? '').trim().replace(/\n+/g, '; ');
  const next = args.next && typeof args.next === 'object' ? args.next : null;
  if (next && (!String(next.title ?? '').trim() || !String(next.acceptance ?? '').trim())) {
    out.push('## 参数校验失败', '', '`next` 需同时提供 `title` 与 `acceptance`(验收是下一任务的完成判定,不可为空)。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const negatives = Array.isArray(args.negative_results)
    ? args.negative_results.map((s) => String(s).trim()).filter(Boolean)
    : [];

  // 2. 绿闸:全量检查;有 ERROR → 不更新任何文件、不提交
  const results = await runChecks(root, { full: true });
  const errors = results.filter((c) => c.result === 'ERROR');
  const warns = results.filter((c) => c.result === 'WARN');
  if (errors.length) {
    out.push('## 绿闸:未通过 — 未提交', '',
      `verify 全量 ${results.length} 项,ERROR ${errors.length} 项。按出场协议:**未更新任何文件,未提交**。`, '',
      '修复清单:', '');
    for (const e of errors) {
      out.push(`- **${e.id}** ${e.detail}`);
      if (e.fix) out.push(`  ${e.fix}`);
    }
    out.push('', '逐条修复后重跑 `relay_session_end`。');
    if (warns.length) {
      out.push('', '另附 WARN(不阻断,建议一并处理):');
      for (const w of warns) out.push(`- ${w.id} ${w.detail}`);
    }
    out.push('', '---', '', formatChecks(results, { root, full: true }));
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  // 2.5 验收执行门(H1):完成声明必须有可执行的绿灯背书;不绿 → 不改任何文件、不提交
  const acc = await acceptanceGate(root, doneTask || null);
  if (acc.fails.length) {
    out.push('## 验收执行门:未通过 — 未提交', '',
      `完成声明 \`${doneTask || '(本次会话)'}\` 缺少可执行验收的绿灯背书。按出场协议:**未更新任何文件,未提交**。`, '',
      '失败明细:', '');
    for (const f of acc.fails) out.push(`- ${f.split('\n').join('\n  ')}`);
    out.push('', '修复:让上述测试真正通过(而不是删测试/改验收行),再重跑 relay_session_end。');
    if (acc.lines.length) out.push('', '已通过的验收:', ...acc.lines);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const redLights = await redLightCheck(root, next);

  // 2.6 仓库级写锁(H-C):TASKS/LOG 的读改写从此处到提交完成必须独占——
  // 两个会话并发出场时,败者的更新曾基于旧快照覆写胜者(实测丢更新);持锁超 2 分钟视为崩溃残留可接管
  const exitLock = await acquireRepoLock(root, `session-end:${model}`);
  if (!exitLock.ok) {
    out.push('## 并发出场:被拒 — 未提交', '',
      `另一会话(**${exitLock.holder}**)正在本仓库出场/认领(锁已持有约 ${Math.round(exitLock.ageMs / 1000)}s)。`, '',
      '修复:等待对方出场完成后重跑 relay_session_end;若确认对方已崩溃,锁超过 2 分钟会自动可接管。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  try {
  // 受保护路径检测:取本会话改动(在更新 TASKS/LOG 之前的工作区状态)
  const isRepo = isGitRepo(root);
  let statusLines = [];
  if (isRepo) {
    const st = await gitRun(root, '-c', 'core.quotePath=false', 'status', '--porcelain');
    if (st.ok) statusLines = st.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const protectedHits = findProtectedChanges(statusLines);
  const sensitiveHits = findSensitiveChanges(statusLines);

  // 3. 更新 TASKS.md
  const changes = [];
  const tasksPath = join(root, 'TASKS.md');
  let tLines = await readLines(tasksPath);
  if (tLines == null) { tLines = await baseTemplateLines('TASKS.md'); changes.push('TASKS.md 不存在,已按模板重建'); }
  const date = stamp().slice(0, 10);

  let alreadyDone = false;
  if (doneTask) {
    const idx = findTaskIdx(tLines, doneTask);
    if (idx < 0) {
      changes.push(`警告: TASKS.md 未找到任务行 ${doneTask},未能标 [x](请核对任务号)`);
    } else {
      const p = parseTaskLine(tLines[idx]);
      if (p.status === 'x') {
        // 幂等(B5):重跑同一出场不重复盖戳
        alreadyDone = true;
        changes.push(`${doneTask} 已是完成态,跳过重复盖戳`);
      } else {
        const range = taskBlockRange(tLines, idx);
        // 完成戳不记 sha:单提交内"盖戳+提交"自指无解(amend 会再换 sha,记录值变悬挂对象)。
        // 考古路径:完成动作的提交消息含「T### 完成」,git log --grep 反查即得。
        const doneLines = [`- [x] ${p.id} ${p.title}  (${date})`];
        if (blocked) doneLines.push(`  阻塞: ${blocked}`);
        doneLines.push(...tLines.slice(idx + 1, range.end)); // 保留「验收:」等续行
        tLines.splice(idx, range.end - idx);
        insertIntoSection(tLines, '已完成', doneLines);
        changes.push(`TASKS.md: ${doneTask} → \`[x]\` (${date}),挪入「已完成」区${blocked ? '〔附阻塞说明〕' : ''}`);
      }
    }
  } else if (blocked) {
    changes.push('警告: 提供了 blocked 但无 done_task,阻塞说明改写入 LOG(留给下一个)');
  }

  if (next) {
    // 幂等(B5):待办区已有同标题任务 → 不重复插入
    const dup = tLines.findIndex((l) => { const m = l.match(TASK_LINE_RE); return m && m[1] === ' ' && m[3].trim() === String(next.title).trim(); });
    if (dup >= 0) {
      const existId = tLines[dup].match(TASK_LINE_RE)[2];
      changes.push(`待办区已存在同标题任务 ${existId}(跳过重复插入)`);
    } else {
      const id = nextTaskId(tLines);
      const nextLines = [`- [ ] ${id} ${String(next.title).trim()}`, `  验收: ${String(next.acceptance).trim()}`];
      if (next.notes && String(next.notes).trim()) nextLines.push(`  备注: ${String(next.notes).trim()}`);
      insertIntoSection(tLines, '待办', nextLines);
      changes.push(`TASKS.md: 待办区顶部插入 \`${id} ${String(next.title).trim()}\`(含验收行)`);
    }
  }
  await writeFile(tasksPath, tidy(tLines));

  // 4. 更新 LOG.md(顶部、标题行之后)
  const logPath = join(root, 'LOG.md');
  let lLines = await readLines(logPath);
  if (lLines == null) { lLines = await baseTemplateLines('LOG.md'); changes.push('LOG.md 不存在,已按模板重建'); }
  // 注意:未完成时的 task 字段不得包含「完成」子串,否则会干扰 R7/R9 的判定
  // 维护会话(onboard/开源化/引擎迁移等基础设施工作)不对应 TASKS 任务:
  // task=维护 且不计入 R7 发散窗口(否则探测类会话挂 task=无 会被误判为停滞)
  const maintenance = args.maintenance === true;
  const taskField = doneTask ? `${doneTask} 完成` : (maintenance ? '维护' : '无');
  const summaryFlat = summary.split('\n').map((s) => s.trim()).filter(Boolean).join('; ');
  const entry = [
    `## ${stamp()} | model=${model} | task=${taskField}`,
    `- 摘要: ${summaryFlat}`,
  ];
  for (const n of negatives) entry.push(`- 负结果: ${n}`);
  if (next && next.notes && String(next.notes).trim()) entry.push(`- 留给下一个: ${String(next.notes).trim()}`);
  if (blocked && !doneTask) entry.push(`- 留给下一个: 当前受阻:${blocked}`);
  let titleIdx = lLines.findIndex((l) => /^# /.test(l));
  if (titleIdx < 0) { lLines.unshift('# 会话日志(最新在上)'); titleIdx = 0; }
  // 幂等(B5):同一会话重复出场(同 model + 同「T### 完成」)不重复记日志;
  // 查重键扫全表——最新条目可能是其他会话的
  const dupLog = alreadyDone && parseLogEntries(lLines.join('\n')).some((e) => e.model === model && e.task === taskField);
  if (!dupLog) {
    if (lLines[titleIdx + 1] === '') lLines.splice(titleIdx + 2, 0, ...entry, '');
    else lLines.splice(titleIdx + 1, 0, '', ...entry, '');
    await writeFile(logPath, tidy(lLines));
    changes.push(`LOG.md: 顶部新增条目「${entry[0]}」`);
  } else {
    changes.push('LOG.md: 最新条目即本次出场(幂等跳过,不重复记录)');
  }

  // 5/6. 提交分支:护栏 → 不提交;否则 add -A + commit;失败 → 降级
  // 提交消息携带「T### 完成」token:TASKS 完成行不记 sha(自指无解),考古靠 git log --grep
  const firstLine = summary.split('\n')[0].trim();
  const head = doneTask ? `${doneTask} 完成 · ` : '';
  const commitMsg = `relay: session end — ${head}${firstLine}`.slice(0, 80);
  let commitSection = null;
  let guardSection = null;
  let degradeReason = null;
  let commitSha = '';

  if (protectedHits.length || sensitiveHits.length) {
    const parts = ['## 护栏:需人类批准,未自动提交', ''];
    if (protectedHits.length) {
      parts.push('本会话改动了受保护路径(verify 脚本 / .relay/** / tests/** / *.test.* / *.spec.*):',
        ...protectedHits.map((h) => `- \`${h.path}\`(命中规则: ${h.why})`), '');
    }
    if (sensitiveHits.length) {
      parts.push('工作区存在疑似密钥/敏感文件,拒绝将其卷入 git 历史(H3):',
        ...sensitiveHits.map((h) => `- \`${h.path}\`(命中规则: ${h.why})`),
        '',
        '处理建议:确认是否应入库——密钥应移入未跟踪位置并依赖 .gitignore;确属可提交的误报,人工提交即可。', '');
    }
    parts.push(`TASKS.md / LOG.md 已照常更新${doneTask ? '(认领锁保留,待人工批准提交后由下一会话接管或到期自动释放)' : ''}。需人类批准后手动提交:`,
      '',
      '```sh',
      `git add -A && git commit -m "${commitMsg}"`,
      '```');
    guardSection = parts;
  } else if (!isRepo) {
    degradeReason = '非 git 仓库';
  } else {
    const addR = await gitRun(root, 'add', '-A');
    if (!addR.ok) {
      degradeReason = `git add 失败: ${(addR.stderr || addR.stdout || '').split('\n').find(Boolean) || '未知原因'}`;
    } else {
      const cR = await gitRun(root, ...(await gitIdentityArgs(root)), 'commit', '-m', commitMsg);
      if (!cR.ok) {
        degradeReason = `git commit 失败: ${(cR.stderr || cR.stdout || '').split('\n').find(Boolean) || '未知原因'}`;
      } else {
        const shaR = await gitRun(root, 'rev-parse', '--short', 'HEAD');
        commitSha = shaR.ok ? shaR.stdout.trim() : '';
        commitSection = [`- \`${commitSha}\` ${commitMsg}`];
        if (doneTask) commitSection.push(`- 完成提交可反查:\`git log --grep "${doneTask} 完成"\``);
      }
    }
  }
  // 认领锁释放:提交成功或降级(非 git)即任务已落定;护栏路径保留锁(见 guardSection)
  let lockNote = '';
  if (doneTask) {
    const released = (commitSection || degradeReason) ? await releaseClaimLock(root, doneTask) : false;
    lockNote = released ? `认领锁 \`.relay/claims/${doneTask}.lock\` 已释放` : (guardSection ? `认领锁保留(待人工批准提交)` : `认领锁不在场(无需释放)`);
  }

  // 7. 汇总输出
  out.push('## 绿闸:通过', '',
    `verify 全量 ${results.length} 项 — ERROR 0${warns.length ? ` · WARN ${warns.length}(建议处理,不阻断)` : ' · 无 WARN'}`,
    ...warns.map((w) => `- WARN ${w.id}: ${w.detail}`));
  if (acc.lines.length || acc.notes.length) {
    out.push('', '## 验收执行门(实际执行)', ...acc.lines.map((l) => `- ${l.replace(/^- /, '')}`));
    for (const n of acc.notes) out.push(`- 注: ${n}`);
  }
  if (redLights.length) out.push('', '## 红灯核验(下一棒)', ...redLights);
  out.push('', '## 文件更新', ...changes.map((c) => `- ${c}`), ...(lockNote ? [`- ${lockNote}`] : []));
  if (commitSection) {
    out.push('', '## 提交', ...commitSection);
  } else if (guardSection) {
    out.push('', ...guardSection);
  } else {
    out.push('', '## 提交:跳过(降级,不置错)', '',
      `- 原因: ${degradeReason}`,
      '- 文件已全部更新;可稍后手动提交:',
      '',
      '```sh',
      `git add -A && git commit -m "${commitMsg}"`,
      '```');
  }
  out.push('', '## 下一棒');
  if (next) {
    const acc = String(next.acceptance).trim();
    if (acc.startsWith('test:')) {
      out.push(
        `- 下一任务(已入待办区):${nextTaskIdFromLines(tLines)} ${String(next.title).trim()} — 红灯协议,验收 \`${acc}\``,
        `  - 若该失败测试已存在:接力者以把它变绿为目标;`,
        `  - 若不存在:接班者第一件事是编写该失败测试(先红后绿),再实现至变绿。`);
    } else {
      out.push(`- 下一任务(已入待办区):${nextTaskIdFromLines(tLines)} ${String(next.title).trim()} — 验收: \`${acc}\``);
    }
  } else {
    out.push('- 未指定 next:下一棒 relay_session_start 后从 TASKS 待办区取任务;若待办区为空,先与人类定义新任务再动代码。');
  }
  out.push('', `- 出场时间: ${stamp()}(ISO ${nowIso()})`);
  return { content: [{ type: 'text', text: out.join('\n') }], isError: false };
  } finally {
    await releaseRepoLock(root);
  }
};

// 取刚插入的下一任务号(待办区顶部第一条 [ ] 行)
const nextTaskIdFromLines = (lines) => {
  for (const l of lines) {
    const m = l.match(TASK_LINE_RE);
    if (m && m[1] === ' ') return m[2];
  }
  return '(见 TASKS.md 待办区)';
};
