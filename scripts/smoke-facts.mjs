#!/usr/bin/env node
// T013/T023 冒烟:事实底账 v2(机检段/叙述段)+ R10 对账 + fail-open 修复。
// 用 CLI 而非 MCP 客户端:验证引擎判定;传输层由 smoke.mjs 覆盖。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactLine } from '../src/engines/facts.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

const tmp = mkdtempSync(path.join(tmpdir(), 'relay-facts-'));
const logPath = path.join(tmp, 'LOG.md');
const mfPath = path.join(tmp, '.relay', 'manifest.json');
const cliAt = (root, tool, args = {}) => spawnSync('node', [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8' });
const cli = (tool, args = {}) => cliAt(tmp, tool, args);
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const readMf = () => JSON.parse(readFileSync(mfPath, 'utf8'));
const writeMf = (m) => writeFileSync(mfPath, JSON.stringify(m, null, 2) + '\n');
const gitAt = (root, ...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const r10Row = (r) => (out(r).split('\n').find((l) => /^\| R10 \|/.test(l)) || '');

try {
  console.log('== init 写入 facts 配置 ==');
  const init = cli('relay_init', { name: '事实底账演示' });
  ok(init.status === 0, 'relay_init 成功', out(init).slice(0, 300));
  const mf0 = readMf();
  ok(mf0.facts && mf0.facts.enabled === true, 'init 写入 facts.enabled=true');
  ok(typeof mf0.facts.since === 'string' && mf0.facts.since.length >= 16, 'init 写入 facts.since(YYYY-MM-DD HH:mm)');

  console.log('\n== 出场由引擎写入 v2 事实行(机检段 || 叙述段) ==');
  const claim = cli('relay_claim', { task: 'T003', model: 'smoke-facts', worktree: false });
  ok(claim.status === 0, '认领 T003', out(claim).slice(0, 200));
  const end = cli('relay_session_end', { model: 'smoke-facts', summary: '事实底账冒烟:只改协议文件', done_task: 'T003' });
  ok(end.status === 0, 'session_end 成功', out(end).slice(0, 400));
  const log = readFileSync(logPath, 'utf8');
  const fact = log.match(/^- 事实\(v2\): .*$/m);
  ok(!!fact, 'LOG 含「事实(v2)」行', log.slice(0, 300));
  ok(/mode=single/.test(fact[0]), '机检段含 mode=single(单根)');
  ok(/文件 \d+/.test(fact[0]) && /± \+\d+\/-\d+/.test(fact[0]), '机检段含文件数与 ± 行数');
  ok(/base=- \| sha=- \| branch=/.test(fact[0]), '机检段含 base/sha/branch(单根无提交时为 -)');
  ok(/\|\| 验收: 通过/.test(fact[0]), '叙述段以 || 分隔并记录验收结果');
  ok(/verify: PASS \d+/.test(fact[0]), '叙述段记录 verify 汇总');

  console.log('\n== R10 存在性:删除事实行 → WARN(不锁死出场) ==');
  writeFileSync(logPath, log.replace(/^- 事实\(v2\): .*\n/m, ''));
  const v1 = cli('relay_verify', { full: true });
  ok(v1.status === 0, 'WARN 不阻断(退出码 0)', out(v1).slice(0, 300));
  ok(/R10\s*\|\s*WARN/.test(out(v1)), '输出为 R10 WARN(缺事实行)');
  ok(/修复:/.test(out(v1)), '输出含可执行「修复:」');

  console.log('\n== 机检段篡改 → R10 ERROR ==');
  writeFileSync(logPath, log.replace(/文件 (\d+)/, (_, n) => `文件 ${Number(n) + 7}`));
  const v2 = cli('relay_verify', { full: true });
  ok(v2.status === 1, '文件数不一致 → 退出码 1', out(v2).slice(0, 300));
  ok(/R10\s*\|\s*ERROR/.test(out(v2)), '输出为 R10 ERROR');

  console.log('\n== 叙述段篡改 → 不误红 ==');
  writeFileSync(logPath, log.replace('验收: 通过', '验收: 未通过'));
  const v3 = cli('relay_verify', { full: true });
  ok(v3.status === 0, '改叙述段不影响判定(退出码 0)', out(v3).slice(0, 300));
  ok(/R10\s*\|\s*PASS/.test(out(v3)), 'R10 仍 PASS(叙述段不参与对账)');

  console.log('\n== 单根行被注入 base/sha → 机检段自相矛盾 ERROR ==');
  writeFileSync(logPath, log.replace('sha=-', 'sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
  const v4 = cli('relay_verify', { full: true });
  ok(v4.status === 1, '单根行带 sha → 退出码 1', out(v4).slice(0, 300));
  ok(/R10\s*\|\s*ERROR/.test(out(v4)), 'R10 ERROR(机检段自相矛盾)');
  ok(/自相矛盾/.test(out(v4)), '文案指明机检段自相矛盾(不靠 git 也能发现篡改)');

  console.log('\n== 解析器边界:| 与 ||(审计 P2-8/P2-9)==');
  const pPipe = parseFactLine('- 事实(v2): mode=managed | 文件 1 | ± +1/-0 | base=abc1234 | sha=def5678 | branch=relay/T1|x || 验收: 通过 | verify: PASS 1·WARN 0·ERROR 0 | 耗时: 1s');
  ok(pPipe && pPipe.branch === 'relay/T1|x', "分支名含 '|' 不被截断", pPipe && pPipe.branch);
  ok(pPipe && pPipe.verifyPass === 1 && pPipe.acceptance === '通过', "含 '|' 的分支名不影响叙述段解析");
  const pNarr = parseFactLine('- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 || 备注: x | verify: PASS 2·WARN 1·ERROR 0 | 耗时: 3s');
  ok(pNarr && pNarr.branch === 'main' && pNarr.verifyPass === 2 && pNarr.verifyWarn === 1, "叙述段含 '||' 时保留其后内容", JSON.stringify(pNarr));

  console.log('\n== single 模式 branch 只校验存在性(P1-3) ==');
  writeFileSync(logPath, log.replace(/branch=[^|]+/, 'branch=zzz/zzz'));
  const vBranch = cli('relay_verify', { full: true });
  ok(/R10\s*\|\s*WARN/.test(out(vBranch)) && /不存在/.test(out(vBranch)), 'single 分支名伪造(zzz/zzz)→ R10 WARN(不再 PASS)', out(vBranch).slice(0, 400));

  console.log('\n== single 模式 ± 是写时近似,不参与对账(P1-4 契约化) ==');
  writeFileSync(logPath, log.replace(/± \+\d+\/-\d+/, '± +999/-999'));
  const v6 = cli('relay_verify', { full: true });
  ok(v6.status === 0 && /R10\s*\|\s*PASS/.test(out(v6)), 'single ± 被改不误红(契约:± 仅 managed 可复算)', out(v6).slice(0, 300));

  console.log('\n== managed 夹具:± 行数属机检段 ==');
  const mtmp = mkdtempSync(path.join(tmpdir(), 'relay-facts-managed-'));
  try {
    const g = (...a) => gitAt(mtmp, ...a);
    g('init', '-q');
    mkdirSync(path.join(mtmp, 'src'), { recursive: true });
    writeFileSync(path.join(mtmp, 'src', 'a.mjs'), 'export const a = 1;\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'wip a');
    const sha1 = g('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(path.join(mtmp, 'src', 'b.mjs'), 'export const b = 1;\nexport const c = 2;\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'wip b');
    const sha2 = g('rev-parse', 'HEAD').stdout.trim();
    mkdirSync(path.join(mtmp, '.relay'), { recursive: true });
    writeFileSync(path.join(mtmp, '.relay', 'manifest.json'), JSON.stringify({
      version: 1, entryFiles: ['AGENTS.md'], allowedTopLevel: ['src', '.relay', 'TASKS.md', 'LOG.md'],
      facts: { enabled: true, since: '2020-01-01 00:00', strict: false },
    }, null, 2) + '\n');
    writeFileSync(path.join(mtmp, 'TASKS.md'), '# 任务队列\n\n## 待办\n\n## 已完成\n- [x] T900 夹具任务  (2026-01-01)\n');
    // 分支归属(P1-3):relay/T900 指向 sha2(含);relay/T902 指向 sha1(不含 sha2)——两种篡改可区分。
    g('branch', 'relay/T900', sha2);
    g('branch', 'relay/T902', sha1);
    const mkFact = (pm) => `- 事实(v2): mode=managed | 文件 1 | ± ${pm} | base=${sha1} | sha=${sha2} | branch=relay/T900 || 验收: 通过 | verify: PASS 0·WARN 0·ERROR 0 | 耗时: 1s`;
    const logM = (factLine) => writeFileSync(path.join(mtmp, 'LOG.md'), `# 会话日志(最新在上)\n\n## 2026-01-01 00:00 | model=fixture | task=T900 完成\n- 摘要: 夹具\n${factLine}\n`);
    const mRow = (mut) => { logM(mut(mkFact('+2/-0'))); return r10Row(cliAt(mtmp, 'relay_verify', { full: true })); };
    logM(mkFact('+2/-0'));
    const m1 = cliAt(mtmp, 'relay_verify', { full: true });
    ok(/R10\s*\|\s*PASS/.test(r10Row(m1)), 'managed 正确事实行 → R10 PASS', r10Row(m1));
    logM(mkFact('+9/-9'));
    const m2 = cliAt(mtmp, 'relay_verify', { full: true });
    ok(/R10\s*\|\s*ERROR/.test(r10Row(m2)), 'managed ± 行数被篡改 → R10 ERROR', r10Row(m2));
    const rMode = mRow((l) => l.replace('mode=managed', 'mode=single'));
    ok(/R10\s*\|\s*ERROR/.test(rMode) && /自相矛盾/.test(rMode), 'mode 被篡改(managed→single)→ R10 ERROR', rMode);
    const rBranchShape = mRow((l) => l.replace('branch=relay/T900', 'branch=main'));
    ok(/R10\s*\|\s*ERROR/.test(rBranchShape), 'branch 形状非法(非 relay/)→ R10 ERROR', rBranchShape);
    const rBranchMissing = mRow((l) => l.replace('branch=relay/T900', 'branch=relay/T901'));
    ok(/R10\s*\|\s*WARN/.test(rBranchMissing) && /无法验证/.test(rBranchMissing), '分支不存在 → R10 WARN(不可验证,不 PASS)', rBranchMissing);
    const rBranchWrong = mRow((l) => l.replace('branch=relay/T900', 'branch=relay/T902'));
    ok(/R10\s*\|\s*ERROR/.test(rBranchWrong) && /不包含/.test(rBranchWrong), '分支存在但不含 sha → R10 ERROR(分支与提交不匹配)', rBranchWrong);
    const rSha = mRow((l) => l.replace(`sha=${sha2}`, 'sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    ok(/R10\s*\|\s*WARN/.test(rSha) && /无法定位对应提交/.test(rSha), '伪造 sha → R10 WARN(不再 PASS)', rSha);
    const rBase = mRow((l) => l.replace(`base=${sha1}`, 'base=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    ok(/R10\s*\|\s*WARN/.test(rBase), '伪造 base → R10 WARN(不再 PASS)', rBase);
    // P0-2(审计):v1 旧行即便数字「恰好对上」也只报 WARN——行自带的 range 不能自证。
    const v1Line = `- 事实(v1): 改动 1 文件(+2/-0) | 验收: 通过 | verify: PASS 9·WARN 0·ERROR 0 | 分支: fake/branch @${sha2} base=${sha1} | 耗时: 1s`;
    logM(v1Line);
    const rV1 = r10Row(cliAt(mtmp, 'relay_verify', { full: true }));
    ok(/R10\s*\|\s*WARN/.test(rV1) && /v1/.test(rV1), 'v1 旧行数字一致也只报 WARN(不自证 PASS)', rV1);
    ok(!/R10\s*\|\s*PASS/.test(rV1), 'v1 旧行绝不 PASS');
  } finally {
    rmSync(mtmp, { recursive: true, force: true });
  }

  console.log('\n== 升级兼容:since 在未来 → SKIP ==');
  const mf2 = readMf();
  mf2.facts.strict = false;
  mf2.facts.since = '2099-01-01 00:00';
  writeMf(mf2);
  const v5 = cli('relay_verify', { full: true });
  ok(v5.status === 0, 'since 在未来时 verify 通过', out(v5).slice(0, 300));
  ok(/R10\s*\|\s*SKIP/.test(out(v5)), '输出为 R10 SKIP(旧条目豁免)');

  console.log('\n== 修宪一致:CONTRACT 记载 v2 拆段 ==');
  const contract = readFileSync(path.join(RELAY, 'docs-design', 'CONTRACT.md'), 'utf8');
  ok(/事实\(v2\)/.test(contract), 'CONTRACT 提及 事实(v2)');
  ok(/机检段/.test(contract) && /叙述段/.test(contract), 'CONTRACT 写明机检段/叙述段');
  const machineFields = ['mode=', '文件 N', '±', 'base=', 'sha=', 'branch='];
  ok(machineFields.every((f) => contract.includes(f)), 'CONTRACT 机检段字段清单与 v2 一致(mode/文件/±/base/sha/branch)', machineFields.filter((f) => !contract.includes(f)).join(','));
  const narrativeFields = ['验收:', 'verify:', '耗时:'];
  ok(narrativeFields.every((f) => contract.includes(f)), 'CONTRACT 叙述段字段清单与 v2 一致(验收/verify/耗时)', narrativeFields.filter((f) => !contract.includes(f)).join(','));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
