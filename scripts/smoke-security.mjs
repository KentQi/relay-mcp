#!/usr/bin/env node
// 安全回归(第五轮审计 P0/P1/P2):写穿 / 密钥入史 / 半写 / 判官劫持 / 指针越界。
// 全部在临时目录构造,不触碰仓库工作区。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
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
const row = (r, id) => (out(r).split('\n').find((l) => new RegExp(`^\\| ${id} \\|`).test(l)) || '');
const base = mkdtempSync(path.join(tmpdir(), 'relay-sec-'));
let n = 0;
const fresh = () => { const d = path.join(base, `r${++n}`); mkdirSync(d); return d; };

try {
  console.log('\n== P0-1 init/onboard 符号链接写穿 ==');
  {
    const root = fresh();
    const outside = path.join(base, 'outside-docs'); mkdirSync(outside);
    // Windows 无 SeCreateSymbolicLinkPrivilege 时目录符号链接建不出来(EPERM);改用 junction
    // (普通用户即可创建,Node lstat 同样识别为符号链接,写穿防线照常可测)
    symlinkSync(outside, path.join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    const r = run(root, 'relay_init', { name: 'x', preset: 'node' });
    ok(r.status === 1 && /符号链接|拒绝/.test(out(r)), 'init:docs 是符号链接 → 拒绝', out(r).slice(0, 300));
    ok(readdirSync(outside).length === 0, 'init:仓库外目录未被写入');
    const root2 = fresh();
    const outside2 = path.join(base, 'outside-relay'); mkdirSync(outside2);
    symlinkSync(outside2, path.join(root2, '.relay'), process.platform === 'win32' ? 'junction' : 'dir');
    const r2 = run(root2, 'relay_onboard', {});
    ok(r2.status === 1 && /符号链接|拒绝/.test(out(r2)), 'onboard:.relay 是符号链接 → 拒绝', out(r2).slice(0, 300));
    ok(!existsSync(path.join(outside2, 'manifest.json')), 'onboard:仓库外未出现 manifest');
  }

  console.log('\n== P0-2 项目名注入 / 密钥进 git 历史 ==');
  {
    const root = fresh();
    const r = run(root, 'relay_init', { name: 'audit\n- [x] T999 fake\nAKIAABCDEFGHIJKLMNOP', preset: 'node' });
    ok(r.status === 1 && /密钥|拒绝/.test(out(r)), 'init:密钥项目名 → 拒绝', out(r).slice(0, 300));
    ok(!existsSync(path.join(root, 'AGENTS.md')), 'init:拒绝后未写任何文件');
    const root2 = fresh();
    const r2 = run(root2, 'relay_init', { name: 'P-{{TODAY}}', preset: 'minimal' });
    const agents = existsSync(path.join(root2, 'AGENTS.md')) ? readFileSync(path.join(root2, 'AGENTS.md'), 'utf8') : '';
    ok(r2.status === 0 && !/P-\d{4}-\d{2}-\d{2}/.test(agents), 'init:项目名占位符不被二阶展开', agents.split('\n')[0]);
    ok(/^# P-TODAY/m.test(agents), 'init:花括号被净化(字面量,不成占位)', agents.split('\n')[0]);
  }

  console.log('\n== P1 session_end 半写(LOG 密钥被拦时 TASKS 不得先写) ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'half' });
    const tasksPath = path.join(root, 'TASKS.md');
    const logPath = path.join(root, 'LOG.md');
    const before = readFileSync(tasksPath, 'utf8');
    writeFileSync(logPath, readFileSync(logPath, 'utf8') + '\n## 2026-01-01 09:00 | model=x | task=维护\n- 摘要: AKIAABCDEFGHIJKLMNOP relay:secret-ok\n');
    const end = run(root, 'relay_session_end', { model: 'half', summary: '半写测试', next: { title: 'X', acceptance: 'echo ok' } });
    ok(end.status === 1 && /已阻断|未写入/.test(out(end)), 'session_end:LOG 密钥 → isError', out(end).slice(0, 300));
    ok(readFileSync(tasksPath, 'utf8') === before, 'session_end:失败时 TASKS 未被写入(无半写)');
  }

  console.log('\n== P2 next.acceptance 注入在写入前被拒 ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'acc' });
    const before = readFileSync(path.join(root, 'TASKS.md'), 'utf8');
    const r = run(root, 'relay_session_end', { model: 'acc', summary: 'x', next: { title: 'Y', acceptance: 'test:-rf /tmp/x' } });
    ok(r.status === 1 && /acceptance|非法/.test(out(r)), 'next.acceptance=test:-rf → 写入前拒绝', out(r).slice(0, 300));
    ok(readFileSync(path.join(root, 'TASKS.md'), 'utf8') === before, '拒绝时 TASKS 未变');
  }

  console.log('\n== P2 R11 扫描入口/协议文件与全部归档 md ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'r11' });
    writeFileSync(path.join(root, 'AGENTS.md'), readFileSync(path.join(root, 'AGENTS.md'), 'utf8') + '\n- leaked AKIAABCDEFGHIJKLMNOP\n');
    const r = run(root, 'relay_verify', { full: true });
    ok(/R11\s*\|\s*ERROR/.test(row(r, 'R11')), 'R11:AGENTS.md 含密钥 → ERROR', row(r, 'R11'));
    const root2 = fresh();
    run(root2, 'relay_init', { name: 'r11b' });
    mkdirSync(path.join(root2, 'docs', 'archive'), { recursive: true });
    writeFileSync(path.join(root2, 'docs', 'archive', 'notes.md'), '# notes\n\n- AKIAABCDEFGHIJKLMNOP\n');
    writeFileSync(path.join(root2, 'LOG.md'), readFileSync(path.join(root2, 'LOG.md'), 'utf8') + '\n<!-- relay:log-archive: docs/archive/notes.md -->\n');
    const r2 = run(root2, 'relay_verify', { full: true });
    ok(/R11\s*\|\s*ERROR/.test(row(r2, 'R11')), 'R11:归档 notes.md 含密钥 → ERROR(不只 LOG-*.md)', row(r2, 'R11'));
  }

  console.log('\n== P2 R12 指针越界/悬空不静默 PASS ==');
  {
    const root = fresh();
    const outside = path.join(base, 'outside-arch.md');
    writeFileSync(outside, '# outside\n');
    run(root, 'relay_init', { name: 'r12' });
    writeFileSync(path.join(root, 'LOG.md'), '# 会话日志(最新在上)\n\n## 2026-01-01 10:00 | model=x | task=维护\n- 摘要: x\n\n<!-- relay:log-archive: ' + outside + ' -->\n');
    const r = run(root, 'relay_verify', { full: true });
    ok(/R12\s*\|\s*WARN/.test(row(r, 'R12')), 'R12:指针目标是绝对路径/越界 → WARN(不静默 PASS)', row(r, 'R12'));
    ok(/未被承认/.test(row(r, 'R12')), 'R12:文案说明指针未被承认');
    writeFileSync(path.join(root, 'LOG.md'), '# 会话日志(最新在上)\n\n## 2026-01-01 10:00 | model=x | task=维护\n- 摘要: x\n\n<!-- relay:log-archive: docs/archive/missing.md -->\n');
    ok(/R12\s*\|\s*WARN/.test(row(run(root, 'relay_verify', { full: true }), 'R12')), 'R12:悬空指针 → WARN');
  }

  console.log('\n== P2 R10 反查不被「提交消息含 T### 完成」劫持 ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'r10' });
    const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    run(root, 'relay_claim', { task: 'T003', model: 'r10', worktree: false });
    const end = run(root, 'relay_session_end', { model: 'r10', summary: '完成 T003(只改协议文件)', done_task: 'T003' });
    ok(end.status === 0, '单根完成出场成功', out(end).slice(0, 300));
    // 追加一个「消息含 T003 完成但改动文件数不同」的无关提交(劫持尝试)
    writeFileSync(path.join(root, 'hijack-a.txt'), 'a\n');
    writeFileSync(path.join(root, 'hijack-b.txt'), 'b\n');
    git('add', '-A');
    git('-c', 'user.name=x', '-c', 'user.email=x@l', 'commit', '-q', '-m', 'docs: T003 完成(劫持提交)');
    const v = run(root, 'relay_verify', { full: true });
    ok(/R10\s*\|\s*PASS/.test(row(v, 'R10')), 'R10:仍能定位真正完成提交(不被劫持提交干扰)', row(v, 'R10'));
  }

  console.log('\n== P2 init force 同秒备份不互覆盖 ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'bk' });
    run(root, 'relay_init', { name: 'bk', force: true });
    run(root, 'relay_init', { name: 'bk', force: true });
    const baks = readdirSync(root).filter((f) => f.startsWith('LOG.md.relay-bak-'));
    ok(baks.length >= 2, '两次 force 各留一份独立备份(同秒不互覆盖)', baks.join(','));
  }

  console.log('\n== P2 重复 session_end 幂等(不再报 git commit 失败) ==');
  {
    const root = fresh();
    run(root, 'relay_init', { name: 'idem' });
    const e1 = run(root, 'relay_session_end', { model: 'idem', summary: '维护一' });
    const logAfter1 = readFileSync(path.join(root, 'LOG.md'), 'utf8');
    const e2 = run(root, 'relay_session_end', { model: 'idem', summary: '维护二' });
    ok(e1.status === 0 && e2.status === 0, '两次维护出场均成功', `${out(e1).slice(0, 120)} | ${out(e2).slice(0, 120)}`);
    ok(!/git commit 失败/.test(out(e2)), '第二次出场不再降级报 git commit 失败');
    ok(readFileSync(path.join(root, 'LOG.md'), 'utf8') !== logAfter1, '维护出场照常写入 LOG');
  }
  console.log('\n== P2 bare 仓库 init 直接拒绝 ==');
  {
    const root = fresh();
    spawnSync('git', ['init', '-q', '--bare', root], { encoding: 'utf8' });
    const r = run(root, 'relay_init', { name: 'bare', preset: 'minimal' });
    ok(r.status === 1 && /bare 仓库/.test(out(r)), 'bare 仓库 → init 拒绝并给修复指令', out(r).slice(0, 300));
    ok(!existsSync(path.join(root, 'START.md')), 'bare 仓库未写入骨架');
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
