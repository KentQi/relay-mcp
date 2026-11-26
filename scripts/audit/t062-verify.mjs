#!/usr/bin/env node
// T062 独立复验探针(不依赖仓库自带冒烟的断言)
//  1) 旧卡兼容:harness='claude' / 'zcode' / 未知值
//  2) F1:done_tasks 不带 done_task → 必须拒收且零写盘
//  3) F2:done_tasks 含幽灵任务号 → 必须拒收且零写盘
//  4) F3:多任务完成提交消息必须带全部任务号(R10 反查依据)
//  5) 新怀疑:多任务数足够多时,提交消息的 80 字上限会截断末尾任务号
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const FIXTURES = path.join(RELAY, 'scripts', 'fixtures', 'rescue');
const cli = (root, tool, args = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8', timeout: 300000 });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (root, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).stdout.trim();
const tmpDirs = [];
const mkTmp = (t) => { const d = mkdtempSync(path.join(tmpdir(), `t062-${t}-`)); tmpDirs.push(d); return d; };
const copyFixture = (name, destRoot, vars) => {
  const walk = (rel) => {
    const from = path.join(FIXTURES, name, rel);
    const to = path.join(destRoot, rel);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from)) walk(path.join(rel, e));
      return;
    }
    let text = readFileSync(from, 'utf8');
    for (const [k, v] of Object.entries(vars)) text = text.split(`<<${k}>>`).join(v);
    writeFileSync(to, text);
  };
  walk('');
};
const freshRepo = (tag) => {
  const d = mkTmp(tag);
  const r = cli(d, 'relay_init', { name: `t062 ${tag}` });
  if (r.status !== 0) throw new Error(`init 失败:${out(r).slice(0, 300)}`);
  return d;
};
const setSources = (root, sources, profiles) => {
  const p = path.join(root, '.relay', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.rescue = { ...(m.rescue || {}), sources, profiles };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
};
const rescueIds = (root) => {
  const d = path.join(root, '.relay', 'rescue');
  return existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith('.')).sort() : [];
};
const withTasks = (root, ids) => {
  const tp = path.join(root, 'TASKS.md');
  const t0 = readFileSync(tp, 'utf8');
  const rows = ids.flatMap((id) => [`- [ ] ${id} 探针${id}`, '  验收: npm test']);
  writeFileSync(tp, t0.replace(/^## 待办$/m, ['## 待办', ...rows].join('\n')));
};

try {
  // ── 1. 旧卡兼容 ──
  console.log('== 1. 旧卡兼容(T058 前的 state.harness)==');
  {
    const repo = freshRepo('legacy');
    const H = mkTmp('home');
    copyFixture('claude', path.join(H, 'cc'), { ROOT: repo });
    setSources(repo, [{ profile: 'cc-ref', root: path.join(H, 'cc', 'projects') }],
      [{ id: 'cc-ref', title: 'ref', kind: 'jsonl-message', filePattern: '^agent-(.+)\\.jsonl$' }]);
    const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'claude-ok', confirm: true });
    console.log('  capture:', cap.status === 0 ? 'OK' : `FAIL ${out(cap).slice(0, 200)}`);
    const id = rescueIds(repo)[0];
    const sp = path.join(repo, '.relay', 'rescue', id, 'state.json');
    const base = JSON.parse(readFileSync(sp, 'utf8'));
    for (const [h, label] of [['claude', '记录型'], ['zcode', '元数据型'], ['some-unknown-harness', '未知值']]) {
      const st = { ...base };
      delete st.profile; delete st.transcriptless;
      st.harness = h;
      writeFileSync(sp, `${JSON.stringify(st, null, 2)}\n`);
      const r = cli(repo, 'relay_rescue', { id });
      const txt = out(r);
      console.log(`  harness='${h}'(${label}) → isError=${r.status !== 0} | 含"原始任务"=${/原始任务/.test(txt)} | 含"未注册"=${/未注册/.test(txt)}`);
    }
    // 复原
    writeFileSync(sp, `${JSON.stringify(base, null, 2)}\n`);
  }

  // ── 2. F1:done_tasks 不带 done_task ──
  console.log('\n== 2. F1:done_tasks 不带 done_task → 必须拒收 ==');
  {
    const repo = freshRepo('f1');
    withTasks(repo, ['T901']);
    cli(repo, 'relay_claim', { task: 'T901', model: 'm', worktree: false });
    const tasksBefore = readFileSync(path.join(repo, 'TASKS.md'), 'utf8');
    const logBefore = readFileSync(path.join(repo, 'LOG.md'), 'utf8');
    const r = cli(repo, 'relay_session_end', { model: 'm', summary: '只给 done_tasks', done_tasks: ['T901'] });
    const tasksAfter = readFileSync(path.join(repo, 'TASKS.md'), 'utf8');
    const logAfter = readFileSync(path.join(repo, 'LOG.md'), 'utf8');
    console.log('  isError:', r.status !== 0, '| 提示含"done_task":', /done_task/.test(out(r)));
    console.log('  TASKS 逐字节未变:', tasksBefore === tasksAfter, '| LOG 逐字节未变:', logBefore === logAfter);
    console.log('  验收门是否被跳过(输出不应出现"项目测试入口"):', !/项目测试入口/.test(out(r)));
    console.log('  输出片段:', out(r).split('\n').filter((l) => /修复|缺少|done_task/.test(l)).slice(0, 2).join(' | '));
  }

  // ── 3. F2:幽灵任务号 ──
  console.log('\n== 3. F2:done_tasks 含幽灵任务号 → 必须拒收 ==');
  {
    const repo = freshRepo('f2');
    withTasks(repo, ['T901']);
    cli(repo, 'relay_claim', { task: 'T901', model: 'm', worktree: false });
    const logBefore = readFileSync(path.join(repo, 'LOG.md'), 'utf8');
    const r = cli(repo, 'relay_session_end', { model: 'm', summary: '幽灵任务', done_task: 'T901', done_tasks: ['T999'] });
    const logAfter = readFileSync(path.join(repo, 'LOG.md'), 'utf8');
    console.log('  isError:', r.status !== 0, '| LOG 逐字节未变:', logBefore === logAfter);
    console.log('  LOG 里出现 task=T999 完成:', /task=T999 完成/.test(logAfter));
    console.log('  输出片段:', out(r).split('\n').filter((l) => /不存在|修复/.test(l)).slice(0, 2).join(' | '));
  }

  // ── 4+5. F3 与多任务提交消息 ──
  for (const n of [7, 8]) {
    console.log(`\n== 4/5. ${n} 任务出场:提交消息必须带全部任务号 ==`);
    const repo = freshRepo(`m${n}`);
    const ids = Array.from({ length: n }, (_, i) => `T${901 + i}`);
    withTasks(repo, ids);
    for (const id of ids) cli(repo, 'relay_claim', { task: id, model: 'm', worktree: false });
    const r = cli(repo, 'relay_session_end', { model: 'm', summary: `${n} 个任务一起交付`, done_task: ids[0], done_tasks: ids.slice(1) });
    console.log('  isError:', r.status !== 0);
    const msg = git(repo, 'log', '-1', '--pretty=%s');
    console.log('  提交消息:', JSON.stringify(msg), `(${msg.length} 字)`);
    const missing = ids.filter((id) => !git(repo, 'log', '--oneline', '--grep', `${id} 完成`));
    console.log(`  ${ids.length} 个任务里 grep 不到「完成」提交的:`, missing.length ? missing.join(',') : '(无)');
    const log = readFileSync(path.join(repo, 'LOG.md'), 'utf8');
    console.log('  LOG 里各任务完成条目:', ids.filter((id) => log.includes(`task=${id} 完成`)).length, '/', ids.length);
  }
} catch (e) {
  console.log('FATAL', e && e.stack ? e.stack : e);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
