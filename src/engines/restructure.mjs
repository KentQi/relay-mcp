// relay-mcp · 引擎 — relay_restructure:老项目目录标准化
// 原则(CONTRACT「安全与降级」):
// - 保守分类:只移动语义明确的条目(源码目录→src/、测试→tests/、工具脚本→scripts/、
//   根目录散落源码/测试文件归位);语义不明的(server/client/frontend/backend/app、
//   monorepo packages、未知目录)一律列入"需人工决定",绝不猜测;
// - 干跑默认:confirm 省略/false 只出迁移方案;confirm:true 才执行;
// - 执行铁闸:必须是 git 仓库且工作区干净(保历史、可回滚),否则拒绝;
// - 执行动作:git mv 逐项移动 → manifest 白名单修宪(先备份)→ DECISIONS 追加决策
//   → TASKS 插入"修复引用路径"任务 → LOG 记条目 → git 提交;
// - 移动后 import 路径修复是模型工作,不是机械工作——以任务形式交给下一棒,绿闸验收。
// 零依赖:仅 node: 内置。

import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  backupFile, ensureDir, findSensitiveChanges, gitIdentityArgs, gitRun, isGitRepo, nowIso,
  readFileSafe, stamp,
} from '../util.mjs';

const ok = (text) => ({ content: [{ type: 'text', text }], isError: false });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

const firstLine = (s) => (String(s || '').trim().split('\n')[0] || '').slice(0, 160);

// ── 分类表(保守:宁可列入人工,不可猜错) ─────────────────────────────
const KEEP_DIRS = new Set([
  '.git', '.relay', '.github', 'node_modules', 'dist', 'build', 'out', 'coverage',
  'docs', 'src', 'tests', 'scripts', 'public', 'static', 'assets',
  'venv', '.venv', '__pycache__', '.vscode', '.idea', '.git-hooks',
]);
const RELAY_FILES = new Set([
  'START.md', 'SPEC.md', 'DECISIONS.md', 'TASKS.md', 'LOG.md', 'verify',
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md',
]);
const CONFIG_EXACT = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'tsconfig.json', 'jsconfig.json', 'vitest.config.js', '.gitignore', '.gitattributes',
  '.editorconfig', '.npmrc', '.nvmrc', '.node-version', '.prettierrc', '.eslintrc',
  'LICENSE', 'LICENCE', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum', 'Cargo.toml', 'pom.xml', '.env',
]);
const CONFIG_RE = [
  /^tsconfig\.[^.]+\.json$/,
  /\.config\.(js|mjs|cjs|ts|mts|cts)$/,
  /^\.env\./,
  /^\.[a-z]+rc\.(js|json|ya?ml)$/,
  /^\.[a-z]+rc$/,
];
const CODE_DIR_RE = /^(lib|source|pkg|cmd|internal|core|modules)$/i;
const TEST_DIR_RE = /^(test|spec|__tests__|e2e|testing)$/i;
const SCRIPT_DIR_RE = /^(tools|tooling|bin)$/i;
// 语义不明,常见于领域切分或框架约定(Next.js app/、monorepo packages/),不猜
const AMBIGUOUS_DIR_RE = /^(app|server|client|frontend|backend|api|packages|apps|services)$/i;
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.rb', '.php']);
const TEST_FILE_RE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /^test_.*\.py$/i,
  /_test\.(py|go)$/i,
];

const isConfigFile = (n) => CONFIG_EXACT.has(n) || CONFIG_RE.some((re) => re.test(n));
const isTestFile = (n) => TEST_FILE_RE.some((re) => re.test(n));

// ── 分析:顶层条目 → {keep / moves[] / manual[]} ──────────────────────
const analyzeTop = async (root) => {
  const moves = [];
  const manual = [];
  const keep = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const n = e.name;
    if (e.isDirectory()) {
      if (KEEP_DIRS.has(n)) { keep.push(`${n}/`); continue; }
      if (AMBIGUOUS_DIR_RE.test(n)) { manual.push(`${n}/ → 语义不明(领域切分/框架约定),人工决定是否入 src/`); continue; }
      let slot = null;
      if (CODE_DIR_RE.test(n)) slot = 'src';
      else if (TEST_DIR_RE.test(n)) slot = 'tests';
      else if (SCRIPT_DIR_RE.test(n)) slot = 'scripts';
      if (!slot) { manual.push(`${n}/ → 未知用途,人工归类`); continue; }
      const dest = `${slot}/${n}`;
      moves.push({ from: n, to: dest, kind: `代码目录→${slot}/` });
      continue;
    }
    if (e.isFile()) {
      if (RELAY_FILES.has(n) || isConfigFile(n) || n.endsWith('.md') || n.startsWith('.relay-bak-') || !SRC_EXT.has(extname(n))) {
        keep.push(n);
        continue;
      }
      if (isTestFile(n)) { moves.push({ from: n, to: `tests/${n}`, kind: '测试文件→tests/' }); continue; }
      moves.push({ from: n, to: `src/${n}`, kind: '源码文件→src/' });
    }
  }
  return { moves, manual, keep };
};

const exists = async (p) => {
  try { await stat(p); return true; } catch { return false; }
};

// 移动目标碰撞检测:目标路径已存在(文件或目录)→ 降级人工
const resolveCollisions = async (root, moves, manual) => {
  const out = [];
  for (const m of moves) {
    if (await exists(join(root, m.to))) {
      manual.push(`${m.from} → ${m.to} 目标已存在,人工处理`);
      continue;
    }
    out.push(m);
  }
  return out;
};

// ── 协议记录:DECISIONS 追加 / TASKS 插任务 / LOG 记条目 ──────────────
const appendDecisions = async (root, moved) => {
  const p = join(root, 'DECISIONS.md');
  const raw = await readFileSafe(p, '');
  const entry = [
    '', `## ${stamp().slice(0, 10)} — 目录标准化(relay_restructure)`,
    '- 理由: 统一到 relay 标准结构(src/tests/scripts),多模型接力时槽位可预测',
    `- 否决: 保持原状(顶层目录分歧会在接力中持续制造摩擦;本次移动 ${moved.length} 项,git mv 保历史)`,
    '- 状态: 现行',
  ].join('\n');
  await writeFile(p, `${raw.replace(/\s*$/, '')}\n${entry}\n`, 'utf8');
};

const insertTask = async (root, movedCount) => {
  const p = join(root, 'TASKS.md');
  const raw = await readFileSafe(p, '');
  const nums = [...raw.matchAll(/T(\d+)/g)].map((m) => Number(m[1]));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const id = `T${String(next).padStart(3, '0')}`;
  const block = [
    `- [ ] ${id} 修复目录重构后的引用路径`,
    `  验收: 全部测试通过(\`node --test\` 或 \`npm test\`)`,
    `  备注: relay_restructure 移动了 ${movedCount} 个顶层条目,import/脚本引用需逐个修复`,
  ].join('\n');
  let out;
  if (/^## 待办$/m.test(raw)) out = raw.replace(/^## 待办$/m, `## 待办\n${block}`);
  else out = `${raw.replace(/\s*$/, '')}\n\n## 待办\n${block}\n`;
  await writeFile(p, out, 'utf8');
  return id;
};

const insertLog = async (root, movedCount, taskId) => {
  const p = join(root, 'LOG.md');
  const raw = await readFileSafe(p, '');
  const lines = raw.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  const entry = [
    `## ${stamp()} | model=relay | task=restructure 标准化目录(${movedCount} 项移动)`,
    '- 摘要: 源码/测试/脚本目录归位到标准槽位,manifest 白名单已修宪',
    `- 留给下一个: 修复 import 引用路径(${taskId}),验收见 TASKS.md`,
  ];
  lines.splice(titleIdx + 1, 0, ...entry);
  await writeFile(p, lines.join('\n'), 'utf8');
};

// ── 主入口 ────────────────────────────────────────────────────────────
export const relayRestructure = async (args = {}) => {
  const a = args || {};
  const root = resolve(a.root || process.cwd());
  const confirm = a.confirm === true;
  try {
    const manifestRaw = await readFileSafe(join(root, '.relay', 'manifest.json'), null);
    if (manifestRaw === null) {
      return err('未找到 `.relay/manifest.json`。先 `relay_init`(新项目)或 `relay_onboard`(老项目),再谈目录标准化。');
    }

    const r0 = await analyzeTop(root);
    const moves = await resolveCollisions(root, r0.moves, r0.manual);

    const head = `## relay:restructure — 目录标准化${confirm ? '(执行)' : '(干跑,传 confirm:true 执行)'}`;
    const moveRows = moves.length
      ? ['| 条目 | 去向 | 判定 |', '|---|---|---|',
        ...moves.map((m) => `| \`${m.from}\` | \`${m.to}\` | ${m.kind} |`)]
      : ['(无明确可移动项)'];
    const manualRows = r0.manual.length
      ? ['| 条目 | 说明 |', '|---|---|', ...r0.manual.map((m) => `| ${m.split(' → ')[0]} | ${m.split(' → ')[1] || ''} |`)]
      : [];

    if (!confirm) {
      return ok([
        head, '',
        `### 迁移方案(${moves.length} 项移动 / ${r0.manual.length} 项人工 / ${r0.keep.length} 项保持)`,
        ...moveRows, '',
        ...(r0.manual.length ? ['### 需人工决定(本工具绝不猜测,保持原位)', ...manualRows, ''] : []),
        '### 执行前提', '- git 仓库且工作区干净(git mv 保历史、可回滚)',
        '- 执行后自动:manifest 白名单修宪 + DECISIONS 记决策 + TASKS 插入"修复引用路径"任务 + LOG 记条目 + git 提交',
        '', '确认方案后传 `confirm:true` 执行。',
      ].join('\n'));
    }

    if (!moves.length) {
      return ok([head, '', '结构已达标,无可移动项;人工清单:', ...manualRows].join('\n'));
    }
    if (!isGitRepo(root)) return err('非 git 仓库:拒绝执行(无历史可保、无法回滚)。先 `git init` 并提交当前状态。');
    const st = await gitRun(root, 'status', '--porcelain');
    if (!st.ok) return err(`无法读取 git 状态:${firstLine(st.stderr)}`);
    if (st.stdout.trim()) return err(['工作区不干净,拒绝执行:', ...st.stdout.trim().split('\n').slice(0, 5).map((l) => `- ${l}`), '先提交或暂存(git stash)再来。'].join('\n'));

    const done = [];
    for (const m of moves) {
      await ensureDir(join(root, dirname(m.to)));
      const mv = await gitRun(root, 'mv', m.from, m.to);
      if (!mv.ok) return err(`git mv ${m.from} → ${m.to} 失败:${firstLine(mv.stderr)}(已移动项保持原状,可 git status 查看;修复后重试)`);
      done.push(m);
    }

    // manifest 修宪:白名单只增不减(并集),旧条目残留无害
    let manifest = {};
    try { manifest = JSON.parse(manifestRaw); } catch { /* 损坏则重建最小骨架 */ }
    const newTop = await readdir(root).then((xs) => xs).catch(() => []);
    const allowed = [...new Set([...(manifest.allowedTopLevel || []), ...newTop])].sort();
    manifest.allowedTopLevel = allowed;
    manifest.restructuredAt = nowIso();
    const manifestPath = join(root, '.relay', 'manifest.json');
    const bak = await backupFile(manifestPath);
    await ensureDir(join(root, '.relay'));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const taskId = await insertTask(root, done.length);
    await appendDecisions(root, done);
    await insertLog(root, done.length, taskId);

    // 密钥安检(H-B):移动/提交不搬运疑似密钥文件,转人工(与 session_end 同一条规则)
    const stSec = await gitRun(root, '-c', 'core.quotePath=false', 'status', '--porcelain');
    const sens = stSec.ok ? findSensitiveChanges(stSec.stdout.split('\n')) : [];
    if (sens.length) {
      return err(`提交跳过:发现疑似密钥/敏感文件,拒绝卷入 git 历史(需人工处理):${sens.slice(0, 3).map((s) => s.path).join(', ')}。移动与协议记录已完成,提交请人工执行`);
    }
    const cm = await gitRun(root, 'add', '-A');
    const cc = cm.ok ? await gitRun(root, ...(await gitIdentityArgs(root)), 'commit', '-m', `relay: restructure — 标准化目录(${done.length} 项移动)`) : cm;
    const gitLine = cc.ok
      ? `已提交:${firstLine(cc.stdout) || 'relay: restructure'}`
      : `提交跳过:${firstLine(cc.stderr)}(文件已移动,可稍后手动提交)`;

    return ok([
      head, '',
      `### 已移动(${done.length})`, ...moveRows, '',
      ...(r0.manual.length ? ['### 需人工决定(未动)', ...manualRows, ''] : []),
      '### 协议记录',
      `- manifest:白名单已修宪(原文件备份:${bak ? basename(bak) : '无(原缺失)'})`,
      `- DECISIONS:追加"目录标准化"决策;LOG:记录本次移动`,
      `- TASKS:插入 **${taskId} 修复目录重构后的引用路径**(验收:全部测试通过)`,
      `- git:${gitLine}`,
      '',
      '### 下一棒', `1. \`relay_session_start\` 进场 → 认领 ${taskId},逐个修复 import/脚本引用`, '2. `relay_verify` 全绿 + 测试通过后 `relay_session_end` 出场',
    ].join('\n'));
  } catch (e) {
    return err(`relay_restructure 执行失败:${firstLine(e && e.message) || String(e)}`);
  }
};
