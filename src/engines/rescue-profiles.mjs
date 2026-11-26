// relay-mcp — 来源格式描述符(profile)契约。
//
// 设计铁律:**核心引擎不认识任何具体 harness**。
//   rescue.mjs 只依赖本文件定义的描述符接口;具体 harness 的目录布局、文件命名、字段映射、
//   记录格式全部收敛为「一份声明式描述」(profile)。
//   新增一个 harness = 新增一份描述,不改核心代码;用户也可以在自己的项目里写描述符。
//
// 一个 profile 的形状:
//   {
//     id:      string          唯一名(写入接力单 state.harness)
//     title:   string          人类可读名(仅用于输出,不参与逻辑)
//     roots:   (home) => string[]   该格式在哪些根目录下找候选(空数组 = 需要显式 source)
//     discover(root, ctx) => Promise<Candidate[]>   在单个 root 下枚举候选
//     parse(text) => Parsed|null                    把 transcript 文本解析成结构化摘要
//     transcriptless?: boolean  true = 该格式不提供可复制的 transcript(只有元数据)
//   }
//
//   Candidate 统一字段(引擎只读这些,不读 harness 私有字段):
//     { sourcePath, agentId, parentSessionId, transcriptPath?, cwd?, status?, error?,
//       prompt?, description?, profile?, createdAt?, updatedAt?, mtimeMs? }
//
//   Parsed 统一字段:
//     { prompt, cwd, gitBranch, sessionId, agentId, edits[], commands[], todos[],
//       narrative, recordCount, toolSignals }
//     toolSignals = { pendingToolUse, lastRecordKind, trailingToolError, apiError, anyToolError }
//     —— 引擎只根据 toolSignals 做**确定性分类**,不含任何 harness 语义。
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
    apiError: null,
  };
  const edits = [];
  const commands = [];
  const todos = [];
  let prompt = '';
  let narrative = '';
  let lastRole = '';

  for (const rec of records) {
    const msg = asMessage(rec, { roleField: m.role, contentPath: m.contentPath });
    if (!msg) continue;
    const { role, content } = msg;
    // 记录级 API 错误标记:最优先,后续分类据此判定 quota/error
    if (rec[m.apiErrorMarker] === true) {
      sig.lastRecordKind = 'api-error';
      let errText = '';
      let cur = rec;
      for (const seg of String(m.apiErrorTextPath).split('.')) { cur = cur == null ? null : cur[seg]; }
      if (typeof cur === 'string') errText = cur;
      else {
        const blocks = asBlocks(content).filter((b) => m.textTypes.includes(b.type));
        errText = blocks.map((b) => String(b.text ?? '')).join(' ');
      }
      let code = '';
      let status = null;
      let c2 = rec;
      for (const seg of String(m.apiErrorCodePath).split('.')) { c2 = c2 == null ? null : c2[seg]; }
      if (typeof c2 === 'string') code = c2;
      const st = Number(rec[m.apiErrorStatusPath]);
      if (Number.isFinite(st)) status = st;
      sig.apiError = { code, status, text: clip(errText, 400) };
      lastRole = 'api-error';
      continue;
    }
    const isAssistant = m.assistantIds.includes(role);
    const isUser = m.userIds.includes(role);
    if (isAssistant) {
      sig.lastRecordKind = 'assistant';
      lastRole = 'assistant';
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
        }
      }
    } else if (isUser) {
      const blocks = asBlocks(content).filter((b) => m.toolResultTypes.includes(b.type));
      if (blocks.length) {
        sig.lastRecordKind = 'user-result';
        lastRole = 'user-result';
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
  return {
    prompt,
    cwd: String(first[m.cwdField] || ''),
    gitBranch: String(first[m.branchField] || ''),
    sessionId: String(first[m.sessionField] || ''),
    agentId: String(first[m.agentField] || ''),
    edits,
    commands,
    todos: [...new Set(todos)],
    narrative,
    recordCount: records.length,
    toolSignals: sig,
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
          profile: pick(meta, map.profile),
          createdAt: pick(meta, map.createdAt),
          updatedAt: pick(meta, map.updatedAt),
          mtimeMs: Number.isFinite(updated) ? updated : 0,
        });
        if (out.length >= 400) return out;
      }
    }
    return out;
  },
  parse: () => null,
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
  // 未知 kind:保留为不可发现的占位,但明确标注(不静默当成可用)
  return {
    id: spec.id, title: spec.title || spec.id, roots: () => roots,
    transcriptless: true, discover: async () => [], parse: () => null,
    _unsupportedKind: kind || '(missing)',
  };
};

// 合并:内置 + 声明式(manifest)+ 函数式(宿主注入)。
export const resolveAllProfiles = ({ builtin = BUILTIN_PROFILES, specs = [], fns = [] } = {}) => {
  const list = [...builtin];
  const upsert = (p) => {
    if (!p || !p.id) return;
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = { ...list[i], ...p }; else list.push(p);
  };
  for (const spec of Array.isArray(specs) ? specs : []) upsert(profileFromSpec(spec));
  for (const fn of Array.isArray(fns) ? fns : []) upsert(fn);
  return list;
};
