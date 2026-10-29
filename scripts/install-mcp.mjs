#!/usr/bin/env node
// relay-mcp — 跨平台 MCP 安装/注册器（任意 OS × 任意 MCP harness）
//
// 目标：不绑定某一个 harness。生成标准 mcpServers 描述，或将同一条目写入
// 兼容 JSON 配置，或调用已安装 harness 的 MCP 管理 CLI；DSH 只是内置适配器之一。
//
// 用法：
//   node scripts/install-mcp.mjs                         # 打印标准配置 + 各 harness 命令
//   node scripts/install-mcp.mjs --print-json            # 仅输出 mcpServers JSON（可管道消费）
//   node scripts/install-mcp.mjs --target json --config <path>
//   node scripts/install-mcp.mjs --target claude  [--scope user]
//   node scripts/install-mcp.mjs --target gemini  [--scope user]
//   node scripts/install-mcp.mjs --target codex
//   node scripts/install-mcp.mjs --target dsh     [--dsh-profile desktop]
//   node scripts/install-mcp.mjs --target auto           # 探测本机 harness 并给建议
//
// 零依赖，Node >= 18；Windows / macOS / Linux 通用。
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const IS_WIN = process.platform === 'win32';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ENTRY = join(REPO_ROOT, 'src', 'index.mjs');
const DEFAULT_NAME = 'relay-mcp';
const DSH_PACKAGE_PREFIX = 'dsh-mcp-';
const TOOL_TIMEOUT_MS = 300000;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const log = (msg = '') => console.log(msg);
const logErr = (msg = '') => console.error(msg);

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const HELP = `relay-mcp — 跨平台 MCP 安装/注册器

用法:
  node scripts/install-mcp.mjs [options]

Options:
  --target <t>        print(默认) | print-json | json | claude | gemini | codex | dsh | auto
  --name <name>       MCP server 名称，默认 ${DEFAULT_NAME}（[A-Za-z0-9_-]{1,32}）
  --config <path>     --target json 时要写入/合并的 JSON 文件
  --scope <s>         claude 的 local|user|project；gemini 的 user|project；默认 user
  --dsh-profile <p>   DSH profile，默认 $DSH_PROFILE 或 desktop
  --dsh-home <p>      DSH home，默认 $DSH_HOME 或 ~/.dsh
  --dsh-cli <path>    DSH CLI 覆盖（默认自动探测 dsh / Desktop 安装）
  --dry-run           只打印将执行的动作/写入内容，不落盘、不调用 harness CLI
  --skip-preflight    跳过 MCP server 启动握手（不推荐；默认会真实 initialize/tools/list）
  --help              显示本帮助

示例:
  node scripts/install-mcp.mjs
  node scripts/install-mcp.mjs --target json --config ~/.cursor/mcp.json
  node scripts/install-mcp.mjs --target claude --scope user
  node scripts/install-mcp.mjs --target dsh --dsh-profile desktop
`;

const parseArgs = (argv) => {
  const out = {
    target: 'print', name: DEFAULT_NAME, config: '', scope: 'user',
    dshProfile: process.env.DSH_PROFILE || 'desktop',
    dshHome: process.env.DSH_HOME || join(os.homedir(), '.dsh'),
    dshCli: process.env.DSH_CLI || '',
    dryRun: false, skipPreflight: false, help: false,
  };
  const valueOf = (i, flag) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('-')) die(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--print') out.target = 'print';
    else if (a === '--print-json') out.target = 'print-json';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-preflight') out.skipPreflight = true;
    else if (a === '--target') { out.target = valueOf(i, a); i += 1; }
    else if (a === '--name') { out.name = valueOf(i, a); i += 1; }
    else if (a === '--config') { out.config = valueOf(i, a); i += 1; }
    else if (a === '--scope') { out.scope = valueOf(i, a); i += 1; }
    else if (a === '--dsh-profile') { out.dshProfile = valueOf(i, a); i += 1; }
    else if (a === '--dsh-home') { out.dshHome = resolve(valueOf(i, a)); i += 1; }
    else if (a === '--dsh-cli') { out.dshCli = valueOf(i, a); i += 1; }
    else die(`未知参数: ${a}（--help 查看用法）`);
  }
  return out;
};

// ---------------------------------------------------------------------------
// 基础探测
// ---------------------------------------------------------------------------
const commandPath = (cmd) => {
  const tool = IS_WIN ? 'where' : 'which';
  const r = spawnSync(tool, [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return '';
  return String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
};

const resolveNodeCommand = () => {
  // 正常从 node 启动：process.execPath 就是正确的 node.exe / node 二进制。
  if (!process.versions.electron) return { command: process.execPath, source: '当前 node' };
  const onPath = commandPath('node') || commandPath('node.exe');
  if (onPath) return { command: onPath, source: 'PATH 中的 node' };
  return { command: 'node', source: 'PATH 中的 node（未定位绝对路径，请确认 harness 环境可执行）' };
};

const quoteWin = (value) => {
  const s = String(value);
  if (/[\r\n"]/.test(s)) die(`参数含非法字符: ${JSON.stringify(s)}`);
  return `"${s}"`;
};

const runProgram = (cmd, args, { env = process.env, cwd = undefined, inherit = false } = {}) => {
  const stdio = inherit ? 'inherit' : 'pipe';
  try {
    if (IS_WIN && /\.(cmd|bat)$/i.test(cmd)) {
      const line = [cmd, ...args].map(quoteWin).join(' ');
      return spawnSync(line, { shell: true, encoding: 'utf8', windowsHide: true, env, cwd, stdio });
    }
    return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env, cwd, stdio });
  } catch (e) {
    return { status: 1, stdout: '', stderr: e?.message || String(e) };
  }
};

const findFileBounded = (root, fileName, depth, seen = new Set()) => {
  if (!root || depth < 0 || seen.has(root)) return '';
  seen.add(root);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return join(root, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^(node_modules|\.git|Cache|Code Cache|GPUCache)$/i.test(e.name)) continue;
    const hit = findFileBounded(join(root, e.name), fileName, depth - 1, seen);
    if (hit) return hit;
  }
  return '';
};

const findDshCli = (explicit) => {
  if (explicit && existsSync(explicit)) return explicit;
  const envCli = process.env.DSH_CLI;
  if (envCli && existsSync(envCli)) return envCli;
  const onPath = commandPath('dsh') || commandPath('dsh.cmd');
  if (onPath) return onPath;
  if (process.platform === 'darwin') {
    const app = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
    if (existsSync(app)) return app;
    const userApp = join(os.homedir(), 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
    if (existsSync(userApp)) return userApp;
  }
  if (IS_WIN) {
    const roots = [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DeepSeek Harness') : '',
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'DeepSeek Harness') : '',
    ].filter(Boolean);
    for (const root of roots) {
      const hit = findFileBounded(root, 'dsh.cmd', 8);
      if (hit) return hit;
    }
  }
  return '';
};

// ---------------------------------------------------------------------------
// MCP server 预检：真实启动并 initialize / tools/list
// ---------------------------------------------------------------------------
const preflight = (nodeCommand) => new Promise((done) => {
  let child;
  try {
    child = spawn(nodeCommand, [ENTRY], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    done({ ok: false, error: e?.message || String(e) });
    return;
  }
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  let nextId = 1;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (e) { rej(e); }
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error(`超时: ${method}`)); }
    }, 12000).unref();
  });
  const finish = (result) => {
    pending.clear();
    try { child.kill(); } catch { /* 已退出 */ }
    done(result);
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
  child.on('exit', (code) => {
    if (pending.size) finish({ ok: false, error: `server 提前退出(code=${code})${stderr ? `: ${stderr.slice(0, 500)}` : ''}` });
  });
  (async () => {
    try {
      const init = await call('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-install-mcp', version: '1' },
      });
      const tools = await call('tools/list');
      const names = (tools.result?.tools || []).map((t) => t.name);
      finish({
        ok: true,
        serverName: init.result?.serverInfo?.name || '(unknown)',
        version: init.result?.serverInfo?.version || '',
        tools: names,
      });
    } catch (e) {
      finish({ ok: false, error: e?.message || String(e) });
    }
  })();
});

// ---------------------------------------------------------------------------
// 各目标
// ---------------------------------------------------------------------------
const validateName = (name) => {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) die(`--name 必须匹配 [A-Za-z0-9_-]{1,32}，收到: ${name}`);
  return name;
};

const descriptorFor = (name, command) => ({ command, args: [ENTRY] });

const serverJson = (name, command) => ({ mcpServers: { [name]: descriptorFor(name, command) } });

const displayCommand = (name, command) => {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return `claude mcp add --scope user ${name} -- ${q(command)} ${q(ENTRY)}`;
};

const printTarget = (name, nodeCmd) => {
  log('relay-mcp — MCP 安装信息');
  log('');
  log(`repo:    ${REPO_ROOT}`);
  log(`entry:   ${ENTRY}`);
  log(`node:    ${nodeCmd}`);
  log(`name:    ${name}`);
  log('');
  log('## 通用 mcpServers JSON（Cursor / Claude Desktop / VS Code / 兼容 harness）');
  log(JSON.stringify(serverJson(name, nodeCmd), null, 2));
  log('');
  log('## Claude Code');
  log(`claude mcp add --scope user ${name} -- "${nodeCmd}" "${ENTRY}"`);
  log('');
  log('## Gemini CLI');
  log(`gemini mcp add --scope user ${name} "${nodeCmd}" "${ENTRY}"`);
  log('');
  log('## Codex CLI');
  log(`codex mcp add ${name} -- "${nodeCmd}" "${ENTRY}"`);
  log('');
  log('## DSH');
  log(`node scripts/install-mcp.mjs --target dsh --dsh-profile ${process.env.DSH_PROFILE || 'desktop'}`);
  log('');
  log('提示：relay 工具都接受 root 参数；若 harness 不支持 cwd，请在调用时显式传目标项目路径。');
};

const jsonTarget = (opts, name, nodeCmd) => {
  if (!opts.config) die('--target json 需要 --config <path>');
  const configPath = resolve(opts.config);
  let data = {};
  if (existsSync(configPath)) {
    try { data = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
      die(`无法解析 ${configPath}: ${e.message}（为避免破坏配置，未写入）`);
    }
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) die(`${configPath} 顶层必须是 JSON 对象`);
  data.mcpServers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
    ? data.mcpServers : {};
  data.mcpServers[name] = descriptorFor(name, nodeCmd);
  const output = `${JSON.stringify(data, null, 2)}\n`;
  if (opts.dryRun) {
    log(`[dry-run] 将写入 ${configPath}:`);
    log(output);
    return;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, output, 'utf8');
    renameSync(tmp, configPath);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    die(`写入 ${configPath} 失败: ${e.message}`);
  }
  log(`✓ 已写入 ${configPath}（mcpServers.${name}）`);
};

const cliTarget = (target, opts, name, nodeCmd) => {
  const specs = {
    claude: {
      bin: 'claude',
      scopes: ['local', 'user', 'project'],
      remove: (n, scope) => ['mcp', 'remove', n, '--scope', scope],
      add: (n, scope) => ['mcp', 'add', '--scope', scope, n, '--', nodeCmd, ENTRY],
      hint: 'npm i -g @anthropic-ai/claude-code（或安装 Claude Code 后重试）',
    },
    gemini: {
      bin: 'gemini',
      scopes: ['user', 'project'],
      remove: (n, scope) => ['mcp', 'remove', n, '--scope', scope],
      add: (n, scope) => ['mcp', 'add', '--scope', scope, n, nodeCmd, ENTRY],
      hint: 'npm i -g @google/gemini-cli（或安装 Gemini CLI 后重试）',
    },
    codex: {
      bin: 'codex',
      scopes: null,
      remove: (n) => ['mcp', 'remove', n],
      add: (n) => ['mcp', 'add', n, '--', nodeCmd, ENTRY],
      hint: '安装 Codex CLI 后重试；或使用 --print-json 手动写入其配置',
    },
  };
  const spec = specs[target];
  if (spec.scopes && !spec.scopes.includes(opts.scope)) {
    die(`--target ${target} 的 --scope 只支持 ${spec.scopes.join('/')}，收到: ${opts.scope}`);
  }
  const bin = commandPath(spec.bin + (IS_WIN ? '.cmd' : '')) || commandPath(spec.bin);
  if (!bin) {
    if (opts.dryRun) {
      log(`[dry-run] 未找到 ${spec.bin}；安装后执行：`);
      log(`${spec.bin} ${spec.add(name, opts.scope).join(' ')}`);
      return;
    }
    die(`未找到 ${spec.bin} CLI。${spec.hint}，或改用 --print / --print-json。`);
  }
  const removeArgs = spec.remove(name, opts.scope);
  const addArgs = spec.add(name, opts.scope);
  if (opts.dryRun) {
    log(`[dry-run] ${bin} ${removeArgs.join(' ')}   # 忽略失败，用于覆盖同名条目`);
    log(`[dry-run] ${bin} ${addArgs.join(' ')}`);
    return;
  }
  runProgram(bin, removeArgs); // 同名已存在时先删；失败可忽略
  const added = runProgram(bin, addArgs, { inherit: true });
  if (added.status !== 0) die(`${spec.bin} mcp add 失败；可改用 --print 获取手动配置。`);
  log(`✓ 已通过 ${spec.bin} 注册 MCP server: ${name}`);
  log(`  重启 ${spec.bin} 后可用 mcp__${name}__* 工具。`);
};

const findDshBundleName = (name) => `${DSH_PACKAGE_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '-')}`;
const yamlSingle = (s) => `'${String(s).replace(/'/g, "''")}'`;

const dshTarget = (opts, name, nodeCmd) => {
  const profile = opts.dshProfile;
  const dshHome = resolve(opts.dshHome);
  const bundleName = findDshBundleName(name);
  const bundleDir = join(dshHome, 'profiles', profile, 'plugins', bundleName);
  const packageJson = `${JSON.stringify({
    name: bundleName,
    version: '1.0.0',
    private: true,
    description: `relay-mcp (${name}) as a DSH MCP server bundle`,
    type: 'module',
    files: ['cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`;
  const nodeFwd = nodeCmd.replace(/\\/g, '/');
  const entryFwd = ENTRY.replace(/\\/g, '/');
  const cwdFwd = REPO_ROOT.replace(/\\/g, '/');
  const patchYml = [
    '# relay-mcp: relay protocol engine MCP tools over stdio.',
    '- insert:',
    '    - id: relay-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${yamlSingle(name)}`,
    '        transport: stdio',
    `        command: ${yamlSingle(nodeFwd)}`,
    '        args:',
    `          - ${yamlSingle(entryFwd)}`,
    `        cwd: ${yamlSingle(cwdFwd)}`,
    `        toolCallTimeoutMs: ${TOOL_TIMEOUT_MS}`,
    '        failOnStartupError: false',
    '',
  ].join('\n');

  const writeBundle = () => {
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'package.json'), packageJson, 'utf8');
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), patchYml, 'utf8');
  };

  const cli = findDshCli(opts.dshCli);
  const env = { ...process.env, DSH_HOME: dshHome };
  if (opts.dryRun) {
    log(`[dry-run] bundle: ${bundleDir}`);
    log(`${packageJson.trim()}`);
    log(patchYml);
    if (!cli) {
      log('[dry-run] 未找到 dsh CLI；安装 DSH CLI 后执行：');
      log(`dsh plugin --profile ${profile} add "${bundleDir}"`);
    } else {
      log(`[dry-run] DSH_CLI=${cli}`);
      log(`[dry-run] ${cli} plugin --profile ${profile} remove ${bundleName}   # 忽略失败`);
      log(`[dry-run] ${cli} plugin --profile ${profile} add "${bundleDir}"`);
    }
    return;
  }
  writeBundle();
  log(`✓ 已生成 DSH bundle: ${bundleDir}`);
  if (!cli) {
    die(`已生成 bundle，但未找到 dsh CLI。请手动执行: dsh plugin --profile ${profile} add "${bundleDir}"`);
  }
  // 迁移/去重：同 profile 下若还有另一个 dsh-mcp-* bundle 配置了相同 serverName，
  // 先移除它，避免 DSH 启动时 duplicate serverName 失败（例如旧版 dsh-mcp-relay）。
  const pluginsDir = join(dshHome, 'profiles', profile, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(DSH_PACKAGE_PREFIX)) continue;
      const oldDir = join(pluginsDir, entry.name);
      if (oldDir === bundleDir) continue;
      let patch = '';
      try { patch = readFileSync(join(oldDir, 'cordis.patch.yml'), 'utf8'); } catch { continue; }
      const match = patch.match(/^\s*serverName:\s*(.+)$/m);
      const oldName = match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
      if (oldName !== name) continue;
      log(`· 移除同 serverName 的旧 bundle: ${entry.name}`);
      const removed = runProgram(cli, ['plugin', '--profile', profile, 'remove', entry.name], { env });
      if (removed.status === 0) {
        try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* 目录残留不阻断 */ }
      } else {
        logErr(`⚠ 旧 bundle ${entry.name} 移除失败，请手动执行: dsh plugin --profile ${profile} remove ${entry.name}`);
      }
    }
  }
  runProgram(cli, ['plugin', '--profile', profile, 'remove', bundleName], { env });
  let added = runProgram(cli, ['plugin', '--profile', profile, 'add', bundleDir], { env, inherit: true });
  if (added.status !== 0 && IS_WIN) {
    // Windows 下本地目录依赖可能因 symlink 权限失败：退化为 tgz 安装。
    log('本地目录安装失败，尝试 tgz 回退…');
    const npm = commandPath('npm.cmd') || commandPath('npm');
    if (npm) {
      runProgram(npm, ['pack', '--silent'], { env, cwd: bundleDir, inherit: true });
      const tgz = readdirSync(bundleDir).filter((f) => f.endsWith('.tgz')).sort().pop();
      if (tgz) {
        added = runProgram(cli, ['plugin', '--profile', profile, 'add', join(bundleDir, tgz)], { env, inherit: true });
      }
    }
  }
  if (added.status !== 0) die(`dsh plugin add 失败；可手动执行: dsh plugin --profile ${profile} add "${bundleDir}"`);
  log(`✓ 已注册到 DSH profile: ${profile}`);
  log(`  重启 DSH 后新会话可用 mcp__${name}__* 工具（共 10 个 relay_* 工具）。`);
  log(`  验证: 在 DSH 中调用 mcp__${name}__relay_rules {}`);
};

const autoTarget = (nodeCmd) => {
  log('探测本机 MCP harness：');
  for (const bin of ['claude', 'gemini', 'codex']) {
    const hit = commandPath(bin + (IS_WIN ? '.cmd' : '')) || commandPath(bin);
    log(`  ${bin.padEnd(8)} ${hit || '(未安装)'}`);
  }
  const dsh = findDshCli('');
  log(`  dsh      ${dsh || '(未安装 / 未探测到)'}`);
  log('');
  log('建议命令（只打印，不修改任何配置）：');
  log('  node scripts/install-mcp.mjs --target claude --scope user');
  log('  node scripts/install-mcp.mjs --target gemini --scope user');
  log('  node scripts/install-mcp.mjs --target json --config <harness 的 mcpServers JSON>');
  log('  node scripts/install-mcp.mjs --target dsh --dsh-profile desktop');
  log('  或者 node scripts/install-mcp.mjs --print-json 交给任意 harness 手动接入。');
  log('');
  log(`server 描述（可直接粘贴到支持 mcpServers 的 harness）：`);
  log(JSON.stringify(serverJson(DEFAULT_NAME, nodeCmd), null, 2));
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { log(HELP); return; }
  const name = validateName(opts.name);
  if (!existsSync(ENTRY)) die(`找不到 server 入口: ${ENTRY}（请在 relay-mcp 仓库内运行本脚本）`);

  const { command: nodeCmd, source } = resolveNodeCommand();
  if (source !== '当前 node') logErr(`· node: ${nodeCmd}（${source}）`);

  if (!opts.skipPreflight) {
    const result = await preflight(nodeCmd);
    if (!result.ok) die(`MCP server 预检失败: ${result.error}\n  可先手动验证: "${nodeCmd}" "${ENTRY}"`);
    const hasAll = result.tools.includes('relay_rules') && result.tools.includes('relay_session_end');
    if (!hasAll) die(`预检通过但工具列表异常: ${result.tools.join(', ')}`);
    logErr(`· 预检通过: ${result.serverName}@${result.version || '?'}，${result.tools.length} 个工具`);
  } else {
    logErr('· 已跳过预检（--skip-preflight）');
  }

  switch (opts.target) {
    case 'print': printTarget(name, nodeCmd); break;
    case 'print-json': log(JSON.stringify(serverJson(name, nodeCmd), null, 2)); break;
    case 'json': jsonTarget(opts, name, nodeCmd); break;
    case 'claude':
    case 'gemini':
    case 'codex': cliTarget(opts.target, opts, name, nodeCmd); break;
    case 'dsh': dshTarget(opts, name, nodeCmd); break;
    case 'auto': autoTarget(nodeCmd); break;
    default: die(`未知 --target: ${opts.target}（print|print-json|json|claude|gemini|codex|dsh|auto）`);
  }
};

main().catch((e) => die(e?.stack || e?.message || String(e)));
