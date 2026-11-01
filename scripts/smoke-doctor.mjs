#!/usr/bin/env node
// T019 冒烟:relay_doctor 只读七检(7 类故障 fixture + 零写盘断言)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-doctor-'));
let fixtureWt = ''; // P3-30:异常时也要清理,不能把完整 checkout 遗留在系统 temp
const cli = (tool, args = {}, env = {}) => spawnSync('node', [CLI, tool, '--root', tmp, '--json', JSON.stringify(args)], { encoding: 'utf8', env: { ...process.env, ...env } });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const mfPath = path.join(tmp, '.relay', 'manifest.json');

// .relay 零写盘快照:文件列表 + 大小 + mtime
const snapshot = (dir) => {
  const acc = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && e.name === '.git') continue; // .git 内部变动与 doctor 只读性无关
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { acc.push(`${rel}/dir`); walk(full, rel); }
      else { const st = statSync(full); acc.push(`${rel}|${st.size}|${st.mtimeMs}`); }
    }
  };
  walk(dir, '');
  return acc.join('\n');
};

try {
  console.log('== 健康仓库:全绿 + 零写盘 ==');
  const init = cli('relay_init', { name: 'doctor 演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));
  // P2-22:快照整个仓库树(排除 .git),才能守住 check 模式对 AGENTS.md 等根目录文件的只读铁律
  const before = snapshot(tmp);
  const d0 = cli('relay_doctor', {});
  const t0 = out(d0);
  ok(d0.status === 0, '健康仓库 doctor 退出码 0', t0.slice(0, 300));
  ok(t0.includes('D1') && t0.includes('D7'), '输出覆盖 D1–D7 七项检查');
  ok(!t0.includes('修复:'), '健康仓库无「修复:」行');
  ok(snapshot(tmp) === before, 'doctor 零写盘(整棵仓库树快照不变,含根目录入口文件)');

  console.log('\n== fixture 1:manifest 缺失 ==');
  const mfBackup = readFileSync(mfPath, 'utf8');
  rmSync(mfPath);
  const d1 = cli('relay_doctor', {});
  ok(d1.status === 1, 'manifest 缺失 → isError', out(d1).slice(0, 200));
  ok(/D2[^\n]*ERROR/.test(out(d1)) && /修复:/.test(out(d1)), 'D2 ERROR + 修复指令');
  writeFileSync(mfPath, mfBackup);

  console.log('\n== fixture 2:manifest 损坏 ==');
  writeFileSync(mfPath, '{ not json');
  const d2 = cli('relay_doctor', {});
  ok(d2.status === 1, 'manifest 损坏 → isError');
  ok(/JSON 解析失败/.test(out(d2)) && /修复:/.test(out(d2)), '报告解析失败 + 修复指令');
  writeFileSync(mfPath, mfBackup);

  console.log('\n== fixture 3:引擎路径错配 ==');
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  mf.relayHome = '/nonexistent/relay-mcp';
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
  const d3 = cli('relay_doctor', {});
  ok(/D7[^\n]*WARN/.test(out(d3)) && /修复:/.test(out(d3)), 'D7 WARN + 修复指令');
  writeFileSync(mfPath, mfBackup);

  console.log('\n== fixture 4:残留过期认领锁 ==');
  mkdirSync(path.join(tmp, '.relay', 'claims'), { recursive: true });
  const lockPath = path.join(tmp, '.relay', 'claims', 'T999.lock');
  writeFileSync(lockPath, JSON.stringify({ version: 2, holder: 'ghost', token: 'tok', acquiredAt: '2020-01-01T00:00:00.000Z' }) + '\n');
  const d4 = cli('relay_doctor', {});
  ok(/D4[^\n]*WARN/.test(out(d4)) && /过期/.test(out(d4)) && /修复:/.test(out(d4)), 'D4 WARN(过期锁)+ 修复指令');
  rmSync(lockPath);

  console.log('\n== fixture 5:未登记 relay 任务树 ==');
  const wtPath = path.join(tmp, '..', `doctor-wt-${process.pid}`);
  fixtureWt = wtPath;
  const add = spawnSync('git', ['-C', tmp, 'worktree', 'add', wtPath, '-b', 'relay/T999'], { encoding: 'utf8' });
  ok(add.status === 0, 'git worktree add 成功', (add.stderr || '').slice(0, 200));
  const d5 = cli('relay_doctor', {});
  ok(d5.status === 1, '未登记任务树 → isError');
  ok(/D5[^\n]*ERROR/.test(out(d5)) && /修复:/.test(out(d5)), 'D5 ERROR + 修复指令');
  spawnSync('git', ['-C', tmp, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' });
  spawnSync('git', ['-C', tmp, 'branch', '-D', 'relay/T999'], { encoding: 'utf8' });

  console.log('\n== fixture 6:入口投影漂移 ==');
  appendFileSync(path.join(tmp, 'AGENTS.md'), '\n## 手工追加的漂移内容\n');
  const d6 = cli('relay_doctor', {});
  ok(/D3[^\n]*WARN/.test(out(d6)) && /修复:/.test(out(d6)), 'D3 WARN(漂移)+ 修复指令');
  writeFileSync(path.join(tmp, 'AGENTS.md'), readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8').replace('\n## 手工追加的漂移内容\n', ''));

  console.log('\n== fixture 7:.relay 注册表损坏 ==');
  writeFileSync(path.join(tmp, '.relay', 'worktrees.json'), '{ corrupt');
  const d7 = cli('relay_doctor', {});
  ok(d7.status === 1, '注册表损坏 → isError');
  ok(/D6[^\n]*ERROR/.test(out(d7)) && /修复:/.test(out(d7)), 'D6 ERROR + 修复指令');
  rmSync(path.join(tmp, '.relay', 'worktrees.json'));
} finally {
  if (fixtureWt) {
    spawnSync('git', ['-C', tmp, 'worktree', 'remove', '--force', fixtureWt], { encoding: 'utf8' });
    spawnSync('git', ['-C', tmp, 'branch', '-D', 'relay/T999'], { encoding: 'utf8' });
    rmSync(fixtureWt, { recursive: true, force: true });
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
