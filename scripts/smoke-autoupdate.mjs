#!/usr/bin/env node
// T065 冒烟:自更新启动器已纳入仓库(scripts/relay-mcp-autoupdate.mjs)。
//
// 红线:
//   1) 启动器存在于仓库内且语法可加载——它是 14 个 harness 更新通道的唯一入口,不能丢;
//   2) 经包装器启动 MCP,initialize 必须应答 serverInfo.name=relay-mcp;
//   3) REPO 参数无效(无 .git)时必须 exit 2 并给明确报错——绝不能静默带病启动;
//   4) 更新自检用 RELAY_AUTOUPDATE_BUDGET_MS=1 强制快速失败,冒烟期间不得真的 git merge。
//
// 说明:包装器把状态写在 <REPO>/.git/relay-autoupdate.json;失败路径会把 lastResult 置为
// fail(10 分钟冷却),不影响任何 harness 的正常启动语义。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(RELAY, 'scripts', 'relay-mcp-autoupdate.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};

// 与引擎同款:外层 node --test 注入的 NODE_TEST_CONTEXT 会污染嵌套进程的退出码语义
const cleanEnv = () => {
  const env = { ...process.env, RELAY_AUTOUPDATE_BUDGET_MS: '1' };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

const probe = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [WRAPPER, ...args], {
    env: { ...cleanEnv(), ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  }) + '\n');
  child.stdin.end();
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 30000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});

try {
  console.log('== 1. 启动器在仓库内 ==');
  {
    const src = existsSync(WRAPPER) ? readFileSync(WRAPPER, 'utf8') : '';
    ok(src.length > 0, 'scripts/relay-mcp-autoupdate.mjs 存在', WRAPPER);
    ok(/ff-only/.test(src), '启动器包含 ff-only 更新逻辑(只快进,不吞本地提交)');
    ok(/RELAY_AUTOUPDATE_BUDGET_MS/.test(src), '自检总时限可用环境变量约束(测试依赖)');
    ok(/import\.meta\.url/.test(src), '缺省仓库路径可从 import.meta.url 自推导');
  }

  console.log('\n== 2. 经包装器启动 MCP(initialize 应答)==');
  {
    const r = await probe([RELAY]);
    let name = '', version = '';
    for (const line of r.out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 1 && m.result?.serverInfo) { name = m.result.serverInfo.name; version = m.result.serverInfo.version; }
      } catch { /* 非 JSON 行(日志在 stderr) */ }
    }
    ok(r.code === 0, '包装器正常退出(stdin 关闭后)', `code=${r.code}`);
    ok(name === 'relay-mcp', 'initialize 应答 serverInfo.name=relay-mcp', `got "${name}"`);
    ok(/^\d+\.\d+\.\d+/.test(version), `应答带语义化版本(实测 ${version || '无'})`);
  }

  console.log('\n== 3. 仓库路径无效 → exit 2 + 明确报错 ==');
  {
    const bogus = mkdtempSync(path.join(tmpdir(), 'relay-au-bogus-'));
    const r = await probe([bogus]);
    ok(r.code === 2, '无 .git 的目录作为 REPO → exit 2', `code=${r.code} err=${r.err.slice(0, 120)}`);
    ok(/仓库路径无效/.test(r.err), '报错写明「仓库路径无效」', r.err.slice(0, 200));
    rmSync(bogus, { recursive: true, force: true });
    const r2 = await probe([path.join(bogus, 'definitely-missing')]);
    ok(r2.code === 2, '不存在的路径同样 exit 2', `code=${r2.code}`);
  }

  console.log('\n== 4. 不带参数 → 自推导仓库路径 ==');
  {
    const r = await probe([]);
    ok(r.code === 0 && /relay-mcp/.test(r.out), '无参数时按脚本位置找到仓库并启动 MCP', r.err.slice(0, 150));
  }
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e && e.stack ? e.stack : e}`);
}
console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
