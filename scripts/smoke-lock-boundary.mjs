#!/usr/bin/env node
// 锁边界行为回归:EACCES 有界失败、认领锁 acquiredAt 单真相源、mtime 心跳不被破坏、占位任务不可认领。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, utimesSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireFileLock, claimLockExpiry, releaseFileLock, sha256Hex, writeFileAtomic } from '../src/util.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src/cli.mjs');
const roots = [];
const mk = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-lock-boundary-'));
  mkdirSync(path.join(root, '.relay', 'claims'), { recursive: true });
  roots.push(root);
  return root;
};
const run = (tool, args, env = {}) => spawnSync(process.execPath, [CLI, tool, '--root', args.root, '--json', JSON.stringify(args)], {
  encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env },
});
let pass = 0;
let failures = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitForFile = async (file, timeoutMs = 2000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(file)) return true;
    await sleep(10);
  }
  return existsSync(file);
};

try {
  console.log('== acquiredAt 精确毫秒与 TTL 覆盖 ==');
  const now = Date.parse('2026-11-27T00:00:00.000Z');
  check('边界前 1ms 不 expired,边界后 1ms expired', () => {
    const base = { token: 't', acquiredAt: new Date(now - 240 * 60000).toISOString() };
    assert.equal(claimLockExpiry(base, { now: now - 1 }).expired, false);
    assert.equal(claimLockExpiry(base, { now: now + 1 }).expired, true);
    assert.equal(claimLockExpiry({ ...base, ttlMinutes: 1 }, { now: now }).ttlSource, 'lock');
    assert.equal(claimLockExpiry(base, { now }).ttlSource, 'default');
  });
  check('缺 token/acquiredAt fail-closed,不接管', () => {
    assert.deepEqual(claimLockExpiry({ acquiredAt: new Date(0).toISOString() }, { now }).expired, false);
    assert.equal(claimLockExpiry({ token: 't', acquiredAt: 'bad' }, { now }).expired, false);
  });

  console.log('\n== heartbeat:false 双向 mtime/acquiredAt 背离 ==');
  {
    const root = mk();
    const rel = '.relay/claims/T901.lock';
    const acquiredAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(path.join(root, '.relay/claims/T901.lock'), JSON.stringify({ version: 2, holder: 'fresh', token: 'a', acquiredAt }) + '\n');
    const old = new Date(Date.now() - 241 * 60000);
    utimesSync(path.join(root, rel), old, old);
    const lock = await acquireFileLock(root, rel, 'contender', { heartbeat: false, staleMs: 240 * 60000, ttlMinutes: 240 });
    assert.equal(lock.ok, false);
    assert.equal(lock.holder, 'fresh');
  }
  check('acquiredAt 新 + mtime 旧 → 不接管', () => {});
  {
    const root = mk();
    const rel = '.relay/claims/T902.lock';
    writeFileSync(path.join(root, rel), JSON.stringify({ version: 2, holder: 'old', token: 'b', acquiredAt: new Date(Date.now() - 241 * 60000).toISOString() }) + '\n');
    const lock = await acquireFileLock(root, rel, 'contender', { heartbeat: false, staleMs: 240 * 60000 });
    assert.equal(lock.ok, true);
    assert.equal(lock.tookOver, 'old');
    await lock.release();
  }
  check('acquiredAt 旧 + mtime 新 → 可接管', () => {});

  console.log('\n== 仓库写锁仍按 mtime 心跳 ==');
  {
    const root = mk();
    const rel = '.relay/relay.lock';
    writeFileSync(path.join(root, rel), JSON.stringify({ version: 2, holder: 'live', token: 'c', acquiredAt: new Date(Date.now() - 241 * 60000).toISOString() }) + '\n');
    const fresh = new Date();
    utimesSync(path.join(root, rel), fresh, fresh);
    const lock = await acquireFileLock(root, rel, 'contender', { heartbeat: true, waitMs: 0 });
    assert.equal(lock.ok, false);
    assert.equal(lock.holder, 'live');
  }
  check('仓库锁 acquiredAt 旧但 mtime 新 → 不接管', () => {});

  console.log('\n== 不可读锁有界失败 ==');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const root = mk();
    const rel = '.relay/relay.lock';
    writeFileSync(path.join(root, rel), JSON.stringify({ version: 2, holder: 'x', token: 'x', acquiredAt: new Date().toISOString() }) + '\n');
    chmodSync(path.join(root, rel), 0);
    await assert.rejects(acquireFileLock(root, rel, 'x', { waitMs: 300 }), (e) => e.code === 'EACCES');
    chmodSync(path.join(root, rel), 0o600);
  }
  check('EACCES 直接拒绝,不无限 continue', () => {});

  console.log('\n== 内容 CAS 发布前复核 ==');
  {
    const root = mk();
    const target = path.join(root, 'TASKS.md');
    writeFileSync(target, 'expected\n');
    await assert.rejects(
      writeFileAtomic(target, 'replacement\n', {
        expectedHash: sha256Hex('expected\n'),
        fencing: async () => {
          writeFileSync(target, 'intruder\n');
          return { ok: true };
        },
      }),
      (e) => e?.code === 'RELAY_CONFLICT',
    );
    assert.equal(readFileSync(target, 'utf8'), 'intruder\n');
  }
  check('fencing 期间外部改文件 → rename 前拒绝且保留对方内容', () => {});

  console.log('\n== 锁释放的内容/身份 CAS ==');
  {
    const root = mk();
    const rel = '.relay/claims/T903.lock';
    const target = path.join(root, rel);
    const lock = await acquireFileLock(root, rel, 'owner', { heartbeat: false });
    const signal = path.join(root, 'release-read.signal');
    const go = path.join(root, 'release-read.go');
    process.env.RELAY_TEST_HOOKS = '1';
    process.env.RELAY_TEST_RELEASE_LOCK_SIGNAL = signal;
    process.env.RELAY_TEST_RELEASE_LOCK_GO = go;
    let signalled = false;
    try {
      const pending = releaseFileLock(root, rel, lock.token, '任务锁');
      signalled = await waitForFile(signal);
      writeFileSync(target, JSON.stringify({
        version: 2,
        holder: 'replacement',
        token: 'replacement-token',
        acquiredAt: new Date().toISOString(),
      }) + '\n');
      writeFileSync(go, 'go\n');
      const verdict = await pending;
      assert.equal(signalled, true, '释放流程必须提供第二次身份复核屏障');
      assert.equal(verdict.ok, false, 'token 所有权在屏障后变化时释放必须失败');
      assert.equal(JSON.parse(readFileSync(target, 'utf8')).token, 'replacement-token', '替换持有者的锁不得被删');
      pass++;
      console.log('  ✓ 第二次复核屏障后替换锁 → 不误删 replacement holder');
    } catch (error) {
      failures++;
      console.log(`  ✗ FAIL 第二次复核屏障后替换锁 — ${error?.message || error}`);
    } finally {
      delete process.env.RELAY_TEST_HOOKS;
      delete process.env.RELAY_TEST_RELEASE_LOCK_SIGNAL;
      delete process.env.RELAY_TEST_RELEASE_LOCK_GO;
    }
  }

  console.log('\n== 无待办占位行不可认领 ==');
  {
    const root = mk();
    assert.equal(run('relay_init', { root, name: 'lock fixture', preset: 'minimal' }).status, 0);
    const tasks = path.join(root, 'TASKS.md');
    const text = readFileSync(tasks, 'utf8').replace('## 待办', '## 待办\n- [ ] T070 无待办 — 新工作需先与人类定义任务\n  验收: npm test && ./verify');
    writeFileSync(tasks, text);
    const claim = run('relay_claim', { root, task: 'T070', model: 'boundary', worktree: false });
    assert.equal(claim.status, 1);
    assert.match(`${claim.stdout}${claim.stderr}`, /不是可认领任务/);
    assert.equal(existsSync(path.join(root, '.relay/claims/T070.lock')), false);
  }
  check('claim 拒绝占位行且不创建认领锁', () => {});
  console.log(`\n结果: ${pass} 通过 / ${failures} 失败`);
  if (failures) process.exitCode = 1;
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
