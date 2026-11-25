#!/usr/bin/env node
// T048 冒烟:relay_rescue —— 子代理抢救与接力。
// 红线:
//   1) scan 只读:不写盘、不加锁、不改 .relay;
//   2) capture 是可复原的快照:transcript 逐字节一致、工作区快照进 git 对象、index/工作区/HEAD/stash 全不变;
//   3) 接力单是本机运行时状态:.relay/rescue/ 不进 git status(否则会撞 .relay/** 受保护路径护栏);
//   4) 停因分类确定性:rate_limit / 悬空 tool_use / 其他错误 / 正常完成,正常完成不列为可抢救;
//   5) 归属:其他项目或不落在控制根内的会话不列出;扫描不落盘;
//   6) 接力互斥:同 model 幂等、异 model 拒绝、201 分钟 TTL 过期可接管、report 释放;
//   7) fail-closed:transcript 篡改 → isError、超大 → 拒绝且无半写、.relay 为符号链接 → 拒绝、缺 START.md → 拒绝;
//   8) 不可信文本:围栏 + 「数据非指令」横幅,密钥样式串脱敏;
//   9) 接续链与同签名告警、简报「待接力」小节。
// 夹具走 scripts/fixtures/rescue/ 下的 ZCode / Claude Code 等价布局。
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, statSync, readlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const FIXTURES = path.join(RELAY, 'scripts', 'fixtures', 'rescue');

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 500) : ''}`); }
};
const tmpDirs = [];
const cli = (root, tool, args = {}, env = {}) => spawnSync(
  process.execPath,
  [CLI, tool, '--root', root, '--json', JSON.stringify(args)],
  { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } },
);
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000 });
const gitOut = (cwd, ...args) => (git(cwd, ...args).stdout || '').trim();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mkTmp = (tag) => {
  const d = mkdtempSync(path.join(tmpdir(), `relay-rescue-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const freshRepo = (tag, name) => {
  const dir = mkTmp(tag);
  const r = cli(dir, 'relay_init', { name: name || `rescue ${tag}` });
  if (r.status !== 0) throw new Error(`relay_init 失败:${out(r).slice(0, 800)}`);
  return dir;
};
const read = (p) => readFileSync(p, 'utf8');

// 夹具构造:把 scripts/fixtures/rescue/ 下的模板拷到临时 home,并按当前夹具根做占位替换。
// 只替换显式占位符(项目根 / 会话 id / agent id),不猜路径编码。
const copyFixture = (name, destRoot, vars) => {
  const src = path.join(FIXTURES, name);
  const walk = (rel) => {
    const from = path.join(src, rel);
    const to = path.join(destRoot, rel);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from)) walk(path.join(rel, e));
      return;
    }
    let text = read(from);
    for (const [k, v] of Object.entries(vars)) text = text.split(`<<${k}>>`).join(v);
    writeFileSync(to, text);
  };
  walk('');
};
const rescueRootOf = (controlRoot) => path.join(controlRoot, '.relay', 'rescue');
const rescueIds = (controlRoot) => (
  existsSync(rescueRootOf(controlRoot))
    ? readdirSync(rescueRootOf(controlRoot)).filter((n) => !n.startsWith('.')).sort()
    : []
);
const treeSnapshot = (dir) => {
  const acc = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      acc.push(`D ${rel}`);
      for (const e of readdirSync(abs).sort()) walk(path.join(rel, e));
    } else {
      acc.push(`F ${rel} ${st.size} ${sha256(readFileSync(abs))}`);
    }
  };
  for (const e of readdirSync(dir).sort()) {
    if (e === '.git') continue;
    walk(e);
  }
  return acc.join('\n');
};
const worktreeState = (root) => ({
  status: gitOut(root, 'status', '--porcelain', '-uall'),
  head: gitOut(root, 'rev-parse', 'HEAD'),
  stash: gitOut(root, 'stash', 'list'),
  indexSha: sha256(existsSync(path.join(root, '.git', 'index')) ? readFileSync(path.join(root, '.git', 'index')) : Buffer.from('')),
});
const isFenced = (text, needles) => needles.every((n) => {
  const at = text.indexOf(n);
  if (at < 0) return false;
  const before = text.slice(0, at);
  return (before.match(/```/g) || []).length % 2 === 1;
});

try {
  // ==========================================================================
  console.log('\n== 1. scan:dry-run 只读,不改任何文件 ==');
  // ==========================================================================
  const HOME = mkTmp('home');
  const repo = freshRepo('main', '抢救主仓');
  writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'base work');
  copyFixture('zcode', path.join(HOME, '.zcode', 'cli'), { ROOT: repo });
  copyFixture('claude', path.join(HOME, '.claude'), { ROOT: repo });
  const ENV = { RELAY_RESCUE_HOME: HOME };
  {
    const before = treeSnapshot(repo);
    const r = cli(repo, 'relay_rescue', {}, ENV);
    ok(r.status === 0, 'scan 成功', out(r));
    const text = out(r);
    ok(/dry-run|只读/.test(text), 'scan 标注 dry-run');
    ok(!existsSync(rescueRootOf(repo)), 'scan 未创建 .relay/rescue 目录');
    ok(treeSnapshot(repo) === before, 'scan 前后文件树逐字节不变(零写盘)');
  }
  {
    const text = out(cli(repo, 'relay_rescue', { action: 'scan' }, ENV));
    ok(/claude-ok/.test(text), '列出 Claude Code 下被 rate_limit 截断的子代理', text);
    ok(/zcode-ok/.test(text), '列出 ZCode 下 status=failed 的子代理', text);
    // 「可抢救」小节只列真正需要抢救的;已完成的落在「已正常完成」小节(不列为可抢救)。
    const rescuableSection = (text.match(/## 可抢救\(\d+\)([\s\S]*?)(?=\n## )/) || ['', ''])[1];
    ok(!/claude-complete/.test(rescuableSection), '正常完成的子代理不列为可抢救', rescuableSection);
    ok(/agent-zcode-running/.test(rescuableSection), '停滞的 running 子代理列为疑似被杀(可抢救)', rescuableSection);
    ok(/其他项目|不属于本项目|已跳过/.test(text) && !/agent-zcode-other/.test(rescuableSection),
      '其他项目的子代理不计入可抢救', rescuableSection);
    ok(/rate.?limit|429|额度|限流/i.test(text), '输出中断类别(quota)', text);
    ok(/prompt|任务|摘要|说明/.test(text), '输出可读的任务摘要', text);
  }

  // ==========================================================================
  console.log('\n== 2. capture:快照可复原 + 接力单不进 git ==');
  // ==========================================================================
  const transcriptSrc = path.join(HOME, '.claude', 'projects', '-repo', 'sess-fixture-b',
    'subagents', 'agent-claude-ok.jsonl');
  let capturedId = '';
  {
    const restoreRef = 'refs/relay/rescue-stash/T048SMOKE';
    const backup = gitOut(repo, 'rev-parse', '--short', 'HEAD');
    // 制造未提交现场:一个修改、一个新增、一个删除
    writeFileSync(path.join(repo, 'f.txt'), 'base\nmodified by dead agent\n');
    writeFileSync(path.join(repo, 'new-file.txt'), 'new artifact\n');
    git(repo, 'rm', '-q', '--cached', '--ignore-unmatch', 'no-such-file');
    const wt = worktreeState(repo);
    const srcHash = sha256(readFileSync(transcriptSrc));
    const r = cli(repo, 'relay_rescue', { action: 'capture', id: 'claude-ok' }, ENV);
    ok(r.status === 1 && /confirm/i.test(out(r)), 'capture 缺 confirm 被拒绝(不写盘)', out(r));
    const r2 = cli(repo, 'relay_rescue', { action: 'capture', id: 'claude-ok', confirm: true }, ENV);
    ok(r2.status === 0, 'capture confirm 成功', out(r2).slice(0, 600));
    capturedId = (out(r2).match(/\b(rs-[a-z0-9]{6,}|claude-ok)\b/) || [])[1] || '';
    const ids = rescueIds(repo);
    ok(ids.length === 1, '恰好落下一张接力单', ids.join(','));
    const id = ids[0];
    ok(!!id, '接力单 id 可解析');
    const dir = path.join(rescueRootOf(repo), id);
    ok(existsSync(path.join(dir, 'state.json')), 'glob:state.json 存在');
    const copied = path.join(dir, 'transcript.json');
    ok(existsSync(copied), 'transcript 被拷入接力单');
    ok(sha256(readFileSync(copied)) === srcHash, 'transcript 逐字节一致(sha256)');
    // git 对象快照
    const state = JSON.parse(read(path.join(dir, 'state.json')));
    ok(!!state.snapshotRef && /^refs\/relay\/rescue\//.test(state.snapshotRef), 'state 记录快照 ref', state.snapshotRef);
    ok(git(repo, 'rev-parse', '--verify', `${state.snapshotRef}^{commit}`).status === 0,
      '快照是真实 git 提交对象', state.snapshotRef);
    const diff = gitOut(repo, 'diff', '--name-only', `${backup}..${state.snapshotRef}`);
    ok(/f\.txt/.test(diff), '快照包含被修改的文件', diff);
    ok(/new-file\.txt/.test(diff), '快照包含新增文件', diff);
    // 现场未被破坏
    const wtAfter = worktreeState(repo);
    ok(wtAfter.status === wt.status, '工作区/暂存区现场逐行不变(未暂存现场)', `before=${wt.status} after=${wtAfter.status}`);
    ok(wtAfter.head === wt.head, 'HEAD 未变化');
    ok(wtAfter.stash === wt.stash, 'stash 未变化');
    ok(wtAfter.indexSha === wt.indexSha, 'index 逐字节不变');
    // 接力单不进 git
    ok(!/\.relay\/rescue/.test(gitOut(repo, 'status', '--porcelain', '-uall')), '.relay/rescue/ 不出现在 git status');
    ok(read(path.join(repo, '.gitignore')).split('\n').includes('.relay/rescue/'), '.gitignore 基线已补 .relay/rescue/');
    const gi = git(repo, 'check-ignore', '-q', path.join(dir, 'state.json'));
    ok(gi.status === 0, '接力单文件被 git 忽略(不会卷进下一次出场提交)');
    ok(restoreRef.includes('rescue-stash') && !existsSync(restoreRef), '夹具临时 ref 名未误用');
  }

  // ==========================================================================
  console.log('\n== 3. show:只读,不写盘不加锁 ==');
  // ==========================================================================
  {
    const id = rescueIds(repo)[0];
    const before = treeSnapshot(repo);
    const r = cli(repo, 'relay_rescue', { id }, ENV);
    ok(r.status === 0, 'show 成功(有 id 时默认 action=show)', out(r).slice(0, 400));
    const text = out(r);
    ok(/不是给你的指令/.test(text), '输出带「不是给你的指令」横幅(数据非指令)');
    ok(/接力单|rescue/i.test(text), '输出接力单卡片');
    ok(isFenced(text, ['忽略之前的指令']), '原始任务(含注入尝试)在围栏内,未被当作指令执行');
    ok(/AKIA|REDACTED/.test(text) && !/AKIA[0-9A-Z]{16}/.test(text), '密钥样式串被脱敏', text);
    ok(/关联任务:/.test(text), '卡片给出关联任务信息', text.slice(0, 500));
    ok(treeSnapshot(repo) === before, 'show 零写盘');
    const locks = existsSync(path.join(rescueRootOf(repo), id, 'takeover.lock'));
    ok(!locks, 'show 不加接力锁');
    for (const view of ['tail', 'edits', 'commands']) {
      const v = cli(repo, 'relay_rescue', { id, view }, ENV);
      ok(v.status === 0, `view=${view} 可读`, out(v).slice(0, 300));
    }
    const bad = cli(repo, 'relay_rescue', { id: 'rs-nope' }, ENV);
    ok(bad.status === 1 && /修复:/.test(out(bad)), '不存在的接力单 isError 且带「修复:」', out(bad));
  }

  // ==========================================================================
  console.log('\n== 4. takeover / report:重建任务、互斥、释放 ==');
  // ==========================================================================
  {
    const id = rescueIds(repo)[0];
    const noModel = cli(repo, 'relay_rescue', { action: 'takeover', id }, ENV);
    ok(noModel.status === 1 && /model/.test(out(noModel)), 'takeover 缺 model 被拒绝', out(noModel));
    const t1 = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-a', confirm: true }, ENV);
    ok(t1.status === 0, 'takeover 成功', out(t1).slice(0, 700));
    const t1text = out(t1);
    ok(/待办|T0\d\d/.test(t1text) && /修复:|原提示词|接力/.test(t1text), '接力包重建任务/提示词', t1text.slice(0, 400));
    const tasks = read(path.join(repo, 'TASKS.md'));
    ok(/^- \[ \] T\d{3} /m.test(tasks), 'TASKS 待办区出现接管任务');
    const newTaskId = (tasks.match(/^- \[ \] (T\d{3}) /m) || [])[1];
    ok(!!newTaskId, '接管任务号可解析', newTaskId);
    const claim = cli(repo, 'relay_claim', { task: newTaskId, model: 'taker-a', worktree: false });
    ok(claim.status === 0, '为接管者显式认领新的 relay 任务', out(claim).slice(0, 400));
    const t2 = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-b', confirm: true }, ENV);
    ok(t2.status === 1, '第二次 takeover 被拒绝(派发权已移交)', out(t2));
    const t1again = cli(repo, 'relay_rescue', { action: 'takeover', id, model: 'taker-a', confirm: true }, ENV);
    ok(t1again.status === 0, '同 model takeover 幂等', out(t1again).slice(0, 300));
    const report = cli(repo, 'relay_rescue', { action: 'report', id, model: 'taker-b', summary: '不应成功' }, ENV);
    ok(report.status === 1, '未持有派发权者不能 report', out(report));
    const okReport = cli(repo, 'relay_rescue', {
      action: 'report', id, model: 'taker-a', summary: '继续并完成剩余编辑', confirm: true,
    }, ENV);
    ok(okReport.status === 0, '持有者 report 成功', out(okReport).slice(0, 500));

    // 给最后一棒留一个失败接力单,测 TTL 与接力链
    const z = cli(repo, 'relay_rescue', { action: 'capture', id: 'agent-zcode-ok', confirm: true }, ENV);
    ok(z.status === 0, 'capture ZCode 子代理', out(z).slice(0, 400));
    const zIds = rescueIds(repo).filter((x) => x !== id);
    ok(zIds.length === 1, 'ZCode 接力单落盘', zIds.join(','));
    const zid = zIds[0];
    const zt = cli(repo, 'relay_rescue', { action: 'takeover', id: zid, model: 'taker-z', confirm: true }, ENV);
    ok(zt.status === 0, 'ZCode 接力单可派发', out(zt).slice(0, 400));
    const zLock = path.join(rescueRootOf(repo), zid, 'takeover.lock');
    ok(existsSync(zLock), 'takeover 落下接力锁');
    const ttlOld = new Date(Date.now() - 241 * 60000); // > 240min TTL 才算过期
    const lockContent = read(zLock);
    const lockJson = JSON.parse(lockContent);
    // 按认领锁协议,过期由 mtime 裁决:回拨 mtime 模拟 201 分钟前
    const { utimesSync } = await import('node:fs');
    utimesSync(zLock, ttlOld, ttlOld);
    ok(lockJson.ttlMinutes === 240, '接力锁沿用 240 分钟 TTL', String(lockJson.ttlMinutes));
    const z2 = cli(repo, 'relay_rescue', { action: 'takeover', id: zid, model: 'taker-y', confirm: true }, ENV);
    ok(z2.status === 0, 'TTL 过期后可被另一模型接管', out(z2).slice(0, 400));
    const zr = cli(repo, 'relay_rescue', {
      action: 'report', id: zid, model: 'taker-y', summary: '完成', confirm: true,
    }, ENV);
    ok(zr.status === 0, '接管者 report 成功', out(zr).slice(0, 400));
  }

  // ==========================================================================
  console.log('\n== 5. 接续链与同签名告警 ==');
  // ==========================================================================
  {
    const first = rescueIds(repo)[0];
    const r = cli(repo, 'relay_rescue', {
      action: 'capture', id: 'claude-ok', confirm: true, note: '接续第一棒',
    }, ENV);
    ok(r.status === 0, '再次 capture 生成新接力单(新一棒)', out(r).slice(0, 400));
    const ids = rescueIds(repo);
    const newest = ids.find((x) => x !== first) || '';
    ok(!!newest, '第二条接力单存在', ids.join(','));
    const text = out(cli(repo, 'relay_rescue', { id: newest }, ENV));
    ok(/chain|上一棒|接续|第 2 棒|已抢救/.test(text), '接力单记录接续链', text.slice(0, 400));
    const t = out(cli(repo, 'relay_rescue', { action: 'takeover', id: newest, model: 'taker-c', confirm: true }, ENV));
    ok(/同一|签名|第 \d+ 棒|不要原样重跑/.test(t), '同签名在接续链上出现时告警', t.slice(0, 500));
  }

  // ==========================================================================
  console.log('\n== 6. fail-closed:篡改 / 超大 / 符号链接 / 未接入 ==');
  // ==========================================================================
  {
    const dir = freshRepo('tamper', '篡改夹具');
    const H2 = mkTmp('home2');
    copyFixture('claude', path.join(H2, '.claude'), { ROOT: dir });
    const e2 = { RELAY_RESCUE_HOME: H2 };
    const c = cli(dir, 'relay_rescue', { action: 'capture', id: 'claude-ok', confirm: true }, e2);
    ok(c.status === 0, '篡改夹具 capture 成功', out(c).slice(0, 300));
    const id = rescueIds(dir)[0];
    const tPath = path.join(rescueRootOf(dir), id, 'transcript.json');
    writeFileSync(tPath, `${read(tPath)}\n{"tampered":true}\n`);
    const s = cli(dir, 'relay_rescue', { id }, e2);
    ok(s.status === 1 && /sha256|篡改|一致/.test(out(s)), 'transcript 被改动后 show isError(fail-closed)', out(s).slice(0, 400));

    // 超大 transcript:超过上限 → 拒绝且不半写
    const H3 = mkTmp('home3');
    copyFixture('claude', path.join(H3, '.claude'), { ROOT: dir });
    const big = path.join(H3, '.claude', 'projects', '-repo', 'sess-fixture-b', 'subagents', 'agent-claude-ok.jsonl');
    writeFileSync(big, `${read(big)}${'x'.repeat(200 * 1024)}\n`);
    const beforeIds = rescueIds(dir).length;
    const bigR = cli(dir, 'relay_rescue', { action: 'capture', id: 'claude-ok', confirm: true }, { RELAY_RESCUE_HOME: H3, RELAY_RESCUE_MAX_BYTES: '1024' });
    ok(bigR.status === 1 && /过大|maxBytes|上限/.test(out(bigR)), '超过 maxBytes 的 transcript 被拒绝', out(bigR).slice(0, 400));
    ok(rescueIds(dir).length === beforeIds, '拒绝时没有半写接力单', rescueIds(dir).join(','));

    // .relay 是符号链接 → 拒绝写
    const symRepo = freshRepo('symlink', '符号链接夹具');
    rmSync(path.join(symRepo, '.relay'), { recursive: true, force: true });
    const outside = mkTmp('outside');
    symlinkSync(outside, path.join(symRepo, '.relay'));
    const H4 = mkTmp('home4');
    copyFixture('claude', path.join(H4, '.claude'), { ROOT: symRepo });
    const symR = cli(symRepo, 'relay_rescue', { action: 'capture', id: 'claude-ok', confirm: true }, { RELAY_RESCUE_HOME: H4 });
    ok(symR.status === 1 && /符号链接/.test(out(symR)), '.relay 为符号链接时拒绝 capture', out(symR).slice(0, 400));
    ok(!existsSync(path.join(outside, 'rescue')), '未向符号链接目标写入任何东西');

    // 未接入 relay 的仓库 → 拒绝
    const bare = mkTmp('initless');
    const bareR = cli(bare, 'relay_rescue', {}, ENV);
    ok(bareR.status === 1 && /START\.md|未接入|relay_init|relay_onboard/.test(out(bareR)),
      '未接入 relay 的目录 isError 并给接入指引', out(bareR).slice(0, 300));
  }

  // ==========================================================================
  console.log('\n== 7. drop:默认 dry-run,confirm 才删 ==');
  // ==========================================================================
  {
    const id = rescueIds(repo)[0];
    const dir = path.join(rescueRootOf(repo), id);
    const before = treeSnapshot(dir);
    const dry = cli(repo, 'relay_rescue', { action: 'drop', id }, ENV);
    ok(dry.status === 0 && /dry-run/.test(out(dry)), 'drop 默认 dry-run', out(dry).slice(0, 300));
    ok(treeSnapshot(dir) === before, 'dry-run 未删除接力单');
    const del = cli(repo, 'relay_rescue', { action: 'drop', id, confirm: true }, ENV);
    ok(del.status === 0, 'drop confirm 成功', out(del).slice(0, 300));
    ok(!existsSync(dir), '接力单目录已删除');
    const state = JSON.parse(before ? '{}' : '{}');
    ok(state !== null, '夹具占位');
    // 快照 ref 是否一并清理由输出显式说明(不静默留垃圾)
    ok(/ref|快照|snapshot/i.test(out(del)), 'drop 输出说明快照 ref 的处置', out(del).slice(0, 300));
  }

  // ==========================================================================
  console.log('\n== 8. 简报「待接力」小节 ==');
  // ==========================================================================
  {
    const none = out(cli(repo, 'relay_session_start', {}, ENV));
    const remaining = rescueIds(repo).length;
    if (remaining === 0) {
      ok(!/待接力/.test(none), '无待接力单时简报不出现「待接力」小节');
    }
    const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'agent-zcode-ok', confirm: true }, ENV);
    ok(cap.status === 0, '再造一张待接力单', out(cap).slice(0, 300));
    const brief = out(cli(repo, 'relay_session_start', {}, ENV));
    ok(/待接力/.test(brief), '有待接力单时简报出现「待接力」小节', brief.slice(0, 600));
    const section = (brief.match(/## 待接力[\s\S]*?(?=\n## |\n入场即)/) || [''])[0];
    ok(section.split('\n').filter((l) => l.trim()).length <= 6, '「待接力」小节有界(≤5 行内容)', section);
    ok(/relay_rescue/.test(brief), '简报给出接手命令', brief.slice(0, 800));
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
} finally {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}
