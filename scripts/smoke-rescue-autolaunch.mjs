#!/usr/bin/env node
// T051 冒烟:manifest 声明的通用自动拉起(argv,不经 shell,不绑定任何 harness)。
//
// 红线:
//   1) 默认关闭:未配置 autoLaunch 时 takeover 只生成接力单,不启动任何进程;
//   2) 配置 {enabled:true, command:[...]} 后,takeover 自动启动**独立后台 worker**;
//   3) command 是 argv 数组,不经 shell;prompt 里的 `; touch ...` 不会被当命令执行;
//   4) worker 把子进程输出写入 .relay/rescue/<id>/dispatch.log,退出状态写 dispatch.json;
//   5) 同一 model 重复 takeover 不重复启动;report/drop 在 dispatch running 时被拒;
//   6) 超时/输出超限会终止子进程并写明确状态;
//   7) 配置非法(非数组/NUL/危险 cwd)在启动前拒绝,不留半写;
//   8) 核心仍零 harness 专有名。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 600) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (tag) => {
  const d = mkdtempSync(path.join(tmpdir(), `relay-launch-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const cli = (root, tool, args = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], {
  encoding: 'utf8', timeout: 120000,
});
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const fresh = (tag) => {
  const d = mkTmp(tag);
  const r = cli(d, 'relay_init', { name: `launch ${tag}` });
  if (r.status !== 0) throw new Error(`relay_init 失败:${out(r).slice(0, 600)}`);
  return d;
};
const idsOf = (root) => {
  const d = path.join(root, '.relay', 'rescue');
  return existsSync(d) ? readdirSync(d).filter((x) => !x.startsWith('.')).sort() : [];
};
import { readdirSync } from 'node:fs';
const cardDir = (root, id) => path.join(root, '.relay', 'rescue', id);
const readDispatch = (root, id) => {
  const p = path.join(cardDir(root, id), 'dispatch.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const waitDispatch = async (root, id, status, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = readDispatch(root, id);
    if (d && d.status === status) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readDispatch(root, id);
};
const setAutoLaunch = (root, autoLaunch) => {
  const p = path.join(root, '.relay', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.rescue = { ...(m.rescue || {}), autoLaunch };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
};
const makeSource = (root, sourceRoot, agentId = 'launch-agent') => {
  const d = path.join(sourceRoot, 'parent', `agent-${agentId}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'metadata.json'), JSON.stringify({
    agentId, cwd: root, workspaceRoot: root, prompt: '完成被中断的任务', status: 'failed',
    error: '[1308][已达到 5 小时的使用上限。]', parentSessionId: 'parent',
    createdAt: '2026-11-26T01:00:00.000Z', updatedAt: '2026-11-26T01:00:10.000Z',
  }));
  const mp = path.join(root, '.relay', 'manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.rescue = {
    ...(m.rescue || {}),
    sources: [{ profile: 'launch-meta', root: sourceRoot }],
    profiles: [{ id: 'launch-meta', kind: 'json-metadata', metaFile: 'metadata.json' }],
  };
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
};

const workerScript = path.join(mkTmp('worker'), 'worker.mjs');
writeFileSync(workerScript, `
import { writeFileSync } from 'node:fs';
const [prompt, marker] = process.argv.slice(2);
writeFileSync(marker, prompt);
process.stdout.write('LAUNCHED:' + prompt);
`);

try {
  console.log('== 1. 默认关闭 ==');
  {
    const repo = fresh('off');
    const src = mkTmp('src');
    makeSource(repo, src);
    const tk = cli(repo, 'relay_rescue', { action: 'takeover', id: 'launch-agent', model: 'taker-off', confirm: true });
    // takeover 需要先 capture;这里先 capture 再 takeover
    const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    ok(cap.status === 0, 'capture 成功', out(cap).slice(0, 300));
    const id = idsOf(repo)[0];
    const tk2 = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-off', confirm: true });
    ok(tk2.status === 0, '默认配置下 takeover 成功', out(tk2).slice(0, 300));
    ok(!existsSync(path.join(cardDir(repo, id), 'dispatch.json')), '默认不启动后台 worker');
    ok(!/自动拉起|dispatch/i.test(out(tk2)), '输出明确未配置自动拉起(或静默跳过)');
    void tk;
  }

  console.log('\n== 2. argv 自动拉起 + 占位符 + 不经 shell ==');
  {
    const repo = fresh('on');
    const src = mkTmp('src');
    makeSource(repo, src);
    const marker = path.join(mkTmp('marker'), 'prompt.txt');
    const injected = '完成被中断的任务; touch /tmp/relay-launch-should-not-exist';
    // 改元数据 prompt 注入串
    const metaPath = path.join(src, 'parent', 'agent-launch-agent', 'metadata.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.prompt = injected;
    writeFileSync(metaPath, JSON.stringify(meta));
    setAutoLaunch(repo, {
      enabled: true,
      command: [process.execPath, workerScript, '{{prompt}}', marker],
      timeoutMs: 10000,
      maxOutputBytes: 65536,
    });
    const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    ok(cap.status === 0, 'capture 成功', out(cap).slice(0, 300));
    const id = idsOf(repo)[0];
    const tk = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-on', confirm: true });
    ok(tk.status === 0, 'takeover 自动拉起成功', out(tk).slice(0, 500));
    ok(/自动拉起|dispatch|后台/i.test(out(tk)), 'takeover 输出报告自动拉起状态', out(tk).slice(0, 500));
    const done = await waitDispatch(repo, id, 'completed');
    ok(done && done.status === 'completed', 'worker 完成并写 dispatch.json', JSON.stringify(done));
    ok(done && done.exitCode === 0, '记录子进程 exitCode=0', JSON.stringify(done));
    ok(existsSync(marker), '子进程收到 prompt 参数');
    ok(existsSync(marker) && readFileSync(marker, 'utf8') === injected, 'prompt 原样传递(含 shell 元字符)');
    ok(!existsSync('/tmp/relay-launch-should-not-exist'), 'shell 元字符未被执行(不经 shell)');
    const log = readFileSync(path.join(cardDir(repo, id), 'dispatch.log'), 'utf8');
    ok(log.includes('LAUNCHED:'), '子进程 stdout 写入 dispatch.log', log.slice(0, 200));
    const shown = out(cli(repo, 'relay_rescue', { id }, {}));
    ok(/dispatch|自动拉起|completed/i.test(shown), 'show 展示自动拉起状态', shown.slice(0, 500));

    // 同 model 再次 takeover:不重复启动
    const before = statSync(path.join(cardDir(repo, id), 'dispatch.json')).mtimeMs;
    const again = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-on', confirm: true });
    const after = statSync(path.join(cardDir(repo, id), 'dispatch.json')).mtimeMs;
    ok(again.status === 0 && before === after, '同 model 重复 takeover 不重复启动', out(again).slice(0, 300));
  }

  console.log('\n== 3. 运行中 report/drop 被拒 + 失败状态 ==');
  {
    const repo = fresh('running');
    const src = mkTmp('src');
    makeSource(repo, src);
    setAutoLaunch(repo, {
      enabled: true,
      command: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'],
      timeoutMs: 30000,
      maxOutputBytes: 65536,
    });
    cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    const id = idsOf(repo)[0];
    const tk = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'runner', confirm: true });
    ok(tk.status === 0, '长任务自动拉起成功', out(tk).slice(0, 300));
    // 等 worker 写 running
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (!readDispatch(repo, id) || readDispatch(repo, id).status !== 'running')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    ok(readDispatch(repo, id)?.status === 'running', 'dispatch.json 进入 running', JSON.stringify(readDispatch(repo, id)));
    const rep = cli(repo, 'relay_rescue', { action: 'report', id, model: 'runner', summary: 'too early', confirm: true });
    ok(rep.status === 1 && /运行|running|完成/.test(out(rep)), 'dispatch running 时 report 被拒', out(rep).slice(0, 400));
    const drop = cli(repo, 'relay_rescue', { action: 'drop', id, model: 'runner', confirm: true });
    ok(drop.status === 1 && /运行|running|完成/.test(out(drop)), 'dispatch running 时 drop 被拒', out(drop).slice(0, 400));
    // 用 worker 的 pid 结束它,模拟外部取消
    const d = readDispatch(repo, id);
    if (d && d.pid) {
      try { process.kill(d.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    const final = await waitDispatch(repo, id, 'failed', 10000);
    ok(final && final.status === 'failed', '子进程被终止后写 failed 状态', JSON.stringify(final));
  }

  console.log('\n== 4. 超时 ==');
  {
    const repo = fresh('timeout');
    const src = mkTmp('src');
    makeSource(repo, src);
    setAutoLaunch(repo, {
      enabled: true,
      command: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'],
      timeoutMs: 300,
      maxOutputBytes: 65536,
    });
    cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    const id = idsOf(repo)[0];
    cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'timeout-taker', confirm: true });
    const d = await waitDispatch(repo, id, 'timed_out', 10000);
    ok(d && d.status === 'timed_out', '超时写 timed_out', JSON.stringify(d));
    ok(d && /timeout|超时/i.test(d.error || ''), '超时状态带明确原因', JSON.stringify(d));
  }

  console.log('\n== 5. 非法配置 fail-closed ==');
  {
    const repo = fresh('bad');
    const src = mkTmp('src');
    makeSource(repo, src);
    setAutoLaunch(repo, { enabled: true, command: 'node worker.mjs' });
    cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    const id = idsOf(repo)[0];
    const r = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'bad-taker', confirm: true });
    ok(r.status === 1 && /command|argv|数组/.test(out(r)), 'command 非数组被拒', out(r).slice(0, 400));
    ok(!existsSync(path.join(cardDir(repo, id), 'dispatch.json')), '非法配置不启动 worker');
  }
  {
    const repo = fresh('badcwd');
    const src = mkTmp('src');
    makeSource(repo, src);
    setAutoLaunch(repo, { enabled: true, command: [process.execPath, '-e', ''], cwd: '/tmp' });
    cli(repo, 'relay_rescue', { action: 'capture', id: 'launch-agent', confirm: true });
    const id = idsOf(repo)[0];
    const r = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'badcwd-taker', confirm: true });
    ok(r.status === 1 && /cwd|目录|仓库/.test(out(r)), 'cwd 逃出仓库被拒', out(r).slice(0, 400));
  }

  console.log('\n== 6. 架构:核心零 harness ==');
  {
    const core = readFileSync(path.join(RELAY, 'src', 'engines', 'rescue.mjs'), 'utf8');
    const hits = core.split('\n').filter((l) => /zcode|claude|codex|gemini|cursor|opencode|kimi|deepseek|glm/i.test(l));
    ok(hits.length === 0, '自动拉起未在核心引入 harness 名', hits.slice(0, 2).join(' | '));
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
} finally {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
}
console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
