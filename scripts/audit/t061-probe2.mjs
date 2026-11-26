#!/usr/bin/env node
// T061 审计探针 2:happy path 与对照
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
  const d = mkdtempSync(path.join(tmpdir(), `t061b-${tag}-`));
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

// C(修正):正常单任务出场
{
  const root = fresh('C');
  const c = cli(root, 'relay_claim', { task: 'T902', model: 'probe-model', worktree: false });
  console.log('=== 探针 C(修正): done_task:"T902" ===');
  console.log('  claim 退出码:', c.status);
  const r = cli(root, 'relay_session_end', { model: 'probe-model', summary: '正常出场', done_task: 'T902' });
  const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
  const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
  console.log('  isError:', r.status !== 0);
  console.log('  TASKS 有 [x] T902:', /\[x\] T902/.test(tasks));
  console.log('  LOG 有 task=T902 完成:', /task=T902 完成/.test(log));
  console.log('  认领锁已释放:', !lockExists(root, 'T902'));
  console.log('  LOG 条目:', JSON.stringify(log.split('\n').filter(l => l.startsWith('## ')).slice(0, 2)));
  rmSync(root, { recursive: true, force: true });
}

// D:happy path —— done_task + done_tasks
{
  const root = fresh('D');
  cli(root, 'relay_claim', { task: 'T901', model: 'probe-model', worktree: false });
  cli(root, 'relay_claim', { task: 'T902', model: 'probe-model', worktree: false });
  console.log('\n=== 探针 D: done_task:"T901" + done_tasks:["T902"] ===');
  const r = cli(root, 'relay_session_end', { model: 'probe-model', summary: '一次交付两个', done_task: 'T901', done_tasks: ['T902'] });
  const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
  const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
  console.log('  isError:', r.status !== 0);
  console.log('  TASKS [x] T901:', /\[x\] T901/.test(tasks), ' | [x] T902:', /\[x\] T902/.test(tasks));
  console.log('  LOG 有 T901 完成:', /task=T901 完成/.test(log), ' | T902 完成:', /task=T902 完成/.test(log));
  console.log('  锁释放 T901:', !lockExists(root, 'T901'), ' | T902:', !lockExists(root, 'T902'));
  console.log('  LOG 条目:', JSON.stringify(log.split('\n').filter(l => l.startsWith('## ')).slice(0, 3)));
  // 提交消息考古路径:git log --grep "T902 完成" 能否找到?
  const g = spawnSync('git', ['-C', root, 'log', '--oneline', '--grep', 'T902 完成'], { encoding: 'utf8' });
  console.log('  git log --grep "T902 完成" 命中:', JSON.stringify(g.stdout.trim()) || '(空)');
  const g2 = spawnSync('git', ['-C', root, 'log', '--oneline', '--grep', 'T901 完成'], { encoding: 'utf8' });
  console.log('  git log --grep "T901 完成" 命中:', JSON.stringify(g2.stdout.trim()) || '(空)');
  const v = cli(root, 'relay_verify', { full: true });
  for (const line of out(v).split('\n')) if (/\| (R9|D8|R7|R10) \|/.test(line)) console.log('   ', line.trim());
  rmSync(root, { recursive: true, force: true });
}
