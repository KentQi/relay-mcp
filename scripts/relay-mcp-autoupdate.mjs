#!/usr/bin/env node
// relay-mcp-autoupdate.mjs — 启动时自检更新的 MCP 启动器
//
// 本文件由 relay-mcp 仓库版本控制(scripts/):它自己会随 ff-only 更新一起升级,
// 因此 harness 侧不需要单独维护这份启动器。
//
// 用法: node scripts/relay-mcp-autoupdate.mjs [relay-mcp 仓库路径]
//   仓库路径可省略——缺省时按本文件自身位置推导(scripts/ 的上一级就是仓库根),
//   显式传参仍生效(向后兼容 2026-11-27 之前 ~/.relay-mcp/ 旧用法)。
//
// 每次 harness 启动 relay MCP 时,先做一次「节流后的」更新自检,再拉起 MCP:
//   1) 节流:成功后 6 小时内不再检测;失败/异常则 10 分钟冷却
//   2) 安全前提(全部满足才更新,否则跳过并记日志):
//      · 当前分支必须是 main(HEAD 在旧 tag / 其它分支 / bisect 中绝不移动);
//      · 不是 linked worktree(git-dir 与 git-common-dir 不同则跳过——任务分支验收通过 ≠ 已合并);
//      · 工作区已跟踪文件无改动;
//      · 本地相对 origin/main 无独有提交。
//   3) 仓库公共 git 目录上的 O_EXCL 更新锁串行化并发 launcher;拿不到锁就启动当前版本。
//      fetch 后只捕获一次 origin/main SHA;发布显式 main ref 前落持久事务 journal,
//      用 Git 两树 read-tree -m -u 同步(拒绝覆盖并发本地编辑),终检后清 journal。
//      超时/信号整组终止 git 进程并等 close 结算;异常时绝不从可疑的树启动 MCP。
//   4) 失败不致命:自检失败只记日志与状态(fail 冷却),「无法判定」一律按失败处理,
//      绝不把 rev-list 失败折算成「已是最新」。
//   5) stdio 纯净:git 的 stdout/stderr 分开收集,日志只进日志文件,stdout 只有 MCP 的 JSON-RPC。
//
// 边界说明:
//   · 「失败不致命」指失败后仍会用**当前磁盘上的版本**启动;REPO 无 .git 或找不到
//     src/index.mjs 属于配置错误,直接 exit 2,不冒充「照常启动」。
//   · 「先更新再启动」只保护**本次新拉起**的进程:其它已在运行的 relay-mcp 进程
//     仍持有旧模块,首次调用工具时才动态 import 磁盘上的新文件。
//   · git fetch 即使被跳过合并,也早已把新对象/引用写入 .git——「放弃更新」
//     指不改变 HEAD 与工作树,不指 .git 内部零写入。
//   · SIGKILL 无法被 wrapper 转发;锁与事务 journal 保留。后续启动在节流判断之前
//     先证明 HEAD/main/index/worktree 同属 before 或 upstream 端点,否则 fail-closed。

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
  unlinkSync, renameSync, writeSync, openSync, closeSync, fstatSync,
  lstatSync, realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// 仓库根:显式 argv[2] 优先;缺省按本文件位置推导(scripts/../)。
// 这样 harness 配置只依赖「脚本在仓库内」这一事实,仓库移动时不用改配置里的第二个参数。
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(process.argv[2] || join(SELF_DIR, '..'));

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;   // 成功后 6 小时内静默
const FAILURE_TTL_MS = 10 * 60 * 1000;       // 失败后 10 分钟冷却
const GIT_TIMEOUT_MS = 20000;                // 单条 git 命令超时上限
const CHECK_BUDGET_MS = clampBudget(process.env.RELAY_AUTOUPDATE_BUDGET_MS);
const UPDATE_LOCK_WAIT_MS = 2000;            // 并发 launcher 的有界等待;超时即启动当前版本
const UPDATE_LOCK_STALE_MS = Math.max(GIT_TIMEOUT_MS, CHECK_BUDGET_MS) + 5000;
const POST_MERGE_RESERVE_MS = 3000;          // 给 ref 发布后的状态复核留出预算
const TRANSACTION_FILE = 'relay-autoupdate-transaction.json';
const UPDATE_LOCK_FILE = 'relay-autoupdate.lock';
const GIT_BIN = process.env.GIT_BIN
  || (existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git');

// 预算必须是有限数并夹在 [1s, 60s]:NaN 会让 setTimeout 退化成 ~1ms,
// 每条 git 都被立刻杀掉,自动更新静默失效;负数/0 同理。
function clampBudget(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 8000;
  return Math.min(60000, Math.max(1000, Math.floor(n)));
}

// 同步写 stderr 再退出:异步 write + process.exit 可能截断报错,冒烟会偶发读不到。
const fatal = (msg) => {
  try { writeSync(2, msg); } catch { /* ignore */ }
  process.exit(2);
};

if (!REPO || !existsSync(join(REPO, '.git'))) {
  fatal(`[relay-autoupdate] 仓库路径无效: ${REPO}\n`);
}

const GIT_DIR = join(REPO, '.git');

// 实探一次能不能写:accessSync(W_OK) 在只读挂载下会误报「可写」,
// 写一个探针再删才可靠。git-dir 是文件(linked worktree)时必然失败。
const canWrite = (dir) => {
  const probe = join(dir, '.relay-au-probe.tmp');
  try {
    writeFileSync(probe, 'x');
    try { unlinkSync(probe); } catch { /* 忽略 */ }
    return true;
  } catch { return false; }
};

// fallback 状态以仓库路径指纹分目录:多个 worktree/仓库不再共用一份节流。
const ALT_DIR = join(homedir(), '.relay-mcp', 'state', createHash('sha1').update(REPO).digest('hex').slice(0, 12));
let STATE_FILE;
let LOG_FILE;
if (canWrite(GIT_DIR)) {
  STATE_FILE = join(GIT_DIR, 'relay-autoupdate.json');
  LOG_FILE = join(GIT_DIR, 'relay-autoupdate.log');
} else {
  try { mkdirSync(ALT_DIR, { recursive: true }); } catch { /* 忽略 */ }
  STATE_FILE = join(ALT_DIR, 'relay-autoupdate.json');
  LOG_FILE = join(ALT_DIR, 'relay-autoupdate.log');
}

const log = (msg) => {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); }
  catch { /* 日志写失败不影响启动 */ }
};

const readState = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
};

// 原子写:临时文件 + rename。截断写在并发启动/被杀瞬间会留下半个 JSON,
// readState 会把它当 {} 丢掉全部节流状态。
const writeState = (state) => {
  const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
  }
};

// -C 只选择仓库,不能阻止调用方预先注入的 GIT_* 改写仓库、索引、对象库或配置。
// 子进程统一使用净化环境;GIT_BIN 仅由 wrapper 自己读取,不传给 git。
const gitEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
};

const EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let activeChild = null;
let receivedSignal = null;
let signalKiller = null;
let updateLock = null;

// POSIX 下 git/MCP 各自成组;信号和超时都杀整组,避免 hook/孙进程继续 merge。
// Windows 用 taskkill /T;失败时仍退回直接 kill,并保留 stdio 隔离。
// 注意:Node 不回填 child.detached(实测恒为 undefined),不能用它判断是否成组。
// launch() 在 POSIX 上一律 detached 启动,因此这里按平台决定杀组。
const KILLS_PROCESS_GROUP = process.platform !== 'win32';
const killChild = (child, sig) => {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } else if (KILLS_PROCESS_GROUP && child.pid) {
      // 负 pid = 整个进程组:git 拉起的 hook/孙进程也一并终止。
      try { process.kill(-child.pid, sig); }
      catch { child.kill(sig); }
    } else {
      child.kill(sig);
    }
  } catch { /* 已退出 */ }
};

const launch = (command, args, options) => {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
  activeChild = child;
  const release = () => {
    if (activeChild !== child) return;
    activeChild = null;
    if (signalKiller) { clearTimeout(signalKiller); signalKiller = null; }
    if (receivedSignal) process.exit(EXIT_CODE[receivedSignal] ?? 1);
  };
  child.once('error', release);
  child.once('close', release);
  return child;
};

const handleSignal = (sig) => {
  if (receivedSignal) {
    killChild(activeChild, 'SIGKILL');
    return;
  }
  receivedSignal = sig;
  if (!activeChild) {
    process.exit(EXIT_CODE[sig] ?? 1);
  }
  killChild(activeChild, sig);
  signalKiller = setTimeout(() => killChild(activeChild, 'SIGKILL'), 2000);
};

// 跑一条 git 命令。stdout/stderr 分开收集:porcelain/计数只看 stdout,
// stderr 混进来会把空输出误判成「工作区有改动」或把计数变 NaN。
// timeoutMs 必须是有限正数;预算耗尽时直接返回失败,绝不把 0 解释成不限时。
// 总是等 close 结算,不在定时器里提前 resolve。
const git = (args, { timeoutMs = GIT_TIMEOUT_MS, onTimeout = 'kill' } = {}) =>
  new Promise((done) => {
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      done({ ok: false, out: '', err: '时间预算耗尽', timedOut: true });
      return;
    }
    let settled = false;
    let out = '';
    let err = '';
    let timedOut = false;
    const child = launch(GIT_BIN, ['-C', REPO, ...args], {
      env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (ok) => { if (!settled) { settled = true; done({ ok, out, err, timedOut }); } };
    let killer = null;
    let hardKiller = null;
    killer = setTimeout(() => {
      timedOut = true;
      killChild(child, onTimeout === 'term' ? 'SIGTERM' : 'SIGKILL');
      if (onTimeout === 'term') {
        hardKiller = setTimeout(() => killChild(child, 'SIGKILL'), 2000);
      }
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (killer) clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      if (!settled) { settled = true; done({ ok: false, out, err: `${err}${String(e.message || e)}`, timedOut }); }
    });
    child.on('close', (code) => {
      if (killer) clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      finish(code === 0);
    });
  });

// 自检总时限:一进 checkAndUpdate 就启动,路径探测、锁等待和 fetch 都计入。
let deadline = Infinity;
const remainingMs = () => (deadline === Infinity ? GIT_TIMEOUT_MS : Math.max(0, deadline - Date.now()));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 该不该现在做检测:成功后 6h 静默,其它情况 10min 冷却
const shouldCheck = () => {
  const st = readState();
  const last = Number(st.lastAttempt || 0);
  if (!last) return true;
  const ttl = st.lastResult === 'ok' ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  return Date.now() - last >= ttl;
};

const lexists = (file) => {
  try { lstatSync(file); return true; } catch { return false; }
};

const releaseUpdateLock = () => {
  if (!updateLock) return;
  const held = updateLock;
  updateLock = null;
  try {
    const current = readUpdateLock(held.path);
    // inode 相同不代表内容仍属本进程:覆盖原文件会复用 inode。token 与 inode 同时匹配才释放。
    if (current?.valid && current.dev === held.dev && current.ino === held.ino && current.token === held.token) {
      unlinkSync(held.path);
    }
  } catch { /* 已消失 */ }
};
process.once('exit', releaseUpdateLock);

const readUpdateLock = (file) => {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return null;
  }
  try {
    return { ...JSON.parse(readFileSync(file, 'utf8')), valid: true, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return { valid: false, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  }
};

const updateLockHeld = () => {
  if (!updateLock) return false;
  const current = readUpdateLock(updateLock.path);
  return !!current && current.valid && current.token === updateLock.token
    && current.dev === updateLock.dev && current.ino === updateLock.ino;
};

const removeUpdateLock = (file, info) => {
  try {
    const current = lstatSync(file);
    if (current.dev === info.dev && current.ino === info.ino) {
      unlinkSync(file);
      return true;
    }
    return false;
  } catch (e) {
    if (e?.code === 'ENOENT') return true;
    throw e;
  }
};

const transactionPath = (commonDir) => join(commonDir, TRANSACTION_FILE);

const readTransaction = (commonDir) => {
  const file = transactionPath(commonDir);
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) {
    if (e?.code === 'ENOENT') return null;
    return { malformed: true, why: `读取失败: ${e?.message || e}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { malformed: true, why: '顶层不是对象' };
    }
    const beforeSha = typeof parsed.beforeSha === 'string' ? parsed.beforeSha : '';
    const upstreamSha = typeof parsed.upstreamSha === 'string' ? parsed.upstreamSha : '';
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(beforeSha)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(upstreamSha)
      || beforeSha.length !== upstreamSha.length || !token) {
      return { malformed: true, why: '缺 beforeSha/upstreamSha/token 或 SHA 形状非法' };
    }
    return { ...parsed, beforeSha, upstreamSha, token, file };
  } catch (e) {
    return { malformed: true, why: `JSON 损坏: ${e?.message || e}` };
  }
};

const writeTransaction = (commonDir, transaction) => {
  const file = transactionPath(commonDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(transaction, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
};

const clearTransaction = (commonDir, token) => {
  const current = readTransaction(commonDir);
  if (!current) return { ok: true };
  if (current.malformed) return { ok: false, why: `事务文件损坏: ${current.why}` };
  if (current.token !== token) return { ok: false, why: '事务文件 token 已被替换' };
  try {
    unlinkSync(current.file);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `事务文件删除失败: ${e?.message || e}` };
  }
};

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};

const guardMarker = (token) => `relay-autoupdate-txn:${token}\n`;

const removeOwnedGuard = (file, identity, label, token) => {
  let current;
  try { current = lstatSync(file); }
  catch (e) {
    if (e?.code === 'ENOENT') return { ok: true };
    throw e;
  }
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { /* 由下面身份/token 判定 */ }
  const identityMatches = identity && current.dev === identity.dev && current.ino === identity.ino;
  const tokenMatches = token && raw === guardMarker(token);
  if (!identityMatches && !tokenMatches) {
    return { ok: false, why: `${label} 不是该事务创建的 guard,拒绝删除: ${file}` };
  }
  try {
    unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `${label} 清理失败: ${e?.message || e}` };
  }
};

const releaseRecoveredLock = (commonDir, transaction) => {
  const file = join(commonDir, UPDATE_LOCK_FILE);
  const current = readUpdateLock(file);
  if (!current) return { ok: true };
  if (!current.valid || current.token !== transaction.token) {
    return { ok: false, why: '更新锁 token 与事务记录不一致' };
  }
  if (pidAlive(Number(current.pid))) {
    return { ok: false, why: `持锁进程 ${current.pid} 仍在运行` };
  }
  try {
    return removeUpdateLock(file, current)
      ? { ok: true }
      : { ok: false, why: '更新锁在恢复期间被替换' };
  } catch (e) {
    return { ok: false, why: `更新锁恢复失败: ${e?.message || e}` };
  }
};

// 在任何节流判断之前检查持久事务。journal 存在时,只有 HEAD/main/index/worktree
// 全部落在同一个已知端点,才允许清理并继续;任一无法证明即拒绝启动。
const recoverPendingTransaction = async (commonDir) => {
  const transaction = readTransaction(commonDir);
  if (!transaction) return { ok: true, none: true };
  if (transaction.malformed) {
    return { ok: false, why: `事务 journal 无法解析(${transaction.why})` };
  }

  const lockFile = join(commonDir, UPDATE_LOCK_FILE);
  const lock = readUpdateLock(lockFile);
  if (!lock || !lock.valid || lock.token !== transaction.token) {
    return { ok: false, why: '事务 journal 存在但配套更新锁缺失或已被替换' };
  }
  if (pidAlive(Number(lock.pid))) {
    return { ok: false, why: `自更新事务仍由进程 ${lock.pid} 持有` };
  }

  const headLock = join(commonDir, 'HEAD.lock');
  const mainLock = join(commonDir, 'refs', 'heads', 'main.lock');
  if (lexists(headLock)) {
    const removed = removeOwnedGuard(headLock, transaction.guards?.headLock, 'HEAD.lock', transaction.token);
    if (!removed.ok) return removed;
  }
  if (lexists(mainLock)) {
    const removed = removeOwnedGuard(mainLock, transaction.guards?.mainLock, 'main.lock', transaction.token);
    if (!removed.ok) return removed;
  }
  const indexLockProbe = await git(['rev-parse', '--git-path', 'index.lock'], { timeoutMs: remainingMs() });
  if (!indexLockProbe.ok || !indexLockProbe.out.trim()) {
    return { ok: false, why: '无法解析 index.lock 路径' };
  }
  const indexLock = resolvePath(REPO, indexLockProbe.out.trim());
  if (lexists(indexLock)) return { ok: false, why: `事务恢复前仍有 Git 锁: ${indexLock}` };

  const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
  const head = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
  const main = await git(['rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: remainingMs() });
  const status = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: remainingMs() });
  if (!branch.ok || branch.out.trim() !== 'main' || !head.ok || !main.ok || !status.ok) {
    return { ok: false, why: '无法证明事务端点的 HEAD/main/index/worktree 状态' };
  }

  const now = head.out.trim();
  const mainSha = main.out.trim();
  const clean = status.out.trim() === '';
  const atBefore = now === transaction.beforeSha && mainSha === transaction.beforeSha && clean;
  const atUpstream = now === transaction.upstreamSha && mainSha === transaction.upstreamSha && clean;
  if (!atBefore && !atUpstream) {
    return {
      ok: false,
      why: `HEAD=${now.slice(0, 7)} main=${mainSha.slice(0, 7)} ` +
        `${clean ? '工作树干净' : '工作树/索引仍有差异'},不在事务端点`,
    };
  }

  const released = releaseRecoveredLock(commonDir, transaction);
  if (!released.ok) return { ok: false, why: released.why };
  const cleared = clearTransaction(commonDir, transaction.token);
  if (!cleared.ok) return { ok: false, why: cleared.why };

  const state = readState();
  const completedAt = Date.now();
  state.lastAttempt = completedAt;
  state.lastResult = atUpstream ? 'ok' : 'fail';
  state.lastResultAt = completedAt;
  if (atUpstream) state.lastSha = transaction.upstreamSha;
  writeState(state);
  return { ok: true, recovered: atUpstream ? 'completed' : 'rolled-back' };
};

// 仓库级互斥放在 common git dir:主检出与 linked worktree 不会各拿一把锁。
// 活锁的最长生命周期不超过总预算 + 终止宽限;超过该期限的锁可安全恢复。
const acquireUpdateLock = async (commonDir) => {
  const file = join(commonDir, 'relay-autoupdate.lock');
  if (remainingMs() <= 0) return { ok: false, why: '时间预算耗尽' };
  const waitUntil = Math.min(deadline, Date.now() + UPDATE_LOCK_WAIT_MS);
  while (Date.now() < waitUntil) {
    let fd = null;
    let st = null;
    let created = false;
    const token = randomUUID();
    try {
      fd = openSync(file, 'wx', 0o600);
      created = true;
      st = fstatSync(fd);
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }));
      closeSync(fd);
      fd = null;
      updateLock = { path: file, token, dev: st.dev, ino: st.ino };
      return { ok: true };
    } catch (e) {
      if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
      if (created && st) {
        try { removeUpdateLock(file, { dev: st.dev, ino: st.ino }); } catch { /* 交给下一次陈旧恢复 */ }
      }
      if (e?.code !== 'EEXIST') return { ok: false, why: `更新锁创建失败: ${e?.message || e}` };
      const info = readUpdateLock(file);
      if (!info) {
        if (!lexists(file)) continue;
        return { ok: false, why: '更新锁无法读取,跳过更新' };
      }
      const observedAt = info.valid
        ? Math.max(Number(info.acquiredAt) || 0, Number(info.mtimeMs) || 0)
        : Number(info.mtimeMs) || 0;
      if (observedAt && Date.now() - observedAt > UPDATE_LOCK_STALE_MS) {
        try {
          if (removeUpdateLock(file, info)) continue;
        } catch (err) {
          if (err?.code === 'ENOENT') continue;
          return { ok: false, why: `陈旧更新锁恢复失败: ${err?.message || err}` };
        }
      }
      const left = Math.min(waitUntil - Date.now(), remainingMs());
      if (left <= 0) break;
      await sleep(Math.min(100, left));
    }
  }
  if (remainingMs() <= 0) return { ok: false, why: '时间预算耗尽' };
  return { ok: false, busy: true, why: '另一个 launcher 正在更新' };
};

// ref 发布后必须确认仓库处于已知状态才允许继续启动 MCP:
// HEAD ∈ {beforeSha, 捕获的 upstreamSha},真实 index.lock 不存在,工作树与合并前完全一致。
const postMergeCheck = async (beforeSha, upstreamSha, beforeStatus = '') => {
  const lockProbe = await git(['rev-parse', '--git-path', 'index.lock'], { timeoutMs: remainingMs() });
  if (!lockProbe.ok || !lockProbe.out.trim()) {
    return { safe: false, why: `无法解析 index.lock 路径: ${lockProbe.err.trim().slice(0, 120)}` };
  }
  const lockPath = resolvePath(REPO, lockProbe.out.trim());
  if (lexists(lockPath)) return { safe: false, why: `${lockPath} 残留(合并被中断)` };

  const head = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
  if (!head.ok) return { safe: false, why: `rev-parse HEAD 失败: ${head.err.trim().slice(0, 120)}` };
  const now = head.out.trim();
  const originMain = await git(['rev-parse', '--verify', 'origin/main'], { timeoutMs: remainingMs() });
  if (!originMain.ok) return { safe: false, why: `无法确认 origin/main: ${originMain.err.trim().slice(0, 120)}` };
  const upstream = originMain.out.trim();
  if (upstream !== upstreamSha) {
    return { safe: false, why: `origin/main 已从本次捕获的 ${upstreamSha.slice(0, 7)} 移动到 ${upstream.slice(0, 7)}` };
  }
  if (now !== beforeSha && now !== upstreamSha) {
    return { safe: false, why: `HEAD ${now.slice(0, 7)} 既不是更新前 ${beforeSha.slice(0, 7)} 也不是本次捕获的 origin/main` };
  }

  const status = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: remainingMs() });
  if (!status.ok) return { safe: false, why: `合并后 git status 失败: ${status.err.trim().slice(0, 120)}` };
  if (status.out.trim() !== beforeStatus.trim()) {
    return { safe: false, why: '合并后工作树/索引与合并前不一致(可能是混合树)' };
  }
  const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
  if (!branch.ok || branch.out.trim() !== 'main') {
    return { safe: false, why: `合并后当前分支变为 ${branch.out.trim() || '(detached/未知)'},不再持有 main 更新授权` };
  }
  return { safe: true, head: now, originMain: upstream };
};

const trackedWorktreeClean = async () => {
  const staged = await git(['diff', '--cached', '--quiet', 'HEAD', '--'], { timeoutMs: remainingMs() });
  if (!staged.ok) return { ok: false, why: staged.timedOut ? '索引复核超时' : '索引存在已暂存改动' };
  const unstaged = await git(['diff', '--quiet', '--'], { timeoutMs: remainingMs() });
  if (!unstaged.ok) return { ok: false, why: unstaged.timedOut ? '工作树复核超时' : '工作树存在未暂存改动' };
  return { ok: true };
};

const acquireGitGuard = (file, content = '') => {
  let fd;
  let created = false;
  try {
    fd = openSync(file, 'wx', 0o600);
    created = true;
    if (content) writeSync(fd, content);
    const st = fstatSync(fd);
    return { ok: true, fd, file, dev: st.dev, ino: st.ino };
  } catch (e) {
    if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
    if (created) { try { unlinkSync(file); } catch { /* ignore */ } }
    return { ok: false, why: e?.code === 'EEXIST' ? `${file} 已被其他 Git 操作占用` : `${file} 创建失败: ${e?.message || e}` };
  }
};

const releaseGitGuard = (guard) => {
  if (!guard?.ok) return { ok: true };
  try {
    const current = lstatSync(guard.file);
    if (current.dev !== guard.dev || current.ino !== guard.ino) {
      return { ok: false, why: `${guard.file} 在更新期间被替换,未删除他人锁` };
    }
    unlinkSync(guard.file);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e?.code === 'ENOENT' ? '' : `${guard.file} 释放失败: ${e?.message || e}` };
  }
};

// fast-forward 只移动显式 main ref。先写 journal,再以 HEAD.lock 阻断 checkout,
// 最后由 `git update-ref <new> <old>` 做后端无关的原子 CAS(ref 权限/reflog/reftable
// 均由 Git 管理);随后 read-tree 只同步 index/worktree。失败时用同一 CAS 回滚。
const atomicFastForwardMain = async ({ commonDir, beforeSha, upstreamSha, beforeStatus, transactionToken }) => {
  let headGuard = null;
  let transactionWritten = false;
  let refUpdated = false;
  const startedAt = new Date().toISOString();
  const baseTransaction = {
    version: 1,
    token: transactionToken,
    beforeSha,
    upstreamSha,
    startedAt,
    pid: process.pid,
  };
  const releaseHeadGuard = () => {
    if (!headGuard) return;
    if (headGuard.fd != null) {
      try { closeSync(headGuard.fd); } catch { /* ignore */ }
      headGuard.fd = null;
    }
    const released = releaseGitGuard(headGuard);
    if (!released.ok) log(released.why);
    headGuard = null;
  };
  const settleRolledBack = async () => {
    const headNow = await git(['rev-parse', 'HEAD'], { timeoutMs: Math.max(1, remainingMs()) });
    const mainNow = await git(['rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: Math.max(1, remainingMs()) });
    const statusNow = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: Math.max(1, remainingMs()) });
    if (!headNow.ok || headNow.out.trim() !== beforeSha
      || !mainNow.ok || mainNow.out.trim() !== beforeSha
      || !statusNow.ok || statusNow.out.trim() !== beforeStatus.trim()) return false;
    const cleared = clearTransaction(commonDir, transactionToken);
    if (cleared.ok) transactionWritten = false;
    return cleared.ok;
  };
  try {
    if (!updateLockHeld()) return { ok: false, safe: false, why: '更新锁在写入前被替换或丢失' };
    const br = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
    const head = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    const upstream = await git(['rev-parse', '--verify', 'origin/main^{commit}'], { timeoutMs: remainingMs() });
    if (!br.ok || br.out.trim() !== 'main') return { ok: false, safe: false, why: 'HEAD 已不在 main,拒绝发布 main ref' };
    if (!head.ok || head.out.trim() !== beforeSha) return { ok: false, safe: false, why: `HEAD 在写入前变为 ${head.out.trim() || '(未知)'}` };
    if (!upstream.ok || upstream.out.trim() !== upstreamSha) {
      return {
        ok: false,
        safe: false,
        why: `origin/main 在发布前变为 ${upstream.out.trim().slice(0, 7) || '(未知)'},不再等于本次捕获的 ${upstreamSha.slice(0, 7)}`,
      };
    }
    const clean = await trackedWorktreeClean();
    if (!clean.ok) return { ok: false, safe: false, why: clean.why };

    // journal 必须先落盘;在 ref CAS 之前不会创建 guard,因此 journal→guard 之间
    // 的任何崩溃都能在未改动端点上直接恢复。
    writeTransaction(commonDir, { ...baseTransaction, guards: {} });
    transactionWritten = true;

    if (!updateLockHeld()) return { ok: false, safe: false, why: '更新锁在 ref CAS 前被替换' };
    const guardedHead = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    const guardedRef = await git(['rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: remainingMs() });
    const guardedUpstream = await git(['rev-parse', '--verify', 'origin/main^{commit}'], { timeoutMs: remainingMs() });
    const guardedClean = await trackedWorktreeClean();
    if (!guardedHead.ok || guardedHead.out.trim() !== beforeSha
      || !guardedRef.ok || guardedRef.out.trim() !== beforeSha
      || !guardedUpstream.ok || guardedUpstream.out.trim() !== upstreamSha
      || !guardedClean.ok) {
      const cleared = clearTransaction(commonDir, transactionToken);
      if (cleared.ok) transactionWritten = false;
      return {
        ok: false, safe: false, changed: !cleared.ok,
        why: `guard 后复核失败: ${guardedClean.why || 'HEAD/main/origin ref 已变化'}`
          + (cleared.ok ? '' : `;${cleared.why}`),
      };
    }

    const refUpdate = await git([
      'update-ref', '-m', 'relay autoupdate: ff-only main',
      'refs/heads/main', upstreamSha, beforeSha,
    ], { timeoutMs: Math.max(1, remainingMs() - POST_MERGE_RESERVE_MS), onTimeout: 'term' });
    if (!refUpdate.ok) {
      const cleared = clearTransaction(commonDir, transactionToken);
      if (cleared.ok) transactionWritten = false;
      return {
        ok: false, safe: false, changed: !cleared.ok,
        why: `main ref CAS 被拒:${(refUpdate.err || refUpdate.out).trim().slice(0, 160)}`
          + (cleared.ok ? '' : `;${cleared.why}`),
      };
    }
    refUpdated = true;

    // update-ref 会自行锁住 refs/heads/main(含 reftable 后端),并在当前分支是 main
    // 时同时刷新 HEAD。随后再以 HEAD.lock 阻断 checkout,保证下面的工作树转换不会落到
    // 另一个分支;若此时分支已经变化,只回滚显式 main ref,绝不 touch 当前工作树。
    headGuard = acquireGitGuard(join(commonDir, 'HEAD.lock'), guardMarker(transactionToken));
    if (!headGuard.ok) {
      const rollbackRef = updateLockHeld()
        ? await git([
          'update-ref', '-m', 'relay autoupdate: rollback main',
          'refs/heads/main', beforeSha, upstreamSha,
        ], { timeoutMs: Math.max(1, remainingMs()), onTimeout: 'term' })
        : { ok: false };
      if (rollbackRef.ok) await settleRolledBack();
      return {
        ok: false, safe: false, changed: true,
        why: `${headGuard.why};${rollbackRef.ok ? 'main 已回滚' : 'main 回滚未确认,请人工核对'}`,
      };
    }
    writeTransaction(commonDir, {
      ...baseTransaction,
      guards: { headLock: { dev: headGuard.dev, ino: headGuard.ino } },
    });
    const postRefBranch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
    const postRefHead = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    const postRefMain = await git(['rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: remainingMs() });
    const indexAtBefore = await git(['diff', '--cached', '--quiet', beforeSha, '--'], { timeoutMs: remainingMs() });
    const worktreeAtIndex = await git(['diff', '--quiet', '--'], { timeoutMs: remainingMs() });
    if (!postRefBranch.ok || postRefBranch.out.trim() !== 'main'
      || !postRefHead.ok || postRefHead.out.trim() !== upstreamSha
      || !postRefMain.ok || postRefMain.out.trim() !== upstreamSha
      || !indexAtBefore.ok || !worktreeAtIndex.ok) {
      releaseHeadGuard();
      const rollbackRef = updateLockHeld()
        ? await git([
          'update-ref', '-m', 'relay autoupdate: rollback main',
          'refs/heads/main', beforeSha, upstreamSha,
        ], { timeoutMs: Math.max(1, remainingMs()), onTimeout: 'term' })
        : { ok: false };
      if (rollbackRef.ok) await settleRolledBack();
      return {
        ok: false, safe: false, changed: true,
        why: `main ref 发布后分支/index 复核失败;${rollbackRef.ok ? 'main 已回滚,工作树未被转换' : 'main 回滚未确认'}`,
      };
    }
    // Git 原生两树转换在目标路径存在本地修改时会拒绝;--reset 会静默覆盖并发编辑。
    const sync = await git(['read-tree', '-m', '-u', beforeSha, upstreamSha], {
      timeoutMs: Math.max(1, remainingMs() - POST_MERGE_RESERVE_MS), onTimeout: 'term',
    });
    if (!sync.ok) {
      let rollback = 'main ref 未能回滚';
      let rollbackSafe = false;
      if (updateLockHeld()) {
        // update-ref 回滚 checked-out branch 时也要拿 HEAD.lock;先释放我们自己的 guard,
        // 再用 CAS 回滚 main。工作树尚未由本次操作转换,外部 checkout 只会改变 HEAD,
        // 不会让下面的显式 refs/heads/main 回滚改错引用。
        releaseHeadGuard();
        const rollbackRef = await git([
          'update-ref', '-m', 'relay autoupdate: rollback main',
          'refs/heads/main', beforeSha, upstreamSha,
        ], { timeoutMs: Math.max(1, remainingMs()), onTimeout: 'term' });
        if (rollbackRef.ok) {
          // 不用 --reset 抢救:若转换期间出现外部写入,强推会再次覆盖用户内容。
          // index 仍停在 before 时无需改写;部分推进时两树回退转换也会在冲突处拒绝。
          const indexAtBefore = await git(['diff', '--cached', '--quiet', beforeSha, '--'], { timeoutMs: Math.max(1, remainingMs()) });
          const restored = indexAtBefore.ok
            ? indexAtBefore
            : await git(['read-tree', '-m', '-u', upstreamSha, beforeSha], { timeoutMs: Math.max(1, remainingMs()) });
          rollback = restored.ok ? 'main 已回滚,工作树转换拒绝覆盖现场' : 'main 已回滚,但工作树/index 仍需人工核对';
          const finalHead = await git(['rev-parse', 'HEAD'], { timeoutMs: Math.max(1, remainingMs()) });
          const finalStatus = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: Math.max(1, remainingMs()) });
          rollbackSafe = finalHead.ok && finalHead.out.trim() === beforeSha
            && finalStatus.ok && finalStatus.out.trim() === beforeStatus.trim();
        }
      }
      if (rollbackSafe && transactionWritten) {
        const cleared = clearTransaction(commonDir, transactionToken);
        if (!cleared.ok) rollback += `;${cleared.why}`;
        else transactionWritten = false;
      }
      return {
        ok: false, safe: false, changed: refUpdated,
        why: `工作树同步失败:${(sync.err || sync.out).trim().slice(0, 120)};${rollback}`,
      };
    }
    const verdict = await postMergeCheck(beforeSha, upstreamSha, beforeStatus);
    if (!verdict.safe || verdict.head !== upstreamSha) {
      return { ok: false, safe: false, why: verdict.why || '更新后 HEAD 未到达 upstream', changed: true };
    }
    if (!updateLockHeld()) {
      return { ok: false, safe: false, why: '更新锁在写操作期间被替换;已停止启动 MCP,请人工核对更新状态', changed: true };
    }
    const cleared = clearTransaction(commonDir, transactionToken);
    if (!cleared.ok) {
      return { ok: false, safe: false, why: `事务已提交但 journal 清理失败:${cleared.why}`, changed: true };
    }
    transactionWritten = false;
    return { ok: true, safe: true, head: upstreamSha, changed: true };
  } catch (e) {
    return { ok: false, safe: false, why: e?.message || String(e), changed: refUpdated };
  } finally {
    releaseHeadGuard();
    if (transactionWritten) {
      log(`自更新事务未闭合(before=${beforeSha.slice(0, 7)} upstream=${upstreamSha.slice(0, 7)})`);
    }
  }
};

const checkAndUpdate = async () => {
  const attemptStartedAt = Date.now();
  deadline = attemptStartedAt + CHECK_BUDGET_MS;
  const finish = (result, extra) => {
    // 另一个 launcher 可能在本进程检查期间完成。较新的完成状态优先,
    // 避免慢路径的 fail/skip 覆盖已经写入的 success 冷却。
    const latest = readState();
    const latestAttemptAt = Number(latest.lastAttempt) || 0;
    const latestResultAt = Number(latest.lastResultAt) || 0;
    if (latestResultAt > attemptStartedAt
      || (latest.lastResult === 'checking' && latestAttemptAt > attemptStartedAt)) return;
    const completedAt = Date.now();
    latest.lastAttempt = completedAt;
    latest.lastResult = result;
    latest.lastResultAt = completedAt;
    if (extra) Object.assign(latest, extra);
    writeState(latest);
  };
  const recheckBranch = async (stage) => {
    const current = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
    if (!current.ok || current.out.trim() !== 'main') {
      log(`${stage}分支复核失败:${current.out.trim() || (current.err || 'detached/未知').trim().slice(0, 120)},跳过更新`);
      finish('fail');
      return false;
    }
    return true;
  };

  // —— 安全前提 1:必须站在 main 上。ff-only 会移动「当前分支」的引用,
  //    在任务分支 / release 分支 / detached HEAD(bisect、复核旧 tag)上绝不执行。
  const br = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
  if (!br.ok) {
    // symbolic-ref 非零有两种含义:detached HEAD(正常跳过)与「无法判定」(超时/权限/git 异常)。
    // 后者必须记 fail —— 否则预算耗尽会被伪装成 skip-head 并写入冷却状态,更新通道静默失效。
    if (br.timedOut || (br.err && br.err.trim())) {
      log(`无法判定当前分支,跳过更新: ${(br.err || '超时').trim().slice(0, 120)}`);
      finish('fail');
      return;
    }
    log('detached HEAD,跳过更新');
    finish('skip-head');
    return;
  }
  const branch = br.out.trim();
  if (branch !== 'main') { log(`当前分支是 ${branch}(非 main),跳过更新`); finish('skip-branch'); return; }

  // —— 安全前提 2:不能是 linked worktree。任一探测/规范化失败都 fail-closed;
  //    git < 2.31 不支持 --path-format=absolute 时只能跳过更新,不能越过守卫 merge。
  const gd = await git(['rev-parse', '--absolute-git-dir'], { timeoutMs: remainingMs() });
  const cd = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: remainingMs() });
  if (!gd.ok || !cd.ok || !gd.out.trim() || !cd.out.trim()) {
    log(`无法判定 worktree 类型,跳过更新: ${(gd.err || cd.err).trim().slice(0, 120)}`);
    finish('fail');
    return;
  }
  let gitDir;
  let commonDir;
  try {
    gitDir = realpathSync(gd.out.trim());
    commonDir = realpathSync(cd.out.trim());
  } catch (e) {
    log(`git 目录路径解析失败,跳过更新: ${e?.message || e}`);
    finish('fail');
    return;
  }
  if (gitDir !== commonDir) {
    log('当前是 linked worktree,跳过更新(任务分支由人工整合)');
    finish('skip-worktree');
    return;
  }

  const lock = await acquireUpdateLock(commonDir);
  if (!lock.ok) {
    log(`${lock.why},启动当前版本`);
    // 等锁失败不代表本进程做过检查;让持锁者独占写入本次结果。
    if (!lock.busy) finish('fail');
    return;
  }

  try {
    const state = readState();
    state.lastAttempt = attemptStartedAt;
    state.lastResult = 'checking';
    writeState(state);
    if (remainingMs() <= 0) { log('时间预算耗尽,本次不更新'); finish('fail'); return; }
    if (!updateLockHeld()) {
      log('更新锁在 fetch 前已被替换或丢失,跳过更新');
      finish('fail');
      return;
    }
    if (!(await recheckBranch('持锁后'))) return;

    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: remainingMs() });
    if (!dirty.ok) { log(`git status 失败: ${dirty.err.trim().slice(0, 120)}`); finish('fail'); return; }
    if (dirty.out.trim()) { log('工作区有已跟踪文件的改动,跳过更新'); finish('skip-dirty'); return; }
    const beforeStatus = dirty.out.trim();

    const before = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    if (!before.ok) { log(`rev-parse HEAD 失败: ${before.err.trim().slice(0, 120)}`); finish('fail'); return; }
    const beforeSha = before.out.trim();

    const fetch = await git(['fetch', '--quiet', 'origin', 'main'], { timeoutMs: remainingMs() });
    if (!fetch.ok) {
      const why = fetch.timedOut ? 'fetch 超时' : `fetch 失败: ${fetch.err.trim().slice(0, 120)}`;
      log(`${why}(不影响启动)`);
      finish('fail');
      return;
    }

    // fetch 后立即把 origin/main 捕获为不可变 SHA。后续比较、发布和终检都引用这个
    // SHA;另一次并发 fetch 即使移动了 ref,也只能让本次更新 fail-closed,不能换锚。
    const upstream = await git(['rev-parse', '--verify', 'origin/main^{commit}'], { timeoutMs: remainingMs() });
    if (!upstream.ok || !upstream.out.trim()) {
      log(`无法确认上游提交: ${upstream.err.trim().slice(0, 120)}`);
      finish('fail');
      return;
    }
    const upstreamSha = upstream.out.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(upstreamSha)
      || upstreamSha.length !== beforeSha.length) {
      log(`上游提交 SHA 形状非法: ${upstreamSha.slice(0, 80)}`);
      finish('fail');
      return;
    }

    // 「无法判定」一律按失败处理。一次 left-right 同时算 ahead/behind;
    // ahead 必须先判,不能把 local-only main 误写成「已是最新」并进入 6h 成功冷却。
    const counts = await git(['rev-list', '--left-right', '--count', `${beforeSha}...${upstreamSha}`], { timeoutMs: remainingMs() });
    if (!counts.ok) { log(`无法比较本地/上游提交数(跳过更新): ${counts.err.trim().slice(0, 120)}`); finish('fail'); return; }
    const [aheadRaw, behindRaw] = counts.out.trim().split(/\s+/);
    const aheadCount = Number(aheadRaw);
    const behindCount = Number(behindRaw);
    if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
      log('本地/上游提交数解析失败,跳过更新');
      finish('fail');
      return;
    }
    if (aheadCount > 0) { log(`本地有 ${aheadCount} 个独有提交,不自动合并`); finish('skip-diverged'); return; }
    const headAfterCounts = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    if (!headAfterCounts.ok || headAfterCounts.out.trim() !== beforeSha) {
      log(`HEAD 在比较期间改变(捕获 ${beforeSha.slice(0, 7)},当前 ${headAfterCounts.out.trim().slice(0, 7) || '(未知)'}),按 fail-closed 跳过更新`);
      finish('fail');
      return;
    }
    const observedUpstream = await git(['rev-parse', '--verify', 'origin/main^{commit}'], { timeoutMs: remainingMs() });
    if (!observedUpstream.ok || observedUpstream.out.trim() !== upstreamSha) {
      const observed = observedUpstream.ok ? observedUpstream.out.trim().slice(0, 7) : '(未知)';
      log(`origin/main 在比较期间发生变化(捕获 ${upstreamSha.slice(0, 7)},当前 ${observed}),按 fail-closed 跳过更新`);
      finish('fail');
      return;
    }
    if (behindCount === 0) { log('已是最新'); finish('ok', { lastSha: beforeSha }); return; }
    const ancestry = await git(['merge-base', '--is-ancestor', beforeSha, upstreamSha], { timeoutMs: remainingMs() });
    if (!ancestry.ok) {
      log(`上游不是 ${beforeSha.slice(0, 7)} 的后代,拒绝发布非快进更新`);
      finish('skip-diverged');
      return;
    }

    // main ref 是有条件的唯一写目标:SIGTERM 留宽限再 SIGKILL,并等 close 结算。
    if (remainingMs() <= POST_MERGE_RESERVE_MS) { log('时间预算不足,本次不更新'); finish('fail'); return; }
    const lockHeld = updateLockHeld();
    const headBeforeMerge = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    if (!lockHeld) {
      log('更新锁在合并前已被替换或丢失,跳过更新');
      finish('fail');
      return;
    }
    if (!headBeforeMerge.ok || headBeforeMerge.out.trim() !== beforeSha) {
      log(`HEAD 在合并前发生变化:${headBeforeMerge.out.trim() || headBeforeMerge.err.trim() || '未知'},跳过更新`);
      finish('fail');
      return;
    }
    if (!(await recheckBranch('写入前'))) return;
    const fastForward = await atomicFastForwardMain({
      commonDir, beforeSha, upstreamSha, beforeStatus, transactionToken: lock.ok ? updateLock?.token : '',
    });
    if (!fastForward.ok) {
      if (!fastForward.changed) {
        log(`main CAS 更新被拒(仓库未改动): ${fastForward.why}`);
        finish('fail');
        return;
      }
      finish('fail');
      log(`main 更新后状态异常,拒绝启动 MCP: ${fastForward.why}`);
      fatal(`[relay-autoupdate] 更新后仓库状态需要人工核对(${fastForward.why})。\n` +
        `[relay-autoupdate] 人工恢复: cd ${REPO} && git status && git log --oneline -3\n` +
        `[relay-autoupdate] 本次不启动 MCP(harness 侧会显示启动失败,属预期)。\n`);
      return;
    }
    log(`已更新 ${beforeSha.slice(0, 7)} → ${fastForward.head.slice(0, 7)}`);
    finish('ok', { lastSha: fastForward.head });
  } finally {
    releaseUpdateLock();
  }
};

// 拉起真正的 MCP server
const entry = join(REPO, 'src', 'index.mjs');
if (!existsSync(entry)) {
  fatal(`[relay-autoupdate] 找不到 MCP 入口: ${entry}\n`);
}

const main = async () => {
  // 在第一条 git 之前接管信号:更新期间被终止也必须等 git 进程组结算。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => handleSignal(sig));
  }

  // 事务检查必须先于节流:进程若在 main ref 发布后、工作树同步前被 SIGKILL,
  // 状态文件里的 checking 不应获得 10 分钟“直接启动”豁免。
  deadline = Date.now() + CHECK_BUDGET_MS;
  let recoveryDir = '';
  try {
    if (lstatSync(GIT_DIR).isDirectory()) recoveryDir = realpathSync(GIT_DIR);
  } catch { /* linked-worktree .git 文件或路径异常,下面走 git */ }
  if (!recoveryDir) {
    const recoveryCommon = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: remainingMs() });
    if (recoveryCommon.ok && recoveryCommon.out.trim()) recoveryDir = recoveryCommon.out.trim();
    else log(`无法定位 git common dir,跳过事务恢复检查: ${(recoveryCommon.err || '未知错误').trim().slice(0, 120)}`);
  }
  if (recoveryDir) {
    try {
      const commonDir = realpathSync(recoveryDir);
      const recovered = await recoverPendingTransaction(commonDir);
      if (!recovered.ok) {
        log(`检测到未完成自更新事务,拒绝启动: ${recovered.why}`);
        fatal(`[relay-autoupdate] 检测到未完成自更新事务,拒绝从可能混合的 HEAD/index/worktree 启动(${recovered.why})。\n` +
          `[relay-autoupdate] 人工核对: cd ${REPO} && git status && git log --oneline -3\n` +
          `[relay-autoupdate] 确认工作树与当前 HEAD 一致后删除 .git/${TRANSACTION_FILE},再重试。\n`);
        return;
      }
      if (recovered.recovered) log(`已恢复未完成自更新事务: ${recovered.recovered}`);
    } catch (e) {
      log(`无法检查自更新事务: ${e?.message || e}`);
    }
  }

  // 自检在前:保证本次新拉起的进程只跑一个版本(已在运行的旧进程见头注释边界说明)
  try {
    if (shouldCheck()) {
      await checkAndUpdate();
    } else {
      log('节流期内,跳过检测');
    }
  } catch (e) {
    log(`自检异常(不影响启动): ${e?.message || e}`);
  }
  if (receivedSignal) return;

  // 合并可能替换了入口文件:启动前复核存在性 + 语法可加载。
  // 坏上游提交不自动回滚(不自动改写用户仓库),给出明确的人工恢复命令。
  if (!existsSync(entry)) {
    fatal(`[relay-autoupdate] 更新后找不到 MCP 入口: ${entry}\n` +
      `[relay-autoupdate] 人工恢复: cd ${REPO} && git log --oneline -3 && git reset --hard <上一个已知好提交>\n`);
  }
  const syntax = launch(process.execPath, ['--check', entry], { stdio: 'ignore' });
  const syntaxOk = await new Promise((done) => {
    syntax.on('close', (code) => done(code === 0));
    syntax.on('error', () => done(false));
  });
  if (receivedSignal) return;
  if (!syntaxOk) {
    fatal(`[relay-autoupdate] 更新后的 MCP 入口无法通过语法检查: ${entry}\n` +
      `[relay-autoupdate] 人工恢复: cd ${REPO} && git reset --hard <上一个已知好提交>\n`);
  }

  const child = launch(process.execPath, [entry], { stdio: ['inherit', 'inherit', 'inherit'] });
  child.on('close', (code, signal) => {
    if (receivedSignal) process.exit(EXIT_CODE[receivedSignal] ?? 1);
    if (signal) { process.exit(1); }
    else { process.exit(code ?? 0); }
  });

  child.on('error', (e) => {
    process.stderr.write(`[relay-autoupdate] 启动 MCP 失败: ${e?.message || e}\n`);
    process.exit(1);
  });
};

main();
