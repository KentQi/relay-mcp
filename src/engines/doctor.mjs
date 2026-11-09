// relay-mcp — relay_doctor:只读环境自检(七检)。
// 铁律:
//   1) 只读:不写任何文件、不取仓库写锁、不自动修复(自动修=越 fail-closed,修复指令交给人类/下一个会话)。
//   2) 每条非 OK 结果都以「修复:」开头,给可执行指令,且只引用 relay 原生命令(绝不输出 rm)。
//   3) 诊断的是「环境/安装面」漂移,不是仓库规范(R1–R13 归 relay_verify)。
import { readFileSafe, isGitRepoAsync, gitRun, parseLockContent, templatesDir } from '../util.mjs';
import { readWorktreeRegistryState, resolveRelayRoots } from './worktree.mjs';
import { generateEntryFiles } from './sync.mjs';
import { collectUnknownManifestKeys, KNOWN_MANIFEST_KEYS, KNOWN_NESTED_KEYS } from '../config.mjs';
import { TASK_LINE_RE, DONE_TASK_RE, parseLogEntries } from './verify.mjs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { readdir, lstat } from 'node:fs/promises';

const CLAIM_TTL_MIN = 240; // 锁文件未记录 ttlMinutes 时的兜底(输出会注明)
const ok = (id, name, detail) => ({ id, name, result: 'OK', detail, fix: null });
const warn = (id, name, detail, fix) => ({ id, name, result: 'WARN', detail, fix });
const bad = (id, name, detail, fix) => ({ id, name, result: 'ERROR', detail, fix });

const readText = async (p) => {
  const t = await readFileSafe(p, null);
  return typeof t === 'string' ? t : null;
};

// D1 运行时
const checkNode = () => {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major >= 18) return ok('D1', 'Node 运行时', `v${process.versions.node}(>=18)`);
  return bad('D1', 'Node 运行时', `v${process.versions.node} 低于最低要求 18`, '升级 Node 到 18 或以上(relay 只用 node: 内置模块,无其它依赖)');
};

// D2 manifest 可解析 + schema 兼容
const levenshtein = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
};
const suggestManifestKey = (key) => {
  const dot = key.indexOf('.');
  const parent = dot > 0 ? key.slice(0, dot) : '';
  const leaf = dot > 0 ? key.slice(dot + 1) : key;
  const pool = parent && KNOWN_NESTED_KEYS[parent] ? KNOWN_NESTED_KEYS[parent] : KNOWN_MANIFEST_KEYS;
  let best = '';
  let bestD = Infinity;
  for (const c of pool) {
    const d = levenshtein(leaf, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || bestD > Math.max(2, Math.floor(leaf.length / 3))) return '';
  return parent ? `${parent}.${best}` : best;
};

// D8 完成状态收敛:TASKS [x] ↔ LOG 完成条目 ↔ registry controlCommitted
const checkCompletionConsistency = async (root) => {
  const tasks = await readText(join(root, 'TASKS.md'));
  const log = await readText(join(root, 'LOG.md'));
  if (tasks == null) return warn('D8', '完成状态', 'TASKS.md 缺失', '先 relay_init/onboard 建立任务队列');
  const doneIds = [];
  for (const line of String(tasks).split('\n')) {
    const m = line.match(TASK_LINE_RE);
    if (m && m[1] === 'x') doneIds.push(m[2]);
  }
  const entries = log ? parseLogEntries(log) : [];
  const completed = new Set(entries
    .map((e) => String(e.task || '').trim())
    .filter((t) => DONE_TASK_RE.test(t))
    .map((t) => (t.match(/^T\d+/) || [''])[0])
    .filter(Boolean));
  const missing = doneIds.filter((id) => !completed.has(id));
  const regRaw = await readText(join(root, '.relay', 'worktrees.json'));
  const regTasks = [];
  if (regRaw) {
    try {
      const reg = JSON.parse(regRaw);
      for (const w of reg.worktrees || []) if (w && w.controlCommitted === true) regTasks.push(String(w.task || ''));
    } catch { /* 注册表损坏由 doctor 其他项/引擎 fail-closed 处理 */ }
  }
  const regMissing = regTasks.filter((t) => !doneIds.includes(t));
  const issues = [];
  if (missing.length) issues.push(`TASKS 标 [x] 但 LOG 无完成条目:${missing.join(', ')}`);
  if (regMissing.length) issues.push(`registry 记录控制面已提交但 TASKS 未完成:${regMissing.join(', ')}`);
  if (issues.length) {
    return warn('D8', '完成状态', issues.join(';'), '补齐 LOG 完成条目或修正 TASKS 状态;证据不得删除,只可回填');
  }
  return ok('D8', '完成状态', `TASKS [x] ${doneIds.length} 条与 LOG 完成条目一致`);
};

// D9 白名单命令落点:acceptance.commands 里的路径型首 token 不得指向仓库外
const checkAcceptancePaths = async (root, manifest) => {
  const cmds = manifest && manifest.acceptance && Array.isArray(manifest.acceptance.commands)
    ? manifest.acceptance.commands.filter((s) => typeof s === 'string') : [];
  if (!cmds.length) return ok('D9', '验收白名单', '未配置 acceptance.commands(只接受 js/ts 测试文件)');
  const rootAbs = resolve(root);
  const bad = [];
  for (const cmd of cmds) {
    const first = cmd.trim().split(/\s+/)[0] || '';
    if (!/[/\\]/.test(first) && !first.startsWith('.') && !first.startsWith('~')) continue; // 裸命令名交给 PATH
    const abs = isAbsolute(first) ? resolve(first) : resolve(rootAbs, first);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) bad.push(`${cmd} → ${abs}`);
  }
  if (bad.length) {
    return warn('D9', '验收白名单', `命令指向仓库外:${bad.join('; ')}`, '白名单命令应使用裸命令名(npm/npx/node)或仓库内路径;确需外部工具请锁版本并评估信任边界');
  }
  return ok('D9', '验收白名单', `${cmds.length} 条命令落点在仓库内或受信 PATH`);
};

const checkManifest = async (root) => {
  const p = join(root, '.relay', 'manifest.json');
  const raw = await readText(p);
  if (raw == null) {
    return bad('D2', 'manifest', '.relay/manifest.json 缺失', '运行 relay_init(新项目)或 relay_onboard(存量项目)生成 manifest');
  }
  let m;
  try { m = JSON.parse(raw); } catch (e) {
    return bad('D2', 'manifest', `JSON 解析失败:${String(e.message).slice(0, 80)}`, '人工修复 .relay/manifest.json 语法;损坏无法还原时备份后重跑 relay_onboard');
  }
  if (!m || typeof m !== 'object') return bad('D2', 'manifest', 'manifest 不是 JSON 对象', '人工修复 .relay/manifest.json;或备份后重跑 relay_onboard');
  const issues = [];
  if (m.version !== 1) issues.push(`schema version=${JSON.stringify(m.version)}(期望 1)`);
  if (!Array.isArray(m.allowedTopLevel)) issues.push('缺 allowedTopLevel(R2 会跳过)');
  if (!Array.isArray(m.entryFiles)) issues.push('缺 entryFiles(R1 用默认三入口)');
  if (issues.length) return warn('D2', 'manifest', issues.join(';'), '按 CONTRACT.md 的 manifest schema 补齐字段;或重跑 relay_onboard(保留既有自定义配置)');
  // v1.7.0:拼错的键此前纯静默失效;doctor 点名 + 给最近似键建议(仍只读、不阻断)
  const unknown = collectUnknownManifestKeys(m);
  if (unknown.length) {
    const hints = unknown.map((k) => { const s = suggestManifestKey(k); return s ? `${k}(是想写 ${s}?)` : k; });
    return warn('D2', 'manifest', `未知键:${hints.join(', ')}`, '拼错的键会被静默忽略;按 CONTRACT.md 的 manifest schema 改名或删除该键');
  }
  return ok('D2', 'manifest', 'schema 兼容,关键字段齐全');
};

// D3 入口文件与模板投影漂移(只读 check 模式,绝不落盘)
const checkEntryDrift = async (root, manifest) => {
  const entryFiles = Array.isArray(manifest && manifest.entryFiles) ? manifest.entryFiles : ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  try {
    const res = await generateEntryFiles(root, {
      mode: 'check',
      entryFiles,
      projectName: manifest && typeof manifest.projectName === 'string' ? manifest.projectName : undefined,
      relayHome: manifest && typeof manifest.relayHome === 'string' ? manifest.relayHome : undefined,
    });
    if (res.drift.length) {
      return warn('D3', '入口投影', `${res.drift.map((d) => d.file).join(', ')} 与模板投影不一致(只读检测,未改写)`, '运行 relay_sync 重新投影入口文件(用户保留区原样携带)');
    }
    return ok('D3', '入口投影', `${entryFiles.join(', ')} 与模板一致`);
  } catch (e) {
    return warn('D3', '入口投影', `无法比对模板投影:${String(e && e.message).slice(0, 80)}`, '确认 templates/ 完整;重跑 relay_sync 复核');
  }
};

// D4 残留/过期认领锁
const checkClaimLocks = async (root) => {
  const dir = join(root, '.relay', 'claims');
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.lock')); } catch { return ok('D4', '认领锁', '无 claims 目录(无残留锁)'); }
  if (!names.length) return ok('D4', '认领锁', '无残留锁');
  const stale = [];
  for (const n of names) {
    const raw = await readText(join(dir, n));
    const info = parseLockContent(raw);
    const task = n.replace(/\.lock$/, '');
    if (!info.token) { stale.push(`${task}(空/半初始化锁)`); continue; }
    const t = info.acquiredAt ? Date.parse(info.acquiredAt) : NaN;
    const ageMin = Number.isNaN(t) ? null : Math.round((Date.now() - t) / 60000);
    // P1-13:优先用锁文件里记录的真实 TTL(claim 支持 ttl_minutes 覆盖);旧锁没有该字段时按默认 240 分钟并注明。
    const ttl = info.ttlMinutes || CLAIM_TTL_MIN;
    const ttlNote = info.ttlMinutes ? `TTL ${ttl} 分钟` : `按默认 ${ttl} 分钟判定`;
    if (ageMin == null) stale.push(`${task}(无时间戳,持有者 ${info.holder || '?'})`);
    else if (ageMin > ttl) stale.push(`${task}(已过期 ${ageMin} 分钟 > ${ttlNote},持有者 ${info.holder || '?'})`);
  }
  if (stale.length) {
    return warn('D4', '认领锁', `${stale.length} 把残留锁:${stale.join('; ')}`, '对已过期锁:relay_claim 同一 task 即可按 TTL 接管;或由原持有者 relay_session_end 释放;确认无人使用后可人工删除对应 .relay/claims/<T###>.lock');
  }
  return ok('D4', '认领锁', `${names.length} 把锁均在 TTL 内`);
};

// D5 未登记的 linked worktree(relay 任务树必须在 registry 里)
const checkWorktrees = async (root) => {
  if (!(await isGitRepoAsync(root))) return ok('D5', 'worktree', '非 git 仓库,跳过');
  const r = await gitRun(root, 'worktree', 'list', '--porcelain');
  if (!r.ok) return warn('D5', 'worktree', `无法读取 worktree 列表:${(r.stderr || r.stdout || '').split('\n')[0]}`, '确认 git 可用后重跑 relay_doctor');
  const entries = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: '' }; entries.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim();
  }
  const others = entries.filter((e) => resolve(e.path) !== resolve(root));
  if (!others.length) return ok('D5', 'worktree', '无额外 worktree');
  const regState = await readWorktreeRegistryState(root);
  const registered = new Set();
  if (regState.state === 'ok' && regState.registry) {
    for (const w of regState.registry.worktrees || []) {
      // P1-12:注册表存的是**控制根相对路径**(如 .relay/worktrees/T014),必须相对 root 解析;
      // 记录里没有 absPath 字段,旧分支是死代码。
      if (w && typeof w.path === 'string') registered.add(resolve(root, w.path));
    }
  }
  const relayish = others.filter((e) => /refs\/heads\/relay\//.test(e.branch) || e.path.includes(`${'.relay'}/worktrees`));
  const unregistered = relayish.filter((e) => !registered.has(resolve(e.path)));
  if (unregistered.length) {
    return bad('D5', 'worktree', `${unregistered.length} 个 relay 任务树未登记:${unregistered.map((e) => `${e.path}(${e.branch || 'detached'})`).join('; ')}`,
      '在 controlRoot 重新 relay_claim { worktree: true } 重建登记;或 relay_worktree_cleanup 清理过期缓存;未登记任务的完成出场会被 fail-closed 拒绝');
  }
  return ok('D5', 'worktree', `${others.length} 个额外 worktree,relay 任务树均已登记`);
};

// D6 .relay 完整性(存在/非符号链接/注册表可解析)
const checkRelayDir = async (root) => {
  const dir = join(root, '.relay');
  let st;
  try { st = await lstat(dir); } catch { return bad('D6', '.relay 目录', '.relay 不存在', '运行 relay_init/relay_onboard 初始化运行时目录'); }
  if (st.isSymbolicLink()) {
    return bad('D6', '.relay 目录', '.relay 是符号链接(协议文件可能被写到仓库外)', '把 .relay 恢复为仓库内普通目录(移除符号链接后重跑 relay_sync)');
  }
  if (!st.isDirectory()) return bad('D6', '.relay 目录', '.relay 不是目录', '把 .relay 恢复为目录;必要时从备份还原');
  const regState = await readWorktreeRegistryState(root);
  if (regState.state === 'corrupt') {
    return bad('D6', '.relay 目录', `worktree 注册表损坏:${String(regState.error || '').slice(0, 80)}`, '备份后删除 .relay/worktrees.json 再重新 relay_claim 重建登记(relay 不会猜测受管状态)');
  }
  return ok('D6', '.relay 目录', `普通目录,注册表状态=${regState.state}`);
};

// D7 引擎路径一致性(RELAY_HOME / manifest.relayHome)
const checkEnginePath = async (root, manifest) => {
  const engineRoot = resolve(templatesDir(), '..');
  const issues = [];
  const envHome = process.env.RELAY_HOME;
  if (envHome && resolve(envHome) !== engineRoot) issues.push(`RELAY_HOME=${envHome} ≠ 实际引擎 ${engineRoot}`);
  const mfHome = manifest && typeof manifest.relayHome === 'string' ? manifest.relayHome : '';
  if (mfHome && resolve(mfHome) !== engineRoot) issues.push(`manifest.relayHome=${mfHome} ≠ 实际引擎 ${engineRoot}`);
  if (issues.length) {
    return warn('D7', '引擎路径', issues.join('; '), `统一为实际引擎路径:export RELAY_HOME=${engineRoot};或重跑 relay_sync 更新 manifest.relayHome`);
  }
  return ok('D7', '引擎路径', `${engineRoot}(RELAY_HOME 与 manifest.relayHome 一致)`);
};

export const relayDoctor = async (args = {}) => {
  const inputRoot = resolve((args && args.root) || process.cwd());
  // P0-4:协议面(.relay / TASKS / LOG)只在控制根;在任务 worktree 里跑 doctor 也必须看控制根,
  // 否则 .relay 是 gitignored、只存在于控制根,会得到「未登记任务树」等假 ERROR。
  let controlRoot = inputRoot;
  try {
    const roots = await resolveRelayRoots(inputRoot);
    if (roots && roots.controlRoot) controlRoot = roots.controlRoot;
  } catch { /* 解析失败按输入根诊断 */ }
  const root = controlRoot;
  const rawManifest = await readText(join(root, '.relay', 'manifest.json'));
  let manifest = null;
  try { manifest = rawManifest ? JSON.parse(rawManifest) : null; } catch { manifest = null; }
  const engineRoot = resolve(templatesDir(), '..');
  const checks = [
    checkNode(),
    await checkManifest(root),
    await checkEntryDrift(root, manifest),
    await checkClaimLocks(root),
    await checkWorktrees(root),
    await checkRelayDir(root),
    await checkEnginePath(root, manifest),
    await checkCompletionConsistency(root),
    await checkAcceptancePaths(root, manifest),
  ];
  const counts = { OK: 0, WARN: 0, ERROR: 0 };
  for (const c of checks) counts[c.result] += 1;
  const lines = [
    `# relay doctor — ${root}`,
    '',
    `- 输入根: ${inputRoot}${inputRoot !== root ? `(已解析到 controlRoot)` : ''}`,
    `- 引擎: ${engineRoot}`,
    `- 结论: ${counts.ERROR ? `发现 ${counts.ERROR} 项 ERROR` : counts.WARN ? `可用(有 ${counts.WARN} 项 WARN)` : '健康'}`,
    '',
    '| 检查 | 结果 | 详情 |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.id} ${c.name} | ${c.result} | ${String(c.detail).replace(/\|/g, '\\|')} |`),
  ];
  const fixes = checks.filter((c) => c.fix);
  if (fixes.length) {
    lines.push('', '## 修复(按序执行;relay_doctor 只读,不会自动修改任何文件)', '');
    for (const c of fixes) lines.push(`- ${c.id} ${c.name}: 修复: ${c.fix}`);
  }
  lines.push('', counts.ERROR
    ? '存在 ERROR:按上方修复指令处理后重跑 relay_doctor。'
    : '未发现 ERROR。诊断不替代 relay_verify:仓库规范检查仍以 relay_verify 为准。');
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: counts.ERROR > 0 };
};
