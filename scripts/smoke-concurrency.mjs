#!/usr/bin/env node
// T002 冒烟:认领/出场的协议写入必须 fail-closed 地防「丢更新」。
// 背景:claim/session_end 已用仓库写锁 + fencing(T010),但锁只约束守规矩的 relay 进程;
// 人类手改、旧版本进程、TTL 接管窗口都能绕过锁 —— 所以补内容 CAS(写入前重读比对哈希)。
// 1) CAS 冲突:读完 TASKS 后被外部写入者修改 → claim / session_end 拒绝写入、不覆盖对方改动
// 2) 并发认领:两模型同时 claim 不同任务 → 两条认领都在 TASKS(仓库写锁串行化)
// 3) 幂等:同模型复领同一任务不产生重复行
// 4) 失败路径无残留:认领锁/临时文件不残留
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
const tmp = mkdtempSync(path.join(tmpdir(), 'relay-conc-'));
const cli = (tool, args = {}, env = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8', env: { ...process.env, ...env } });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const tasksPath = path.join(tmp, 'TASKS.md');
const logPath = path.join(tmp, 'LOG.md');
const runClaimAsync = (task, model) => new Promise((resolve) => {
  const p = spawn('node', [CLI, 'relay_claim', '--root', tmp, '--json', JSON.stringify({ task, model })], { encoding: 'utf8' });
  let o = '';
  p.stdout.on('data', (d) => { o += d; });
  p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, o }));
});

try {
  const init = cli('relay_init', { name: '并发回归夹具' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 200));
  const tasksBefore = readFileSync(tasksPath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');

  console.log('\n== CAS:claim 读完 TASKS 后被外部修改 → 拒绝写入 ==');
  const externalClaim = tasksBefore + '\n<!-- external writer during claim -->\n';
  const claimCas = cli('relay_claim', { task: 'T003', model: 'cas-a' }, { RELAY_TEST_EXTERNAL_TASKS_WRITE: externalClaim });
  ok(claimCas.status === 1, 'CAS 冲突时 claim 失败(fail-closed)', out(claimCas).slice(0, 400));
  ok(/CAS|被其他写入者修改/.test(out(claimCas)), '失败信息说明内容冲突', out(claimCas).slice(0, 400));
  ok(readFileSync(tasksPath, 'utf8') === externalClaim, '外部改动未被覆盖(TASKS 保持外部内容)');
  ok(!existsSync(path.join(tmp, '.relay', 'claims', 'T003.lock')), '失败后未残留认领锁');
  writeFileSync(tasksPath, tasksBefore);

  console.log('\n== CAS:session_end 读完 TASKS/LOG 后被外部修改 → 整体拒绝,不半写 ==');
  const externalEnd = tasksBefore + '\n<!-- external writer during session_end -->\n';
  const endCas = cli('relay_session_end', { model: 'cas-b', summary: '并发回归:外部写入冲突' }, { RELAY_TEST_EXTERNAL_TASKS_WRITE: externalEnd });
  ok(endCas.status === 1, 'CAS 冲突时 session_end 失败(fail-closed)', out(endCas).slice(0, 400));
  ok(readFileSync(tasksPath, 'utf8') === externalEnd, '外部改动未被覆盖(session_end)');
  ok(readFileSync(logPath, 'utf8') === logBefore, '冲突时 LOG 未被写入(无半写)');
  writeFileSync(tasksPath, tasksBefore);

  console.log('\n== 并发认领:两模型同时 claim 不同任务,两条都不丢 ==');
  const [c1, c2] = await Promise.all([runClaimAsync('T003', 'conc-a'), runClaimAsync('T004', 'conc-b')]);
  ok(c1.code === 0 && c2.code === 0, '两个认领都成功(仓库写锁串行化)', `${c1.o.slice(-200)} | ${c2.o.slice(-200)}`);
  const tasksAfter = readFileSync(tasksPath, 'utf8');
  ok(/\[~\] T003/.test(tasksAfter) && /\[~\] T004/.test(tasksAfter), 'TASKS 同时含两条认领(无丢更新)', tasksAfter.slice(0, 400));
  ok(existsSync(path.join(tmp, '.relay', 'claims', 'T003.lock')) && existsSync(path.join(tmp, '.relay', 'claims', 'T004.lock')), '两把认领锁都在');

  console.log('\n== 幂等与残留 ==');
  const again = cli('relay_claim', { task: 'T003', model: 'conc-a' });
  const tasksAgain = readFileSync(tasksPath, 'utf8');
  ok(again.status === 0, '同模型复领成功(幂等)', out(again).slice(0, 300));
  ok((tasksAgain.match(/^- \[~\] T003\b/gm) || []).length === 1, '复领不产生重复任务行(模板注释行不计)');
  const residues = readdirSync(tmp).filter((n) => /(\.relay-tmp|\.tmp$)/.test(n));
  ok(residues.length === 0, '无临时文件残留', residues.join(','));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
