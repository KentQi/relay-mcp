#!/usr/bin/env node
// T061 审计探针:done_tasks[] 的三条路径
// A) 只传 done_tasks(不传 done_task) → 静默无操作?
// B) done_tasks 含 TASKS 里不存在的任务号 → LOG 写假完成条目,R9 能否拦住?
// C) 正常单任务出场(对照)
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const cli = (root, tool, args = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8', timeout: 180000 });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

const fresh = (tag) => {
  const d = mkdtempSync(path.join(tmpdir(), `t061-${tag}-`));
  const r = cli(d, 'relay_init', { name: `probe ${tag}` });
  if (r.status !== 0) throw new Error(`init 失败: ${out(r).slice(0, 400)}`);
  const tp = path.join(d, 'TASKS.md');
  const t0 = readFileSync(tp, 'utf8');
  writeFileSync(tp, t0.replace(/^## 待办$/m, ['## 待办',
    '- [ ] T901 探针甲', '  验收: npm test',
    '- [ ] T902 探针乙', '  验收: npm test',
    '- [ ] T903 探针丙', '  验收: npm test',
  ].join('\n')));
  return d;
};
const lockExists = (root, id) => existsSync(path.join(root, '.relay', 'claims', `${id}.lock`));

// ── 探针 A:只传 done_tasks,省略 done_task ──
{
  const root = fresh('A');
  cli(root, 'relay_claim', { task: 'T903', model: 'probe-model', worktree: false });
  console.log('=== 探针 A: done_tasks:["T903"],无 done_task ===');
  console.log('  认领锁存在(前):', lockExists(root, 'T903'));
  const r = cli(root, 'relay_session_end', { model: 'probe-model', summary: '只传 done_tasks', done_tasks: ['T903'] });
  const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
  const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
  console.log('  isError(退出码非0):', r.status !== 0);
  console.log('  TASKS 里有 [x] T903 :', /\[x\] T903/.test(tasks));
  console.log('  LOG 里有 task=T903 完成:', /task=T903 完成/.test(log));
  console.log('  LOG 实际条目:', JSON.stringify(log.split('\n').filter(l => l.startsWith('## ')).slice(0, 3)));
  console.log('  认领锁仍存在:', lockExists(root, 'T903'));
  console.log('  输出片段:', out(r).slice(0, 500).replace(/\n/g, ' | '));
  rmSync(root, { recursive: true, force: true });
}

// ── 探针 B:done_tasks 含不存在的任务号 ──
{
  const root = fresh('B');
  cli(root, 'relay_claim', { task: 'T901', model: 'probe-model', worktree: false });
  console.log('\n=== 探针 B: done_task:"T901" + done_tasks:["T999"](T999 不在 TASKS) ===');
  const r = cli(root, 'relay_session_end', { model: 'probe-model', summary: '主任务 + 幽灵任务', done_task: 'T901', done_tasks: ['T999'] });
  const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
  const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
  console.log('  isError:', r.status !== 0);
  console.log('  TASKS 有 [x] T901:', /\[x\] T901/.test(tasks));
  console.log('  TASKS 有 T999 行:', /T999/.test(tasks));
  console.log('  LOG 里有 task=T999 完成:', /task=T999 完成/.test(log));
  console.log('  LOG 条目:', JSON.stringify(log.split('\n').filter(l => l.startsWith('## ')).slice(0, 3)));
  const v = cli(root, 'relay_verify', { full: true });
  console.log('  verify 输出(含 R9/D8):');
  for (const line of out(v).split('\n')) if (/R9|D8|R7|ERROR/.test(line)) console.log('    ', line.trim());
  console.log('  输出片段:', out(r).slice(0, 700).replace(/\n/g, ' | '));
  rmSync(root, { recursive: true, force: true });
}

// ── 探针 C:正常单任务(对照) ──
{
  const root = fresh('C');
  cli(root, 'relay_claim', { task: 'T902', model: 'probe-model', worktree: false });
  console.log('\n=== 探针 C(对照): done_task:"T902" ===');
  const r = cli(root, 'relay_session_end', { model: 'probe-model', summary: '正常出场' });
  const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
  console.log('  isError:', r.status !== 0);
  console.log('  LOG 条目:', JSON.stringify(log.split('\n').filter(l => l.startsWith('## ')).slice(0, 2)));
  rmSync(root, { recursive: true, force: true });
}
