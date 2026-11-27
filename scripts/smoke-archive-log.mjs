#!/usr/bin/env node
// T001 冒烟:relay_archive_log —— 默认 dry-run、只从尾部搬(方向正确)、留可验证指针、条目守恒、不可洗绿 R7。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};
const run = (root, tool, args = {}) => spawnSync('node', [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const entryCount = (text) => (text.match(/^## /gm) || []).length;
const activeLines = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s*<!--\s*relay:log-archive:/.test(l));
  return (i < 0 ? lines : lines.slice(0, i)).filter((l, idx, arr) => !(idx === arr.length - 1 && l === '')).length;
};
const pointerOf = (text) => (text.match(/<!--\s*relay:log-archive:\s*(\S+)\s*-->/) || [])[1] || '';
const tmp = mkdtempSync(path.join(tmpdir(), 'relay-archive-'));
const logPath = path.join(tmp, 'LOG.md');
const tasksPath = path.join(tmp, 'TASKS.md');
const makeLog = (n) => {
  const lines = ['# 会话日志(最新在上)', ''];
  for (let i = n; i >= 1; i--) {
    lines.push(`## 2026-01-${String((i % 28) + 1).padStart(2, '0')} 10:00 | model=fixture | task=维护`);
    lines.push(`- 摘要: 历史条目 ${i}`);
    lines.push(`- 负结果: 历史夹具负结果 ${i}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
};

try {
  const init = run(tmp, 'relay_init', { name: '归档夹具' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 200));
  const logBefore = makeLog(40);
  writeFileSync(logPath, logBefore);
  ok(activeLines(logBefore) > 150, '夹具 LOG 活跃区 > 150 行(触发 R12)', String(activeLines(logBefore)));

  console.log('\n== dry-run:只报告,不写盘 ==');
  const dry = run(tmp, 'relay_archive_log', {});
  ok(dry.status === 0, 'dry-run 成功', out(dry).slice(0, 300));
  ok(/dry-run/.test(out(dry)), '输出标注 dry-run');
  ok(/归档: \d+ 条/.test(out(dry)), '报告将归档条目数');
  ok(readFileSync(logPath, 'utf8') === logBefore, 'dry-run 未修改 LOG.md');
  const archiveMds0 = existsSync(path.join(tmp, 'docs', 'archive')) ? readdirSync(path.join(tmp, 'docs', 'archive')).filter((n) => /\.md$/.test(n)) : [];
  ok(archiveMds0.length === 0, 'dry-run 未创建归档文件', archiveMds0.join(','));

  console.log('\n== confirm:归档旧条目 + 指针 + 条目守恒 + R12 PASS ==');
  const run1 = run(tmp, 'relay_archive_log', { confirm: true });
  ok(run1.status === 0, 'confirm 执行成功', out(run1).slice(0, 400));
  const logAfter = readFileSync(logPath, 'utf8');
  const ptr = pointerOf(logAfter);
  ok(/^docs\/archive\/LOG-[^/]+\.md$/.test(ptr), 'LOG.md 留了合法归档指针(LOG-*)', ptr);
  ok(ptr && existsSync(path.join(tmp, ptr)), '指针目标文件真实存在', ptr);
  const archivedText = ptr ? readFileSync(path.join(tmp, ptr), 'utf8') : '';
  ok(entryCount(logAfter) + entryCount(archivedText) === entryCount(logBefore),
    '条目守恒(归档前 = live + 归档)', `${entryCount(logBefore)} vs ${entryCount(logAfter)}+${entryCount(archivedText)}`);
  ok(activeLines(logAfter) < 150, '归档后活跃区 < 150 行', String(activeLines(logAfter)));
  ok(entryCount(logAfter) >= 3, 'live 至少保留 3 条(R7 窗口不退化)', String(entryCount(logAfter)));
  const v1 = run(tmp, 'relay_verify', { full: true });
  ok(v1.status === 0 && /R12\s*\|\s*PASS/.test(out(v1)), 'verify 通过且 R12 PASS', out(v1).slice(0, 400));

  console.log('\n== 旧式非 LOG 指针:新建 LOG-* 归档并保留旧文件 ==');
  {
    const legacyTmp = mkdtempSync(path.join(tmpdir(), 'relay-archive-legacy-'));
    try {
      const li = run(legacyTmp, 'relay_init', { name: '旧式指针' });
      ok(li.status === 0, 'legacy fixture init 成功', out(li).slice(0, 200));
      mkdirSync(path.join(legacyTmp, 'docs', 'archive'), { recursive: true });
      const legacyRel = 'docs/archive/notes.md';
      const legacyPath = path.join(legacyTmp, legacyRel);
      writeFileSync(legacyPath, '# 旧式归档\n\n## 2025-12-01 10:00 | model=x | task=T001 完成\n- 摘要: legacy\n');
      const legacyBefore = readFileSync(legacyPath, 'utf8');
      writeFileSync(path.join(legacyTmp, 'LOG.md'), makeLog(40) + `\n<!-- relay:log-archive: ${legacyRel} -->\n`);
      const lr = run(legacyTmp, 'relay_archive_log', { confirm: true });
      ok(lr.status === 0, '旧式指针下归档成功', out(lr).slice(0, 300));
      const lptr = pointerOf(readFileSync(path.join(legacyTmp, 'LOG.md'), 'utf8'));
      ok(/^docs\/archive\/LOG-[^/]+\.md$/.test(lptr), '指针改指新的 LOG-* 归档', lptr);
      ok(readFileSync(legacyPath, 'utf8') === legacyBefore, '旧的非 LOG 归档文件未被改写', legacyRel);
    const lv = run(legacyTmp, 'relay_verify', { full: true });
    ok(/R12\s*\|\s*PASS/.test(out(lv)), '新指针被 R12 承认', out(lv).split('\n').filter((l) => l.startsWith('| R12') || l.startsWith('**汇总')).join('\n'));
    } finally { rmSync(legacyTmp, { recursive: true, force: true }); }
  }

  console.log('\n== 方向:归档最旧,live 保留最新(P1-1) ==');
  const mLog = ['# 会话日志(最新在上)', ''];
  for (let i = 10; i >= 1; i--) { mLog.push(`## 2026-01-01 ${String(i).padStart(2, '0')}:00 | model=x | task=维护`); mLog.push(`- 摘要: m${i}`); mLog.push(''); }
  writeFileSync(logPath, mLog.join('\n'));
  const dirRun = run(tmp, 'relay_archive_log', { confirm: true, keep: 3 });
  ok(dirRun.status === 0, 'keep=3 归档成功', out(dirRun).slice(0, 400));
  const logDir = readFileSync(logPath, 'utf8');
  ok(/m10/.test(logDir) && /m9/.test(logDir) && /m8/.test(logDir), 'live 保留最新 3 条(m10/m9/m8)');
  ok(!/m7\b/.test(logDir) && !/m1\b/.test(logDir), 'live 不含旧条目(m7/m1;m1\\b 不误伤 m10)');
  const archDir = readFileSync(path.join(tmp, pointerOf(logDir)), 'utf8');
  ok(/m7/.test(archDir) && /m1/.test(archDir) && !/m10/.test(archDir), '归档文件是最旧 7 条(m7..m1),不含最新');

  console.log('\n== 维护条目不占 R7 的 3 个任务会话配额 ==');
  {
    const mixed = ['# 会话日志(最新在上)', ''];
    const tasks = ['T201 完成', 'T202 完成', 'T203 完成'];
    tasks.forEach((task, i) => {
      mixed.push(`## 2026-02-0${i + 1} 10:00 | model=x | task=${task}`, `- 摘要: task-${i + 1}`, '');
      mixed.push(`## 2026-02-0${i + 1} 11:00 | model=x | task=无`, '- 摘要: maintenance', '');
    });
    for (let i = 0; i < 8; i += 1) mixed.push(`## 2026-01-01 10:00 | model=x | task=T3${i} 完成`, '- 摘要: old', '');
    writeFileSync(logPath, mixed.join('\n'));
    const mixedRun = run(tmp, 'relay_archive_log', { confirm: true, keep: 3 });
    ok(mixedRun.status === 0, '混合条目 keep=3 可归档', out(mixedRun).slice(0, 300));
    const live = readFileSync(logPath, 'utf8');
    const liveTasks = [...live.matchAll(/task=(T\d+) 完成/g)].map((m) => m[1]);
    ok(liveTasks.includes('T201') && liveTasks.includes('T202') && liveTasks.includes('T203'),
      '第 3 个任务会话在 keep 之外时扩展边界保留', liveTasks.join(','));
    const r7 = out(run(tmp, 'relay_verify', { full: true }));
    ok(/R7\s*\|\s*PASS/.test(r7) && /最近 3 条任务会话/.test(r7), '归档后 R7 仍有完整 3 会话窗口', r7.match(/R7[^\n]+/)?.[0] || '');
  }

  console.log('\n== R7 不可被归档洗绿(P0-3) ==');
  writeFileSync(tasksPath, ['# 任务队列', '', '## 进行中', '', '## 待办', '', '## 已完成',
    '- [x] T100 完成  (2026-01-01)', '- [x] T101 完成  (2026-01-01)', '- [x] T102 完成  (2026-01-01)'].join('\n') + '\n');
  const divLog = ['# 会话日志(最新在上)', ''];
  for (let i = 406; i >= 400; i--) { divLog.push(`## 2026-01-02 10:00 | model=x | task=T${i} 未完成`); divLog.push(`- 摘要: divergence ${i}`); divLog.push(''); }
  for (let i = 102; i >= 100; i--) { divLog.push(`## 2026-01-01 10:00 | model=x | task=T${i} 完成`); divLog.push(`- 摘要: done ${i}`); divLog.push(''); }
  writeFileSync(logPath, divLog.join('\n'));
  ok(/R7\s*\|\s*ERROR/.test(out(run(tmp, 'relay_verify', { full: true }))), '归档前 R7 ERROR(发散证据在最顶部)');
  const wash = run(tmp, 'relay_archive_log', { confirm: true, keep: 3 });
  ok(wash.status === 1 && /拒绝执行/.test(out(wash)), 'keep=3 会切走最新/完成条目 → 拒绝执行(fail-closed)', out(wash).slice(0, 300));
  ok(/R7\s*\|\s*ERROR/.test(out(run(tmp, 'relay_verify', { full: true }))), '尝试归档后 R7 仍 ERROR(判官未被洗绿)');

  console.log('\n== docs 符号链接 → 拒绝写穿(P0-1) ==');
  const tmp2 = mkdtempSync(path.join(tmpdir(), 'relay-archive-sym-'));
  try {
    run(tmp2, 'relay_init', { name: 'sym' });
    const outside = mkdtempSync(path.join(tmpdir(), 'relay-outside-'));
    rmSync(path.join(tmp2, 'docs'), { recursive: true, force: true });
    // Windows 无 SeCreateSymbolicLinkPrivilege(未开开发者模式)时目录符号链接建不出来(EPERM);
    // 改用 junction——普通用户即可创建,Node lstat 同样识别为符号链接,写穿防线照常可测
    symlinkSync(outside, path.join(tmp2, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(tmp2, 'LOG.md'), makeLog(30));
    const symRun = run(tmp2, 'relay_archive_log', { confirm: true });
    ok(symRun.status === 1 && /符号链接|拒绝/.test(out(symRun)), 'docs 符号链接 → 归档拒绝(不写仓库外)', out(symRun).slice(0, 300));
    ok(readdirSync(outside).length === 0, '仓库外目录未出现归档文件');
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(tmp2, { recursive: true, force: true }); }

  console.log('\n== 幂等:低于保留条件 → no-op ==');
  writeFileSync(logPath, ['# 会话日志(最新在上)', '', '## 2026-01-01 10:00 | model=x | task=维护', '- 摘要: only one', ''].join('\n'));
  const smallLog = readFileSync(logPath, 'utf8');
  const again = run(tmp, 'relay_archive_log', { confirm: true });
  ok(again.status === 0 && /无需归档/.test(out(again)), '重复归档为 no-op', out(again).slice(0, 300));
  ok(readFileSync(logPath, 'utf8') === smallLog, 'no-op 未改动 LOG.md');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
