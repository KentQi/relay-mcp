// relay-mcp — src/util.mjs (W2)
// 零依赖公共助手:fs / git / 时间戳。仅使用 node: 内置模块。
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
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
