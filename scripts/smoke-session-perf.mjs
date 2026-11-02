#!/usr/bin/env node
// T026 冒烟(红灯协议):session_start 的 manifest 读放大必须收敛到 1。
// 现状(PR #8 审计 P1-6 实测):session_start 读 manifest 6 次、git 7 次;
// relay_verify 已收敛到 1/1/1(T022),会话生命周期尚未跟上。
// 本脚本刻意**不**进 npm test:它现在必须是红的,等 T026 实现后转绿。
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
  ok(t.git <= 4, `session_start git 子进程 ${t.git} ≤ 4`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try { rmSync(trace, { force: true }); } catch { /* ignore */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
