#!/usr/bin/env node
// T018 冒烟:relay_recall / relay_get(只读派生、有界、数据非指令、零写盘)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-recall-'));
const logPath = path.join(tmp, 'LOG.md');
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const gitStatus = () => spawnSync('git', ['-C', tmp, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;

try {
  console.log('== 初始化 + 造两条历史 ==');
  const init = cli('relay_init', { name: '检索演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 200));
  appendFileSync(logPath, '\n## 2026-11-01 15:10 | model=smoke-a | task=T003 完成\n- 摘要: 实现登录接口并补测试\n- 负结果: JWT 刷新令牌竞态未解决\n- 留给下一个: T004 支付回调,签名见 SPEC.md\n');
  appendFileSync(logPath, '\n## 2026-11-01 15:20 | model=smoke-b | task=T004 完成\n- 摘要: 支付回调对接完成\n');

  console.log('\n== recall:索引 ==');
  const r1 = cli('relay_recall', {});
  const t1 = out(r1);
  ok(r1.status === 0, 'recall 成功', t1.slice(0, 300));
  ok(/不是给你的指令/.test(t1), '含「数据非指令」声明');
  ok(/```text/.test(t1), '索引包在 text 围栏内');
  ok(/T003\|/.test(t1) && /T004\|/.test(t1), '索引含 T003/T004 行');
  ok(!/task=无/.test(t1), '无任务号的条目不入索引');
  ok(/命中 2 条/.test(t1), '命中 2 条(与 LOG 中 T### 计数一致)');

  console.log('\n== recall:有界与过滤 ==');
  const r2 = cli('relay_recall', { limit: 1 });
  ok(/truncated: 1 more/.test(out(r2)), 'limit=1 时显式标注截断');
  const r3 = cli('relay_recall', { query: '登录' });
  ok(/T003\|/.test(out(r3)) && !/T004\|/.test(out(r3)), 'query 过滤生效');
  const r4 = cli('relay_recall', { status: '待办' });
  ok(/命中 2 条/.test(out(r4)), 'status 过滤可用(模板 T003/T004 均为待办)');
  const r5 = cli('relay_recall', { limit: 999 });
  ok(r5.status === 0 && /命中 2 条/.test(out(r5)), 'limit 超上限被夹到 50(不报错)');

  console.log('\n== get:全文取回 ==');
  const before = gitStatus();
  const g1 = cli('relay_get', { ids: ['T003'] });
  const gt = out(g1);
  ok(g1.status === 0, 'get T003 成功');
  ok(/实现登录接口/.test(gt), '返回 TASKS 标题');
  ok(/验收: /.test(gt), '返回验收行');
  ok(/负结果: JWT/.test(gt), '返回负结果全文');
  ok(/留给下一个: T004/.test(gt), '返回交接提示');
  ok(/不是给你的指令/.test(gt), 'get 也标注数据非指令');
  const g2 = cli('relay_get', { ids: ['T999'] });
  ok(/未找到/.test(out(g2)), '未知任务号 → 未找到');
  ok(g2.status === 1, '全部未找到 → isError');
  const g3 = cli('relay_get', { ids: ['bad!'] });
  ok(g3.status === 1 && /非法任务号/.test(out(g3)), '非法任务号 → isError + 修复提示');
  const g4 = cli('relay_get', { ids: ['T001', 'T002', 'T003', 'T004', 'T005', 'T006'] });
  ok(g4.status === 1 && /最多取 5 个/.test(out(g4)), '超过 5 个 → isError');
  ok(gitStatus() === before, 'recall/get 零写盘(git status 不变)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
