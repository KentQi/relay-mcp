// relay-mcp — 通用只读 SQLite 会话描述符(kind: sqlite-conversation)。
//
// 设计铁律:**这里不包含任何具体 harness 的名字、表名、列名或安装路径**。
//   调用方用纯 JSON 声明:
//     {
//       id, kind: 'sqlite-conversation', tables: {session,message,part},
//       session: {id,directory,parentId,title},
//       message: {sessionId,data,sequence},
//       part: {sessionId,messageId,data,sequence},
//       maxRows?
//     }
//   表名与列名必须是**已配置的合法标识符**(字母/数字/下划线,且不能是 SQL 关键字);
//   它们只用于拼受控 SQL,不接受任意字符串(SQL 注入防线)。
//
// 安全:
//   - node:sqlite 用 {readOnly:true} 打开,绝不写库;
//   - 只读查询在 finally 中 close;连接失败/缺表/缺列 → 明确返回诊断;
//   - 每个 session 最多读 maxRows 行,超出即拒绝(不静默截断);
//   - data 字段按 JSON 文本解析;若 message.data.error 是嵌套 JSON **字符串**,二次解析。
//
// 输出:
//   discover(root) 把 `root` 当作**单个 SQLite 文件**或含 *.sqlite 的目录,枚举 session;
//   每个 candidate.source 保存 session id,loadTranscript(candidate) 从库中物化 JSONL;
//   物化后的记录交给 jsonlMessageProfile 的标准字段映射解析,复用核心分类器。

import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_RESCUE_DISCOVERY_CANDIDATES, parseWithFieldMap, jsonlMessageProfile,
} from './rescue-profiles.mjs';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_RESERVED = new Set([
  'select', 'from', 'where', 'insert', 'update', 'delete', 'drop', 'create', 'alter', 'table',
  'index', 'view', 'into', 'values', 'set', 'and', 'or', 'not', 'null', 'is', 'in', 'as',
  'join', 'on', 'by', 'order', 'group', 'having', 'limit', 'offset', 'distinct', 'union',
  'all', 'case', 'when', 'then', 'else', 'end', 'begin', 'commit', 'rollback', 'pragma',
]);

const ident = (value, label) => {
  const s = String(value || '');
  if (!IDENT_RE.test(s) || SQL_RESERVED.has(s.toLowerCase())) {
    throw new Error(`${label} 非法 SQL 标识符:${JSON.stringify(s).slice(0, 80)}`);
  }
  return s;
};
const qident = (value, label) => `"${ident(value, label)}"`;

const jsonParse = (text, fallback = null) => {
  if (text == null) return { value: fallback, ok: true };
  if (typeof text === 'object') return { value: text, ok: true };
  try { return { value: JSON.parse(String(text)), ok: true }; }
  catch { return { value: fallback, ok: false }; }
};

// node:sqlite 是 Node >=22.13 的实验性模块:动态导入 + 明确的不可用诊断。
let DatabaseSyncClass = null;
const openReadOnly = async (dbPath) => {
  if (!DatabaseSyncClass) {
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncClass = mod.DatabaseSync;
    } catch {
      throw new Error('当前 Node 运行时不可用 node:sqlite(需要 Node >=22.13);SQLite 会话来源暂不可用');
    }
  }
  return new DatabaseSyncClass(dbPath, { readOnly: true });
};

// 找出实际要打开的库文件。root 可以直接是文件,也可以是含 SQLite 文件的目录。
const resolveDbPath = async (root) => {
  const st = await fsStat(root).catch(() => null);
  if (st && st.isFile()) return root;
  if (!st || !st.isDirectory()) throw new Error(`SQLite 来源路径不存在或不是文件/目录:${root}`);
  const files = (await readdir(root).catch(() => []))
    .filter((f) => /\.(sqlite|sqlite3|db)$/i.test(f))
    .sort();
  if (files.length !== 1) {
    throw new Error(`SQLite 来源目录必须恰好包含一个 .sqlite/.sqlite3/.db 文件,实际 ${files.length} 个:${root}`);
  }
  return path.join(root, files[0]);
};

const normalizeConfig = (spec) => {
  const s = spec || {};
  const tables = s.tables || {};
  const session = s.session || {};
  const message = s.message || {};
  const part = s.part || {};
  return {
    sessionTable: ident(tables.session || 'session', 'tables.session'),
    messageTable: ident(tables.message || 'message', 'tables.message'),
    partTable: ident(tables.part || 'part', 'tables.part'),
    sessionId: ident(session.id || 'id', 'session.id'),
    directory: ident(session.directory || 'directory', 'session.directory'),
    parentId: ident(session.parentId || 'parent_id', 'session.parentId'),
    title: ident(session.title || 'title', 'session.title'),
    messageSessionId: ident(message.sessionId || 'session_id', 'message.sessionId'),
    messageData: ident(message.data || 'data', 'message.data'),
    messageSequence: ident(message.sequence || 'sequence', 'message.sequence'),
    messageId: ident(message.id || 'id', 'message.id'),
    partSessionId: ident(part.sessionId || 'session_id', 'part.sessionId'),
    partMessageId: ident(part.messageId || 'message_id', 'part.messageId'),
    partData: ident(part.data || 'data', 'part.data'),
    partSequence: ident(part.sequence || 'sequence', 'part.sequence'),
    partId: ident(part.id || 'id', 'part.id'),
    maxRows: Number.isFinite(s.maxRows) && s.maxRows > 0 ? Math.floor(s.maxRows) : 5000,
  };
};

// 把数据库行物化成「一行一条 JSON 对象」的 transcript 文本。
// 记录结构只负责保留通用字段(role/cwd/time/content/error),不承载任何 harness 语义。
const materializeSession = (db, cfg, sessionId) => {
  const s = cfg;
  const selectSession = `SELECT ${qident(s.sessionId)}, ${qident(s.directory)}, ${qident(s.parentId)}, ${qident(s.title)} FROM ${qident(s.sessionTable)} WHERE ${qident(s.sessionId)} = ? LIMIT 1`;
  const sess = db.prepare(selectSession).get(sessionId);
  if (!sess) throw new Error(`session 不存在:${sessionId}`);
  const cwd = String(sess[s.directory] || '');

  const mSel = `${qident(s.messageId)}, ${qident(s.messageData)}, ${qident(s.messageSequence)}`;
  const messages = db.prepare(
    `SELECT ${mSel} FROM ${qident(s.messageTable)} WHERE ${qident(s.messageSessionId)} = ? ORDER BY ${qident(s.messageSequence)}, ${qident(s.messageId)} LIMIT ${s.maxRows + 1}`,
  ).all(sessionId);
  if (messages.length > s.maxRows) throw new Error(`session ${sessionId} 的消息数超过 maxRows=${s.maxRows}`);

  const parts = db.prepare(
    `SELECT ${qident(s.partId)}, ${qident(s.partMessageId)}, ${qident(s.partData)}, ${qident(s.partSequence)} FROM ${qident(s.partTable)} WHERE ${qident(s.partSessionId)} = ? ORDER BY ${qident(s.partSequence)}, ${qident(s.partId)} LIMIT ${s.maxRows + 1}`,
  ).all(sessionId);
  if (parts.length > s.maxRows) throw new Error(`session ${sessionId} 的 part 数超过 maxRows=${s.maxRows}`);

  const corrupt = [];
  const byMessage = new Map();
  for (const p of parts) {
    const mid = String(p[s.partMessageId]);
    if (!byMessage.has(mid)) byMessage.set(mid, []);
    byMessage.get(mid).push(p);
  }
  const lines = [];
  for (const m of messages) {
    const mid = String(m[s.messageId]);
    const corruptBefore = corrupt.length;
    const parsedData = jsonParse(m[s.messageData], {});
    if (!parsedData.ok) corrupt.push(`message ${mid} 的 data 不是合法 JSON`);
    const data = parsedData.value && typeof parsedData.value === 'object' ? parsedData.value : {};
    // error 可能是 JSON 字符串(这是首个用户的实际 schema,但描述符层只描述形状,不绑定名字)
    let error = data && data.error;
    if (typeof error === 'string') {
      const parsedError = jsonParse(error, null);
      if (!parsedError.ok) corrupt.push(`message ${mid} 的 error 不是合法 JSON`);
      else if (parsedError.value && typeof parsedError.value === 'object') error = parsedError.value;
    }
    const content = [];
    const results = [];
    for (const p of byMessage.get(mid) || []) {
      const parsedPart = jsonParse(p[s.partData], {});
      if (!parsedPart.ok) corrupt.push(`part ${String(p[s.partId])} 的 data 不是合法 JSON`);
      const pd = parsedPart.value && typeof parsedPart.value === 'object' ? parsedPart.value : {};
      if (!pd || typeof pd !== 'object') continue;
      const type = String(pd.type || '');
      if (type === 'text' && typeof pd.text === 'string') {
        content.push({ type: 'text', text: pd.text });
      } else if (type === 'tool') {
        const st = pd.state && typeof pd.state === 'object' ? pd.state : {};
        const input = st.input && typeof st.input === 'object' ? st.input : {};
        const callId = String(pd.callID || pd.callId || p[s.partId]);
        content.push({
          type: 'tool_use', id: callId,
          name: String(pd.tool || st.tool || ''), input,
        });
        // 工具结果必须按**终态**判定:completed 带对象输出同样要配对;running/pending 不产生结果。
        const terminal = st.status === 'completed' || st.status === 'error' || st.status === 'failed';
        if (terminal) {
          const rawOut = st.output ?? st.error ?? '';
          const outText = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut ?? '');
          results.push({
            type: 'user',
            uuid: `${mid}-result-${callId}`,
            parentUuid: mid,
            sessionId,
            cwd,
            timestamp: new Date((data && data.time && data.time.created) || Date.now()).toISOString(),
            message: {
              role: 'user',
              content: [{
                type: 'tool_result', tool_use_id: callId,
                is_error: st.status === 'error' || st.status === 'failed',
                content: String(outText).slice(0, 4000),
              }],
            },
          });
        }
      } else if (type === 'step-finish' && pd.reason) {
        content.push({ type: 'step_finish', reason: String(pd.reason) });
      }
    }
    const role = String((data && data.role) || 'assistant');
    const rec = {
      type: role,
      uuid: mid,
      sessionId,
      cwd,
      timestamp: new Date((data && data.time && data.time.created) || Date.now()).toISOString(),
      message: { role, content },
    };
    if (error && typeof error === 'object') {
      rec.isApiErrorMessage = true;
      rec.apiErrorStatus = Number.isFinite(Number(error.statusCode)) ? Number(error.statusCode) : null;
      rec.error = String(error.code || error.name || 'api_error');
      // 让分类器同时看到 code/text(顶层 error 字符串 + assistant 文本)
      const apiText = String(error.message || error.reason || error.code || 'api_error');
      rec.message.content.push({ type: 'text', text: `API Error: ${apiText}` });
    }
    lines.push(JSON.stringify(rec));
    for (const result of results) lines.push(JSON.stringify(result));
    if (corrupt.length > corruptBefore) {
      // 每条损坏单独落一条 issue 记录,且不冒充 assistant/user(分类器不会据此改变 lastRecordKind)。
      for (const issue of corrupt.slice(corruptBefore)) {
        lines.push(JSON.stringify({
          type: '_parse_issue',
          parseIssue: issue,
          message: { role: 'system', content: [] },
        }));
      }
    }
  }
  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    cwd, messageCount: messages.length, partCount: parts.length, corrupt,
  };
};

const sqliteConversationProfile = (spec) => {
  const cfg = normalizeConfig(spec);
  const base = jsonlMessageProfile(spec.id, spec.title || spec.id, {
    roots: Array.isArray(spec.roots) ? spec.roots : (typeof spec.roots === 'string' ? [spec.roots] : []),
  });
  return {
    ...base,
    kind: 'sqlite-conversation',
    transcriptless: false,
    async discover(root, {
      limit = MAX_RESCUE_DISCOVERY_CANDIDATES,
      match = null,
    } = {}) {
      const dbPath = await resolveDbPath(root);
      let db;
      try {
        db = await openReadOnly(dbPath);
        const rows = db.prepare(
          `SELECT ${qident(cfg.sessionId)}, ${qident(cfg.directory)}, ${qident(cfg.parentId)}, ${qident(cfg.title)} FROM ${qident(cfg.sessionTable)} ORDER BY ${qident(cfg.sessionId)}`,
        ).all();
        const out = [];
        for (const r of rows) {
          const sid = String(r[cfg.sessionId]);
          const candidate = {
            profile: spec.id,
            sourcePath: dbPath,
            source: sid,
            transcriptPath: '',
            agentId: sid,
            parentSessionId: r[cfg.parentId] ? String(r[cfg.parentId]) : '',
            cwd: String(r[cfg.directory] || ''),
            description: String(r[cfg.title] || ''),
            status: '',
            createdAt: '',
            updatedAt: '',
            mtimeMs: (await fsStat(dbPath)).mtimeMs,
          };
          if (match && !match(candidate)) continue;
          out.push(candidate);
          if (out.length >= limit) break;
        }
        return out;
      } catch (e) {
        // 诊断必须到得了 scan 输出:抛给核心,核心会放进 notes(不静默 0 候选)
        throw new Error(`SQLite 来源不可用:${e?.message || String(e)}`);
      } finally {
        if (db) db.close();
      }
    },
    async loadTranscript(candidate) {
      const dbPath = path.resolve(candidate.sourcePath);
      let db;
      try {
        db = await openReadOnly(dbPath);
        return materializeSession(db, cfg, String(candidate.source || candidate.agentId)).text;
      } finally {
        if (db) db.close();
      }
    },
    parse: (text) => parseWithFieldMap(text, {}),
  };
};

export { sqliteConversationProfile, normalizeConfig, materializeSession };
