#!/usr/bin/env node
// T018 冒烟:relay_recall / relay_get(只读派生、有界、数据非指令、零写盘)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  ok(/命中 3 条/.test(t1), '命中 3 条:两条日志历史 + 一条无日志待办', t1.slice(0, 400));
  ok(/T002\|-\|-/.test(t1), '无日志待办也进入索引(时间/model 明确为 -)');

  console.log('\n== recall:有界与过滤 ==');
  const r2 = cli('relay_recall', { limit: 1 });
  ok(/truncated: 2 more/.test(out(r2)), 'limit=1 时显式标注截断');
  const r3 = cli('relay_recall', { query: '登录' });
  ok(/T003\|/.test(out(r3)) && !/T004\|/.test(out(r3)), 'query 过滤生效');
  const r4 = cli('relay_recall', { status: '待办' });
  ok(/命中 3 条/.test(out(r4)), 'status 过滤返回 TASKS 中的三条待办');
  const r5 = cli('relay_recall', { limit: 999 });
  ok(r5.status === 0 && /命中 3 条/.test(out(r5)), 'limit 超上限被夹到 50(不报错)');
  const rBadStatus = cli('relay_recall', { status: 'bogus' });
  ok(rBadStatus.status === 1 && /非法 status/.test(out(rBadStatus)) && /允许值/.test(out(rBadStatus)),
    '非法 status → fail-closed,不静默取消过滤', out(rBadStatus).slice(0, 400));
  const rEmptyStatus = cli('relay_recall', { status: '' });
  ok(rEmptyStatus.status === 1, '显式空 status 同样拒绝,不伪装成未传');

  console.log('\n== HTML 注释中的伪日志不进入检索 ==');
  {
    const saved = readFileSync(logPath, 'utf8');
    writeFileSync(logPath, `${saved}\n<!--\n## 2026-01-01 00:00 | model=fake | task=T998 完成\n- 摘要: COMMENT-ONLY-EVIDENCE\n-->\n`);
    const hidden = cli('relay_recall', { query: 'COMMENT-ONLY-EVIDENCE' });
    ok(hidden.status === 0 && /命中 0 条/.test(out(hidden)), '注释内条目不被 recall 索引', out(hidden).slice(0, 300));
    writeFileSync(logPath, saved);
  }

  console.log('\n== HTML 注释中的伪任务不进入检索 ==');
  {
    const tasksPath = path.join(tmp, 'TASKS.md');
    const saved = readFileSync(tasksPath, 'utf8');
    writeFileSync(tasksPath, `${saved}\n<!--\n- [ ] T998 COMMENT_ONLY_TASK\n  验收: 不应被索引\n-->\n`);
    const hiddenTask = cli('relay_recall', { query: 'COMMENT_ONLY_TASK' });
    ok(hiddenTask.status === 0 && /命中 0 条/.test(out(hiddenTask)),
      '注释内任务行不被 recall 索引', out(hiddenTask).slice(0, 400));
    writeFileSync(tasksPath, saved);
  }

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

  console.log('\n== get:v1 旧事实行前缀也要剥离(P2-10) ==');
  appendFileSync(logPath, '- 事实(v1): 改动 3 文件(+10/-2) | 验收: 通过 | verify: PASS 9·WARN 0·ERROR 0 | 分支: main @未提交 | 耗时: 9s\n');
  const gv = cli('relay_get', { ids: ['T004'] });
  ok(/事实: 改动 3 文件/.test(out(gv)), 'v1 事实行剥离后输出(不再双前缀)', out(gv).slice(0, 400));
  ok(!/- 事实\(v1\)/.test(out(gv)), '输出不含原始 v1 前缀');

  console.log('\n== 归档后 recall/get 仍可取回 ==');
  {
    const archiveDir = path.join(tmp, 'docs', 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const archived = ['# 归档', '', '## 2026-10-01 10:00 | model=old | task=T900 完成', '- 摘要: 已归档的负结果', '- 留给下一个: 不要重试旧方案', ''].join('\n');
    writeFileSync(path.join(archiveDir, 'LOG-2026-10-01.md'), archived);
    writeFileSync(logPath, `# 会话日志\n\n<!-- relay:log-archive: docs/archive/LOG-2026-10-01.md -->\n\n${readFileSync(logPath, 'utf8')}`);
    const archivedRecall = cli('relay_recall', { query: '已归档' });
    ok(/T900\|/.test(out(archivedRecall)), 'recall 合并合法归档条目');
    const archivedGet = cli('relay_get', { ids: ['T900'] });
    ok(archivedGet.status === 0 && /不要重试旧方案/.test(out(archivedGet)), 'get live 未命中时回查归档');
  }

  console.log('\n== 缺失 LOG 是配置错误,空搜索才是正常结果 ==');
  {
    const savedLog = readFileSync(logPath, 'utf8');
    rmSync(logPath);
    const missingLog = cli('relay_recall', { query: '任意查询' });
    ok(missingLog.status === 1 && /LOG\.md 不存在/.test(out(missingLog)),
      'LOG.md 缺失 → recall isError(不伪装成空搜索)', out(missingLog).slice(0, 300));
    writeFileSync(logPath, savedLog);
    const noHit = cli('relay_recall', { query: '绝对不存在的检索词' });
    ok(noHit.status === 0 && /无命中/.test(out(noHit)),
      'LOG.md 存在但零命中 → 成功返回空搜索', out(noHit).slice(0, 300));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
