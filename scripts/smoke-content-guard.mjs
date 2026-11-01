#!/usr/bin/env node
// T014/R11 冒烟:协议文件内容级密钥扫描(verify)与出场写盘前阻断(session_end)。
// 用 CLI 而非 MCP 客户端:这里验证的是引擎判定;传输层已由 smoke.mjs 覆盖。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-secret-'));
const logPath = path.join(tmp, 'LOG.md');
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

try {
  console.log('== 初始化 ==');
  const init = cli('relay_init', { name: '密钥扫描演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));
  const baseLog = readFileSync(logPath, 'utf8');

  console.log('\n== R11:命中密钥 → ERROR 且不回显 ==');
  appendFileSync(logPath, '\n## 2026-11-01 10:00 | model=smoke | task=无\n- 摘要: 演示泄漏 AKIAABCDEFGHIJKLMNOP\n');
  const v1 = cli('relay_verify', { full: true });
  ok(v1.status === 1, 'verify 退出码 1(isError)', out(v1).slice(0, 300));
  ok(/R11/.test(out(v1)), '输出含 R11');
  ok(/修复:/.test(out(v1)), '输出含可执行「修复:」');
  ok(!/AKIAABCDEFGHIJKLMNOP/.test(out(v1)), '输出不回显完整密钥(只给前 4 字符预览)');

  console.log('\n== R11:同行 relay:secret-ok → 放行 ==');
  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('演示泄漏 AKIAABCDEFGHIJKLMNOP', '演示泄漏 AKIAABCDEFGHIJKLMNOP relay:secret-ok'));
  const v2 = cli('relay_verify', { full: true });
  ok(v2.status === 0, '豁免标记后 verify 通过', out(v2).slice(0, 400));

  console.log('\n== 出场写盘前阻断(任何文件都不得先写) ==');
  writeFileSync(logPath, baseLog);
  const claim = cli('relay_claim', { task: 'T003', model: 'smoke-secret', worktree: false });
  ok(claim.status === 0, '认领 T003', out(claim).slice(0, 300));
  const tasksBefore = readFileSync(path.join(tmp, 'TASKS.md'), 'utf8');
  const end = cli('relay_session_end', {
    model: 'smoke-secret',
    summary: '演示泄漏 AKIAABCDEFGHIJKLMNOP',
    done_task: 'T003',
  });
  ok(end.status === 1, 'session_end 被阻断(isError)', out(end).slice(0, 400));
  ok(/敏感内容闸/.test(out(end)), '输出含「敏感内容闸:已阻断」');
  ok(!/AKIAABCDEFGHIJKLMNOP/.test(out(end)), '阻断输出不回显完整密钥');
  ok(!readFileSync(logPath, 'utf8').includes('AKIAABCDEFGHIJKLMNOP'), 'LOG.md 未写入密钥');
  ok(readFileSync(path.join(tmp, 'TASKS.md'), 'utf8') === tasksBefore, 'TASKS.md 未被半写(前置闸生效)');
  ok(!/\[x\] T003/.test(readFileSync(path.join(tmp, 'TASKS.md'), 'utf8')), 'T003 未被标记完成');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
