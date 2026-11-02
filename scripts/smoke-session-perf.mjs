#!/usr/bin/env node
// T026 冒烟:session_start 的读放大必须收敛(manifest / LOG / TASKS 各 1 次)。
// 背景(PR #8 审计 P1-6):session_start 曾读 manifest 6 次、LOG 2 次、TASKS 3 次;
// relay_verify 早就是 1/1/1(T022),会话生命周期在 T026 才跟上。
// 已接入 npm test(T026 完成后由红灯转绿,作为回归防线)。
// git 子进程数说明:session_start 还要跑自动清理(git worktree list)与未合并分支探测
// (git branch --merged/--no-merged),这些不是读放大,单独设上界;本脚本只锁定读次数。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};
const tmp = mkdtempSync(path.join(tmpdir(), 'relay-sessperf-'));
const trace = path.join(tmpdir(), `relay-sessperf-trace-${process.pid}.json`);
const cli = (tool, args = {}, tr = '') => {
  const env = { ...process.env };
  if (tr) env.RELAY_TRACE_FILE = tr; else delete env.RELAY_TRACE_FILE;
  return spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8', env });
};
try {
  const init = cli('relay_init', { name: 'session perf 红灯' });
  ok(init.status === 0, 'relay_init 成功', `${init.stdout || ''}${init.stderr || ''}`.slice(0, 200));
  const ss = cli('relay_session_start', {}, trace);
  ok(ss.status === 0, 'relay_session_start 成功');
  const t = JSON.parse(readFileSync(trace, 'utf8'));
  ok(t.sync === 0, `session_start 同步 spawn ${t.sync} = 0`);
  ok(t.reads['manifest.json'] === 1, `session_start manifest 读 ${t.reads['manifest.json']} 次 = 1(读放大收敛)`);
  ok(t.reads['LOG.md'] === 1 && t.reads['TASKS.md'] === 1, `session_start LOG/TASKS 各读 ${t.reads['LOG.md']}/${t.reads['TASKS.md']} 次 = 1/1`);
  ok(t.git <= 8, `session_start git 子进程 ${t.git} ≤ 8(自动清理 + 未合并分支探测,非读放大)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try { rmSync(trace, { force: true }); } catch { /* ignore */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
