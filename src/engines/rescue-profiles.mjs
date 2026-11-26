// relay-mcp — 来源格式描述符(profile)契约。
//
// 设计铁律:**核心引擎不认识任何具体 harness**。
//   rescue.mjs 只依赖本文件定义的描述符接口;具体 harness 的目录布局、文件命名、字段映射、
//   记录格式全部收敛为「一份声明式描述」(profile)。
//   新增一个 harness = 新增一份描述,不改核心代码;用户也可以在自己的项目里写描述符。
//
// 一个 profile 的形状:
//   {
//     id:      string          唯一名(写入接力单 state.profile)
//     title:   string          人类可读名(仅用于输出,不参与逻辑)
//     roots:   (home) => string[]   该格式在哪些根目录下找候选(空数组 = 需要显式 source)
//     discover(root, ctx) => Promise<Candidate[]>   在单个 root 下枚举候选
//     parse(text) => Parsed|null                    把 transcript 文本解析成结构化摘要
//     loadTranscript?(candidate) => Promise<Buffer|string>  可选:来源不是文件时用它读取字节
//     transcriptless?: boolean  true = 该格式不提供可复制的 transcript(只有元数据)
//   }
//
//   Candidate 统一字段(引擎只读这些,不读 harness 私有字段):
//     { sourcePath, agentId, parentSessionId, transcriptPath?, source?, cwd?, status?, error?,
//       prompt?, description?, profile?, createdAt?, updatedAt?, mtimeMs? }
//   非文件来源可以用 `source` 传给 loadTranscript(如 sqlite 的 session id),
//   同时保留 transcriptPath(通常为空)。
//
//   Parsed 统一字段:
//     { prompt, cwd, gitBranch, sessionId, agentId, edits[], commands[], todos[],
//       narrative, recordCount, toolSignals }
//     toolSignals = { pendingToolUse, lastRecordKind, trailingToolError, apiError, anyToolError,
//                     explicitCompletion, parseIssues[] }
//     —— 引擎只根据 toolSignals 做**确定性分类**,不含任何 harness 语义。
//     parseIssues 是描述符自报的「行数据损坏」信号(如 SQLite 行内 JSON 非法):
//     只要非空,分类就降级为 error,绝不当成正常完成。
//
// 本文件只放「格式描述符的实现」与「注册表」;通用规则(归属判定、分类、快照、锁)留在 rescue.mjs。

import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { readFileSafe } from '../util.mjs';

const clip = (s, n) => {
  const cps = Array.from(String(s ?? ''));
  return cps.length > n ? cps.slice(0, n).join('') : cps.join('');
};

/* ------------------------------------------------------------------ */
/* 通用 JSONL 记录遍历器:大多数 harness 的 transcript 都是「一行一条 JSON」*/
/* ------------------------------------------------------------------ */

// 解析 JSONL,返回 { records(可解析对象数组), total, badLines }
const readJsonl = (text) => {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
  const records = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') records.push(v);
      else bad += 1;
    } catch { bad += 1; }
  }
  return { records, total: lines.length, badLines: bad };
};

// 从一条记录里取出「消息外壳」:不同 harness 会把内容放在 message/content/parts 等不同位置。
// 这里只做**结构性**归一(不猜语义):返回 { role, content } 或 null。
const asMessage = (rec, { roleField = 'type', roleMap = {}, contentPath = 'message.content' } = {}) => {
  const roleRaw = rec[roleField];
  const role = roleMap[roleRaw] ?? roleRaw;
  if (!role) return null;
  let content = rec;
  for (const seg of String(contentPath).split('.')) content = content == null ? null : content[seg];
  if (content === undefined) content = rec.content;
  return { role: String(role), content };
};

// 内容块归一:支持 string / [{type,...}] 两种常见形态
const asBlocks = (content) => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((c) => c && typeof c === 'object');
  return [];
};

/* ------------------------------------------------------------------ */
/* 通用 transcript 解析器:基于「字段映射」而不是硬编码 harness 语义      */
/* ------------------------------------------------------------------ */

// fieldMap 描述「从一条记录里怎么取字段」,全部可选,缺省用通用缺省:
//   role:       记录级别的角色字段名(默认 'type')
//   roleMap:    角色值映射({ user:'user', assistant:'assistant' })
//   userIds:    视为 user 的角色值数组(默认 ['user','human'])
//   assistantIds:视为 assistant 的角色值数组(默认 ['assistant','ai','agent'])
//   contentPath:内容在记录里的点路径(默认 'message.content')
//   textTypes:  文本块 type 值(默认 ['text','output_text'])
//   toolUseTypes:工具调用块 type 值(默认 ['tool_use','tool_call'])
//   toolResultTypes:工具结果块 type 值(默认 ['tool_result','tool_response'])
//   toolNamePath/toolInputPath/toolIdPath:块内字段名
//   filePathKeys:视为「写文件」的工具参数键(默认 ['file_path','path','notebook_path'])
//   writeTools:  视为写文件的工具名(默认 Write/Edit/MultiEdit/NotebookEdit)
//   shellTools:  视为执行命令的工具名(默认 Bash/Shell)
//   apiErrorMarker:标记「这条记录是 API 错误」的字段名(默认 'isApiErrorMessage')
//   apiErrorCodePath / apiErrorStatusPath / apiErrorTextPath
//   timestampField, cwdField, sessionField, agentField, branchField
//
// 返回值里的 toolSignals 是引擎做分类的唯一依据(见文件头注释)。
const parseWithFieldMap = (text, map = {}) => {
  const m = {
    role: 'type', contentPath: 'message.content',
    userIds: ['user', 'human'],
    assistantIds: ['assistant', 'ai', 'agent'],
    textTypes: ['text', 'output_text'],
    toolUseTypes: ['tool_use', 'tool_call'],
    toolResultTypes: ['tool_result', 'tool_response'],
    toolNamePath: 'name', toolInputPath: 'input', toolIdPath: 'id',
    filePathKeys: ['file_path', 'path', 'notebook_path'],
    writeTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    shellTools: ['Bash', 'Shell'],
    apiErrorMarker: 'isApiErrorMessage',
    apiErrorCodePath: 'error', apiErrorStatusPath: 'apiErrorStatus', apiErrorTextPath: 'message.content',
    roleMap: {}, stopReasonPath: 'message.stop_reason',
    timestampField: 'timestamp', cwdField: 'cwd', sessionField: 'sessionId', agentField: 'agentId', branchField: 'gitBranch',
    ...map,
  };
  const { records } = readJsonl(text);
  const first = records[0] || {};
  const sig = {
    pendingToolUse: new Set(),
    lastRecordKind: '',
    trailingToolError: false,
    anyToolError: false,
    explicitCompletion: false,
    apiError: null,
    parseIssues: [],
  };
  const edits = [];
  const commands = [];
  const toolCalls = [];
  const todos = [];
  let prompt = '';
  let narrative = '';
  let lastSignalIndex = -1;
  let apiErrorIndex = -1;

  const readPath = (obj, dotted) => {
    let cur = obj;
    for (const seg of String(dotted).split('.')) { cur = cur == null ? null : cur[seg]; }
    return cur;
  };

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // 描述符可以在物化记录里标注 parseIssue(如来源行 JSON 损坏):这是损坏信号,不是内容。
    if (typeof rec.parseIssue === 'string' && rec.parseIssue) sig.parseIssues.push(clip(rec.parseIssue, 200));
    const msg = asMessage(rec, { roleField: m.role, roleMap: m.roleMap || {}, contentPath: m.contentPath });
    if (!msg) continue;
    const { role, content } = msg;
    // 记录级 API 错误标记:按「最后一个有效轮次」判定,后续恢复轮次会覆盖它。
    // 标记可以是布尔 true,也可以直接是一个错误对象(声明式 fieldMap 里更自然)。
    const markerVal = readPath(rec, m.apiErrorMarker);
    const isApiErrorRec = markerVal === true
      || (markerVal != null && typeof markerVal === 'object' && !Array.isArray(markerVal));
    if (isApiErrorRec) {
      sig.lastRecordKind = 'api-error';
      let errText = '';
      const cur = readPath(rec, m.apiErrorTextPath);
      if (typeof cur === 'string') errText = cur;
      else {
        const blocks = asBlocks(content).filter((b) => m.textTypes.includes(b.type));
        errText = blocks.map((b) => String(b.text ?? '')).join(' ');
      }
      let code = '';
      let status = null;
      const c2 = readPath(rec, m.apiErrorCodePath);
      if (typeof c2 === 'string') code = c2;
      const statusRaw = readPath(rec, m.apiErrorStatusPath);
      const st = Number(statusRaw);
      if (Number.isFinite(st)) status = st;
      sig.apiError = { code, status, text: clip(errText, 400) };
      apiErrorIndex = i;
      lastSignalIndex = i;
      continue;
    }
    const isAssistant = m.assistantIds.includes(role);
    const isUser = m.userIds.includes(role);
    if (isAssistant) {
      sig.lastRecordKind = 'assistant';
      lastSignalIndex = i;
      // 完成信号只认**最后一条 assistant** 自己的 stop 原因:早期轮次的 end_turn 不能掩盖后续中断。
      const stopReason = String(readPath(rec, m.stopReasonPath) ?? rec.stop_reason ?? '');
      const completed = ['end_turn', 'completed', 'stop'].includes(stopReason);
      sig.explicitCompletion = completed;
      for (const b of asBlocks(content)) {
        if (m.textTypes.includes(b.type) && b.text) {
          narrative = String(b.text);
          const plan = narrative.match(/计划[:：]([\s\S]*)$/);
          if (plan) todos.push(clip(plan[1].trim(), 300));
        }
        if (m.toolUseTypes.includes(b.type)) {
          const name = String(b[m.toolNamePath] ?? '');
          const input = b[m.toolInputPath] && typeof b[m.toolInputPath] === 'object' ? b[m.toolInputPath] : {};
          const id = b[m.toolIdPath];
          if (id) sig.pendingToolUse.add(String(id));
          toolCalls.push({ name: name || '(unknown)', input });
          if (m.writeTools.includes(name)) {
            const fp = m.filePathKeys.map((k) => input[k]).find((v) => typeof v === 'string' && v);
            if (fp) edits.push({ tool: name, path: String(fp) });
          }
          if (m.shellTools.includes(name) && typeof input.command === 'string') {
            commands.push(clip(input.command, 400));
          }
          if (Array.isArray(input.todos)) {
            for (const t of input.todos) if (t && t.content) todos.push(clip(t.content, 200));
          }
        } else if (b.type === 'step_finish' && ['stop', 'completed', 'end_turn'].includes(String(b.reason))) {
          sig.explicitCompletion = true;
        }
      }
    } else if (isUser) {
      lastSignalIndex = i;
      const blocks = asBlocks(content).filter((b) => m.toolResultTypes.includes(b.type));
      if (blocks.length) {
        sig.lastRecordKind = 'user-result';
        let hadError = false;
        for (const b of blocks) {
          const id = b[m.toolIdPath] ?? b.tool_use_id;
          if (id) sig.pendingToolUse.delete(String(id));
          if (b.is_error === true) hadError = true;
        }
        if (hadError) { sig.anyToolError = true; sig.trailingToolError = true; }
        else sig.trailingToolError = false;
      } else {
        // 纯文本 user 记录:第一条是任务提示词
        if (!prompt) {
          const tb = asBlocks(content).filter((b) => m.textTypes.includes(b.type));
          prompt = tb.length ? tb.map((b) => String(b.text ?? '')).join('\n') : '';
        }
      }
    }
  }
  // 历史 API 错误只在其后没有新轮次时才算「当前停因」;恢复后的会话不再被判 quota。
  if (sig.apiError && lastSignalIndex > apiErrorIndex) {
    sig.recoveredApiError = sig.apiError;
    sig.apiError = null;
  }
  return {
    prompt,
    cwd: String(first[m.cwdField] || ''),
    gitBranch: String(first[m.branchField] || ''),
    sessionId: String(first[m.sessionField] || ''),
    agentId: String(first[m.agentField] || ''),
    edits,
    commands,
    toolCalls,
    todos: [...new Set(todos)],
    narrative,
    recordCount: records.length,
    toolSignals: sig,
    parseIssues: sig.parseIssues,
  };
};

/* ------------------------------------------------------------------ */
/* 内置格式描述符(仅两份等价参考描述;核心不依赖它们的具体语义)           */
/* ------------------------------------------------------------------ */

// 描述符 A:「一条记录一行 JSON,内容在 message.content」的通用形态。
// 记录级 cwd / sessionId / agentId / gitBranch 直接读取。
const jsonlMessageProfile = (id, title, { roots, agentFilePattern = /^agent-(.+)\.jsonl$/ } = {}) => ({
  id,
  title,
  roots: typeof roots === 'function' ? roots : () => roots || [],
  transcriptless: false,
  async discover(root, { maxAgeMs = 7 * 86400000 } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    const out = [];
    // 递归到底(最多 MAX_DEPTH 层):不预设 harness 的目录层数,只认文件名模式。
    const MAX_DEPTH = 6;
    const walk = async (dir, depth) => {
      if (depth > MAX_DEPTH || out.length >= 400) return;
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p, depth + 1); continue; }
        if (!e.isFile()) continue;
        const mm = e.name.match(agentFilePattern);
        if (!mm) continue;
        let st;
        try { st = await fsStat(p); } catch { continue; }
        if (maxAgeMs > 0 && st.mtimeMs < cutoff) continue;
        out.push({
          sourcePath: p,
          transcriptPath: p,
          agentId: mm[1],
          parentSessionId: path.basename(path.dirname(path.dirname(dir))),
          mtimeMs: st.mtimeMs,
        });
        if (out.length >= 400) return;
      }
    };
    await walk(root, 0);
    return out;
  },
  parse: (text) => parseWithFieldMap(text, {}),
});

// 描述符 B:「一层目录一份元数据」的通用形态(不提供可复制的对话,只有结构化元数据)。
// 目录形状:root/<parent>/<agent>/<metaFile>,字段由 fieldMap 指定。
const jsonMetadataProfile = (id, title, { roots, metaFile = 'metadata.json', fieldMap = {} } = {}) => ({
  id,
  title,
  roots: typeof roots === 'function' ? roots : () => roots || [],
  transcriptless: true,
  async discover(root, { maxAgeMs = 7 * 86400000 } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    const map = {
      agentId: 'agentId', parentSessionId: 'parentSessionId',
      cwd: ['cwd', 'workspaceRoot'], status: 'status', error: 'error',
      prompt: 'prompt', description: 'description', profile: 'profileId',
      createdAt: 'createdAt', updatedAt: ['updatedAt', 'completedAt'],
      ...fieldMap,
    };
    const pick = (obj, spec) => {
      const keys = Array.isArray(spec) ? spec : [spec];
      for (const k of keys) {
        const v = obj && obj[k];
        if (typeof v === 'string' && v) return v;
      }
      return '';
    };
    const out = [];
    let parents = [];
    try { parents = await readdir(root, { withFileTypes: true }); } catch { return out; }
    for (const parent of parents) {
      if (!parent.isDirectory()) continue;
      let agents = [];
      try { agents = await readdir(path.join(root, parent.name), { withFileTypes: true }); } catch { continue; }
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const metaPath = path.join(root, parent.name, agent.name, metaFile);
        const raw = await readFileSafe(metaPath, null);
        if (raw == null) continue;
        let meta;
        try { meta = JSON.parse(raw); } catch { continue; }
        const updated = Date.parse(pick(meta, map.updatedAt) || pick(meta, map.createdAt) || '');
        if (Number.isFinite(updated) && maxAgeMs > 0 && updated < cutoff) continue;
        out.push({
          sourcePath: metaPath,
          transcriptPath: '',
          agentId: pick(meta, map.agentId) || agent.name.replace(/^agent[_-]/, ''),
          parentSessionId: pick(meta, map.parentSessionId) || parent.name,
          cwd: pick(meta, map.cwd),
          status: pick(meta, map.status),
          error: pick(meta, map.error),
          prompt: pick(meta, map.prompt),
          description: pick(meta, map.description),
          agentType: pick(meta, map.profile),
          createdAt: pick(meta, map.createdAt),
          updatedAt: pick(meta, map.updatedAt),
          mtimeMs: Number.isFinite(updated) ? updated : 0,
        });
        if (out.length >= 400) return out;
      }
    }
    return out;
  },
  parse: (text) => parseWithFieldMap(text, {}),
});

/* ------------------------------------------------------------------ */
/* 注册表                                                             */
/* ------------------------------------------------------------------ */

// 内置描述符**不含硬编码 home 路径**——roots 由调用方注入或为空(需显式 source)。
// 这样核心不需要知道任何 harness 的安装位置。
export const BUILTIN_PROFILES = Object.freeze([
  // 作为「记录型」与「元数据类型」两种形态的参考实现;id 与 title 可被用户覆盖。
  jsonlMessageProfile('jsonl-agent', 'JSONL agent transcript (one JSON object per line)'),
  jsonMetadataProfile('json-meta', 'JSON metadata-only agent (no copyable transcript)'),
]);

// 把用户提供的描述符(manifest.rescue.profiles 或代码传入)与内置合并。
// 用户描述符只需提供 id 与 roots/discover/parse 的最小子集,其余用内置默认补齐。
export const resolveProfiles = ({ custom = [], builtin = BUILTIN_PROFILES } = {}) => {
  const list = [...builtin];
  for (const p of Array.isArray(custom) ? custom : []) {
    if (!p || typeof p !== 'object' || !p.id) continue;
    const idx = list.findIndex((x) => x.id === p.id);
    const merged = { ...(idx >= 0 ? list[idx] : {}), ...p };
    if (idx >= 0) list[idx] = merged; else list.push(merged);
  }
  return list;
};

export { parseWithFieldMap, jsonlMessageProfile, jsonMetadataProfile, readJsonl, clip };

/* ------------------------------------------------------------------ */
/* 声明式描述符(manifest 里只能放 JSON,不能放函数)                     */
/* ------------------------------------------------------------------ */

// 把 manifest.rescue.profiles 里的**纯数据**描述转成可执行描述符。
// 支持两种声明:
//   { id, kind: 'jsonl-message', roots?, filePattern?, fieldMap? }   记录型
//   { id, kind: 'json-metadata',  roots?, metaFile?, fieldMap? }     元数据型
// 需要更复杂逻辑时,调用方(嵌入 relay 的宿主)可用 _profiles 注入真函数。
export const profileFromSpec = (spec) => {
  if (!spec || typeof spec !== 'object' || !spec.id) return null;
  const roots = Array.isArray(spec.roots) ? spec.roots : (typeof spec.roots === 'string' ? [spec.roots] : []);
  const kind = String(spec.kind || '');
  if (kind === 'jsonl-message' || (!kind && spec.filePattern)) {
    const pattern = spec.filePattern ? new RegExp(spec.filePattern) : undefined;
    const base = jsonlMessageProfile(spec.id, spec.title || spec.id, { roots, agentFilePattern: pattern });
    const map = spec.fieldMap || {};
    return { ...base, parse: (text) => parseWithFieldMap(text, map) };
  }
  if (kind === 'json-metadata' || (!kind && spec.metaFile)) {
    return jsonMetadataProfile(spec.id, spec.title || spec.id, {
      roots, metaFile: spec.metaFile || 'metadata.json', fieldMap: spec.fieldMap || {},
    });
  }
  if (kind === 'sqlite-conversation') {
    // 懒加载:没有配置 SQLite 来源的项目不需要为它付出 import/可用性检查成本。
    // 这里用同步 createRequire 不合适(ESM),改为动态 import 在 resolveAllProfiles 里完成。
    return { ...spec, __lazySqlite: true };
  }
  // 未知 kind:保留为不可发现的占位,但明确标注(不静默当成可用)
  return {
    id: spec.id, title: spec.title || spec.id, roots: () => roots,
    transcriptless: true, discover: async () => [], parse: () => null,
    _unsupportedKind: kind || '(missing)',
  };
};

// 合并:内置 + 声明式(manifest)+ 函数式(宿主注入)。
// 异步是为了懒加载可选的 SQLite 描述符;未配置该 kind 的项目不会 import 它。
export const resolveAllProfiles = async ({ builtin = BUILTIN_PROFILES, specs = [], fns = [] } = {}) => {
  const list = [...builtin];
  const upsert = (p) => {
    if (!p || !p.id) return;
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = { ...list[i], ...p }; else list.push(p);
  };
  for (const spec of Array.isArray(specs) ? specs : []) {
    const p = profileFromSpec(spec);
    if (p && p.__lazySqlite) {
      const mod = await import('./rescue-sqlite-profile.mjs');
      upsert(mod.sqliteConversationProfile(spec));
    } else {
      upsert(p);
    }
  }
  for (const fn of Array.isArray(fns) ? fns : []) upsert(fn);
  return list;
};

/* ------------------------------------------------------------------ */
/* 旧接力单兼容(T058 之前用 state.harness 记来源)                        */
/* ------------------------------------------------------------------ */

// T058 之前的 state.harness 真实取值(按 T048 实现 d33d7b2 逐行核对):
//   'zcode'  → 一层目录一份 metadata.json,无可复制对话 → 元数据型   【真实写入过】
//   'claude' → 一行一条 JSON 的 transcript 文件       → 记录型     【真实写入过】
//   'explicit' 只在读取分支里被比较过(state.harness === 'explicit'),**从无赋值点**:
//   T048 的显式 source 会按文件形态落成 'zcode' 或 'claude'。这里保留该键只为兼容
//   可能存在的第三方/历史变体,不宣称它是官方持久化值。
// 放在描述符层而不是核心:核心不认识任何具体来源名,只问「这个旧值对应哪个描述符」。
const LEGACY_HARNESS_ALIASES = Object.freeze({
  zcode: 'json-meta',
  claude: 'jsonl-agent',
  explicit: 'jsonl-agent', // 从未被本引擎写入;兼容未知变体
});

// 把旧 harness 值映射到内置描述符 id;非旧值返回 ''(调用方据此判定「未注册」并显式报错)。
export const legacyProfileFor = (value) => {
  const key = String(value || '').toLowerCase();
  return LEGACY_HARNESS_ALIASES[key] || '';
};
