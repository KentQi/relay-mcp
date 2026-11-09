#!/usr/bin/env node
// v1.8.0 崩溃点矩阵:在协议写盘的每个点杀掉进程,断言重跑后状态收敛(幂等出场)。
// 写盘点 = writeProtocolFile 的第 1/2 次调用(TASKS、LOG);RELAY_CRASH_AT_WRITE=N 在
// 第 N+1 次写之前 exit(137)。崩溃后模拟人工清理残留锁,再正常跑一次出场,断言:
// TASKS 恰好一个 [x]、LOG 恰好一条完成条目、无半写、总提交数收敛。
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (tag) => {
  const d = mkdtempSync(path.join(tmpdir(), `relay-crash-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const run = (tool, args, env = {}) => spawnSync(process.execPath, [CLI, tool, '--json', JSON.stringify(args)], {
  encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env },
});
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

const addTask = (root, id, title, acceptance) => {
  const p = path.join(root, 'TASKS.md');
  const s = readFileSync(p, 'utf8').replace('## 待办', `## 待办\n- [ ] ${id} ${title}${acceptance ? `\n  验收: ${acceptance}` : ''}`);
  writeFileSync(p, s);
};

try {
  console.log('== 崩溃点矩阵:协议写盘中途被杀 → 重跑收敛 ==');
  const cases = [
    { tag: 'write0', env: { RELAY_CRASH_AT_WRITE: '0' }, desc: '第一次协议写之前' },
    { tag: 'write1', env: { RELAY_CRASH_AT_WRITE: '1' }, desc: 'TASKS 已写、LOG 未写' },
    { tag: 'precommit', env: { RELAY_CRASH_BEFORE_COMMIT: '1' }, desc: '两文件已写、提交未发生' },
  ];
  for (const c of cases) {
    const crashAt = c.tag;
    const root = mkTmp(`at${crashAt}`);
    const init = run('relay_init', { root, preset: 'minimal', name: `crash${crashAt}` });
    ok(init.status === 0, `[crash@${crashAt}] init 成功`, out(init).slice(0, 200));
    addTask(root, 'T901', '崩溃矩阵任务');
    const claim = run('relay_claim', { root, task: 'T901', model: 'crash-a', worktree: false });
    ok(claim.status === 0, `[crash@${crashAt}] 单根认领成功`, out(claim).slice(0, 200));

    const crashed = run('relay_session_end', { root, model: 'crash-a', summary: `崩溃点 ${crashAt}`, done_task: 'T901' }, c.env);
    ok(crashed.status !== 0, `[crash@${crashAt}] 进程在${c.desc}被杀(非零退出)`, `status=${crashed.status}`);

    // 模拟人工恢复:崩溃进程留下的仓库锁无法在 120s 内自证过期,移除后重跑(锁 TTL 另有专属用例)
    rmSync(path.join(root, '.relay', 'relay.lock'), { force: true });
    const recovered = run('relay_session_end', { root, model: 'crash-a', summary: `崩溃点 ${crashAt} 恢复`, done_task: 'T901' });
    ok(recovered.status === 0, `[crash@${crashAt}] 重跑出场成功(收敛)`, out(recovered).slice(0, 500));

    const tasks = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    ok((tasks.match(/^- \[x\] T901 /gm) || []).length === 1, `[crash@${crashAt}] TASKS 恰好一个 [x] T901`);
    const log = readFileSync(path.join(root, 'LOG.md'), 'utf8');
    ok((log.match(/task=T901 完成/g) || []).length === 1, `[crash@${crashAt}] LOG 恰好一条完成条目`);
    ok(git(root, 'rev-list', '--count', 'HEAD') === '2', `[crash@${crashAt}] 提交数收敛为 2(init + 一次出场)`, git(root, 'rev-list', '--count', 'HEAD'));

    const v = run('relay_verify', { root, full: true });
    ok(!/\| R9 \| ERROR \|/.test(out(v)) && !/\| R10 \| ERROR \|/.test(out(v)),
      `[crash@${crashAt}] 重跑后 R9/R10 无 ERROR`, out(v).slice(0, 500));
  }

  console.log('\n== 对照:不设置崩溃钩子时一次成功,不多写 ==');
  {
    const root = mkTmp('noop');
    run('relay_init', { root, preset: 'minimal', name: 'noop' });
    addTask(root, 'T902', '正常出场');
    run('relay_claim', { root, task: 'T902', model: 'crash-b', worktree: false });
    const once = run('relay_session_end', { root, model: 'crash-b', summary: '正常一次', done_task: 'T902' });
    ok(once.status === 0, '正常出场成功', out(once).slice(0, 300));
    ok(git(root, 'rev-list', '--count', 'HEAD') === '2', '正常出场只产生一个提交');
    const twice = run('relay_session_end', { root, model: 'crash-b', summary: '幂等重跑', done_task: 'T902' });
    ok(twice.status === 0 && git(root, 'rev-list', '--count', 'HEAD') === '2', '重复出场幂等(不重复提交)', out(twice).slice(0, 300));
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e?.stack || e}`);
} finally {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
