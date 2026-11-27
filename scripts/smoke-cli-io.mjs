#!/usr/bin/env node
// M3/M4/M18 冒烟:CLI schema 校验、自然数组写法、管道不截断、查无此项退出码。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
const sync = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const collect = (args) => new Promise((resolve, reject) => {
  const child = spawn('node', [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
});

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-cli-'));
try {
  console.log('== k=v 对 schema 校验 ==');
  const unknown = sync(['relay_get', '--root', tmp, '--json', 'ids=T001', 'bogus=value']);
  ok(unknown.status === 2, '未知键 → 用法错误 exit 2', String(unknown.status));
  ok(/未知.*bogus|bogus.*未知/.test(out(unknown)) && /ids/.test(out(unknown)), '错误列出未知键与可用键', out(unknown).slice(0, 300));

  // 单值同样按自然数组处理;object 的标量错误见下一项。
  const scalarObject = sync(['relay_session_end', '--root', tmp, '--json', 'next=oops']);
  ok(scalarObject.status === 2, 'object 收到标量 → 用法错误 exit 2', String(scalarObject.status));
  ok(/next/.test(out(scalarObject)) && /JSON/.test(out(scalarObject)) && /object/i.test(out(scalarObject)), 'object 标量错误建议整段 JSON', out(scalarObject).slice(0, 300));

  const wrongScalar = sync(['relay_archive_log', '--root', tmp, '--json', 'confirm=maybe']);
  ok(wrongScalar.status === 2 && /confirm/.test(out(wrongScalar)) && /boolean/.test(out(wrongScalar)), '标量类型也按 inputSchema 校验', out(wrongScalar).slice(0, 300));
  const badItem = sync(['relay_get', '--root', tmp, '--json', 'ids=T001,7']);
  ok(badItem.status === 2 && /ids/.test(out(badItem)) && /string/.test(out(badItem)), '自然数组元素类型按 items schema 校验', out(badItem).slice(0, 300));

  console.log('\n== 数组自然写法与既有 JSON 语义 ==');
  mkdirSync(path.join(tmp, 'docs', 'archive'), { recursive: true });
  writeFileSync(path.join(tmp, 'TASKS.md'), ['# 任务队列', '', '## 待办', '- [ ] T001 第一个', '  验收: test:T001', '- [ ] T002 第二个', '  验收: test:T002', '- [ ] T003 第三个', '  验收: test:T003', ''].join('\n'));
  writeFileSync(path.join(tmp, 'LOG.md'), '# 会话日志(最新在上)\n');
  const comma = sync(['relay_get', '--root', tmp, '--json', 'ids=T001,T002']);
  ok(comma.status === 0 && /## T001/.test(comma.stdout) && /## T002/.test(comma.stdout), 'ids=T001,T002 逗号数组可达');
  const repeated = sync(['relay_get', '--root', tmp, '--json', 'ids=T002', 'ids=T003']);
  ok(repeated.status === 0 && /## T002/.test(repeated.stdout) && /## T003/.test(repeated.stdout), '重复 ids= 合并为数组');
  const jsonArray = sync(['relay_get', '--root', tmp, '--json', '{"ids":["T001","T003"]}']);
  ok(jsonArray.status === 0 && /## T001/.test(jsonArray.stdout) && /## T003/.test(jsonArray.stdout), '整段 JSON 数组语义不变');
  const inlineArray = sync(['relay_get', '--root', tmp, '--json', 'ids=["T001","T002"]']);
  ok(inlineArray.status === 0 && /## T001/.test(inlineArray.stdout) && /## T002/.test(inlineArray.stdout), 'k=v 内联 JSON 数组语义不变');
  const nextObject = sync(['relay_session_end', '--root', tmp, '--json', 'next={"title":"修 CLI","acceptance":"npm test"}']);
  ok(nextObject.status !== 2, 'k=v 内联 JSON 对象可到达业务校验(非 CLI 用法错误)', out(nextObject).slice(0, 200));

  console.log('\n== 自然退出:>64KB stdout 管道完整 ==');
  const title = `T${'大'.repeat(70000)}END-MARKER`;
  writeFileSync(path.join(tmp, 'TASKS.md'), `# 任务队列\n\n## 待办\n- [ ] T900 ${title}\n`);
  const piped = await collect(['relay_recall', '--root', tmp, '--json', 'query=END-MARKER']);
  ok(piped.signal === null && piped.status === 0, '大输出进程自然退出码 0', JSON.stringify({ status: piped.status, signal: piped.signal, stderr: piped.stderr.slice(0, 200) }));
  ok(piped.stdout.length > 65536, 'stdout 超过 64KB', String(piped.stdout.length));
  ok(piped.stdout.includes('END-MARKER') && piped.stdout.includes('```'), '管道尾部标记完整(未被 process.exit 截断)', `len=${piped.stdout.length}`);

  console.log('\n== 查无此项退出码与帮助说明 ==');
  const noLogRoot = path.join(tmp, 'no-log');
  mkdirSync(noLogRoot);
  const noLog = sync(['relay_archive_log', '--root', noLogRoot]);
  ok(noLog.status === 1 && /LOG\.md 不存在/.test(out(noLog)), 'archive 无 LOG → 配置错误 exit 1', out(noLog).slice(0, 200));
  const noHit = sync(['relay_recall', '--root', tmp, '--json', 'query=绝对不存在']);
  ok(noHit.status === 0 && /无命中/.test(noHit.stdout), 'recall 空搜索仍是正常结果 exit 0');
  const noGet = sync(['relay_get', '--root', tmp, '--json', 'ids=T999']);
  ok(noGet.status === 1 && /未找到/.test(noGet.stdout), 'get 全未找到 → exit 1');
  const help = sync(['--help']);
  ok(/退出码[\s\S]*recall[\s\S]*无命中[\s\S]*0[\s\S]*archive[\s\S]*无 LOG[\s\S]*1[\s\S]*get[\s\S]*1/.test(help.stdout), '帮助说明三类查无此项退出码', help.stdout.slice(-500));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
