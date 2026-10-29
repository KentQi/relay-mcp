// relay-mcp — src/util.mjs (W2)
// 零依赖公共助手:fs / git / 时间戳。仅使用 node: 内置模块。
import { readFile, writeFile, mkdir, rename, stat, lstat, unlink, utimes, open as fsOpen2 } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

// relay-mcp/templates 绝对路径:基于本文件(src/util.mjs)向上一级再进 templates
export const templatesDir = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// 读文件,不存在(或不可读)返回 fallback
export const readFileSafe = async (p, fallback = null) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return fallback;
  }
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
  const backup = `${p}.relay-bak-${ts}`;
  await rename(p, backup);
  return backup;
};

// root 目录本身是否是一个 git 仓库(而非恰好位于某个外层仓库之内)
// 两侧都过 realpath:macOS 的 /tmp→/private/tmp、/var→/private/var 符号链接
// 会让字符串比较永远不等,把真仓库误判成"非 git 仓库"
export const isGitRepo = (root) => {
  if (typeof root !== 'string' || root === '') return false;
  const real = (p) => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  try {
    const top = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 },
    )
      .toString()
      .trim();
    return top !== '' && real(top) === real(root);
  } catch {
    return false;
  }
};

// execFile('git', ['-C', root, ...args]) 包装:8 秒超时,永不抛错
// 返回 {ok, stdout, stderr};ok = exit 0
export const gitRun = async (root, ...args) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', root, ...args],
      { timeout: 8000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
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
  [/(^|\/)\.env(\..+)?$/i, '.env 疑似密钥'],
  [/(^|\/)[^/]*secret[^/]*$/i, '文件名含 secret'],
  [/(^|\/)[^/]*credential[^/]*$/i, '文件名含 credential'],
  [/\.(key|pem)$/i, '*.key / *.pem 私钥'],
  [/(^|\/)id_rsa(\..+)?$/i, 'id_rsa 私钥'],
];
export const findSensitiveChanges = (statusLines) => {
  const hits = new Map();
  for (const line of statusLines || []) {
    if (line.length < 4) continue;
    for (const raw of line.slice(3).split(' -> ')) {
      let p = raw.trim();
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      const rule = SECRET_RULES.find(([re]) => re.test(p));
      if (rule) hits.set(p, rule[1]);
    }
  }
  return [...hits.entries()].map(([path, why]) => ({ path, why })).sort((a, b) => a.path.localeCompare(b.path));
};

// =====================================================================
// 协议文件安全写 / 符号链接防线 / 锁协议(JSON v2,兼容旧文本 v1)
// =====================================================================

// 校验「root 之下某条相对路径的每一级已存在组件都不是符号链接」。
// .relay / .relay/claims / 自定义 cacheDir 以及 TASKS/LOG/锁/注册表都必须先过这一关:
// 否则一条指向仓库外的符号链接就能把协议文件写到不该写的地方。
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
export const writeFileAtomic = async (target, content, { fencing = null, label = '' } = {}) => {
  await assertNotSymlinkFile(target, label);
  const dir = path.dirname(target);
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat && dirStat.isSymbolicLink()) {
    throw new Error(`${label || target} 所在目录是符号链接(${dir}),拒绝写入`);
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
    await rename(tmp, target);
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
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
};
export const writeProtocolFile = async (root, name, content, { token = '', lockLabel = '仓库写锁' } = {}) => {
  const target = path.join(root, name);
  await writeFileAtomic(target, content, {
    label: name,
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
export const lockTiming = () => ({ heartbeatMs: lockHeartbeatMs, emptyGraceMs: emptyLockGraceMs });
// 仅供冒烟测试缩短心跳/宽限(不改默认行为);返回还原函数。
export const __setLockTimingForTest = ({ heartbeatMs, emptyGraceMs } = {}) => {
  const prev = { heartbeatMs: lockHeartbeatMs, emptyGraceMs: emptyLockGraceMs };
  if (Number.isFinite(heartbeatMs) && heartbeatMs >= 0) lockHeartbeatMs = heartbeatMs;
  if (Number.isFinite(emptyGraceMs) && emptyGraceMs >= 1) emptyLockGraceMs = emptyGraceMs;
  return () => { lockHeartbeatMs = prev.heartbeatMs; emptyLockGraceMs = prev.emptyGraceMs; };
};

export const serializeLock = ({ holder, token, acquiredAt }) => `${JSON.stringify({
  version: LOCK_VERSION,
  holder: String(holder ?? ''),
  token: String(token ?? ''),
  acquiredAt: acquiredAt || new Date().toISOString(),
  pid: process.pid,
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
      if (token) return { holder, token, acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '', legacy: false, empty: false, corrupt: false };
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

const readLockSnapshot = async (file) => {
  // 锁路径被替换成符号链接:拒绝按内容接管/释放(可能把操作引到仓库外)。
  const lst = await lstat(file).catch(() => null);
  if (lst && lst.isSymbolicLink()) {
    return { unsafe: 'symlink', raw: '', info: { holder: '(符号链接)', token: '', acquiredAt: '', legacy: false, empty: false, corrupt: true }, ageMs: 0 };
  }
  let raw;
  try {
    raw = String(await readFile(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const st = await stat(file).catch(() => null);
  const info = parseLockContent(raw);
  const ageMs = st ? Math.max(0, Date.now() - st.mtimeMs) : 0;
  return { raw, info, ageMs };
};

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
  let tookOver = '';
  for (;;) {
    let handle = null;
    let opened = false;
    try {
      handle = await fsOpen2(file, 'wx');
      opened = true;
      await handle.writeFile(serializeLock({ holder, token, acquiredAt }), 'utf8');
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
    const snap = await readLockSnapshot(file).catch(() => null);
    if (!snap) continue; // 锁刚好消失 → 立即重试抢位
    if (snap.unsafe) throw new Error(`${label}路径是符号链接,拒绝接管:${file}`);
    const lockHolder = snap.info.holder || '(未知持有者)';
    if (sameHolder && sameHolder(snap.info.holder)) {
      // 同持有者幂等:沿用既有 token;旧格式缺 token 时原子补写(不再用非原子 writeFile)
      let adoptToken = snap.info.token;
      if (!adoptToken) {
        adoptToken = token;
        await writeFileAtomic(file, serializeLock({ holder: lockHolder, token: adoptToken, acquiredAt: snap.info.acquiredAt || acquiredAt }), { label });
      }
      return makeLockHandle({ root: rootAbs, relPath, file, token: adoptToken, holder: lockHolder, created: false, tookOver: '', label, heartbeat });
    }
    const halfInitialized = !snap.info.token;
    const staleThreshold = halfInitialized ? emptyLockGraceMs : staleMs;
    if (snap.ageMs > staleThreshold) {
      // 删除前复核内容,避免把等待期间换上的新锁当成旧锁;换上的新锁内容不同 → 不删。
      try {
        const rawAgain = String(await readFile(file, 'utf8'));
        if (rawAgain === snap.raw) {
          await unlink(file);
          tookOver = lockHolder;
          if (onTakeover) onTakeover(lockHolder);
        }
      } catch { /* 别的等待者已接管 */ }
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        ok: false, holder: lockHolder, ageMs: snap.ageMs, ageMin: snap.ageMs / 60000,
        staleMs, label,
        warning: `${label}被 ${lockHolder} 持有(约 ${Math.round(snap.ageMs / 1000)}s)`,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};

const makeLockHandle = ({ root, relPath, file, token, holder, created, tookOver, label, heartbeat = true }) => {
  let lost = false;
  let heartbeatTimer = null;
  const check = async () => {
    const snap = await readLockSnapshot(file).catch(() => null);
    if (!snap) {
      lost = true;
      return { ok: false, held: false, warning: `${label}已不在场(可能被接管或释放)` };
    }
    if (snap.unsafe) {
      lost = true;
      return { ok: false, held: false, warning: `${label}路径被替换为符号链接` };
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
    heartbeatTimer = setInterval(() => { touch().catch(() => {}); }, lockHeartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }
  const release = async () => { stopHeartbeat(); return releaseFileLock(root, relPath, token, label); };
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
  if (snap.unsafe) return { ok: false, released: false, warning: `${label}路径是符号链接,拒绝释放:${file}` };
  if (snap.info.token !== token) {
    return { ok: false, released: false, warning: `${label}未释放:token 不匹配(当前持有者 ${snap.info.holder || '(未知)'}),锁可能已被接管` };
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
  if (snap.unsafe) return { ok: false, held: false, warning: '仓库锁路径是符号链接,拒绝按内容校验归属' };
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
