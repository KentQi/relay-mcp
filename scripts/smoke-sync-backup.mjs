#!/usr/bin/env node
// T032 冒烟:relay_sync/onboard 的漂移备份(*.relay-bak-*)不得被自动提交。
// 红线:制造入口漂移 → relay_sync 重写并留下可恢复备份;备份不得出现在 git status / git add -A 暂存区;
// 旧项目(基线缺该行)运行 relay_sync 后基线被幂等补齐;重复 sync 不产生多余备份;嵌套 .relay 备份同样忽略。
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = '*.relay-bak-*';
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
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
const read = (p) => readFileSync(p, 'utf8');
const write = (p, t) => writeFileSync(p, t);
const edit = (dir, file, fn) => write(path.join(dir, file), fn(read(path.join(dir, file))));
const backupsOf = (dir, prefix = 'AGENTS.md.relay-bak-') =>
  readdirSync(dir).filter((f) => f.startsWith(prefix));
const fresh = (name) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-sync-bak-'));
  tmpDirs.push(dir);
  const r = cli('relay_init', { root: dir, name });
  if (r.status !== 0) throw new Error('relay_init 失败:' + out(r).slice(0, 800));
  return dir;
};
const drift = (dir) => edit(dir, 'AGENTS.md', (t) => t + '\n<!-- sync-drift-fixture -->\n');
const statusNoBackup = (dir) => {
  const st = git(dir, ['status', '--porcelain']);
  return { status: st.status, text: st.stdout || '', leaked: /relay-bak/.test(st.stdout || '') };
};

try {
  console.log('== 1. 新旧基线都含 *.relay-bak-*(init 与 sync 两入口)==');
  {
    const dir = fresh('sync-backup-fixture');
    const ignore = read(path.join(dir, '.gitignore'));
    ok(ignore.includes(PATTERN), 'relay_init 生成的 .gitignore 含备份忽略行', ignore);
    const initStatus = statusNoBackup(dir);
    ok(!initStatus.leaked, 'init 后工作区无备份泄漏', initStatus.text);
  }

  console.log('\n== 2. 漂移 → sync → 备份可恢复但不进 git ==');
  {
    const dir = fresh('sync-backup-drift');
    drift(dir);
    const sy = cli('relay_sync', { root: dir });
    ok(sy.status === 0, 'relay_sync 成功', out(sy).slice(0, 300));
    ok(/备份/.test(out(sy)), 'sync 报告给出备份路径(可恢复)', out(sy).slice(0, 300));
    const baks = backupsOf(dir);
    ok(baks.length === 1, '恰好产生 1 个 AGENTS 漂移备份', String(baks.length));
    if (baks.length === 1) {
      const bakText = read(path.join(dir, baks[0]));
      ok(bakText.includes('sync-drift-fixture'), '备份保留原内容(人工可恢复)');
    }
    const st = statusNoBackup(dir);
    ok(!st.leaked, '备份未出现在 git status', st.text);
    const add = git(dir, ['add', '-A']);
    ok(add.status === 0, 'git add -A 成功');
    const staged = git(dir, ['diff', '--cached', '--name-only']).stdout || '';
    ok(!/relay-bak/.test(staged), '备份未进入 git add -A 暂存区', staged);
    ok(!read(path.join(dir, 'AGENTS.md')).includes('sync-drift-fixture'), 'AGENTS.md 被重写回规范投影(漂移已修复)');
  }

  console.log('\n== 3. 旧项目升级:基线缺行 → sync 幂等补齐 ==');
  {
    const dir = fresh('sync-backup-upgrade');
    edit(dir, '.gitignore', (t) => t.split('\n').filter((l) => l.trim() !== PATTERN).join('\n'));
    ok(!read(path.join(dir, '.gitignore')).includes(PATTERN), '夹具已移除旧基线行');
    drift(dir);
    const sy = cli('relay_sync', { root: dir });
    ok(sy.status === 0, '旧项目 relay_sync 成功');
    ok(read(path.join(dir, '.gitignore')).includes(PATTERN), 'sync 幂等补齐 *.relay-bak-* 基线行');
    ok(!statusNoBackup(dir).leaked, '升级后备份同样不进 git status');
    // 重复 sync:入口已一致,不再产生新备份
    const before = backupsOf(dir).length;
    const sy2 = cli('relay_sync', { root: dir });
    ok(sy2.status === 0, '重复 relay_sync 成功');
    ok(backupsOf(dir).length === before, '无漂移时不产生多余备份', `before=${before}, after=${backupsOf(dir).length}`);
  }

  console.log('\n== 4. .relay 下的 manifest 备份同样被忽略(嵌套路径)==');
  {
    const dir = fresh('sync-backup-nested');
    write(path.join(dir, '.relay', 'manifest.json.relay-bak-20260101000000'), '{}\n');
    const st = statusNoBackup(dir);
    ok(!st.leaked, '嵌套 .relay 备份不出现在 git status', st.text);
    git(dir, ['add', '-A']);
    const staged = git(dir, ['diff', '--cached', '--name-only']).stdout || '';
    ok(!/relay-bak/.test(staged), '嵌套 .relay 备份未进入暂存区', staged);
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
