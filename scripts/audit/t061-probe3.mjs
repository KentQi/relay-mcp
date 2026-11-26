#!/usr/bin/env node
// T061 审计探针 3:额外任务条目成为「最新完成条目」时,R10 能否定位完成提交
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const cli = (root, tool, args = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8', timeout: 180000 });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (root, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), 't061c-'));
const r0 = cli(root, 'relay_init', { name: 'probe r10' });
if (r0.status !== 0) throw new Error(out(r0).slice(0, 300));
const tp = path.join(root, 'TASKS.md');
const t0 = readFileSync(tp, 'utf8');
writeFileSync(tp, t0.replace(/^## 待办$/m, ['## 待办',
  '- [ ] T901 主任务', '  验收: npm test',
  '- [ ] T902 额外任务', '  验收: npm test',
].join('\n')));
// 制造一次真实代码改动,让事实行的文件数非零(放在 src/ 下,避免 R2 顶层白名单越界)
writeFileSync(path.join(root, 'src', 'probe.js'), 'export const probe = 1;\n');
spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
spawnSync('git', ['-C', root, '-c', 'user.name=probe', '-c', 'user.email=p@e', 'commit', '-m', 'feat: 改点东西'], { encoding: 'utf8' });

cli(root, 'relay_claim', { task: 'T901', model: 'm1', worktree: false });
cli(root, 'relay_claim', { task: 'T902', model: 'm1', worktree: false });

console.log('=== 会话 1:done_task=T901(单任务)===');
const s1 = cli(root, 'relay_session_end', { model: 'm1', summary: '先完成主任务', done_task: 'T901' });
console.log('  isError:', s1.status !== 0);
console.log('  HEAD:', git(root, 'log', '-1', '--pretty=%s'));

console.log('\n=== 会话 2:done_task=T901(幂等) + done_tasks=[T902] ===');
const s2 = cli(root, 'relay_session_end', { model: 'm1', summary: '再补交付额外任务', done_task: 'T901', done_tasks: ['T902'] });
console.log('  isError:', s2.status !== 0);
const log2 = readFileSync(path.join(root, 'LOG.md'), 'utf8');
console.log('  LOG 条目顺序:', JSON.stringify(log2.split('\n').filter(l => l.startsWith('## ')).slice(0, 4)));
console.log('  HEAD:', git(root, 'log', '-1', '--pretty=%s'));
console.log('  grep "T902 完成" 命中:', JSON.stringify(git(root, 'log', '--oneline', '--grep', 'T902 完成')));

console.log('\n=== 会话 3:维护出场(无 done_task)===');
writeFileSync(path.join(root, 'src', 'probe.js'), 'export const probe = 2;\n');
const s3 = cli(root, 'relay_session_end', { model: 'm2', summary: '一次普通维护', maintenance: true });
console.log('  isError:', s3.status !== 0);
console.log('  HEAD:', git(root, 'log', '-1', '--pretty=%s'));

console.log('\n=== 会话 3 之后的 relay_verify ===');
const v = cli(root, 'relay_verify', { full: true });
for (const line of out(v).split('\n')) if (/\|\s*(R9|R10|R7|D8)\s*\|/.test(line) || /汇总/.test(line)) console.log('   ', line.trim());
console.log('\n=== 会话 3 之后的 relay_doctor ===');
const d = cli(root, 'relay_doctor', {});
for (const line of out(d).split('\n')) if (/D8|WARN|ERROR/.test(line)) console.log('   ', line.trim());
rmSync(root, { recursive: true, force: true });
