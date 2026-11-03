#!/usr/bin/env node
// T020 冒烟:分发打包面(不发布,只校验 npm pack 的产物边界)。
// 断言:files 白名单生效(源码/模板/安装器进包,协议状态与开发文档不进包);bin 可执行;零运行时依赖。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

const pkg = JSON.parse(readFileSync(path.join(RELAY, 'package.json'), 'utf8'));

console.log('== package.json 发布面 ==');
ok(pkg.private !== true, 'private 已移除(可发布)');
ok(pkg.bin && pkg.bin['relay-mcp'] === 'src/index.mjs', 'bin 指向 src/index.mjs');
ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 白名单存在');
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '零运行时依赖');
ok(pkg.engines && pkg.engines.node === '>=18', 'engines.node >= 18');
// T025:provenance 发布前置——repository/bugs 缺一个,npm 页面就少一条可信来源链路。
ok(pkg.repository && /github\.com[\/:]KentQi\/relay-mcp(?:\.git)?$/.test(String(pkg.repository.url || pkg.repository)), 'repository 指向 github.com/KentQi/relay-mcp', JSON.stringify(pkg.repository));
ok(pkg.bugs && /\/issues$/.test(String(pkg.bugs.url || pkg.bugs)), 'bugs 指向仓库 issues', JSON.stringify(pkg.bugs));

const indexText = readFileSync(path.join(RELAY, 'src', 'index.mjs'), 'utf8');
ok(indexText.startsWith('#!/usr/bin/env node'), 'bin 入口带 shebang(可直接执行)');

console.log('\n== npm pack --dry-run 产物边界 ==');
const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: RELAY, encoding: 'utf8', timeout: 120000 });
ok(r.status === 0, 'npm pack --dry-run 成功', (r.stderr || '').slice(0, 300));
let files = [];
try {
  const parsed = JSON.parse(r.stdout);
  files = (parsed[0] && parsed[0].files ? parsed[0].files : []).map((f) => f.path);
} catch { /* 解析失败由下方断言暴露 */ }
ok(files.length > 0, '拿到打包文件清单', `${files.length} 个`);

const has = (p) => files.some((f) => f === p || f.startsWith(`${p}/`));
const must = ['src/index.mjs', 'src/engines/session.mjs', 'templates/AGENTS.md.tpl', 'scripts/install-mcp.mjs', 'scripts/validate-plugin.mjs', 'plugin.json', 'mcp.json', 'skills/relay-protocol/SKILL.md', 'package.json', 'README.md', 'LICENSE'];
for (const m of must) ok(has(m), `进包: ${m}`);

const forbidden = ['.relay', 'docs-design', 'docs', '.github', 'scripts/smoke.mjs', 'scripts/smoke-facts.mjs', 'TASKS.md', 'LOG.md', 'START.md', 'SPEC.md', 'DECISIONS.md', 'verify', '.gitignore'];
for (const f of forbidden) ok(!has(f), `不进包: ${f}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
