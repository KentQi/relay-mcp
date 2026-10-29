#!/usr/bin/env node
// 跨平台 MCP 安装器冒烟：只验证纯本地契约（print/json/dsh dry-run/auto/参数校验），
// 不写入任何真实 harness 配置，也不依赖 Claude/Gemini/Codex/DSH 是否安装。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-mcp.mjs');

let pass = 0;
let fail = 0;
const ok = (condition, label, extra = '') => {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ` — ${String(extra).slice(0, 800)}` : ''}`); }
};
const run = (args) => spawnSync(process.execPath, [INSTALLER, ...args], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000,
});
const tmpDirs = [];

try {
  console.log('\n== I1: 标准 mcpServers 描述 ==');
  {
    const r = run(['--print-json', '--skip-preflight']);
    ok(r.status === 0, 'I1: --print-json 退出码 0', r.stderr);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 下面断言会失败 */ }
    const entry = parsed?.mcpServers?.['relay-mcp'];
    ok(!!entry && typeof entry.command === 'string' && entry.command.length > 0,
      'I1: 输出含 relay-mcp.command', r.stdout.slice(0, 300));
    ok(Array.isArray(entry?.args) && entry.args.length === 1
      && path.resolve(entry.args[0]) === path.join(ROOT, 'src', 'index.mjs'),
    'I1: args 指向本仓库 src/index.mjs', JSON.stringify(entry?.args));
  }

  console.log('\n== I2: 启动握手预检（真实 initialize + tools/list）==');
  {
    const r = run(['--print-json']);
    ok(r.status === 0, 'I2: 预检模式退出码 0', r.stderr);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 断言失败 */ }
    ok(!!parsed?.mcpServers?.['relay-mcp'], 'I2: stdout 仍是纯 JSON（可管道消费）', r.stdout.slice(0, 200));
    ok(/预检通过/.test(r.stderr), 'I2: stderr 报告预检通过', r.stderr.slice(0, 300));
  }

  console.log('\n== I3: --target json 合并写入 ==');
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-install-json-'));
    tmpDirs.push(dir);
    const cfg = path.join(dir, 'nested', 'mcp.json');
    const r = run(['--target', 'json', '--config', cfg, '--skip-preflight']);
    ok(r.status === 0 && existsSync(cfg), 'I3: 配置文件已创建', r.stderr);
    const data = JSON.parse(readFileSync(cfg, 'utf8'));
    ok(Array.isArray(data?.mcpServers?.['relay-mcp']?.args), 'I3: mcpServers.relay-mcp 已写入');
    // 二次写入保留其他条目
    const merged = JSON.parse(readFileSync(cfg, 'utf8'));
    merged.mcpServers.other = { command: 'x' };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfg, JSON.stringify(merged));
    const r2 = run(['--target', 'json', '--config', cfg, '--skip-preflight']);
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    ok(r2.status === 0 && after.mcpServers.other?.command === 'x' && !!after.mcpServers['relay-mcp'],
      'I3: 写入不覆盖其它 mcpServers 条目');
  }

  console.log('\n== I4: --target dsh --dry-run 不落盘 ==');
  {
    const home = mkdtempSync(path.join(tmpdir(), 'relay-install-dsh-'));
    tmpDirs.push(home);
    const r = run(['--target', 'dsh', '--dsh-home', home, '--dsh-profile', 'test', '--skip-preflight', '--dry-run']);
    ok(r.status === 0, 'I4: dsh dry-run 退出码 0', r.stderr);
    ok(r.stdout.includes('cordis.patch.yml') && r.stdout.includes("serverName: 'relay-mcp'"),
      'I4: 输出 DSH bundle 配置', r.stdout.slice(0, 400));
    ok(!existsSync(path.join(home, 'profiles')), 'I4: dry-run 未创建 profile 目录');
  }

  console.log('\n== I5: --target auto 与参数校验 ==');
  {
    const r = run(['--target', 'auto', '--skip-preflight']);
    ok(r.status === 0 && r.stdout.includes('relay-mcp') && r.stdout.includes('mcpServers'),
      'I5: auto 输出探测结果与通用描述');
    const bad = run(['--name', 'bad name', '--skip-preflight']);
    ok(bad.status !== 0 && /--name/.test(bad.stderr), 'I5: 非法 server 名称被拒', bad.stderr);
    const unknown = run(['--target', 'nope', '--skip-preflight']);
    ok(unknown.status !== 0 && /未知 --target/.test(unknown.stderr), 'I5: 未知 target 被拒', unknown.stderr);
  }
} finally {
  for (const dir of tmpDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`\n========== 安装器冒烟结果: ${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail ? 1 : 0);
}
