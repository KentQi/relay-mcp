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
//      合并只允许 --ff-only;超时/信号整组终止 git 进程并等 close 结算;
//      合并后复核 HEAD、真实 index.lock 路径与工作树,异常时绝不从可疑的树启动 MCP。
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
//   · SIGKILL 无法被 wrapper 转发;锁保留 acquiredAt/mtime,后续启动可按陈旧期限恢复。

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
const POST_MERGE_RESERVE_MS = 3000;          // 给合并后的状态复核留出预算
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
    const st = lstatSync(held.path);
    // 只删自己仍持有的那个 inode;锁已被替换时不能误删新持有者的锁。
    if (st.dev === held.dev && st.ino === held.ino) unlinkSync(held.path);
  } catch { /* 已消失 */ }
};
process.once('exit', releaseUpdateLock);

const readUpdateLock = (file) => {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const st = lstatSync(file);
    return { ...raw, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch { return null; }
};

// 仓库级互斥放在 common git dir:主检出与 linked worktree 不会各拿一把锁。
// 活锁的最长生命周期不超过总预算 + 终止宽限;超过该期限的锁可安全恢复。
const acquireUpdateLock = async (commonDir) => {
  const file = join(commonDir, 'relay-autoupdate.lock');
  const waitUntil = Math.min(deadline, Date.now() + UPDATE_LOCK_WAIT_MS);
  while (Date.now() < waitUntil) {
    let fd = null;
    let st = null;
    const token = randomUUID();
    try {
      fd = openSync(file, 'wx', 0o600);
      st = fstatSync(fd);
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }));
      closeSync(fd);
      fd = null;
      updateLock = { path: file, token, dev: st.dev, ino: st.ino };
      return { ok: true };
    } catch (e) {
      if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
      if (e?.code !== 'EEXIST') return { ok: false, why: `更新锁创建失败: ${e?.message || e}` };
      const info = readUpdateLock(file);
      if (!info) {
        if (!lexists(file)) continue;
        return { ok: false, why: '更新锁无法读取,跳过更新' };
      }
      const observedAt = Math.max(Number(info.acquiredAt) || 0, Number(info.mtimeMs) || 0);
      if (observedAt && Date.now() - observedAt > UPDATE_LOCK_STALE_MS) {
        try {
          const current = lstatSync(file);
          if (current.dev === info.dev && current.ino === info.ino) {
            unlinkSync(file);
            continue;
          }
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
  return { ok: false, busy: true, why: '另一个 launcher 正在更新' };
};

// 合并失败后必须确认仓库处于已知状态才允许继续启动 MCP:
// HEAD ∈ {beforeSha, origin/main},真实 index.lock 不存在,工作树与合并前完全一致。
const postMergeCheck = async (beforeSha, beforeStatus = '') => {
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
  if (now !== beforeSha && now !== upstream) {
    return { safe: false, why: `HEAD ${now.slice(0, 7)} 既不是更新前 ${beforeSha.slice(0, 7)} 也不是 origin/main` };
  }

  const status = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: remainingMs() });
  if (!status.ok) return { safe: false, why: `合并后 git status 失败: ${status.err.trim().slice(0, 120)}` };
  if (status.out.trim() !== beforeStatus.trim()) {
    return { safe: false, why: '合并后工作树/索引与合并前不一致(可能是混合树)' };
  }
  return { safe: true, head: now, originMain: upstream };
};

const checkAndUpdate = async () => {
  deadline = Date.now() + CHECK_BUDGET_MS;
  const finish = (result, extra) => {
    // 等待更新锁期间另一个 launcher 可能已写完状态,结束时基于最新状态合并字段。
    const latest = readState();
    // 一次启动至多尝试更新一次:别人的成功节流不能被本次 skip/fail 覆盖成冷却。
    latest.lastAttempt = Number(latest.lastAttempt) || Date.now();
    latest.lastResult = result;
    if (extra) Object.assign(latest, extra);
    writeState(latest);
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
    finish(lock.busy ? 'skip-locked' : 'fail');
    return;
  }

  try {
    const state = readState();
    state.lastAttempt = Date.now();
    state.lastResult = 'checking';
    writeState(state);
    if (remainingMs() <= 0) { log('时间预算耗尽,本次不更新'); finish('fail'); return; }

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

    // 「无法判定」一律按失败处理,绝不折算成 0 冒充「已是最新」:
    // single-branch 克隆 / 预算耗尽时 rev-list 会失败,把它当 0 会写入 6 小时成功静默。
    const behind = await git(['rev-list', '--count', 'HEAD..origin/main'], { timeoutMs: remainingMs() });
    if (!behind.ok) { log(`无法比较落后数(跳过更新): ${behind.err.trim().slice(0, 120)}`); finish('fail'); return; }
    const behindCount = Number(behind.out.trim() || '0');
    if (!Number.isFinite(behindCount)) { log('落后数解析失败,跳过更新'); finish('fail'); return; }
    if (behindCount === 0) { log('已是最新'); finish('ok', { lastSha: beforeSha }); return; }

    const ahead = await git(['rev-list', '--count', 'origin/main..HEAD'], { timeoutMs: remainingMs() });
    if (!ahead.ok) { log(`无法比较独有提交数(跳过更新): ${ahead.err.trim().slice(0, 120)}`); finish('fail'); return; }
    const aheadCount = Number(ahead.out.trim() || '0');
    if (!Number.isFinite(aheadCount)) { log('独有提交数解析失败,跳过更新'); finish('fail'); return; }
    if (aheadCount > 0) { log(`本地有 ${aheadCount} 个独有提交,不自动合并`); finish('skip-diverged'); return; }

    const upstream = await git(['rev-parse', '--verify', 'origin/main^{commit}'], { timeoutMs: remainingMs() });
    if (!upstream.ok) { log(`无法确认上游提交: ${upstream.err.trim().slice(0, 120)}`); finish('fail'); return; }
    const upstreamSha = upstream.out.trim();

    // merge 是唯一的写命令:SIGTERM 留宽限再 SIGKILL,并等 close 结算;
    // 预留状态复核预算,结算后可疑的树绝不启动 MCP。
    if (remainingMs() <= POST_MERGE_RESERVE_MS) { log('时间预算不足,本次不更新'); finish('fail'); return; }
    const merge = await git(['merge', '--ff-only', 'origin/main'], {
      timeoutMs: remainingMs() - POST_MERGE_RESERVE_MS, onTimeout: 'term',
    });
    if (!merge.ok) {
      const verdict = await postMergeCheck(beforeSha, beforeStatus);
      if (verdict.safe) {
        log(`ff-only 合并失败(仓库仍在已知状态): ${(merge.err || merge.out).trim().slice(0, 120)}`);
        finish('fail');
        return;
      }
      // 仓库处于中间态:拒绝从这棵树启动 MCP,给出人工恢复指令(不自动 reset 用户仓库)。
      finish('fail');
      log(`合并后仓库状态异常,拒绝启动 MCP: ${verdict.why}`);
      fatal(`[relay-autoupdate] 更新中断且仓库状态未知(${verdict.why})。\n` +
        `[relay-autoupdate] 人工恢复: cd ${REPO} && git status && git merge --ff-only origin/main\n` +
        `[relay-autoupdate] 本次不启动 MCP(harness 侧会显示启动失败,属预期)。\n`);
      return;
    }

    const after = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
    const afterSha = after.ok ? after.out.trim() : '';
    if (!after.ok || afterSha !== upstreamSha) {
      finish('fail');
      log(`合并后 HEAD 复核失败: ${after.err.trim().slice(0, 120)}`);
      const verdict = await postMergeCheck(beforeSha, beforeStatus);
      if (!verdict.safe || verdict.head !== upstreamSha) {
        fatal(`[relay-autoupdate] 更新后无法确认 HEAD == origin/main(${verdict.why})。\n` +
          `[relay-autoupdate] 人工恢复: cd ${REPO} && git status && git log --oneline -3\n` +
          `[relay-autoupdate] 本次不启动 MCP。\n`);
      }
      return;
    }

    const verdict = await postMergeCheck(beforeSha, beforeStatus);
    if (!verdict.safe || verdict.head !== upstreamSha || verdict.originMain !== upstreamSha) {
      finish('fail');
      log(`合并后状态复核失败,拒绝启动 MCP: ${verdict.why}`);
      fatal(`[relay-autoupdate] 更新后仓库状态未知(${verdict.why})。\n` +
        `[relay-autoupdate] 人工恢复: cd ${REPO} && git status && git log --oneline -3\n` +
        `[relay-autoupdate] 本次不启动 MCP。\n`);
      return;
    }
    log(`已更新 ${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)}`);
    finish('ok', { lastSha: afterSha });
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
