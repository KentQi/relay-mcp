// relay-mcp — LOG 归档引擎(T001):把 LOG.md 尾部的旧条目搬进 docs/archive/,留一行指针。
// 设计铁律(钢人论证后采纳 A1「独立工具 + 默认 dry-run」,否决 session_end 自动归档):
//   1) 归档是全仓唯一不可逆的「移动历史」动作 —— 必须由人显式确认(confirm:true),默认只报告。
//   2) 只从尾部搬、永不触碰头部;边界严格早于最新完成条目(否则 R10 会失去最新完成提交)。
//   3) live 至少保留 keep 条(默认 8,下限 3),保证 R7 的「最近 3 条任务会话」窗口不退化。
//   4) 归档文件只在 docs/archive/ 下、只追加不改写;指针格式与 R12 一致,目标必须真实存在。
//   5) 写入走协议原语(密钥闸 + 内容 CAS + fencing),不裸写 LOG.md。
import {
  readFileSafe, writeFileAtomic, writeProtocolFile, scanSecrets, acquireRepoLock, sha256Hex, stamp,
  ensureDir, assertNoSymlinkComponents, checkProtocolFilesSafe,
} from '../util.mjs';
import { join, dirname } from 'node:path';
import { resolveRelayRoots } from './worktree.mjs';
import { LOG_TITLE_RE } from './verify.mjs';

const POINTER_RE = /^\s*<!--\s*relay:log-archive:\s*(\S+)\s*-->\s*$/;
const ARCHIVE_REL_RE = /^docs\/archive\/[^/\\]+\.md$/;
const DEFAULT_KEEP = 8;
const MIN_KEEP = 3;

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

// 解析活跃区条目(标题行 + 到下一个标题/指针之前的正文行),返回行号区间。
const parseEntries = (lines) => {
  const pointerIdx = lines.findIndex((l) => POINTER_RE.test(l));
  const limit = pointerIdx < 0 ? lines.length : pointerIdx;
  const entries = [];
  for (let i = 0; i < limit; i++) {
    const m = lines[i].match(LOG_TITLE_RE);
    if (!m) continue;
    let end = i + 1;
    while (end < limit && !LOG_TITLE_RE.test(lines[end])) end++;
    entries.push({ start: i, end, time: m[1], model: m[2], task: m[3] });
  }
  return { entries, pointerIdx, limit };
};

const isDoneTask = (task) => /^T\d+\s*完成$/.test(String(task || '').trim());

export const relayArchiveLog = async (args = {}) => {
  const inputRoot = args.root || process.cwd();
  const confirm = args.confirm === true;
  const keepArg = Number(args.keep);
  const keep = Number.isFinite(keepArg) && keepArg >= MIN_KEEP ? Math.floor(keepArg) : DEFAULT_KEEP;
  const roots = await resolveRelayRoots(inputRoot);
  const root = roots.controlRoot;
  const notes = [];
  if (roots.executionRoot !== roots.controlRoot) {
    notes.push(`- 注意:输入根是任务 worktree;归档只操作 controlRoot(${root})的 LOG.md(任务树里的 LOG 是 baseSha 快照)。`);
  }
  const logPath = join(root, 'LOG.md');
  const raw = await readFileSafe(logPath, null);
  if (raw == null) return textResult('LOG.md 不存在,无历史可归档。', false);
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const { entries, pointerIdx } = parseEntries(lines);
  if (!entries.length) return textResult('# relay_archive_log\n\nLOG.md 活跃区没有条目,无需归档。', false);
  if (entries.length <= keep) {
    return textResult([
      '# relay_archive_log — 无需归档',
      '',
      `- 活跃区条目 ${entries.length} 条 ≤ 保留下限 ${keep} 条;不移动任何内容。`,
      ...notes,
    ].join('\n'), false);
  }
  // LOG 是「最新在上」:保留前 keep 条(最新),归档其余(更旧)。
  // 方向绝不能反:搬走最新历史 = 把 live 变成最旧的一批,指针语义与人类预期完全相反。
  const kept = entries.slice(0, keep);
  const moved = entries.slice(keep);
  // 安全线:最新完成条目必须留在 live(否则 R10 的「最新完成条目」会指向归档区)。
  const newestDoneIdx = entries.findIndex((e) => isDoneTask(e.task));
  if (newestDoneIdx >= 0 && newestDoneIdx >= keep) {
    return textResult([
      '# relay_archive_log — 拒绝执行',
      '',
      `- 归档边界会覆盖最新完成条目(${entries[newestDoneIdx].time} ${entries[newestDoneIdx].task}),`,
      '  违反「边界严格早于最新完成条目」的硬约束;请增大 keep 后重试。',
    ].join('\n'), true);
  }
  const movedLines = moved.flatMap((e) => lines.slice(e.start, e.end));
  const keptLines = kept.flatMap((e) => lines.slice(e.start, e.end));
  const movedText = movedLines.join('\n').replace(/\n+$/, '');
  const keptText = keptLines.join('\n').replace(/\n+$/, '');
  // 目标归档文件:已有合法指针 → 追加到同一文件;否则新建 docs/archive/LOG-<today>.md。
  let archiveRel = '';
  if (pointerIdx >= 0) {
    const m = lines[pointerIdx].match(POINTER_RE);
    if (m && ARCHIVE_REL_RE.test(m[1])) archiveRel = m[1];
  }
  const creating = !archiveRel;
  if (creating) archiveRel = `docs/archive/LOG-${stamp().slice(0, 10)}.md`;
  const archiveAbs = join(root, archiveRel);
  const existingArchive = creating ? null : await readFileSafe(archiveAbs, null);
  // 幂等重试(审计 P1 半写):上一次若已写归档文件但 LOG 写失败,重试时不要重复追加同一段。
  const alreadyArchived = !creating && String(existingArchive || '').includes(movedText);
  const archiveContent = creating
    ? ['# 归档 — 会话日志', '', `> 由 relay_archive_log 于 ${stamp()} 从 LOG.md 尾部搬出;只增不改。`, '', movedText, ''].join('\n')
    : (alreadyArchived
      ? String(existingArchive || '')
      : `${String(existingArchive || '').replace(/\n+$/, '')}\n\n${movedText}\n`);
  const pointer = `<!-- relay:log-archive: ${archiveRel} -->`;
  const newLog = ['# 会话日志(最新在上)', '', keptText, '', pointer, ''].join('\n');
  const header = [
    '# relay_archive_log — ' + (confirm ? '已归档' : 'dry-run(未写盘)'),
    '',
    `- controlRoot: ${root}`,
    `- 活跃区条目: ${entries.length} 条(完成条目 ${entries.filter((e) => isDoneTask(e.task)).length} 条)`,
    `- 保留: ${kept.length} 条(keep=${keep},下限 ${MIN_KEEP});归档: ${moved.length} 条`, 
    `- 归档目标: ${archiveRel}${creating ? '(新建)' : '(追加)'}`,
    `- LOG 活跃行数: ${lines.slice(0, pointerIdx < 0 ? lines.length : pointerIdx).length} → ${keptText.split('\n').length}`,
    `- 边界安全: 最新完成条目 ${entries.find((e) => isDoneTask(e.task)) ? '留在 live' : '不存在(无需保护)'}`,
    ...notes,
  ].join('\n');
  if (!confirm) {
    return textResult([header, '', '确认执行请传 `confirm: true`(会写盘:LOG.md + 归档文件)。'].join('\n'), false);
  }
  // 写盘:仓库写锁 + fencing;归档文件内容先过密钥闸;LOG.md 走协议原语(内容 CAS)。
  const lock = await acquireRepoLock(root, 'archive-log');
  if (!lock.ok) return textResult(`归档被拒:仓库写锁被 ${lock.holder} 持有,请稍后重试。`, true);
  try {
    const hits = scanSecrets(archiveContent);
    if (hits.length) return textResult(`归档被拒:搬移内容含疑似密钥(${hits.length} 处),拒绝写盘。`, true);
    // 写盘前布局安全闸:docs/archive 的既有组件不得是符号链接,否则归档文件会被写到仓库外
    // (审计 P0:docs -> /tmp/OUT 时,LOG 指针仍指向仓库内路径,而内容其实在仓库外)。
    const protoSafe = await checkProtocolFilesSafe(root);
    if (!protoSafe.ok) return textResult(`归档被拒:协议文件布局不安全(${protoSafe.error})。`, true);
    // 半写防线(审计 P1):写归档文件之前先对 LOG.md 做一次内容 CAS 预检——
    // LOG 在读取后被外部改过就直接拒绝,避免「归档文件已追加、LOG 未更新」的半写。
    const logNow = await readFileSafe(logPath, null);
    if (sha256Hex(logNow == null ? '' : logNow) !== sha256Hex(raw)) {
      return textResult('归档被拒:LOG.md 在读取后被其他写入者修改(内容 CAS 失败),未写入任何文件;请重试。', true);
    }
    // 只查父目录组件:断言函数针对目录链,文件叶子由随后的原子写负责(不存在即新建)。
    const archiveDirRel = archiveRel.split('/').slice(0, -1).join('/');
    if (archiveDirRel) await assertNoSymlinkComponents(root, archiveDirRel, '归档文件目录');
    await ensureDir(dirname(archiveAbs));
    await writeFileAtomic(archiveAbs, archiveContent, { label: archiveRel });
    await writeProtocolFile(root, 'LOG.md', newLog, { token: lock.token, lockLabel: '仓库写锁', expectedHash: sha256Hex(raw) });
  } catch (e) {
    return textResult(`归档被拒:${e?.message || String(e)}`, true);
  } finally {
    await lock.release();
  }
  return textResult([
    header,
    '',
    '## 已写入',
    `- \`${archiveRel}\`(新增 ${moved.length} 条历史条目)`,
    '- `LOG.md`(保留条目 + 归档指针)',
    '',
    '> 归档文件会在下一次 `relay_session_end` 的控制面提交中一并入库(控制面白名单已包含 `docs/archive/`);',
    '> 或按人工流程自行提交。归档只移动、不删除、不压缩历史。',
  ].join('\n'), false);
};
