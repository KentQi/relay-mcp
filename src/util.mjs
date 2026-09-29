// relay-mcp — src/util.mjs (W2)
// 零依赖公共助手:fs / git / 时间戳。仅使用 node: 内置模块。
import { readFile, writeFile, mkdir, rename, stat, unlink, open as fsOpen2 } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

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

// —— 仓库级写锁(H-C):序列化一切 TASKS/LOG 的读改写(session_end / claim / restructure / sync)——
// 单任务认领锁不覆盖 TASKS.md 本体;两个会话并发读改写会互相吞更新(实测复现过)。
// O_EXCL 原子创建;持锁超 STALE_REPO_LOCK_MS 视为崩溃残留,unlink+wx 原子接管。
export const REPO_LOCK_REL = '.relay/relay.lock';
export const STALE_REPO_LOCK_MS = 120_000;

export const acquireRepoLock = async (root, holder, { waitMs = 15_000 } = {}) => {
  await ensureDir(path.join(root, '.relay'));
  const p = path.join(root, REPO_LOCK_REL);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const h = await fsOpen2(p, 'wx');
      await h.writeFile(`${holder}\n${new Date().toISOString()}\n`, 'utf8');
      await h.close();
      return { ok: true };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ageMs = Infinity;
      let lockHolder = '?';
      try {
        const st = await stat(p);
        ageMs = Date.now() - st.mtimeMs;
        lockHolder = String(await readFile(p, 'utf8')).split('\n')[0].trim() || '?';
      } catch { /* 锁刚好消失 → 立即重试抢位 */ }
      if (ageMs > STALE_REPO_LOCK_MS) {
        try { await unlink(p); } catch { /* 别的等待者已接管 */ }
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, holder: lockHolder, ageMs };
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

export const releaseRepoLock = async (root) => {
  try { await unlink(path.join(root, REPO_LOCK_REL)); } catch { /* 锁不在场 */ }
};
