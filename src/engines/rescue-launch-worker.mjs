// relay-mcp — 通用自动拉起 worker(T051)。
// 核心不绑定任何 harness:manifest.rescue.autoLaunch 只声明 argv 数组与 cwd/timeout/output 上限。
// worker 与 MCP server 解耦:即使调用方会话退出,子进程仍按配置运行并最终落 dispatch.json。
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const [configPath] = process.argv.slice(2);
if (!configPath) process.exit(2);
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const outPath = path.join(cfg.cardDir, 'dispatch.log');
const statePath = path.join(cfg.cardDir, 'dispatch.json');
const state = {
  status: 'running',
  pid: null,
  command: cfg.command,
  cwd: cfg.cwd,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  exitCode: null,
  signal: null,
  error: '',
  outputBytes: 0,
};
const writeState = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
writeState();

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
  });
} catch (e) {
  state.status = 'failed';
  state.error = `spawn failed: ${e?.message || String(e)}`;
  state.finishedAt = new Date().toISOString();
  writeState();
  closeSync(fd);
  process.exit(1);
}
state.pid = child.pid || null;
writeState();
if (child.stdout) child.stdout.on('data', writeOutput);
if (child.stderr) child.stderr.on('data', writeOutput);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { child.kill('SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 2000).unref();
}, cfg.timeoutMs);

child.on('error', (e) => {
  state.error = `child error: ${e?.message || String(e)}`;
});
child.on('close', (code, signal) => {
  clearTimeout(timer);
  state.finishedAt = new Date().toISOString();
  state.exitCode = code;
  state.signal = signal || null;
  if (timedOut) {
    state.status = 'timed_out';
    state.error = `自动拉起超时(${cfg.timeoutMs}ms),子进程已终止`;
  } else if (code === 0) {
    state.status = 'completed';
  } else {
    state.status = 'failed';
    if (!state.error) state.error = `子进程退出码 ${code}${signal ? `,signal=${signal}` : ''}`;
  }
  writeState();
  closeSync(fd);
  // 删除临时配置(只含 argv,可能含 prompt;不长期留在盘上)
  try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ignore */ }
});
