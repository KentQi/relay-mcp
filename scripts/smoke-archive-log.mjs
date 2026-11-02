#!/usr/bin/env node
// T001 冒烟:relay_archive_log —— 归档必须默认 dry-run、只从尾部搬、留可验证指针、条目守恒。
// 验收(可执行):dry-run 不写盘;confirm 后 R12 PASS、指针目标存在、条目守恒、幂等。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
const tmp = mkdtempSync(path.join(tmpdir(), 'relay-archive-'));
const cli = (tool, args = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const logPath = path.join(tmp, 'LOG.md');
const archiveDir = path.join(tmp, 'docs', 'archive');
// 造 40 条维护条目 × 5 行 ≈ 200 行(避开完成语义,只触发 R12 行数轴)
const makeLog = () => {
  const lines = ['# 会话日志(最新在上)', ''];
  for (let i = 40; i >= 1; i--) {
    lines.push(`## 2026-01-${String((i % 28) + 1).padStart(2, '0')} 10:00 | model=fixture | task=维护`);
    lines.push(`- 摘要: 历史条目 ${i}`);
    lines.push(`- 负结果: 历史夹具负结果 ${i}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
};
const entryCount = (text) => (text.match(/^## /gm) || []).length;
const activeLines = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s*<!--\s*relay:log-archive:/.test(l));
  return (i < 0 ? lines : lines.slice(0, i)).filter((l, idx, arr) => !(idx === arr.length - 1 && l === '')).length;
};

try {
  const init = cli('relay_init', { name: '归档夹具' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 200));
  const logBefore = makeLog();
  writeFileSync(logPath, logBefore);
  ok(activeLines(logBefore) > 150, '夹具 LOG 活跃区 > 150 行(触发 R12)', String(activeLines(logBefore)));

  console.log('\n== dry-run:只报告,不写盘 ==');
  const dry = cli('relay_archive_log', {});
  ok(dry.status === 0, 'dry-run 成功', out(dry).slice(0, 400));
  ok(/dry-run/.test(out(dry)), '输出标注 dry-run');
  ok(/归档: \d+ 条/.test(out(dry)), '报告将归档的条目数', out(dry).slice(0, 400));
  ok(readFileSync(logPath, 'utf8') === logBefore, 'dry-run 未修改 LOG.md');
  const archiveMds = existsSync(archiveDir) ? readdirSync(archiveDir).filter((n) => /^LOG-.*\.md$/.test(n)) : [];
  ok(archiveMds.length === 0, 'dry-run 未创建归档文件', archiveMds.join(','));

  console.log('\n== confirm:归档 + 指针 + 条目守恒 ==');
  const run = cli('relay_archive_log', { confirm: true });
  ok(run.status === 0, 'confirm 执行成功', out(run).slice(0, 500));
  ok(/已归档/.test(out(run)), '输出标注已归档');
  const logAfter = readFileSync(logPath, 'utf8');
  const ptr = (logAfter.match(/<!--\s*relay:log-archive:\s*(\S+)\s*-->/) || [])[1] || '';
  ok(/^docs\/archive\/[^/]+\.md$/.test(ptr), 'LOG.md 留了合法归档指针', ptr);
  ok(ptr && existsSync(path.join(tmp, ptr)), '指针目标文件真实存在', ptr);
  const archivedText = ptr ? readFileSync(path.join(tmp, ptr), 'utf8') : '';
  ok(entryCount(logAfter) + entryCount(archivedText) === entryCount(logBefore),
    '条目守恒(归档前 = live + 归档)', `${entryCount(logBefore)} vs ${entryCount(logAfter)}+${entryCount(archivedText)}`);
  ok(activeLines(logAfter) < 150, '归档后活跃区 < 150 行', String(activeLines(logAfter)));
  ok(entryCount(logAfter) >= 3, 'live 至少保留 3 条(R7 窗口不退化)', String(entryCount(logAfter)));

  console.log('\n== verify:R12 转 PASS ==');
  const v = cli('relay_verify', { full: true });
  ok(v.status === 0, 'verify 通过', out(v).slice(0, 500));
  ok(/R12\s*\|\s*PASS/.test(out(v)), 'R12 PASS', out(v).slice(0, 600));

  console.log('\n== 幂等:已低于保留下限 → 不再搬 ==');
  const again = cli('relay_archive_log', { confirm: true });
  ok(again.status === 0 && /无需归档/.test(out(again)), '重复归档为 no-op', out(again).slice(0, 300));
  ok(readFileSync(logPath, 'utf8') === logAfter, 'no-op 未改动 LOG.md');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
