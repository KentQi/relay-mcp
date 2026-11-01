// relay-mcp — 事实底账(T013/R10):从 git/verify 确定性派生 LOG「事实」行。
// 设计铁律:
//   1) 零 LLM、零新状态:写入在 relay_session_end 内完成,校验在 relay_verify 内完成,不落 .relay。
//   2) 只比文件数,不比行数:行级 ±x/-y 会被 CRLF/重命名/合并污染,成为假裁判。
//   3) 写入侧与校验侧使用同一条 git 命令(--name-only --no-renames),口径天然一致。
import { gitRun, isGitRepo } from '../util.mjs';

export const FACT_LINE_PREFIX = '- 事实(v1):';
export const FACT_LINE_RE = /^- 事实\(v1\):\s*(.*)$/;
// 协议文件不计入「改动文件数」:它们由控制面提交维护,不是本次任务的代码事实。
const PROTOCOL_FILES = new Set(['TASKS.md', 'LOG.md']);

const diffStat = async (root, range) => {
  const names = await gitRun(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', ...range);
  const nums = await gitRun(root, '-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', ...range);
  if (!names.ok || !nums.ok) return null;
  const files = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => !PROTOCOL_FILES.has(p));
  let insertions = 0;
  let deletions = 0;
  for (const line of nums.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const p = m[3].trim();
    if (PROTOCOL_FILES.has(p)) continue;
    if (m[1] !== '-') insertions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
  }
  return { files: files.length, insertions, deletions };
};

/**
 * 派生本次会话的事实。
 * - managed: 代码提交在 executionRoot 的任务分支 → 用 baseSha..HEAD。
 * - 单根: 代码尚未提交 → 用工作区 vs HEAD(git diff HEAD)。
 * - 非 git / git 不可读: 退化为 statusLines 的文件数(± 记 0,不假装知道)。
 */
export const deriveFacts = async ({
  executionRoot,
  managed = false,
  baseSha = '',
  statusLines = [],
  verifyResults = [],
  acceptance = null,
  branch = '',
  codeSha = '',
  startedAt = 0,
}) => {
  const git = isGitRepo(executionRoot);
  let stat = null;
  if (git) {
    stat = managed && baseSha
      ? await diffStat(executionRoot, [`${baseSha}..HEAD`])
      : await diffStat(executionRoot, ['HEAD']);
  }
  if (!stat) {
    const files = (statusLines || [])
      .map((l) => String(l).slice(3).trim())
      .filter((p) => p && !PROTOCOL_FILES.has(p));
    stat = { files: files.length, insertions: 0, deletions: 0 };
  }
  const counts = { PASS: 0, WARN: 0, ERROR: 0 };
  for (const r of verifyResults || []) counts[r.result] = (counts[r.result] || 0) + 1;
  const accText = !acceptance
    ? '未要求'
    : (acceptance.fails && acceptance.fails.length)
      ? '未通过'
      : (acceptance.executed ? '通过' : '未要求');
  return {
    files: stat.files,
    insertions: stat.insertions,
    deletions: stat.deletions,
    verifyPass: counts.PASS || 0,
    verifyWarn: counts.WARN || 0,
    verifyError: counts.ERROR || 0,
    acceptance: accText,
    branch: branch || (git ? '' : '无 git'),
    sha: codeSha || '',
    durationSec: startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
    git,
  };
};

/** 事实行:由引擎写入,模型不得手写或改写(R10 会拦)。 */
export const formatFactLine = (f) => {
  const branch = f.branch || (f.git ? '未知' : '无 git');
  const sha = f.sha ? ` @${String(f.sha).slice(0, 7)}` : (f.git ? ' @未提交' : '');
  return `${FACT_LINE_PREFIX} 改动 ${f.files} 文件(+${f.insertions}/-${f.deletions}) | 验收: ${f.acceptance} | `
    + `verify: PASS ${f.verifyPass}·WARN ${f.verifyWarn}·ERROR ${f.verifyError} | 分支: ${branch}${sha} | 耗时: ${f.durationSec}s`;
};

export const parseFactLine = (text) => {
  const m = String(text || '').match(FACT_LINE_RE);
  if (!m) return null;
  const body = m[1];
  const num = (re) => {
    const x = body.match(re);
    return x ? Number(x[1]) : null;
  };
  const files = num(/改动 (\d+) 文件/);
  const pass = num(/PASS (\d+)/);
  if (files == null || pass == null) return null;
  const ins = num(/\+(\d+)\/-/);
  const del = num(/\/-(\d+)\)/);
  const acc = (body.match(/验收:\s*([^|]+?)\s*\|/) || [])[1] || null;
  const warn = num(/WARN (\d+)/);
  const err = num(/ERROR (\d+)/);
  const branchM = body.match(/分支:\s*(\S+)/);
  const shaM = body.match(/@([0-9a-f]{7,40})/);
  const dur = num(/耗时:\s*(\d+)s/);
  return {
    files,
    insertions: ins == null ? 0 : ins,
    deletions: del == null ? 0 : del,
    acceptance: acc,
    verifyPass: pass,
    verifyWarn: warn == null ? 0 : warn,
    verifyError: err == null ? 0 : err,
    branch: branchM ? branchM[1] : '',
    sha: shaM ? shaM[1] : '',
    durationSec: dur == null ? 0 : dur,
  };
};

/**
 * 校验侧重算:只数文件数,且与写入侧同一条命令。
 * 优先用事实行里的代码 SHA(managed);否则用 HEAD(单根:HEAD 就是本次完成提交)。
 * 返回 null 表示「无法定位提交」,调用方应跳过数字对账而不是判错。
 */
export const recomputeCommitFileCount = async (root, parsed) => {
  if (!isGitRepo(root)) return null;
  let range = null;
  if (parsed && parsed.sha && /^[0-9a-f]{7,40}$/.test(parsed.sha)) {
    range = [`${parsed.sha}^`, parsed.sha];
  } else {
    const msg = await gitRun(root, 'log', '-1', '--pretty=%s');
    if (!msg.ok || !/T\d+\s*完成/.test(msg.stdout)) return null;
    range = ['HEAD^', 'HEAD'];
  }
  const names = await gitRun(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', ...range);
  if (!names.ok) return null;
  return names.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((p) => !PROTOCOL_FILES.has(p)).length;
};
