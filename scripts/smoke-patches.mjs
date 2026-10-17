#!/usr/bin/env node
// relay-mcp 补丁回归:每个补丁两条断言 ——「默认值行为不变」+「新配置生效」。
// 默认路径必须与 v1.0.0 逐字符一致,否则就是破坏性变更而不是补丁。
// 独立于 scripts/smoke.mjs(后者覆盖原生契约,本文件只覆盖补丁引入的配置面)。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proc = spawn('node', ['src/index.mjs'], { cwd: RELAY, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

let nextId = 1;
const pending = new Map();
proc.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 非协议行即失败 */ }
  }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
});
const tool = async (name, args = {}) => {
  const r = await call('tools/call', { name, arguments: args });
  return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? '' };
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 1600) : ''}`); } };

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const mfPath = (dir) => path.join(dir, '.relay', 'manifest.json');
const readMf = (dir) => JSON.parse(readFileSync(mfPath(dir), 'utf8'));
// .relay/** 是内置受保护路径:改 manifest 后若留着不提交,出场必然走护栏通道,
// 那样测的就不是补丁而是夹具噪声。改完立刻提交,把 manifest 变化从工作区清掉。
const commitAll = (dir, msg) => {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', msg || 'chore: fixture', '--quiet');
};
const writeMf = (dir, patch) => {
  const m = readMf(dir);
  writeFileSync(mfPath(dir), JSON.stringify({ ...m, ...patch }, null, 2));
  commitAll(dir, 'chore: manifest fixture');
};
// R2 顶层白名单:夹具新增目录/文件必须先修宪,否则 R2 会挡住出场(与补丁无关)
const allow = (dir, ...tops) => {
  const m = readMf(dir);
  const set = new Set(m.allowedTopLevel || []);
  for (const t of tops) set.add(t);
  writeFileSync(mfPath(dir), JSON.stringify({ ...m, allowedTopLevel: [...set] }, null, 2));
  commitAll(dir, 'chore: allowedTopLevel fixture');
};
const W = (rel, body) => writeFileSync(rel, body);
const mkTmp = (tag) => mkdtempSync(path.join(tmpdir(), `relay-patch-${tag}-`));

// 造一个干净基线仓库(relay_init → 清掉 preset 的 src/tests,只留协议骨架)
async function freshRepo(tag, { noDocsHistory = false } = {}) {
  const dir = mkTmp(tag);
  const r = await tool('relay_init', { root: dir, name: `补丁-${tag}`, preset: 'minimal' });
  if (r.isError) throw new Error(`relay_init 失败: ${r.text.slice(0, 300)}`);
  for (const f of ['src/index.js', 'tests/smoke.test.js', 'package.json', 'src']) rmSync(path.join(dir, f), { recursive: true, force: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `patch-${tag}`, private: true, type: 'module' }, null, 2));
  // preset=minimal 不带 .gitignore;补上 relay 的运行时文件忽略,否则 .relay/relay.lock
  // 会被 status --porcelain 看见并命中内置 .relay/** 护栏(夹具噪声,非补丁行为)
  writeFileSync(path.join(dir, '.gitignore'), '.env\n*.pem\n.relay/claims/\n.relay/relay.lock\n');
  // 可选:R6 看的是「最近 20 次提交」的文件并集,relay_init 的首个提交里带 docs/,
  // 会让任何仓库的 docsChanged 恒为 true。要构造「docs 零改动」的历史必须把 docs 摘出 git。
  if (noDocsHistory) {
    git(dir, 'rm', '-r', '--cached', 'docs', '--quiet');
    writeFileSync(path.join(dir, '.gitignore'), '.env\n*.pem\n.relay/claims/\n.relay/relay.lock\ndocs/\n');
    git(dir, 'checkout', '--orphan', 'relay-base', '--quiet');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'baseline', '--quiet');
    git(dir, 'branch', '-M', 'relay-base');
  }
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'baseline', '--quiet');
  return dir;
}
// 往 TASKS.md 待办区塞一条任务(带验收行)
const addTask = (dir, id, title, acceptance) => {
  const p = path.join(dir, 'TASKS.md');
  const s = readFileSync(p, 'utf8').replace('## 待办', `## 待办\n- [ ] ${id} ${title}\n  验收: ${acceptance}`);
  writeFileSync(p, s);
};
// 端到端出场(成功才算绿)
const end = (dir, args) => tool('relay_session_end', { root: dir, model: 'patch-model', ...args });

const tmpDirs = [];
try {
  await call('initialize', { protocolVersion: '2025-06-18' });

  // ===================== P1:验收白名单 =====================
  console.log('\n== P1: manifest.acceptance.commands 验收白名单 ==');
  {
    const dir = await freshRepo('p1'); tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'acc-pass.mjs'), 'console.log("ACC OK");\n');
    writeFileSync(path.join(dir, 'acc-fail.mjs'), 'process.exit(3);\n');
    // 验收串必须**不以 js/ts 后缀结尾**才会走白名单分支:「node acc-pass.mjs」在补丁前后
    // 都被当测试文件路径(因此在补丁前也报「测试文件不存在」)。用 npm script 更贴近真实仓库。
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'p1', private: true, type: 'module',
      scripts: { guard: 'node acc-pass.mjs', guardfail: 'node acc-fail.mjs', guardboom: 'node acc-boom.mjs' },
    }, null, 2));
    writeFileSync(path.join(dir, 'acc-boom.mjs'), 'console.error("SHOULD-NOT-RUN"); process.exit(0);\n');
    allow(dir, 'acc-pass.mjs', 'acc-fail.mjs', 'acc-boom.mjs');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'chore: acc fixtures', '--quiet');
    addTask(dir, 'T901', '白名单验收', 'test:npm run guard');

    // 默认值:未登记的命令 → 与补丁前逐字符一致的拒绝文案
    const d = await end(dir, { summary: '默认值应拒绝非白名单命令', done_task: 'T901' });
    ok(d.isError && d.text.includes('只接受 js/ts 测试文件'), 'P1 默认:非 js/ts 验收行仍被安检拒绝(与 v1.0.0 同文案)', d.text.slice(0, 200));

    // dash 安检:验收命令以 - 开头 → 与 js/ts 路径安检同规拒收(防 CLI 选项注入)
    writeMf(dir, { acceptance: { commands: ['-x evil'] } });
    addTask(dir, 'T915', 'dash 安检', 'test:-x evil');
    const r15 = await end(dir, { summary: 'dash 应被拒', done_task: 'T915' });
    ok(r15.isError && r15.text.includes('不得以'), 'P1 加固:白名单内 dash 命令仍被安检拒收(inspectTestPath 或 classifyAcceptance 任一分支拦截)', r15.text.slice(0, 250));

    // 新配置生效:登记进白名单 → 实跑
    writeMf(dir, { acceptance: { commands: ['npm run guard', 'npm run guardfail', 'npm run guardboom'] } });
    const g = await end(dir, { summary: '白名单命中应放行', done_task: 'T901' });
    ok(!g.isError && g.text.includes('manifest.acceptance.commands 白名单)通过'), 'P1 生效:白名单命令被实际执行并记入出场简报', g.text.slice(0, 400));

    // 白名单命中但命令不绿 → 仍拒绝出场(绿灯协议不被绕过)
    addTask(dir, 'T902', '白名单验收红', 'test:npm run guardfail');
    const r2 = await end(dir, { summary: '白名单命令不绿应拒绝', done_task: 'T902' });
    ok(r2.isError && r2.text.includes('验收 test: 不绿'), 'P1 生效:白名单命令红 → 拒绝出场(绿灯端执法未被绕过)', r2.text.slice(0, 250));

    // 未登记的命令即便在白名单文件里也不执行
    addTask(dir, 'T903', '未登记命令', 'test:npm run never-registered');
    const r3 = await end(dir, { summary: '未登记命令不得执行', done_task: 'T903' });
    ok(r3.isError && r3.text.includes('白名单'), 'P1 生效:白名单外的命令被拒(不执行)', r3.text.slice(0, 250));
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== P2:protectedPaths =====================
  console.log('\n== P2: manifest.protectedPaths 受保护路径 ==');
  {
    const dir = await freshRepo('p2'); tmpDirs.push(dir);
    mkdirSync(path.join(dir, 'tools'), { recursive: true });
    writeFileSync(path.join(dir, 'tools', 'check_x.py'), 'print("guard")\n');
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'guard_x.py'), 'print("guard")\n');
    allow(dir, 'tools', 'scripts', 'tests', 'backend_marker.js', 'toolsx');

    // 默认值:manifest 无 protectedPaths → 这些文件不受保护,正常自动提交(与 v1.0.0 一致)
    const d = await end(dir, { summary: '默认不受保护', maintenance: true });
    ok(!d.isError && d.text.includes('## 提交'), 'P2 默认:无 protectedPaths 时守门脚本照常自动提交(与 v1.0.0 一致)', d.text.slice(0, 250));

    // 新配置生效
    writeMf(dir, { protectedPaths: ['tools/check_*', 'scripts/guard_*', 'tools/*.json'] });
    writeFileSync(path.join(dir, 'tools', 'check_y.py'), 'print("g2")\n');
    const g = await end(dir, { summary: '受保护命中', maintenance: true });
    ok(!g.isError && g.text.includes('护栏:需人类批准') && g.text.includes('tools/check_y.py'),
      'P2 生效:manifest.protectedPaths 命中 → 不自动提交', g.text.slice(0, 400));
    ok(g.text.includes('manifest.protectedPaths'), 'P2 生效:命中原因点名 manifest 规则', g.text.slice(0, 600));

    // 合并语义:内置 5 条规则仍生效(manifest 不能放松)
    writeFileSync(path.join(dir, 'backend_marker.js'), '// built-in rule probe\n');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'probe.js'), '// built-in rule probe\n');
    const b = await end(dir, { summary: '内置规则仍在', maintenance: true });
    ok(b.text.includes('tests/probe.js') && b.text.includes('命中规则: tests/**'),
      'P2 合并语义:内置 tests/** 规则未被 manifest 覆盖掉', b.text.slice(0, 700));

    // glob 语义边界:** 跨目录,* 不跨目录
    writeMf(dir, { protectedPaths: ['tools/**'] });
    mkdirSync(path.join(dir, 'tools', 'deep'), { recursive: true });
    writeFileSync(path.join(dir, 'tools', 'deep', 'check_deep.py'), 'print("deep")\n');
    mkdirSync(path.join(dir, 'toolsx'), { recursive: true });
    writeFileSync(path.join(dir, 'toolsx', 'check_no.py'), 'print("no")\n');
    const gg = await end(dir, { summary: 'glob 边界', maintenance: true });
    ok(gg.text.includes('tools/deep/check_deep.py'), 'P2 glob:** 跨目录命中 tools/deep/**', gg.text.slice(0, 800));
    ok(!gg.text.includes('toolsx/check_no.py'), 'P2 glob:** 不误伤前缀同名的 toolsx/', gg.text.slice(0, 800));
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== P3:docsIgnore =====================
  console.log('\n== P3: manifest.docsIgnore frontmatter 豁免 ==');
  {
    const dir = await freshRepo('p3'); tmpDirs.push(dir);
    mkdirSync(path.join(dir, 'docs', '05-delivery'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', '05-delivery', 'release-notes-v0.9.0.md'), '# 无 frontmatter 的发布说明\n');
    writeFileSync(path.join(dir, 'docs', '05-delivery', 'adr-note.md'), '---\ntitle: 有 frontmatter\nstatus: 现行\n---\n\nok\n');
    mkdirSync(path.join(dir, 'docs', 'superpowers'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'superpowers', 'x.md'), '# 无 frontmatter\n');

    // 默认值:docsIgnore 缺席 → 缺 frontmatter 即 ERROR(与 v1.0.0 一致)
    const d = await tool('relay_verify', { root: dir, full: true });
    ok(d.isError && /\| R3 \| ERROR \|/.test(d.text), 'P3 默认:无 docsIgnore 时缺 frontmatter 仍判 ERROR(与 v1.0.0 一致)', d.text.slice(0, 400));

    // 新配置生效
    writeMf(dir, { docsIgnore: ['05-delivery/release-notes-*.md', 'superpowers/**'] });
    const g = await tool('relay_verify', { root: dir, full: true });
    ok(!g.isError && /\| R3 \| PASS \|/.test(g.text), 'P3 生效:docsIgnore 命中的文件被跳过,R3 转 PASS', g.text.slice(0, 500));
    ok(/R3.*剪掉 2 个/s.test(g.text.replace(/\n/g, ' ')), 'P3 生效:PASS 明细如实报出剪掉的文件数(静默豁免会骗人)', g.text.slice(0, 500));

    // 内置豁免不受配置影响:再配一条命中 archive 的 ignore,内置行为不变
    const k = await tool('relay_verify', { root: dir, full: true });
    ok(!k.isError && k.text.includes('docs/ 无待检') === false, 'P3 生效:archive/templates 内置豁免语义未被破坏', k.text.slice(0, 300));
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== P4:codeRoots =====================
  console.log('\n== P4: manifest.codeRoots R5/R6 前缀 ==');
  {
    const dir = await freshRepo('p4', { noDocsHistory: true }); tmpDirs.push(dir);
    mkdirSync(path.join(dir, 'backend', 'app', 'services'), { recursive: true });
    writeFileSync(path.join(dir, 'backend', 'app', 'services', 'x.py'), 'print(1)\n');
    allow(dir, 'backend');

    // 先用默认 codeRoots 提交一次代码 —— ['src','lib','app'] 匹配不到 backend/app/**(v1.0.0 盲区)
    commitAll(dir, 'feat: add backend/app service');
    const d = await tool('relay_verify', { root: dir, full: true });
    ok(!/\| R5 \| WARN/.test(d.text), 'P4 默认:backend/app/** 不被默认 codeRoots 识别(与 v1.0.0 一致)', d.text.slice(0, 600));

    // 新配置生效:两级前缀能命中 → R5 报原子性缺口
    writeMf(dir, { codeRoots: ['backend/app', 'backend', 'web/src', 'mp/src'] });
    W(path.join(dir, 'backend/app/services/x.py'), 'print(2)' + String.fromCharCode(10));   // 让「最近一次提交」再次落在代码上
    commitAll(dir, 'feat: touch backend/app again');
    const g = await tool('relay_verify', { root: dir, full: true });
    ok(/\| R5 \| WARN/.test(g.text) && g.text.includes('backend/app/services/x.py')
      && g.text.includes('manifest.codeRoots: backend/app, backend, web/src, mp/src'),
    'P4 生效:codeRoots 命中两级前缀 backend/app/** → R5 报警且明细报出本次前缀', g.text.slice(0, 700));
    ok(/\| R6 \| (PASS|WARN) \|/.test(g.text) && g.text.includes('manifest.codeRoots: backend/app, backend, web/src, mp/src'),
      'P4 生效:R6 用同一份 codeRoots 判定且明细报出(报告不与实现漂移)', g.text.slice(0, 700));

    // R6:代码前缀 + docs 同步判定
    allow(dir, 'web');
    mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'src', 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'feat: web src only');
    const r6 = await tool('relay_verify', { root: dir, full: true });
    ok(/\| R6 \| WARN/.test(r6.text), 'P4 生效:R6 用 codeRoots 识别 web/src/** 的改动而 docs/ 零改动', r6.text.slice(0, 900));
    const r6row = (r6.text.split('\n').find((l) => l.startsWith('| R6 |')) || '(未找到 R6 行)');
    ok(r6row.includes('manifest.codeRoots: backend/app, backend, web/src, mp_src_PLACEHOLDER') === false
      && r6row.includes('文档前缀 docs 零改动'), 'P4 生效:R6 WARN 同时报出 docsRoots', r6row);
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== P5:entryFiles 子集 + 不接管 =====================
  console.log('\n== P5: manifest.entryFiles 子集 + sync 不接管 ==');
  {
    const dir = await freshRepo('p5'); tmpDirs.push(dir);
    allow(dir, 'CLAUDE.md');
    // 造一个 2000+ 行、无 relay 标记的老 CLAUDE.md
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# 老团队规范\n' + Array.from({ length: 1200 }, (_, i) => `第 ${i} 行老规范,不许改。`).join('\n') + '\n');

    // 默认值:entryFiles 为空数组 → 不生成任何入口文件,且**不再回落默认三份**
    writeMf(dir, { entryFiles: [] });
    rmSync(path.join(dir, 'AGENTS.md'), { force: true });
    rmSync(path.join(dir, 'GEMINI.md'), { force: true });
    const s0 = await tool('relay_sync', { root: dir });
    ok(!s0.isError && s0.text.includes('本次不投影任何入口文件'), 'P5 生效:entryFiles=[] → 不生成任何入口文件(不再回落默认三份)', s0.text.slice(0, 300));
    ok(!existsSync(path.join(dir, 'AGENTS.md')) && !existsSync(path.join(dir, 'GEMINI.md')), 'P5 生效:确认 AGENTS.md / GEMINI.md 未被凭空生成');

    // 老 CLAUDE.md 一个字节都没被动
    const claudeBefore = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    writeMf(dir, { entryFiles: ['CLAUDE.md'] });
    const s1 = await tool('relay_sync', { root: dir });
    ok(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8') === claudeBefore, 'P5 生效:2000+ 行无标记 CLAUDE.md 未被改写(逐字节一致)');
    ok(s1.text.includes('未接管'), 'P5 生效:报告里点名「未接管」,不把 kept 伪装成「一致」', s1.text.slice(0, 400));
    ok(s1.text.includes('relay_sync') && !s1.text.includes('无漂移'), 'P5 生效:有未接管项时不谎报「全部一致,无漂移」', s1.text.slice(0, 400));

    // 显式 takeover → 恢复 v1.0.0 的强制重投影
    writeMf(dir, { entryFiles: ['CLAUDE.md'], entryFilesTakeover: true });
    const s2 = await tool('relay_sync', { root: dir });
    ok(s2.text.includes('重写'), 'P5 生效:entryFilesTakeover=true 恢复强制重投影', s2.text.slice(0, 400));
    ok(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').length < claudeBefore.length, 'P5 生效:takeover 后老 CLAUDE.md 确实被投影覆盖');

    // 默认值:带 relay 标记的入口文件仍然强制对齐(补丁未放松既有执法)
    const dir2 = await freshRepo('p5b'); tmpDirs.push(dir2);
    writeFileSync(path.join(dir2, 'AGENTS.md'), readFileSync(path.join(dir2, 'AGENTS.md'), 'utf8') + '\n人为篡改\n');
    const s3 = await tool('relay_sync', { root: dir2 });
    ok(s3.text.includes('重写') && !readFileSync(path.join(dir2, 'AGENTS.md'), 'utf8').includes('人为篡改'),
      'P5 默认:带标记入口文件仍强制对齐模板(既有执法未被放松)', s3.text.slice(0, 400));
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }

  // ===================== P6:提交面 =====================
  console.log('\n== P6: commitMessageTemplate / autoCommit / 冲突守卫 ==');
  {
    const dir = await freshRepo('p6'); tmpDirs.push(dir);
    allow(dir, 'acc.mjs', 'conflict.txt');

    // 默认值:提交信息与 v1.0.0 逐字符一致
    const d = await end(dir, { summary: '默认提交信息', maintenance: true });
    const top0 = git(dir, 'log', '-1', '--pretty=%s').stdout.trim();
    ok(top0 === 'relay: session end — 默认提交信息', 'P6 默认:提交信息逐字符不变', `got "${top0}"`);

    // 新配置:模板
    writeMf(dir, { commitMessageTemplate: '[{{taskId}}] {{summary}}' });
    const g = await end(dir, { summary: '模板化提交', maintenance: true });
    const top1 = git(dir, 'log', '-1', '--pretty=%s').stdout.trim();
    ok(top1 === '[] 模板化提交', 'P6 生效:commitMessageTemplate 生效({{taskId}}/{{summary}})', `got "${top1}"`);

    // {{task}} 变量保持补丁前 head 语义(含「 · 」分隔符)
    addTask(dir, 'T905', '模板任务', 'node acc.mjs');
    writeFileSync(path.join(dir, 'acc.mjs'), 'console.log("ok");\n');
    writeMf(dir, { commitMessageTemplate: '{{task}}{{summary}}', acceptance: { commands: ['node acc.mjs'] } });
    const t = await end(dir, { summary: '带任务号出场', done_task: 'T905' });
    const top2 = git(dir, 'log', '-1', '--pretty=%s').stdout.trim();
    ok(top2 === 'T905 完成 · 带任务号出场', 'P6 生效:{{task}} 渲染 = 补丁前 head(任务前缀 + 「 · 」)', `got "${top2}"`);

    // autoCommit=false → 只更新文件,不落提交,不置错
    writeMf(dir, { autoCommit: false });
    const before = git(dir, 'rev-list', '--count', 'HEAD').stdout.trim();
    const a = await end(dir, { summary: '关闭自动提交', maintenance: true });
    const after = git(dir, 'rev-list', '--count', 'HEAD').stdout.trim();
    ok(!a.isError && a.text.includes('autoCommit = false'), 'P6 生效:autoCommit=false → 降级但不置错', a.text.slice(0, 400));
    ok(before === after, 'P6 生效:autoCommit=false 确实没有产生提交', `${before} → ${after}`);
    writeMf(dir, { autoCommit: true });

    // 冲突守卫:制造真实未解决冲突 → 拒绝自动提交
    git(dir, 'checkout', '-q', '-b', 'feat-a');
    writeFileSync(path.join(dir, 'conflict.txt'), 'a\n');
    git(dir, 'add', '-A'); git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'feat: a', '--quiet');
    git(dir, 'checkout', '-q', '-b', 'feat-b', 'HEAD~1');
    writeFileSync(path.join(dir, 'conflict.txt'), 'b\n');
    git(dir, 'add', '-A'); git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'feat: b', '--quiet');
    git(dir, 'merge', 'feat-a');
    const isConflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').stdout.includes('conflict.txt');
    if (isConflicted) {
      const cBefore = git(dir, 'rev-list', '--count', 'HEAD').stdout.trim();
      const c = await end(dir, { summary: '冲突在场', maintenance: true });
      const cAfter = git(dir, 'rev-list', '--count', 'HEAD').stdout.trim();
      ok(c.text.includes('存在未解决的合并冲突'), 'P6 生效:diff-filter=U 非空 → 护栏拦截', c.text.slice(0, 500));
      ok(cBefore === cAfter, 'P6 生效:冲突态没有被自动提交进历史', `${cBefore} → ${cAfter}`);
      ok(c.text.includes('conflict.txt'), 'P6 生效:冲突文件名逐个点名', c.text.slice(0, 500));
    } else {
      ok(false, 'P6 冲突守卫:测试夹具未能制造未解决冲突');
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== P2-bugfix:porcelain XY 状态位 =====================
  console.log('\n== P2-bugfix: ` M path` 前导空格被吃掉导致护栏路径截断 ==');
  {
    const dir = await freshRepo('p2b'); tmpDirs.push(dir);
    allow(dir, '.relay-fix.md', 'tools');
    // 受保护文件已入库,本轮只「修改」不新增 —— git status 走 ` M path`(首字符是空格)
    W(path.join(dir, '.relay-fix.md'), '# 首次入库\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-m', 'chore: seed', '--quiet');
    writeMf(dir, { protectedPaths: ['.relay-fix.md'] });
    W(path.join(dir, '.relay-fix.md'), '# 本轮修改 —— 若状态位被 trim 吃掉,路径会变成 relay-fix.md 而漏判\n');
    const raw = git(dir, '-c', 'core.quotePath=false', 'status', '--porcelain', '-uall').stdout.trimEnd();
    ok(raw.startsWith(' M '), 'P2-bugfix 前提:git status 该行确实是 ` M <path>`(首字符为空格)', JSON.stringify(raw));
    const g = await end(dir, { summary: '状态位回归', maintenance: true });
    ok(g.text.includes('护栏:需人类批准') && g.text.includes('`.relay-fix.md`'),
      'P2-bugfix 生效:护栏看到完整路径 `.relay-fix.md`(未被截成 `relay-fix.md`/`ackend/...`)', g.text.slice(0, 700));
    ok(!/`[a-z]relay-fix.md`|`elay-fix.md`/.test(g.text), 'P2-bugfix 生效:输出中不存在被截掉首字符的路径', g.text.slice(0, 700));
    rmSync(dir, { recursive: true, force: true });
  }

  // ===================== 配置默认值回归:manifest 缺席 =====================
  console.log('\n== 默认值回归:无 manifest 时全部走 v1.0.0 默认 ==');
  {
    const dir = mkTmp('p0'); tmpDirs.push(dir);
    git(dir, 'init', '--quiet');
    mkdirSync(path.join(dir, '.relay'), { recursive: true });
    writeFileSync(mfPath(dir), '{ 这不是合法 JSON ');
    const v = await tool('relay_verify', { root: dir, full: true });
    ok(/\| R1 \| ERROR \|/.test(v.text), '默认回归:manifest 损坏 → R1 报错(未因新配置面崩溃)');
    ok(!/\| R5 \| ERROR \|/.test(v.text) && !/\| R6 \| ERROR \|/.test(v.text), '默认回归:R5/R6 在无有效 manifest 下不炸', v.text.slice(0, 500));
    rmSync(dir, { recursive: true, force: true });
  }

} finally {
  console.log(`\n========== 补丁冒烟结果: ${pass} 通过 / ${fail} 失败 ==========`);
  proc.kill();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 已删 */ } }
  process.exit(fail ? 1 : 0);
}