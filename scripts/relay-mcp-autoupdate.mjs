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
//   3) 合并只允许 --ff-only;超时先 SIGTERM 留宽限再 SIGKILL,并等 close 结算;
//      合并后复核 HEAD 与入口健康,任何异常都不会从可疑的树启动 MCP(postMergeCheck)。
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
//
// 状态与日志优先放在仓库 .git/ 下(不弄脏工作树);.git/ 不可写或不是目录
// (linked worktree 的 .git 是文件)时退回 ~/.relay-mcp/state/<仓库指纹>/,
// 以仓库路径为 key,避免多个 worktree/仓库共用一份节流状态互相干扰。

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
  unlinkSync, renameSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// 仓库根:显式 argv[2] 优先;缺省按本文件位置推导(scripts/../)。
// 这样 harness 配置只依赖「脚本在仓库内」这一事实,仓库移动时不用改配置里的第二个参数。
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(process.argv[2] || join(SELF_DIR, '..'));

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;   // 成功后 6 小时内静默
const FAILURE_TTL_MS = 10 * 60 * 1000;       // 失败后 10 分钟冷却
const GIT_TIMEOUT_MS = 20000;                // 单条只读 git 命令超时上限
const CHECK_BUDGET_MS = clampBudget(process.env.RELAY_AUTOUPDATE_BUDGET_MS);
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

// 跑一条 git 命令。stdout/stderr 分开收集:porcelain/计数只看 stdout,
// stderr 混进来会把空输出误判成「工作区有改动」或把计数变 NaN。
// opts.timeoutMs <= 0 表示不限时;onTimeout:
//   'kill'(默认,只读命令:直接 SIGKILL) | 'term'(写命令:SIGTERM 留宽限再 SIGKILL)。
// 总是等 close 结算,不在定时器里提前 resolve。
const git = (args, { timeoutMs = GIT_TIMEOUT_MS, onTimeout = 'kill' } = {}) =>
  new Promise((done) => {
    let settled = false;
    let out = '';
    let err = '';
    let timedOut = false;
    const child = spawn(GIT_BIN, ['-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (ok) => { if (!settled) { settled = true; done({ ok, out, err, timedOut }); } };
    let killer = null;
    let hardKiller = null;
    if (timeoutMs > 0) {
      killer = setTimeout(() => {
        timedOut = true;
        if (onTimeout === 'term') {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          hardKiller = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, 2000);
        } else {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, timeoutMs);
    }
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

// 自检总时限
let deadline = Infinity;
const remainingMs = () => (deadline === Infinity ? GIT_TIMEOUT_MS : Math.max(0, deadline - Date.now()));

// 该不该现在做检测:成功后 6h 静默,其它情况 10min 冷却
const shouldCheck = () => {
  const st = readState();
  const last = Number(st.lastAttempt || 0);
  if (!last) return true;
  const ttl = st.lastResult === 'ok' ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  return Date.now() - last >= ttl;
};

// 合并失败后必须确认仓库处于已知状态才允许继续启动 MCP:
// HEAD 必须仍是 beforeSha(合并未开始)或 origin/main(合并已完成),
// 且没有残留 .git/index.lock。返回 { safe, why }。
const postMergeCheck = async (beforeSha) => {
  const lockProbe = join(REPO, '.git', 'index.lock');
  if (existsSync(lockProbe)) return { safe: false, why: '.git/index.lock 残留(合并被中断)' };
  const head = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
  if (!head.ok) return { safe: false, why: `rev-parse HEAD 失败: ${head.err.trim().slice(0, 120)}` };
  const now = head.out.trim();
  if (now === beforeSha) return { safe: true };                                 // 合并未开始即失败
  const originMain = await git(['rev-parse', '--verify', 'origin/main'], { timeoutMs: remainingMs() });
  if (originMain.ok && originMain.out.trim() === now) return { safe: true };    // 合并已完成
  return { safe: false, why: `HEAD ${now.slice(0, 7)} 既不是更新前 ${beforeSha.slice(0, 7)} 也不是 origin/main` };
};

const checkAndUpdate = async () => {
  const state = readState();
  state.lastAttempt = Date.now();
  state.lastResult = 'checking';
  writeState(state);

  const finish = (result, extra) => {
    state.lastResult = result;
    if (extra) Object.assign(state, extra);
    writeState(state);
  };

  // —— 安全前提 1:必须站在 main 上。ff-only 会移动「当前分支」的引用,
  //    在任务分支 / release 分支 / detached HEAD(bisect、复核旧 tag)上绝不执行。
  const br = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: remainingMs() });
  if (!br.ok) { log('detached HEAD,跳过更新'); finish('skip-head'); return; }
  const branch = br.out.trim();
  if (branch !== 'main') { log(`当前分支是 ${branch}(非 main),跳过更新`); finish('skip-branch'); return; }

  // —— 安全前提 2:不能是 linked worktree(它的 main 在主检出登记;
  //    这里 ff-only 会把任务分支指到 origin/main,而任务分支验收通过 ≠ 已合并)。
  const gd = await git(['rev-parse', '--absolute-git-dir'], { timeoutMs: remainingMs() });
  const cd = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: remainingMs() });
  if (gd.ok && cd.ok && resolvePath(gd.out.trim()) !== resolvePath(cd.out.trim())) {
    log('当前是 linked worktree,跳过更新(任务分支由人工整合)');
    finish('skip-worktree');
    return;
  }

  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], { timeoutMs: remainingMs() });
  if (!dirty.ok) { log(`git status 失败: ${dirty.err.trim().slice(0, 120)}`); finish('fail'); return; }
  if (dirty.out.trim()) { log('工作区有已跟踪文件的改动,跳过更新'); finish('skip-dirty'); return; }

  const before = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
  if (!before.ok) { log(`rev-parse HEAD 失败: ${before.err.trim().slice(0, 120)}`); finish('fail'); return; }
  const beforeSha = before.out.trim();

  deadline = Date.now() + CHECK_BUDGET_MS;

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

  // merge 是唯一的写命令:SIGTERM 留宽限再 SIGKILL,并等 close 结算;
  // 结算后用 postMergeCheck 确认仓库处于已知状态,可疑的树绝不启动 MCP。
  if (remainingMs() < 2000) { log('时间预算不足,本次不更新'); finish('fail'); return; }
  const merge = await git(['merge', '--ff-only', 'origin/main'], { timeoutMs: remainingMs(), onTimeout: 'term' });
  if (!merge.ok) {
    const verdict = await postMergeCheck(beforeSha);
    if (verdict.safe) {
      log(`ff-only 合并失败(仓库仍在已知状态): ${(merge.err || merge.out).trim().slice(0, 120)}`);
      finish('fail');
      return;
    }
    // 仓库处于中间态:拒绝从这棵树启动 MCP,给出人工恢复指令(不自动 reset 用户仓库)。
    log(`合并后仓库状态异常,拒绝启动 MCP: ${verdict.why}`);
    fatal(`[relay-autoupdate] 更新中断且仓库状态未知(${verdict.why})。\n` +
      `[relay-autoupdate] 人工恢复: cd ${REPO} && git status && git merge --ff-only origin/main\n` +
      `[relay-autoupdate] 本次不启动 MCP(harness 侧会显示启动失败,属预期)。\n`);
    return;
  }

  const after = await git(['rev-parse', 'HEAD'], { timeoutMs: remainingMs() });
  const afterSha = after.ok ? after.out.trim() : '';
  log(`已更新 ${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)}`);
  finish('ok', { lastSha: afterSha });
};

// 拉起真正的 MCP server
const entry = join(REPO, 'src', 'index.mjs');
if (!existsSync(entry)) {
  fatal(`[relay-autoupdate] 找不到 MCP 入口: ${entry}\n`);
}

const main = async () => {
  // 自检在前:保证本次新拉起的进程只跑一个版本(已在运行的旧进程见头注释边界说明)
  try {
    if (shouldCheck()) {
      deadline = Date.now() + CHECK_BUDGET_MS;
      await checkAndUpdate();
    } else {
      log('节流期内,跳过检测');
    }
  } catch (e) {
    log(`自检异常(不影响启动): ${e?.message || e}`);
  }

  // 合并可能替换了入口文件:启动前复核存在性 + 语法可加载。
  // 坏上游提交不自动回滚(不自动改写用户仓库),给出明确的人工恢复命令。
  if (!existsSync(entry)) {
    fatal(`[relay-autoupdate] 更新后找不到 MCP 入口: ${entry}\n` +
      `[relay-autoupdate] 人工恢复: cd ${REPO} && git log --oneline -3 && git reset --hard <上一个已知好提交>\n`);
  }
  const syntax = spawn(process.execPath, ['--check', entry], { stdio: 'ignore' });
  const syntaxOk = await new Promise((done) => {
    syntax.on('close', (code) => done(code === 0));
    syntax.on('error', () => done(false));
  });
  if (!syntaxOk) {
    fatal(`[relay-autoupdate] 更新后的 MCP 入口无法通过语法检查: ${entry}\n` +
      `[relay-autoupdate] 人工恢复: cd ${REPO} && git reset --hard <上一个已知好提交>\n`);
  }

  const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'inherit', 'inherit'] });

  // 把 wrapper 收到的信号转发给 MCP 子进程,然后 wrapper 自己退出。
  // 不用 process.kill(process.pid, sig) 重投递:它会再次进入本 handler,wrapper 永不退出。
  const EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { child.kill(sig); } catch { /* 已退出 */ }
      process.exit(EXIT_CODE[sig] ?? 1);
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) { process.exit(1); }
    else { process.exit(code ?? 0); }
  });

  child.on('error', (e) => {
    process.stderr.write(`[relay-autoupdate] 启动 MCP 失败: ${e?.message || e}\n`);
    process.exit(1);
  });
};

main();
