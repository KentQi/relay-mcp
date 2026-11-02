#!/usr/bin/env node
// T024 冒烟:LOG 边界规则 R12 —— 活跃区 >150 行 或 完成条目 >20 → WARN。
// 红线(可执行验收):151 行 LOG fixture → R12 WARN;120 行 → 全绿;修宪三处一致(CONTRACT/relay_rules/AGENTS 模板)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-r12-'));
const logPath = path.join(tmp, 'LOG.md');
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const row = (r, id) => (out(r).split('\n').find((l) => new RegExp(`^\\| ${id} \\|`).test(l)) || '');

// 构造恰好 targetLines 行(含末尾换行)的 LOG:维护条目填充,避开 R7/R9/R10 的完成语义。
const makeLog = (targetLines) => {
  const head = ['# 会话日志(最新在上)', '', '## 2026-01-01 00:00 | model=fixture | task=维护', '- 摘要: 边界夹具(维护条目不计入发散窗口)'];
  const lines = [...head];
  while (lines.length < targetLines) lines.push(`- 填充行 ${lines.length + 1}:边界夹具,不构成完成证据`);
  return lines.slice(0, targetLines).join('\n') + '\n';
};

// 21 条完成条目(每 2 行),总行数 <150:只触发「完成条目 >20」。
const makeDoneLog = (n) => {
  const lines = ['# 会话日志(最新在上)', ''];
  for (let i = n; i >= 1; i--) {
    lines.push(`## 2026-01-01 00:00 | model=fixture | task=T${String(i).padStart(3, '0')} 完成`);
    lines.push(`- 摘要: 完成条目夹具 ${i}`);
  }
  return lines.join('\n') + '\n';
};
const doneTasks = (n) => ['# 任务队列', '', '## 进行中', '(空)', '', '## 待办', '(空)', '', '## 已完成',
  ...Array.from({ length: n }, (_, i) => `- [x] T${String(i + 1).padStart(3, '0')} 夹具任务  (2026-01-01)`)].join('\n') + '\n';

try {
  console.log('== 初始化夹具仓库 ==');
  const init = cli('relay_init', { name: 'R12 边界夹具' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));

  console.log('\n== 120 行 LOG → 全绿 ==');
  writeFileSync(logPath, makeLog(120));
  const g1 = cli('relay_verify', { full: true });
  ok(g1.status === 0, '120 行:verify 退出码 0', out(g1).slice(0, 400));
  ok(/R12\s*\|\s*PASS/.test(row(g1, 'R12')), '120 行:R12 PASS', row(g1, 'R12'));
  ok(!/\| R12 \| WARN/.test(out(g1)), '120 行:无 R12 WARN');

  console.log('\n== 151 行 LOG → R12 WARN ==');
  writeFileSync(logPath, makeLog(151));
  const g2 = cli('relay_verify', { full: true });
  ok(g2.status === 0, '151 行:WARN 不阻断(退出码 0)', out(g2).slice(0, 400));
  ok(/R12\s*\|\s*WARN/.test(row(g2, 'R12')), '151 行:R12 WARN', row(g2, 'R12'));
  ok(/150/.test(row(g2, 'R12')) && /归档/.test(row(g2, 'R12')), 'WARN 文案给出阈值与归档出路', row(g2, 'R12'));

  console.log('\n== 21 条完成条目(<150 行)→ R12 WARN ==');
  writeFileSync(logPath, makeDoneLog(21));
  writeFileSync(path.join(tmp, 'TASKS.md'), doneTasks(21));
  const g3 = cli('relay_verify', { full: true });
  ok(/R12\s*\|\s*WARN/.test(row(g3, 'R12')), '完成条目 >20:R12 WARN', row(g3, 'R12'));
  ok(/完成条目/.test(row(g3, 'R12')), 'WARN 文案指明完成条目超限', row(g3, 'R12'));

  console.log('\n== 归档指针:必须指向真实存在的 docs/archive 文件(P1-7) ==');
  // 假指针(目标不存在):不承认边界 → 151 行仍 WARN(一行字不能消音)
  writeFileSync(logPath, '<!-- relay:log-archive: docs/archive/LOG-2026-01.md -->\n' + makeLog(151));
  const g4 = cli('relay_verify', { full: true });
  ok(/R12\s*\|\s*WARN/.test(row(g4, 'R12')), '假归档指针不能把活跃区归零(仍 WARN)', row(g4, 'R12'));
  ok(/未被承认/.test(row(g4, 'R12')), 'WARN 文案指明指针未被承认', row(g4, 'R12'));
  // 真指针(目标存在且非空):边界生效 → 活跃区归零 → PASS;条目轴用同一活跃区
  mkdirSync(path.join(tmp, 'docs', 'archive'), { recursive: true });
  writeFileSync(path.join(tmp, 'docs', 'archive', 'LOG-2026-01.md'), '# 归档\n\n- 旧条目\n');
  writeFileSync(logPath, '<!-- relay:log-archive: docs/archive/LOG-2026-01.md -->\n' + makeDoneLog(21));
  writeFileSync(path.join(tmp, 'TASKS.md'), doneTasks(21));
  const g5 = cli('relay_verify', { full: true });
  ok(/R12\s*\|\s*PASS/.test(row(g5, 'R12')), '真归档指针生效 → 活跃区归零 PASS', row(g5, 'R12'));
  ok(/活跃区 0 行/.test(row(g5, 'R12')), '指针之前的行才算活跃区(两轴同一口径)', row(g5, 'R12'));

  console.log('\n== 修宪三处一致:内容一致,不只行存在(P1-5) ==');
  const contract = readFileSync(path.join(RELAY, 'docs-design', 'CONTRACT.md'), 'utf8');
  const rules = cli('relay_rules', {});
  const tpl = readFileSync(path.join(RELAY, 'templates', 'AGENTS.md.tpl'), 'utf8');
  const readme = readFileSync(path.join(RELAY, 'README.md'), 'utf8');
  const r12Rows = {
    CONTRACT: (contract.match(/^\| R12 \|.*$/m) || [''])[0],
    relay_rules: (out(rules).match(/^\| R12 \|.*$/m) || [''])[0],
    'AGENTS 模板': (tpl.match(/^\| R12 \|.*$/m) || [''])[0],
  };
  for (const [name, text] of Object.entries(r12Rows)) {
    ok(/150/.test(text) && /20/.test(text) && /warn/i.test(text) && /logBoundary\.strict/.test(text),
      `${name} 的 R12 行内容一致(阈值 150/20 + 判定 WARN + 开关键名)`, text.slice(0, 180));
  }
  ok(/R1–R12/.test(readme) && !/R1–R11/.test(readme), 'README 中英文两半规则区间均为 R1–R12(无 R1–R11 残留)');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const stale = walk(path.join(RELAY, 'src')).filter((f) => readFileSync(f, 'utf8').includes('R1–R11'));
  ok(stale.length === 0, 'src/** 无 R1–R11 残留', stale.map((f) => f.replace(RELAY + '/', '')).join(','));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
