#!/usr/bin/env node
// relay-mcp-autoupdate.mjs — 启动时自检更新的 MCP 启动器
//
// 本文件由 relay-mcp 仓库版本控制(scripts/):它自己会随 ff-only 更新一起升级,
// 因此 harness 侧不需要单独维护这份启动器。
//
// 用法: node scripts/relay-mcp-autoupdate.mjs [relay-mcp 仓库路径]
//   仓库路径可省略——缺省时按本文件自身位置推导(scripts/ 的上一级就是仓库根),
//   显式传参仍生效(向后兼容 2026-11-27 之前 ~/.relay-mcp/ 旧用法)。//
// 每次 harness 启动 relay MCP 时,先做一次「节流后的」更新自检,再拉起 MCP:
//   1) 节流:成功后 6 小时内不再检测;失败/异常则 10 分钟冷却
//   2) 只在「工作区干净(仅已跟踪文件)+ 无本地独有提交」时才 ff-only 快进
//   3) 自检有总时限(默认 8 秒),超时直接放弃本次更新,仓库一个字节都不动
//   4) 失败不致命:任何出错只记日志,用当前版本照常启动
//   5) stdio 纯净:git 输出只进日志文件,stdout 只有 MCP 的 JSON-RPC
//
// 为什么自检放在 MCP 启动「之前」:
//   relay-mcp 内部有延迟 import(src/contract.mjs 动态 import engines/,
//   src/engines/verify.mjs 动态 import ./worktree.mjs)。
//   如果边跑边合并,同一个进程里会同时存在新旧两个版本的文件,工具调用可能报错。
//   先更新、再启动,能保证一个进程只跑一个版本。
//
// 状态与日志优先放在仓库 .git/ 下(不弄脏工作树);.git/ 不可写时退回 ~/.relay-mcp/state/。

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
  unlinkSync,
} from 'node:fs';
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
const CHECK_BUDGET_MS = Number(process.env.RELAY_AUTOUPDATE_BUDGET_MS || 8000); // 整个自检总时限
const GIT_BIN = process.env.GIT_BIN
  || (existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git');

if (!REPO || !existsSync(join(REPO, '.git'))) {
  process.stderr.write(`[relay-autoupdate] 仓库路径无效: ${REPO}\n`);
  process.exit(2);
}

const GIT_DIR = join(REPO, '.git');

// 实探一次能不能写:accessSync(W_OK) 在只读挂载下会误报「可写」,
// 写一个探针再删才可靠。探针在 .git/ 内,不弄脏工作树。
const canWrite = (dir) => {
  const probe = join(dir, '.relay-au-probe.tmp');
  try {
    writeFileSync(probe, 'x');
    try { unlinkSync(probe); } catch { /* 忽略 */ }
    return true;
  } catch { return false; }
};

const ALT_DIR = join(homedir(), '.relay-mcp', 'state');
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

const writeState = (state) => {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* 忽略 */ }
};

// 跑一条 git 命令;超时/出错都不抛,返回 { ok, out }
const git = (args, timeoutMs) =>
  new Promise((done) => {
    let settled = false;
    let out = '';
    const child = spawn(GIT_BIN, ['-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
        done({ ok: false, out: 'timeout' });
      }
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); done({ ok: false, out: String(e.message || e) }); }
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); done({ ok: code === 0, out }); }
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

  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], remainingMs());
  if (!dirty.ok) { log(`git status 失败: ${dirty.out.trim()}`); finish('fail'); return; }
  if (dirty.out.trim()) { log('工作区有已跟踪文件的改动,跳过更新'); finish('skip-dirty'); return; }

  const before = await git(['rev-parse', 'HEAD'], remainingMs());
  const beforeSha = before.ok ? before.out.trim() : '';

  const fetch = await git(['fetch', '--quiet', 'origin', 'main'], remainingMs());
  if (!fetch.ok) {
    const why = fetch.out.trim() === 'timeout' ? 'fetch 超时' : `fetch 失败: ${fetch.out.trim()}`;
    log(`${why}(不影响启动)`);
    finish('fail');
    return;
  }

  const behind = await git(['rev-list', '--count', 'HEAD..origin/main'], remainingMs());
  const behindCount = behind.ok ? Number(behind.out.trim() || '0') : 0;
  if (behindCount === 0) { log('已是最新'); finish('ok', { lastSha: beforeSha }); return; }

  const ahead = await git(['rev-list', '--count', 'origin/main..HEAD'], remainingMs());
  const aheadCount = ahead.ok ? Number(ahead.out.trim() || '0') : 0;
  if (aheadCount > 0) { log(`本地有 ${aheadCount} 个独有提交,不自动合并`); finish('skip-diverged'); return; }

  // 时间预算不够就不合并,避免半途被杀留下锁文件
  if (remainingMs() < 2000) { log('时间预算不足,本次不更新'); finish('fail'); return; }

  const merge = await git(['merge', '--ff-only', 'origin/main'], remainingMs());
  if (!merge.ok) { log(`ff-only 合并失败(仓库未被改动): ${merge.out.trim()}`); finish('fail'); return; }

  const after = await git(['rev-parse', 'HEAD'], remainingMs());
  const afterSha = after.ok ? after.out.trim() : '';
  log(`已更新 ${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)}`);
  finish('ok', { lastSha: afterSha });
};

// 拉起真正的 MCP server
const entry = join(REPO, 'src', 'index.mjs');
if (!existsSync(entry)) {
  process.stderr.write(`[relay-autoupdate] 找不到 MCP 入口: ${entry}\n`);
  process.exit(2);
}

const main = async () => {
  // 自检在前:保证一个进程只跑一个版本
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

  const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'inherit', 'inherit'] });

  // 把 wrapper 收到的信号转发给子进程,保证 harness 能正常关闭 MCP
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* 忽略 */ } });
  }

  child.on('exit', (code, signal) => {
    if (signal) { process.kill(process.pid, signal); }
    else { process.exit(code ?? 0); }
  });

  child.on('error', (e) => {
    process.stderr.write(`[relay-autoupdate] 启动 MCP 失败: ${e?.message || e}\n`);
    process.exit(1);
  });
};

main();
