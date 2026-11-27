#!/usr/bin/env node
// T066 验收:14 个 harness 注册面的 relay MCP 条目必须全部指向仓库内启动器,
// 且不再有指向 ~/.relay-mcp/ 旧启动器的残留。
//
// 注意:本套件是**本机验收**,不接入 npm test——它检查的是这台机器上的
// harness 配置文件(home 路径),CI 环境下必然失败。仅在 relay-mcp 所在
// 机器上由 session_end 绿闸或人工执行。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW = path.join(REPO, 'scripts', 'relay-mcp-autoupdate.mjs');
const OLD = path.join(H, '.relay-mcp/relay-mcp-autoupdate.mjs');

// label, path, kind(json=额外校验合法 JSON)
const targets = [
  ['claude-code', `${H}/.claude.json`, 'json'],
  ['claude-desktop', `${H}/Library/Application Support/Claude/claude_desktop_config.json`, 'json'],
  ['claude-3p', `${H}/Library/Application Support/Claude-3p/claude_desktop_config.json`, 'json'],
  ['codex', `${H}/.codex/config.toml`, 'text'],
  ['gemini', `${H}/.gemini/settings.json`, 'json'],
  ['zcode', `${H}/.zcode/cli/config.json`, 'json'],
  ['minimax-main', `${H}/.minimax/mcp.json`, 'json'],
  ['minimax-mcp', `${H}/.minimax/mcp/mcp.json`, 'json'],
  ['kimi', `${H}/.kimi/mcp.json`, 'json'],
  ['kimi-code', `${H}/.kimi-code/mcp.json`, 'json'],
  ['mavis', `${H}/.mavis/mcp.json`, 'json'],
  ['vscode', `${H}/Library/Application Support/Code/User/mcp.json`, 'json'],
  ['dsh-desktop', `${H}/.dsh/profiles/desktop/plugins/dsh-mcp-relay-mcp/cordis.patch.yml`, 'text'],
  ['dsh-web', `${H}/.dsh/profiles/web/plugins/dsh-mcp-relay-mcp/cordis.patch.yml`, 'text'],
];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`); }
};

console.log('== 14 个 harness 注册面:relay 条目指向仓库内启动器 ==');
for (const [label, p] of targets) {
  if (!existsSync(p)) { ok(false, `${label}: 配置文件不存在`, p); continue; }
  const t = readFileSync(p, 'utf8');
  ok(t.includes(NEW), `${label}: 指向 scripts/relay-mcp-autoupdate.mjs`, p);
  ok(!t.includes(OLD), `${label}: 无旧路径残留`, p);
}

console.log('\n== JSON 配置仍合法(替换未破坏结构)==');
for (const [label, p] of targets.filter(([, , kind]) => kind === 'json')) {
  try { JSON.parse(readFileSync(p, 'utf8')); ok(true, `${label}: JSON 合法`); }
  catch (e) { ok(false, `${label}: JSON 解析失败`, String(e.message).slice(0, 120)); }
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
