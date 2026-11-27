#!/usr/bin/env node
// T067 冒烟:自更新启动器(scripts/relay-mcp-autoupdate.mjs)——隔离夹具版。
//
// 红线(真实 git / 真实 launcher 行为断言,不是源码 grep):
//   1) 干净且落后 origin → 包装器把 HEAD ff 到上游顶端(只快进真的会发生);
//   2) 本地有独有提交 / 非 main / linked worktree → HEAD 不动;
//   3) worktree 探测失败或路径解析失败 → fail-closed,不能越过守卫 merge;
//   4) merge 在 ref 更新前失败留下混合树 → 拒绝从混合树启动 MCP;
//   5) 两个 launcher 并发进入 fetch → 更新锁串行化;等锁者启动当前版本而非 exit 2;
//   6) 总预算立即生效;超时整组杀 git,孙进程不能继续运行;
//   7) GIT_* 污染不能覆盖 -C 指向的夹具仓库;
//   8) merge 假成功但 HEAD 未到 origin/main → 不能 finish(ok);
//   9) wrapper 收到 SIGTERM → in-flight git 及其孙进程一起终止;
//  10) 陈旧更新锁可恢复;夹具 commit 禁用全局 gpg signing。
//
// 隔离:每个场景一个临时目录(bare origin + clone 的工作仓 + 最小 MCP 应答器),
// 不触碰真实仓库与 ~/.relay-mcp/;冒烟里的 HEAD 断言全部在夹具内完成。
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
  chmodSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_SRC = path.join(RELAY, 'scripts', 'relay-mcp-autoupdate.mjs');
// --exec-path 只返回 helper 目录,不是 git 可执行文件目录;单独解析 PATH。
const GIT_EXEC = (() => {
  const r = spawnSync('/bin/sh', ['-lc', 'command -v git'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : '/usr/bin/git';
})();

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (tag) => { const d = mkdtempSync(path.join(tmpdir(), `relay-au-${tag}-`)); tmpDirs.push(d); return d; };
// Wrapper fallback state/log files use os.homedir(); pin every fixture to a
// throwaway home so linked-worktree coverage never reads or writes the real one.
const TEST_HOME = mkTmp('home');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (predicate, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
};
const git = (cwd, ...args) => {
  const r = spawnSync(GIT_EXEC, ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const commit = (cwd, message) => {
  git(cwd, 'add', '-A');
  // 开发者可能全局开启 commit.gpgsign;夹具必须不依赖其 GPG 配置/agent。
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
};
const status = (repo) => git(repo, 'status', '--porcelain', '--untracked-files=no');
const readLauncherState = (repo) =>
  JSON.parse(readFileSync(path.join(repo, '.git', 'relay-autoupdate.json'), 'utf8'));

// 最小 MCP 应答器:收到 initialize 就回一条,stdin EOF 退出
const RESPONDER = `process.stdin.setEncoding('utf8');let buf='';
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;try{const m=JSON.parse(line);if(m.id!=null){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'relay-mcp-fixture',version:'0.0.0'}}})+'\\n');}}catch{}}});
process.stdin.on('end',()=>process.exit(0));`;

// 建夹具:origin(普通仓)+ clone 的工作仓,复制启动器到 work/scripts/
// (同时验证「脚本在仓库内」这一交付形态:夹具跑的就是仓库里那份启动器)。
const makeFixture = (tag) => {
  const root = mkTmp(tag);
  const origin = path.join(root, 'origin');
  const work = path.join(root, 'work');
  mkdirSync(origin, { recursive: true });
  mkdirSync(path.join(origin, 'src'), { recursive: true });
  mkdirSync(path.join(origin, 'scripts'), { recursive: true });
  git(origin, 'init', '--initial-branch=main');
  writeFileSync(path.join(origin, 'src', 'index.mjs'), RESPONDER);
  // 启动器先提交进 origin 再 clone:若留在 work 侧,work 会与 origin 分叉,
  // wrapper 正确地拒绝合并,ff 场景就永远测不到(实测踩过)。
  writeFileSync(path.join(origin, 'scripts', 'relay-mcp-autoupdate.mjs'), readFileSync(WRAPPER_SRC, 'utf8'));
  writeFileSync(path.join(origin, 'README.md'), 'origin\n');
  commit(origin, 'init');
  git(root, 'clone', '--quiet', origin, work);
  return { root, origin, work };
};
const head = (repo) => git(repo, 'rev-parse', 'HEAD');
const bumpOrigin = (f, version = 'upstream') => {
  writeFileSync(path.join(f.origin, 'README.md'), `origin ${version}\n`);
  if (version) {
    writeFileSync(path.join(f.origin, 'src', 'index.mjs'), RESPONDER.replace('0.0.0', version));
  }
  commit(f.origin, `upstream ${version}`);
  return head(f.origin);
};
const logOf = (f, work = f.work) => {
  try { return readFileSync(path.join(work, '.git', 'relay-autoupdate.log'), 'utf8'); }
  catch { return ''; }
};
const failedCheck = (f, work = f.work) => {
  // linked worktree 的 .git 是文件,日志/状态走路径指纹 fallback;直接断言判定的文案。
  return /无法判定 worktree 类型|无法判定当前分支|git 目录路径解析失败|时间预算耗尽|合并后 HEAD 复核失败|状态未知|预算耗尽/.test(logOf(f, work));
};

const writeShim = (root, name, body) => {
  // 必须是 .cjs:shim 用 CommonJS 的 require 写,给 .mjs 会直接语法错误,
  // 于是「守卫失败」变成「shim 自己挂了」,测出来的失败毫无意义。
  const file = path.join(root, name.replace(/\.mjs$/, '.cjs'));
  // 用 Node 而不是 shell 模拟 git:环境净化会删掉 AU_* 外的自定义 GIT_BIN 以外变量,
  // 但 Node 可精确制造子进程/孙进程屏障,不依赖宿主 shell 的后台作业行为。
  writeFileSync(file, `#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
${body}
const r = spawnSync(${JSON.stringify(GIT_EXEC)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  chmodSync(file, 0o700);
  return file;
};

// probe:spawn 包装器(detached → 可整组杀),写 initialize 后收应答。
// 超时杀整个进程组并**立即结算失败**——孙进程持有管道时 close 永不来,不能等它。
const probe = (repo, {
  args = [], budget = null, timeoutMs = 30000, scriptPath = null, env: extraEnv = {}, onSpawn = null,
} = {}) => new Promise((resolve) => {
  const script = scriptPath || path.join(repo, 'scripts', 'relay-mcp-autoupdate.mjs');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME };
  delete env.NODE_TEST_CONTEXT;                       // T063 同款:防外层 node --test 污染子进程退出码
  if (budget != null) env.RELAY_AUTOUPDATE_BUDGET_MS = String(budget);
  Object.assign(env, extraEnv);
  // 显式 shim 优先;否则让 wrapper 用同一份真实 git,避免 PATH 中的 git shim 与
  // 测试夹具的 git 二进制行为分叉。
  if (!env.GIT_BIN) env.GIT_BIN = GIT_EXEC;
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch { /* ignore */ } }
  };
  if (onSpawn) onSpawn(child);
  let out = '', err = '', settled = false;
  const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
  const timer = setTimeout(() => {
    killGroup('SIGKILL');
    // 只杀 wrapper 会留下它的 detached git 子进程;这里是测试侧的整组兜底。
    setTimeout(() => killGroup('SIGKILL'), 2000);
    done({ code: null, out, err, timedOut: true });
  }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => done({ code: -1, out, err: String(e.message || e), timedOut: false }));
  child.on('close', (code) => done({ code, out, err, timedOut: false }));
  child.stdin.on('error', () => { /* 配置错误时 wrapper 可能先关 stdin */ });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  }) + '\n');
  child.stdin.end();
});

try {
  console.log('== 1. 静态不变量:真实行为之外的调用点保护 ==');
  {
    const src = readFileSync(WRAPPER_SRC, 'utf8');
    ok(/\[\s*'merge'\s*,\s*'--ff-only'/.test(src),
      '合并调用点精确匹配 git([merge, --ff-only])');
    ok(/rev-list['",\s]+'--count'/.test(src.replace(/\n/g, ' ')) && !/behind\.ok \? Number\([^)]*\) : 0/.test(src),
      'rev-list 失败不再折算成 0(fail-closed)');
  }

  console.log('\n== 2. 干净且落后 → 只快进到上游顶端 ==');
  {
    const f = makeFixture('ff');
    const before = head(f.work);
    const upstreamTip = bumpOrigin(f, 'ff-new');
    const r = await probe(f.work);
    ok(r.code === 0, '包装器正常退出', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(/relay-mcp-fixture/.test(r.out) && /ff-new/.test(r.out), '经包装器启动更新后的 MCP 应答 initialize', r.out.slice(0, 150));
    ok(head(f.work) === upstreamTip, 'HEAD 被只快进到上游顶端(merge 真的发生且只快进)',
      `before=${before.slice(0, 7)} tip=${upstreamTip.slice(0, 7)} now=${head(f.work).slice(0, 7)}`);
    ok(status(f.work) === '', '成功合并后工作树干净');
    ok(!existsSync(path.join(f.work, '.git', 'relay-autoupdate.lock')), '成功合并后更新锁已释放');
    ok(!/^\[relay-autoupdate\]/m.test(r.out), 'git/更新日志没有污染 MCP stdout');
  }

  console.log('\n== 3. 本地有独有提交 → 不合并 ==');
  {
    const f = makeFixture('diverged');
    bumpOrigin(f);
    writeFileSync(path.join(f.work, 'local.txt'), 'local only\n');
    commit(f.work, 'local 1');
    const before = head(f.work);
    const r = await probe(f.work);
    ok(r.code === 0, '包装器正常退出', `code=${r.code}`);
    ok(head(f.work) === before, '本地独有提交时 HEAD 不动(不吞本地提交)',
      `before=${before.slice(0, 7)} now=${head(f.work).slice(0, 7)}`);
    ok(!/已更新|已是最新/.test(logOf(f)), '分叉状态没有写成成功');
  }

  console.log('\n== 4. linked worktree / 守卫失败 → 都不能越过守卫 merge ==');
  {
    const f = makeFixture('linked');
    const upstreamTip = bumpOrigin(f, 'linked-new');
    const linked = path.join(f.root, 'linked');
    git(f.work, 'worktree', 'add', '-qb', 'relay/T-fixture', linked, 'origin/main');
    const before = head(linked);
    const r = await probe(linked, { scriptPath: WRAPPER_SRC, args: [linked] });
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out), 'linked worktree 仍启动当前 MCP', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(linked) === before, 'linked worktree 的 HEAD 不被自动快进');
    ok(head(f.work) !== upstreamTip, '主检出 main 也没有被 linked worktree 更新');
    ok(existsSync(path.join(TEST_HOME, '.relay-mcp', 'state')),
      'linked worktree 的 fallback state/log 留在夹具 HOME');

    for (const [tag, mode] of [['oldgit', 'path-format'], ['badpath', 'missing-path']]) {
      const g = makeFixture(tag);
      const tip = bumpOrigin(g, `${tag}-new`);
      const before = head(g.work);
      const shim = writeShim(g.root, `git-guard-${mode}.mjs`, mode === 'path-format'
        ? `if (args.includes('--path-format=absolute')) { console.error('error: unknown option path-format=absolute'); process.exit(129); }`
        : `if (args.includes('--absolute-git-dir')) { console.log('/definitely/missing/git-dir'); process.exit(0); }`);
      const r = await probe(g.work, { scriptPath: WRAPPER_SRC, args: [g.work], env: { GIT_BIN: shim } });
      ok(r.code === 0 && /relay-mcp-fixture/.test(r.out), `${mode}: 守卫失败仍启动当前版本`, `code=${r.code} err=${r.err.slice(0, 150)}`);
      ok(head(g.work) === before, `${mode}: HEAD 不动(守卫不再 fail-open)`);
      ok(failedCheck(g) && !/已更新|已是最新/.test(logOf(g)), `${mode}: 无法判定记为 fail,不记 ok`);
      ok(tip !== head(g.work), `${mode}: 上游更新未被合并`);
    }
  }

  console.log('\n== 5. ref 更新失败留下混合树 → 拒绝启动 MCP ==');
  {
    const f = makeFixture('mixed');
    const before = head(f.work);
    bumpOrigin(f, 'mixed-new');
    mkdirSync(path.join(f.work, '.git', 'refs', 'heads'), { recursive: true });
    // 真实 git ff 会先写 index/工作树,再尝试更新 refs/heads/main。
    writeFileSync(path.join(f.work, '.git', 'refs', 'heads', 'main.lock'), 'blocked\n');
    const r = await probe(f.work, { scriptPath: WRAPPER_SRC, args: [f.work] });
    ok(r.code === 2, '混合树被判定为未知状态,包装器 exit 2', `code=${r.code} err=${r.err.slice(0, 250)}`);
    ok(!/relay-mcp-fixture/.test(r.out), '拒绝从混合树启动 MCP(没有 initialize 应答)');
    ok(head(f.work) === before, 'ref 更新失败后 HEAD 仍是 before');
    ok(status(f.work) !== '', '夹具确实制造了工作树/index 与 HEAD 不一致');
    ok(/状态未知|混合树/.test(r.err), '报错明确说明不能从可疑树启动', r.err.slice(0, 250));
    ok(!/已更新|已是最新/.test(logOf(f)), '混合树失败没有写成功状态');
  }

  console.log('\n== 6. 并发两个 launcher → 有界等锁后启动当前版本 ==');
  {
    const f = makeFixture('concurrent');
    const before = head(f.work);
    const upstreamTip = bumpOrigin(f, 'concurrent-new');
    const gateDir = path.join(f.root, 'gate');
    mkdirSync(gateDir);
    const gateGit = writeShim(f.root, 'git-gate.mjs', `
if (args.includes('fetch')) {
  require('node:fs').writeFileSync(require('node:path').join(process.env.AU_GATE_DIR, 'pid-' + process.ppid), 'waiting');
  const until = Date.now() + 16000;
  while (!require('node:fs').existsSync(require('node:path').join(process.env.AU_GATE_DIR, 'release')) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}`);
    const opts = {
      scriptPath: WRAPPER_SRC, args: [f.work], timeoutMs: 15000,
      env: { GIT_BIN: gateGit, AU_GATE_DIR: gateDir },
    };
    let firstDone = null, secondDone = null;
    // 两个进程都先到 fetch barrier;更新锁的等待从 barrier 释放后才开始计时。
    const gateRuns = () => requireListing(gateDir).filter((name) => name.startsWith('pid-')).length;
    const firstPromise = probe(f.work, opts).then((r) => { firstDone = r; return r; });
    ok(await waitFor(() => gateRuns() >= 1, 5000), '第一个 launcher 已到达 fetch barrier');
    const secondPromise = probe(f.work, opts).then((r) => { secondDone = r; return r; });
    // 更新锁在 fetch **之前**获取:拿不到锁的 launcher 根本不会进入 fetch,
    // 所以这里不能断言「两个都到 barrier」,只能断言它会带内有界返回并启动当前版本。
    ok(await waitFor(() => secondDone != null, 6000), '第二个 launcher 未被更新锁阻塞到超时');
    ok(await waitFor(() => secondDone != null, 6000), '等锁者有界返回,不永久阻塞');
    ok(secondDone?.code === 0, '拿不到更新锁的 launcher 正常启动当前版本(不 exit 2)', `code=${secondDone?.code} err=${secondDone?.err.slice(0, 150)}`);
    ok(/relay-mcp-fixture/.test(secondDone?.out || '') && !/concurrent-new/.test(secondDone?.out || ''),
      '等锁者启动的是更新前版本');
    ok(head(f.work) === before, '等锁者返回时第一个 launcher 尚未 merge');
    ok(firstDone == null, '第一个 launcher 仍被 fetch barrier 持住');
    writeFileSync(path.join(gateDir, 'release'), 'go\n');
    const first = await firstPromise;
    ok(first.code === 0 && /concurrent-new/.test(first.out), '释放 barrier 后持锁者完成更新并启动新版本', `code=${first.code} err=${first.err.slice(0, 150)}`);
    ok(head(f.work) === upstreamTip, '并发场景最终只快进一次,HEAD/index 一致');
    ok(status(f.work) === '' && !existsSync(path.join(f.work, '.git', 'relay-autoupdate.lock')),
      '并发结束后工作树干净且更新锁释放');
    ok(readLauncherState(f.work).lastResult === 'ok',
      '并发结束后持锁者的成功状态是最终状态');
  }

  console.log('\n== 7. 总预算立即生效 + git 进程组终止 ==');
  {
    const f = makeFixture('budget');
    const before = head(f.work);
    bumpOrigin(f, 'budget-new');
    const marker = path.join(f.root, 'git-grandchild-survived');
    const slowGit = writeShim(f.root, 'git-slow.mjs', `
if (args.includes('symbolic-ref')) {
  // 孙进程必须留在 shim 自己的进程组里:否则 shim 自建新组,杀 -pid 当然杀不到,
  // 测出来的是夹具逃逸而不是实现的进程组终止能力。
  spawn(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync(process.env.AU_MARKER, 'survived'), 2000)"], {
    stdio: 'ignore',
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}`);
    const started = Date.now();
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], budget: 1000, timeoutMs: 6000,
      env: { GIT_BIN: slowGit, AU_MARKER: marker },
    });
    const elapsed = Date.now() - started;
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out), '预算耗尽后仍启动当前 MCP', `code=${r.code} timedOut=${r.timedOut}`);
    ok(elapsed < 5000, '第一条 git 就受总预算约束,没有按 20s 单条上限拖住', `elapsed=${elapsed}ms`);
    ok(head(f.work) === before, '预算耗尽时 HEAD 不动');
    ok(failedCheck(f) && !/已更新|已是最新/.test(logOf(f)), '预算耗尽记为 fail,不记 ok');
    await sleep(2200);
    ok(!existsSync(marker), '超时杀掉整个 git 进程组,孙进程没有继续运行');
  }

  console.log('\n== 8. GIT_* 污染不能覆盖 -C ==');
  {
    const f = makeFixture('env');
    const other = makeFixture('env-other');
    const upstreamTip = bumpOrigin(f, 'env-new');
    writeFileSync(path.join(other.work, 'other.txt'), 'other\n');
    commit(other.work, 'other local');
    const otherBefore = head(other.work);
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work],
      env: {
        GIT_DIR: path.join(other.work, '.git'),
        GIT_WORK_TREE: other.work,
        GIT_INDEX_FILE: path.join(other.work, '.git', 'index'),
        GIT_OBJECT_DIRECTORY: path.join(other.work, '.git', 'objects'),
        GIT_COMMON_DIR: path.join(other.work, '.git'),
      },
    });
    ok(r.code === 0 && /env-new/.test(r.out), '污染环境下仍更新并启动目标仓库版本', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(f.work) === upstreamTip, 'fetch/merge 始终作用于 -C 指定仓库');
    ok(head(other.work) === otherBefore && status(other.work) === '', '另一个仓库的 HEAD/index 没有被污染环境改写');
  }

  console.log('\n== 9. merge 返回成功但 HEAD 未到 origin/main → 不能 finish(ok) ==');
  {
    const f = makeFixture('fake-success');
    const before = head(f.work);
    bumpOrigin(f, 'not-merged');
    const fakeGit = writeShim(f.root, 'git-fake-merge.mjs', `
if (args.includes('merge')) process.exit(0);`);
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], env: { GIT_BIN: fakeGit },
    });
    ok(r.code === 2, 'HEAD != origin/main 时拒绝启动', `code=${r.code} err=${r.err.slice(0, 200)}`);
    ok(!/relay-mcp-fixture/.test(r.out), '假成功没有启动 MCP');
    ok(head(f.work) === before, '假成功场景 HEAD 保持原样');
    ok(failedCheck(f) && !/已更新/.test(logOf(f)), 'after 校验失败没有写 ok');
  }

  console.log('\n== 10. 陈旧更新锁可恢复 ==');
  {
    const f = makeFixture('stale-lock');
    const upstreamTip = bumpOrigin(f, 'stale-new');
    const lock = path.join(f.work, '.git', 'relay-autoupdate.lock');
    const old = new Date(Date.now() - 120000);
    writeFileSync(lock, JSON.stringify({ token: 'dead', pid: 999999, acquiredAt: old.getTime() }));
    utimesSync(lock, old, old);
    const r = await probe(f.work, { scriptPath: WRAPPER_SRC, args: [f.work] });
    ok(r.code === 0 && /stale-new/.test(r.out), '陈旧锁被恢复后正常更新并启动', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(f.work) === upstreamTip, '陈旧锁没有阻断合法更新');
    ok(!existsSync(lock), '恢复后的新锁在完成后释放');
  }

  console.log('\n== 11. wrapper 被 SIGTERM → in-flight git 不变孤儿 ==');
  {
    const f = makeFixture('signal');
    const before = head(f.work);
    bumpOrigin(f, 'signal-new');
    const marker = path.join(f.root, 'signal-grandchild-survived');
    const pidFile = path.join(f.root, 'signal-git.pid');
    const hangingGit = writeShim(f.root, 'git-hang.mjs', `
if (args.includes('fetch')) {
  require('node:fs').writeFileSync(process.env.AU_PID_FILE, String(process.pid));
  // 孙进程留在同一进程组(不 detached),这样 wrapper 杀组时它应一并终止。
  spawn(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync(process.env.AU_MARKER, 'survived'), 5000)"], {
    stdio: 'ignore',
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
}`);
    let launcher = null;
    const pending = probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], timeoutMs: 12000,
      env: { GIT_BIN: hangingGit, AU_MARKER: marker, AU_PID_FILE: pidFile },
      onSpawn: (child) => { launcher = child; },
    });
    ok(await waitFor(() => existsSync(pidFile), 5000), 'wrapper 已进入 in-flight fetch');
    if (launcher) launcher.kill('SIGTERM');
    const r = await pending;
    ok(r.code === 143, 'wrapper 转发并等待子进程后以 SIGTERM 码退出', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(f.work) === before, '信号中断没有继续 merge');
    ok(!existsSync(path.join(f.work, '.git', 'relay-autoupdate.lock')), '信号结算后更新锁释放');
    await sleep(5200);
    ok(!existsSync(marker), 'git 孙进程没有在 wrapper 退出后继续运行');
  }

  console.log('\n== 12. 无参数 → 自推导仓库路径 / REPO 无效 → exit 2 ==');
  {
    const f = makeFixture('autoderive');
    const r = await probe(f.work, { args: [] });   // 不传 REPO:按脚本位置推导 fixture 根
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out),
      '无参数时按脚本自身位置推导仓库并启动夹具 MCP(而非真实仓库)', r.err.slice(0, 150));

    const bogus = mkTmp('bogus');
    const bad = await probe(bogus, { args: [bogus], scriptPath: WRAPPER_SRC });
    ok(bad.code === 2, '无 .git 的目录作为 REPO → exit 2', `code=${bad.code}`);
    ok(/仓库路径无效/.test(bad.err), '报错写明「仓库路径无效」', bad.err.slice(0, 200));
  }

  console.log('\n== 13. 失败检查刷新冷却起点,冷却期内不再调用 git ==');
  {
    const f = makeFixture('failed-cooldown');
    const stateFile = path.join(f.work, '.git', 'relay-autoupdate.json');
    const staleAt = Date.now() - 11 * 60 * 1000;
    writeFileSync(stateFile, JSON.stringify({ lastAttempt: staleAt, lastResult: 'fail' }));
    const failGit = writeShim(f.root, 'git-fail-branch.mjs', `
if (args.includes('symbolic-ref')) {
  console.error('fatal: cannot resolve HEAD');
  process.exit(128);
}`);
    const started = Date.now();
    const first = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], env: { GIT_BIN: failGit },
    });
    const failedState = readLauncherState(f.work);
    ok(first.code === 0 && /relay-mcp-fixture/.test(first.out),
      '失败检查仍启动当前 MCP', `code=${first.code} err=${first.err.slice(0, 150)}`);
    ok(failedState.lastResult === 'fail' && failedState.lastAttempt >= started
      && failedState.lastResultAt >= started,
      '失败检查用本次完成时间刷新冷却起点', JSON.stringify(failedState));

    const marker = path.join(f.root, 'cooldown-git-ran');
    const markerGit = writeShim(f.root, 'git-cooldown-marker.mjs', `
require('node:fs').writeFileSync(process.env.AU_MARKER, 'git-ran');`);
    const second = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work],
      env: { GIT_BIN: markerGit, AU_MARKER: marker },
    });
    ok(second.code === 0 && /relay-mcp-fixture/.test(second.out) && !existsSync(marker),
      '冷却期内直接启动当前版本,没有再次调用 git');
    ok(readLauncherState(f.work).lastAttempt === failedState.lastAttempt,
      '冷却期内的启动不改写失败状态');
  }

  console.log('\n== 14. 并发完成的较新 success 不被本次 fail 覆盖 ==');
  {
    const f = makeFixture('concurrent-state');
    const stateFile = path.join(f.work, '.git', 'relay-autoupdate.json');
    const racingGit = writeShim(f.root, 'git-concurrent-state.mjs', `
if (args.includes('symbolic-ref')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  require('node:fs').writeFileSync(process.env.AU_STATE_FILE, JSON.stringify({
    lastAttempt: Date.now(),
    lastResult: 'ok',
    lastResultAt: Date.now(),
    lastSha: 'other-launcher'
  }));
  console.error('fatal: simulated concurrent branch-check failure');
  process.exit(128);
}`);
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work],
      env: { GIT_BIN: racingGit, AU_STATE_FILE: stateFile },
    });
    const state = readLauncherState(f.work);
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out),
      '并发状态夹具仍启动当前 MCP', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(state.lastResult === 'ok' && state.lastSha === 'other-launcher',
      '已完成的较新 success 保留为最终状态', JSON.stringify(state));
  }

  console.log('\n== 15. 合并前预留预算不足 → 不进入 merge ==');
  {
    const f = makeFixture('premerge-budget');
    const before = head(f.work);
    bumpOrigin(f, 'premerge-new');
    const slowRevList = writeShim(f.root, 'git-slow-rev-list.mjs', `
if (args.includes('HEAD..origin/main')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}`);
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], budget: 5000, timeoutMs: 10000,
      env: { GIT_BIN: slowRevList },
    });
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out) && !/premerge-new/.test(r.out),
      '预算不足时仍启动更新前版本', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(f.work) === before, '未给合并后复核留足预算时 HEAD 不动');
    ok(/时间预算不足/.test(logOf(f)) && readLauncherState(f.work).lastResult === 'fail',
      '合并前预算不足记为 fail,不写成功状态');
  }

  console.log('\n== 16. 等更新锁耗尽预算 → 记为失败检查而非普通争用 ==');
  {
    const f = makeFixture('lock-budget');
    const before = head(f.work);
    const lock = path.join(f.work, '.git', 'relay-autoupdate.lock');
    writeFileSync(lock, JSON.stringify({
      token: 'fixture-holder',
      pid: process.pid,
      acquiredAt: Date.now(),
    }));
    const r = await probe(f.work, {
      scriptPath: WRAPPER_SRC, args: [f.work], budget: 1000, timeoutMs: 5000,
    });
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out),
      '等锁预算耗尽后仍启动当前 MCP', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(head(f.work) === before && existsSync(lock), '未更新且未删除仍新鲜的他人锁');
    ok(/时间预算耗尽/.test(logOf(f)) && readLauncherState(f.work).lastResult === 'fail',
      '等锁耗尽预算记为 fail 并写入冷却');
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ } }
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}

function requireListing(dir) {
  // 小型夹具目录:避免为测试并发 barrier 再引入 glob 依赖。
  return readdirSync(dir);
}
