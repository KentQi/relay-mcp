// relay-mcp — 通用自动拉起 worker(T051)。
// 核心不绑定任何 harness:manifest.rescue.autoLaunch 只声明 argv 数组与 cwd/timeout/output 上限。
// worker 与 MCP server 解耦:即使调用方会话退出,子进程仍按配置运行并最终落 dispatch.json。
//
// 生命周期铁律:
//   - dispatch.json 只由 worker 写一次 running、一次终态;父进程**不再回写**(避免终态被 running 占位覆盖);
//   - 状态发布走 临时文件 + rename,读者永远看到完整 JSON,损坏态按 busy fail-closed;
//   - 超时终止整个进程组(POSIX detached + kill(-pid)),孙进程无法用继承的管道把 worker 拖成永久 running;
//   - 有界收尾:超时后 SIGTERM → SIGKILL → 最终强制 close 结算,不无限等待。
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, fdatasyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';

const [configPath] = process.argv.slice(2);
if (!configPath) process.exit(2);
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const outPath = path.join(cfg.cardDir, 'dispatch.log');
const statePath = path.join(cfg.cardDir, 'dispatch.json');

const atomicWriteState = () => {
  const tmp = path.join(cfg.cardDir, `.dispatch-write-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`, null, 'utf8');
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { renameSync(tmp, statePath); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
};

const state = {
  status: 'running',
  pid: null,
  cwd: cfg.cwd,
  startedAt: cfg.startedAt || new Date().toISOString(),
  finishedAt: '',
  exitCode: null,
  signal: null,
  error: '',
  outputBytes: 0,
};
atomicWriteState();

const fd = openSync(outPath, 'a');
let outputBytes = 0;
const writeOutput = (buf) => {
  if (outputBytes >= cfg.maxOutputBytes) return;
  const room = cfg.maxOutputBytes - outputBytes;
  const chunk = buf.length > room ? buf.subarray(0, room) : buf;
  try { writeSync(fd, chunk); } catch { /* worker 退出后忽略 */ }
  outputBytes += chunk.length;
  state.outputBytes = outputBytes;
};

let child;
try {
  child = spawn(cfg.command[0], cfg.command.slice(1), {
    cwd: cfg.cwd,
    env: { ...process.env, RELAY_RESCUE_ID: cfg.rescueId, RELAY_RESCUE_TASK: cfg.task || '', RELAY_RESCUE_MODEL: cfg.model },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // POSIX:独立进程组,超时时能整组终止(含孙进程)
    detached: process.platform !== 'win32',
  });
} catch (e) {
  state.status = 'failed';
  state.error = `spawn failed: ${e?.message || String(e)}`;
  state.finishedAt = new Date().toISOString();
  atomicWriteState();
  closeSync(fd);
  process.exit(1);
}
state.pid = child.pid || null;
atomicWriteState();
if (child.stdout) child.stdout.on('data', writeOutput);
if (child.stderr) child.stderr.on('data', writeOutput);

const killTree = (signal) => {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
};

let timedOut = false;
let settled = false;
let timeoutTimer = null;
let sigkillTimer = null;
let settleTimer = null;
const finish = (status, code, signal, error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeoutTimer);
  clearTimeout(sigkillTimer);
  clearTimeout(settleTimer);
  state.finishedAt = new Date().toISOString();
  state.exitCode = code ?? null;
  state.signal = signal || null;
  state.status = status;
  if (error) state.error = error;
  atomicWriteState();
  try { closeSync(fd); } catch { /* ignore */ }
  try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ignore */ }
};
timeoutTimer = setTimeout(() => {
  timedOut = true;
  killTree('SIGTERM');
  sigkillTimer = setTimeout(() => killTree('SIGKILL'), 2000);
}, cfg.timeoutMs);
// 兜底:即使 close 事件永远不来(孙进程持有管道),也在宽限期后结算,避免永久 running。
settleTimer = setTimeout(() => {
  if (!settled) finish('timed_out', null, null, `自动拉起超时(${cfg.timeoutMs}ms)后仍有进程存活,已强制结算`);
}, cfg.timeoutMs + 8000);
settleTimer.unref?.();

child.on('error', (e) => {
  state.error = `child error: ${e?.message || String(e)}`;
});
child.on('close', (code, signal) => {
  if (timedOut) {
    finish('timed_out', code, signal, `自动拉起超时(${cfg.timeoutMs}ms),进程组已终止`);
  } else if (code === 0) {
    finish('completed', code, signal, '');
  } else {
    finish('failed', code, signal, state.error || `子进程退出码 ${code}${signal ? `,signal=${signal}` : ''}`);
  }
});
