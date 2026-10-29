#!/usr/bin/env node
// worktree 生命周期与锁所有权端到端回归。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, chmodSync, readdirSync, symlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dispatch } from '../src/contract.mjs';
import { acquireRepoLock, releaseRepoLock, serializeLock, writeProtocolFile, __setLockTimingForTest } from '../src/util.mjs';

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockFileOf = (root) => path.join(root, '.relay', 'relay.lock');
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

  {
    // 复用旧分支时 baseSha 必须取真实 merge-base;陈旧记录(目录不存在)要 prune 后重建
    const root = await freshRepo('stale-merge-base');
    const base0 = git(root, 'rev-parse', 'HEAD');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    git(root, 'add', 'TASKS.md');
    git(root, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'control: advance', '--quiet');
    const base1 = git(root, 'rev-parse', 'HEAD');
    ok(base1 !== base0, 'L3: 控制面 HEAD 已前进');
    rmSync(executionRoot, { recursive: true, force: true });
    const reclaimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const rec = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T003');
    ok(!reclaimed.isError && existsSync(executionRoot) && /executionRoot/.test(resultText(reclaimed)), 'L3: 陈旧记录(目录不存在)prune 后重建 executionRoot', resultText(reclaimed));
    ok(rec?.baseSha === base0 && rec.baseSha !== base1, 'L3: 复用旧分支的 baseSha 取真实 merge-base(非 controlRoot 当前 HEAD)');
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
    const controlHead = git(root, 'rev-parse', 'HEAD');
    ok(!ended.isError && /\[x\] T003/.test(controlTasks), 'L4: worktree 出场只把 controlRoot 任务标完成', resultText(ended));
    ok(branchHead !== base && controlHead !== base && existsSync(path.join(executionRoot, 'test-ran.txt')) && !existsSync(path.join(root, 'test-ran.txt')), 'L4: 测试与代码提交落在 executionRoot,controlRoot 只产生控制面提交');
    ok(git(root, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean).sort().join(',') === 'LOG.md,TASKS.md', 'L4: controlRoot 控制面提交只含 TASKS.md/LOG.md');
    ok(git(root, 'status', '--porcelain') === '', 'L4: 出场后 controlRoot 工作区干净(控制面已提交)');
    ok(resultText(ended).includes(branchHead) && resultText(ended).includes(controlHead), 'L4: 输出同时展示代码 SHA 与控制面 SHA', resultText(ended));
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
    // 真实代码改动:必须由 record.task 校验拦截,不能被伪 SHA 闸顺带挡走(避免假阳性回归)。
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'wrong-task.js'), 'export const wrong = 1;\n');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '误传另一个任务号', done_task: 'T004' });
    const tasksNow = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    ok(ended.isError && /登记的是 T003|与 done_task/.test(resultText(ended)) && !/伪 SHA/.test(resultText(ended))
      && /\[~\] T004/.test(tasksNow), 'L4: executionRoot 与 done_task 错配由 record.task 校验拒绝(非伪 SHA 顺带)', resultText(ended));
    const reg = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8'));
    const recT4 = reg.worktrees.find((w) => w.task === 'T004');
    const recT3 = reg.worktrees.find((w) => w.task === 'T003');
    ok(recT4?.status !== 'completed' && recT3?.status === 'active'
      && existsSync(path.join(root, '.relay', 'claims', 'T004.lock'))
      && !/\[x\] T003/.test(tasksNow) && !/\[x\] T004/.test(tasksNow),
    'L4: 错配出场不串改注册表/不释放 T004 锁/不标完成');
  }
  {
    // 未认领任务号变体:受管 worktree 里 done_task 指向从未 claim 的 T004 → 同样拒绝。
    const root = await freshRepo('wrong-task-unclaimed');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'unclaimed-task.js'), 'export const u = 1;\n');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '未认领任务号', done_task: 'T004' });
    const tasksNow = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    ok(ended.isError && /登记的是 T003|与 done_task/.test(resultText(ended)) && /\[ \] T004/.test(tasksNow),
      'L4: 受管 worktree 不可完成未认领的其他任务号', resultText(ended));
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

  console.log('\n== L5: 根错配 fail-closed 与伪 SHA ==');
  {
    // A: 从 controlRoot 完成「仍有活跃 worktree + 未提交代码」的任务 → 必须拒绝
    const root = await freshRepo('root-mismatch');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'index.js'), 'export const taskCode = 1;\n');
    const bad = await dispatch('relay_session_end', { root, model: 'model-A', summary: '从主仓库完成', done_task: 'T003' });
    ok(bad.isError && /根错配/.test(resultText(bad)) && /executionRoot/.test(resultText(bad)), 'L5-A: 从 controlRoot 完成活跃 worktree 任务被 fail-closed', resultText(bad));
    ok(/\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')) && existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L5-A: 拒绝后 TASKS 未标完成、认领锁保留');
    const good = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '从 executionRoot 完成', done_task: 'T003' });
    ok(!good.isError && /\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L5-A: 正确根出场成功且控制面落账', resultText(good));
  }
  {
    // A2(Lead 决策/Fix2b):受管 worktree 即使为空(clean、无新提交),从 controlRoot 完成也必须拒绝——
    // 不再保留「空且干净树单根兼容」例外;受管任务必须在 executionRoot 出场拿到成对证据。
    const root = await freshRepo('empty-worktree');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const ended = await dispatch('relay_session_end', { root, model: 'model-A', summary: '空 worktree 单根完成', done_task: 'T003' });
    const record = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T003');
    ok(ended.isError && /根错配/.test(resultText(ended)) && /executionRoot/.test(resultText(ended)),
      'L5-A2: 空且干净的受管 worktree 从 controlRoot 完成也必须拒绝(fail-closed)', resultText(ended));
    ok(record?.status === 'active' && /\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'))
      && existsSync(path.join(root, '.relay', 'claims', 'T003.lock')),
      'L5-A2: 拒绝后 TASKS 保持 [~]、认领锁与 active 注册记录均保留');
  }
  {
    // B: managed worktree HEAD==baseSha 且无改动 → 伪 SHA 拒绝
    const root = await freshRepo('pseudo-sha');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    const bad = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '没有代码改动', done_task: 'T003' });
    const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    ok(bad.isError && /伪 SHA|baseSha/.test(resultText(bad)), 'L5-B: HEAD==baseSha 且无改动 → 伪 SHA 拒绝', resultText(bad));
    ok(/\[~\] T003/.test(tasks) && !/\[x\] T003/.test(tasks) && existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L5-B: 伪 SHA 不盖完成章、不释放认领锁');
  }

  console.log('\n== L6: 双提交与成对证据 ==');
  {
    const root = await freshRepo('dual-commit');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'feature.js'), 'export const feature = 1;\n');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '双提交证据', done_task: 'T003' });
    const text = resultText(ended);
    const codeSha = git(executionRoot, 'rev-parse', 'HEAD');
    const controlSha = git(root, 'rev-parse', 'HEAD');
    ok(!ended.isError && text.includes(codeSha) && text.includes(controlSha) && codeSha !== controlSha, 'L6: 输出展示代码 SHA 与控制面 SHA(两提交)', text.slice(0, 900));
    ok(/^- \[x\] T003 /m.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')) && !/^- \[~\] T003 /m.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L6: 双提交成功后 TASKS 标完成');
    ok(git(root, 'status', '--porcelain') === '', 'L6: 控制面提交后 controlRoot 工作区干净');
    ok(git(root, 'log', '-1', '--format=%s').includes('T003 完成'), 'L6: controlRoot 最新提交消息含 T003 完成');
    ok(git(root, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean).sort().join(',') === 'LOG.md,TASKS.md', 'L6: 控制面提交只含 TASKS.md/LOG.md(不卷入其它改动)');
    ok(/成对证据/.test(text), 'L6: 输出包含成对证据说明');
    ok(git(root, 'log', '--grep', 'T003 完成', '--oneline').includes('T003 完成'), 'L6: controlRoot 完成提交可 git log --grep 反查');
    const rec = JSON.parse(readFileSync(path.join(root, '.relay', 'worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T003');
    ok(rec?.status === 'completed' && rec?.commitSha === codeSha && rec?.controlSha === controlSha && rec?.controlCommitted === true, 'L6: 注册表记录两侧 SHA 与 controlCommitted');
    const again = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '重跑补交', done_task: 'T003' });
    ok(!again.isError && git(root, 'rev-parse', 'HEAD') === controlSha && git(executionRoot, 'rev-parse', 'HEAD') === codeSha, 'L6: 重跑出场幂等(不产生重复提交)', resultText(again));
  }
  {
    // managed 维护出场(无 done_task):代码提交 + 控制面 LOG 提交都要落账,TASKS 保持 [~]
    const root = await freshRepo('maintenance-managed');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'wip.js'), 'export const wip = 1;\n');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '中途维护出场' });
    const text = resultText(ended);
    ok(!ended.isError && /代码\(executionRoot\)/.test(text) && /控制面\(controlRoot\)/.test(text) && /^- \[~\] T003 /m.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L6: managed 维护出场双提交且 TASKS 保持进行中', text.slice(0, 800));
    ok(git(root, 'status', '--porcelain') === '' && git(root, 'log', '-1', '--format=%s').includes('session end'), 'L6: managed 维护出场后 controlRoot 干净(LOG 已提交)');
  }
  {
    // autoCommit=false:代码需人工提交;控制面明确标注"未提交",不得伪装成已落账
    const root = await freshRepo('autocommit-off');
    const manifestPath = path.join(root, '.relay', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.autoCommit = false;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'manual.js'), 'export const manual = 1;\n');
    git(executionRoot, 'add', '-A');
    git(executionRoot, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'manual: task code', '--quiet');
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: 'autoCommit 关闭', done_task: 'T003' });
    const text = resultText(ended);
    ok(!ended.isError && /控制面未提交/.test(text) && /autoCommit/.test(text), 'L6: autoCommit=false 时明确标注控制面未提交', text.slice(0, 1200));
    ok(git(root, 'status', '--porcelain', '-uall').includes('TASKS.md') && git(root, 'status', '--porcelain', '-uall').includes('LOG.md'), 'L6: autoCommit=false 时 controlRoot 协议面确实未提交(如所标注)');
  }
  {
    // managed 出场时 controlRoot 上的误写代码:必须显式告警,不得伪装成"已提交"
    const root = await freshRepo('controlroot-dirty');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'ok.js'), 'export const ok = 1;\n');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'stray.js'), 'export const stray = 1;\n'); // 误写主工作树
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '主工作树有误写', done_task: 'T003' });
    const text = resultText(ended);
    ok(!ended.isError && /另有未提交改动/.test(text) && git(root, 'status', '--porcelain', '-uall').includes('src/stray.js'), 'L6: controlRoot 误写代码显式告警且保持未提交', text.slice(0, 1200));
    ok(!git(root, 'log', '-1', '--name-only', '--pretty=format:').includes('src/stray.js'), 'L6: controlRoot 误写代码未被卷入控制面提交');
  }

  console.log('\n== L7: registry fail-closed、verify 双根与未合并分支可见 ==');
  {
    const root = await freshRepo('registry-missing');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'x.js'), 'export const x = 1;\n');
    rmSync(path.join(root, '.relay', 'worktrees.json'));
    const bad = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '注册表缺失', done_task: 'T003' });
    ok(bad.isError && /根错配|注册表/.test(resultText(bad)) && /relay_claim/.test(resultText(bad)), 'L7: 注册表缺失时完成出场 fail-closed 并给重建指引', resultText(bad));
    ok(/\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')) && existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L7: fail-closed 不改 TASKS、不释放锁');
    const start = await dispatch('relay_session_start', { root: executionRoot });
    ok(!start.isError && /未登记/.test(resultText(start)), 'L7: 未登记 linked worktree 的 session_start 明确告警', resultText(start));
    writeFileSync(path.join(root, '.relay', 'worktrees.json'), '{broken\n');
    const claimBad = await dispatch('relay_claim', { root, task: 'T004', model: 'model-A' });
    ok(claimBad.isError && /注册表/.test(resultText(claimBad)) && /修复或删除/.test(resultText(claimBad)), 'L7: 注册表损坏时 claim fail-closed 并可执行恢复指引', resultText(claimBad));
    const endBad = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '注册表损坏', done_task: 'T003' });
    ok(endBad.isError && /注册表损坏/.test(resultText(endBad)), 'L7: 注册表损坏时完成出场 fail-closed', resultText(endBad));
  }
  {
    // verify 双根:root 在 executionRoot 时同时检查 controlRoot 与任务树
    const root = await freshRepo('verify-dual');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'rogue'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'rogue', 'x.txt'), 'R2 violation\n');
    const rv = await dispatch('relay_verify', { root: executionRoot, full: true });
    const text = resultText(rv);
    ok(rv.isError && /R2/.test(text) && /双根模式/.test(text) && /controlRoot/.test(text) && /executionRoot 任务树/.test(text), 'L7: relay_verify 在 executionRoot 内同时检查双根并报任务树 R2 ERROR', text.slice(0, 1200));
    const ended = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '任务树违规', done_task: 'T003' });
    ok(ended.isError && /R2/.test(resultText(ended)) && /executionRoot/.test(resultText(ended)) && !/\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L7: 出场绿闸覆盖 executionRoot 任务树(R2 ERROR 阻断)', resultText(ended));
  }
  {
    // 未合并 relay/T### 分支在 claim / session_start / cleanup 输出中可见
    const root = await freshRepo('unmerged-visible');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'a.js'), 'export const a = 1;\n');
    await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '完成但未合并', done_task: 'T003' });
    const c4 = await dispatch('relay_claim', { root, task: 'T004', model: 'model-A', worktree: false });
    ok(/未合并任务分支/.test(resultText(c4)) && /relay\/T003/.test(resultText(c4)), 'L7: claim 输出列出未合并任务分支 relay/T###', resultText(c4));
    const brief = await dispatch('relay_session_start', { root });
    ok(/未合并任务分支/.test(resultText(brief)) && /relay\/T003/.test(resultText(brief)), 'L7: session_start 输出列出未合并任务分支', resultText(brief));
    const clean = await dispatch('relay_worktree_cleanup', { root });
    ok(/未合并任务分支/.test(resultText(clean)), 'L7: worktree_cleanup 输出列出未合并任务分支', resultText(clean));
  }
  {
    // 未登记 linked worktree 的维护出场:不 fail-closed(完成才拒绝),但必须告警且控制面独立提交
    const root = await freshRepo('unregistered-maintenance');
    const wt = path.join(mkTmp('manual-wt'), 'checkout-error'); // 仓库外的手工 worktree(未登记)
    git(root, 'worktree', 'add', '-b', 'manual/exp', wt, 'HEAD');
    mkdirSync(path.join(wt, 'src'), { recursive: true });
    writeFileSync(path.join(wt, 'src', 'm.js'), 'export const m = 1;\n');
    const ended = await dispatch('relay_session_end', { root: wt, model: 'model-A', summary: '手工 worktree 维护出场' });
    const text = resultText(ended);
    ok(!ended.isError && /未登记/.test(text) && /维护/.test(text), 'L7: 未登记 linked worktree 维护出场告警但不阻断', text.slice(0, 800));
    ok(git(root, 'status', '--porcelain', '-uall') === '', 'L7: 未登记 linked worktree 维护出场后 controlRoot 协议面已提交(干净)');
    ok(git(wt, 'status', '--porcelain', '-uall') === '', 'L7: 未登记 linked worktree 代码已提交');
  }
  console.log('\n== L8: Fix2a ignored 保护 / 陈旧 worktree / 注册表校验 / cacheDir / claim 降级 ==');
  {
    // R-02:含 ignored 本地内容(.env/node_modules/构建产物)的过期 worktree 默认保留;
    // 显式 cleanup 与 session_start 自动清理两条路径都必须生效。
    const root = await freshRepo('ignored-protect');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay/worktrees', 'T003');
    writeFileSync(path.join(executionRoot, '.env'), 'API_KEY=local-only\n');
    mkdirSync(path.join(executionRoot, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'node_modules', 'dep', 'package.json'), '{}');
    const regPath = path.join(root, '.relay', 'worktrees.json');
    const registry = JSON.parse(readFileSync(regPath, 'utf8'));
    registry.worktrees.find((w) => w.task === 'T003').lastUsedAt = OLD;
    registry.worktrees.find((w) => w.task === 'T003').status = 'completed';
    writeFileSync(regPath, `${JSON.stringify(registry, null, 2)}\n`);
    writeFileSync(path.join(root, 'TASKS.md'), readFileSync(path.join(root, 'TASKS.md'), 'utf8')
      .replace(/^- \[~\] T003 /m, '- [x] T003 '));

    const dry = await dispatch('relay_worktree_cleanup', { root });
    ok(!/可清理\(1\)/.test(resultText(dry)) && /ignored/.test(resultText(dry)),
      'L8-R02: 含 ignored 本地内容的过期 worktree 在 dry-run 中被保留并说明原因', resultText(dry));
    const cleaned = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(existsSync(executionRoot) && existsSync(path.join(executionRoot, '.env'))
      && !/已清理\(1\)/.test(resultText(cleaned)), 'L8-R02: confirm 也不删除 .env/node_modules 现场', resultText(cleaned));
    const auto = await dispatch('relay_session_start', { root });
    ok(existsSync(executionRoot) && existsSync(path.join(executionRoot, '.env'))
      && /保留 1 个/.test(resultText(auto)), 'L8-R02: session_start 自动清理路径同样保留 ignored 现场', resultText(auto));

    // 反向对照:移除 ignored 内容后同一现场可正常清理(保护是精确条件,不是永不清理)
    rmSync(path.join(executionRoot, 'node_modules'), { recursive: true, force: true });
    rmSync(path.join(executionRoot, '.env'), { force: true });
    const done = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(!existsSync(executionRoot) && /已清理\(1\)/.test(resultText(done)),
      'L8-R02: 移除 ignored 内容后同一 worktree 正常清理', resultText(done));
  }
  {
    // P2-12:注册表投毒防护——task/path/branch 任一与受管命名不符即只保留不清理;
    // 手工创建、只被伪造记录指向的 worktree 绝不能被删。
    const root = await freshRepo('registry-poison');
    mkdirSync(path.join(root, '.relay', 'worktrees'), { recursive: true });
    const manual = path.join(root, '.relay', 'worktrees', 'manual-evil');
    git(root, 'worktree', 'add', '-b', 'relay/T666', manual, 'HEAD');
    writeFileSync(path.join(root, '.relay', 'worktrees.json'), `${JSON.stringify({
      version: 1,
      worktrees: [
        { task: 'T666', path: '.relay/worktrees/manual-evil', branch: 'relay/T666', lastUsedAt: OLD, status: 'completed' },
        { task: 'T667', path: '.relay/worktrees/T667', branch: 'relay/T666', lastUsedAt: OLD, status: 'completed' },
        { task: '../../evil', path: '.relay/worktrees/manual-evil', branch: 'relay/T666', lastUsedAt: OLD, status: 'completed' },
      ],
    }, null, 2)}\n`);
    const cleaned = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(existsSync(manual) && /疑似伪造|不一致/.test(resultText(cleaned)) && !/已清理\(1\)/.test(resultText(cleaned)),
      'L8-P2-12: 伪造注册表记录(task/path/branch 不符)不触发任何删除,手工 worktree 保留', resultText(cleaned));
  }
  {
    // R-03:仓库整体移动后 Git admin 链接失效 → repair/prune 后按分支重建,孤儿目录绝不 rm -rf
    const rootOld = await freshRepo('moved-repo');
    await dispatch('relay_claim', { root: rootOld, task: 'T003', model: 'model-A' });
    const root = `${rootOld}-moved`;
    renameSync(rootOld, root);
    tmpDirs.push(root);
    const reclaimed = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay', 'worktrees', 'T003');
    ok(!reclaimed.isError && existsSync(executionRoot) && /executionRoot/.test(resultText(reclaimed)),
      'L8-R03: 仓库整体移动后 prune/repair 重建任务 worktree', resultText(reclaimed));
    ok(git(executionRoot, 'rev-parse', '--abbrev-ref', 'HEAD') === 'relay/T003',
      'L8-R03: 重建后的 worktree 仍在原任务分支');
    const orphans = readdirSync(path.join(root, '.relay', 'worktrees')).filter((n) => n.includes('.relay-orphan-'));
    ok(orphans.length === 1 && existsSync(path.join(root, '.relay', 'worktrees', orphans[0])),
      'L8-R03: 无法 repair 的旧检出被改名留存(未 rm -rf)', orphans.join(','));
  }
  {
    // R-03:remove 失败 → 错误含可执行恢复指引;Git 注销但目录残留 → 陈旧现场报告;
    // 再次 claim 时孤儿目录改名留存并重建。
    const root = await freshRepo('remove-fail');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay/worktrees', 'T003');
    chmodSync(executionRoot, 0o500);
    const regPath = path.join(root, '.relay', 'worktrees.json');
    const registry = JSON.parse(readFileSync(regPath, 'utf8'));
    registry.worktrees.find((w) => w.task === 'T003').lastUsedAt = OLD;
    registry.worktrees.find((w) => w.task === 'T003').status = 'completed';
    writeFileSync(regPath, `${JSON.stringify(registry, null, 2)}\n`);
    writeFileSync(path.join(root, 'TASKS.md'), readFileSync(path.join(root, 'TASKS.md'), 'utf8')
      .replace(/^- \[~\] T003 /m, '- [x] T003 '));
    const failed = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(failed.isError && /remove 失败/.test(resultText(failed)) && /rm -rf|恢复/.test(resultText(failed)) && existsSync(executionRoot),
      'L8-R03: git worktree remove 失败时给可执行恢复指引,目录与记录保留', resultText(failed));
    const staleReport = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    ok(!staleReport.isError && /陈旧\/孤儿现场/.test(resultText(staleReport)) && /未登记/.test(resultText(staleReport)),
      'L8-R03: Git 注销但目录残留 → 陈旧现场显式报告(不永久沉默)', resultText(staleReport));
    chmodSync(executionRoot, 0o755);
    writeFileSync(path.join(root, 'TASKS.md'), readFileSync(path.join(root, 'TASKS.md'), 'utf8')
      .replace(/^- \[x\] T003 /m, '- [ ] T003 '));
    rmSync(path.join(root, '.relay', 'claims', 'T003.lock')); // 模拟认领锁已随崩溃恢复释放
    const re = await dispatch('relay_claim', { root, task: 'T003', model: 'model-B' });
    ok(!re.isError && existsSync(executionRoot) && /孤儿/.test(resultText(re)),
      'L8-R03: remove 半失败留下的孤儿目录在再次 claim 时安全留存并重建', resultText(re));
    const orphans = readdirSync(path.join(root, '.relay', 'worktrees')).filter((n) => n.includes('.relay-orphan-'));
    ok(orphans.length === 1, 'L8-R03: 重建时旧目录被改名留存而非删除', orphans.join(','));
  }
  {
    // R-03:目录已不存在的陈旧注册表记录自动回收(分支保留),不再每次自动清理都沉默保留
    const root = await freshRepo('stale-record');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay/worktrees', 'T003');
    rmSync(executionRoot, { recursive: true, force: true });
    const regPath = path.join(root, '.relay', 'worktrees.json');
    const registry = JSON.parse(readFileSync(regPath, 'utf8'));
    registry.worktrees.find((w) => w.task === 'T003').lastUsedAt = OLD;
    registry.worktrees.find((w) => w.task === 'T003').status = 'completed';
    writeFileSync(regPath, `${JSON.stringify(registry, null, 2)}\n`);
    writeFileSync(path.join(root, 'TASKS.md'), readFileSync(path.join(root, 'TASKS.md'), 'utf8')
      .replace(/^- \[~\] T003 /m, '- [x] T003 '));
    const gc = await dispatch('relay_worktree_cleanup', { root, confirm: true });
    const remaining = JSON.parse(readFileSync(regPath, 'utf8')).worktrees.map((w) => w.task);
    ok(/陈旧\/孤儿现场/.test(resultText(gc)) && /自动回收/.test(resultText(gc)) && !remaining.includes('T003'),
      'L8-R03: 目录不存在的陈旧注册表记录自动回收并给指引', resultText(gc));
    let branchAlive = false;
    try { branchAlive = git(root, 'rev-parse', '--verify', 'refs/heads/relay/T003').length === 40; } catch { branchAlive = false; }
    ok(branchAlive, 'L8-R03: 回收陈旧记录不影响任务分支');
  }
  {
    // P3-01:cacheDir 严格校验(控制字符/换行/绝对/盘符相对/../.git/空/.),且非法 cacheDir 不连累 worktree:false 认领
    const root = await freshRepo('cache-dir');
    const manifestPath = path.join(root, '.relay', 'manifest.json');
    const badValues = ['../escape', '/abs/wt', 'C:\\tmp\\wt', 'C:rel', '.git/hooks', '.relay/wt\ninject', '', '.', './'];
    const rejectedSamples = [];
    const isolationSamples = [];
    for (const value of badValues) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      m.worktree = { enabled: true, cacheDir: value, ttlHours: 24, autoCleanup: true };
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
      const bad = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
      if (!(bad.isError && /cacheDir/.test(resultText(bad)))) {
        rejectedSamples.push(`${JSON.stringify(value)} → ${resultText(bad).slice(0, 160)}`);
      }
      const single = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A', worktree: false });
      if (single.isError) isolationSamples.push(`${JSON.stringify(value)} → ${resultText(single).slice(0, 160)}`);
    }
    ok(rejectedSamples.length === 0, 'L8-P3-01: 非法 cacheDir 全部拒绝(含控制字符/换行/绝对/盘符相对/../.git/空/.)', rejectedSamples.join(' | '));
    ok(isolationSamples.length === 0, 'L8-P3-01: 非法 cacheDir 不连累 worktree:false 单根认领', isolationSamples.join(' | '));
    ok(!existsSync(path.join(root, '.relay', 'worktrees')), 'L8-P3-01: 校验失败发生在任何 ensureDir 之前(未创建缓存目录)');

    // R-07:合法自定义 cacheDir → 创建成功,并幂等补 .gitignore(实际 cacheDir + 注册表 + 锁),重复 claim 不重复追加
    const m2 = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m2.worktree = { enabled: true, cacheDir: '.relay/wt-custom', ttlHours: 24, autoCleanup: true };
    writeFileSync(manifestPath, `${JSON.stringify(m2, null, 2)}\n`);
    const giPath = path.join(root, '.gitignore');
    writeFileSync(giPath, readFileSync(giPath, 'utf8').split('\n').filter((l) => !l.includes('worktrees')).join('\n'));
    const custom = await dispatch('relay_claim', { root, task: 'T004', model: 'model-A' });
    const giText = readFileSync(giPath, 'utf8');
    ok(!custom.isError && existsSync(path.join(root, '.relay', 'wt-custom', 'T004'))
      && giText.includes('.relay/wt-custom/') && giText.includes('.relay/worktrees.json') && giText.includes('.relay/worktrees.lock'),
      'L8-R07: 自定义 cacheDir 创建成功并幂等补 .gitignore 三行', resultText(custom));
    await dispatch('relay_claim', { root, task: 'T004', model: 'model-A' });
    const giAfter = readFileSync(giPath, 'utf8').split('\n');
    ok(giAfter.filter((l) => l === '.relay/worktrees.json').length === 1
      && giAfter.filter((l) => l === '.relay/wt-custom/').length === 1,
      'L8-R07: 重复 claim 不重复追加 .gitignore 行');
  }
  {
    // R-06:无可用 HEAD / 非 Git 仓库时 claim 降级单根 + WARN(不硬失败),不创建 executionRoot
    const noHeadRoot = await freshRepo('no-head');
    const headRef = git(noHeadRoot, 'symbolic-ref', 'HEAD');
    git(noHeadRoot, 'update-ref', '-d', headRef);
    const noHead = await dispatch('relay_claim', { root: noHeadRoot, task: 'T003', model: 'model-A' });
    ok(!noHead.isError && /降级单根/.test(resultText(noHead))
      && resultText(noHead).includes(`executionRoot: ${realpathSync(noHeadRoot)}`)
      && !existsSync(path.join(noHeadRoot, '.relay', 'worktrees', 'T003')),
      'L8-R06: 无可用 HEAD 时 claim 降级单根并 WARN', resultText(noHead));

    const noGitRoot = await freshRepo('no-git');
    rmSync(path.join(noGitRoot, '.git'), { recursive: true, force: true });
    const noGit = await dispatch('relay_claim', { root: noGitRoot, task: 'T003', model: 'model-A' });
    ok(!noGit.isError && /降级单根/.test(resultText(noGit))
      && !existsSync(path.join(noGitRoot, '.relay', 'worktrees', 'T003')),
      'L8-R06: 非 Git 仓库 claim 降级单根并 WARN', resultText(noGit));
  }
  console.log('\n== L9: Fix2b 锁协议 / 原子写 / 输入净化 / symlink / 严格根错配 ==');
  {
    // R-04/P2-10/P2-11:仓库写锁改 JSON v2(holder 结构化,换行不再破坏 token 定位);旧文本锁只读兼容。
    const root = mkTmp('lock-json');
    const a = await acquireRepoLock(root, 'session-end:evil\nmodel');
    const raw = readFileSync(lockFileOf(root), 'utf8');
    let parsedLock = null;
    try { parsedLock = JSON.parse(raw); } catch { parsedLock = null; }
    ok(parsedLock?.version === 2 && parsedLock?.holder === 'session-end:evil\nmodel'
      && typeof parsedLock?.token === 'string' && parsedLock.token.length >= 16,
    'L9-R04: 仓库锁为 JSON v2(holder 含换行仍可结构化解析)', raw.slice(0, 200));
    const relA = await a.release();
    ok(relA.ok && relA.released && !existsSync(lockFileOf(root)), 'L9-R04: JSON 锁正常释放', JSON.stringify(relA));

    const legacyRoot = mkTmp('lock-legacy');
    mkdirSync(path.join(legacyRoot, '.relay'), { recursive: true });
    const legacyToken = 'legacy-token-abcdef';
    writeFileSync(lockFileOf(legacyRoot), `evil\nmodel\n2026-01-01T00:00:00.000Z\n${legacyToken}\n`);
    const legacyRel = await releaseRepoLock(legacyRoot, legacyToken);
    ok(legacyRel.ok && legacyRel.released && !existsSync(lockFileOf(legacyRoot)),
      'L9-R04: 旧文本锁 token 取最后一行非空行,model 含换行也能正常释放', JSON.stringify(legacyRel));

    // 锁路径被替换成符号链接:拒绝跟随(不接管、不释放、不动仓库外目标文件)
    const symRoot = mkTmp('lock-symlink');
    mkdirSync(path.join(symRoot, '.relay'), { recursive: true });
    const outsideLock = path.join(mkTmp('lock-symlink-outside'), 'outside.lock');
    writeFileSync(outsideLock, serializeLock({ holder: 'outside', token: 'outside-token-0001' }));
    symlinkSync(outsideLock, lockFileOf(symRoot));
    let symErr = '';
    try { await acquireRepoLock(symRoot, 'holder-F', { waitMs: 0 }); } catch (e) { symErr = e?.message || String(e); }
    ok(/符号链接/.test(symErr), 'L9-R08: 锁文件是符号链接时拒绝接管(不跟随)', symErr);
    const symRel = await releaseRepoLock(symRoot, 'outside-token-0001');
    ok(!symRel.ok && /符号链接/.test(symRel.warning), 'L9-R08: 符号链接锁拒绝释放', JSON.stringify(symRel));
    ok(existsSync(lockFileOf(symRoot)) && readFileSync(outsideLock, 'utf8').includes('outside'),
      'L9-R08: 符号链接锁未被删除/外部目标文件未被改写');

    const b = await acquireRepoLock(root, 'holder-B');
    const badRel = await releaseRepoLock(root, 'not-the-token');
    ok(!badRel.ok && /token 不匹配|接管/.test(badRel.warning) && existsSync(lockFileOf(root)),
      'L9-R04: release 失败返回告警(不再静默 false)', JSON.stringify(badRel));
    await b.release();

    // 空/半初始化锁(O_EXCL 后崩溃):宽限期后按内容比对安全接管;刚创建未写完的窗口不被抢占。
    const emptyRoot = mkTmp('lock-empty');
    mkdirSync(path.join(emptyRoot, '.relay'), { recursive: true });
    writeFileSync(lockFileOf(emptyRoot), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockFileOf(emptyRoot), stale, stale);
    const t0 = Date.now();
    const dl = await acquireRepoLock(emptyRoot, 'holder-D', { waitMs: 5_000 });
    ok(dl.ok && Date.now() - t0 < 3_000, 'L9-R04: 空/半初始化锁在宽限期后安全接管(不再阻塞 120s/240min)', JSON.stringify(dl));
    await dl.release();
    writeFileSync(lockFileOf(emptyRoot), '');
    const freshEmpty = await acquireRepoLock(emptyRoot, 'holder-E', { waitMs: 0 });
    ok(!freshEmpty.ok, 'L9-R04: 刚创建尚未写完的空锁在宽限期内不被抢占(防双持有)');
    rmSync(lockFileOf(emptyRoot), { force: true });

    // 心跳 + fencing:持锁心跳刷新 mtime;被接管后 check() 报错,写协议文件被 fencing 拒绝
    const hbRoot = mkTmp('lock-heartbeat');
    const restoreTiming = __setLockTimingForTest({ heartbeatMs: 80, emptyGraceMs: 500 });
    try {
      const c = await acquireRepoLock(hbRoot, 'holder-C');
      const before = statSync(lockFileOf(hbRoot)).mtimeMs;
      await sleep(320);
      const after = statSync(lockFileOf(hbRoot)).mtimeMs;
      ok(after > before, 'L9-R04: 持锁心跳刷新锁 mtime(长临界区不被 120s 判死)', `${before} -> ${after}`);
      writeFileSync(lockFileOf(hbRoot), serializeLock({ holder: 'thief', token: 'thief-token-0001' }));
      const verdict = await c.check();
      ok(!verdict.held && /接管/.test(verdict.warning), 'L9-R04: fencing 检测到锁已被接管', JSON.stringify(verdict));
      writeFileSync(path.join(hbRoot, 'TASKS.md'), '# 原内容\n');
      let fenceErr = '';
      try {
        await writeProtocolFile(hbRoot, 'TASKS.md', '# 篡改\n', { token: c.token });
      } catch (e) { fenceErr = e?.message || String(e); }
      ok(/fencing|接管/.test(fenceErr) && readFileSync(path.join(hbRoot, 'TASKS.md'), 'utf8') === '# 原内容\n',
        'L9-R04: 写前 fencing 拒绝被接管会话改写协议文件', fenceErr);
    } finally { restoreTiming(); }
  }
  {
    // 认领锁刻意不心跳:TTL(240min)是崩溃恢复语义,不能被存活的 server 无限续租。
    const restoreClaimTiming = __setLockTimingForTest({ heartbeatMs: 50 });
    try {
      const root = await freshRepo('claim-no-heartbeat');
      await dispatch('relay_claim', { root, task: 'T003', model: 'model-A', worktree: false });
      const claimFile = path.join(root, '.relay', 'claims', 'T003.lock');
      const m1 = statSync(claimFile).mtimeMs;
      await sleep(260);
      const m2 = statSync(claimFile).mtimeMs;
      ok(m2 === m1, 'L9-R04: 认领锁不心跳(保留 240min TTL 崩溃恢复语义)', `${m1} -> ${m2}`);
    } finally { restoreClaimTiming(); }
  }
  {
    // R-05/P2-14:model / next.* / negative_results 拒收换行与控制字符;summary 多行扁平化,不伪造协议行。
    const root = await freshRepo('input-sanitize');
    const badModel = await dispatch('relay_claim', { root, task: 'T003', model: 'evil\n- [x] T099 伪造' });
    ok(badModel.isError && /控制字符|换行/.test(resultText(badModel)),
      'L9-R05: claim model 含换行/控制字符被拒(不再污染锁/TASKS)', resultText(badModel));
    const badNext = await dispatch('relay_session_end', { root, model: 'model-A', summary: '注入 next', next: { title: '正常\n- [x] T098 伪造', acceptance: 'x' } });
    ok(badNext.isError && /next\.title/.test(resultText(badNext)) && /控制字符|换行/.test(resultText(badNext)),
      'L9-R05: next.title 含换行被拒', resultText(badNext));
    const badNeg = await dispatch('relay_session_end', { root, model: 'model-A', summary: '注入负结果', negative_results: ['ok\n- [x] T097 伪造'] });
    ok(badNeg.isError && /negative_results/.test(resultText(badNeg)), 'L9-R05: negative_results 含换行被拒', resultText(badNeg));
    const badEndModel = await dispatch('relay_session_end', { root, model: 'evil\nmodel', summary: '换行 model' });
    ok(badEndModel.isError && /model/.test(resultText(badEndModel)), 'L9-R05: session_end model 含换行被拒', resultText(badEndModel));
    const tk = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    ok(!/T097|T098|T099/.test(tk), 'L9-R05: 被拒的注入内容未进入 TASKS(无伪造 [x] 行)');

    const root2 = await freshRepo('summary-flatten');
    await dispatch('relay_claim', { root: root2, task: 'T003', model: 'model-A', worktree: false });
    const flat = await dispatch('relay_session_end', { root: root2, model: 'model-A', summary: '第一行\n- [x] T096 注入行', done_task: 'T003' });
    const log = readFileSync(path.join(root2, 'LOG.md'), 'utf8');
    ok(!flat.isError && !/^- \[x\] T096/m.test(log) && log.includes('第一行 - [x] T096 注入行'),
      'L9-R05: summary 多行被扁平化为单行(不产生伪造协议行)', resultText(flat).slice(0, 400));
    ok(!readFileSync(path.join(root2, 'TASKS.md'), 'utf8').includes('T096'), 'L9-R05: summary 注入未污染 TASKS');
  }
  {
    // R-08:协议文件 symlink 防线——TASKS.md 指向仓库外文件时出场 fail-closed,外部文件不变。
    const root = await freshRepo('symlink-guard');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A', worktree: false });
    const outsideDir = mkTmp('symlink-outside');
    const outside = path.join(outsideDir, 'TASKS-outside.md');
    writeFileSync(outside, '# 仓库外文件,不得被改写\n');
    const tasksPath = path.join(root, 'TASKS.md');
    const savedTasks = readFileSync(tasksPath, 'utf8');
    rmSync(tasksPath);
    symlinkSync(outside, tasksPath);
    const bad = await dispatch('relay_session_end', { root, model: 'model-A', summary: 'symlink 劫持', done_task: 'T003' });
    ok(bad.isError && /符号链接/.test(resultText(bad)), 'L9-R08: TASKS.md 为符号链接时出场 fail-closed', resultText(bad));
    ok(readFileSync(outside, 'utf8') === '# 仓库外文件,不得被改写\n', 'L9-R08: 仓库外目标文件未被写入');
    ok(existsSync(path.join(root, '.relay', 'claims', 'T003.lock')), 'L9-R08: 拒绝后认领锁保留');
    rmSync(tasksPath);
    writeFileSync(tasksPath, savedTasks);
    const okEnd = await dispatch('relay_session_end', { root, model: 'model-A', summary: '恢复后正常出场', done_task: 'T003' });
    ok(!okEnd.isError && /\[x\] T003/.test(readFileSync(tasksPath, 'utf8')), 'L9-R08: 移除符号链接后正常出场(非误伤)', resultText(okEnd));
  }
  {
    // 复核项 R1:.gitignore 为符号链接时,基线补齐(claim/sync/onboard)不得写穿仓库外。
    const root = await freshRepo('gitignore-symlink');
    const outsideDir = mkTmp('gitignore-outside');
    const outside = path.join(outsideDir, 'outside-ignore.txt');
    writeFileSync(outside, '# 仓库外,不得被追加\n');
    const gi = path.join(root, '.gitignore');
    rmSync(gi, { force: true });
    symlinkSync(outside, gi);
    const c = await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    ok(c.isError && /符号链接/.test(resultText(c)), 'L9-R08: .gitignore 为符号链接时 claim 拒绝写穿', resultText(c));
    ok(readFileSync(outside, 'utf8') === '# 仓库外,不得被追加\n', 'L9-R08: 仓库外 .gitignore 目标未被追加基线');
  }
  {
    // 复核项 R3:受管记录缺 baseSha 时不得放行零改动完成(伪 SHA 闸不能被绕过)。
    const root = await freshRepo('missing-basesha');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const regPath = path.join(root, '.relay', 'worktrees.json');
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    const rec = reg.worktrees.find((w) => w.task === 'T003');
    delete rec.baseSha;
    writeFileSync(regPath, `${JSON.stringify(reg, null, 2)}\n`);
    const exe = path.join(root, '.relay/worktrees/T003');
    const e = await dispatch('relay_session_end', { root: exe, model: 'model-A', summary: '缺 baseSha 零改动完成', done_task: 'T003' });
    ok(e.isError && /baseSha/.test(resultText(e)), 'L9-strict: 受管记录缺 baseSha 时零改动完成被拒', resultText(e));
    ok(/\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')), 'L9-strict: 缺 baseSha 拒绝后 TASKS 保持 [~]');
  }
  {
    // Lead 决策:严格根错配——空且干净的受管 worktree 也从 controlRoot 完成 → 一律拒绝。
    const root = await freshRepo('strict-root-mismatch');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    const executionRoot = path.join(root, '.relay/worktrees/T003');
    const lockRaw = readFileSync(path.join(root, '.relay/claims/T003.lock'), 'utf8');
    const lockParsed = JSON.parse(lockRaw);
    ok(lockParsed.version === 2 && lockParsed.holder === 'model-A', 'L9-R04: 认领锁同样迁移 JSON v2', lockRaw.slice(0, 120));
    const bad = await dispatch('relay_session_end', { root, model: 'model-A', summary: '空 worktree 单根完成', done_task: 'T003' });
    const rec = JSON.parse(readFileSync(path.join(root, '.relay/worktrees.json'), 'utf8')).worktrees.find((w) => w.task === 'T003');
    ok(bad.isError && /根错配/.test(resultText(bad)) && /executionRoot/.test(resultText(bad)),
      'L9-strict: 空且干净的受管 worktree 从 controlRoot 完成被拒(无兼容例外)', resultText(bad));
    ok(rec?.status === 'active' && /\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'))
      && existsSync(path.join(root, '.relay/claims/T003.lock')),
    'L9-strict: 拒绝后 TASKS 保持 [~]、认领锁与 active 注册记录均保留');

    // 正确路径:executionRoot 产生代码改动 → 双提交完成;TASKS/LOG/注册表原子写不留临时文件
    mkdirSync(path.join(executionRoot, 'src'), { recursive: true });
    writeFileSync(path.join(executionRoot, 'src', 'fix.js'), 'export const fix = 1;\n');
    const good = await dispatch('relay_session_end', { root: executionRoot, model: 'model-A', summary: '从 executionRoot 完成', done_task: 'T003' });
    ok(!good.isError && /\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')),
      'L9-strict: 从 executionRoot 正常完成(成对证据)', resultText(good));
    const leftovers = readdirSync(root).filter((n) => n.includes('.relay-tmp-'))
      .concat(readdirSync(path.join(root, '.relay')).filter((n) => n.includes('.relay-tmp-')));
    ok(leftovers.length === 0, 'L9-R04: TASKS/LOG/注册表原子写无临时文件残留', leftovers.join(','));
  }
  {
    // Lead 决策:registry 文件整体缺失 + 从 controlRoot 完成 → 用 git worktree list 反查受管痕迹并拒绝。
    const root = await freshRepo('registry-missing-controlroot');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    rmSync(path.join(root, '.relay', 'worktrees.json'));
    const bad = await dispatch('relay_session_end', { root, model: 'model-A', summary: '注册表丢失后想单根完成', done_task: 'T003' });
    ok(bad.isError && /根错配/.test(resultText(bad)) && /git worktree list/.test(resultText(bad)) && /重建登记/.test(resultText(bad)),
      'L9-strict: 注册表缺失时从 controlRoot 完成被 git worktree list 反查拒绝', resultText(bad));
    ok(/\[~\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8'))
      && existsSync(path.join(root, '.relay/claims/T003.lock')),
    'L9-strict: 注册表缺失拒绝后 TASKS 保持 [~]、认领锁保留');
  }
  {
    // Lead 决策:registry 文件合法但记录丢失 + 从 controlRoot 完成 → 仍拒绝(不因查不到记录就静默单根完成)。
    const root = await freshRepo('registry-record-lost');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A' });
    writeFileSync(path.join(root, '.relay/worktrees.json'), `${JSON.stringify({ version: 1, worktrees: [] }, null, 2)}\n`);
    const bad = await dispatch('relay_session_end', { root, model: 'model-A', summary: '记录丢失后单根完成', done_task: 'T003' });
    ok(bad.isError && /根错配/.test(resultText(bad)) && /受管 worktree 痕迹/.test(resultText(bad)),
      'L9-strict: 注册记录丢失时仍由 git worktree list 反查拒绝', resultText(bad));
  }
  {
    // 反向对照:单根 claim(worktree:false)从 controlRoot 完成不被严格根错配误伤。
    const root = await freshRepo('single-root-unaffected');
    await dispatch('relay_claim', { root, task: 'T003', model: 'model-A', worktree: false });
    const good = await dispatch('relay_session_end', { root, model: 'model-A', summary: '单根正常完成', done_task: 'T003' });
    ok(!good.isError && /\[x\] T003/.test(readFileSync(path.join(root, 'TASKS.md'), 'utf8')),
      'L9-strict: 单根(worktree:false)完成不受严格根错配影响', resultText(good));
    ok(!existsSync(path.join(root, '.relay/worktrees.json')), 'L9-strict: 单根完成不产生受管注册记录');
  }

} finally {
  console.log(`\n========== worktree 冒烟结果: ${pass} 通过 / ${fail} 失败 ==========`);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
