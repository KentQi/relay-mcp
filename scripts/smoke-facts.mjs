#!/usr/bin/env node
// T013/T023 冒烟:事实底账 v2(机检段/叙述段)+ R10 对账 + fail-open 修复。
// 用 CLI 而非 MCP 客户端:验证引擎判定;传输层由 smoke.mjs 覆盖。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactLine, changedPathsFromStatus } from '../src/engines/facts.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n== 0. porcelain 路径口径(rename 展开 / 协议面过滤 / 大小写) ==');
ok(changedPathsFromStatus(['R  old.js\0new.js']).length === 2, 'rename 展开为两条(与 numstat --no-renames 一致)');
ok(changedPathsFromStatus(['M  src/a.js']).length === 1, '普通修改计一条');
ok(changedPathsFromStatus(['A  docs/archive/LOG-x.md']).length === 0, 'LOG-* 归档不计入文件数');
ok(changedPathsFromStatus(['A  docs/archive/log-x.md']).length === 0, 'LOG-* 归档判定大小写不敏感');
ok(changedPathsFromStatus(['A  docs/archive/notes.md']).length === 1, '非 LOG 归档仍按普通文件计入');
  const weirdName = 'quote" tab\t newline\n arrow ->.mjs';
  const weird = `src/${weirdName}`;
ok(changedPathsFromStatus([`A  ${weird}`])[0] === weird, 'porcelain -z 刁钻文件名保持原字节路径(不解析引号/换行/箭头)');
ok(changedPathsFromStatus(['R  old -> name.mjs\0new -> name.mjs']).length === 2, 'rename 两侧含字面箭头仍按 NUL 正确展开');

const tricky = mkdtempSync(path.join(tmpdir(), 'relay-facts-path-'));
try {
  const g = (...a) => spawnSync('git', ['-C', tricky, ...a], { encoding: 'utf8' });
  g('init', '-q');
  // 先建一个基线提交,让后续 diff 有 HEAD^ 可对;否则首次提交时 HEAD^ 不存在。
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  mkdirSync(path.join(tricky, 'src'), { recursive: true });
  writeFileSync(path.join(tricky, weird), 'export const tricky = 1;\n');
  // 精确 add 该路径:含换行/制表符的文件名不能被 -A 之外的 glob/引号形式安全展开。
  g('add', '--', weird);
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tricky paths');
  const { diffStat } = await import('../src/engines/facts.mjs');
  const st = await diffStat(tricky, ['HEAD^', 'HEAD']);
  ok(st && st.files === 1 && st.insertions === 1, 'diffStat 对换行/制表符/引号路径仍准确计数', JSON.stringify(st));
} finally { rmSync(tricky, { recursive: true, force: true }); }

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
  ok(Object.prototype.hasOwnProperty.call(mf0.facts, 'baselineSha'), 'init 写入 facts.baselineSha 拓扑锚点(空仓库为 null)');

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
  ok(/旧版本引擎|前移到该条目之后/.test(out(v1)), 'R10 WARN 给出缺事实行对应的专属修复路径');

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

  console.log('\n== 单根:完成提交之后又有普通提交,R10 仍能定位完成提交 ==');
  writeFileSync(logPath, log); // 恢复干净事实行(前面用例会篡改 LOG)
  appendFileSync(path.join(tmp, 'README.md'), '\n<!-- post-completion maintenance -->\n');
  gitAt(tmp, 'add', '-A');
  gitAt(tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'docs: 完成后的普通提交');
  const vPost = cli('relay_verify', { full: true });
  ok(/R10\s*\|\s*PASS/.test(out(vPost)), '完成提交之后有普通提交,R10 仍 PASS(按「T### 完成」反查,不依赖 HEAD)', out(vPost).slice(0, 400));
  const oldHeading = '## 2000-01-01 00:00 | model=legacy | task=T777 完成';
  writeFileSync(logPath, log.replace(/(?=^## )/m, `${oldHeading}\n\n`).replace(/文件 (\d+)/, (_, n) => `文件 ${Number(n) + 1}`));
  const backdatedRow = r10Row(cli('relay_verify', { full: true }));
  ok(/R10\s*\|\s*WARN/.test(backdatedRow) && !/R10\s*\|\s*SKIP/.test(backdatedRow),
    '回填旧日期不能触发 R10 升级豁免(按物理最新条目对账)');
  writeFileSync(logPath, log);

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
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'T900 完成');
    const sha2 = g('rev-parse', 'HEAD').stdout.trim();
    const controlBranch = g('branch', '--show-current').stdout.trim();
    mkdirSync(path.join(mtmp, '.relay'), { recursive: true });
    writeFileSync(path.join(mtmp, '.relay', 'manifest.json'), JSON.stringify({
      version: 1, entryFiles: ['AGENTS.md'], allowedTopLevel: ['src', '.relay', 'TASKS.md', 'LOG.md'],
      facts: { enabled: true, since: '2020-01-01 00:00', strict: false },
    }, null, 2) + '\n');
    writeFileSync(path.join(mtmp, '.relay', 'worktrees.json'), JSON.stringify({
      version: 1, worktrees: [{
        task: 'T900', path: '.relay/worktrees/T900', baseSha: sha1, branch: 'relay/T900',
        status: 'completed', controlCommitted: true, commitSha: sha2,
      }],
    }, null, 2) + '\n');
    writeFileSync(path.join(mtmp, 'TASKS.md'), '# 任务队列\n\n## 待办\n\n## 已完成\n- [x] T900 夹具任务  (2026-01-01)\n');
    // 分支归属(P1-3):relay/T900 指向 sha2(含);relay/T902 指向 sha1(不含 sha2)——两种篡改可区分。
    g('branch', 'relay/T900', sha2);
    g('branch', 'relay/T902', sha1);
    const mkFact = (pm) => `- 事实(v2): mode=managed | 文件 1 | ± ${pm} | base=${sha1} | sha=${sha2} | branch=relay/T900 || 验收: 通过 | verify: PASS 0·WARN 0·ERROR 0 | 耗时: 1s`;
    const pair = `- worktree: branch=relay/T900; sha=${sha2}; 已验收,未合并\n`;
    const logM = (factLine, evidence = pair) => writeFileSync(path.join(mtmp, 'LOG.md'), `# 会话日志(最新在上)\n\n## 2026-01-01 00:00 | model=fixture | task=T900 完成\n- 摘要: 夹具\n${factLine}\n${evidence}`);
    const verifyManaged = () => r10Row(cliAt(mtmp, 'relay_verify', { full: true }));
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
    // 分支不存在 + 提交不是该任务的完成提交(sha1 的 message 是 wip a)→ WARN
    logM(`- 事实(v2): mode=managed | 文件 1 | ± +2/-0 | base=${sha1} | sha=${sha1} | branch=relay/T901 || 验收: 通过 | verify: PASS 0·WARN 0·ERROR 0 | 耗时: 1s`);
    const rBranchMissing = r10Row(cliAt(mtmp, 'relay_verify', { full: true }));
    ok(!/R10\s*\|\s*PASS/.test(rBranchMissing), '伪造完成 sha → R10 不 PASS(独立定位不接受自报提交)', r10Row(cliAt(mtmp,'relay_verify',{full:true})));
    // 分支不存在 + 完成提交仍在当前分支历史(合并后删分支的正常生命周期)→ PASS(带注记)
    logM(mkFact('+2/-0').replace('branch=relay/T900', 'branch=relay/T901'));
    const rMergedDeleted = r10Row(cliAt(mtmp, 'relay_verify', { full: true }));
    ok(!/R10\s*\|\s*PASS/.test(rMergedDeleted), '分支已删除时不做无依据的 PASS(无法独立验证保持可见)', rMergedDeleted);
    const rBranchWrong = mRow((l) => l.replace('branch=relay/T900', 'branch=relay/T902'));
    ok(/R10\s*\|\s*ERROR/.test(rBranchWrong) && /branch/.test(rBranchWrong), '事实行分支与任务或成对证据不匹配 → R10 ERROR', rBranchWrong);
    logM(mkFact('+2/-0'));
    g('branch', '-f', 'relay/T900', sha1);
    ok(/R10\s*\|\s*ERROR.*不包含/.test(verifyManaged()), '真实任务分支不包含成对证据提交 → R10 ERROR');
    g('branch', '-f', 'relay/T900', sha2);
    const rSha = mRow((l) => l.replace(`sha=${sha2}`, 'sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    ok(/R10\s*\|\s*ERROR/.test(rSha) && /sha 声明/.test(rSha), '伪造 sha → R10 ERROR(独立定位提交不被事实行左右)', rSha);
    const rBase = mRow((l) => l.replace(`base=${sha1}`, 'base=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    ok(/R10\s*\|\s*ERROR/.test(rBase) && /registry/.test(rBase), '伪造 base → R10 ERROR(范围由 registry 独立锚定)', rBase);
    const rEmpty = mRow((l) => l.replace(`base=${sha1}`, `base=${sha2}`).replace(`sha=${sha2}`, `sha=${sha2}`).replace(/文件 1/, '文件 0').replace(/\+2\/-0/, '+0/-0'));
    ok(/R10\s*\|\s*ERROR/.test(rEmpty) && /文件数/.test(rEmpty), 'base=sha 伪造空区间 → R10 ERROR(不再空洞 PASS)', rEmpty);
    const savedReg = readFileSync(path.join(mtmp, '.relay', 'worktrees.json'), 'utf8');
    logM(mkFact('+2/-0'));
    writeFileSync(path.join(mtmp, '.relay', 'worktrees.json'), savedReg.replace('relay/T900', 'relay/T902'));
    ok(/R10\s*\|\s*ERROR.*(?:registry|注册表)/.test(verifyManaged()), '注册表分支与成对证据不同必须报错', verifyManaged());
    rmSync(path.join(mtmp, '.relay', 'worktrees.json'));
    ok(/R10\s*\|\s*WARN/.test(r10Row(cliAt(mtmp, 'relay_verify', { full: true }))) && /registry=missing/.test(r10Row(cliAt(mtmp, 'relay_verify', { full: true }))), 'registry 缺失 → R10 WARN(不 PASS)');
    writeFileSync(path.join(mtmp, '.relay', 'worktrees.json'), savedReg);
    // P0-2(审计):v1 旧行即便数字「恰好对上」也只报 WARN——行自带的 range 不能自证。
    const v1Line = `- 事实(v1): 改动 1 文件(+2/-0) | 验收: 通过 | verify: PASS 9·WARN 0·ERROR 0 | 分支: fake/branch @${sha2} base=${sha1} | 耗时: 1s`;
    logM(v1Line);
    const rV1 = r10Row(cliAt(mtmp, 'relay_verify', { full: true }));
    ok(/R10\s*\|\s*WARN/.test(rV1) && /v1/.test(rV1), 'v1 旧行数字一致也只报 WARN(不自证 PASS)', rV1);
    ok(!/R10\s*\|\s*PASS/.test(rV1), 'v1 旧行绝不 PASS');

    console.log('\n== R10 锚点:同一条目的配对证据不随任务分支移动 ==');
    logM(mkFact('+2/-0'), `\n## 2025-12-31 00:00 | model=fixture | task=T901 完成\n${pair}`);
    ok(/R10\s*\|\s*WARN/.test(verifyManaged()), '同 SHA 的其他条目不能提供锚点', verifyManaged());
    logM(mkFact('+2/-0'), pair.repeat(2));
    ok(/R10\s*\|\s*WARN/.test(verifyManaged()), '同条目有多个锚点 → R10 WARN', verifyManaged());
    logM(mkFact('+2/-0'));
    ok(g('checkout', '-q', 'relay/T900').status === 0, '切到任务分支');
    writeFileSync(path.join(mtmp, 'src', 'after-exit.mjs'), 'export const after = 1;\n');
    g('add', '--', 'src/after-exit.mjs');
    const added = g('-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'wip: after exit');
    ok(added.status === 0, '任务分支新增真实提交', added.stderr);
    const newTip = g('rev-parse', 'HEAD').stdout.trim();
    ok(newTip !== sha2 && /R10\s*\|\s*PASS/.test(verifyManaged()), '追加提交后原事实行仍须 PASS', verifyManaged());
    const mismatched = mRow((line) => line.replace(`sha=${sha2}`, `sha=${newTip}`).replace('文件 1', '文件 2').replace('+2/-0', '+3/-0'));
    ok(/R10\s*\|\s*ERROR.*sha 声明/.test(mismatched), '事实行与独立成对证据不一致时必须报错', mismatched);
    logM(mkFact('+2/-0'));
    ok(g('checkout', '-q', controlBranch).status === 0 && g('merge', '--ff-only', 'relay/T900').status === 0
      && g('branch', '-d', 'relay/T900').status === 0, '合并任务分支后删除本地任务引用');
    ok(/R10\s*\|\s*PASS.*已合并删除/.test(verifyManaged()), '合并并删除分支后仍可按原锚点对账', verifyManaged());
  } finally {
    rmSync(mtmp, { recursive: true, force: true });
  }

  console.log('\n== 注释中的完成条目不能成为 R9 / R10 证据 ==');
  {
    const commentRoot = mkdtempSync(path.join(tmpdir(), 'relay-facts-comment-'));
    try {
      const initC = cliAt(commentRoot, 'relay_init', { name: '注释证据' });
      ok(initC.status === 0, 'comment fixture init', out(initC).slice(0, 200));
      const tasksPath = path.join(commentRoot, 'TASKS.md');
      writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8')
        .replace(/^- \[ \] T003 .+$/m, '- [x] T003 仅注释中的假完成  (2026-11-27)'));
      writeFileSync(path.join(commentRoot, 'LOG.md'), [
        '# 会话日志(最新在上)',
        '',
        '<!--',
        '## 2026-11-27 12:00 | model=fixture | task=T003 完成',
        '- 摘要: 模板注释里的示例,不是真实证据',
        '-->',
        '',
      ].join('\n'));
      const verified = cliAt(commentRoot, 'relay_verify', { full: true });
      ok(verified.status === 1 && /R9\s*\|\s*ERROR/.test(out(verified)), 'HTML 注释里的完成标题不满足 R9', out(verified).slice(0, 800));
      ok(!/R10\s*\|\s*PASS.*comment/i.test(out(verified)), '注释标题也不参与 R10 事实锚定');
    } finally {
      rmSync(commentRoot, { recursive: true, force: true });
    }
  }

  console.log('\n== 回填旧日期的新完成条目不能整条 SKIP R10 ==');
  {
    const backdatedRoot = mkdtempSync(path.join(tmpdir(), 'relay-facts-backdated-'));
    try {
      const initB = cliAt(backdatedRoot, 'relay_init', { name: '回填旧日期' });
      ok(initB.status === 0, 'backdated fixture init', out(initB).slice(0, 200));
      const tasksPath = path.join(backdatedRoot, 'TASKS.md');
      writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8')
        .replace(/^- \[ \] T003 .+$/m, '- [x] T003 回填旧日期且无事实行  (2026-11-27)'));
      writeFileSync(path.join(backdatedRoot, 'LOG.md'), [
        '# 会话日志(最新在上)',
        '',
        '## 2000-01-01 00:00 | model=fixture | task=T003 完成',
        '- 摘要: 时间被回填,但该行尚未提交到 HEAD',
        '',
      ].join('\n'));
      const verified = cliAt(backdatedRoot, 'relay_verify', { full: true });
      ok(/R10\s*\|\s*WARN/.test(out(verified)), '未提交的回填旧日期条目进入 R10 对账(WARN,不 SKIP)', out(verified).slice(0, 800));
      ok(!/R10\s*\|\s*SKIP/.test(out(verified)), '标题文本时间不能单独触发升级豁免');
    } finally {
      rmSync(backdatedRoot, { recursive: true, force: true });
    }
  }

  console.log('\n== 伪造提交时间不能让 baseline 之后的完成条目 SKIP ==');
  {
    const forgedRoot = mkdtempSync(path.join(tmpdir(), 'relay-facts-forged-time-'));
    try {
      const initF = cliAt(forgedRoot, 'relay_init', { name: '伪造提交时间' });
      ok(initF.status === 0, 'forged-time fixture init', out(initF).slice(0, 200));
      const baseline = gitAt(forgedRoot, 'rev-parse', 'HEAD').stdout.trim();
      const manifestPath = path.join(forgedRoot, '.relay', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.facts.since = '2099-01-01 00:00';
      manifest.facts.baselineSha = baseline;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const tasksPath = path.join(forgedRoot, 'TASKS.md');
      writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8')
        .replace(/^- \[ \] T003 .+$/m, '- [x] T003 提交时间伪造  (2026-11-27)'));
      writeFileSync(path.join(forgedRoot, 'LOG.md'), [
        '# 会话日志(最新在上)',
        '',
        '## 2000-01-01 00:00 | model=fixture | task=T003 完成',
        '- 摘要: 标题与 committer time 都被回填',
        '',
      ].join('\n'));
      gitAt(forgedRoot, 'add', '-A');
      const forgedCommit = spawnSync('git', [
        '-C', forgedRoot,
        '-c', 'user.name=t', '-c', 'user.email=t@t',
        'commit', '-q', '-m', 'backdated completion',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
      });
      ok(forgedCommit.status === 0, 'forged-time completion commit 已提交', forgedCommit.stderr);
      const verifiedF = cliAt(forgedRoot, 'relay_verify', { full: true });
      const row = r10Row(verifiedF);
      ok(/R10\s*\|\s*WARN/.test(row) && !/R10\s*\|\s*SKIP/.test(row),
        'baseline 之后的新条目即使伪造 2000 年 committer time 也不 SKIP', row);
    } finally {
      rmSync(forgedRoot, { recursive: true, force: true });
    }
  }

  console.log('\n== 升级兼容:since 在未来 → SKIP ==');
  const mf2 = readMf();
  mf2.facts.since = '2099-01-01 00:00';
  mf2.facts.baselineSha = gitAt(tmp, 'rev-parse', 'HEAD').stdout.trim();
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
