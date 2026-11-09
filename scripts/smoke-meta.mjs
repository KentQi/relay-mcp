#!/usr/bin/env node
// v1.7.0 测试框架元负控:防"套件没跑完却报绿"。
// 事故形态(v1.6.1 前 smoke-worktrees):try { … } finally { 打印汇总; process.exit(0) } 无 catch,
// 中途异常进入 finally → 打印「N 通过 / 0 失败」→ exit(0),异常被吞,后半断言静默未执行。
// 本套件三件事:
//   1) 负例复现:构造上述坏套件并运行,断言它确实假绿(exit 0) —— 证明规则不是空谈;
//   2) 正例对照:同样抛异常但带 catch 的套件必须 exit 1;
//   3) 静态规则:仓库内所有 smoke-*.mjs,顶层 try/finally 必须配 catch,且 catch 里递增 fail。
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SELF = path.basename(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};

const BAD = `let pass = 0, fail = 0;
try {
  console.log('  ✓ 前半段跑完'); pass += 1;
  throw new Error('fixture boom');
} finally {
  console.log(\`\\n===== 结果: \${pass} 通过 / \${fail} 失败 =====\`);
  process.exit(fail ? 1 : 0);
}
`;
const GOOD = `let pass = 0, fail = 0;
try {
  console.log('  ✓ 前半段跑完'); pass += 1;
  throw new Error('fixture boom');
} catch (e) {
  fail += 1;
  console.log('  ✗ FATAL: ' + e.message);
} finally {
  console.log(\`\\n===== 结果: \${pass} 通过 / \${fail} 失败 =====\`);
  process.exit(fail ? 1 : 0);
}
`;

try {
  console.log('== 1. 负例复现:无 catch + finally 内 exit 会假绿 ==');
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-meta-'));
  try {
    const badPath = path.join(dir, 'bad-smoke.mjs');
    writeFileSync(badPath, BAD);
    const bad = spawnSync(process.execPath, [badPath], { encoding: 'utf8', timeout: 30000 });
    ok(bad.status === 0, '坏套件中途抛异常却 exit 0(假绿形态可复现)', `status=${bad.status}`);
    ok(/0 失败/.test(bad.stdout || ''), '坏套件打印「0 失败」汇总', (bad.stdout || '').slice(-120));
    ok(!/FATAL/.test(bad.stdout || ''), '坏套件未报告异常(异常被 finally 吞掉)');

    console.log('\n== 2. 正例对照:同样异常但带 catch 必须判负 ==');
    const goodPath = path.join(dir, 'good-smoke.mjs');
    writeFileSync(goodPath, GOOD);
    const good = spawnSync(process.execPath, [goodPath], { encoding: 'utf8', timeout: 30000 });
    ok(good.status === 1, '带 catch 的套件 exit 1(异常判负生效)', `status=${good.status}`);
    ok(/FATAL/.test(good.stdout || ''), '带 catch 的套件打印 FATAL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n== 3. 静态规则:仓库内 smoke 套件不得回归假绿形态 ==');
  const files = readdirSync(SCRIPTS).filter((f) => /^smoke.*\.mjs$/.test(f) && f !== SELF).sort();
  ok(files.length >= 15, `扫到 ${files.length} 个 smoke 套件`);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(path.join(SCRIPTS, f), 'utf8');
    // 只对「finally 块内 process.exit」这一假绿形态立规:异常进入 finally → 打印汇总 → exit(0)。
    // exit 在 finally 之外的套件,异常会自然以非零退出,不属于假绿。
    const fin = src.match(/\n\} finally \{([\s\S]*?)\n\}\n/);
    if (!fin || !/process\.exit\s*\(/.test(fin[1])) continue;
    const topCatch = /\n\} catch \(/.test(src);
    const catchCountsFail = /\n\} catch \([^)]*\) \{[\s\S]{0,300}?fail\s*\+=\s*1/.test(src);
    if (!topCatch || !catchCountsFail) offenders.push(f + (topCatch ? '(catch 未判负)' : '(无 catch)'));
  }
  ok(offenders.length === 0, '顶层 try/finally 均配 catch 且 catch 递增 fail', offenders.join(', '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e?.stack || e}`);
}

process.exit(fail ? 1 : 0);
