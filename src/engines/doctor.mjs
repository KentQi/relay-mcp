// relay-mcp — relay_doctor:只读环境自检(七检)。
// 铁律:
//   1) 只读:不写任何文件、不取仓库写锁、不自动修复(自动修=越 fail-closed,修复指令交给人类/下一个会话)。
//   2) 每条非 OK 结果都以「修复:」开头,给可执行指令,且只引用 relay 原生命令(绝不输出 rm)。
//   3) 诊断的是「环境/安装面」漂移,不是仓库规范(R1–R11 归 relay_verify)。
import { readFileSafe, isGitRepo, gitRun, parseLockContent, templatesDir } from '../util.mjs';
import { readWorktreeRegistryState } from './worktree.mjs';
import { generateEntryFiles } from './sync.mjs';
import { join, resolve } from 'node:path';
import { readdir, lstat } from 'node:fs/promises';

const CLAIM_TTL_MIN = 240;
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
    if (ageMin == null) stale.push(`${task}(无时间戳,持有者 ${info.holder || '?'})`);
    else if (ageMin > CLAIM_TTL_MIN) stale.push(`${task}(已过期 ${ageMin} 分钟,持有者 ${info.holder || '?'})`);
  }
  if (stale.length) {
    return warn('D4', '认领锁', `${stale.length} 把残留锁:${stale.join('; ')}`, '对已过期锁:relay_claim 同一 task 即可按 TTL 接管;或由原持有者 relay_session_end 释放;确认无人使用后可人工删除对应 .relay/claims/<T###>.lock');
  }
  return ok('D4', '认领锁', `${names.length} 把锁均在 TTL 内`);
};

// D5 未登记的 linked worktree(relay 任务树必须在 registry 里)
const checkWorktrees = async (root) => {
  if (!isGitRepo(root)) return ok('D5', 'worktree', '非 git 仓库,跳过');
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
      if (w && typeof w.absPath === 'string') registered.add(resolve(w.absPath));
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
  const root = resolve((args && args.root) || process.cwd());
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
  ];
  const counts = { OK: 0, WARN: 0, ERROR: 0 };
  for (const c of checks) counts[c.result] += 1;
  const lines = [
    `# relay doctor — ${root}`,
    '',
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
