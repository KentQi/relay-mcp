#!/usr/bin/env node
// relay-mcp 端到端冒烟测试:真实 stdio MCP 客户端,走完整生命周期。
// 场景 A: 0→1 init → session_start → claim → session_end → verify → sync(+漂移)
// 场景 B: 老项目 onboard → session_start → verify
// 场景 C: 绿闸负向(制造 R4 违规 → session_end 必须拒绝且不提交)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proc = spawn('node', ['src/index.mjs'], { cwd: RELAY, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', d => process.stderr.write(`[srv] ${d}`));

let nextId = 1;
const pending = new Map();
proc.stdout.on('data', chunk => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 非协议行即失败 */ }
  }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 30000);
});
const tool = async (name, args = {}) => {
  const r = await call('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? '';
  return { isError: !!r.result?.isError, text };
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); } };

const tmpA = mkdtempSync(path.join(tmpdir(), 'relay-a-'));
const tmpB = mkdtempSync(path.join(tmpdir(), 'relay-b-'));
const gitSafe = (dir, ...a) => spawnSync2('git', ['-C', dir, ...a]);

import { spawnSync } from 'node:child_process';
function spawnSync2(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf8' }); }

try {
  // ---------- 握手 ----------
  const init = await call('initialize', { protocolVersion: '2025-06-18' });
  ok(init.result?.serverInfo?.name === 'relay-mcp', 'initialize 握手');
  const tools = await call('tools/list');
  const names = (tools.result?.tools ?? []).map(t => t.name);
  ok(names.length === 9, 'tools/list = 9 个工具', `got ${names.length}`);

  // ---------- 场景 A: 0→1 ----------
  console.log('\n== 场景 A: relay_init (0→1) ==');
  const r1 = await tool('relay_init', { root: tmpA, name: '演示项目' });
  ok(!r1.isError, 'relay_init 成功', r1.text.slice(0, 200));
  for (const f of ['START.md', 'SPEC.md', 'DECISIONS.md', 'TASKS.md', 'LOG.md', 'verify',
    'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.relay/manifest.json',
    '.github/workflows/workflow-relay.yml', 'docs/README.md', 'docs/01-sow/README.md'])
    ok(existsSync(path.join(tmpA, f)), `文件存在: ${f}`);
  ok(!readFileSync(path.join(tmpA, 'TASKS.md'), 'utf8').includes('{{'), '占位符已全部替换');
  for (const f of ['package.json', 'src/index.js', 'tests/smoke.test.js', '.gitignore', '.editorconfig'])
    ok(existsSync(path.join(tmpA, f)), `preset 文件存在: ${f}`);
  ok(readFileSync(path.join(tmpA, 'package.json'), 'utf8').includes('"name"'), 'package.json 已生成(中文项目名转 slug)');
  const tst = spawnSync('node', ['--test'], { cwd: tmpA, encoding: 'utf8' });
  ok(tst.status === 0, 'preset 骨架测试交付即全绿(node --test)', (tst.stdout || tst.stderr || '').slice(-200));
  const mfA = JSON.parse(readFileSync(path.join(tmpA, '.relay/manifest.json'), 'utf8'));
  ok(mfA.preset === 'node', 'manifest 记录 preset=node');
  const giA = readFileSync(path.join(tmpA, '.gitignore'), 'utf8');
  ok(giA.includes('.relay/claims/') && giA.includes('.env') && giA.includes('*.pem'), 'H3: gitignore 基线(密钥/认领锁/私钥)');
  const stTxt = readFileSync(path.join(tmpA, 'START.md'), 'utf8');
  ok(!stTxt.includes('./verify.sh'), 'H2: START 不再引用不存在的 verify.sh');
  const vrun = spawnSync('./verify', [], { cwd: tmpA, encoding: 'utf8' });
  ok(vrun.status === 0, 'H2: ./verify 引导命令一键可用', (vrun.stderr || vrun.stdout || '').slice(0, 200));
  const gl = gitSafe(tmpA, 'log', '--oneline');
  ok(gl.status === 0 && gl.stdout.includes('relay: init'), 'git 初始提交存在');

  console.log('\n== A2: session_start / claim ==');
  const rs = await tool('relay_session_start', { root: tmpA });
  ok(!rs.isError && (rs.text.includes('接力简报') || rs.text.includes('简报')), 'session_start 出简报', rs.text.slice(0, 300));
  const rc = await tool('relay_claim', { root: tmpA, task: 'T004', model: 'smoke-model' });
  ok(!rc.isError, 'relay_claim T004');
  ok(readFileSync(path.join(tmpA, 'TASKS.md'), 'utf8').includes('smoke-model'), '认领者写入 TASKS');
  const lockP = path.join(tmpA, '.relay/claims/T004.lock');
  ok(existsSync(lockP), 'M3: 认领锁文件已创建');
  const rcB = await tool('relay_claim', { root: tmpA, task: 'T004', model: 'intruder-model' });
  ok(rcB.isError && rcB.text.includes('smoke-model'), 'M3: 认领锁拒绝第二模型抢占', rcB.text.slice(0, 200));

  console.log('\n== A3: session_end(绿闸→提交) ==');
  const re = await tool('relay_session_end', {
    root: tmpA, model: 'smoke-model', summary: '完成支付回调对接与联调',
    done_task: 'T004',
    next: { title: '编写对账脚本', acceptance: 'test:tests/recon.test.js', notes: '签名见 SPEC.md' },
    negative_results: ['内存会话方案不可行,改用 jwt']
  });
  ok(!re.isError, 'session_end 成功', re.text.slice(0, 400));
  ok(re.text.includes('npm test'), 'H1: 出场简报含验收执行结果(npm test)', re.text.slice(0, 600));
  ok(!existsSync(lockP), 'M3: 出场后认领锁已释放');
  const tk = readFileSync(path.join(tmpA, 'TASKS.md'), 'utf8');
  ok(/\[x\] T004/.test(tk), 'T004 已标完成');
  ok(tk.includes('T005'), 'next 任务 T005 已插入');
  const lg = readFileSync(path.join(tmpA, 'LOG.md'), 'utf8');
  ok(lg.includes('model=smoke-model') && lg.includes('负结果:'), 'LOG 条目含 model 与负结果');
  const gl2 = gitSafe(tmpA, 'log', '--oneline');
  ok(gl2.stdout.includes('session end'), 'session end 提交存在');
  ok(gitSafe(tmpA, 'log', '--grep', 'T004 完成', '--oneline').stdout.trim().length > 0, 'N2: 完成提交可 git log --grep 反查(完成行不记悬挂 sha)');

  console.log('\n== A4: verify 全量 + sync 漂移 ==');
  const rv = await tool('relay_verify', { root: tmpA, full: true });
  ok(!rv.isError, 'relay_verify(full) 全绿', rv.text.slice(0, 500));
  const sy1 = await tool('relay_sync', { root: tmpA });
  ok(!sy1.isError && sy1.text.includes('无漂移') && !/\| 重写/.test(sy1.text), 'sync: 无漂移', sy1.text.slice(0, 300));
  appendFileSync(path.join(tmpA, 'AGENTS.md'), '\n人为篡改\n');
  const sy2 = await tool('relay_sync', { root: tmpA });
  ok(!sy2.isError, 'sync: 篡改后重写');
  ok(!readFileSync(path.join(tmpA, 'AGENTS.md'), 'utf8').includes('人为篡改'), '篡改被清除');

  // ---------- 场景 B: onboard ----------
  console.log('\n== 场景 B: relay_onboard (老项目) ==');
  writeFileSync(path.join(tmpB, 'README.md'), '# legacy\n');
  writeFileSync(path.join(tmpB, 'package.json'), JSON.stringify({ name: 'legacy', scripts: { test: 'node --test' } }, null, 2));
  const srcDir = path.join(tmpB, 'src'); mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'app.js'), 'console.log("legacy")\n');
  // 制造"历史遗留"散乱结构:lib/ test/ tools/ + 根目录散文件
  for (const [d, f] of [['lib', 'helper.js'], ['test', 'old.test.js'], ['tools', 'x.js']]) {
    mkdirSync(path.join(tmpB, d));
    writeFileSync(path.join(tmpB, d, f), d === 'lib' ? 'export const h = 1\n' : '');
  }
  writeFileSync(path.join(tmpB, 'app2.js'), 'export const a = 2\n');
  writeFileSync(path.join(tmpB, 'AGENTS.md'), '# 我们团队的老规范\n不许用 var。\n');
  gitSafe(tmpB, 'init'); gitSafe(tmpB, 'add', '-A');
  gitSafe(tmpB, '-c', 'user.name=legacy', '-c', 'user.email=l@x', 'commit', '-m', 'legacy: first');
  const ro = await tool('relay_onboard', { root: tmpB });
  ok(!ro.isError, 'relay_onboard 成功', ro.text.slice(0, 400));
  ok(existsSync(path.join(tmpB, 'START.md')), '核心五件已建(START.md)');
  ok(readFileSync(path.join(tmpB, '.gitignore'), 'utf8').includes('.env'), 'H3: onboard 补建 gitignore 基线');
  const ag = readFileSync(path.join(tmpB, 'AGENTS.md'), 'utf8');
  ok(ag.includes('relay:generated') && ag.includes('不许用 var'), '老 AGENTS.md 内容保留+标记注入');
  ok(require0(path.join(tmpB, '.relay', 'manifest.json')).allowedTopLevel.includes('package.json'), 'manifest 白名单含既有顶层');
  const rs2 = await tool('relay_session_start', { root: tmpB });
  ok(!rs2.isError, 'onboard 后 session_start 可用');
  const rv2 = await tool('relay_verify', { root: tmpB });
  ok(!rv2.isError, 'onboard 后 verify(fast) 通过', rv2.text.slice(0, 400));

  console.log('\n== B2: relay_restructure 干跑→执行 ==');
  const dr = await tool('relay_restructure', { root: tmpB });
  ok(!dr.isError && dr.text.includes('干跑') && dr.text.includes('src/lib'), '干跑出迁移方案且不执行', dr.text.slice(0, 300));
  ok(existsSync(path.join(tmpB, 'lib')), '干跑未移动任何文件');
  const ex = await tool('relay_restructure', { root: tmpB, confirm: true });
  ok(!ex.isError, 'restructure 执行成功', ex.text.slice(0, 400));
  for (const f of ['src/lib/helper.js', 'tests/test/old.test.js', 'scripts/tools/x.js', 'src/app2.js'])
    ok(existsSync(path.join(tmpB, f)), `已归位: ${f}`);
  ok(!existsSync(path.join(tmpB, 'lib')) && !existsSync(path.join(tmpB, 'app2.js')), '原位置已清空(git mv)');
  const gl4 = gitSafe(tmpB, 'log', '--oneline').stdout;
  ok(gl4.includes('restructure'), 'restructure 提交存在');
  ok(readFileSync(path.join(tmpB, 'TASKS.md'), 'utf8').includes('修复目录重构后的引用路径'), 'TASKS 已插入修复任务');
  const rv3 = await tool('relay_verify', { root: tmpB });
  ok(!rv3.isError, 'restructure 后 verify(fast) 通过', rv3.text.slice(0, 300));

  console.log('\n== B3: sync 不冲掉项目自定义规范(M2) ==');
  const syb = await tool('relay_sync', { root: tmpB });
  ok(!syb.isError, 'B: relay_sync 执行');
  ok(readFileSync(path.join(tmpB, 'AGENTS.md'), 'utf8').includes('不许用 var'), 'M2: sync 重投影后老规范保留在用户保留区');

  console.log('\n== B4: R4 豁免 user-rules 保留区(N3) ==');
  const agP = path.join(tmpB, 'AGENTS.md');
  const agSaved = readFileSync(agP, 'utf8');
  const agInjected = agSaved.replace('<!-- relay:user-rules-start', '<!-- relay:user-rules-start\nTODO: 老规范里的时变词,应豁免');
  writeFileSync(agP, agInjected);
  const rv5 = await tool('relay_verify', { root: tmpB });
  ok(!rv5.isError, 'N3: 保留区内的 TODO 不触发 R4(项目自治领土)', rv5.text.slice(0, 300));
  writeFileSync(agP, agSaved);

  // ---------- 场景 C: 绿闸负向 ----------
  console.log('\n== 场景 C: 绿闸拒绝违规出场 ==');
  appendFileSync(path.join(tmpA, 'START.md'), '\nTODO: 之后再说\n');
  const bad = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '违规尝试', done_task: 'T005' });
  ok(bad.isError, 'R4 违规 → session_end 拒绝');
  ok(bad.text.includes('未提交'), '明确输出"未提交"');
  const gl3 = gitSafe(tmpA, 'log', '--oneline').stdout;
  ok(gl3.split('\n')[0].includes('session end') || gl3.split('\n')[0].includes('init'), '无新提交产生');
  const tk2 = readFileSync(path.join(tmpA, 'TASKS.md'), 'utf8');
  ok(!/\[x\] T005/.test(tk2), 'T005 未被误标完成');
  // 清理 R4 违规,恢复 START.md
  const stP = path.join(tmpA, 'START.md');
  writeFileSync(stP, readFileSync(stP, 'utf8').replace('\nTODO: 之后再说\n', ''));

  console.log('\n== C2: 验收执行门(H1)+ 密钥守卫(H3) ==');
  writeFileSync(path.join(tmpA, 'tests/broken.test.js'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('必败', () => { assert.equal(1, 2); });\n");
  const bad2 = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '带伤出场尝试', done_task: 'T005' });
  ok(bad2.isError, 'H1: 验收不绿 → session_end 拒绝');
  ok(bad2.text.includes('未提交') || bad2.text.includes('未更新'), 'H1: 明示未提交/未更新');
  rmSync(path.join(tmpA, 'tests/broken.test.js'));
  // .env 类已被 gitignore 基线兜住(add -A 不会卷入);守卫值班的场景是不被忽略的可疑文件
  writeFileSync(path.join(tmpA, 'src/secrets.md'), 'API_KEY=supersecret\n');
  const secret = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '密钥守卫测试' });
  ok(!secret.isError, 'H3: 密钥在场不置错(走人工批准通道)');
  ok(secret.text.includes('密钥') || secret.text.includes('敏感'), 'H3: 输出密钥守卫提示');
  const top1 = gitSafe(tmpA, 'log', '--oneline').stdout.split('\n')[0] || '';
  ok(!top1.includes('密钥守卫'), 'H3: 密钥会话未被自动提交', top1);
  rmSync(path.join(tmpA, 'src/secrets.md'));
  const fin = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '清理后正常出场' });
  ok(!fin.isError, '清理后正常出场', fin.text.slice(0, 300));
  ok(gitSafe(tmpA, 'log', '--oneline').stdout.includes('清理后正常出场'), '正常出场已提交');

  console.log('\n== M1 回归:「未完成」不再击穿 R7/R9 ==');
  const logP = path.join(tmpA, 'LOG.md');
  const savedLog = readFileSync(logP, 'utf8');
  const inject = [
    '## 2026-09-28 10:00 | model=x | task=T009 未完成', '- 摘要: a',
    '## 2026-09-28 11:00 | model=x | task=T010 未完成', '- 摘要: b',
    '## 2026-09-28 12:00 | model=x | task=T011 未完成', '- 摘要: c',
  ];
  const lls = savedLog.split('\n');
  const ti0 = lls.findIndex((l) => l.startsWith('# '));
  lls.splice(ti0 + 1, 0, '', ...inject, '');
  writeFileSync(logP, lls.join('\n'));
  const rv4 = await tool('relay_verify', { root: tmpA });
  ok(rv4.isError && rv4.text.includes('R7'), 'M1: 三连「未完成」正确触发 R7 发散报警');
  ok(!rv4.text.includes('声明 T009'), 'M1: R9 不再误判「未完成」为完成');
  // 维护条目不计入发散窗口:同窗口的三条 task=维护 → R7 恢复 PASS
  const maintLog = savedLog.split('\n');
  const tiM = maintLog.findIndex((l) => l.startsWith('# '));
  maintLog.splice(tiM + 1, 0, '',
    '## 2026-09-28 10:00 | model=x | task=维护', '- 摘要: 基础设施',
    '## 2026-09-28 11:00 | model=x | task=维护', '- 摘要: 基础设施',
    '## 2026-09-28 12:00 | model=x | task=维护', '- 摘要: 基础设施', '');
  writeFileSync(logP, maintLog.join('\n'));
  const rv7 = await tool('relay_verify', { root: tmpA });
  ok(!rv7.isError && !rv7.text.includes('| R7 | ERROR'), '维护会话不计入 R7 发散窗口');
  writeFileSync(logP, savedLog);

  // ---------- P0 安检回归:H-A 选项注入/目录逃逸 + H-B onboard 密钥安检 ----------
  console.log('\n== P0 安检回归 ==');
  const tkP = path.join(tmpA, 'TASKS.md');
  const tkSaved = readFileSync(tkP, 'utf8');
  // H-A-1a: 整段参数以 - 开头 = 真正的 CLI 选项注入(node --test --require=pwn.js 会预载任意脚本);
  // 攻击者可修宪把伪装文件加进白名单绕过 R2,所以这里同时篡改 manifest 模拟该前提
  writeFileSync(path.join(tmpA, '--require=pwn.js'), 'require("fs").writeFileSync("PWNED","1")\n');
  const mfP = path.join(tmpA, '.relay', 'manifest.json');
  const mfSaved = readFileSync(mfP, 'utf8');
  writeFileSync(mfP, mfSaved.replace('"allowedTopLevel": [', '"allowedTopLevel": [\n    "--require=pwn.js",'));
  const tk1 = tkSaved.replace('## 待办', '## 待办\n- [ ] T010 伪装验收\n  验收: test:--require=pwn.js');
  writeFileSync(tkP, tk1);
  const pwn1 = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '注入尝试', done_task: 'T010' });
  ok(pwn1.isError && pwn1.text.includes("不得以 '-' 开头"), 'H-A: 整段 - 开头的 test: 路径被拒(选项注入失效)', JSON.stringify(pwn1.isError) + pwn1.text.slice(0, 500));
  ok(!existsSync(path.join(tmpA, 'PWNED')), 'H-A: 预载脚本未被执行');
  writeFileSync(mfP, mfSaved);
  rmSync(path.join(tmpA, '--require=pwn.js'));
  // H-A-1b: 嵌套的 -- 开头段会被 node 当普通文件路径跑(非选项注入),但必须是真测试文件才绿——伪装文件照样被"不绿"拒绝
  mkdirSync(path.join(tmpA, 'scripts'), { recursive: true });
  writeFileSync(path.join(tmpA, 'scripts', '--require=pwn.js'), 'require("fs").writeFileSync("PWNED2","1")\n');
  const tk1b = tkSaved.replace('## 待办', '## 待办\n- [ ] T012 伪装验收嵌套\n  验收: test:scripts/--require=pwn.js');
  writeFileSync(tkP, tk1b);
  const pwn3 = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '嵌套注入尝试', done_task: 'T012' });
  ok(pwn3.isError && pwn3.text.includes('不绿'), 'H-A: 嵌套伪装文件被"不绿"拒绝(当文件跑也进不了绿灯)', pwn3.text.slice(0, 300));
  ok(!existsSync(path.join(tmpA, 'PWNED2')), 'H-A: 嵌套伪装文件未产生副作用');
  // H-A-2: ../ 目录逃逸
  writeFileSync(path.join(tmpdir(), 'outside.test.js'), 'test("x",()=>{});\n');
  const tkEscape = tkSaved.replace('## 待办', '## 待办\n- [ ] T011 逃逸验收\n  验收: test:../outside.test.js');
  writeFileSync(tkP, tkEscape);
  const pwn2 = await tool('relay_session_end', { root: tmpA, model: 'smoke-model', summary: '逃逸尝试', done_task: 'T011' });
  ok(pwn2.isError && pwn2.text.includes('位于项目目录内'), 'H-A: ../ 目录逃逸被拒', pwn2.text.slice(0, 200));
  writeFileSync(tkP, tkSaved);
  rmSync(path.join(tmpA, 'scripts', '--require=pwn.js')); rmSync(path.join(tmpdir(), 'outside.test.js'));
  // H-B: onboard 遇工作区密钥 → 拒绝自动提交
  const secP = path.join(tmpB, 'id_rsa');
  writeFileSync(secP, '-----BEGIN PRIVATE KEY-----\n');
  const commitsBefore = gitSafe(tmpB, 'rev-list', '--count', 'HEAD').stdout.trim();
  const roSec = await tool('relay_onboard', { root: tmpB });
  const commitsAfter = gitSafe(tmpB, 'rev-list', '--count', 'HEAD').stdout.trim();
  ok(!roSec.isError && roSec.text.includes('密钥'), 'H-B: onboard 发现密钥→拒绝自动入库(不置错,转人工)', roSec.text.slice(0, 200));
  ok(commitsBefore === commitsAfter, `H-B: 未产生新提交(${commitsBefore} → ${commitsAfter})`);

  // ---------- 场景 D: 并发写串行 + 幂等(T010,真双进程) ----------
  console.log('\n== 场景 D: 并发与幂等(T010) ==');
  const tmpC = mkdtempSync(path.join(tmpdir(), 'relay-c-'));
  const runCli = (cliArgs) => new Promise((resolveP) => {
    const p = spawn('node', [path.join(RELAY, 'src/cli.mjs'), ...cliArgs], { encoding: 'utf8' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolveP({ code, out }));
  });
  const jc = (o) => ['--json', JSON.stringify(o)];
  await tool('relay_init', { root: tmpC, name: '并发演示' });
  // D1: 并发 claim 不同任务 → 仓库锁串行化,两条认领都存活
  const [c1, c2] = await Promise.all([
    runCli(['relay_claim', '--root', tmpC, ...jc({ task: 'T003', model: 'model-A' })]),
    runCli(['relay_claim', '--root', tmpC, ...jc({ task: 'T004', model: 'model-B' })]),
  ]);
  ok(c1.code === 0 && c2.code === 0, 'D1: 并发 claim 不同任务双双成功', `${c1.code}/${c2.code} ${c1.out.slice(0, 150)}`);
  const tkC = readFileSync(path.join(tmpC, 'TASKS.md'), 'utf8');
  ok(/\[~\] T003 .*model-A/.test(tkC) && /\[~\] T004 .*model-B/.test(tkC), 'D1: 两条认领都写入 TASKS(无丢失更新)');
  // D2: 并发 session_end 不同任务 → 排队串行,双完成、双日志
  const [e1, e2] = await Promise.all([
    runCli(['relay_session_end', '--root', tmpC, ...jc({ model: 'model-A', summary: '甲会话完成T003', done_task: 'T003' })]),
    runCli(['relay_session_end', '--root', tmpC, ...jc({ model: 'model-B', summary: '乙会话完成T004', done_task: 'T004' })]),
  ]);
  ok(e1.code === 0 && e2.code === 0, 'D2: 并发出场双双成功(排队串行)', `${e1.code}/${e2.code}`);
  const tkC2 = readFileSync(path.join(tmpC, 'TASKS.md'), 'utf8');
  ok(/\[x\] T003/.test(tkC2) && /\[x\] T004/.test(tkC2), 'D2: 两个完成戳都落账(无回退吞没)');
  const lgC = readFileSync(path.join(tmpC, 'LOG.md'), 'utf8');
  ok(lgC.includes('甲会话完成T003') && lgC.includes('乙会话完成T004'), 'D2: 两条 LOG 条目都在(无吞没)');
  // D3: 幂等——同一出场重跑不重复记账
  const re1 = await runCli(['relay_session_end', '--root', tmpC, ...jc({ model: 'model-B', summary: '重跑出场', done_task: 'T004', next: { title: '幂等探针任务', acceptance: 'npm test 通过' } })]);
  const re2 = await runCli(['relay_session_end', '--root', tmpC, ...jc({ model: 'model-B', summary: '重跑出场', done_task: 'T004', next: { title: '幂等探针任务', acceptance: 'npm test 通过' } })]);
  ok(re1.code === 0 && re2.code === 0, 'D3: 重复出场不报错(幂等)', `${re1.code}/${re2.code}`);
  const tkC3 = readFileSync(path.join(tmpC, 'TASKS.md'), 'utf8');
  const lgC2 = readFileSync(path.join(tmpC, 'LOG.md'), 'utf8');
  ok((tkC3.match(/幂等探针任务/g) || []).length === 1, 'D3: next 不重复插入', String((tkC3.match(/幂等探针任务/g) || []).length));
  ok((lgC2.match(/model=model-B \| task=T004 完成/g) || []).length === 1, 'D3: LOG 不重复记录(同会话同任务)', String((lgC2.match(/model=model-B \| task=T004 完成/g) || []).length));
  // D4: 占位 model 拒收
  const ph = await tool('relay_claim', { root: tmpC, task: 'T003', model: '<你的模型标识>' });
  ok(ph.isError && ph.text.includes('占位'), 'D4: 占位 model 被拒收(防署名污染)');
  rmSync(tmpC, { recursive: true, force: true });

  console.log('\n== CLI ==');
  const cli = spawnSync2('node', [path.join(RELAY, 'src/cli.mjs'), 'relay_rules']);
  ok(cli.status === 0 && cli.stdout.includes('R9'), 'cli relay_rules 可用');

} finally {
  console.log(`\n========== 冒烟结果: ${pass} 通过 / ${fail} 失败 ==========`);
  proc.kill();
  rmSync(tmpA, { recursive: true, force: true }); rmSync(tmpB, { recursive: true, force: true });
  if (typeof tmpC !== 'undefined') rmSync(tmpC, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
function require0(p) { return JSON.parse(readFileSync(p, 'utf8')); }
