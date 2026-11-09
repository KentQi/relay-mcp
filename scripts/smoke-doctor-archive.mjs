#!/usr/bin/env node
// T033 冒烟:relay_doctor D8 完成状态证据面纳入 docs/archive。
// 红线:归档文件里的完成条目要能证明 TASKS [x](归档后不再永久 WARN);
// 悬空/越界归档指针必须 fail-closed 报警(即使任务已被 LOG 覆盖也不静默 PASS);未引用的归档文件同样算证据。
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; console.log('  ✗ FAIL ' + label + (extra ? ' — ' + String(extra).slice(0, 500) : '')); }
};

const cli = (tool, args) => spawnSync(
  process.execPath,
  [path.join(RELAY, 'src/cli.mjs'), tool, '--json', JSON.stringify(args)],
  { encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: process.env.npm_config_cache || '/tmp/npm-cache' } },
);
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const row = (text, id) => (text.match(new RegExp('^\\| ' + id + ' .*$', 'm')) || [''])[0];
const read = (p) => readFileSync(p, 'utf8');
const write = (p, t) => writeFileSync(p, t);
const edit = (dir, file, fn) => write(path.join(dir, file), fn(read(path.join(dir, file))));
const fresh = (name) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-doctor-archive-'));
  tmpDirs.push(dir);
  const r = cli('relay_init', { root: dir, name });
  if (r.status !== 0) throw new Error('relay_init 失败:' + out(r).slice(0, 800));
  return dir;
};
const markDone = (dir, id, date = '2026-01-01') => edit(dir, 'TASKS.md', (t) => t
  .split('\n')
  .map((line) => {
    const m = line.match(/^- \[ \] (T\d+) (.*)$/);
    return m && m[1] === id ? `- [x] ${id} ${m[2]}  (${date})` : line;
  })
  .join('\n'));
const addLogEntry = (dir, text) => edit(dir, 'LOG.md', (t) => {
  const lines = t.split('\n');
  lines.splice(1, 0, '', text);
  return lines.join('\n');
});
const addArchive = (dir, name, entryText) => {
  mkdirSync(path.join(dir, 'docs', 'archive'), { recursive: true });
  write(path.join(dir, 'docs', 'archive', name), '# LOG 归档\n\n' + entryText + '\n');
};
const pointer = (dir, rel) => edit(dir, 'LOG.md', (t) => t + `\n<!-- relay:log-archive: ${rel} -->\n`);
const doctor = (dir) => out(cli('relay_doctor', { root: dir }));

try {
  console.log('== 1. 归档完成条目可证明 TASKS [x](不再永久 WARN)==');
  {
    const dir = fresh('d8-archive-ok');
    markDone(dir, 'T002');
    addArchive(dir, 'LOG-2026-01.md', '## 2026-01-01 10:00 | model=claude | task=T002 完成');
    pointer(dir, 'docs/archive/LOG-2026-01.md');
    const d8 = row(doctor(dir), 'D8');
    ok(/D8 .*\|\s*OK/.test(d8), '归档证据 → D8 OK', d8);
    ok(/归档/.test(d8), 'D8 详情说明已完成条目来自归档', d8);
  }

  console.log('\n== 2. 无任何完成证据 → 仍 WARN(不放松原有检查)==');
  {
    const dir = fresh('d8-no-evidence');
    markDone(dir, 'T002');
    const d8 = row(doctor(dir), 'D8');
    ok(/D8 .*\|\s*WARN/.test(d8) && /T002/.test(d8), '无 LOG/归档完成条目 → WARN 点名 T002', d8);
  }

  console.log('\n== 3. 悬空指针 fail-closed:即使任务已被 LOG 覆盖也不静默 PASS ==');
  {
    const dir = fresh('d8-dangling');
    markDone(dir, 'T002');
    addLogEntry(dir, '## 2026-01-01 10:00 | model=claude | task=T002 完成');
    pointer(dir, 'docs/archive/LOG-9999.md');
    const d8 = row(doctor(dir), 'D8');
    ok(/D8 .*\|\s*WARN/.test(d8), '悬空归档指针 → D8 WARN', d8);
    ok(/指针/.test(d8) && /未被承认/.test(d8), 'WARN 说明归档指针未被承认', d8);
  }

  console.log('\n== 4. 越界指针(不在 docs/archive/*.md)→ fail-closed ==');
  {
    const dir = fresh('d8-outside');
    markDone(dir, 'T002');
    addLogEntry(dir, '## 2026-01-01 10:00 | model=claude | task=T002 完成');
    write(path.join(dir, 'docs', 'LOG-x.md'), '# not an archive\n');
    pointer(dir, 'docs/LOG-x.md');
    const d8 = row(doctor(dir), 'D8');
    ok(/D8 .*\|\s*WARN/.test(d8) && /未被承认/.test(d8), '越界指针 → D8 WARN 并说明未被承认', d8);
  }

  console.log('\n== 5. 未被指针引用的归档文件也算证据(归档不因失去指针而失忆)==');
  {
    const dir = fresh('d8-orphan-archive');
    markDone(dir, 'T003');
    addArchive(dir, 'LOG-2025-old.md', '## 2025-12-01 10:00 | model=claude | task=T003 完成');
    const d8 = row(doctor(dir), 'D8');
    ok(/D8 .*\|\s*OK/.test(d8) && /归档/.test(d8), '孤立归档文件仍被纳入 D8 证据面', d8);
  }
} catch (e) {
  fail += 1;
  console.log('\n✗ FATAL: 套件中途未捕获异常,判失败\n' + (e && e.stack ? e.stack : e));
} finally {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}
