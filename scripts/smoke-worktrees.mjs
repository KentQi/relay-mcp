#!/usr/bin/env node
// worktree 生命周期与锁所有权端到端回归。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dispatch } from '../src/contract.mjs';
import { acquireRepoLock, releaseRepoLock } from '../src/util.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
let pass = 0;
let fail = 0;
const ok = (condition, label, extra = '') => {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ` — ${String(extra).slice(0, 500)}` : ''}`); }
};
const mkTmp = (tag) => {
  const dir = mkdtempSync(path.join(tmpdir(), `relay-worktree-${tag}-`));
  tmpDirs.push(dir);
  return dir;
};
const freshRepo = async (tag) => {
  const root = mkTmp(tag);
  const result = await dispatch('relay_init', { root, preset: 'minimal' });
  if (result.isError) throw new Error(result.content[0].text);
  return root;
};
const resultText = (result) => result?.content?.[0]?.text || '';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const OLD = '2000-01-01T00:00:00.000Z';
const addWorktree = (root, task, recordPath = `.relay/worktrees/${task}`) => {
  const target = path.resolve(root, recordPath);
  mkdirSync(path.dirname(target), { recursive: true });
  git(root, 'worktree', 'add', '-b', `relay/${task}`, target, 'HEAD');
  return {
    task, path: recordPath, branch: `relay/${task}`, baseSha: git(root, 'rev-parse', 'HEAD'),
    owner: 'model-A', status: 'completed', createdAt: OLD, lastUsedAt: OLD,
  };
};

try {
  console.log('\n== L1: TTL 接管与完成权限 ==');
  {
    const root = await freshRepo('ttl');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const takeover = await dispatch('relay_claim', { root, task: 'T003', model: 'model-B', ttl_minutes: 0.000001 });
    ok(!takeover.isError && readFileSync(path.join(root, 'TASKS.md'), 'utf8').includes('[~] T003'), 'L1: 另一模型可在 TTL 到期后接管', resultText(takeover));
  }
  {
    const root = await freshRepo('owner');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const intruder = await dispatch('relay_session_end', { root, model: 'model-B', summary: '越权完成', done_task: 'T003' });
    ok(intruder.isError && /认领者|持有者/.test(resultText(intruder)) && /\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L1: 非持有者不能完成他人任务', resultText(intruder));
    ok(existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L1: 非持有者不能释放他人认领锁');
  }
  {
    const root = await freshRepo('missing-lock');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    rmSync(path.join(root, '.relay', 'claims', 'T003.lock'));
    const intruder = await dispatch('relay_claim', { root, task: 'T003', model: 'model-B' });
    const owner = /^- \[~\] T003 .+  \(model-A, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/m.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'));
    ok(intruder.isError && owner, 'L1: 锁文件丢失时仍按 TASKS 持有时间拒绝提前接管', resultText(intruder));
  }
  {
    const root = mkTmp('repo-lock');
    const first = await acquireRepoLock(root, 'model-A', { waitMs: 0 });
    await releaseRepoLock(root, first.token);
    const second = await acquireRepoLock(root, 'model-B', { waitMs: 0 });
    await releaseRepoLock(root, first.token);
    ok(existsSync(path.join(root, '.relay', 'relay.lock')), 'L1: 旧锁句柄不能释放新持有者的仓库锁');
    await releaseRepoLock(root, second.token);
  }

  console.log('\n== L2: worktree 安全清理矩阵 ==');
  {
    const root = await freshRepo('cleanup');
    const manifest = JSON.parse(readFileSync(path.join(root, '.relay', 'manifest.json'), 'utf8'));
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    ok(manifest.worktree?.enabled === true && manifest.worktree?.ttlHours === 24, 'L2: 新 init 默认启用 worktree 与 24 小时 TTL');
    ok(ignore.includes('.relay/worktrees/') && ignore.includes('.relay/worktrees.json'), 'L2: 缓存目录与注册表默认不入库');

    const expired = addWorktree(root, 'T003');
    const fresh = { ...addWorktree(root, 'T004'), lastUsedAt: new Date().toISOString() };
    const active = { ...addWorktree(root, 'T005'), status: 'active' };
    const dirty = addWorktree(root, 'T006');
    const locked = addWorktree(root, 'T007');
    const unregistered = addWorktree(root, 'T008');
    const escapeTarget = mkTmp('escape-target');
    const escaped = addWorktree(root, 'T009', escapeTarget);
    writeFileSync(path.join(root, 'TASKS.md'), readFileSync(path.join(root, 'TASKS.md'), 'utf8')
      .replace('## 进行中\n', '## 进行中\n- [~] T005 长任务  (model-A, 2026-10-29 00:00)\n'));
    writeFileSync(path.join(root, dirty.path, 'untracked.txt'), 'do not delete\n');
    git(root, 'worktree', 'lock', path.resolve(root, locked.path));
    writeFileSync(path.join(root, '.relay', 'worktrees.json'), `${JSON.stringify({ version: 1, worktrees: [expired, fresh, active, dirty, locked, escaped] }, null, 2)}\n`);

    const dry = await dispatch('relay_worktree_cleanup', { root });
    ok(!dry.isError && existsSync(path.resolve(root, expired.path)), 'L2: 默认 dry-run 报告但不删除', resultText(dry));
    const cleaned = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(!cleaned.isError, 'L2: 显式确认清理成功', resultText(cleaned));
    ok(!existsSync(path.resolve(root, expired.path)), 'L2: 过期 completed worktree 被删除');
    let branchAlive = false;
    try { branchAlive = git(root, 'rev-parse', '--verify', 'refs/heads/relay/T003').length === 40; } catch { branchAlive = false; }
    ok(branchAlive, 'L2: 删除目录后任务分支仍保留');
    ok(existsSync(path.resolve(root, fresh.path)), 'L2: 未到期 worktree 保留');
    ok(existsSync(path.resolve(root, active.path)), 'L2: 活跃任务即使过期也保留');
    ok(existsSync(path.resolve(root, dirty.path)), 'L2: dirty worktree 保留');
    ok(existsSync(path.resolve(root, locked.path)), 'L2: Git locked worktree 保留');
    ok(existsSync(path.resolve(root, unregistered.path)), 'L2: 未登记 worktree 保留');
    ok(existsSync(escapeTarget), 'L2: 注册表路径越界时拒绝删除');
    const remaining = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.map((w) => w.task);
    ok(!remaining.includes('T003') && remaining.includes('T004') && remaining.includes('T009'), 'L2: 注册表仅移除实际清理项');
  }

  console.log('\n== L3: claim 创建、复用与失败回滚 ==');
  {
    const root = await freshRepo('claim-create');
    const base = git(root, 'rev-parse', 'HEAD');
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    const claimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const registry = existsSync(path.join(root, '.relay', 'worktrees.json'))
      ? JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')) : { worktrees: [] };
    ok(!claimed.isError && existsSync(executionRoot) && git(executionRoot, 'rev-parse', '--abbrev-ref', 'HEAD') === 'relay/T003', 'L3: claim 创建任务目录与 relay/T### 分支', resultText(claimed));
    ok(registry.worktrees[0]?.baseSha === base && resultText(claimed).includes(base), 'L3: 注册表与输出记录真实 baseSha');
    const reclaimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    ok(!reclaimed.isError && /复用/.test(resultText(reclaimed)) && resultText(reclaimed).includes(executionRoot), 'L3: 同模型重复 claim 复用原 executionRoot', resultText(reclaimed));
    const other = await dispatch('relay_claim', { root, task: 'T004', model: 'model-A' });
    ok(!other.isError && existsSync(path.join(root, '.relay', 'worktrees', 'T004')) && !resultText(other).includes(executionRoot), 'L3: 不同任务使用隔离目录', resultText(other));
  }
  {
    const root = await freshRepo('claim-legacy');
    const manifestPath = path.join(root, '.relay', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.worktree;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const claimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    ok(!claimed.isError && !existsSync(path.join(root, '.relay', 'worktrees', 'T003')) && !existsSync(path.join(root, '.relay', 'worktrees.json')), 'L3: 旧 manifest 未启用时保持单根认领', resultText(claimed));
  }
  {
    const root = await freshRepo('claim-rollback');
    mkdirSync(path.join(root, '.relay', 'worktrees'), { recursive: true });
    writeFileSync(path.join(root, '.relay', 'worktrees', 'T003'), 'blocking file\n');
    const claimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    ok(claimed.isError && /^- \[ \] T003 /m.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L3: worktree 创建失败不留半认领 TASKS', resultText(claimed));
    ok(!existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L3: worktree 创建失败释放本次认领锁');
  }

  console.log('\n== L4: session 双根、提交原子性与自动清理 ==');
  {
    const root = await freshRepo('dual-root');
    const base = git(root, 'rev-parse', 'HEAD');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    writeFileSync(path.join(executionRoot, 'package.json'), `${JSON.stringify({ scripts: { test: 'node -e "require(\'node:fs\').writeFileSync(\'test-ran.txt\',\'execution\')"' } }, null, 2)}\n`);
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '双根任务完成', done_task: 'T003' });
    const controlTasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    const controlLog = readFileSync(path.join(root, 'LOG.md'), 'utf8');
    const branchHead = git(executionRoot, 'rev-parse', 'HEAD');
    ok(!ended.isError && /\[x\] T003/.test(controlTasks), 'L4: worktree 出场只把 controlRoot 任务标完成', resultText(ended));
    ok(branchHead !== base && git(root, 'rev-parse', 'HEAD') === base && existsSync(path.join(executionRoot, 'test-ran.txt')) && !existsSync(path.join(root, 'test-ran.txt')), 'L4: 测试与代码提交只落在 executionRoot 任务分支');
    ok(controlLog.includes('relay/T003') && controlLog.includes(branchHead), 'L4: controlRoot LOG 记录 branch 与完整提交 SHA');
    const completedRecord = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T003');
    ok(completedRecord?.status === 'completed' && !existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L4: 完成后注册表更新并释放 controlRoot 认领锁');

    const brief = await dispatch('relay_session_start', { root: executionRoot });
    ok(!brief.isError && resultText(brief).includes(`controlRoot: ${realpathSync(root)}`) && existsSync(executionRoot), 'L4: managed session_start 识别双根且不清理自己', resultText(brief));
    const selfClean = await dispatch('relay_worktree_cleanup', { root: executionRoot, confirm: true, ttl_hours: 0 });
    ok(!selfClean.isError && existsSync(executionRoot), 'L4: 当前 executionRoot 即使 TTL=0 也不可自我清理', resultText(selfClean));

    const registryPath = path.join(root, '.relay', 'worktrees.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.worktrees[0].lastUsedAt = OLD;
    registry.worktrees[0].status = 'completed';
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const auto = await dispatch('relay_session_start', { root });
    ok(!auto.isError && !existsSync(executionRoot), 'L4: 后续主仓库 session_start 自动清理过期 completed', resultText(auto));
    let branchAlive = false;
    try { branchAlive = git(root, 'rev-parse', '--verify', 'refs/heads/relay/T003').length === 40; } catch { branchAlive = false; }
    ok(branchAlive, 'L4: 自动清理仍保留任务分支');
    writeFileSync(registryPath, '{broken registry\n');
    const degraded = await dispatch('relay_session_start', { root });
    ok(!degraded.isError && /自动清理/.test(resultText(degraded)), 'L4: 自动清理故障不阻断入场简报', resultText(degraded));
  }
  {
    const root = await freshRepo('commit-failure');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'index.js'), 'export const ok = true;\n');
    const hookRoot = mkTmp('reject-commit-hook');
    const hook = path.join(hookRoot, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    execFileSync('chmod', ['+x', hook]);
    git(executionRoot, 'config', 'core.hooksPath', hookRoot);
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '提交必须失败', done_task: 'T003' });
    const noCompletion = !/\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'))
      && !/\[x\] T003/.test(readFileSync(path.join(executionRoot, 'TASKS.md'), 'utf8'));
    ok(ended.isError && /git commit 失败|提交失败/.test(resultText(ended)) && noCompletion, 'L4: 代码提交失败时两个根都不得标任务完成', resultText(ended));
    ok(existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L4: 代码提交失败保留认领锁供恢复');
  }
  {
    const root = await freshRepo('wrong-task-worktree');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    await dispatch('relay_claim', { root, task: 'T004', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '误传另一个任务号', done_task: 'T004' });
    ok(ended.isError && /任务分支|worktree.*不匹配|任务目录.*不匹配/.test(resultText(ended))
      && /\[~\] T004/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L4: executionRoot 与 done_task 不匹配时拒绝出场', resultText(ended));
    const record = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T004');
    ok(record?.status !== 'completed' && existsSync(path.join(root, '.relay', 'claims', 'T004.lock')), 'L4: 任务目录错位不得串改注册表或释放他人现场');
  }
  {
    const root = await freshRepo('unreadable-git-status');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    const gitDir = git(executionRoot, 'rev-parse', '--git-dir');
    writeFileSync(path.join(gitDir, 'index'), 'corrupt index');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '无法确认代码状态', done_task: 'T003' });
    ok(ended.isError && /status|状态/.test(resultText(ended))
      && !/\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'))
      && existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L4: executionRoot 状态不可读时不得标完成', resultText(ended));
  }
  {
    const root = await freshRepo('ownership-race');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A', worktree: false });
    const waiting = await acquireRepoLock(root, 'ownership-race-barrier', { waitMs: 0 });
    const pending = dispatch('relay_session_end', { root, model: 'model-A', summary: '等待锁期间被接管', done_task: 'T003' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tasksPath = path.join(root, 'TASKS.md');
    writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8').replace(/\(model-A, /, '(model-B, '));
    writeFileSync(path.join(root, '.relay', 'claims', 'T003.lock'), `model-B\n${new Date().toISOString()}\nowner-B\n`);
    await releaseRepoLock(root, waiting.token);
    const ended = await pending;
    ok(ended.isError && /认领者|持有者/.test(resultText(ended))
      && /\[~\] T003 .+\(model-B, /.test(readFileSync(tasksPath, 'utf8')), 'L4: 等待仓库锁期间发生接管时必须重验完成权限', resultText(ended));
    ok(existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L4: 接管者的认领锁不得被前持有者完成流程释放');
  }
} finally {
  console.log(`\n========== worktree 冒烟结果: ${pass} 通过 / ${fail} 失败 ==========`);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
