// relay-mcp — W4 会话协议引擎:入场简报 / 出场绿闸 / 任务认领。
// 依据 CONTRACT.md「仓库文件格式」「安全与降级」与 W4 分工。
// 任务行/日志条目正则统一取自 verify.mjs(与契约逐字符一致)。
// 出场绿闸铁律:verify 全量有 ERROR → 不改任何文件、不提交;
//   此外绿闸实际执行可执行验收(H1):test: 路径跑 node --test、package.json 有 scripts.test 就跑 npm test。
//   安全边界:只执行这两类已知入口,绝不解析执行「验收:」行里的自由文本命令。
// 受保护路径(verify/.relay//tests//*.test.*/*.spec.*):文件照常更新,但不自动 commit(需人类批准,isError 不置位)。
//   注意:护栏只看未提交 diff——模型中途自行 git commit 即可绕过,该边界写明在 README。
// 疑似密钥文件(.env*/*secret*/*credential*/*.key/*.pem/id_rsa)在场:同护栏处理,不自动提交(H3)。
import {
  acquireFileLock, acquireRepoLock, checkProtocolFilesSafe, parseLockContent, readFileSafe, isGitRepo, gitIdentityArgs,
  gitRun, findSensitiveChanges, releaseFileLock, stamp, nowIso, templatesDir,
  writeProtocolFile,
} from '../util.mjs';
import { stat as fsStat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { runChecks, formatChecks, runTaskTreeChecks, TASK_LINE_RE, LOG_TITLE_RE, parseLogEntries } from './verify.mjs';
import { readManifestConfig, DEFAULT_COMMIT_TEMPLATE } from '../config.mjs';
import {
  cleanupWorktrees, ensureTaskWorktree, ensureWorktreeGitignore, findManagedWorktreeEvidence, formatUnmergedBranchesNote,
  listUnmergedTaskBranches, readWorktreeConfig, readWorktreeConfigRaw, readWorktreeRegistryState, registryRecoveryHint,
  resolveRelayRoots, rollbackTaskWorktree, touchWorktree, upsertWorktreeRecord,
} from './worktree.mjs';

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

// —— 输入净化(R-05/P2-14)——
// model / 任务标题 / 验收 / 备注 / 负结果 会原样进入锁文件、TASKS 任务行、LOG 条目:
// 换行或控制字符可以伪造额外的 `[x]` 任务行 / `- 负结果:` 行 / 破坏锁文件字段定位。
// 这类身份与结构字段一律拒绝;自由文本 summary/blocked 则扁平化为单行(不拒绝,保留可读性)。
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const hasControlChars = (value) => CONTROL_CHAR_RE.test(String(value ?? ''));
const controlCharError = (label) =>
  `\`${label}\` 含换行/控制字符(可伪造协议行或破坏锁文件结构),已拒绝。修复:改为单行纯文本后重试。`;
const flattenText = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

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
// P2:manifest.protectedPaths 追加在 PROTECTED_RULES 之后(合并,非替换)——
// 内置 5 条护栏任何时候都生效,manifest 只能加严不能放松。
const findProtectedChanges = (statusLines, extra = []) => {
  const rules = [
    ...PROTECTED_RULES.map(([name, f]) => [name, f]),
    ...extra.map(({ pattern, re }) => [`manifest.protectedPaths(${pattern})`, (p) => re.test(p)]),
  ];
  const hits = new Map();
  for (const line of statusLines || []) {
    if (line.length < 4) continue;
    for (const raw of line.slice(3).split(' -> ')) {
      let p = raw.trim();
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      const rule = rules.find(([, f]) => f(p));
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
// —— 白名单命令执行器(P1):仅当命令串「逐字符」命中 manifest.acceptance.commands 才走到这里 ——
// runCmd 用 execFile(无 shell,不解析元字符);这里显式开 shell 是执行复合命令串的必要妥协,
// 边界写在 manifest 里:命令由仓库属主逐条签字,与「执行验收行里的自由文本」有本质区别。
const execAsync = promisify(exec);
const runWhitelistedCmd = async (cmdStr, cwd, timeoutMs = 180000) => {
  try {
    const { stdout, stderr } = await execAsync(cmdStr, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: `${stdout || ''}\n${stderr || ''}`.trim() };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: null, out: `未找到可执行文件 ${cmdStr}` };
    if (e && (e.killed || e.signal === 'SIGTERM')) return { ok: false, out: `超时(${timeoutMs / 1000}s)被终止` };
    return { ok: false, out: `${e?.stdout || ''}\n${e?.stderr || e?.message || '执行失败'}`.trim() };
  }
};

const tailOf = (s, n = 500) => {
  const t = String(s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};
const existsFile = async (p) => (await readFileSafe(p, null)) !== null;

// —— 双根辅助:协议文件名判定 / 任务 worktree 证据 / 成对证据校验 ——
const PROTOCOL_FILES = new Set(['TASKS.md', 'LOG.md']);
// porcelain 行:XY 定宽两字符 + 空格,其余是路径(rename 为 "old -> new")。只认协议文件本身。
const statusPathOf = (line) => {
  const raw = String(line || '').slice(3);
  const tail = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
  let p = String(tail || '').trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
};
const isProtocolStatusLine = (line) => PROTOCOL_FILES.has(statusPathOf(line));

// registry 记录对应 worktree 的当前证据:脏改动 / 分支是否有新提交(用于根错配 fail-closed)。
const taskWorktreeEvidence = async (controlRoot, record) => {
  const relPath = typeof record?.path === 'string' ? record.path : '';
  const absPath = relPath ? resolve(controlRoot, relPath) : '';
  const branch = typeof record?.branch === 'string' ? record.branch : '';
  const baseSha = typeof record?.baseSha === 'string' ? record.baseSha : '';
  let exists = false;
  let dirtyCount = null;
  let statusError = '';
  if (absPath) {
    const st = await fsStat(absPath).catch(() => null);
    exists = !!(st && st.isDirectory());
    if (exists) {
      const r = await gitRun(absPath, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
      if (r.ok) dirtyCount = r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length >= 3).length;
      else statusError = r.stderr || r.stdout || '未知原因';
    }
  }
  let headSha = '';
  if (branch) {
    const h = await gitRun(controlRoot, 'rev-parse', '--verify', `refs/heads/${branch}`);
    if (h.ok) headSha = h.stdout.trim();
  }
  const ahead = !!(headSha && baseSha && headSha !== baseSha);
  return {
    exists, absPath, branch, baseSha, dirtyCount, statusError, headSha, ahead,
    hazard: ahead || (dirtyCount != null && dirtyCount > 0),
  };
};

// 成对证据:managed 完成必须同时具备「任务分支代码提交」与「controlRoot 控制面提交」,
// 且 LOG 记录 branch+代码 SHA。任何一项不满足都不得盖完成章。
const verifyDualEvidence = async ({ controlRoot, executionRoot, doneTask, codeSha, controlSha, branch }) => {
  const fails = [];
  const lines = [];
  if (!codeSha) fails.push('缺少 executionRoot 代码提交 SHA');
  const exHead = await gitRun(executionRoot, 'rev-parse', 'HEAD');
  if (!exHead.ok || exHead.stdout.trim() !== codeSha) {
    fails.push(`executionRoot HEAD(${exHead.stdout.trim() || '?'})≠代码提交 SHA(${codeSha || '?'})`);
  }
  if (!controlSha) fails.push('缺少 controlRoot 控制面提交 SHA');
  const cMsg = await gitRun(controlRoot, 'log', '-1', '--format=%s');
  if (!cMsg.ok || !cMsg.stdout.includes(`${doneTask} 完成`)) {
    fails.push(`controlRoot 最新提交消息未含「${doneTask} 完成」:${cMsg.stdout.trim() || '(空)'}`);
  }
  const cStat = await gitRun(controlRoot, 'status', '--porcelain', '--', 'TASKS.md', 'LOG.md');
  if (!cStat.ok || cStat.stdout.trim()) {
    fails.push(`controlRoot 的 TASKS.md/LOG.md 未提交干净:${cStat.stdout.trim() || cStat.stderr || '未知原因'}`);
  }
  const logText = String((await readText(join(controlRoot, 'LOG.md'))) || '');
  if (!branch || !logText.includes(`branch=${branch}`) || !logText.includes(`sha=${codeSha}`)) {
    fails.push(`LOG 未记录 branch(${branch || '?'}) 与代码 SHA(${codeSha || '?'})`);
  }
  if (!fails.length) {
    lines.push(`- 成对证据: branch=${branch}; codeSha=${codeSha}; controlSha=${controlSha}; LOG 记录 branch+sha; controlRoot TASKS/LOG 已提交`);
  }
  return { fails, lines };
};

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
  // 非测试文件后缀 → 不再直接判死,交白名单裁决(白名单缺席时行为与补丁前逐字符一致)
  if (!/\.(m|c)?[jt]sx?$/i.test(raw)) return { abs, raw, isPath: false };
  return { abs, raw, isPath: true };
};

// 白名单裁决(P1):命令串必须在 manifest.acceptance.commands 里「原样」登记才可执行。
// 未登记的一律拒绝 —— 这比补丁前更宽松?不,更窄:补丁前只会拒绝,现在多了一条放行通道,
// 而放行通道的钥匙在仓库属主手里,不在验收行里。
const classifyAcceptance = (raw, cfg) => {
  if (String(raw).startsWith('-')) return { bad: `验收命令不得以 - 开头(防 CLI 选项注入),与 js/ts 路径安检同规: ${raw}` };
  const cmds = (cfg && cfg.acceptanceCommands) || [];
  if (cmds.includes(raw)) return { cmd: raw };
  return {
    bad: cmds.length
      ? `${raw} 既不是 js/ts 测试文件,也不在 manifest.acceptance.commands 白名单内(裁判只执行签过字的命令);白名单: ${cmds.join(' / ')}`
      : `只接受 js/ts 测试文件,其他类型不予执行: ${raw}`,
  };
};

// —— 验收执行门(H1):完成声明必须有可执行的绿灯背书 ——
// 返回 { lines: string[](已执行并通过), fails: string[](任何一条即拒绝出场), executed: number, notes: string[] }
const acceptanceGate = async (root, doneTask, cfg, executionRoot = root) => {
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
    const chk = inspectTestPath(executionRoot, testPath);
    const verdict = chk.bad ? { bad: chk.bad }
      : chk.isPath ? { isPath: true }
        : classifyAcceptance(chk.raw, cfg); // P1 分支
    if (verdict.cmd) {
      executed += 1;
      const r = await runWhitelistedCmd(verdict.cmd, executionRoot); // 超时沿用 180s
      if (r.ok === null) notes.push(`验收 test:${testPath} 命中白名单,但无法执行(${r.out})——人工确认`);
      else if (!r.ok) fails.push(`\`${verdict.cmd}\` 失败(验收 test: 不绿):\n${tailOf(r.out)}`);
      else lines.push(`- 验收 \`test:\`:\`${verdict.cmd}\`(manifest.acceptance.commands 白名单)通过`);
    } else if (verdict.bad) {
      fails.push(`验收 test: 安检未通过——${verdict.bad}(裁判只执行真正的测试文件)`);
    } else if (!(await existsFile(chk.abs))) {
      fails.push(`验收 \`${testPath}\` 的测试文件不存在——完成声明无法证实(红灯协议:完成时该测试必须存在且通过)`);
    } else if (/\.(m|c)?js$/i.test(chk.raw)) {
      executed += 1;
      const r = await runCmd('node', ['--test', chk.raw], executionRoot);
      if (r.ok === null) notes.push(`验收 test:${testPath} 存在,但无法执行(${r.out})——人工确认`);
      else if (!r.ok) fails.push(`\`node --test ${testPath}\` 失败(验收 test: 不绿):\n${tailOf(r.out)}`);
      else lines.push(`- 验收 \`test:\`:node --test ${testPath} 通过`);
    } else {
      lines.push(`- 验收 \`test:\`:${testPath} 存在(ts 系测试,未自动执行,人工确认其通过)`);
    }
  }
  // b) 项目测试入口:package.json scripts.test → npm test
  const pkg = await readText(join(executionRoot, 'package.json'));
  let hasTestScript = false;
  if (pkg) { try { hasTestScript = typeof JSON.parse(pkg)?.scripts?.test === 'string'; } catch { /* 非法 package.json 不影响本门 */ } }
  if (hasTestScript) {
    executed += 1;
    // 命令串由引擎自造(常量),不是验收行里的自由文本。Windows 下 execFile 拉不起 npm.cmd(ENOENT)必须走 shell;
    // POSIX 保留 execFile(不经 shell),防 ~/.bashrc 的 alias npm=... 劫持语义
    const r = process.platform === 'win32'
      ? await runWhitelistedCmd('npm test --silent', executionRoot, 180000)
      : await runCmd('npm', ['test', '--silent'], executionRoot, 180000);
    if (r.ok === null) notes.push(`发现 scripts.test 但无法执行(${r.out})——人工跑测试后手动提交`);
    else if (!r.ok) fails.push(`\`npm test\` 失败(项目测试入口不绿):\n${tailOf(r.out)}`);
    else lines.push('- 项目测试入口:`npm test` 通过');
  }
  if (!executed) notes.push('未发现可执行验收(无 test: 路径、无 package.json scripts.test)——本次绿闸仅做结构检查,代码事实由人工验收兜底');
  return { lines, fails, executed, notes };
};

// —— 红灯核验(出场时对 next.acceptance=test: 的提示,不阻断)——
const redLightCheck = async (root, next, cfg, executionRoot = root) => {
  if (!next || !String(next.acceptance ?? '').trim().startsWith('test:')) return [];
  const p = String(next.acceptance).trim().slice(5).trim();
  const chk = inspectTestPath(executionRoot, p);
  if (chk.bad) {
    return [`- 红灯 \`${p}\`:安检未通过(${chk.bad})——请先修正 TASKS 中的验收行`];
  }
  if (!chk.isPath) {
    const v = classifyAcceptance(chk.raw, cfg);
    if (v.bad) return [`- 红灯 \`${p}\`:安检未通过(${v.bad})——请先修正 TASKS 中的验收行`];
    const r = await runWhitelistedCmd(v.cmd, executionRoot);
    if (r.ok === true) return [`- 红灯 \`${p}\`(\`${v.cmd}\`):当前是绿的——下一任务可能已被完成,请人工确认意图`];
    if (r.ok === null) return [`- 红灯 \`${p}\`(\`${v.cmd}\`):无法执行(${r.out})——人工确认意图`];
    return [`- 红灯 \`${p}\`(\`${v.cmd}\`):确认当前为失败状态(接班者以让它变绿为目标)`];
  }
  if (!(await existsFile(chk.abs))) {
    return [`- 红灯 \`${p}\`:测试文件尚不存在——接班者第一件事是编写该失败测试(先红后绿)`];
  }
  if (/\.(m|c)?js$/i.test(chk.raw)) {
    const r = await runCmd('node', ['--test', chk.raw], executionRoot);
    if (r.ok === true) return [`- 红灯 \`${p}\`:当前是绿的——下一任务可能已被完成,请人工确认意图`];
    return [`- 红灯 \`${p}\`:确认当前为失败状态(接班者以让它变绿为目标)`];
  }
  return [];
};

// —— 认领锁(M3):.relay/claims/T###.lock,O_EXCL 原子创建,TTL 到期可接管 ——
// 与仓库写锁共用 util 的锁协议:JSON v2(兼容旧文本)、写失败清理、空/半初始化锁安全接管、
// token fencing。认领锁刻意关闭心跳(heartbeat:false):它的 TTL(240min)是崩溃恢复语义,
// 持续续租会让「agent 崩溃但 server 仍存活」的认领永不过期;仓库写锁才需要心跳。
const CLAIM_TTL_MIN = 240;
const claimLockRel = (task) => `.relay/claims/${task}.lock`;
const lockPathOf = (root, task) => join(root, claimLockRel(task));
const acquireClaimLock = async (root, task, model, ttlMin = CLAIM_TTL_MIN) => {
  let lock;
  try {
    lock = await acquireFileLock(root, claimLockRel(task), model, {
      staleMs: Math.max(0, ttlMin) * 60000,
      waitMs: 0,
      sameHolder: (holder) => holder === model,
      label: `任务 ${task} 认领锁`,
      heartbeat: false,
    });
  } catch (e) {
    return { ok: false, holder: '(锁路径异常)', ageMin: 0, ttlMin, warning: e?.message || String(e) };
  }
  if (!lock.ok) return { ok: false, holder: lock.holder, ageMin: lock.ageMin, ttlMin, warning: lock.warning };
  return { ok: true, created: lock.created, token: lock.token, tookOver: lock.tookOver, handle: lock };
};
const releaseClaimLock = async (root, task, token) => releaseFileLock(root, claimLockRel(task), token, `任务 ${task} 认领锁`);
const ownedClaimToken = async (root, task, model) => {
  const raw = await readFileSafe(lockPathOf(root, task), null);
  if (raw == null) return '';
  const info = parseLockContent(raw);
  return info.holder === model ? (info.token || '') : '';
};
const claimLockCheck = async (lock, task) => {
  const verdict = await lock.check();
  return verdict.held ? '' : `任务 ${task} 的认领锁已不属于当前会话(${verdict.warning || '已被接管'})`;
};

const text = (s) => (Array.isArray(s) ? s.join('\n') : s);

// ============================================================
// relay_session_start — 入场简报
// ============================================================
export const relaySessionStart = async (args = {}) => {
  const roots = await resolveRelayRoots(args.root || process.cwd());
  const root = roots.controlRoot;
  const executionRoot = roots.executionRoot;
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

  const lifecycleNotes = [];
  if (roots.managed) {
    try { await touchWorktree(root, executionRoot); }
    catch (e) { lifecycleNotes.push(`- worktree 活跃时间更新失败(不阻断): ${e?.message || String(e)}`); }
  } else {
    if (roots.linkedWorktree) {
      // fail-closed 提示:linked worktree 未登记时,完成出场会被拒绝,不再静默按单根处理
      lifecycleNotes.push(`- ⚠ linked worktree 未登记(registryState=${roots.registryState}):完成出场将被 fail-closed 拒绝;${registryRecoveryHint(root, roots.registryState)}`);
    }
    try {
      const wtConfig = await readWorktreeConfig(root);
      if (wtConfig.enabled && wtConfig.autoCleanup) {
        const cleaned = await cleanupWorktrees(root, { confirm: true, currentRoot: executionRoot });
        lifecycleNotes.push(`- 自动清理: 移除 ${cleaned.removed.length} 个,保留 ${cleaned.kept.length} 个,错误 ${cleaned.errors.length} 个${cleaned.errors.length ? '(不阻断简报)' : ''}`);
      }
    } catch (e) {
      lifecycleNotes.push(`- 自动清理失败(不阻断简报): ${e?.message || String(e)}`);
    }
  }
  // 依赖隔离 + 未合并分支:双根的核心认知,必须在进场时就说清
  try {
    const wtCfg = await readWorktreeConfig(root);
    if (wtCfg.enabled) {
      lifecycleNotes.push('- 依赖隔离:任务 worktree 不携带 node_modules/.env 等 gitignored 文件;需要依赖时在 executionRoot 内安装(或 symlink),不要依赖 controlRoot 的旧依赖(嵌套目录可能被 Node 向上解析到 controlRoot/node_modules)');
    }
  } catch { /* 配置不可读不阻断简报 */ }
  let unmergedBranches = [];
  try { unmergedBranches = await listUnmergedTaskBranches(root); } catch { /* 只读提示,失败不阻断 */ }

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

  // git 对账:代码状态属于 executionRoot,协议检查仍使用 controlRoot。
  const isRepo = isGitRepo(executionRoot);
  let dirty = null;
  let recentCommits = [];
  if (isRepo) {
    const st = await gitRun(executionRoot, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
    if (st.ok) dirty = st.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length >= 3);
    const lg = await gitRun(executionRoot, 'log', '--oneline', '-5');
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
    `- controlRoot: ${root}`,
    `- executionRoot: ${executionRoot}`,
    ...lifecycleNotes,
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
    '## 任务分支(完成≠合并)',
    ...formatUnmergedBranchesNote(unmergedBranches),
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
  // R-05/P2-14:model/task 会写入锁文件与 TASKS 任务行,换行/控制字符可伪造协议行或破坏锁结构 → 拒收
  if (hasControlChars(model)) return fail(controlCharError('model'));
  if (hasControlChars(task)) return fail(controlCharError('task'));
  const roots = await resolveRelayRoots(args.root || process.cwd());
  const root = roots.controlRoot;
  // R-08:symlink 防线。TASKS.md/LOG.md/.relay 写成符号链接时,协议读写会被引到仓库外,
  // 认领/出场这类状态变更必须先 fail-closed。
  const protoSafety = await checkProtocolFilesSafe(root);
  if (!protoSafety.ok) {
    return fail(`协议文件安全校验失败,拒绝认领:${protoSafety.error}`, [
      '', '修复:TASKS.md / LOG.md / .relay 必须是仓库内普通文件与目录(移除符号链接后重试)。',
    ]);
  }
  // registry fail-closed:注册表损坏时状态变更操作必须明确报错并给恢复指引,
  // 不能静默按「非受管」继续(会丢失受管 worktree 的提交/状态语义)。
  const regStatePre = await readWorktreeRegistryState(root);
  // P3-01:这里只读「是否启用」,不校验 cacheDir——显式 worktree:false 时配置非法也不能连累普通认领。
  const wtRawPre = await readWorktreeConfigRaw(root);
  const useWorktreePre = typeof args.worktree === 'boolean' ? args.worktree : wtRawPre.enabled;
  if (useWorktreePre && regStatePre.state === 'corrupt') {
    return fail(`worktree 注册表损坏,拒绝认领(无法安全判定受管状态):${regStatePre.error}`, [
      '', `修复:${registryRecoveryHint(root, 'corrupt')}`,
    ]);
  }
  // 仓库级写锁:TASKS、注册表和 Git worktree 的读改写必须独占。
  let claimLock;
  try {
    claimLock = await acquireRepoLock(root, `claim:${model}`);
  } catch (e) {
    return fail(`获取仓库写锁失败(可能是 .relay 目录/锁路径异常):${e?.message || String(e)}`, [
      '', '修复:确认 .relay 是仓库内普通目录、锁文件不是符号链接后重试。',
    ]);
  }
  if (!claimLock.ok) {
    return fail(`另一会话(**${claimLock.holder}**)正在本仓库出场/认领,请稍后重试(锁持有约 ${Math.round(claimLock.ageMs / 1000)}s;超 2 分钟自动可接管)。`);
  }
  let lock = null;
  let taskWorktree = null;
  try {
  const fence0 = await claimLock.check();
  if (!fence0.held) return fail(`仓库写锁在认领期间被接管(${fence0.warning || '锁已不属于当前会话'}),未做任何写入;请重试。`);
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
  // 是否可接管由认领锁的 TTL 裁决;TASKS.md 的持有者文本不能抢先把过期接管拒掉。
  const range = taskBlockRange(lines, idx);
  // 认领锁(M3):O_EXCL 原子创建,同模型幂等,TTL 到期可接管;防并行 read-modify-write 竞态
  const ttlMin = Number(args.ttl_minutes) > 0 ? Number(args.ttl_minutes) : CLAIM_TTL_MIN;
  const sameClaimant = p.meta === model || p.meta.startsWith(`${model}, `);
  if (p.status === '~' && !sameClaimant && !(await existsFile(lockPathOf(root, task)))) {
    // 锁文件被人为清理或崩溃恢复丢失时,TASKS 时间戳是仅剩的接管依据。
    const claimedAt = p.meta.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/);
    const claimedMs = claimedAt ? new Date(`${claimedAt[1].replace(' ', 'T')}:00`).getTime() : NaN;
    const ageMin = (Date.now() - claimedMs) / 60000;
    if (!Number.isFinite(ageMin) || ageMin < ttlMin) {
      return fail(`${task} 的认领锁不在场,TASKS.md 仍显示持有者为 **${p.meta || '(未知)'}**,且尚无证据证明认领已过期。`, [
        '', `修复:等待认领超过 TTL(${ttlMin} 分钟)后重试;不要通过删除锁绕过持有权。`,
      ]);
    }
  }
  lock = await acquireClaimLock(root, task, model, ttlMin);
  if (!lock.ok) {
    return fail(`${task} 的认领锁被 **${lock.holder}** 持有(已持有约 ${Math.round(lock.ageMin)} 分钟,TTL ${lock.ttlMin} 分钟)。并行协议下不得抢占。`, [
      '',
      `修复: 选择待办区其他未被认领的任务;确信持有方已崩溃,等锁超过 TTL(${lock.ttlMin} 分钟)后自动可接管,或传 ttl_minutes 覆盖。`,
      ...(lock.warning ? ['', `锁诊断:${lock.warning}`] : []),
    ]);
  }
  // P3-01 / R-06 / R-07:worktree 的三个前置条件互不连累——
  //   · 显式 worktree:false 完全不读/校验 worktree 配置(非法 cacheDir 不连累普通认领)
  //   · 无 Git / 无可用 HEAD → 降级单根 + WARN(不硬失败,保持补丁前的单根可用性)
  //   · 启用时先幂等补 .gitignore(实际 cacheDir + 注册表 + 锁),再创建缓存目录
  const worktreeNotes = [];
  const useWorktree = useWorktreePre;
  if (useWorktree) {
    let wtConfig = null;
    try {
      wtConfig = await readWorktreeConfig(root);
    } catch (e) {
      let releaseWarning = '';
      if (lock?.token && (lock.created || lock.tookOver)) {
        const rel = await releaseClaimLock(root, task, lock.token);
        if (!rel.ok && rel.warning) releaseWarning = rel.warning;
      }
      return fail(`worktree 配置非法,拒绝创建任务 worktree:${e?.message || String(e)}`, [
        '',
        '修复: 按提示修正 .relay/manifest.json 的 worktree.cacheDir(controlRoot 内相对路径,不含 ..、控制字符、绝对/盘符路径、.git 前缀)后重试;',
        '或传 `worktree: false` 显式走单根认领(该路径完全不读取 cacheDir 配置)。',
        ...(releaseWarning ? ['', `锁告警:${releaseWarning}`] : []),
      ]);
    }
    const headCheck = isGitRepo(root) ? await gitRun(root, 'rev-parse', '--verify', 'HEAD') : { ok: false, stdout: '' };
    if (!headCheck.ok || !String(headCheck.stdout || '').trim()) {
      worktreeNotes.push('- ⚠ worktree 降级单根: 当前仓库不是 Git 仓库或尚无可用 HEAD(无提交),未创建 executionRoot;完成首次提交后重新 relay_claim 即可获得任务 worktree');
    } else {
      try {
        const gi = await ensureWorktreeGitignore(root, wtConfig);
        if (gi.added.length) worktreeNotes.push(`- .gitignore: 已幂等补 ${gi.added.length} 条运行时忽略行(${gi.added.join(', ')}),避免缓存目录被 controlRoot 的提交卷入`);
        taskWorktree = await ensureTaskWorktree(root, task, model, wtConfig, {
          fencing: async () => {
            const verdict = await claimLock.check();
            return verdict.held ? { ok: true } : { ok: false, warning: verdict.warning };
          },
        });
        if (taskWorktree.rescuedOrphan) {
          worktreeNotes.push(`- ⚠ 发现未被 Git 登记的孤儿目录,已安全移至 \`${taskWorktree.rescuedOrphan}\` 后按分支重建;确认无未提交价值后可手工删除该 orphan 目录`);
        }
      } catch (e) {
        const msg = e?.message || String(e);
        if (/无法读取当前 HEAD|not a git repository/i.test(msg)) {
          // R-06:Git 环境不可用属于环境问题,降级单根而不是让认领硬失败
          worktreeNotes.push(`- ⚠ worktree 降级单根: ${msg}。未创建 executionRoot;修复 Git 环境后重新 relay_claim 即可获得任务 worktree`);
        } else {
          throw e;
        }
      }
    }
  }
  // fencing:worktree 创建等耗时步骤期间仓库锁可能被接管;写 TASKS 前复核 token 仍是自己的,
  // 否则宁可整次认领失败回滚,也不能把任务行写进别人的锁窗口。
  const fenceBeforeWrite = await claimLock.check();
  if (!fenceBeforeWrite.held) {
    throw new Error(`仓库写锁在认领期间被接管(${fenceBeforeWrite.warning || '锁已不属于当前会话'}),未写入 TASKS`);
  }
  const claimLease = await claimLockCheck(lock.handle, task);
  if (claimLease) throw new Error(claimLease);
  const blockLines = [`- [~] ${p.id} ${p.title}  (${model}, ${stamp()})`, ...lines.slice(idx + 1, range.end)];
  lines.splice(idx, range.end - idx);
  insertIntoSection(lines, '进行中', blockLines);
  // TASKS.md 原子写(tmp+rename)并带 fencing:TASKS 是任务队列唯一事实源,不能被半写截断。
  await writeProtocolFile(root, 'TASKS.md', tidy(lines), { token: claimLock.token, lockLabel: '仓库写锁' });
  const executionRoot = taskWorktree?.path || root;
  let unmergedBranches = [];
  try { unmergedBranches = await listUnmergedTaskBranches(root); } catch { /* 只读提示,失败不阻断认领 */ }
  // 成功路径显式释放仓库锁;失败返回告警而不是静默吞掉(token 不匹配 = 锁已被接管)。
  const claimRepoRelease = await claimLock.release();
  const releaseNote = claimRepoRelease.ok ? [] : ['', `> ⚠ 仓库写锁释放告警:${claimRepoRelease.warning}`];
  return {
    content: [{ type: 'text', text: [
      `# 任务认领 — ${task}`,
      '',
      `- 任务: ${p.id} ${p.title}`,
      `- 认领: ${model} @ ${stamp()}`,
      `- controlRoot: ${root}`,
      `- executionRoot: ${executionRoot}`,
      ...worktreeNotes,
      ...(taskWorktree ? [`- branch: ${taskWorktree.branch}`, `- baseSha: ${taskWorktree.baseSha}`, `- worktree: ${taskWorktree.reused ? '复用' : '新建'}`] : []),
      `- 认领锁: \`.relay/claims/${task}.lock\`${lock.created ? '(已创建' : '(同模型复领,已持有'}${lock.tookOver ? `,接管自 ${lock.tookOver}` : ''},TTL ${ttlMin} 分钟)`,
      '- 状态: controlRoot 的任务行已改为 `[~]` 并挪入「进行中」区(认领不产生 git 提交)',
      ...formatUnmergedBranchesNote(unmergedBranches).map((l) => l.replace(/^- 未合并/, '- 未合并').replace(/^  -/, '  -')),
      ...releaseNote,
      '',
      '提醒(并行模式):',
      `- 自此刻起,其他会话不得修改 ${task} 的任务行与相关代码;冲突以认领锁 + TASKS.md 认领标记为准。`,
      `- 在 executionRoot 修改代码并运行测试;TASKS.md / LOG.md 只由 relay 写回 controlRoot。`,
      ...(taskWorktree ? [
        '- 依赖隔离: 新 worktree 不携带 node_modules/.env 等 gitignored 文件;需要依赖时在 executionRoot 内安装(或 symlink),不要依赖 controlRoot 的旧依赖',
        '- 完成≠合并: 出场只提交任务分支并更新 controlRoot 协议面,不会自动 merge/rebase/push',
      ] : []),
      `- 完成时出场:\`relay_session_end { "root": "${executionRoot}", "model": "${model}", "summary": "…", "done_task": "${task}", "next": { "title": "…", "acceptance": "…" } }\`(出场成功自动释放认领锁)`,
    ].join('\n') }],
    isError: false,
  };
  } catch (e) {
    let rollbackError = '';
    if (taskWorktree) {
      try {
        await rollbackTaskWorktree(root, task, taskWorktree, {
          fencing: async () => {
            const verdict = await claimLock.check();
            return verdict.held ? { ok: true } : { ok: false, warning: verdict.warning };
          },
        });
      }
      catch (rollback) { rollbackError = rollback?.message || String(rollback); }
    }
    let releaseWarning = '';
    if (lock?.token && (lock.created || lock.tookOver)) {
      const rel = await releaseClaimLock(root, task, lock.token);
      if (!rel.ok && rel.warning) releaseWarning = `认领锁释放告警:${rel.warning}`;
    }
    const extras = [];
    if (rollbackError) extras.push('', `回滚警告:${rollbackError}`);
    if (releaseWarning) extras.push('', `锁告警:${releaseWarning}`);
    return fail(`认领失败:${e?.message || String(e)}。未保留本次半认领状态。`, extras);
  } finally {
    const finalRelease = await claimLock.release();
    if (!finalRelease.ok && finalRelease.warning) process.stderr.write(`[relay] claim 仓库锁释放告警:${finalRelease.warning}\n`);
  }
};

// 完成权限既要在验收前快速拒绝,也必须在仓库写锁内重验,堵住等待锁期间的接管竞态。
const completionOwnershipError = async (root, doneTask, model) => {
  const lines = await readLines(join(root, 'TASKS.md'));
  const idx = lines ? findTaskIdx(lines, doneTask) : -1;
  if (idx < 0) return null;
  const p = parseTaskLine(lines[idx]);
  const ownsClaim = p.meta === model || p.meta.startsWith(`${model}, `);
  if (p.status === '~' && !ownsClaim) {
    return `${doneTask} 的认领者是 **${p.meta || '(未知)'}**,当前 model=${model} 不是持有者。\n\n修复:由认领者出场;持有者崩溃时先按 TTL 接管,再完成任务。`;
  }
  if (p.status === 'x') {
    const log = await readText(join(root, 'LOG.md'));
    const canReplay = log != null && parseLogEntries(log)
      .some((e) => e.model === model && e.task === `${doneTask} 完成`);
    if (!canReplay) {
      return `${doneTask} 已完成;只有原完成模型可以幂等重跑,当前 model=${model} 无对应完成日志。\n\n修复:由原作者重跑,或省略 done_task 进行普通维护出场。`;
    }
  }
  return null;
};

// ============================================================
// relay_session_end — 出场协议(绿闸铁律)
// ============================================================
export const relaySessionEnd = async (args = {}) => {
  const roots = await resolveRelayRoots(args.root || process.cwd());
  const root = roots.controlRoot;
  const executionRoot = roots.executionRoot;
  const managed = roots.managed;
  const linkedWorktree = roots.linkedWorktree === true;
  const registryState = roots.registryState || 'not-applicable';
  const model = String(args.model ?? '').trim().replace(/\|/g, '/') || 'unknown';
  // summary/blocked 是自由文本:扁平化为单行(不拒绝),避免把多行内容注入 LOG/TASKS;
  // model/next.*/negative_results 是结构字段:换行/控制字符可伪造协议行,一律拒收。
  const summary = typeof args.summary === 'string' ? flattenText(args.summary) : '';
  const out = [`# relay 出场 — ${root}`, '', `- controlRoot: ${root}`, `- executionRoot: ${executionRoot}`, ''];
  out.push(`- 模式: ${managed ? 'managed(受管任务 worktree,registry 已登记)' : linkedWorktree ? `linked worktree 未登记(registryState=${registryState})` : '单根(controlRoot == executionRoot)'}`);

  // 1. 参数校验(summary 必填 / 结构字段净化)
  if (hasControlChars(model)) {
    out.push('## 参数校验失败', '', controlCharError('model'));
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  if (!summary) {
    out.push('## 参数校验失败', '', '`summary` 必填:出场必须留下会话摘要——这是无信任交接的最低要求。', '', '修复: 补上 summary(做了什么/结果如何/留给下一棒什么)后重跑 relay_session_end。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const doneTask = String(args.done_task ?? '').trim();
  if (doneTask && !/^T\d+$/.test(doneTask)) {
    out.push('## 参数校验失败', '', `\`done_task\` 须形如 T003,收到:“${doneTask}”。`, '', '修复: 传入 TASKS.md 中存在的任务号,或省略 done_task(无完成任务的会话)。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const blocked = String(args.blocked ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const next = args.next && typeof args.next === 'object' ? args.next : null;
  if (next) {
    for (const key of ['title', 'acceptance', 'notes']) {
      if (next[key] != null && hasControlChars(next[key])) {
        out.push('## 参数校验失败', '', controlCharError(`next.${key}`));
        return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
      }
    }
  }
  if (next && (!String(next.title ?? '').trim() || !String(next.acceptance ?? '').trim())) {
    out.push('## 参数校验失败', '', '`next` 需同时提供 `title` 与 `acceptance`(验收是下一任务的完成判定,不可为空)。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const negatives = Array.isArray(args.negative_results)
    ? args.negative_results.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const badNegative = negatives.find((s) => hasControlChars(s));
  if (badNegative != null) {
    out.push('## 参数校验失败', '', controlCharError('negative_results 条目'));
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  // R-08:协议文件/运行时目录 symlink 防线——先于绿闸、测试与任何写入。
  const protoSafety = await checkProtocolFilesSafe(root);
  if (!protoSafety.ok) {
    out.push('## 协议文件安全校验失败 — 未提交', '',
      `协议文件/运行时目录不安全,拒绝出场:${protoSafety.error}`, '',
      '修复:TASKS.md / LOG.md / .relay 必须是仓库内普通文件与目录(移除符号链接后重试)。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  // 完成权限先于绿闸:越权请求不得执行测试、提交或改动协议文件。
  if (doneTask) {
    const ownershipError = await completionOwnershipError(root, doneTask, model);
    if (ownershipError) {
      out.push('## 完成权限校验失败 — 未提交', '', ownershipError);
      return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
    }
  }

  // 1.5 根错配 / 注册表 fail-closed(先于任何测试与写入)
  const regState = await readWorktreeRegistryState(root);
  if (doneTask && regState.state === 'corrupt') {
    out.push('## worktree 注册表损坏 — 未提交', '',
      `无法安全判定 ${doneTask} 的受管 worktree 状态:${regState.error}`, '',
      '受管身份依赖 `.relay/worktrees.json`;注册表损坏时 relay 不会猜测受管状态,也不会按单根静默完成(那会绕过 executionRoot 的代码提交与验收)。', '',
      `修复:${registryRecoveryHint(root, 'corrupt')}`);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  if (!managed && linkedWorktree && doneTask) {
    out.push('## 根错配 — 未提交', '',
      `当前目录是 controlRoot 的 linked worktree,但没有 relay 登记(registryState=${registryState});无法确认它对应哪个任务/分支。`, '',
      '本次未更新 TASKS/LOG、未提交、未释放认领锁。', '',
      `修复:${registryRecoveryHint(root, registryState)}`);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  if (!managed && linkedWorktree && !doneTask) {
    out.push('', `> ⚠ 当前目录是未登记的 linked worktree(registryState=${registryState}):本次按维护出场处理;`
      + `完成出场将被 fail-closed 拒绝。${registryRecoveryHint(root, registryState)}`);
  }
  // 从 controlRoot 完成「仍有受管 worktree」的任务 = 假完成(F3):**一律** fail-closed。
  // Lead 决策:移除“空 worktree 保留单根兼容”的例外——不再以「工作树干净 / 分支仍等于 baseSha」
  // 放行;受管任务必须在 executionRoot 出场,才能拿到「代码提交 + 控制面提交」的成对证据。
  let registryScanNote = '';
  if (!managed && doneTask) {
    const record = regState.state === 'ok' ? regState.registry.worktrees.find((w) => w && w.task === doneTask) : null;
    if (record && record.status !== 'completed') {
      const ev = await taskWorktreeEvidence(root, record);
      out.push('## 根错配 — 未提交', '',
        `任务 ${doneTask} 由 relay 管理的 executionRoot 仍登记为未完成:${ev.absPath || '(注册表缺路径)'}(分支 ${ev.branch || '?'},status=${record.status})。`,
        `- 工作树:${ev.exists ? (ev.dirtyCount ? `${ev.dirtyCount} 处未提交改动` : '干净') : '目录不存在'}`
          + `${ev.ahead ? `;分支 HEAD(${ev.headSha.slice(0, 12)})≠baseSha(${ev.baseSha.slice(0, 12)}),已有未合并提交` : ''}`,
        '',
        '从 controlRoot 完成会绕过 executionRoot 的代码提交与验收,属于假完成(无论工作树是否干净、分支是否仍等于 baseSha);'
          + '本次未更新 TASKS/LOG、未提交、未释放认领锁。', '',
        `修复:cd ${ev.absPath || '<executionRoot>'} 后重跑 relay_session_end { "root": "${ev.absPath || '<executionRoot>'}", "model": "${model}", "summary": "…", "done_task": "${doneTask}" };`
          + '若确认该任务确实没有代码内容,也必须在 executionRoot 完成(受管模式要求成对证据),不要从 controlRoot 单根完成。');
      return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
    }
    // 注册表缺失/损坏/记录已丢失时:不能因为「注册表里查不到」就按单根静默完成。
    // 用 git worktree list(relay/<task> 是否仍被某个 worktree checkout)+ 受管缓存路径存在性反查,
    // 存在受管痕迹即 fail-closed,并给出重建登记 / 从 executionRoot 出场的可执行指引。
    if (!record) {
      const evidence = await findManagedWorktreeEvidence(root, doneTask, { registry: regState.registry });
      if (evidence.found) {
        const suggestedRoot = evidence.worktreePath || path.join(root, '.relay', 'worktrees', doneTask);
        out.push('## 根错配 — 未提交', '',
          `任务 ${doneTask} 仍存在受管 worktree 痕迹(registryState=${regState.state}),但当前出场根是 controlRoot:`,
          ...evidence.reasons.map((r) => `- ${r}`),
          '',
          '注册表记录可能丢失/损坏,relay 不会按单根静默完成(那会绕过 executionRoot 的代码提交与验收);'
            + '本次未更新 TASKS/LOG、未提交、未释放认领锁。', '',
          `修复:1) 在 controlRoot 运行 relay_claim { "root": "${root}", "task": "${doneTask}", "worktree": true } 重建登记;`
            + `2) cd "${suggestedRoot}" 后从 executionRoot 重跑 relay_session_end;`
            + '3) 若确认该任务不再需要 worktree,先 relay_worktree_cleanup 处理后再完成。');
        return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
      }
      if (regState.state !== 'ok') {
        registryScanNote = `registryState=${regState.state},且未发现该任务的受管 worktree 痕迹:按单根维护出场处理`;
      }
    }
  }

  // 2. 绿闸:controlRoot 全量 + executionRoot 任务树结构检查(R1/R2/R3/R4/R8);
  //    任一 ERROR → 不更新任何文件、不提交。
  const cfg = await readManifestConfig(root); // P1/P2/P6 的配置面在此一次性读入
  const controlResults = await runChecks(root, { full: true });
  let taskResults = [];
  let taskGateNote = '';
  if (executionRoot !== root) {
    if (isGitRepo(executionRoot)) {
      taskResults = await runTaskTreeChecks(executionRoot, root);
    } else {
      taskGateNote = 'executionRoot 不是 Git 工作树,跳过任务树结构检查(managed 提交会随后拒绝)';
    }
  }
  const controlErrors = controlResults.filter((c) => c.result === 'ERROR');
  const taskErrors = taskResults.filter((c) => c.result === 'ERROR');
  const errors = [...controlErrors, ...taskErrors];
  const warns = [...controlResults.filter((c) => c.result === 'WARN'), ...taskResults.filter((c) => c.result === 'WARN')];
  const taskGateSummary = taskResults.length ? `executionRoot 任务树 ${taskResults.length} 项(R1/R2/R3/R4/R8)` : '';
  if (errors.length) {
    out.push('## 绿闸:未通过 — 未提交', '',
      `controlRoot 全量 ${controlResults.length} 项(ERROR ${controlErrors.length})`
        + (taskGateSummary ? `;${taskGateSummary}(ERROR ${taskErrors.length})` : '')
        + '。按出场协议:**未更新任何文件,未提交**。', '',
      '修复清单:', '');
    for (const e of controlErrors) {
      out.push(`- **${e.id}**(controlRoot) ${e.detail}`);
      if (e.fix) out.push(`  ${e.fix}`);
    }
    for (const e of taskErrors) {
      out.push(`- **${e.id}**(executionRoot,真正待提交的任务树) ${e.detail}`);
      if (e.fix) out.push(`  ${e.fix}`);
    }
    out.push('', '逐条修复后重跑 `relay_session_end`(任务树违规必须在 executionRoot 修好并提交)。');
    if (warns.length) {
      out.push('', '另附 WARN(不阻断,建议一并处理):');
      for (const w of warns) out.push(`- ${w.id} ${w.detail}`);
    }
    out.push('', '---', '', formatChecks(controlResults, { root, full: true }));
    if (taskResults.length) {
      out.push('', formatChecks(taskResults, { root: executionRoot, full: false, mode: 'executionRoot 任务树(R7/R9 只在 controlRoot 跑)' }));
    }
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  // 2.5 验收执行门(H1):完成声明必须有可执行的绿灯背书;不绿 → 不改任何文件、不提交
  const acc = await acceptanceGate(root, doneTask || null, cfg, executionRoot);
  if (acc.fails.length) {
    out.push('## 验收执行门:未通过 — 未提交', '',
      `完成声明 \`${doneTask || '(本次会话)'}\` 缺少可执行验收的绿灯背书。按出场协议:**未更新任何文件,未提交**。`, '',
      '失败明细:', '');
    for (const f of acc.fails) out.push(`- ${f.split('\n').join('\n  ')}`);
    out.push('', '修复:让上述测试真正通过(而不是删测试/改验收行),再重跑 relay_session_end。');
    if (acc.lines.length) out.push('', '已通过的验收:', ...acc.lines);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  const redLights = await redLightCheck(root, next, cfg, executionRoot);

  // 2.6 仓库级写锁(H-C):TASKS/LOG 的读改写从此处到提交完成必须独占——
  // 两个会话并发出场时,败者的更新曾基于旧快照覆写胜者(实测丢更新)。持锁期间心跳(util 锁协议)
  // 让长临界区不再被 120s stale 规则误判;关键写点前用 fencing 复核锁仍属于本会话。
  let exitLock;
  try {
    exitLock = await acquireRepoLock(root, `session-end:${model}`);
  } catch (e) {
    out.push('## 并发出场:被拒 — 未提交', '',
      `获取仓库写锁失败(可能是 .relay 目录/锁路径异常):${e?.message || String(e)}`, '',
      '修复:确认 .relay 是仓库内普通目录、锁文件不是符号链接后重试。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  if (!exitLock.ok) {
    out.push('## 并发出场:被拒 — 未提交', '',
      `另一会话(**${exitLock.holder}**)正在本仓库出场/认领(锁已持有约 ${Math.round(exitLock.ageMs / 1000)}s)。`, '',
      '修复:等待对方出场完成后重跑 relay_session_end;若确认对方已崩溃,锁超过 2 分钟会自动可接管。');
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  try {
  const fenceAtStart = await exitLock.check();
  if (!fenceAtStart.held) {
    out.push('## 并发出场:被拒 — 未提交', '', `仓库写锁在出场前被接管(${fenceAtStart.warning || '锁已不属于当前会话'}),未做任何写入;请重试。`);
    await exitLock.release();
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  if (doneTask) {
    const ownershipError = await completionOwnershipError(root, doneTask, model);
    if (ownershipError) {
      out.push('## 完成权限校验失败 — 未提交', '', ownershipError);
      return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
    }
  }
  // 受保护路径检测:代码改动只从 executionRoot 读取。
  const isRepo = isGitRepo(executionRoot);
  let statusLines = [];
  let statusError = '';
  if (isRepo) {
    const st = await gitRun(executionRoot, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
    // 只剥行尾换行:porcelain 的 XY 状态位是定宽字段,trim 吃掉前导空格会让下游 slice(3) 截错路径
    if (st.ok) statusLines = st.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length >= 3);
    else statusError = st.stderr || st.stdout || '未知原因';
  }
  const protectedHits = findProtectedChanges(statusLines, (cfg && cfg.protectedPaths) || []);
  const sensitiveHits = findSensitiveChanges(statusLines);

  // controlRoot 的未提交清单:managed 双提交只允许 TASKS.md/LOG.md 进入控制面提交;
  // controlRoot 上出现的其它改动(典型:代码被误写在主工作树)必须如实列出、不得假装已提交。
  let controlStatusLines = [];
  let controlStatusError = '';
  if (isRepo && root !== executionRoot) {
    const cst = await gitRun(root, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
    if (cst.ok) controlStatusLines = cst.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length >= 3);
    else controlStatusError = cst.stderr || cst.stdout || '未知原因';
  }
  const controlExtras = controlStatusLines.filter((l) => !isProtocolStatusLine(l));

  // fencing:代码提交/TASKS 写入前复核仓库锁仍属于本会话;被接管时立即停手(宁可不提交,
  // 也不能让两套出场流程同时改协议面)。此检查在 managed 代码提交之前与 TASKS 写入之前各做一次。
  const fenceBeforeCommit = await exitLock.check();
  if (!fenceBeforeCommit.held) {
    out.push('## 并发出场:被拒 — 未提交', '', `仓库写锁在出场期间被接管(${fenceBeforeCommit.warning || '锁已不属于当前会话'}),未做任何写入;请重试。`);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }

  // managed 出场:先落 executionRoot 代码提交,再落 controlRoot 控制面提交(双提交);
  // 任何一步失败都不得盖完成章,也不得释放认领锁。
  let managedCommit = null;
  let controlCommit = null;
  let controlCommitSkipped = '';
  let managedEvidence = [];
  if (managed) {
    const record = roots.record || null;
    const branch = record?.branch || '';
    const managedHead = doneTask ? `${doneTask} 完成 · ` : '';
    const managedMessage = ((cfg && cfg.commitMessageTemplate) || DEFAULT_COMMIT_TEMPLATE)
      .replaceAll('{{task}}', managedHead)
      .replaceAll('{{taskId}}', doneTask)
      .replaceAll('{{summary}}', summary.split('\n')[0].trim())
      .slice(0, 80);
    const rejectCommit = (reason) => {
      out.push('## 代码提交失败 — 未更新 TASKS/LOG', '', reason, '',
        `controlRoot 的 ${doneTask || '(本次会话)'} 保持原状态,认领锁保留。修复 executionRoot 后重跑出场。`);
      return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
    };
    if (!isRepo) return rejectCommit('executionRoot 不是 Git 工作树,无法持久化任务代码。');
    if (statusError) return rejectCommit(`无法读取 executionRoot 的 git status:${statusError}`);
    if (controlStatusError) return rejectCommit(`无法读取 controlRoot 的 git status,不能安全做控制面提交:${controlStatusError}`);
    if (doneTask && (!record || !branch)) return rejectCommit(`executionRoot 的任务目录与 ${doneTask} 的注册记录不匹配。`);
    // roots.record 是按 executionRoot 路径反查的;必须显式核对 doneTask 否则会在 T003 的
    // executionRoot 里把 T004 标完成(跨任务串改,成对证据会记到错误任务上)。
    if (doneTask && record && record.task !== doneTask) {
      return rejectCommit(`executionRoot 登记的是 ${record.task},与 done_task=${doneTask} 不一致:受管任务必须在本人的 executionRoot 出场。`);
    }
    // baseSha 是「任务分支是否有新提交」的唯一基准;记录缺失时不能靠 HEAD 自证完成(fail-closed)。
    if (doneTask && !record.baseSha) {
      return rejectCommit(`受管记录缺少 baseSha,无法校验任务分支相对基点是否有新提交(注册表可能被手工篡改或来自旧版本);`
        + '请在 controlRoot 修复注册表或重新 claim 后再出场。');
    }
    const actualBranch = await gitRun(executionRoot, 'branch', '--show-current');
    if (doneTask) {
      if (!actualBranch.ok || actualBranch.stdout.trim() !== branch) {
        return rejectCommit(`executionRoot 的任务分支与 ${doneTask} 不匹配:预期 ${branch},实际 ${actualBranch.stdout.trim() || '(未知)'}。`);
      }
    } else if (!actualBranch.ok || !actualBranch.stdout.trim()) {
      return rejectCommit('executionRoot 处于 detached HEAD,无法提交代码;请先切到任务分支再出场。');
    }
    // 协议文件只能由 relay 写 controlRoot;任务树里出现 TASKS/LOG 改动必须拒绝,
    // 否则会把「控制面副本」混进代码提交,造成双根状态分叉。
    const protocolInTaskTree = statusLines.filter((l) => isProtocolStatusLine(l));
    if (protocolInTaskTree.length) {
      return rejectCommit(`executionRoot 出现协议文件改动(${protocolInTaskTree.map(statusPathOf).join(', ')}):`
        + 'TASKS.md/LOG.md 只能由 relay 写 controlRoot。请在任务树还原这两个文件后重跑。');
    }
    const conf = await gitRun(executionRoot, '-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U');
    if (conf.ok && conf.stdout.trim()) return rejectCommit(`存在未解决冲突:${conf.stdout.trim().split('\n').join(', ')}`);
    if (protectedHits.length || sensitiveHits.length) {
      return rejectCommit(`受保护或敏感路径需人工提交:${[...protectedHits, ...sensitiveHits].map((h) => h.path).join(', ')}`);
    }
    if (statusLines.length && cfg.autoCommit === false) {
      return rejectCommit('manifest.autoCommit=false,且 executionRoot 尚有未提交代码;请人工提交后重跑。');
    }
    if (statusLines.length) {
      const added = await gitRun(executionRoot, 'add', '-A');
      if (!added.ok) return rejectCommit(`git add 失败:${added.stderr || added.stdout}`);
      const committed = await gitRun(executionRoot, ...(await gitIdentityArgs(executionRoot)), 'commit', '-m', managedMessage);
      if (!committed.ok) return rejectCommit(`git commit 失败:${committed.stderr || committed.stdout}`);
    }
    const sha = await gitRun(executionRoot, 'rev-parse', 'HEAD');
    if (!sha.ok || !sha.stdout.trim()) return rejectCommit(`无法读取任务分支提交 SHA:${sha.stderr || sha.stdout}`);
    const codeSha = sha.stdout.trim();
    // 伪 SHA 闸:HEAD 仍等于 baseSha 且本次无任何改动 → 没有可验收的代码提交。
    if (doneTask && !statusLines.length && record?.baseSha && codeSha === record.baseSha) {
      return rejectCommit(`伪 SHA:任务分支 HEAD 仍等于 baseSha(${codeSha.slice(0, 12)}),本次没有任何新提交或改动;`
        + '禁止把 base SHA 当作完成证据。请在 executionRoot 提交代码(或确认任务确实产生了已提交改动)后重跑。');
    }
    managedCommit = {
      branch: branch || actualBranch.stdout.trim(),
      sha: codeSha, message: managedMessage,
      hadChanges: statusLines.length > 0, baseSha: record?.baseSha || '',
    };
  }

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
  // fencing + 原子写:TASKS.md 是任务队列唯一事实源,tmp+rename 防半写截断,写前复核锁归属。
  const fenceBeforeTasks = await exitLock.check();
  if (!fenceBeforeTasks.held) {
    out.push('## 并发出场:被拒 — 未提交', '', `仓库写锁在出场期间被接管(${fenceBeforeTasks.warning || '锁已不属于当前会话'}),未更新 TASKS/LOG;请重试。`);
    return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
  }
  await writeProtocolFile(root, 'TASKS.md', tidy(tLines), { token: exitLock.token, lockLabel: '仓库写锁' });

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
  if (managedCommit && doneTask) entry.push(`- worktree: branch=${managedCommit.branch}; sha=${managedCommit.sha}; 已验收,未合并(是否合并由人工决定)`);
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
    await writeProtocolFile(root, 'LOG.md', tidy(lLines), { token: exitLock.token, lockLabel: '仓库写锁' });
    changes.push(`LOG.md: 顶部新增条目「${entry[0]}」`);
  } else {
    changes.push('LOG.md: 最新条目即本次出场(幂等跳过,不重复记录)');
  }

  // 5/6. 提交分支:护栏 → 不提交;否则 add -A + commit;失败 → 降级
  // 提交消息携带「T### 完成」token:TASKS 完成行不记 sha(自指无解),考古靠 git log --grep
  const firstLine = summary.split('\n')[0].trim();
  const head = doneTask ? `${doneTask} 完成 · ` : '';
  // P6 模板变量:{{task}} = 任务前缀(含「 · 」分隔符,与补丁前 head 逐字符一致),
  // {{taskId}} = 纯任务号(供 [[{{taskId}}] {{summary}}] 这类干净模板使用),{{summary}} = 摘要首行。
  const tpl = (cfg && cfg.commitMessageTemplate) || DEFAULT_COMMIT_TEMPLATE;
  const commitMsg = tpl
    .replaceAll('{{task}}', head)
    .replaceAll('{{taskId}}', doneTask)
    .replaceAll('{{summary}}', firstLine)
    .slice(0, 80);
  // 人工建议命令串专用:码点安全截断 + POSIX 双引号内元字符转义(防 summary 自由文本注入);
  // 自动提交不走此串(gitRun 以 argv 传参,无 shell 解析)
  const commitMsgSh = Array.from(commitMsg).slice(0, 80).join('')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\`');
  let commitSection = null;
  let guardSection = null;
  let degradeReason = null;
  let commitSha = managedCommit?.sha || '';

  // P6 冲突守卫优先于一切护栏:护栏章节附带的「git add -A && git commit」人工指令,
  //   在有未解决冲突时会把冲突态写进历史 —— 冲突必须先说、且只说冲突。
  let conflictGuard = null;
  if (!managedCommit && isRepo) {
    const conf = await gitRun(executionRoot, '-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U');
    const conflicted = (conf.ok ? conf.stdout : '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (conflicted.length) {
      conflictGuard = [
        '## 护栏:存在未解决的合并冲突,未自动提交', '',
        'git 检出未合并路径(U = unmerged)。把冲突态自动提交会让历史不可复现,必须人工先解决:', '',
        ...conflicted.map((p) => `- \`${p}\``), '',
        '处理建议:人工解决冲突并 git add 对应路径后重新出场;或自行 git merge --abort / git rebase --abort 回退。', '',
        `TASKS.md / LOG.md 已照常更新。解决冲突后人工提交:`, '',
        '```sh',
        `git add -A && git commit -m "${commitMsgSh}"`,
        '```',
      ];
    }
  }

  if (managed) {
    // 双提交的第二步:controlRoot 只提交 TASKS.md / LOG.md(路径限定,绝不卷入其它改动),
    // 随后校验「成对证据」——任务分支代码提交 + 控制面提交 + LOG 记录 branch+sha。
    if (cfg && cfg.autoCommit === false) {
      controlCommitSkipped = 'manifest.autoCommit = false(控制面未提交)';
    } else {
      // TASKS 完成行不记 sha(自指无解),考古靠提交消息 token:自定义模板若不含任务号则补前缀
      const controlCommitMsg = doneTask && !commitMsg.includes(`${doneTask} 完成`)
        ? `${doneTask} 完成 · ${commitMsg}`.slice(0, 80) : commitMsg;
      const added = await gitRun(root, 'add', '--', 'TASKS.md', 'LOG.md');
      if (!added.ok) {
        out.push('## 控制面提交失败 — 未落完成状态', '',
          `executionRoot 代码已提交(${managedCommit?.sha || '?'}),但 controlRoot 的 TASKS/LOG 暂存失败:${added.stderr || added.stdout}`, '',
          '本次未更新注册表完成状态、未释放认领锁;TASKS.md/LOG.md 已在工作区更新。修复后重跑 relay_session_end 补交(幂等)。');
        return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
      }
      const staged = await gitRun(root, 'diff', '--cached', '--name-only', '--', 'TASKS.md', 'LOG.md');
      const stagedNames = staged.ok ? staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
      if (stagedNames.length) {
        const cR = await gitRun(root, ...(await gitIdentityArgs(root)), 'commit', '-m', controlCommitMsg, '--', 'TASKS.md', 'LOG.md');
        if (!cR.ok) {
          out.push('## 控制面提交失败 — 未落完成状态', '',
            `git commit(TASKS.md/LOG.md)失败:${(cR.stderr || cR.stdout || '').split('\n').find(Boolean) || '未知原因'}`, '',
            'executionRoot 代码提交保留;controlRoot 协议面未提交、注册表未更新、认领锁保留。修复后重跑出场补交(幂等)。');
          return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
        }
      }
      const shaR = await gitRun(root, 'rev-parse', 'HEAD');
      controlCommit = {
        sha: shaR.ok ? shaR.stdout.trim() : '',
        message: controlCommitMsg,
        committed: stagedNames.length > 0,
      };
    }
    if (doneTask && !controlCommitSkipped) {
      const ev = await verifyDualEvidence({
        controlRoot: root, executionRoot, doneTask,
        codeSha: managedCommit?.sha, controlSha: controlCommit?.sha, branch: managedCommit?.branch,
      });
      if (ev.fails.length) {
        out.push('## 成对证据校验失败 — 未落完成状态', '',
          'managed 完成要求「任务分支代码提交 + controlRoot 控制面提交」成对存在:', '',
          ...ev.fails.map((f) => `- ${f}`), '',
          'TASKS.md/LOG.md 已在工作区更新但未更新注册表;修复后重跑 relay_session_end 补交。');
        return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
      }
      managedEvidence = ev.lines;
    }
    if (managedCommit) {
      commitSection = [
        `- 代码(executionRoot): \`${managedCommit.sha}\` ${managedCommit.message}${managedCommit.hadChanges ? '' : '(本次无新改动,复用既有提交)'}`,
        ...(controlCommit
          ? [`- 控制面(controlRoot): \`${controlCommit.sha}\` ${controlCommit.message}${controlCommit.committed ? '' : '(控制面已是最新,无新提交)'}`]
          : []),
        '- 任务分支已验收,未合并;是否合并由人工决定',
        ...managedEvidence,
      ];
      if (controlCommitSkipped) {
        commitSection.push(`- ⚠ ${controlCommitSkipped}:TASKS.md/LOG.md 已更新但未进入 git,完成记录不具持久性,请人工提交`);
      }
    }
  } else if (conflictGuard) {
    guardSection = conflictGuard;
    if (protectedHits.length || sensitiveHits.length) {
      guardSection.push('', `(另有 ${protectedHits.length} 个受保护路径改动、${sensitiveHits.length} 个疑似敏感文件在场,解决冲突后一并按护栏流程人工过目)`);
    }
  } else if (protectedHits.length || sensitiveHits.length) {
    const parts = ['## 护栏:需人类批准,未自动提交', ''];
    if (protectedHits.length) {
      parts.push(`本会话改动了受保护路径(内置:verify 脚本 / .relay/** / tests/** / *.test.* / *.spec.*${(cfg.protectedPaths || []).length ? `;另加 manifest.protectedPaths ${(cfg.protectedPaths || []).map((x) => `\`${x.pattern}\``).join(' ')}` : ''}):`,
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
      `git add -A && git commit -m "${commitMsgSh}"`,
      '```');
    guardSection = parts;
  } else if (!isRepo) {
    degradeReason = '非 git 仓库';
  } else if (cfg && cfg.autoCommit === false) {
    degradeReason = 'manifest.autoCommit = false(只更新文件,不自动提交)';
  } else {
    const addR = await gitRun(executionRoot, 'add', '-A');
    if (!addR.ok) {
      degradeReason = `git add 失败: ${(addR.stderr || addR.stdout || '').split('\n').find(Boolean) || '未知原因'}`;
    } else {
      const cR = await gitRun(executionRoot, ...(await gitIdentityArgs(executionRoot)), 'commit', '-m', commitMsg);
      if (!cR.ok) {
        degradeReason = `git commit 失败: ${(cR.stderr || cR.stdout || '').split('\n').find(Boolean) || '未知原因'}`;
      } else {
        const shaR = await gitRun(executionRoot, 'rev-parse', '--short', 'HEAD');
        commitSha = shaR.ok ? shaR.stdout.trim() : '';
        commitSection = [`- \`${commitSha}\` ${commitMsg}`];
        if (doneTask) commitSection.push(`- 完成提交可反查:\`git log --grep "${doneTask} 完成"\``);
        if (root !== executionRoot) {
          // 未登记的 linked worktree(维护出场):代码提交在任务分支,协议面写 controlRoot;
          // 再把 TASKS/LOG 作为独立控制面提交,避免把主工作树留成脏状态。
          const cAdd = await gitRun(root, 'add', '--', 'TASKS.md', 'LOG.md');
          const cStaged = cAdd.ok ? await gitRun(root, 'diff', '--cached', '--name-only', '--', 'TASKS.md', 'LOG.md') : null;
          const cNames = cStaged && cStaged.ok ? cStaged.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
          if (!cAdd.ok) {
            commitSection.push(`- ⚠ 控制面(controlRoot)未提交:git add 失败(${cAdd.stderr || cAdd.stdout})`);
          } else if (cNames.length) {
            const cR2 = await gitRun(root, ...(await gitIdentityArgs(root)), 'commit', '-m', commitMsg, '--', 'TASKS.md', 'LOG.md');
            if (!cR2.ok) {
              commitSection.push(`- ⚠ 控制面(controlRoot)未提交:git commit 失败(${(cR2.stderr || cR2.stdout || '').split('\n').find(Boolean) || '未知原因'})`);
            } else {
              const cs = await gitRun(root, 'rev-parse', '--short', 'HEAD');
              commitSection.push(`- 控制面(controlRoot): \`${cs.ok ? cs.stdout.trim() : ''}\` ${commitMsg}(仅 TASKS.md/LOG.md)`);
            }
          }
        }
      }
    }
  }
  // 认领锁释放:提交成功或降级(非 git)即任务已落定;护栏/根错配路径保留锁(见 guardSection)。
  // 注册表完成状态只在「代码提交(+控制面提交)都成立」后落账,避免崩溃窗口留下完成假象。
  // 注:strict 根错配已移除「空 worktree 单根完成」路径,所以这里不再有 completedFrom=controlRoot 分支。
  const settled = !!(commitSection || degradeReason);
  let lockNote = '';
  const registryWarnings = [];
  if (doneTask) {
    if (managedCommit && settled) {
      try {
        await upsertWorktreeRecord(root, doneTask, {
          status: 'completed',
          commitSha: managedCommit.sha,
          controlSha: controlCommit?.sha || null,
          controlCommitted: !!controlCommit,
          lastUsedAt: nowIso(),
        }, {
          fencing: async () => {
            const verdict = await exitLock.check();
            return verdict.held ? { ok: true } : { ok: false, warning: verdict.warning };
          },
        });
      } catch (e) {
        registryWarnings.push(`注册表完成状态更新失败(完成提交已落账,需人工修复注册表):${e?.message || String(e)}`);
      }
    }
    const claimToken = await ownedClaimToken(root, doneTask, model);
    const claimRelease = settled
      ? await releaseClaimLock(root, doneTask, claimToken)
      : { ok: true, released: false, warning: '' };
    if (!claimRelease.ok && claimRelease.warning) registryWarnings.push(claimRelease.warning);
    lockNote = claimRelease.released
      ? `认领锁 \`.relay/claims/${doneTask}.lock\` 已释放`
      : (guardSection ? `认领锁保留(待人工批准提交)` : (claimRelease.ok ? `认领锁不在场或不属于当前模型(无需释放)` : `⚠ 认领锁未释放:${claimRelease.warning}`));
  }

  // 7. 汇总输出
  const controlWarns = controlResults.filter((c) => c.result === 'WARN');
  out.push('## 绿闸:通过', '',
    `- controlRoot 全量 ${controlResults.length} 项 — ERROR 0${controlWarns.length ? ` · WARN ${controlWarns.length}(建议处理,不阻断)` : ' · 无 WARN'}`);
  if (taskResults.length) out.push(`- executionRoot 任务树 ${taskResults.length} 项(R1/R2/R3/R4/R8)— ERROR 0`);
  if (taskGateNote) out.push(`- 注:${taskGateNote}`);
  for (const w of controlWarns) out.push(`- WARN ${w.id}: ${w.detail}`);
  for (const w of taskResults.filter((c) => c.result === 'WARN')) out.push(`- WARN ${w.id}@executionRoot: ${w.detail}`);
  if (controlExtras.length) {
    out.push('', '## 注意:controlRoot 另有未提交改动(不属于本出场,未提交)', '',
      ...controlExtras.map((l) => `- \`${l}\``), '',
      '代码改动必须提交在 executionRoot;上述改动留在 controlRoot,请人工处理(不要把它们算作本次出场提交)。');
  }
  if (registryScanNote) out.push('', '## 注意:注册表不可用但无受管痕迹', `- ${registryScanNote}`);
  if (registryWarnings.length) out.push('', '## 注册表/锁告警', ...registryWarnings.map((w) => `- ⚠ ${w}`));
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
      `git add -A && git commit -m "${commitMsgSh}"`,
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
  // 成功路径显式释放仓库锁:失败(token 不匹配 = 已被接管 / 释放 IO 错误)必须在输出里告警,
  // 不能像旧实现那样静默返回 false 让调用方以为锁已释放。
  const exitRelease = await exitLock.release();
  if (!exitRelease.ok && exitRelease.warning) {
    out.push('', '## 锁释放告警', `- ⚠ ${exitRelease.warning}(本会话写入已完成;若锁已被接管,请检查是否有并发出场)`);
  }
  out.push('', `- 出场时间: ${stamp()}(ISO ${nowIso()})`);
  return { content: [{ type: 'text', text: out.join('\n') }], isError: false };
  } finally {
    const fallbackRelease = await exitLock.release();
    if (!fallbackRelease.ok && fallbackRelease.warning && !fallbackRelease.released) {
      // 早期 return 分支的告警无处可写:至少留在服务端 stderr 便于排查,不吞掉。
      process.stderr.write(`[relay] session_end 仓库锁释放告警:${fallbackRelease.warning}\n`);
    }
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
