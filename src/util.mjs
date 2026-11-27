// relay-mcp — 公共文件/Git/锁/结果助手
// 零依赖公共助手:fs / git / 时间戳。仅使用 node: 内置模块。
import {
  access, readFile, readdir, writeFile, mkdir, rename, link, stat, lstat, unlink, utimes, open as fsOpen2,
} from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

// —— 测试用计数追踪(T022)——
// 只在 RELAY_TRACE_FILE 存在时启用:记录 readFileSafe 的按文件读取次数、git 子进程数(含同步)。
// 用途:smoke-perf 用**确定性计数断言**(不用计时阈值)验证「单轮 verify 只读一次 LOG/TASKS/manifest」。
const TRACE_FILE = process.env.RELAY_TRACE_FILE || '';
const trace = { reads: {}, git: 0, sync: 0 };
const traceRead = (p) => {
  if (!TRACE_FILE) return;
  const k = path.basename(String(p || ''));
  trace.reads[k] = (trace.reads[k] || 0) + 1;
};
const traceGit = (sync = false) => {
  if (!TRACE_FILE) return;
  trace.git += 1;
  if (sync) trace.sync += 1;
};
if (TRACE_FILE) {
  process.on('exit', () => {
    try { writeFileSync(TRACE_FILE, JSON.stringify(trace)); } catch { /* 追踪失败不影响主流程 */ }
  });
}

// relay-mcp/templates 绝对路径:基于本文件(src/util.mjs)向上一级再进 templates
export const templatesDir = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const toolOk = (text) => ({ content: [{ type: 'text', text }], isError: false });
export const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
export const toolText = (text, isError = false) => isError ? toolError(text) : { content: [{ type: 'text', text }] };

export const pathExists = async (p) => {
  try { await access(p); return true; } catch { return false; }
};

export const firstLine = (value, maxLength = 160) =>
  (String(value || '').trim().split('\n')[0] || '').slice(0, maxLength);

// 读文件,不存在(或不可读)返回 fallback
export const readFileSafe = async (p, fallback = null, { onlyMissing = false } = {}) => {
  traceRead(p);
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if (onlyMissing && e?.code !== 'ENOENT') throw e;
    return fallback;
  }
};

export const readTextOrNull = async (p) => {
  const text = await readFileSafe(p, null);
  return typeof text === 'string' ? text : null;
};

// 已存在则返回 false 不覆盖;成功写入返回 true;其余错误向上抛
export const writeFileIfAbsent = async (p, content) => {
  try {
    await writeFile(p, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
};

// 自动备份最多保留 20 份。备份是运行时恢复面,不能无限增长;按文件名中的
// 秒级时间戳和同秒序号保留最新,不让旧备份长期挤占工作树。
export const MAX_BACKUP_FILES = 20;
export const pruneBackupFiles = async (target) => {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.relay-bak-`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const engineGenerated = new RegExp(
    `^${escaped}(?:\\d{14}(?:-\\d+)?|new-\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
  );
  const names = (await readdir(dir)).filter((name) => engineGenerated.test(name));
  const ranked = await Promise.all(names.map(async (name) => {
    const st = await stat(path.join(dir, name)).catch(() => null);
    return { name, mtimeMs: st?.mtimeMs || 0 };
  }));
  names.sort((a, b) => {
    const at = ranked.find((row) => row.name === a)?.mtimeMs || 0;
    const bt = ranked.find((row) => row.name === b)?.mtimeMs || 0;
    return bt - at || b.localeCompare(a);
  });
  await Promise.all(names.slice(MAX_BACKUP_FILES).map((name) => unlink(path.join(dir, name)).catch(() => {})));
};

// 存在则改名为 <p>.relay-bak-<yyyyMMddHHmmss>,返回新路径;不存在返回 null
export const backupFile = async (p) => {
  let st;
  try {
    st = await stat(p);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // 同一秒内多次 force/onboard(CI、脚本循环)会撞名:rename 到已存在路径会**覆盖**前一份备份。
  // 加序号保证每次备份都独立存在(审计 P2:原 LOG 的备份被后一份覆盖丢失)。
  const sameSecond = (await readdir(path.dirname(p)))
    .map((name) => name.match(new RegExp(`^${path.basename(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.relay-bak-${ts}(?:-(\\d+))?$`)))
    .filter(Boolean)
    .map((match) => Number(match[1]) || 1);
  const nextSequence = sameSecond.length ? Math.max(...sameSecond) + 1 : 1;
  let backup = nextSequence === 1
    ? `${p}.relay-bak-${ts}`
    : `${p}.relay-bak-${ts}-${nextSequence}`;
  for (let i = nextSequence; ; i++) {
    try {
      await lstat(backup);
      backup = `${p}.relay-bak-${ts}-${i + 1}`;
    } catch {
      break;
    }
  }
  await rename(p, backup);
  await pruneBackupFiles(p).catch(() => {});
  return backup;
};

// root 目录本身是否是一个 git 仓库(而非恰好位于某个外层仓库之内)。
// 两侧都过 realpath:macOS 的 /tmp→/private/tmp、/var→/private/var 符号链接
// 会让字符串比较永远不等,把真仓库误判成"非 git 仓库"。
// P1-6(审计):同步探测版已删除——MCP server 是长驻进程,
// 任何同步 spawn 都会冻结事件循环;所有调用方统一走 isGitRepoAsync。
// 异步版 isGitRepoAsync(T022):fs 快路径先看 root/.git(普通仓库是目录;linked worktree 是文件,
// 两者都意味着 root 自身是仓库根)→ 命中则**零子进程**;未命中再回退 git rev-parse,
// 兼容「root 是仓库子目录」的情形(此时 .git 不在 root 下)。
export const isGitRepoAsync = async (root) => {
  if (typeof root !== 'string' || root === '') return false;
  try {
    const st = await stat(path.join(root, '.git'));
    if (st.isDirectory() || st.isFile()) return true;
  } catch { /* 无 .git → 回退 git 探测 */ }
  const real = async (p) => {
    try { return await realpath(p); } catch { return path.resolve(p); }
  };
  traceGit(false);
  const r = await gitRun(root, 'rev-parse', '--show-toplevel');
  if (!r.ok || !r.stdout.trim()) return false;
  return (await real(r.stdout.trim())) === (await real(root));
};

// execFile('git', ['-C', root, ...args]) 包装:8 秒超时,永不抛错
// 返回 {ok, stdout, stderr};ok = exit 0
// env 只用于给单条 git 命令追加环境(如抢救快照的临时 GIT_INDEX_FILE),不读也不改全局配置。
export const gitRun = async (root, ...rest) => {
  const last = rest[rest.length - 1];
  const opts = last && typeof last === 'object' && !Array.isArray(last) && last.__gitOpts === true ? last : null;
  const args = opts ? rest.slice(0, -1) : rest;
  traceGit(false);
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', root, ...args],
      {
        timeout: 8000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
        ...(opts && opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
    );
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? '') || String(e?.message ?? 'git failed'),
    };
  }
};

// NUL 分隔保留文件名原样;关闭 rename 推断使重命名的两端各自成为独立记录。
export const gitStatusPaths = async (root) => {
  const status = await gitRun(root, 'status', '--porcelain', '-z', '--no-renames', '-uall');
  const paths = status.ok ? status.stdout.split('\0').filter(Boolean).map((record) => record.slice(3)) : [];
  return { ...status, paths };
};

// recursive mkdir
export const ensureDir = async (p) => {
  await mkdir(p, { recursive: true });
};

// 身份兜底探测 + 仅本条命令生效的配置注入参数。
// CI 容器常无 user.name/email:Linux git 直接拒绝提交(macOS 用 hostname 兜底)——
// 曾导致"本地绿 CI 红"。用户已配置任一身份 → 返回 [];否则返回前置注入参数
// (形式为 `git <注入> commit …`;注意必须放在子命令之前——`git commit -c` 是"复用消息",
// 与配置注入完全是两回事),不写全局配置。
export const gitIdentityArgs = async (root) => {
  for (const k of ['user.name', 'user.email']) {
    const r = await gitRun(root, 'config', k);
    if (r.ok && r.stdout.trim()) return [];
  }
  return ['-c', 'user.name=relay-bot', '-c', 'user.email=relay-bot@localhost'];
};

// 'YYYY-MM-DD HH:mm' 本地时间
export const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

// ISO 日期时间
export const nowIso = () => new Date().toISOString();

// —— 疑似密钥文件守卫(H3/H-B):在场即不自动提交,强制人类过目 ——
// 单一实现,session_end / init / onboard / restructure 各自动提交点共用
export const SECRET_RULES = [
  [/(^|\/)\.env(\.[^/]+)?$/i, '.env 疑似密钥'],
  [/(^|\/)[^/]*secret[^/]*$/i, '文件名含 secret'],
  [/(^|\/)[^/]*credential[^/]*$/i, '文件名含 credential'],
  [/\.(key|pem)$/i, '*.key / *.pem 私钥'],
  [/(^|\/)id_rsa(\.[^/]+)?$/i, 'id_rsa 私钥'],
];
/** @internal 旧 porcelain 文本调用方兼容。引擎使用 findSensitivePaths 处理原始路径。 */
export const findSensitiveChanges = (statusLines) => {
  const paths = [];
  for (const line of statusLines || []) {
    if (line.length < 4) continue;
    for (const raw of line.slice(3).split(' -> ')) {
      let p = raw.trim();
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      paths.push(p);
    }
  }
  return findSensitivePaths(paths);
};
export const findSensitivePaths = (paths) => {
  const hits = new Map();
  for (const p of paths) {
    const rule = SECRET_RULES.find(([re]) => re.test(p));
    if (rule) hits.set(p, rule[1]);
  }
  return [...hits.entries()].map(([path, why]) => ({ path, why })).sort((a, b) => a.path.localeCompare(b.path));
};

// —— 协议文件内容级密钥扫描(R11)——
// SECRET_RULES/findSensitivePaths 只看路径;这里补内容级扫描。
// 规则刻意窄:宁可漏掉冷门格式,也不要误报把出场绿闸变成噪音源。
// 一行只报一条,preview 只保留前 4 字符——扫描结果会进简报/LOG,绝不能回显完整密钥。
export const SECRET_OK_MARKER = 'relay:secret-ok';
// 规则集覆盖主流 provider 的**带连字符前缀**(旧规则 sk-[A-Za-z0-9]{20,} 会漏掉 sk-ant-/sk-proj-,
// 而 sk-ant-* 恰是 Claude/Anthropic 生态最常被写进日志的形态)。
export const SECRET_CONTENT_RULES = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub classic token', /gh[pous]_[A-Za-z0-9]{36}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI project key', /sk-proj-[A-Za-z0-9_-]{20,}/],
  ['OpenAI legacy key', /sk-[A-Za-z0-9]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// 默认 fail-closed:不接受 relay:secret-ok 豁免。只有 R11(探测器)显式 allowMarker=true,
// 且会把被豁免的行数写进输出——豁免必须可见,不能靠模型自己写一行标记就静默放行。
export const scanSecrets = (text, { allowMarker = false } = {}) => {
  const hits = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (allowMarker && lines[i].includes(SECRET_OK_MARKER)) continue;
    for (const [rule, re] of SECRET_CONTENT_RULES) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      hits.push({ rule, line: i + 1, preview: `${m[0].slice(0, 4)}…(${m[0].length} chars)` });
      break; // 一行只报一条,避免同一行刷屏
    }
  }
  return hits;
};
export const formatSecretHits = (hits, file = '') =>
  (hits || []).map((h) => `${file ? `${file}:` : ''}${h.line} 命中 ${h.rule} ${h.preview}`).join('; ');
// 输出脱敏:把文本里的密钥样式串就地替换为 [REDACTED:规则名],并保留首 4 字符便于辨认。
// 与 scanSecrets 的区别:scanSecrets 只报告位置(供 R11 阻断),redactSecrets 用于「会把不可信文本
// 回显给模型」的路径(rescue 的 transcript 片段),避免密钥随上下文继续扩散。
// 只影响展示;落盘内容不变(写入前的阻断仍由 scanSecrets / writeProtocolFile 负责)。
export const redactSecrets = (text) => {
  let out = String(text ?? '');
  const hits = [];
  for (const [rule, re] of SECRET_CONTENT_RULES) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(global, (m) => {
      hits.push(rule);
      return `[REDACTED:${rule}:${m.slice(0, 4)}…]`;
    });
  }
  return { text: out, hits };
};

// =====================================================================
// 协议文件安全写 / 符号链接防线 / 锁协议(JSON v2,兼容旧文本 v1)
// =====================================================================

// 校验「root 之下某条相对路径的每一级已存在组件都不是符号链接」。
// .relay / .relay/claims / 自定义 cacheDir 以及 TASKS/LOG/锁/注册表都必须先过这一关:
// 否则一条指向仓库外的符号链接就能把协议文件写到不该写的地方。
// 写盘前布局安全闸(init/onboard/archive 用):root 自身与「将要写入的每个路径」的
// 既有目录组件都不能是符号链接——否则一条 `docs -> /tmp/out` 的链接就能把整棵骨架
// 或归档文件写到仓库之外(审计 P0-1:init/onboard 不经过 claim/session_end 的协议闸)。
export const assertSafeWriteLayout = async (root, relPaths = [], label = '写入') => {
  const rootAbs = path.resolve(root);
  let rootSt = null;
  try { rootSt = await lstat(rootAbs); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  if (rootSt && rootSt.isSymbolicLink()) {
    throw new Error(`${label} 拒绝执行:root(${rootAbs})是符号链接,可能把文件写到别处;请改用真实目录`);
  }
  const dirs = new Set();
  for (const rel of relPaths) {
    const parts = String(rel ?? '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
    parts.pop(); // 文件本身不在此检查(写原语另有文件级守卫)
    let cur = rootAbs;
    for (const part of parts) { cur = path.join(cur, part); dirs.add(cur); }
  }
  for (const dir of dirs) {
    let st = null;
    try { st = await lstat(dir); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) {
      throw new Error(`${label} 拒绝写入:${path.relative(rootAbs, dir) || '(root)'} 是符号链接,会把文件写到仓库之外;请移除该符号链接或改用仓库内真实目录后重试`);
    }
    if (!st.isDirectory()) throw new Error(`${label} 拒绝写入:${path.relative(rootAbs, dir)} 不是目录`);
  }
};

export const assertNoSymlinkComponents = async (root, relPath, label = '') => {
  const rootAbs = path.resolve(root);
  const parts = String(relPath ?? '').split(/[\\/]+/).filter((s) => s && s !== '.');
  let cur = rootAbs;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st = null;
    try { st = await lstat(cur); } catch (e) {
      if (e && e.code === 'ENOENT') return; // 其余层级尚不存在,由 ensureDir 新建
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${label || relPath} 路径含符号链接(${cur}),拒绝在符号链接下写入协议文件`);
    }
    if (!st.isDirectory()) {
      throw new Error(`${label || relPath} 路径组件不是目录(${cur}),拒绝写入协议文件`);
    }
  }
};

// 单文件符号链接守卫:目标已存在时必须是普通文件(不是 symlink/目录/FIFO)。
export const assertNotSymlinkFile = async (p, label = '') => {
  let st = null;
  try { st = await lstat(p); } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`${label || p} 是符号链接,拒绝读写:协议文件/锁必须是仓库内普通文件(符号链接可把写入引到仓库外)`);
  }
  if (!st.isFile()) {
    throw new Error(`${label || p} 不是普通文件(可能是目录/设备/FIFO),拒绝读写`);
  }
};

// 原子写:同目录临时文件 + rename,失败清理;可选 fencing 回调在 rename 之前复核锁仍属于本会话。
export const writeFileAtomic = async (
  target,
  content,
  { fencing = null, label = '', createOnly = false, expectedHash = null } = {},
) => {
  await assertNotSymlinkFile(target, label);
  const dir = path.dirname(target);
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat && dirStat.isSymbolicLink()) {
    throw new Error(`${label || target} 所在目录是符号链接(${dir}),拒绝写入`);
  }
  const initialStat = expectedHash == null ? null : await lstat(target).catch((e) => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (expectedHash != null) {
    const current = await readFile(target, 'utf8').catch((e) => {
      if (e?.code === 'ENOENT') return '';
      throw e;
    });
    const actual = sha256Hex(current);
    if (actual !== expectedHash) throw new ProtocolConflictError(label || path.basename(target), { expected: expectedHash, actual });
  }
  const tmp = path.join(dir, `.${path.basename(target)}.relay-tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(tmp, content, { encoding: 'utf8' });
    if (fencing) {
      const verdict = await fencing();
      if (!verdict || verdict.ok !== true) {
        throw new Error(`锁 fencing 校验失败:${verdict?.warning || '写入前发现仓库锁已不属于当前会话'}`);
      }
    }
    if (expectedHash != null) {
      // 便携式 Node 没有原子的内容 compare-and-swap。这里在发布前重读内容、inode、
      // mtime 与 size,把 check→rename 窗口压到最小;非协作写入仍可能在最后一条指令前抢入,
      // 但正常编辑器和并发 relay 进程会在确定性测试覆盖的窗口内被拒绝。
      const finalStat = await lstat(target).catch((e) => {
        if (e?.code === 'ENOENT') return null;
        throw e;
      });
      const sameIdentity = initialStat == null
        ? finalStat == null
        : !!finalStat
          && finalStat.dev === initialStat.dev
          && finalStat.ino === initialStat.ino
          && finalStat.size === initialStat.size
          && finalStat.mtimeMs === initialStat.mtimeMs;
      const current = await readFile(target, 'utf8').catch((e) => {
        if (e?.code === 'ENOENT') return '';
        throw e;
      });
      const actual = sha256Hex(current);
      if (!sameIdentity || actual !== expectedHash) {
        throw new ProtocolConflictError(label || path.basename(target), { expected: expectedHash, actual });
      }
    }
    if (!createOnly) {
      await rename(tmp, target);
    } else {
      // link 同样原子发布完整内容,且目标已存在时不会替换原文件。
      try { await link(tmp, target); }
      catch (e) { if (e?.code === 'EEXIST') return false; throw e; }
    }
    return true;
  } finally {
    await unlink(tmp).catch(() => { /* 已 rename 或写失败 */ });
  }
};

// 协议控制面文件(TASKS.md/LOG.md)写前检查 + 原子写(fencing token 由调用方提供)。
export const PROTOCOL_FILE_NAMES = ['TASKS.md', 'LOG.md'];
export const checkProtocolFilesSafe = async (root) => {
  try {
    for (const name of PROTOCOL_FILE_NAMES) await assertNotSymlinkFile(path.join(root, name), name);
    await assertNoSymlinkComponents(root, '.relay', '.relay 目录');
    await assertNotSymlinkFile(path.join(root, '.relay', 'last-failure.json'), '.relay/last-failure.json');
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
};
// 写入原语级密钥闸(P1-6):TASKS/LOG 只能经由本函数落盘,任何调用点(claim / session_end / 未来工具)
// 都自动受保护。检测器(R11)只负责报告,拦截发生在写之前——fail-closed。
export class ProtocolSecretError extends Error {
  constructor(hits, label) {
    super(`${label} 含疑似密钥内容(${hits.length} 处),已阻断写入`);
    this.name = 'ProtocolSecretError';
    this.code = 'RELAY_SECRET';
    this.hits = hits;
    this.label = label;
  }
}
// T002:内容 CAS。锁只约束守规矩的 relay 进程;人类手改、旧版本进程、TTL 接管窗口都能绕过锁,
// 只有「写入前重读磁盘并比对内容哈希」能让「基于旧快照的覆写」fail-closed。
export const sha256Hex = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
export class ProtocolConflictError extends Error {
  constructor(name, { expected = '', actual = '' } = {}) {
    super(`${name} 在读取后被其他写入者修改(内容 CAS 失败:期望 ${String(expected).slice(0, 12)}… 实际 ${String(actual).slice(0, 12)}…),已阻断写入;请重读后重试`);
    this.name = 'ProtocolConflictError';
    this.code = 'RELAY_CONFLICT';
    this.file = name;
    this.expected = expected;
    this.actual = actual;
  }
}
export const writeProtocolFile = async (root, name, content, { token = '', lockLabel = '仓库写锁', expectedHash = '' } = {}) => {
  // 崩溃点矩阵(测试钩子):RELAY_CRASH_AT_WRITE=N 在第 N+1 次协议写之前立刻退出,
  // 用来验证「半途崩溃后重跑必收敛」。生产环境不设置该变量时行为完全不变。
  if (process.env.RELAY_TEST_HOOKS === '1' && process.env.RELAY_CRASH_AT_WRITE != null) {
    const n = Number(process.env.RELAY_CRASH_AT_WRITE);
    globalThis.__relayProtocolWrites = (globalThis.__relayProtocolWrites || 0) + 1;
    if (Number.isFinite(n) && globalThis.__relayProtocolWrites > n) process.exit(137);
  }
  const hits = scanSecrets(content); // 不接受标记豁免:模型可写的标记不能当绕过凭证
  if (hits.length) throw new ProtocolSecretError(hits, name);
  const target = path.join(root, name);
  await writeFileAtomic(target, content, {
    label: name,
    expectedHash: expectedHash || null,
    fencing: token
      ? async () => {
        const verdict = await verifyRepoLock(root, token);
        return verdict.held ? { ok: true } : { ok: false, warning: `${lockLabel}已不属于当前会话(${verdict.warning || '锁已被接管'})` };
      }
      : null,
  });
};

// —— 锁协议 ——
// 新格式:单行 JSON {version,holder,token,acquiredAt,pid};holder/model 里的换行/特殊字符由 JSON 转义,
// 不再用「第 N 行」定位 token(旧文本格式 model 含换行会让 token 变成 lines[3],释放/归属全部失效)。
// 旧格式只读兼容:token = 最后一个非空行(且不能是 ISO 时间戳)。
export const REPO_LOCK_REL = '.relay/relay.lock';
export const STALE_REPO_LOCK_MS = 120_000;
export const LOCK_VERSION = 2;
// 心跳:持锁期间定期刷新锁文件 mtime,长任务(cleanup 逐 worktree git status 等)不会被 120s 判死;
// 空/半初始化锁的接管宽限:远大于 open→write 的窗口,避免把「刚创建还没写完」的锁误判为崩溃残留。
const numEnv = (name, fallback, min) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
};
let lockHeartbeatMs = numEnv('RELAY_LOCK_HEARTBEAT_MS', 20_000, 50);
let emptyLockGraceMs = numEnv('RELAY_LOCK_EMPTY_GRACE_MS', 2_000, 10);
// 仅供冒烟测试缩短心跳/宽限(不改默认行为);返回还原函数。
export const __setLockTimingForTest = ({ heartbeatMs, emptyGraceMs } = {}) => {
  const prev = { heartbeatMs: lockHeartbeatMs, emptyGraceMs: emptyLockGraceMs };
  if (Number.isFinite(heartbeatMs) && heartbeatMs >= 0) lockHeartbeatMs = heartbeatMs;
  if (Number.isFinite(emptyGraceMs) && emptyGraceMs >= 1) emptyLockGraceMs = emptyGraceMs;
  return () => { lockHeartbeatMs = prev.heartbeatMs; emptyLockGraceMs = prev.emptyGraceMs; };
};

export const serializeLock = ({ holder, token, acquiredAt, ttlMinutes }) => `${JSON.stringify({
  version: LOCK_VERSION,
  holder: String(holder ?? ''),
  token: String(token ?? ''),
  acquiredAt: acquiredAt || new Date().toISOString(),
  pid: process.pid,
  // 认领锁把真实 TTL 落盘,doctor 才能判断「过期」而不是硬编码 240 分钟(P1-13)
  ...(Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? { ttlMinutes } : {}),
})}\n`;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;
export const parseLockContent = (raw) => {
  const text = String(raw ?? '');
  const empty = { holder: '', token: '', acquiredAt: '', legacy: false, empty: true, corrupt: false };
  if (!text.trim()) return empty;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const token = typeof parsed.token === 'string' ? parsed.token : '';
      const holder = typeof parsed.holder === 'string' ? parsed.holder : '';
      if (token) return {
        holder, token,
        acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
        ttlMinutes: Number.isFinite(parsed.ttlMinutes) && parsed.ttlMinutes > 0 ? parsed.ttlMinutes : null,
        legacy: false, empty: false, corrupt: false,
      };
      // 合法 JSON 但没有 token = 半初始化(进程在写内容前崩溃)
      return { holder, token: '', acquiredAt: '', legacy: false, empty: true, corrupt: false };
    }
  } catch { /* 旧文本格式,继续按行解析 */ }
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return empty;
  const holder = lines[0];
  const acquiredAt = lines.length >= 2 && ISO_RE.test(lines[1]) ? lines[1] : '';
  const last = lines[lines.length - 1];
  const token = lines.length >= 3 && !ISO_RE.test(last) ? last : '';
  return { holder, token, acquiredAt, legacy: true, empty: !token, corrupt: !token };
};

// 认领锁(heartbeat:false)以锁内 acquiredAt 为唯一年龄真相源;仓库写锁用心跳刷新的 mtime。
// 无法证明过期时绝不接管:旧文本缺时间、空锁/损坏锁都交给宽限期或人工诊断。
export const DEFAULT_CLAIM_TTL_MINUTES = 240;
export const claimLockExpiry = (info, { now = Date.now(), defaultTtlMinutes = DEFAULT_CLAIM_TTL_MINUTES, overrideTtlMinutes = null } = {}) => {
  // 优先级:调用方本次显式 TTL(ttl_minutes 覆盖)> 锁内记录的真实 TTL > 默认 240。
  // 若固定优先锁内值,调用方传更短 TTL 想强制接管时会被旧锁记录的 240 分钟挡住。
  const hasOverride = Number.isFinite(overrideTtlMinutes) && overrideTtlMinutes > 0;
  const hasLockTtl = Number.isFinite(info?.ttlMinutes) && info.ttlMinutes > 0;
  const ttlMinutes = hasOverride ? overrideTtlMinutes : (hasLockTtl ? info.ttlMinutes : defaultTtlMinutes);
  const ttlSource = hasOverride ? 'override' : (hasLockTtl ? 'lock' : 'default');
  if (!info?.token) return { expired: false, ageMinutes: null, ttlMinutes, ttlSource, reason: 'missing-token' };
  const acquiredMs = info.acquiredAt ? Date.parse(info.acquiredAt) : NaN;
  if (!Number.isFinite(acquiredMs)) {
    return { expired: false, ageMinutes: null, ttlMinutes, ttlSource, reason: 'missing-or-invalid-acquiredAt' };
  }
  const ageMinutes = Math.max(0, now - acquiredMs) / 60000;
  return {
    expired: ageMinutes > ttlMinutes,
    ageMinutes, ttlMinutes, ttlSource,
    reason: ageMinutes > ttlMinutes ? 'ttl-expired' : 'within-ttl',
  };
};

const readLockSnapshot = async (file) => {
  // 锁路径必须是稳定普通文件。读取前后各取一次 lstat,把 symlink/inode 替换
  // 和边读边改写压成 fail-closed,供 acquire/check/release 共用。
  const before = await lstat(file).catch(() => null);
  if (!before) return null;
  if (before.isSymbolicLink()) {
    return { unsafe: 'symlink', raw: '', info: { holder: '(符号链接)', token: '', acquiredAt: '', legacy: false, empty: false, corrupt: true }, ageMs: 0 };
  }
  if (!before.isFile()) {
    return { unsafe: 'not-file', raw: '', info: { holder: '(非普通文件)', token: '', acquiredAt: '', legacy: false, empty: false, corrupt: true }, ageMs: 0 };
  }
  let raw;
  try {
    raw = String(await readFile(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const after = await lstat(file).catch(() => null);
  if (!after || after.isSymbolicLink() || !after.isFile()) {
    return {
      unsafe: !after ? 'disappeared' : (after.isSymbolicLink() ? 'symlink' : 'not-file'),
      raw: '', info: parseLockContent(raw), ageMs: 0,
    };
  }
  const sameIdentity = before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
  if (!sameIdentity) {
    return { unsafe: 'changed', raw: '', info: parseLockContent(raw), ageMs: Math.max(0, Date.now() - after.mtimeMs) };
  }
  const info = parseLockContent(raw);
  const ageMs = Math.max(0, Date.now() - after.mtimeMs);
  return {
    raw, info, ageMs,
    dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs,
  };
};

const lockUnsafeReason = (unsafe) => {
  if (unsafe === 'symlink') return '符号链接';
  if (unsafe === 'not-file') return '非普通文件';
  if (unsafe === 'changed') return '同路径的其他文件';
  if (unsafe === 'disappeared') return '已消失';
  return String(unsafe || '未知变化');
};

const sameLockSnapshot = (a, b) => !!a && !!b
  && !a.unsafe && !b.unsafe
  && a.dev === b.dev
  && a.ino === b.ino
  && a.size === b.size
  && a.mtimeMs === b.mtimeMs
  && a.raw === b.raw;

// 通用文件锁(仓库写锁 / 认领锁共用):
//   · O_EXCL 创建后立刻写 JSON;写失败清理锁文件(不留空锁)
//   · 旧文本格式兼容读取,token 取最后一行非空行
//   · 空/半初始化锁:宽限期后按「内容比对」安全接管(不会误删别人刚换上的新锁)
//   · 持锁心跳(默认 20s,unref,可用 heartbeat:false 关闭):长临界区不会被 120s stale 规则判死;
//     认领锁刻意关闭心跳以保留 240min TTL 的崩溃恢复语义
//   · check()/fencing:写前复核 token 仍是自己的,被接管时拒绝写入
export const acquireFileLock = async (root, relPath, holder, {
  staleMs = STALE_REPO_LOCK_MS,
  waitMs = 0,
  sameHolder = null,
  label = '文件锁',
  onTakeover = null,
  heartbeat = true,
  ttlMinutes = null,
} = {}) => {
  const rootAbs = path.resolve(root);
  const file = path.join(rootAbs, relPath);
  // 目录链(排除锁文件本身)不得含符号链接;锁文件本身若已存在必须是普通文件(不能是 symlink/目录)。
  await assertNoSymlinkComponents(rootAbs, path.dirname(relPath), label);
  await assertNotSymlinkFile(file, label);
  await ensureDir(path.dirname(file));
  const token = randomUUID();
  const acquiredAt = new Date().toISOString();
  const deadline = Date.now() + waitMs;
  const newLockTtl = ttlMinutes ?? (heartbeat ? null : staleMs / 60000);
  let tookOver = '';
  let waitSignalSent = false;
  for (;;) {
    let handle = null;
    let opened = false;
    try {
      handle = await fsOpen2(file, 'wx');
      opened = true;
      await handle.writeFile(serializeLock({ holder, token, acquiredAt, ttlMinutes: newLockTtl }), 'utf8');
      await handle.close();
      handle = null;
      return makeLockHandle({ root: rootAbs, relPath, file, token, holder, created: true, tookOver, label, heartbeat });
    } catch (e) {
      if (handle) { await handle.close().catch(() => {}); handle = null; }
      if (!e || e.code !== 'EEXIST') {
        // 只有本进程 O_EXCL 成功(open 已创建文件)后写内容/close 失败时才清理;
        // open 本身失败(如 EACCES)绝不 unlink,避免误删他人锁。
        if (opened) await unlink(file).catch(() => {});
        throw e;
      }
    }
    // 所有循环路径共享同一 deadline;ENOENT 可立即重试,其余读取错误(含 EACCES)直接有界失败,
    // 不再把异常吞成 continue 形成永久忙等。非 ENOENT 不 unlink,避免误删他人锁。
    if (Date.now() >= deadline && waitMs > 0) {
      const timedOutSnap = await readLockSnapshot(file).catch(() => null);
      const holder = timedOutSnap?.info?.holder || '(未知)';
      return { ok: false, holder, ageMs: timedOutSnap?.ageMs || 0, ageMin: (timedOutSnap?.ageMs || 0) / 60000, staleMs, label, warning: `${label}等待超时(${waitMs}ms)` };
    }
    let snap;
    try {
      snap = await readLockSnapshot(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      throw e;
    }
    if (!snap) continue; // 锁刚好消失 → 立即重试抢位
    if (snap.unsafe) {
      // 获取路径上的 changed/disappeared 是另一个进程正在 O_EXCL 创建或刚释放的
      // 瞬态;在总 deadline 内重试。symlink/非普通文件仍是安全拒绝。
      if (snap.unsafe === 'changed' || snap.unsafe === 'disappeared') continue;
      const why = snap.unsafe === 'symlink'
        ? '路径是符号链接'
        : `路径在读取期间变为 ${lockUnsafeReason(snap.unsafe)}`;
      throw new Error(`${label}${why},拒绝接管`);
    }
    const lockHolder = snap.info.holder || '(未知持有者)';
    if (sameHolder && sameHolder(snap.info.holder)) {
      // 同持有者幂等:沿用既有 token;旧格式缺 token 时原子补写(不再用非原子 writeFile)
      let adoptToken = snap.info.token;
      if (!adoptToken) {
        adoptToken = token;
        await writeFileAtomic(file, serializeLock({
          holder: lockHolder, token: adoptToken, acquiredAt: snap.info.acquiredAt || acquiredAt, ttlMinutes: newLockTtl,
        }), { label, expectedHash: sha256Hex(snap.raw) });
      }
      return makeLockHandle({ root: rootAbs, relPath, file, token: adoptToken, holder: lockHolder, created: false, tookOver: '', label, heartbeat });
    }
    const halfInitialized = !snap.info.token;
    // 空锁仍走 mtime 宽限期(acquiredAt 不存在);完整认领锁只按 acquiredAt 的精确毫秒裁决。
    const expiry = !heartbeat && !halfInitialized
      ? claimLockExpiry(snap.info, {
        defaultTtlMinutes: Number.isFinite(staleMs) ? staleMs / 60000 : DEFAULT_CLAIM_TTL_MINUTES,
        overrideTtlMinutes: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : null,
      })
      : null;
    const canTakeOver = halfInitialized
      ? snap.ageMs > emptyLockGraceMs
      : expiry ? expiry.expired : snap.ageMs > staleMs;
    if (canTakeOver) {
      // 删除前复核内容与 inode;等待期间换上的新锁即使正文完全相同也不能删。
      try {
        const finalSnap = await readLockSnapshot(file);
        if (sameLockSnapshot(snap, finalSnap)) {
          await unlink(file);
          tookOver = lockHolder;
          if (onTakeover) onTakeover(lockHolder);
        }
      } catch (e) {
        // ENOENT = 别的等待者已删除;EACCES/其它错误不能伪装成「已接管」。
        if (!e || e.code !== 'ENOENT') throw e;
      }
      continue;
    }
    if (!waitSignalSent && process.env.RELAY_TEST_HOOKS === '1' && process.env.RELAY_TEST_LOCK_WAIT_SIGNAL) {
      await writeFile(process.env.RELAY_TEST_LOCK_WAIT_SIGNAL, `${holder}\n${lockHolder}\n`, 'utf8');
      waitSignalSent = true;
    }
    if (Date.now() >= deadline) {
      const ageMs = expiry && expiry.ageMinutes != null ? expiry.ageMinutes * 60000 : snap.ageMs;
      return {
        ok: false, holder: snap.info.holder || '(未知持有者)', ageMs, ageMin: ageMs / 60000,
        ttlMin: expiry?.ttlMinutes,
        staleMs, label,
        warning: `${label}被 ${snap.info.holder || '(未知持有者)'} 持有(约 ${Math.round(ageMs / 1000)}s)${expiry ? `;${expiry.reason}` : ''}`,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};

const makeLockHandle = ({ root, relPath, file, token, holder, created, tookOver, label, heartbeat = true }) => {
  let lost = false;
  let heartbeatTimer = null;
  let heartbeatInFlight = null;
  const check = async () => {
    const snap = await readLockSnapshot(file).catch(() => null);
    if (!snap) {
      lost = true;
      return { ok: false, held: false, warning: `${label}已不在场(可能被接管或释放)` };
    }
    if (snap.unsafe) {
      lost = true;
      return { ok: false, held: false, warning: `${label}路径在复核期间变为${lockUnsafeReason(snap.unsafe)}` };
    }
    if (snap.info.token !== token) {
      // 兼容:旧格式/半初始化锁若已被同持有者补写 token,以内容为准
      lost = true;
      return { ok: false, held: false, holder: snap.info.holder, warning: `${label}已被 ${snap.info.holder || '(未知持有者)'} 接管` };
    }
    return { ok: true, held: true, holder: snap.info.holder };
  };
  const touch = async () => {
    const verdict = await check();
    if (!verdict.held) { stopHeartbeat(); return; }
    try {
      const now = new Date();
      await utimes(file, now, now);
    } catch { /* 丢失在下一次 check 体现 */ }
  };
  const stopHeartbeat = () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } };
  if (heartbeat && lockHeartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = touch().catch(() => {}).finally(() => { heartbeatInFlight = null; });
    }, lockHeartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }
  const release = async () => {
    stopHeartbeat();
    // 等已在途的心跳结算,避免 release 首个快照后又发生 utimes,把自家的正常释放误判为替换。
    if (heartbeatInFlight) await heartbeatInFlight;
    return releaseFileLock(root, relPath, token, label);
  };
  return {
    ok: true, created, tookOver, token, holder, label, file, relPath,
    check, release, stopHeartbeat,
    get lost() { return lost; },
  };
};

// 释放:token 不匹配(被接管)/锁文件异常时返回 ok:false + warning;锁不在场视为已释放(ok:true, released:false)。
export const releaseFileLock = async (root, relPath, token, label = '文件锁') => {
  if (!token) return { ok: false, released: false, warning: `${label}释放缺少 token,拒绝按归属不明删除` };
  const file = path.isAbsolute(relPath) ? relPath : path.join(path.resolve(root), relPath);
  const snap = await readLockSnapshot(file).catch((e) => ({ error: e }));
  if (snap && snap.error) return { ok: false, released: false, warning: `${label}释放失败:${snap.error?.message || String(snap.error)}` };
  if (!snap) return { ok: true, released: false, warning: '' };
  if (snap.unsafe) return { ok: false, released: false, warning: `${label}路径在读取期间变为${lockUnsafeReason(snap.unsafe)},拒绝释放:${file}` };
  if (snap.info.token !== token) {
    return { ok: false, released: false, warning: `${label}未释放:token 不匹配(当前持有者 ${snap.info.holder || '(未知)'}),锁可能已被接管` };
  }
  if (process.env.RELAY_TEST_HOOKS === '1' && process.env.RELAY_TEST_RELEASE_LOCK_SIGNAL) {
    const signal = process.env.RELAY_TEST_RELEASE_LOCK_SIGNAL;
    const go = process.env.RELAY_TEST_RELEASE_LOCK_GO;
    try {
      await writeFile(signal, `${snap.info.token}\n`, 'utf8');
      const waitUntil = Date.now() + 10_000;
      while (Date.now() < waitUntil) {
        if (go && await pathExists(go)) break;
        await new Promise((done) => setTimeout(done, 10));
      }
    } catch (e) {
      return { ok: false, released: false, warning: `${label}释放复核屏障失败:${e?.message || String(e)}` };
    }
  }
  const finalSnap = await readLockSnapshot(file).catch((e) => ({ error: e }));
  if (finalSnap?.error) {
    return { ok: false, released: false, warning: `${label}最终复核失败:${finalSnap.error?.message || String(finalSnap.error)}` };
  }
  if (!finalSnap) return { ok: true, released: false, warning: `${label}已被其他进程释放` };
  if (finalSnap.unsafe) {
    return { ok: false, released: false, warning: `${label}路径在释放前变为${lockUnsafeReason(finalSnap.unsafe)},拒绝删除:${file}` };
  }
  if (!sameLockSnapshot(snap, finalSnap) || finalSnap.info.token !== token) {
    return {
      ok: false,
      released: false,
      warning: `${label}在释放前被替换或改写(当前持有者 ${finalSnap.info.holder || '(未知)'}),未删除他人锁`,
    };
  }
  try {
    await unlink(file);
    return { ok: true, released: true, warning: '' };
  } catch (e) {
    return { ok: false, released: false, warning: `${label}释放失败:${e?.message || String(e)}` };
  }
};

export const verifyRepoLock = async (root, token) => {
  if (!token) return { ok: false, held: false, warning: '缺少 token,无法校验仓库锁归属' };
  const file = path.join(path.resolve(root), REPO_LOCK_REL);
  const snap = await readLockSnapshot(file).catch(() => null);
  if (!snap) return { ok: true, held: false, warning: '仓库锁不在场' };
  if (snap.unsafe) return { ok: false, held: false, warning: `仓库锁路径在读取期间变为${lockUnsafeReason(snap.unsafe)},拒绝按内容校验归属` };
  if (snap.info.token !== token) {
    return { ok: false, held: false, holder: snap.info.holder, warning: `仓库锁现持有者 ${snap.info.holder || '(未知)'}` };
  }
  return { ok: true, held: true, holder: snap.info.holder };
};

// —— 仓库级写锁(H-C):序列化一切 TASKS/LOG 的读改写(session_end / claim / restructure / sync)——
// 单任务认领锁不覆盖 TASKS.md 本体;两个会话并发读改写会互相吞更新(实测复现过)。
export const acquireRepoLock = async (root, holder, { waitMs = 15_000 } = {}) => acquireFileLock(
  root, REPO_LOCK_REL, holder, { staleMs: STALE_REPO_LOCK_MS, waitMs, label: '仓库写锁' },
);

// 兼容旧调用方:返回 {ok,released,warning}(原先布尔值);旧 token 不能释放新持有者的锁。
export const releaseRepoLock = async (root, token) => releaseFileLock(root, REPO_LOCK_REL, token, '仓库写锁');
