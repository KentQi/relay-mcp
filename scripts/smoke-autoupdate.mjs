#!/usr/bin/env node
// T067 冒烟:自更新启动器(scripts/relay-mcp-autoupdate.mjs)——隔离夹具版。
//
// 红线(行为断言,不是源码 grep):
//   1) 干净且落后 origin → 包装器把 HEAD ff 到上游顶端(只快进真的会发生);
//   2) 本地有独有提交 → HEAD 不动(不吞本地提交);
//   3) 预算耗尽(RELAY_AUTOUPDATE_BUDGET_MS=1)→ HEAD 不动(失败路径不启动合并);
//   4) 当前分支非 main → HEAD 不动(分支守卫);
//   5) REPO 无 .git → exit 2 + 明确报错;
//   6) 无参数 → 按脚本自身位置推导仓库并启动 MCP;
//   7) 合并调用点必须是 --ff-only(源码级:精确匹配 git(['merge','--ff-only'])。
//
// 隔离:每个场景一个临时目录(bare origin + clone 的工作仓 + 最小 MCP 应答器),
// 不触碰真实仓库与 ~/.relay-mcp/;冒烟里的 HEAD 断言全部在夹具内完成。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_SRC = path.join(RELAY, 'scripts', 'relay-mcp-autoupdate.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};
const tmpDirs = [];
const mkTmp = (tag) => { const d = mkdtempSync(path.join(tmpdir(), `relay-au-${tag}-`)); tmpDirs.push(d); return d; };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
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
  git(origin, 'add', '-A');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'init');
  git(root, 'clone', '--quiet', origin, work);
  return { root, origin, work };
};
const head = (repo) => git(repo, 'rev-parse', 'HEAD');

// probe:spawn 包装器(detached → 可整组杀),写 initialize 后收应答。
// 超时杀整个进程组并**立即结算失败**——孙进程持有管道时 close 永不来,不能等它。
const probe = (repo, { args = [], budget = null, timeoutMs = 30000, scriptPath = null } = {}) => new Promise((resolve) => {
  const script = scriptPath || path.join(repo, 'scripts', 'relay-mcp-autoupdate.mjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;                       // T063 同款:防外层 node --test 污染子进程退出码
  if (budget != null) env.RELAY_AUTOUPDATE_BUDGET_MS = String(budget);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  let out = '', err = '', settled = false;
  const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    done({ code: null, out, err, timedOut: true });
  }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => done({ code: -1, out, err: String(e.message || e), timedOut: false }));
  child.on('close', (code) => done({ code, out, err, timedOut: false }));
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  }) + '\n');
  child.stdin.end();
});

try {
  console.log('== 1. 静态:合并调用点必须是 --ff-only ==');
  {
    const src = readFileSync(WRAPPER_SRC, 'utf8');
    ok(/\[\s*'merge'\s*,\s*'--ff-only'/.test(src),
      '合并调用点精确匹配 git([merge, --ff-only])(不是源码任意处出现 ff-only 字样)');
    ok(/symbolic-ref['",\s]+-q['",\s]+--short['",\s]+HEAD/.test(src.replace(/\n/g, ' ')),
      '存在当前分支守卫(symbolic-ref --short HEAD)');
    ok(src.includes('--git-common-dir'), '存在 linked worktree 守卫(git-common-dir 对比)');
    ok(/index\.lock/.test(src), 'merge 失败后有 index.lock 残留检查');
    ok(/rev-list['",\s]+'--count'/.test(src.replace(/\n/g, ' ')) && !/behind\.ok \? Number\([^)]*\) : 0/.test(src),
      'rev-list 失败不再折算成 0(fail-closed)');
  }

  console.log('\n== 2. 干净且落后 → 只快进到上游顶端 ==');
  {
    const f = makeFixture('ff');
    const before = head(f.work);
    writeFileSync(path.join(f.origin, 'README.md'), 'origin updated\n');
    git(f.origin, 'add', '-A');
    git(f.origin, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'upstream 2');
    const upstreamTip = head(f.origin);
    const r = await probe(f.work);
    ok(r.code === 0, '包装器正常退出', `code=${r.code} err=${r.err.slice(0, 150)}`);
    ok(/relay-mcp-fixture/.test(r.out), '经包装器启动的 MCP 应答 initialize', r.out.slice(0, 150));
    ok(head(f.work) === upstreamTip, 'HEAD 被只快进到上游顶端(merge 真的发生且只快进)',
      `before=${before.slice(0, 7)} tip=${upstreamTip.slice(0, 7)} now=${head(f.work).slice(0, 7)}`);
  }

  console.log('\n== 3. 本地有独有提交 → 不合并 ==');
  {
    const f = makeFixture('diverged');
    writeFileSync(path.join(f.origin, 'README.md'), 'origin updated\n');
    git(f.origin, 'add', '-A');
    git(f.origin, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'upstream 2');
    writeFileSync(path.join(f.work, 'local.txt'), 'local only\n');
    git(f.work, 'add', '-A');
    git(f.work, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'local 1');
    const before = head(f.work);
    const r = await probe(f.work);
    ok(r.code === 0, '包装器正常退出', `code=${r.code}`);
    ok(head(f.work) === before, '本地独有提交时 HEAD 不动(不吞本地提交)',
      `before=${before.slice(0, 7)} now=${head(f.work).slice(0, 7)}`);
  }

  console.log('\n== 4. 预算耗尽 → 不启动合并 ==');
  {
    const f = makeFixture('budget');
    writeFileSync(path.join(f.origin, 'README.md'), 'origin updated\n');
    git(f.origin, 'add', '-A');
    git(f.origin, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'upstream 2');
    const before = head(f.work);
    const r = await probe(f.work, { budget: 1 });
    ok(r.timedOut || r.code === 0, '预算=1 时包装器快速失败或跳过(不长时间阻塞)', `code=${r.code} timedOut=${r.timedOut}`);
    ok(head(f.work) === before, '预算耗尽时 HEAD 不动(合并未被启动)', `now=${head(f.work).slice(0, 7)}`);
  }

  console.log('\n== 5. 分支守卫:非 main 分支不更新 ==');
  {
    const f = makeFixture('branchguard');
    git(f.work, 'checkout', '-qb', 'feature');
    const featureTip = head(f.work);
    writeFileSync(path.join(f.origin, 'README.md'), 'origin updated\n');
    git(f.origin, 'add', '-A');
    git(f.origin, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'upstream 2');
    const r = await probe(f.work);
    ok(r.code === 0, '非 main 分支上包装器仍正常启动 MCP', `code=${r.code}`);
    ok(head(f.work) === featureTip, 'feature 分支的 HEAD 不被自动快进(分支守卫)',
      `tip=${featureTip.slice(0, 7)} now=${head(f.work).slice(0, 7)}`);
  }

  console.log('\n== 6. REPO 无效 → exit 2 + 明确报错 ==');
  {
    const bogus = mkTmp('bogus');
    // 注意:scriptPath 显式取真实启动器;REPO=bogus 才是要测的对象
    const r = await probe(bogus, { args: [bogus], scriptPath: WRAPPER_SRC });
    ok(r.code === 2, '无 .git 的目录作为 REPO → exit 2', `code=${r.code}`);
    ok(/仓库路径无效/.test(r.err), '报错写明「仓库路径无效」', r.err.slice(0, 200));
    // 复制启动器到无 .git 的目录后无参运行 → 自推导也必须 exit 2(不能带病启动)
    mkdirSync(path.join(bogus, 'scripts'), { recursive: true });
    writeFileSync(path.join(bogus, 'scripts', 'relay-mcp-autoupdate.mjs'), readFileSync(WRAPPER_SRC, 'utf8'));
    const r2 = spawnSync(process.execPath, [path.join(bogus, 'scripts', 'relay-mcp-autoupdate.mjs')], {
      cwd: bogus, encoding: 'utf8', timeout: 30000,
    });
    ok(r2.status === 2, '自推导路径同样 fail-closed(exit 2)', `status=${r2.status}`);
  }

  console.log('\n== 7. 无参数 → 自推导仓库路径 ==');
  {
    const f = makeFixture('autoderive');
    const r = await probe(f.work, { args: [] });   // 不传 REPO:按脚本位置推导 fixture 根
    ok(r.code === 0 && /relay-mcp-fixture/.test(r.out),
      '无参数时按脚本位置推导仓库并启动夹具 MCP(而非真实仓库)', r.err.slice(0, 150));
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ } }
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}
