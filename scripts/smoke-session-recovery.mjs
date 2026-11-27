#!/usr/bin/env node
// session 可靠性行为回归:进程组超时、NODE_TEST_CONTEXT 清洗、manifest 单次读取、占位 next、managed 中断恢复。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { __runAcceptanceForTest } from '../src/engines/session.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src/cli.mjs');
const roots = [];
const mk = () => { const root = mkdtempSync(path.join(tmpdir(), 'relay-session-recovery-')); roots.push(root); return root; };
const run = (tool, args, env = {}, timeout = 180000) => spawnSync(process.execPath, [CLI, tool, '--root', args.root, '--json', JSON.stringify(args)], {
  encoding: 'utf8', timeout, env: { ...process.env, ...env },
});
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };
const addTask = (root, id, title) => {
  const p = path.join(root, 'TASKS.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('## 待办', `## 待办\n- [ ] ${id} ${title}\n  验收: npm test && ./verify`));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('== 验收子进程:超时杀整个进程组并等待 close ==');
  if (process.platform !== 'win32') {
    const root = mk();
    const sentinel = path.join(root, 'SURVIVED');
    const grandchild = path.join(root, 'grandchild.mjs');
    writeFileSync(grandchild, `import { writeFileSync } from 'node:fs';\nsetTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'bad'), 1200);\n`);
    const script = path.join(root, 'spawn-grandchild.mjs');
    writeFileSync(script, `import { spawn } from 'node:child_process';\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`);
    const started = Date.now();
    const r = await __runAcceptanceForTest.runCmd(process.execPath, [script], root, 180);
    assert.equal(r.ok, false);
    assert.match(r.out, /超时/);
    assert.ok(Date.now() - started < 5000, '等待 close 必须有界');
    await delay(1500);
    assert.equal(existsSync(sentinel), false, '孙进程不得在判红后继续写文件');
  }
  check('POSIX 孙进程超时后不能继续写文件', () => {});

  console.log('\n== NODE_TEST_CONTEXT 清洗与输出上限 ==');
  {
    const root = mk();
    const script = path.join(root, 'env-check.mjs');
    writeFileSync(script, `if (process.env.NODE_TEST_CONTEXT) process.exit(9); console.log('ENV-OK'); console.error('x'.repeat(8*1024*1024));\n`);
    const previous = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = 'child-v8-context';
    let r;
    try { r = await __runAcceptanceForTest.runCmd(process.execPath, [script], root, 5000); }
    finally { if (previous == null) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previous; }
    assert.equal(r.ok, true);
    assert.match(r.out, /ENV-OK/);
    assert.ok(Buffer.byteLength(r.out) <= 4 * 1024 * 1024 + 1, `输出必须有上限,实际 ${r.out.length}`);
  }
  check('runCmd 清洗 NODE_TEST_CONTEXT 且总输出有界', () => {});

  console.log('\n== session_end manifest 单次读取 + 损坏早退 ==');
  {
    const root = mk();
    assert.equal(run('relay_init', { root, name: 'manifest once', preset: 'minimal' }).status, 0);
    const trace = path.join(mk(), 'trace.json');
    const end = run('relay_session_end', { root, model: 'once', summary: '单次读取', done_task: 'T003' }, { RELAY_TRACE_FILE: trace });
    assert.equal(end.status, 0, out(end));
    const reads = JSON.parse(readFileSync(trace, 'utf8')).reads;
    assert.equal(reads['manifest.json'], 1);
    const mf = path.join(root, '.relay/manifest.json');
    const beforeTasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    writeFileSync(mf, '{ broken');
    const bad = run('relay_session_end', { root, model: 'once', summary: '损坏应早退' });
    assert.equal(bad.status, 1);
    assert.match(out(bad), /manifest 损坏/);
    assert.equal(readFileSync(path.join(root, 'TASKS.md'), 'utf8'), beforeTasks);
    const badVerify = run('relay_verify', { root, full: true }, { RELAY_TRACE_FILE: trace });
    assert.equal(badVerify.status, 1, out(badVerify));
    assert.match(out(badVerify), /R1.*manifest.*解析失败/);
    assert.equal(JSON.parse(readFileSync(trace, 'utf8')).reads['manifest.json'], 1);
    rmSync(mf);
    mkdirSync(mf);
    const badClaim = run('relay_claim', { root, model: 'once', task: 'T002', worktree: false });
    assert.equal(badClaim.status, 1, out(badClaim));
    assert.match(out(badClaim), /manifest\.json/);
    assert.equal(readFileSync(path.join(root, 'TASKS.md'), 'utf8'), beforeTasks);
  }
  check('session_end manifest 读 1 次且损坏不进入写盘', () => {});

  console.log('\n== next.title=无待办 不生成可认领占位任务 ==');
  {
    const root = mk();
    assert.equal(run('relay_init', { root, name: 'empty next', preset: 'minimal' }).status, 0);
    const end = run('relay_session_end', { root, model: 'empty', summary: '空队列', next: { title: '无待办 — 等人类定义', acceptance: 'npm test && ./verify', notes: '等待新任务' } });
    assert.equal(end.status, 0, out(end));
    const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    assert.doesNotMatch(tasks, /^- \[ \] T\d+ 无待办/m);
    assert.match(tasks, /relay:maintenance-next: 等待新任务/);
    const start = run('relay_session_start', { root });
    assert.equal(start.status, 0, out(start));
    assert.doesNotMatch(out(start), /T\d+ 无待办/);
    assert.doesNotMatch(out(start), /T070/);
    assert.match(out(start), /T002 用户表迁移/, '模板真实任务保留');
  }
  check('无待办 next 仅写维护注释,简报不指定队首', () => {});

  console.log('\n== 批量出场复用项目测试与可配置超时 ==');
  {
    const root = mk();
    const init = run('relay_init', { root, name: 'acceptance limits', preset: 'minimal' });
    assert.equal(init.status, 0, out(init));
    addTask(root, 'T904', '批量测试一');
    addTask(root, 'T905', '批量测试二');
    const pkg = path.join(root, 'package.json');
    const mf = path.join(root, '.relay', 'manifest.json');
    const manifest = JSON.parse(readFileSync(mf, 'utf8'));
    writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 1500)"' } }));
    writeFileSync(mf, JSON.stringify({ ...manifest, acceptance: { timeoutMs: 200 } }));
    const timedOut = run('relay_session_end', { root, model: 'run-once', summary: '验收时限', done_task: 'T904', done_tasks: ['T905'] });
    assert.equal(timedOut.status, 1, out(timedOut));
    assert.match(out(timedOut), /npm test.*超时\(0\.2s\)/);
    assert.doesNotMatch(readFileSync(path.join(root, 'TASKS.md'), 'utf8'), /^- \[x\] T90[45] /m);
    writeFileSync(mf, JSON.stringify(manifest));
    writeFileSync(pkg, JSON.stringify({ scripts: { test: `node -e "require('node:fs').appendFileSync('.relay/test-count', '1')"` } }));
    const batch = run('relay_session_end', { root, model: 'run-once', summary: '批量验收', done_task: 'T904', done_tasks: ['T905'] });
    assert.equal(batch.status, 0, out(batch));
    assert.equal(readFileSync(path.join(root, '.relay', 'test-count'), 'utf8'), '1');
    assert.equal((readFileSync(path.join(root, 'LOG.md'), 'utf8').match(/task=T90[45] 完成/g) || []).length, 2);
  }
  check('验收超时报告准确,批量完成只运行一次 npm test', () => {});

  console.log('\n== managed 代码提交后的写盘中断 → 同一任务可接管补交 ==');
  {
    const control = mk();
    assert.equal(run('relay_init', { root: control, name: 'managed recovery', preset: 'minimal' }).status, 0);
    addTask(control, 'T903', '受管恢复');
    const claim = run('relay_claim', { root: control, task: 'T903', model: 'managed-a', worktree: true, ttl_minutes: 1 });
    assert.equal(claim.status, 0, out(claim));
    const execution = path.join(control, '.relay/worktrees/T903');
    assert.ok(existsSync(execution), 'managed worktree 已创建');
    writeFileSync(path.join(execution, 'README.md'), 'durable\n');
    const baseSha = git(execution, 'rev-parse', 'HEAD');
    const crashed = run('relay_session_end', { root: execution, model: 'managed-a', summary: '中断恢复', done_task: 'T903' },
      { RELAY_TEST_HOOKS: '1', RELAY_CRASH_AT_WRITE: '1' });
    assert.equal(crashed.status, 137, out(crashed));
    const codeSha = git(execution, 'rev-parse', 'HEAD');
    assert.notEqual(codeSha, baseSha, '首次 managed 代码提交已落账');
    const tasksPath = path.join(control, 'TASKS.md');
    const logPath = path.join(control, 'LOG.md');
    assert.match(readFileSync(tasksPath, 'utf8'), /^- \[x\] T903 /m);
    assert.doesNotMatch(readFileSync(logPath, 'utf8'), /task=T903 完成/);
    rmSync(path.join(control, '.relay/relay.lock'), { force: true });
    const claimPath = path.join(control, '.relay', 'claims', 'T903.lock');
    const whileHeld = run('relay_claim', { root: control, task: 'T903', model: 'managed-b', worktree: true });
    assert.equal(whileHeld.status, 1, out(whileHeld));
    const lock = JSON.parse(readFileSync(claimPath, 'utf8'));
    writeFileSync(claimPath, JSON.stringify({ ...lock, acquiredAt: new Date(Date.now() - 120000).toISOString() }));
    const wrongRoot = run('relay_claim', { root: control, task: 'T903', model: 'managed-b', worktree: false });
    assert.equal(wrongRoot.status, 1, out(wrongRoot));
    const tookOver = run('relay_claim', { root: control, task: 'T903', model: 'managed-b', worktree: true });
    assert.equal(tookOver.status, 0, out(tookOver));
    const recovered = run('relay_session_end', { root: execution, model: 'managed-b', summary: '中断恢复', done_task: 'T903' });
    assert.equal(recovered.status, 0, out(recovered));
    assert.equal(git(execution, 'rev-parse', 'HEAD'), codeSha, '幂等恢复不得重复代码提交');
    const tasks = readFileSync(path.join(control, 'TASKS.md'), 'utf8');
    assert.equal((tasks.match(/^- \[x\] T903 /gm) || []).length, 1);
    const log = readFileSync(path.join(control, 'LOG.md'), 'utf8');
    assert.equal((log.match(/task=T903 完成/g) || []).length, 1);
    const registry = JSON.parse(readFileSync(path.join(control, '.relay/worktrees.json'), 'utf8'));
    const record = registry.worktrees.find((w) => w.task === 'T903');
    assert.equal(record.status, 'completed');
    assert.equal(record.controlCommitted, true);
    assert.equal(existsSync(path.join(control, '.relay/claims/T903.lock')), false);
    const again = run('relay_session_end', { root: execution, model: 'managed-b', summary: '幂等恢复', done_task: 'T903' });
    assert.equal(again.status, 0, out(again));
    assert.equal((readFileSync(path.join(control, 'LOG.md'), 'utf8').match(/task=T903 完成/g) || []).length, 1);
    const passer = () => (run('relay_verify', { root: execution, full: true }).stdout || '').split('\n').find((line) => line.startsWith('| R10 |'));
    assert.match(passer(), /R10 \| PASS/);
    writeFileSync(path.join(execution, 'README.md'), 'follow-up\n');
    git(execution, 'add', '--', 'README.md');
    git(execution, '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', '分支继续开发');
    assert.notEqual(git(execution, 'rev-parse', 'HEAD'), codeSha);
    assert.match(passer(), /R10 \| PASS/);
    const replay = run('relay_session_end', { root: execution, model: 'managed-b', summary: '重跑已经提交的出场', done_task: 'T903' });
    assert.equal(replay.status, 0, out(replay));
    assert.match(out(replay), new RegExp(`codeSha=${codeSha}`));
    assert.equal(readFileSync(logPath, 'utf8'), log);
  }
  check('managed 代码提交后异常恢复幂等,不重复代码提交', () => {});

  if (process.platform !== 'win32') {
    console.log('\n== Git 拒绝提交 → 认领保留且重跑补交 ==');
    const root = mk();
    const init = run('relay_init', { root, name: 'git failure', preset: 'minimal' });
    assert.equal(init.status, 0, out(init));
    const args = { root, model: 'retry-git', done_task: 'T003', summary: 'Git 拒绝提交时保留认领' };
    assert.equal(run('relay_claim', { root, task: 'T003', model: args.model, worktree: false }).status, 0);
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    git(root, 'config', 'core.hooksPath', '.git/hooks');
    writeFileSync(hook, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const before = git(root, 'rev-parse', 'HEAD');
    const r = run('relay_session_end', args);
    assert.equal(r.status, 1, out(r));
    assert.match(out(r), /提交失败.*待补交/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
    const claimFile = path.join(root, '.relay', 'claims', 'T003.lock');
    assert.ok(existsSync(claimFile));
    rmSync(hook);
    const retry = run('relay_session_end', args);
    assert.equal(retry.status, 0, out(retry));
    assert.notEqual(git(root, 'rev-parse', 'HEAD'), before);
    assert.equal(existsSync(claimFile), false);
    check('Git 提交失败返回错误并保留认领，补交后释放', () => {});
  }
  console.log(`\n结果: ${pass} 通过 / 0 失败`);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
