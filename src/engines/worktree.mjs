// relay-mcp — 任务级 worktree 根目录、注册表与安全清理。
// 删除只走 `git worktree remove`(不使用 force / rm -rf),分支始终保留。
import { existsSync } from 'node:fs';
import { realpath, rename, stat, lstat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireRepoLock, assertNoSymlinkComponents, assertNotSymlinkFile, ensureDir, gitRun, nowIso, readFileSafe,
} from '../util.mjs';
import { DEFAULT_WORKTREE_CONFIG, ensureGitignoreBaseline, readManifestConfig } from '../config.mjs';
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

// cacheDir 是唯一允许在 controlRoot 内落目录的配置项:必须在任何 ensureDir 之前做严格静态校验。
// 拒绝空/`.`/控制字符(含换行)/POSIX 或 Windows 绝对路径/盘符相对路径(如 `C:tmp`)/
// `..` 段/`.git` 前缀——这些都能把任务目录写到 controlRoot 之外或写进 Git 管理区。
const normalizeCacheDir = (value) => {
  const raw = String(value ?? '');
  const bad = (why) => {
    throw new Error(`worktree.cacheDir 非法(${why}):${JSON.stringify(raw).slice(0, 80)}。修复:改为 controlRoot 内的相对路径(默认 .relay/worktrees)`);
  };
  if (!raw.trim()) bad('空');
  if (/[\u0000-\u001f\u007f]/.test(raw)) bad('含控制字符/换行');
  const portable = raw.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(raw.trim()) || /^[A-Za-z]:/.test(portable)) {
    bad('绝对路径/盘符');
  }
  const segs = portable.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) bad('空/仅 .');
  if (segs.includes('..')) bad('含 .. 段');
  if (segs[0] === '.git' || segs[0].startsWith('.git/') || segs[0].startsWith('.git')) bad('.git 前缀');
  return segs.join('/');
};

// 无校验读取:供 claim 判定「是否启用」与「显式 worktree:false 时完全跳过配置校验」使用。
// cacheDirProvided 区分「manifest 显式写了 cacheDir(哪怕是空串/null,要拒绝)」与「缺省(用默认值)」。
export const readWorktreeConfigRaw = async (root) => {
  const cfg = await readManifestConfig(root);
  const raw = cfg.manifest && cfg.manifest.worktree && typeof cfg.manifest.worktree === 'object'
    ? cfg.manifest.worktree : {};
  const ttl = Number(raw.ttlHours);
  const cacheDirProvided = Object.prototype.hasOwnProperty.call(raw, 'cacheDir');
  return {
    enabled: raw.enabled === true,
    cacheDirRaw: cacheDirProvided ? raw.cacheDir : DEFAULT_WORKTREE_CONFIG.cacheDir,
    cacheDirProvided,
    ttlHours: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_WORKTREE_CONFIG.ttlHours,
    autoCleanup: raw.autoCleanup !== false,
  };
};

export const readWorktreeConfig = async (root) => {
  const raw = await readWorktreeConfigRaw(root);
  if (raw.cacheDirProvided && typeof raw.cacheDirRaw !== 'string') {
    throw new Error(`worktree.cacheDir 必须是字符串相对路径,收到 ${JSON.stringify(raw.cacheDirRaw).slice(0, 40)}。修复:改为 controlRoot 内的相对路径(默认 .relay/worktrees)`);
  }
  return {
    enabled: raw.enabled,
    cacheDir: normalizeCacheDir(raw.cacheDirRaw),
    ttlHours: raw.ttlHours,
    autoCleanup: raw.autoCleanup,
  };
};

// R-07:worktree 启用时幂等补 .gitignore(实际 cacheDir + 注册表 + 锁),
// 只追加缺失行,绝不删改用户条目;供 claim 在创建缓存目录之前调用。
export const ensureWorktreeGitignore = async (root, cfg) => {
  const cacheLine = `${String(cfg.cacheDir).replace(/\/+$/, '')}/`;
  return ensureGitignoreBaseline(root, [cacheLine, WORKTREE_REGISTRY_REL, '.relay/worktrees.lock']);
};

const emptyRegistry = () => ({ version: 1, worktrees: [] });

// fail-closed 读取:把「缺失 / 损坏」与「合法但为空」区分开。
// 受管身份完全依赖该 gitignored 文件,不能把不可读一律当作 managed=false 静默降级。
export const readWorktreeRegistryState = async (controlRoot) => {
  const raw = await readFileSafe(path.join(controlRoot, WORKTREE_REGISTRY_REL), null);
  if (raw == null) return { state: 'missing', registry: emptyRegistry(), error: '' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.worktrees)) {
      return { state: 'corrupt', registry: emptyRegistry(), error: `${WORKTREE_REGISTRY_REL} 格式无效:缺少 worktrees 数组` };
    }
    return {
      state: 'ok',
      registry: { version: 1, worktrees: parsed.worktrees.filter((w) => w && typeof w === 'object') },
      error: '',
    };
  } catch (e) {
    return { state: 'corrupt', registry: emptyRegistry(), error: `${WORKTREE_REGISTRY_REL} 解析失败:${e?.message || String(e)}` };
  }
};

// 损坏/缺失时的可执行恢复指引(供 claim / session_end / cleanup 复用)
export const registryRecoveryHint = (controlRoot, state) => {
  const rel = path.join(controlRoot, WORKTREE_REGISTRY_REL);
  if (state === 'corrupt') {
    return `修复或删除注册表 \`${rel}\`(建议先备份为 .relay-bak):relay 不信任损坏的注册表,也不会猜测受管 worktree 状态。`;
  }
  return `注册表缺失:\`${rel}\` 未找到。若该目录确为 relay 任务 worktree,运行 relay_claim { "root": "${controlRoot}", "task": "T###", "worktree": true } 重建登记;否则请离开该 worktree 在 controlRoot 操作。`;
};

export const readWorktreeRegistry = async (controlRoot) => {
  const { state, registry, error } = await readWorktreeRegistryState(controlRoot);
  if (state === 'corrupt') {
    throw new Error(`${error}。修复或删除 .relay/worktrees.json(建议先备份)后重试;relay 不会在注册表损坏时猜测受管状态。`);
  }
  return registry;
};

// 调用方负责持有 controlRoot 的仓库写锁;临时文件 + rename 保证注册表不半写。
// R-08:注册表写入前拒绝符号链接(.relay 目录与 worktrees.json 本体),否则写入可能被引到仓库外;
// fencing 回调在 rename 前复核仓库锁仍属于本会话,被接管时拒写(由调用方传入 token)。
export const writeWorktreeRegistry = async (controlRoot, registry, { fencing = null } = {}) => {
  const target = path.join(controlRoot, WORKTREE_REGISTRY_REL);
  await assertNoSymlinkComponents(controlRoot, path.dirname(WORKTREE_REGISTRY_REL), 'worktree 注册表目录');
  await assertNotSymlinkFile(target, WORKTREE_REGISTRY_REL);
  await ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, worktrees: registry.worktrees || [] }, null, 2)}\n`, 'utf8');
    if (fencing) {
      const verdict = await fencing();
      if (!verdict || verdict.ok !== true) {
        throw new Error(`注册表写回 fencing 校验失败:${verdict?.warning || '仓库锁已不属于当前会话'}`);
      }
    }
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
};

export const upsertWorktreeRecord = async (controlRoot, task, patch = {}, { fencing = null } = {}) => {
  const registry = await readWorktreeRegistry(controlRoot);
  const idx = registry.worktrees.findIndex((w) => w.task === task);
  const previous = idx >= 0 ? registry.worktrees[idx] : { task, createdAt: nowIso() };
  const record = { ...previous, ...patch, task, lastUsedAt: patch.lastUsedAt || nowIso() };
  if (idx >= 0) registry.worktrees[idx] = record;
  else registry.worktrees.push(record);
  await writeWorktreeRegistry(controlRoot, registry, { fencing });
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
  let lock;
  try {
    lock = await acquireRepoLock(controlRoot, `worktree-touch:${found.task}`);
  } catch (e) {
    throw new Error(`更新 worktree 注册表时无法获取仓库锁(锁路径异常):${e?.message || String(e)}`);
  }
  if (!lock.ok) throw new Error(`更新 worktree 注册表时仓库锁被 ${lock.holder} 持有`);
  try {
    // fencing:等待锁期间可能被 stale 接管;写注册表前复核锁仍属于本会话。
    const fence = await lock.check();
    if (!fence.held) throw new Error(`更新 worktree 注册表前发现仓库锁已被接管:${fence.warning || '锁已不属于当前会话'}`);
    return await upsertWorktreeRecord(controlRoot, found.task, { ...patch, lastUsedAt: nowIso() }, {
      fencing: async () => {
        const verdict = await lock.check();
        return verdict.held ? { ok: true } : { ok: false, warning: verdict.warning };
      },
    });
  } finally {
    const rel = await lock.release();
    if (!rel.ok && rel.warning) process.stderr.write(`[relay] worktree-touch 仓库锁释放告警:${rel.warning}\n`);
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

// 解析 controlRoot / executionRoot。
// linkedWorktree=true 表示「当前目录是 controlRoot 的 Git linked worktree」;
// registryState ∈ ok | missing | corrupt | unregistered,用于上层 fail-closed:
// 受管身份依赖 gitignored 注册表,注册表不可读时不得静默把受管 worktree 当作普通目录。
export const resolveRelayRoots = async (root) => {
  const input = path.resolve(root || process.cwd());
  const top = await gitRun(input, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.stdout.trim()) {
    return { controlRoot: input, executionRoot: input, managed: false, linkedWorktree: false, registryState: 'not-applicable' };
  }
  const executionRoot = await realPath(top.stdout.trim());
  const common = await gitRun(executionRoot, 'rev-parse', '--git-common-dir');
  if (!common.ok || !common.stdout.trim()) {
    return { controlRoot: executionRoot, executionRoot, managed: false, linkedWorktree: false, registryState: 'not-applicable' };
  }
  const commonDir = await realPath(path.resolve(executionRoot, common.stdout.trim()));
  if (path.basename(commonDir) !== '.git') {
    return { controlRoot: executionRoot, executionRoot, managed: false, linkedWorktree: false, registryState: 'not-applicable' };
  }
  const controlRoot = await realPath(path.dirname(commonDir));
  if (controlRoot === executionRoot) {
    return { controlRoot, executionRoot, managed: false, linkedWorktree: false, registryState: 'not-applicable' };
  }
  const { state, registry } = await readWorktreeRegistryState(controlRoot);
  if (state === 'ok') {
    for (const record of registry.worktrees) {
      if (typeof record.path !== 'string') continue;
      const candidate = await realPath(path.resolve(controlRoot, record.path));
      if (candidate === executionRoot) {
        return { controlRoot, executionRoot, managed: true, linkedWorktree: true, registryState: 'ok', record };
      }
    }
    return { controlRoot, executionRoot, managed: false, linkedWorktree: true, registryState: 'unregistered' };
  }
  return { controlRoot, executionRoot, managed: false, linkedWorktree: true, registryState: state };
};

// 注册表缺失/损坏/记录丢失时的只读反查(Lead 决策):判断某个 done_task 是否仍有「受管 worktree 痕迹」。
// 依据(任一即可,命中即 fail-closed):
//   1) git worktree list 里有 worktree 正经 checkout refs/heads/relay/<task>;
//   2) 受管缓存路径 <cacheDir>/<task> 在磁盘上仍存在;
//   3) 调用方提供的注册表里存在该任务的非 completed 记录且其路径仍存在。
// 注意:仅「分支存在」不算痕迹——契约规定清理后分支保留,不能因此永远阻止单根完成。
export const findManagedWorktreeEvidence = async (controlRoot, task, { registry = null } = {}) => {
  const evidence = { found: false, worktreePath: '', reasons: [] };
  const id = String(task || '');
  if (!/^T\d+$/.test(id)) return evidence;
  const branchRef = `refs/heads/relay/${id}`;
  const branch = await gitRun(controlRoot, 'for-each-ref', '--format=%(refname)', branchRef);
  const branchExists = branch.ok && branch.stdout.trim() === branchRef;
  const listed = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
  if (listed.ok) {
    for (const entry of parseWorktreeList(listed.stdout)) {
      if (entry.branch === branchRef) {
        evidence.found = true;
        evidence.worktreePath = entry.path;
        evidence.reasons.push(`git worktree list:分支 ${branchRef} 仍被 ${entry.path} checkout`);
        break;
      }
    }
  }
  if (!evidence.found) {
    let cacheDir = DEFAULT_WORKTREE_CONFIG.cacheDir;
    try { cacheDir = (await readWorktreeConfig(controlRoot)).cacheDir; } catch { /* 配置非法时回退默认受管路径 */ }
    const expected = path.resolve(controlRoot, cacheDir, id);
    if (existsSync(expected)) {
      evidence.found = true;
      evidence.worktreePath = expected;
      evidence.reasons.push(`受管缓存路径仍存在:${expected}`);
    }
  }
  if (!evidence.found && registry && Array.isArray(registry.worktrees)) {
    const record = registry.worktrees.find((w) => w && String(w.task) === id);
    if (record && record.status !== 'completed' && typeof record.path === 'string') {
      const abs = path.resolve(controlRoot, record.path);
      if (existsSync(abs)) {
        evidence.found = true;
        evidence.worktreePath = abs;
        evidence.reasons.push(`注册表记录路径仍存在:${record.path}(status=${record.status})`);
      }
    }
  }
  if (!evidence.found && branchExists) {
    evidence.reasons.push(`分支 ${branchRef} 存在但未被 worktree checkout(清理后分支保留属正常,不阻止单根完成)`);
  }
  return evidence;
};

export const ensureTaskWorktree = async (controlRoot, task, model, config = null, { fencing = null } = {}) => {
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
  // R-08:cacheDir 的每一级已存在组件都不得是符号链接(cacheDir 可能含 .relay/worktrees 多层)。
  await assertNoSymlinkComponents(controlRoot, cfg.cacheDir, 'worktree.cacheDir');
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
  if (existing) {
    const existingStat = await stat(actual).catch(() => null);
    if (!existingStat || !existingStat.isDirectory()) {
      // Git 管理记录残留(目录被手工删除/清理):先尝试 repair(仓库/worktree 移动过的话可救回),
      // 再 prune,最后按分支重建,不能把幽灵记录当复用。
      await gitRun(controlRoot, 'worktree', 'repair');
      await gitRun(controlRoot, 'worktree', 'prune');
      existing = null;
    }
  }
  // 受管目录在磁盘上存在但 Git 未登记(移动仓库 / 手工 repair 丢失 admin 链接):
  // 先 best-effort 让 Git 自己修复(主工作树侧 + worktree 侧各试一次),失败不阻断后续安全重建。
  let rescuedOrphan = '';
  if (!existing && existsSync(absolute)) {
    await gitRun(controlRoot, 'worktree', 'repair');
    await gitRun(absolute, 'worktree', 'repair');
    const relisted = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
    if (relisted.ok) {
      for (const entry of parseWorktreeList(relisted.stdout)) {
        if (await realPath(entry.path) === actual) { existing = entry; break; }
      }
    }
    if (existing) {
      const existingStat = await stat(actual).catch(() => null);
      if (!existingStat || !existingStat.isDirectory()) existing = null;
    }
    if (!existing) {
      // repair 也救不回:只有「真实目录」才允许改名留存(绝不 rm -rf),再按分支重建;
      // 文件/符号链接占用受管路径时直接拒绝,交人工确认,避免把可疑现场静默改名或覆盖。
      const orphanStat = await lstat(absolute).catch(() => null);
      if (!orphanStat || !orphanStat.isDirectory()) {
        throw new Error(
          `受管路径 ${recordPath} 已被非目录内容占用(文件/符号链接),拒绝认领以免误删现场。`
          + `恢复:确认 \`${absolute}\` 无价值后手工删除或移走,再重试 relay_claim。`,
        );
      }
      const orphanPath = `${absolute}.relay-orphan-${Date.now().toString(36)}`;
      try {
        await rename(absolute, orphanPath);
        rescuedOrphan = orphanPath;
      } catch (e) {
        throw new Error(
          `受管路径 ${recordPath} 已存在但未被 Git 登记,且无法安全挪走(${e?.message || String(e)})。`
          + `恢复:确认该目录无未提交价值后 \`git -C "${controlRoot}" worktree repair "${absolute}"\`,`
          + `或手工 \`rm -rf "${absolute}"\` 后重试 relay_claim。`,
        );
      }
    }
  }
  if (existing && existing.branch !== `refs/heads/${branch}`) {
    throw new Error(`受管路径已挂载其他分支:${existing.branch || '(detached)'}`);
  }
  let created = false;
  try {
    // 陈旧记录恢复:注册表有记录但目录已不存在 → 先 prune Git 管理记录,再按分支重建
    if (previous && !existsSync(absolute)) await gitRun(controlRoot, 'worktree', 'prune');
    if (!existing) {
      await gitRun(controlRoot, 'worktree', 'prune');
      const branchExists = await gitRun(controlRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
      const args = branchExists.ok
        ? ['worktree', 'add', absolute, branch]
        : ['worktree', 'add', '-b', branch, absolute, headSha];
      const added = await gitRun(controlRoot, ...args);
      if (!added.ok) {
        throw new Error(`git worktree add 失败:${added.stderr || added.stdout}。恢复:在 controlRoot 运行 \`git worktree repair "${absolute}"\`;若报 'already exists',确认目录无未提交价值后手工删除该目录再重试。`);
      }
      created = true;
    }
    const finalReal = await realPath(absolute);
    if (!contained(cacheReal, finalReal)) throw new Error(`创建后复核发现路径逃逸:${recordPath}`);
    const finalStat = await stat(finalReal).catch(() => null);
    if (!finalStat || !finalStat.isDirectory()) throw new Error(`executionRoot 未就绪(目录不存在):${absolute}`);
    // 复用旧分支时 baseSha 必须取真实 merge-base;拿 controlRoot 当前 HEAD 冒充会把后续
    // 「伪 SHA / 已完成证据」校验建立在错误基准上。
    const branchNow = await gitRun(controlRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    let baseSha = headSha;
    if (branchNow.ok) {
      const mb = await gitRun(controlRoot, 'merge-base', 'HEAD', `refs/heads/${branch}`);
      if (mb.ok && mb.stdout.trim()) baseSha = mb.stdout.trim();
      else if (previous?.baseSha) baseSha = previous.baseSha;
    }
    await upsertWorktreeRecord(controlRoot, task, {
      path: recordPath, branch, baseSha, owner: model, status: 'active', lastUsedAt: nowIso(),
    }, { fencing });
    return { path: finalReal, branch, baseSha, reused: !created, created, rescuedOrphan };
  } catch (e) {
    if (created) await gitRun(controlRoot, 'worktree', 'remove', absolute);
    throw e;
  }
};

// TASKS 写入失败时仅回滚本次新建的干净 worktree;复用现场绝不删除,分支始终保留。
export const rollbackTaskWorktree = async (controlRoot, task, info, { fencing = null } = {}) => {
  if (!info?.created) return;
  await gitRun(controlRoot, 'worktree', 'remove', info.path);
  const registry = await readWorktreeRegistry(controlRoot);
  registry.worktrees = registry.worktrees.filter((w) => w.task !== task);
  await writeWorktreeRegistry(controlRoot, registry, { fencing });
};

// P2-12 注册表投毒防护:清理只信任「task===T###、path===cacheDir/task、branch===relay/task」的严格记录。
// 注册表是 gitignored 的本地文件,可能被手工编辑/伪造;不严格匹配的记录一律只保留不清理。
const registryRecordMismatch = (record, recordPath, cacheDir) => {
  const task = String(record?.task ?? '');
  if (!/^T\d+$/.test(task)) return '注册表记录 task 非 T### 形态(疑似伪造),拒绝清理';
  const normRel = String(recordPath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const expected = path.join(cacheDir, task).replace(/\\/g, '/');
  if (normRel !== expected) {
    return `注册表记录 path 与受管路径不一致(期望 ${path.join(cacheDir, task)}),疑似伪造,拒绝清理`;
  }
  if (String(record.branch ?? '') !== `relay/${task}`) {
    return `注册表记录 branch 与任务号不一致(期望 relay/${task}),疑似伪造,拒绝清理`;
  }
  return '';
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
  const report = { removed: [], candidates: [], kept: [], errors: [], stale: [] };
  let lock;
  try {
    lock = await acquireRepoLock(controlRoot, 'worktree-cleanup');
  } catch (e) {
    report.errors.push({ task: '(lock)', path: '.relay/relay.lock', reason: `无法获取仓库写锁(锁路径异常):${e?.message || String(e)}` });
    return report;
  }
  if (!lock.ok) {
    report.errors.push({ task: '(lock)', path: '.relay/relay.lock', reason: `仓库写锁被 ${lock.holder} 持有,请稍后重试` });
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
    let gitEntries = [];
    for (const entry of parseWorktreeList(listed.stdout)) {
      gitEntries.push({ ...entry, realPath: await realPath(entry.path) });
    }
    // R-03:受管目录在磁盘上存在但 Git 未登记(仓库/worktree 被移动、remove 半失败)时,
    // 先 best-effort `git worktree repair` 再重列;修不回的在循环里按「陈旧/孤儿」报告可执行恢复指引。
    const unregisteredExisting = [];
    for (const record of registry.worktrees) {
      const recordPath = typeof record.path === 'string' ? record.path : '';
      if (!recordPath || path.isAbsolute(recordPath) || path.win32.isAbsolute(recordPath)) continue;
      // 修复动作也只对严格匹配的受管记录做,伪造记录不得驱动任何 Git 写操作
      if (registryRecordMismatch(record, recordPath, cfg.cacheDir)) continue;
      const abs = path.resolve(controlRoot, recordPath);
      if (!contained(cacheAbs, abs) || !existsSync(abs)) continue;
      const real = await realPath(abs);
      if (!gitEntries.some((entry) => entry.realPath === real)) unregisteredExisting.push(abs);
    }
    if (unregisteredExisting.length) {
      await gitRun(controlRoot, 'worktree', 'repair');
      for (const dir of unregisteredExisting.slice(0, 8)) await gitRun(dir, 'worktree', 'repair');
      const relisted = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
      if (relisted.ok) {
        gitEntries = [];
        for (const entry of parseWorktreeList(relisted.stdout)) {
          gitEntries.push({ ...entry, realPath: await realPath(entry.path) });
        }
      }
    }
    // Git 侧幽灵记录(目录已被手工删除):prune 后重列,循环里再把注册表陈旧记录自动回收。
    if (gitEntries.some((entry) => !existsSync(entry.path))) {
      await gitRun(controlRoot, 'worktree', 'prune');
      const relisted2 = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
      if (relisted2.ok) {
        gitEntries = [];
        for (const entry of parseWorktreeList(relisted2.stdout)) {
          gitEntries.push({ ...entry, realPath: await realPath(entry.path) });
        }
      }
    }
    const removedKeys = new Set();
    const droppedKeys = new Set();

    for (const record of registry.worktrees) {
      const task = String(record.task || '(未知任务)');
      const recordPath = typeof record.path === 'string' ? record.path : '';
      const displayPath = recordPath || '(缺失路径)';
      const keep = async (reason) => { report.kept.push({ task, path: displayPath, reason }); };
      if (!recordPath || path.isAbsolute(recordPath) || path.win32.isAbsolute(recordPath)) {
        await keep('路径不是注册表允许的相对路径'); continue;
      }
      const poison = registryRecordMismatch(record, recordPath, cfg.cacheDir);
      if (poison) { await keep(poison); continue; }
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
        if (!existsSync(absolute)) {
          // 记录指向的目录已不存在且 Git 也不再登记 → 纯陈旧记录:自动回收记录(分支保留),
          // 不再永久沉默地在每次自动清理里刷一条「保留」。
          droppedKeys.add(`${task}\0${recordPath}`);
          report.stale.push({
            task, path: displayPath,
            reason: '目录已不存在且 Git 未登记该 worktree:注册表陈旧记录已自动回收(任务分支保留,不受影响)',
          });
          continue;
        }
        report.stale.push({
          task, path: displayPath,
          reason: '目录存在但 Git worktree 列表未登记(可能因仓库/worktree 移动或 remove 半失败),未自动删除。'
            + `恢复:确认目录无未提交价值后运行 \`git -C "${controlRoot}" worktree repair "${absolute}"\`;`
            + `仍不行则 \`rm -rf "${absolute}"\` 后重跑 relay_worktree_cleanup;任务分支始终保留`,
        });
        continue;
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
      // R-02:ignored 本地内容(.env/node_modules/构建产物)默认保留。
      // git status 的「干净」不包含 ignored 文件,而 git worktree remove 会连带删除它们 → 静默丢数据。
      const statusArgs = ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall', '--ignored=matching'];
      const status = await gitRun(actual, ...statusArgs);
      if (!status.ok) {
        await keep(`无法读取 worktree 状态:${status.stderr || status.stdout}`); continue;
      }
      const statusLines = status.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
      const dirtyLines = statusLines.filter((l) => !l.startsWith('!!'));
      const ignoredLines = statusLines.filter((l) => l.startsWith('!!'));
      if (dirtyLines.length) {
        await keep('worktree 有未提交或冲突改动(dirty)'); continue;
      }
      if (ignoredLines.length) {
        await keep(`含 ${ignoredLines.length} 项 ignored 本地内容(.env/node_modules/构建产物等,如 ${ignoredLines.slice(0, 3).join(' / ')}${ignoredLines.length > 3 ? ' 等' : ''}),默认保留;确认可丢弃后手工删除或移出缓存再重试`);
        continue;
      }
      if (!confirm) {
        report.candidates.push({ task, path: displayPath, branch: record.branch, reason: '过期、非活跃、干净且分支已保留' });
        continue;
      }

      // 删除前再核验真实路径与 dirty/ignored 状态;Git 自身仍保留最后一道非强制删除闸门。
      const verified = await realPath(absolute);
      const statusAgain = await gitRun(verified, ...statusArgs);
      if (!contained(cacheReal, verified) || verified !== actual || !statusAgain.ok) {
        await keep('删除前复核发现路径或状态变化,拒绝清理'); continue;
      }
      const againLines = statusAgain.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
      if (againLines.some((l) => !l.startsWith('!!'))) {
        await keep('删除前复核发现未提交/冲突改动,拒绝清理'); continue;
      }
      if (againLines.some((l) => l.startsWith('!!'))) {
        await keep('删除前复核发现 ignored 本地内容,默认保留'); continue;
      }
      const removed = await gitRun(controlRoot, 'worktree', 'remove', verified);
      if (!removed.ok) {
        const stillListed = await gitRun(controlRoot, 'worktree', 'list', '--porcelain');
        let deregistered = stillListed.ok;
        if (stillListed.ok) {
          for (const entry of parseWorktreeList(stillListed.stdout)) {
            if (await realPath(entry.path) === verified) { deregistered = false; break; }
          }
        }
        report.errors.push({
          task, path: displayPath,
          reason: `git worktree remove 失败:${removed.stderr || removed.stdout}`
            + (deregistered
              ? `。Git 已注销该 worktree 但目录仍在,下次清理会把它标记为陈旧孤儿。恢复:确认目录无价值后 rm -rf "${verified}",再重跑 relay_worktree_cleanup`
              : '。恢复:解决占用/权限问题后重跑 relay_worktree_cleanup;目录与注册表记录均已保留,不会丢数据'),
        });
        continue;
      }
      report.removed.push({ task, path: displayPath, branch: record.branch });
      removedKeys.add(`${task}\0${recordPath}`);
    }
    if (removedKeys.size || droppedKeys.size) {
      // fencing:cleanup 可能因逐 worktree git 检查而持锁较久,写回前复核锁仍属于本会话。
      const fence = await lock.check();
      if (!fence.held) {
        report.errors.push({
          task: '(lock)', path: '.relay/relay.lock',
          reason: `仓库锁在清理期间被接管(${fence.warning || '锁已不属于当前会话'}),注册表未写回;已删除的目录不体现在注册表更新里,请重跑 relay_worktree_cleanup 核对`,
        });
        return report;
      }
      // P2-11:写回前重新读取注册表并按记录合并,而不是整文件覆盖 hold 锁时读到的旧快照——
      // 只移除「本次确实删除/回收、且内容与快照一致」的记录;期间被并发修改/重建的记录保留。
      const latestState = await readWorktreeRegistryState(controlRoot);
      if (latestState.state === 'corrupt') {
        report.errors.push({
          task: '(registry)', path: WORKTREE_REGISTRY_REL,
          reason: `写回注册表前发现注册表损坏:${latestState.error};本次未改写注册表(已删除目录需人工核对)`,
        });
        return report;
      }
      const keyOf = (w) => `${String(w.task || '(未知任务)')}\0${w.path}`;
      const snapshot = new Map();
      for (const rec of registry.worktrees) snapshot.set(keyOf(rec), JSON.stringify(rec));
      const touched = [...new Set([...removedKeys, ...droppedKeys])];
      const latest = latestState.registry;
      const changed = touched.filter((key) => {
        const current = latest.worktrees.find((w) => keyOf(w) === key);
        return current && snapshot.get(key) !== JSON.stringify(current);
      });
      for (const key of changed) {
        const [task, recordPath] = key.split('\0');
        report.kept.push({
          task, path: recordPath || '(缺失路径)',
          reason: '清理期间该注册表记录被并发更新/重建,保留新记录(不按旧快照回写覆盖)',
        });
      }
      latest.worktrees = latest.worktrees.filter((w) => {
        const key = keyOf(w);
        if (!removedKeys.has(key) && !droppedKeys.has(key)) return true; // 非本次删除项:原样保留
        return snapshot.get(key) !== JSON.stringify(w); // 与快照不一致(并发更新):保留
      });
      await writeWorktreeRegistry(controlRoot, latest, {
        fencing: async () => {
          const verdict = await lock.check();
          return verdict.held ? { ok: true } : { ok: false, warning: verdict.warning };
        },
      });
    }
    return report;
  } catch (e) {
    const msg = e?.message || String(e);
    // 只有注册表本身的问题才套用「修复或删除注册表」指引;cacheDir 等配置错误给出独立标签,
    // 避免把配置问题误诊成注册表损坏。
    const registryIssue = /worktrees\.json|注册表/.test(msg);
    report.errors.push({
      task: registryIssue ? '(registry)' : '(config)',
      path: registryIssue ? WORKTREE_REGISTRY_REL : 'worktree.config',
      reason: msg,
    });
    return report;
  } finally {
    const rel = await lock.release();
    if (!rel.ok && rel.warning) process.stderr.write(`[relay] cleanup 仓库锁释放告警:${rel.warning}\n`);
  }
};

// 「完成≠合并」的可观测性:列出尚未并入 controlRoot HEAD 的 relay/T### 任务分支。
// 只读;用于 claim / session_start / cleanup / worktree_cleanup 的输出提示。
export const listUnmergedTaskBranches = async (controlRoot) => {
  const refs = await gitRun(controlRoot, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/relay/');
  if (!refs.ok) return [];
  const out = [];
  for (const raw of refs.stdout.split('\n')) {
    const branch = raw.trim();
    if (!branch) continue;
    const ancestor = await gitRun(controlRoot, 'merge-base', '--is-ancestor', branch, 'HEAD');
    if (ancestor.ok) continue; // 已并入 HEAD
    out.push(branch);
  }
  return out;
};

export const formatUnmergedBranchesNote = (branches, { indent = '' } = {}) => {
  if (!branches.length) return [`${indent}- 未合并任务分支:无(controlRoot HEAD 已包含全部 relay/T### 分支)`];
  return [
    `${indent}- 未合并任务分支(${branches.length}):${branches.join(', ')}`,
    `${indent}  - 完成≠合并:分支已保留、代码未并入 controlRoot;整合由人工决定(relay 不自动 merge/rebase/push)`,
  ];
};

export const relayWorktreeCleanup = async (args = {}) => {
  const roots = await resolveRelayRoots(args.root || process.cwd());
  const report = await cleanupWorktrees(roots.controlRoot, {
    confirm: args.confirm === true,
    ttlHours: args.ttl_hours,
    currentRoot: roots.executionRoot,
  });
  const dry = args.confirm !== true;
  const unmerged = await listUnmergedTaskBranches(roots.controlRoot);
  const lines = [
    `# worktree 清理 — ${dry ? 'dry-run(传 confirm:true 执行)' : '已执行'}`,
    '', `- controlRoot: ${roots.controlRoot}`, `- executionRoot: ${roots.executionRoot}`,
  ];
  if (roots.linkedWorktree && !roots.managed) {
    lines.push('', `> ⚠ 当前目录是 controlRoot 的 linked worktree,但未被 relay 注册(registryState=${roots.registryState})。`);
    lines.push(`> 状态变更操作(完成出场)将被拒绝。${registryRecoveryHint(roots.controlRoot, roots.registryState)}`);
  }
  const row = (w) => `- ${w.task}: \`${w.path}\`${w.branch ? ` — 分支 \`${w.branch}\` 保留` : ''}${w.reason ? ` — ${w.reason}` : ''}`;
  if (dry) lines.push('', `## 可清理(${report.candidates.length})`, ...(report.candidates.length ? report.candidates.map(row) : ['- 无']));
  if (!dry) lines.push('', `## 已清理(${report.removed.length})`, ...(report.removed.length ? report.removed.map(row) : ['- 无']));
  lines.push('', `## 保留(${report.kept.length})`, ...(report.kept.length ? report.kept.map(row) : ['- 无']));
  if (report.stale?.length) {
    lines.push('', `## 陈旧/孤儿现场(${report.stale.length})`, ...report.stale.map(row));
    lines.push('', '> 以上项不会被自动删除(数据安全优先);按 reason 中的可执行命令处理后,在 controlRoot 重跑 relay_worktree_cleanup 复核。');
  }
  if (report.errors.length) {
    lines.push('', `## 错误(${report.errors.length})`, ...report.errors.map(row));
    if (report.errors.some((e) => e.task === '(registry)')) {
      lines.push('', `> 修复指引:${registryRecoveryHint(roots.controlRoot, 'corrupt')}`);
    }
  }
  lines.push('', ...formatUnmergedBranchesNote(unmerged));
  lines.push('', '只删除 worktree 目录,不删除分支,不自动 merge/rebase/push。');
  return textResult(lines.join('\n'), report.errors.length > 0);
};
