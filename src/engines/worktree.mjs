// relay-mcp — 任务级 worktree 根目录、注册表与安全清理。
// 删除只走 `git worktree remove`(不使用 force / rm -rf),分支始终保留。
import { realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireRepoLock, ensureDir, gitRun, nowIso, readFileSafe, releaseRepoLock,
} from '../util.mjs';
import { DEFAULT_WORKTREE_CONFIG, readManifestConfig } from '../config.mjs';
import { TASK_LINE_RE } from './verify.mjs';

export const WORKTREE_REGISTRY_REL = '.relay/worktrees.json';

const realPath = async (p) => {
  try { return await realpath(p); } catch { return path.resolve(p); }
};
const contained = (root, candidate, allowEqual = false) => {
  const rel = path.relative(root, candidate);
  return (allowEqual && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

const normalizeCacheDir = (value) => {
  const raw = String(value || '').trim();
  const portable = raw.replace(/\\/g, '/');
  if (!raw || raw === '.' || path.isAbsolute(raw) || path.win32.isAbsolute(raw)
    || portable.startsWith('/') || portable.split('/').includes('..')) {
    throw new Error(`worktree.cacheDir 必须是 controlRoot 内不含 .. 的相对路径:${raw || '(空)'}`);
  }
  return portable.replace(/^\.\//, '').replace(/\/+$/, '');
};

export const readWorktreeConfig = async (root) => {
  const cfg = await readManifestConfig(root);
  const raw = cfg.manifest && cfg.manifest.worktree && typeof cfg.manifest.worktree === 'object'
    ? cfg.manifest.worktree : {};
  const ttl = Number(raw.ttlHours);
  return {
    enabled: raw.enabled === true,
    cacheDir: normalizeCacheDir(raw.cacheDir || DEFAULT_WORKTREE_CONFIG.cacheDir),
    ttlHours: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_WORKTREE_CONFIG.ttlHours,
    autoCleanup: raw.autoCleanup !== false,
  };
};

const emptyRegistry = () => ({ version: 1, worktrees: [] });

export const readWorktreeRegistry = async (controlRoot) => {
  const raw = await readFileSafe(path.join(controlRoot, WORKTREE_REGISTRY_REL), null);
  if (raw == null) return emptyRegistry();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.worktrees)) {
    throw new Error(`${WORKTREE_REGISTRY_REL} 格式无效:缺少 worktrees 数组`);
  }
  return { version: 1, worktrees: parsed.worktrees.filter((w) => w && typeof w === 'object') };
};

// 调用方负责持有 controlRoot 的仓库写锁;临时文件 + rename 保证注册表不半写。
export const writeWorktreeRegistry = async (controlRoot, registry) => {
  const target = path.join(controlRoot, WORKTREE_REGISTRY_REL);
  await ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, worktrees: registry.worktrees || [] }, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
};

export const upsertWorktreeRecord = async (controlRoot, task, patch = {}) => {
  const registry = await readWorktreeRegistry(controlRoot);
  const idx = registry.worktrees.findIndex((w) => w.task === task);
  const previous = idx >= 0 ? registry.worktrees[idx] : { task, createdAt: nowIso() };
  const record = { ...previous, ...patch, task, lastUsedAt: patch.lastUsedAt || nowIso() };
  if (idx >= 0) registry.worktrees[idx] = record;
  else registry.worktrees.push(record);
  await writeWorktreeRegistry(controlRoot, registry);
  return record;
};

export const touchWorktree = async (controlRoot, executionRoot, patch = {}) => {
  const actual = await realPath(executionRoot);
  const registry = await readWorktreeRegistry(controlRoot);
  let found = null;
  for (const record of registry.worktrees) {
    if (typeof record.path === 'string' && await realPath(path.resolve(controlRoot, record.path)) === actual) {
      found = record; break;
    }
  }
  if (!found) return null;
  const lock = await acquireRepoLock(controlRoot, `worktree-touch:${found.task}`);
  if (!lock.ok) throw new Error(`更新 worktree 注册表时仓库锁被 ${lock.holder} 持有`);
  try {
    return await upsertWorktreeRecord(controlRoot, found.task, { ...patch, lastUsedAt: nowIso() });
  } finally {
    await releaseRepoLock(controlRoot, lock.token);
  }
};

const parseWorktreeList = (raw) => {
  const out = [];
  let current = null;
  for (const line of String(raw || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = { path: line.slice(9), branch: '', head: '', locked: false };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).trim();
    else if (current && line.startsWith('locked')) current.locked = line.slice(6).trim() || true;
  }
  if (current) out.push(current);
  return out;
};

export const resolveRelayRoots = async (root) => {
  const input = path.resolve(root || process.cwd());
  const top = await gitRun(input, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.stdout.trim()) return { controlRoot: input, executionRoot: input, managed: false };
  const executionRoot = await realPath(top.stdout.trim());
  const common = await gitRun(executionRoot, 'rev-parse', '--git-common-dir');
  if (!common.ok || !common.stdout.trim()) return { controlRoot: executionRoot, executionRoot, managed: false };
  const commonDir = await realPath(path.resolve(executionRoot, common.stdout.trim()));
  if (path.basename(commonDir) !== '.git') return { controlRoot: executionRoot, executionRoot, managed: false };
  const controlRoot = await realPath(path.dirname(commonDir));
  if (controlRoot === executionRoot) return { controlRoot, executionRoot, managed: false };
  try {
    const registry = await readWorktreeRegistry(controlRoot);
    for (const record of registry.worktrees) {
      if (typeof record.path !== 'string') continue;
      const candidate = await realPath(path.resolve(controlRoot, record.path));
      if (candidate === executionRoot) return { controlRoot, executionRoot, managed: true };
    }
  } catch { /* 注册表损坏时按普通 Git worktree 处理,清理器会另行报告 */ }
  return { controlRoot, executionRoot, managed: false };
};

export const ensureTaskWorktree = async (controlRoot, task, model, config = null) => {
  if (!/^T\d+$/.test(task)) throw new Error(`非法任务号,不能生成 worktree:${task}`);
  const cfg = config || await readWorktreeConfig(controlRoot);
  const branch = `relay/${task}`;
  const recordPath = path.join(cfg.cacheDir, task);
  const absolute = path.resolve(controlRoot, recordPath);
  const cacheAbs = path.resolve(controlRoot, cfg.cacheDir);
  if (!contained(cacheAbs, absolute)) throw new Error(`任务 worktree 路径越界:${recordPath}`);
  const baseResult = await gitRun(controlRoot, 'rev-parse', 'HEAD');
  if (!baseResult.ok || !baseResult.stdout.trim()) throw new Error(`无法读取当前 HEAD:${baseResult.stderr || baseResult.stdout}`);
  const headSha = baseResult.stdout.trim();
  const registry = await readWorktreeRegistry(controlRoot);
  const previous = registry.worktrees.find((w) => w.task === task);
  const listed = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
  if (!listed.ok) throw new Error(`git worktree list 失败:${listed.stderr || listed.stdout}`);
  await ensureDir(cacheAbs);
  const rootReal = await realPath(controlRoot);
  const cacheReal = await realPath(cacheAbs);
  if (!contained(rootReal, cacheReal)) throw new Error(`缓存目录通过符号链接逃出 controlRoot:${cfg.cacheDir}`);
  const actual = await realPath(absolute);
  if (!contained(cacheReal, actual)) throw new Error(`任务 worktree 通过符号链接逃逸:${recordPath}`);
  const entries = parseWorktreeList(listed.stdout);
  let existing = null;
  for (const entry of entries) {
    if (await realPath(entry.path) === actual) { existing = entry; break; }
  }
  if (existing && existing.branch !== `refs/heads/${branch}`) {
    throw new Error(`受管路径已挂载其他分支:${existing.branch || '(detached)'}`);
  }
  let created = false;
  try {
    if (!existing) {
      await gitRun(controlRoot, 'worktree', 'prune');
      const branchExists = await gitRun(controlRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
      const args = branchExists.ok
        ? ['worktree', 'add', absolute, branch]
        : ['worktree', 'add', '-b', branch, absolute, headSha];
      const added = await gitRun(controlRoot, ...args);
      if (!added.ok) throw new Error(`git worktree add 失败:${added.stderr || added.stdout}`);
      created = true;
    }
    const finalReal = await realPath(absolute);
    if (!contained(cacheReal, finalReal)) throw new Error(`创建后复核发现路径逃逸:${recordPath}`);
    const baseSha = previous?.baseSha || headSha;
    await upsertWorktreeRecord(controlRoot, task, {
      path: recordPath, branch, baseSha, owner: model, status: 'active', lastUsedAt: nowIso(),
    });
    return { path: finalReal, branch, baseSha, reused: !created, created };
  } catch (e) {
    if (created) await gitRun(controlRoot, 'worktree', 'remove', absolute);
    throw e;
  }
};

// TASKS 写入失败时仅回滚本次新建的干净 worktree;复用现场绝不删除,分支始终保留。
export const rollbackTaskWorktree = async (controlRoot, task, info) => {
  if (!info?.created) return;
  await gitRun(controlRoot, 'worktree', 'remove', info.path);
  const registry = await readWorktreeRegistry(controlRoot);
  registry.worktrees = registry.worktrees.filter((w) => w.task !== task);
  await writeWorktreeRegistry(controlRoot, registry);
};

const activeTaskIds = async (controlRoot) => {
  const raw = await readFileSafe(path.join(controlRoot, 'TASKS.md'), '');
  const active = new Set();
  for (const line of String(raw || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(TASK_LINE_RE);
    if (m && m[1] === '~') active.add(m[2]);
  }
  return active;
};

export const cleanupWorktrees = async (controlRoot, options = {}) => {
  const confirm = options.confirm === true;
  const report = { removed: [], candidates: [], kept: [], errors: [] };
  const lock = await acquireRepoLock(controlRoot, 'worktree-cleanup');
  if (!lock.ok) {
    report.errors.push({ task: '(registry)', path: WORKTREE_REGISTRY_REL, reason: `仓库写锁被 ${lock.holder} 持有` });
    return report;
  }
  try {
    const cfg = await readWorktreeConfig(controlRoot);
    const ttlHours = Number.isFinite(Number(options.ttlHours)) && Number(options.ttlHours) >= 0
      ? Number(options.ttlHours) : cfg.ttlHours;
    const nowValue = options.now instanceof Date ? options.now.getTime()
      : options.now != null ? new Date(options.now).getTime() : Date.now();
    const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
    const rootReal = await realPath(controlRoot);
    const cacheAbs = path.resolve(controlRoot, cfg.cacheDir);
    const cacheReal = await realPath(cacheAbs);
    if (!contained(rootReal, cacheReal)) throw new Error(`缓存目录通过符号链接逃出 controlRoot:${cfg.cacheDir}`);
    const currentReal = options.currentRoot ? await realPath(options.currentRoot) : rootReal;
    const registry = await readWorktreeRegistry(controlRoot);
    const active = await activeTaskIds(controlRoot);
    const listed = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
    if (!listed.ok) throw new Error(`git worktree list 失败:${listed.stderr || listed.stdout}`);
    const gitEntries = [];
    for (const entry of parseWorktreeList(listed.stdout)) {
      gitEntries.push({ ...entry, realPath: await realPath(entry.path) });
    }
    const removedKeys = new Set();

    for (const record of registry.worktrees) {
      const task = String(record.task || '(未知任务)');
      const recordPath = typeof record.path === 'string' ? record.path : '';
      const displayPath = recordPath || '(缺失路径)';
      const keep = async (reason) => { report.kept.push({ task, path: displayPath, reason }); };
      if (!recordPath || path.isAbsolute(recordPath) || path.win32.isAbsolute(recordPath)) {
        await keep('路径不是注册表允许的相对路径'); continue;
      }
      const absolute = path.resolve(controlRoot, recordPath);
      const actual = await realPath(absolute);
      if (!contained(cacheAbs, absolute) || !contained(cacheReal, actual)) {
        await keep('路径越出受管 cacheDir,拒绝清理'); continue;
      }
      if (actual === rootReal || actual === currentReal) {
        await keep('主工作树或当前 executionRoot 不可自我清理'); continue;
      }
      if (active.has(task)) {
        await keep('任务仍处于 [~] 活跃状态'); continue;
      }
      const usedMs = new Date(record.lastUsedAt).getTime();
      if (!Number.isFinite(usedMs)) {
        await keep('lastUsedAt 无效,无法证明已过期'); continue;
      }
      if (nowMs - usedMs <= ttlHours * 3600000) {
        await keep(`未超过 TTL ${ttlHours} 小时`); continue;
      }
      const gitEntry = gitEntries.find((entry) => entry.realPath === actual);
      if (!gitEntry) {
        await keep('Git worktree 列表未登记该路径'); continue;
      }
      if (gitEntry.locked) {
        await keep('Git worktree 已 locked'); continue;
      }
      const branchRef = `refs/heads/${record.branch || ''}`;
      if (!record.branch || gitEntry.branch !== branchRef) {
        await keep('当前 Git 分支与注册表不一致'); continue;
      }
      const branch = await gitRun(controlRoot, 'show-ref', '--verify', '--quiet', branchRef);
      if (!branch.ok) {
        await keep('任务分支引用不存在,拒绝失去最后持久引用'); continue;
      }
      const status = await gitRun(actual, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
      if (!status.ok) {
        await keep(`无法读取 worktree 状态:${status.stderr || status.stdout}`); continue;
      }
      if (status.stdout.trim()) {
        await keep('worktree 有未提交或冲突改动(dirty)'); continue;
      }
      if (!confirm) {
        report.candidates.push({ task, path: displayPath, branch: record.branch, reason: '过期、非活跃、干净且分支已保留' });
        continue;
      }

      // 删除前再核验真实路径与 dirty 状态;Git 自身仍保留最后一道非强制删除闸门。
      const verified = await realPath(absolute);
      const statusAgain = await gitRun(verified, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall');
      if (!contained(cacheReal, verified) || verified !== actual || !statusAgain.ok || statusAgain.stdout.trim()) {
        await keep('删除前复核发现路径或状态变化,拒绝清理'); continue;
      }
      const removed = await gitRun(controlRoot, 'worktree', 'remove', verified);
      if (!removed.ok) {
        report.errors.push({ task, path: displayPath, reason: `git worktree remove 失败:${removed.stderr || removed.stdout}` });
        continue;
      }
      report.removed.push({ task, path: displayPath, branch: record.branch });
      removedKeys.add(`${task}\0${recordPath}`);
    }
    if (removedKeys.size) {
      registry.worktrees = registry.worktrees.filter((w) => !removedKeys.has(`${String(w.task || '(未知任务)')}\0${w.path}`));
      await writeWorktreeRegistry(controlRoot, registry);
    }
    return report;
  } catch (e) {
    report.errors.push({ task: '(registry)', path: WORKTREE_REGISTRY_REL, reason: e?.message || String(e) });
    return report;
  } finally {
    await releaseRepoLock(controlRoot, lock.token);
  }
};

export const relayWorktreeCleanup = async (args = {}) => {
  const roots = await resolveRelayRoots(args.root || process.cwd());
  const report = await cleanupWorktrees(roots.controlRoot, {
    confirm: args.confirm === true,
    ttlHours: args.ttl_hours,
    currentRoot: roots.executionRoot,
  });
  const dry = args.confirm !== true;
  const lines = [
    `# worktree 清理 — ${dry ? 'dry-run(传 confirm:true 执行)' : '已执行'}`,
    '', `- controlRoot: ${roots.controlRoot}`, `- executionRoot: ${roots.executionRoot}`,
  ];
  const row = (w) => `- ${w.task}: \`${w.path}\`${w.branch ? ` — 分支 \`${w.branch}\` 保留` : ''}${w.reason ? ` — ${w.reason}` : ''}`;
  if (dry) lines.push('', `## 可清理(${report.candidates.length})`, ...(report.candidates.length ? report.candidates.map(row) : ['- 无']));
  if (!dry) lines.push('', `## 已清理(${report.removed.length})`, ...(report.removed.length ? report.removed.map(row) : ['- 无']));
  lines.push('', `## 保留(${report.kept.length})`, ...(report.kept.length ? report.kept.map(row) : ['- 无']));
  if (report.errors.length) lines.push('', `## 错误(${report.errors.length})`, ...report.errors.map(row));
  lines.push('', '只删除 worktree 目录,不删除分支,不自动 merge/rebase/push。');
  return textResult(lines.join('\n'), report.errors.length > 0);
};
