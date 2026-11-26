#!/usr/bin/env node
// T050 冒烟:通用只读 SQLite 会话描述符。
// 任务名里的具体 harness 只表示这个 schema 的**首个用户**;实现本身不绑定任何 harness。
//
// 红线:
//   1) node:sqlite 必须以 readOnly 打开(不得写库、不得改变文件 mtime/bytes);
//   2) manifest 用纯 JSON 声明表名、列名、session/directory 字段与 message/part 关联;
//   3) data.error 是嵌套 JSON **字符串**时,二次解析后能拿到 code/statusCode → quota 分类;
//   4) message/part 被还原为 transcript 后,复用 T053 的工具调用/悬空分类;
//   5) scan 默认不扫描任何库;只有 manifest.rescue.sources 显式声明后才发现;
//   6) 库损坏 / 缺表 / 缺列 → 明确降级为元数据卡或 isError,不伪造「转录损坏」;
//   7) 读取结果有上限(避免把 1.6GB 库整页搬进内存),超限显式失败;
//   8) 核心 rescue.mjs 仍零 harness 专有名。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const RELAY = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 500) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (tag) => {
  const d = mkdtempSync(path.join(tmpdir(), `relay-sqlite-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const cli = (root, tool, args = {}, env = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], {
  encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
});
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const fresh = (tag) => {
  const d = mkTmp(tag);
  const r = cli(d, 'relay_init', { name: `sqlite ${tag}` });
  if (r.status !== 0) throw new Error(`relay_init 失败:${out(r).slice(0, 600)}`);
  return d;
};
const idsOf = (root) => {
  const d = path.join(root, '.relay', 'rescue');
  return existsSync(d) ? readdirSync(d).filter((x) => !x.startsWith('.')).sort() : [];
};
import { readdirSync } from 'node:fs';
const setSources = (root, dbPath, maxRows = 5000) => {
  const p = path.join(root, '.relay', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.rescue = {
    maxAgeDays: 7,
    maxBytes: 16 * 1024 * 1024,
    sources: [{ profile: 'sqlite-conversation', root: dbPath }],
    profiles: [{
      id: 'sqlite-conversation',
      title: 'declarative SQLite conversation store',
      kind: 'sqlite-conversation',
      tables: { session: 'session', message: 'message', part: 'part' },
      session: { directory: 'directory', parentId: 'parent_id', title: 'title', id: 'id' },
      message: { sessionId: 'session_id', data: 'data', sequence: 'sequence' },
      part: { sessionId: 'session_id', messageId: 'message_id', data: 'data', sequence: 'sequence' },
      // message.data / part.data 都是 JSON 文本;message.data.error 可能还是 JSON 字符串。
      maxRows,
    }],
  };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
};

const buildDb = (dbPath, { failed = true, corrupt = false, empty = false } = {}) => {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
  `);
  if (!empty) {
    const sid = 'sess_failed_001';
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(sid, REPO_PLACEHOLDER, null, 'failed session');
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('u1', sid, JSON.stringify({
      role: 'user', time: { created: Date.now() }, cwd: REPO_PLACEHOLDER,
    }), 1);
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', sid, 'u1', JSON.stringify({
      type: 'text', text: '重构导出为流式并补测试',
    }), 1);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('a1', sid, JSON.stringify({
      role: 'assistant', modelId: 'fixture', time: { created: Date.now() },
    }), 2);
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', sid, 'a1', JSON.stringify({
      type: 'tool', callID: 'tu1', tool: 'Read',
      state: { status: 'completed', input: { filePath: REPO_PLACEHOLDER + '/f.txt' }, output: 'base' },
    }), 2);
    if (failed) {
      const errObj = { name: 'AiSdkModelAdapterError', code: 'model_rate_limited', statusCode: 429, errorPhase: 'stream', attribution: { reason: 'rate_limited' } };
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('a2', sid, JSON.stringify({
        role: 'assistant', modelId: 'fixture', time: { created: Date.now() }, error: JSON.stringify(errObj),
      }), 3);
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p3', sid, 'a2', JSON.stringify({
        type: 'text', text: 'API Error: 429 model_rate_limited',
      }), 3);
    } else {
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p3', sid, 'a1', JSON.stringify({
        type: 'step-finish', reason: 'stop',
      }), 3);
    }
  }
  db.close();
};

// 用真实仓库路径替换夹具占位符
let REPO_PLACEHOLDER = '';
const buildFor = (repo, dbPath, opts) => {
  REPO_PLACEHOLDER = repo;
  buildDb(dbPath, opts);
};

try {
  console.log('== 1. 未声明 sources:默认零扫描 ==');
  {
    const repo = fresh('nosource');
    const r = out(cli(repo, 'relay_rescue', { action: 'scan' }, {}));
    ok(/可抢救\(0\)/.test(r), '未声明 SQLite 来源时不扫描任何库', r.slice(0, 300));
  }

  console.log('\n== 2. 只读发现 + 完整对话抢救(quota 分类) ==');
  {
    const repo = fresh('readonly');
    const dbPath = path.join(mkTmp('db'), 'conversations.sqlite');
    buildFor(repo, dbPath, { failed: true });
    setSources(repo, dbPath);
    const before = statSync(dbPath);
    const scan = cli(repo, 'relay_rescue', { action: 'scan' }, {});
    ok(scan.status === 0, 'scan 成功', out(scan).slice(0, 400));
    ok(/sess_failed_001/.test(out(scan)), '发现 SQLite 里的失败会话', out(scan).slice(0, 600));
    ok(/额度\/限流|quota/.test(out(scan)), '二次解析 data.error 后识别 429/rate_limit', out(scan).slice(0, 600));
    const afterScan = statSync(dbPath);
    ok(afterScan.size === before.size && afterScan.mtimeMs === before.mtimeMs,
      'scan 未修改 SQLite 文件(只读)', `${before.size}/${before.mtimeMs} -> ${afterScan.size}/${afterScan.mtimeMs}`);

    const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'sess_failed_001', confirm: true }, {});
    ok(cap.status === 0, 'capture 成功', out(cap).slice(0, 400));
    const ids = idsOf(repo);
    ok(ids.length === 1, '恰好生成一张接力单', ids.join(','));
    if (ids.length) {
      const dir = path.join(repo, '.relay', 'rescue', ids[0]);
      const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      ok(state.profile === 'sqlite-conversation', 'state 记录通用 SQLite 描述符 id', state.profile);
      ok(existsSync(path.join(dir, 'transcript.json')), '完整对话已物化为 transcript.json');
      const transcript = readFileSync(path.join(dir, 'transcript.json'), 'utf8');
      ok(/model_rate_limited|429/.test(transcript), 'transcript 保留了 API 错误证据');
      ok(/重构导出为流式并补测试/.test(transcript), 'transcript 保留了原始任务');
      const shown = out(cli(repo, 'relay_rescue', { id: ids[0] }, {}));
      ok(/重构导出为流式并补测试/.test(shown), 'show 能展示原始任务', shown.slice(0, 500));
      ok(/半途被杀|工具调用/.test(shown), 'show 展示工具调用/中断证据', shown.slice(0, 500));
      const tk = cli(repo, 'relay_rescue', { action: 'takeover', id: ids[0], model: 'db-taker', confirm: true }, {});
      ok(tk.status === 0 && /重构导出为流式并补测试/.test(out(tk)), 'takeover 生成的接力提示词含完整任务', out(tk).slice(0, 600));
    }
    const afterCap = statSync(dbPath);
    ok(afterCap.size === before.size && afterCap.mtimeMs === before.mtimeMs, 'capture 也未修改 SQLite 文件(只读)');
  }

  console.log('\n== 3. 正常完成不列为可抢救 ==');
  {
    const repo = fresh('complete');
    const dbPath = path.join(mkTmp('db'), 'conversations.sqlite');
    buildFor(repo, dbPath, { failed: false });
    setSources(repo, dbPath);
    const scan = out(cli(repo, 'relay_rescue', { action: 'scan' }, {}));
    const rescuable = (scan.match(/## 可抢救\(\d+\)([\s\S]*?)(?=\n## )/) || ['', ''])[1];
    ok(!/sess_failed_001/.test(rescuable), '正常完成不出现在可抢救区', rescuable);
    ok(/sess_failed_001/.test(scan), '正常完成仍可在「已正常完成」小节看到', scan.slice(-600));
  }

  console.log('\n== 4. 降级与安全边界 ==');
  {
    const repo = fresh('corrupt');
    const dbPath = path.join(mkTmp('db'), 'broken.sqlite');
    writeFileSync(dbPath, 'not a sqlite database\n');
    setSources(repo, dbPath);
    const scan = cli(repo, 'relay_rescue', { action: 'scan' }, {});
    ok(scan.status === 0 && /无法|损坏|SQLite|不兼容|降级/.test(out(scan)),
      '损坏数据库被明确报告(不静默当成 0 候选)', out(scan).slice(0, 500));
  }
  {
    const repo = fresh('empty');
    const dbPath = path.join(mkTmp('db'), 'empty.sqlite');
    buildFor(repo, dbPath, { empty: true });
    setSources(repo, dbPath);
    const r = out(cli(repo, 'relay_rescue', { action: 'scan' }, {}));
    ok(/可抢救\(0\)/.test(r), '空库返回 0 候选且不报错', r.slice(0, 300));
  }
  {
    const repo = fresh('limit');
    const dbPath = path.join(mkTmp('db'), 'limited.sqlite');
    buildFor(repo, dbPath, { failed: true });
    setSources(repo, dbPath, 1);
    const r = out(cli(repo, 'relay_rescue', { action: 'scan' }, {}));
    ok(/maxRows|上限|过多|超限/.test(r), '超过 maxRows 显式失败(不静默截断)', r.slice(0, 400));
  }

  console.log('\n== 5. 架构:核心仍零 harness 专有名 ==');
  {
    const core = readFileSync(path.join(RELAY, 'src', 'engines', 'rescue.mjs'), 'utf8');
    const hits = core.split('\n').filter((l) => /zcode|claude|codex|gemini|cursor|opencode|kimi|deepseek|glm/i.test(l));
    ok(hits.length === 0, 'T050 未在核心引入任何 harness 名', hits.slice(0, 2).join(' | '));
    const profiles = readFileSync(path.join(RELAY, 'src', 'engines', 'rescue-profiles.mjs'), 'utf8');
    ok(/sqlite-conversation/.test(profiles), 'SQLite 描述符在描述符层注册');
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
} finally {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
}
console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
