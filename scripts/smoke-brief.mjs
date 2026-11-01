#!/usr/bin/env node
// T015 冒烟:简报有界化(字段上限 + 溢出显式告警,不做裁剪)。
// 用 CLI:验证的是简报渲染与预算判定,不是传输层。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-brief-'));
const logPath = path.join(tmp, 'LOG.md');
const mfPath = path.join(tmp, '.relay', 'manifest.json');
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

try {
  console.log('== 初始化 ==');
  const init = cli('relay_init', { name: '简报有界演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));

  // 制造一条 500 字摘要的日志条目(超长摘要曾可把简报撑爆)
  const long = '这是一段用于压力测试的超长摘要'.repeat(35).slice(0, 500);
  appendFileSync(logPath, `\n## 2026-11-01 15:00 | model=smoke | task=无\n- 摘要: ${long}\n`);

  console.log('\n== 简报:摘要字段上限 ==');
  const s1 = cli('relay_session_start', {});
  const t1 = out(s1);
  ok(s1.status === 0, 'session_start 成功', t1.slice(0, 300));
  ok(t1.includes('生效配置'), '简报含「生效配置」回显');
  ok(t1.includes('截断'), '超长摘要被截断并标注');
  ok(!t1.includes(long), '简报不含完整 500 字摘要');
  ok(t1.length < 6000, `简报总长 ${t1.length} < 6000 字符`);

  console.log('\n== 简报:超预算显式告警(不裁剪) ==');
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  mf.contextBudget = 800;
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
  const s2 = cli('relay_session_start', {});
  const t2 = out(s2);
  ok(s2.status === 0, '低预算下 session_start 仍成功(不阻断)', t2.slice(0, 200));
  ok(/超出预算 \d+/.test(t2), '输出含「超出预算」显式告警');
  ok(t2.includes('## 建议第一动作'), '告警不裁剪段落(建议第一动作仍在)');
  ok(t2.includes('## 检查结果'), '告警不裁剪段落(检查结果仍在)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
