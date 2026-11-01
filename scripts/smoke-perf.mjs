#!/usr/bin/env node
// T022 冒烟:runChecks 单快照 + git 收敛 + 根解析快路径。
// 用**确定性计数**(RELAY_TRACE_FILE),不用计时阈值——CI 抖动不会造成假红。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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
const cli = (root, tool, args = {}, traceFile = '') => {
  const env = { ...process.env };
  if (traceFile) env.RELAY_TRACE_FILE = traceFile; else delete env.RELAY_TRACE_FILE;
  return spawnSync('node', [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8', env });
};
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const traceOf = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-perf-'));
// 追踪文件必须放在夹具**之外**:它一旦落在仓库根目录,就会成为未跟踪顶层条目让 R2 越界。
const trace = path.join(tmpdir(), `relay-perf-trace-${process.pid}.json`);

// 造 N 条维护条目(R7 不计入;不产生完成条目 → R10 早退,专注读/进程计数)
const fillLog = (n) => {
  const base = '# 会话日志(最新在上)\n\n';
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push(`## 2026-01-01 00:00 | model=perf | task=维护`);
    entries.push(`- 摘要: perf fixture entry ${i}`);
    entries.push('');
  }
  writeFileSync(path.join(tmp, 'LOG.md'), base + entries.join('\n'));
};

try {
  console.log('== 夹具初始化 ==');
  const init = cli(tmp, 'relay_init', { name: 'perf 冒烟' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 200));
  fillLog(20);

  console.log('\n== full:单快照 + 同步 spawn=0 ==');
  const f1 = cli(tmp, 'relay_verify', { full: true }, trace);
  const t1 = traceOf(trace);
  ok(f1.status === 0, 'full verify 通过', out(f1).slice(0, 300));
  ok(t1 && t1.reads['LOG.md'] === 1, 'LOG.md 只读 1 次', JSON.stringify(t1 && t1.reads));
  ok(t1 && t1.reads['TASKS.md'] === 1, 'TASKS.md 只读 1 次');
  ok(t1 && t1.reads['manifest.json'] === 1, 'manifest.json 只读 1 次');
  ok(t1 && t1.sync === 0, '同步 git spawn = 0(async 路径无 execFileSync)');
  ok(t1 && t1.git <= 4, `git 子进程 ${t1 && t1.git} ≤ 4`);

  console.log('\n== fast:git ≤3 ==');
  const f2 = cli(tmp, 'relay_verify', {}, trace);
  const t2 = traceOf(trace);
  ok(f2.status === 0, 'fast verify 通过', out(f2).slice(0, 300));
  ok(t2 && t2.git <= 3, `fast git 子进程 ${t2 && t2.git} ≤ 3`);
  ok(t2 && t2.sync === 0, 'fast 同步 spawn = 0');

  console.log('\n== 规模无关性:20/100/500 条计数一致 ==');
  const counts = [];
  const tables = [];
  for (const n of [20, 100, 500]) {
    fillLog(n);
    cli(tmp, 'relay_verify', { full: true }, trace);
    const t = traceOf(trace);
    counts.push(t ? `${t.reads['LOG.md']}/${t.reads['TASKS.md']}/${t.reads['manifest.json']}/${t.git}/${t.sync}` : 'null');
    const r = cli(tmp, 'relay_verify', { full: true }, '');
    // 只比较「ID + 判定」两列:R7 的详情天然随维护条目数变化(「另排除 N 条维护条目」),
    // 判定结果本身必须与 LOG 规模无关,这才是规模不变量的可机检形态。
    tables.push(out(r).split('\n').filter((l) => l.startsWith('| R'))
      .map((l) => l.split('|').slice(1, 3).map((s) => s.trim()).join('='))
      .join('\n'));
  }
  ok(counts[0] === counts[1] && counts[1] === counts[2], `读/进程计数与 LOG 规模无关(${counts.join(' | ')})`);
  ok(tables[0] === tables[1] && tables[1] === tables[2], 'R1–R11 判定结果与 LOG 规模无关(20/100/500 条一致)');

  console.log('\n== 普通仓库:recall/get 的 git = 0(fs 快路径) ==');
  const r1 = cli(tmp, 'relay_recall', {}, trace);
  const tr = traceOf(trace);
  ok(r1.status === 0, 'relay_recall 成功', out(r1).slice(0, 200));
  ok(tr && tr.git === 0, `recall git 子进程 ${tr && tr.git} = 0`);
  ok(tr && tr.reads['LOG.md'] === 1 && tr.reads['TASKS.md'] === 1, 'recall 只读 LOG/TASKS 各 1 次');
  const g1 = cli(tmp, 'relay_get', { ids: ['T002'] }, trace);
  const tg = traceOf(trace);
  ok(g1.status === 0, 'relay_get 成功', out(g1).slice(0, 200));
  ok(tg && tg.git === 0, `get git 子进程 ${tg && tg.git} = 0`);
  const g2 = cli(tmp, 'relay_get', { ids: ['T002'] }, '');
  ok(out(g1) === out(g2), 'get 输出可复放(两次逐字一致)');

  console.log('\n== 静态约束:async 引擎无同步 exec ==');
  for (const f of ['src/engines/verify.mjs', 'src/engines/facts.mjs']) {
    const src = readFileSync(path.join(RELAY, f), 'utf8');
    ok(!src.includes('execFileSync'), `${f} 无 execFileSync`);
    ok(!/isGitRepo\(/.test(src), `${f} 不调用同步 isGitRepo()`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try { rmSync(trace, { force: true }); } catch { /* ignore */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
