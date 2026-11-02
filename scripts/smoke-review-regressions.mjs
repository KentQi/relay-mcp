#!/usr/bin/env node
// 评审回归(P0-1/P0-2/P0-4):managed 密钥泄漏、事实行口径、worktree 内检索/诊断。
// 这些用例是审计报告点名缺失的回归防线(P2-21):旧 smoke 只走单根,恰好绕开两条 P0 路径。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const SECRET = 'AKIAABCDEFGHIJKLMNOP';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const cliAt = (cwd, tool, args = {}) => spawnSync('node', [CLI, tool, '--root', cwd, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const field = (text, name) => {
  const m = text.match(new RegExp(`- ${name}: (.+)`));
  return m ? m[1].trim() : '';
};

const tmpA = mkdtempSync(path.join(tmpdir(), 'relay-rev-managed-'));
const tmpB = mkdtempSync(path.join(tmpdir(), 'relay-rev-single-'));
const tmpC = mkdtempSync(path.join(tmpdir(), 'relay-rev-sentinel-'));

try {
  // ================= A. managed:密钥必须在任何提交之前被拦 =================
  console.log('== A. managed 密钥闸前置(P0-1) ==');
  const initA = cliAt(tmpA, 'relay_init', { name: '评审回归-managed' });
  ok(initA.status === 0, 'init tmpA', out(initA).slice(0, 200));
  const claimA = cliAt(tmpA, 'relay_claim', { task: 'T003', model: 'rev-managed' });
  const claimText = out(claimA);
  const execA = field(claimText, 'executionRoot');
  ok(claimA.status === 0 && execA && execA !== tmpA, 'claim 返回独立 executionRoot', claimText.slice(0, 300));

  mkdirSync(path.join(execA, 'src'), { recursive: true });
  writeFileSync(path.join(execA, 'src', 'feature.mjs'), 'export const ok = true;\n');
  const leakExit = cliAt(execA, 'relay_session_end', {
    model: 'rev-managed',
    summary: `实现功能,顺便记录 ${SECRET}`,
    done_task: 'T003',
  });
  ok(leakExit.status === 1, '含密钥的 managed 出场被拒(isError)', out(leakExit).slice(0, 300));
  const allMessages = git(execA, 'log', '--all', '--format=%s').stdout || '';
  ok(!allMessages.includes(SECRET), '密钥未进入任何 git 提交消息(P0-1 回归)');
  const tasksAfter = readFileSync(path.join(tmpA, 'TASKS.md'), 'utf8');
  ok(!/\[x\] T003/.test(tasksAfter), 'TASKS 未被标记完成');

  // ================= B. managed:多提交分支的事实行口径 =================
  console.log('\n== B. managed 多提交对账(P0-2) ==');
  writeFileSync(path.join(execA, 'src', 'one.mjs'), 'export const one = 1;\n');
  git(execA, 'add', '-A');
  git(execA, '-c', 'user.name=rev', '-c', 'user.email=rev@local', 'commit', '-m', 'wip: one');
  writeFileSync(path.join(execA, 'src', 'two.mjs'), 'export const two = 2;\n');
  git(execA, 'add', '-A');
  git(execA, '-c', 'user.name=rev', '-c', 'user.email=rev@local', 'commit', '-m', 'wip: two');
  const okExit = cliAt(execA, 'relay_session_end', {
    model: 'rev-managed',
    summary: '实现功能并分两次提交',
    done_task: 'T003',
  });
  ok(okExit.status === 0, '干净 managed 出场成功(多提交)', out(okExit).slice(0, 400));
  const logA = readFileSync(path.join(tmpA, 'LOG.md'), 'utf8');
  const factLine = (logA.match(/^- 事实\(v2\): .*$/m) || [''])[0];
  ok(/^\s*- 事实\(v2\): .*\|\| .*$/m.test(factLine), '事实行是 v2 两段式(机检段 || 叙述段)', factLine);
  ok(/base=[0-9a-f]{7,40}/.test(factLine), '事实行记录 base sha', factLine);
  ok(/mode=managed/.test(factLine) && /branch=relay\/T003/.test(factLine), '事实行记录 managed 模式与任务分支', factLine);
  const verifyA = cliAt(tmpA, 'relay_verify', { full: true });
  ok(verifyA.status === 0, 'verify 全绿', out(verifyA).slice(0, 300));
  ok(/R10\s*\|\s*PASS/.test(out(verifyA)), 'R10 多提交对账一致(不因多提交误判)', out(verifyA).slice(0, 400));

  // ================= C. worktree 内检索/诊断看控制根 =================
  console.log('\n== C. worktree 内 recall/doctor 双根(P0-4) ==');
  const recallInWt = cliAt(execA, 'relay_recall', {});
  ok(/命中 [1-9]/.test(out(recallInWt)), 'worktree 内 recall 能读到控制根历史', out(recallInWt).slice(0, 300));
  const doctorInWt = cliAt(execA, 'relay_doctor', {});
  ok(!/未登记/.test(out(doctorInWt)) || !/D5[^\n]*ERROR/.test(out(doctorInWt)), 'worktree 内 doctor 不误报未登记任务树', out(doctorInWt).slice(0, 400));

  // ================= D. 单根:未跟踪新文件的口径 =================
  console.log('\n== D. 单根未跟踪文件(P0-2) ==');
  const initB = cliAt(tmpB, 'relay_init', { name: '评审回归-单根' });
  ok(initB.status === 0, 'init tmpB', out(initB).slice(0, 200));
  mkdirSync(path.join(tmpB, 'src'), { recursive: true });
  writeFileSync(path.join(tmpB, 'src', 'brand-new.mjs'), 'export const n = 1;\n');
  const claimB = cliAt(tmpB, 'relay_claim', { task: 'T003', model: 'rev-single', worktree: false });
  ok(claimB.status === 0, '单根认领 T003', out(claimB).slice(0, 200));
  const endB = cliAt(tmpB, 'relay_session_end', { model: 'rev-single', summary: '新增一个文件', done_task: 'T003' });
  ok(endB.status === 0, '单根出场成功', out(endB).slice(0, 300));
  const verifyB = cliAt(tmpB, 'relay_verify', { full: true });
  ok(verifyB.status === 0, 'verify 全绿', out(verifyB).slice(0, 300));
  ok(/R10\s*\|\s*PASS/.test(out(verifyB)), 'R10 对未跟踪新文件口径一致(不再 WARN)', out(verifyB).slice(0, 400));

  // ================= E. 发布护栏 =================
  console.log('\n== E. 发布护栏(P2-19) ==');
  const pkg = JSON.parse(readFileSync(path.join(RELAY, 'package.json'), 'utf8'));
  ok(pkg.scripts && pkg.scripts.prepublishOnly === 'node scripts/check-publish-guard.mjs', 'prepublishOnly 护栏已配置');
  const guardDeny = spawnSync('node', [path.join(RELAY, 'scripts', 'check-publish-guard.mjs')], { encoding: 'utf8' });
  ok(guardDeny.status === 1, '无显式批准时发布护栏拒绝(exit 1)');
  const guardAllow = spawnSync('node', [path.join(RELAY, 'scripts', 'check-publish-guard.mjs')], { encoding: 'utf8', env: { ...process.env, RELAY_ALLOW_PUBLISH: '1' } });
  ok(guardAllow.status === 0, 'RELAY_ALLOW_PUBLISH=1 时放行');

  // ================= F. R5 提交原子性:哨兵文件名不可伪造提交头 =================
  // P0-1(PR #8 审计):git log --name-only 把文件名混进同一行流,旧实现用文本哨兵
  // "__COMMIT__" 分隔提交——根级同名文件会被当成提交头,让 R5 静默失明。
  // 回归:白名单修宪允许该文件(R2 不干扰)后,R5 仍必须看到 src 改动并 WARN。
  console.log('\n== F. R5 原子性:__COMMIT__ 文件名不可伪造提交头(P0-1) ==');
  const initC = cliAt(tmpC, 'relay_init', { name: '评审回归-哨兵' });
  ok(initC.status === 0, 'init tmpC', out(initC).slice(0, 200));
  const mfC = JSON.parse(readFileSync(path.join(tmpC, '.relay', 'manifest.json'), 'utf8'));
  mfC.allowedTopLevel = [...new Set([...(mfC.allowedTopLevel || []), '__COMMIT__notes.md'])];
  writeFileSync(path.join(tmpC, '.relay', 'manifest.json'), JSON.stringify(mfC, null, 2) + '\n');
  mkdirSync(path.join(tmpC, 'src'), { recursive: true });
  writeFileSync(path.join(tmpC, 'src', 'feature.js'), 'export const f = 1;\n');
  writeFileSync(path.join(tmpC, '__COMMIT__notes.md'), 'sentinel\n');
  git(tmpC, 'add', '-A');
  const cmt = git(tmpC, '-c', 'user.name=rev', '-c', 'user.email=rev@local', 'commit', '-q', '-m', 'feat: 改代码但不更新 TASKS/LOG');
  ok(cmt.status === 0, '提交含 src 改动与 __COMMIT__ 文件名', (cmt.stderr || '').slice(0, 200));
  const vC = cliAt(tmpC, 'relay_verify', { full: true });
  const rowOf = (text, id) => (text.split('\n').find((l) => new RegExp(`^\\| ${id} \\|`).test(l)) || '');
  const r5 = rowOf(out(vC), 'R5');
  ok(/R5\s*\|\s*WARN/.test(r5), '哨兵文件名不能让 R5 失明(仍 WARN)', r5);
  ok(/feature\.js/.test(r5), 'R5 详情确实看到 src 改动', r5);
  ok(/R2\s*\|\s*PASS/.test(rowOf(out(vC), 'R2')), '白名单已修宪 → R2 PASS(排除 R2 干扰)', rowOf(out(vC), 'R2'));
} finally {
  rmSync(tmpA, { recursive: true, force: true });
  rmSync(tmpB, { recursive: true, force: true });
  rmSync(tmpC, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
