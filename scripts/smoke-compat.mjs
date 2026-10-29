#!/usr/bin/env node
// relay-mcp — 升级兼容与文档契约端到端冒烟(Fix3)。
// 覆盖:
//   C1 relay_onboard 保留既有 manifest 配置(worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover)
//   C2 relay_sync 对"已存在无 relay 标记 AGENTS.md"输出可执行迁移步骤(不让 R1 修复空转)
//   C3 relay_sync 幂等补 .gitignore 运行时基线(旧项目升级路径),用户条目不被删改
//   C4 contract / README / CONTRACT / templates 关键文案断言(配置真值表、双提交、未合并、ignored 保护等)
//   C5 无既有 manifest 的 onboard 保持"既有项目 worktree 缺省关闭"语义
//   C6 relay_restructure 干跑在本次改动后仍正常(轻量回归)
// 只使用 node: 内置依赖;全部在 mktemp 目录内运行,不触碰仓库工作区与 .tmp/。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dispatch, TOOLS, RESOURCES } from '../src/contract.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
let pass = 0;
let fail = 0;
const ok = (condition, label, extra = '') => {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ` — ${String(extra).slice(0, 600)}` : ''}`); }
};
const mkTmp = (tag) => {
  const dir = mkdtempSync(path.join(tmpdir(), `relay-compat-${tag}-`));
  tmpDirs.push(dir);
  return dir;
};
const txt = (r) => r?.content?.[0]?.text || '';
const read = (p) => readFileSync(p, 'utf8');
const git = (root, ...args) => {
  try {
    return execFileSync('git', ['-c', 'user.name=relay-smoke', '-c', 'user.email=relay-smoke@localhost', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { return `ERR:${String(e.stderr || e.message).split('\n')[0]}`; }
};
const freshRepo = async (tag) => {
  const root = mkTmp(tag);
  const r = await dispatch('relay_init', { root, preset: 'minimal' });
  if (r.isError) throw new Error(`relay_init 失败:${txt(r)}`);
  return root;
};
const manifestOf = (root) => JSON.parse(read(path.join(root, '.relay', 'manifest.json')));
const writeManifest = (root, m) => writeFileSync(path.join(root, '.relay', 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
const toolOf = (name) => TOOLS.find((t) => t.name === name);
const toolText = (name) => JSON.stringify(toolOf(name) || {});

try {
  console.log('\n== C1: relay_onboard 保留既有 manifest 配置(P2-06)==');
  {
    const root = await freshRepo('onboard-preserve');
    const before = manifestOf(root);
    const custom = {
      ...before,
      worktree: { enabled: true, cacheDir: '.relay/worktrees', ttlHours: 12, autoCleanup: false },
      autoCommit: false,
      acceptance: { commands: ['npm run lint'] },
      protectedPaths: ['secrets/**'],
      entryFilesTakeover: true,
      codeRoots: ['src', 'app'],
    };
    writeManifest(root, custom);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'custom manifest config');
    const beforeOnboardedAt = custom.onboardedAt;

    const r = await dispatch('relay_onboard', { root });
    const after = manifestOf(root);
    ok(!r.isError, 'C1: onboard 成功', txt(r));
    ok(after.worktree && after.worktree.enabled === true && after.worktree.cacheDir === '.relay/worktrees' && after.worktree.ttlHours === 12 && after.worktree.autoCleanup === false,
      'C1: worktree 配置原样保留(enabled/cacheDir/ttlHours/autoCleanup)', JSON.stringify(after.worktree));
    ok(after.autoCommit === false, 'C1: autoCommit=false 保留');
    ok(Array.isArray(after.acceptance?.commands) && after.acceptance.commands[0] === 'npm run lint', 'C1: acceptance.commands 保留');
    ok(Array.isArray(after.protectedPaths) && after.protectedPaths[0] === 'secrets/**', 'C1: protectedPaths 保留');
    ok(after.entryFilesTakeover === true, 'C1: entryFilesTakeover=true 保留');
    ok(JSON.stringify(after.codeRoots) === JSON.stringify(['src', 'app']), 'C1: codeRoots 保留');
    ok(after.onboardedAt && after.onboardedAt !== beforeOnboardedAt, 'C1: onboardedAt 被刷新');
    ok(txt(r).includes('既有 manifest 配置已保留'), 'C1: 报告声明配置已保留', txt(r));
    ok(txt(r).includes('worktree 配置保持不变'), 'C1: 报告点名 worktree 配置未重置', txt(r));
    const backups = readdirSync(path.join(root, '.relay')).filter((f) => f.startsWith('manifest.json.relay-bak-'));
    ok(backups.length >= 1, 'C1: 旧 manifest 已备份', backups.join(','));
  }

  console.log('\n== C2: relay_sync 输出 AGENTS.md 可执行迁移步骤(P2-04)==');
  {
    const root = await freshRepo('agents-migrate');
    const agentsPath = path.join(root, 'AGENTS.md');
    const handwritten = '# 项目自写规范\n\n- 自定义规则(旧项目未接管)\n';
    writeFileSync(agentsPath, handwritten);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'legacy self-written AGENTS.md');

    const r = await dispatch('relay_sync', { root });
    const out = txt(r);
    ok(!r.isError, 'C2: sync 成功', out);
    ok(out.includes('### AGENTS.md 迁移'), 'C2: 输出专门的 AGENTS.md 迁移小节', out);
    ok(out.includes('entryFilesTakeover'), 'C2: 给出 entryFilesTakeover=true 选项', out);
    ok(out.includes('relay_onboard'), 'C2: 给出 relay_onboard 接管选项(原文不丢)', out);
    ok(out.includes('<!-- relay:generated v1 -->'), 'C2: 给出手工加标记选项', out);
    ok(read(agentsPath) === handwritten, 'C2: sync 按非破坏原则未改写无标记 AGENTS.md');
    ok(!out.includes('全部入口文件与模板再生内容一致,无漂移'), 'C2: 未接管时不谎报"无漂移"', out);

    // C2b: AGENTS.md 缺失 → sync 重建(R1 的可恢复路径)
    const root2 = await freshRepo('agents-recreate');
    rmSync(path.join(root2, 'AGENTS.md'));
    const r2 = await dispatch('relay_sync', { root: root2 });
    ok(!r2.isError && read(path.join(root2, 'AGENTS.md')).startsWith('<!-- relay:generated'),
      'C2b: 缺失 AGENTS.md 由 relay_sync 重建并带标记', txt(r2));
    ok(txt(r2).includes('重建'), 'C2b: 报告标注入口文件已重建', txt(r2));
  }

  console.log('\n== C3: relay_sync 幂等补 .gitignore 基线(旧项目升级路径)==');
  {
    const root = await freshRepo('gitignore-upgrade');
    const giPath = path.join(root, '.gitignore');
    const legacy = read(giPath).split('\n').filter((l) => !l.includes('.relay/worktrees')).join('\n');
    writeFileSync(giPath, `${legacy.replace(/\s*$/, '')}\ncustom-user-ignore/\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'legacy .gitignore without worktree baseline');

    const r = await dispatch('relay_sync', { root });
    const gi = read(giPath);
    ok(!r.isError, 'C3: sync 成功', txt(r));
    ok(txt(r).includes('幂等补'), 'C3: 报告声明补了基线', txt(r));
    ok(gi.includes('.relay/worktrees/'), 'C3: .gitignore 补 .relay/worktrees/');
    ok(gi.includes('.relay/worktrees.json'), 'C3: .gitignore 补 .relay/worktrees.json');
    ok(gi.includes('.relay/worktrees.lock'), 'C3: .gitignore 补 .relay/worktrees.lock');
    ok(gi.includes('custom-user-ignore/'), 'C3: 用户自定义 ignore 条目未被删改');
    ok(txt(r).includes('worktree 配置缺省关闭'), 'C3: 输出旧项目升级提示(worktree 缺省关闭)', txt(r));

    const beforeLineCount = gi.split('\n').length;
    const r2 = await dispatch('relay_sync', { root });
    const gi2 = read(giPath);
    ok(!r2.isError && gi2.split('\n').length === beforeLineCount && !txt(r2).includes('幂等补'),
      'C3: 第二次 sync 幂等,不重复追加基线', txt(r2));

    // C3b: 完全没有 .gitignore 的旧项目 → sync 直接按基线新建
    const root2 = await freshRepo('gitignore-missing');
    rmSync(path.join(root2, '.gitignore'));
    const r3 = await dispatch('relay_sync', { root: root2 });
    ok(!r3.isError && read(path.join(root2, '.gitignore')).includes('.relay/worktrees/'),
      'C3b: 缺失 .gitignore 时 sync 按基线新建', txt(r3));
    ok(txt(r3).includes('按基线新建'), 'C3b: 报告声明 .gitignore 已按基线新建', txt(r3));
  }

  console.log('\n== C4: contract / README / CONTRACT / templates 文案契约 ==');
  {
    const claim = toolText('relay_claim');
    ok(claim.includes('Only JSON boolean true') || claim.includes('JSON boolean true'), 'C4: claim schema 明示只认 JSON 布尔 true', claim);
    ok(claim.includes('silently'), 'C4: claim schema 明示字符串/未知值静默处理', claim);
    ok(claim.includes('cacheDir'), 'C4: claim schema 明示 cacheDir 相对路径约束');
    ok(toolText('relay_worktree_cleanup').includes('ignored'), 'C4: cleanup 描述明示 ignored 内容保护');
    ok(/two commits|TWO commits/i.test(toolText('relay_session_end')), 'C4: session_end 描述明示双提交', toolText('relay_session_end'));
    ok(toolText('relay_session_end').includes('unique per concurrent session') || toolText('relay_session_end').includes('unique model id'), 'C4: session_end 描述要求并发会话使用唯一 model 标识');
    ok(toolText('relay_onboard').includes('PRESERVED') && toolText('relay_onboard').includes('worktree'), 'C4: onboard 描述明示保留既有配置');
    ok(toolText('relay_sync').includes('.gitignore') && toolText('relay_sync').includes('migration'), 'C4: sync 描述明示补基线 + AGENTS 迁移', toolText('relay_sync'));

    const rules = txt(await dispatch('relay_rules', {}));
    for (const [needle, label] of [
      ['worktree 配置真值表', 'RULES_TEXT 含配置真值表'],
      ['双提交', 'RULES_TEXT 含双提交语义'],
      ['未合并', 'RULES_TEXT 含未合并分支说明'],
      ['ignored', 'RULES_TEXT 含 ignored 清理保护'],
      ['abort/release', 'RULES_TEXT 含能力边界(abort/release)'],
      ['同名 model', 'RULES_TEXT 含同名 model 禁并发'],
      ['R1', 'RULES_TEXT 含 R1 迁移修复路径'],
    ]) ok(rules.includes(needle), `C4: ${label}`);

    const protocol = await RESOURCES.find((r) => r.uri === 'relay://protocol').load();
    ok(/two commits|TWO commits/i.test(protocol), 'C4: relay://protocol 含双提交');
    ok(protocol.includes('relay/T###') && protocol.includes('ignored'), 'C4: relay://protocol 含未合并/ignored 说明');
    ok(protocol.includes('abort'), 'C4: relay://protocol 含 abort 能力边界');

    const readme = read(path.join(RELAY, 'README.md'));
    for (const [needle, label] of [
      ['出场 = 双提交', 'README 含出场双提交'],
      ['未合并 ≠ 未完成', 'README 含未合并语义与人工 merge'],
      ['git merge --no-ff relay/T###', 'README 含人工合并命令'],
      ['ignored 本地内容', 'README 含 ignored 清理保护'],
      ['只认 JSON 布尔 `true`', 'README 含 enabled 只认布尔 true'],
      ['entryFilesTakeover', 'README 含 AGENTS 迁移步骤'],
      ['abort/release', 'README 含能力边界'],
      ['worktrees.json', 'README 含 registry 恢复指引'],
      ['重建登记', 'README 含 registry 恢复操作(重建登记)'],
      ['成对证据', 'README 含成对证据/R5-R6 说明'],
      ['双根绿闸', 'README 含双根绿闸'],
      ['根错配保护', 'README 含根错配保护'],
      ['一律 isError', 'README 含严格根错配(一律 isError)'],
      ['git worktree list', 'README 含注册表反查(git worktree list)'],
      ['刻意关闭心跳', 'README 含认领锁不心跳'],
      ['240 分钟 TTL', 'README 含认领锁 240min TTL 崩溃恢复'],
      ['写前 fencing', 'README 含仓库写锁心跳/fencing'],
      ['独立 checkout', 'README 含 executionRoot 独立依赖'],
      ['同名 model 无法区分持有者', 'README 含同名 model 禁并发'],
    ]) ok(readme.includes(needle), `C4: ${label}`);

    const contractDoc = read(path.join(RELAY, 'docs-design', 'CONTRACT.md'));
    for (const [needle, label] of [
      ['Fix3', 'CONTRACT 含本轮修复契约小节'],
      ['双提交', 'CONTRACT 含双提交'],
      ['ignored', 'CONTRACT 含 ignored 清理保护'],
      ['relay_sync', 'CONTRACT 含旧项目升级路径'],
      ['registry 恢复', 'CONTRACT 含 registry 恢复'],
      ['根错配', 'CONTRACT 含根错配 fail-closed'],
      ['一律 isError', 'CONTRACT 含严格根错配'],
      ['刻意关闭心跳', 'CONTRACT 含认领锁不心跳'],
      ['写前 fencing', 'CONTRACT 含仓库写锁心跳/fencing'],
      ['cacheDir', 'CONTRACT 含 cacheDir 校验'],
    ]) ok(contractDoc.includes(needle), `C4: ${label}`);

    const agentsTpl = read(path.join(RELAY, 'templates', 'AGENTS.md.tpl'));
    ok(agentsTpl.includes('任务级 worktree(启用时)'), 'C4: AGENTS 模板含 worktree 章节');
    ok(agentsTpl.includes('executionRoot') && agentsTpl.includes('未合并'), 'C4: AGENTS 模板含双根/未合并');
    ok(agentsTpl.includes('R1') && agentsTpl.includes('entryFilesTakeover'), 'C4: AGENTS 模板 R1 行含迁移路径');
    ok(read(path.join(RELAY, 'templates', 'START.md')).includes('独立检出'), 'C4: START 模板含 executionRoot 独立检出提示');
    ok(agentsTpl.includes('根错配') && agentsTpl.includes('双根绿闸'), 'C4: AGENTS 模板含根错配/双根绿闸');
    ok(agentsTpl.includes('不心跳') && agentsTpl.includes('240min TTL'), 'C4: AGENTS 模板含两把锁语义(认领锁不心跳)');
    ok(agentsTpl.includes('无空树例外') || agentsTpl.includes('一律被拒'), 'C4: AGENTS 模板含严格根错配语义');
    for (const [file, label] of [['START.md', 'START 模板'], ['AGENTS.md.tpl', 'AGENTS 模板']]) {
      const t = read(path.join(RELAY, 'templates', file));
      ok(!/TODO|进行中|下周|待办:/.test(t), `C4: ${label} 无 R4 时变词`);
    }
    const pkg = JSON.parse(read(path.join(RELAY, 'package.json')));
    ok(typeof pkg.scripts?.test === 'string' && pkg.scripts.test.includes('smoke-compat.mjs'), 'C4: package.json test 链包含 smoke-compat');
  }

  console.log('\n== C5: 无既有 manifest 的 onboard 保持旧项目 worktree 缺省关闭 ==');
  {
    const root = mkTmp('onboard-legacy');
    writeFileSync(path.join(root, 'README.md'), '# legacy project\n');
    const r = await dispatch('relay_onboard', { root });
    const m = manifestOf(root);
    ok(!r.isError, 'C5: 旧项目 onboard 成功', txt(r));
    ok(!m.worktree, 'C5: onboard 不凭空写入 worktree 配置(既有项目缺省关闭)', JSON.stringify(m.worktree));
    ok(m.version === 1 && Array.isArray(m.entryFiles) && m.entryFiles.includes('AGENTS.md'), 'C5: onboard manifest 基础字段正确');
    ok(read(path.join(root, '.gitignore')).includes('.relay/worktrees/'), 'C5: onboard 写入 .gitignore worktree 基线');
  }

  console.log('\n== C6: relay_restructure 干跑轻量回归 ==');
  {
    const root = await freshRepo('restructure-dry');
    mkdirSync(path.join(root, 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'lib', 'a.js'), 'export const a = 1;\n');
    const r = await dispatch('relay_restructure', { root });
    ok(!r.isError && txt(r).includes('迁移方案'), 'C6: restructure 干跑仍返回迁移方案', txt(r));
    ok(!existsSync(path.join(root, 'src')), 'C6: 干跑不移动文件');
  }
} catch (e) {
  fail += 1;
  console.log(`  ✗ FAIL 未捕获异常: ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : String(e)}`);
} finally {
  console.log(`\n========== smoke-compat 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
