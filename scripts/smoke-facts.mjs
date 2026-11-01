#!/usr/bin/env node
// T013/R10 冒烟:事实底账(引擎写入「事实(v1)」行 + 文件数对账)。
// 用 CLI 而非 MCP 客户端:验证引擎判定;传输层由 smoke.mjs 覆盖。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-facts-'));
const logPath = path.join(tmp, 'LOG.md');
const mfPath = path.join(tmp, '.relay', 'manifest.json');
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const readMf = () => JSON.parse(readFileSync(mfPath, 'utf8'));
const writeMf = (m) => writeFileSync(mfPath, JSON.stringify(m, null, 2) + '\n');

try {
  console.log('== init 写入 facts 配置 ==');
  const init = cli('relay_init', { name: '事实底账演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));
  const mf0 = readMf();
  ok(mf0.facts && mf0.facts.enabled === true, 'init 写入 facts.enabled=true');
  ok(typeof mf0.facts.since === 'string' && mf0.facts.since.length >= 16, 'init 写入 facts.since(YYYY-MM-DD HH:mm)');

  console.log('\n== 出场由引擎写入事实行 ==');
  const claim = cli('relay_claim', { task: 'T003', model: 'smoke-facts', worktree: false });
  ok(claim.status === 0, '认领 T003', out(claim).slice(0, 200));
  const end = cli('relay_session_end', { model: 'smoke-facts', summary: '事实底账冒烟:只改协议文件', done_task: 'T003' });
  ok(end.status === 0, 'session_end 成功', out(end).slice(0, 400));
  const log = readFileSync(logPath, 'utf8');
  const fact = log.match(/^- 事实\(v1\): .*$/m);
  ok(!!fact, 'LOG 含「事实(v1)」行', log.slice(0, 300));
  ok(/改动 \d+ 文件\(\+\d+\/-\d+\)/.test(fact[0]), '事实行含文件数与增删行数');
  ok(/验收: 通过/.test(fact[0]), '事实行记录验收执行结果');
  ok(/verify: PASS \d+/.test(fact[0]), '事实行记录 verify 汇总');

  console.log('\n== R10 存在性:删除事实行 → WARN(P1-14:不锁死出场) ==');
  writeFileSync(logPath, log.replace(/^- 事实\(v1\): .*\n/m, ''));
  const v1 = cli('relay_verify', { full: true });
  ok(v1.status === 0, 'WARN 不阻断(退出码 0,避免 R10 死锁出场)', out(v1).slice(0, 300));
  ok(/R10\s*\|\s*WARN/.test(out(v1)), '输出为 R10 WARN(缺事实行)');
  ok(/修复:/.test(out(v1)), '输出含可执行「修复:」');

  console.log('\n== R10 数字对账:篡改文件数 → WARN(strict 前) ==');
  writeFileSync(logPath, log.replace(/改动 (\d+) 文件/, (_, n) => `改动 ${Number(n) + 7} 文件`));
  const v2 = cli('relay_verify', { full: true });
  ok(v2.status === 0, 'WARN 不阻断出场(退出码 0)', out(v2).slice(0, 300));
  ok(/R10\s*\|\s*WARN/.test(out(v2)), '输出为 R10 WARN');

  console.log('\n== R10 strict:数字不一致 → ERROR ==');
  const mf1 = readMf();
  mf1.facts.strict = true;
  writeMf(mf1);
  const v3 = cli('relay_verify', { full: true });
  ok(v3.status === 1, 'strict 模式下退出码 1', out(v3).slice(0, 300));
  ok(/R10\s*\|\s*ERROR/.test(out(v3)), '输出为 R10 ERROR');

  console.log('\n== 升级兼容:since 在未来 → SKIP ==');
  const mf2 = readMf();
  mf2.facts.strict = false;
  mf2.facts.since = '2099-01-01 00:00';
  writeMf(mf2);
  const v4 = cli('relay_verify', { full: true });
  ok(v4.status === 0, 'since 在未来时 verify 通过', out(v4).slice(0, 300));
  ok(/R10\s*\|\s*SKIP/.test(out(v4)), '输出为 R10 SKIP(旧条目豁免)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
