#!/usr/bin/env node
// relay-mcp — src/cli.mjs (W2)
// `node src/cli.mjs <tool> [--root path] [--json '{...}' | --json k=v k=v ...]`
// 复用 contract.mjs 的 dispatch,人类可读输出;isError → exit code 1。
// verify.sh 与 CI(workflow-relay.yml)通过本文件调用 relay_verify。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, TOOLS } from './contract.mjs';

const PKG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

const USAGE = `relay-mcp CLI — relay protocol tools from the shell

用法:
  node src/cli.mjs <tool> [--root <path>] [--json '<JSON 对象>' | --json k=v k=v ...]

示例:
  node src/cli.mjs relay_verify --root /path/to/repo
  node src/cli.mjs relay_verify --json '{"root":"/path/to/repo","full":true}'
  node src/cli.mjs relay_claim --root . --json task=T003 model=claude

说明:
  --root  等价于 --json 里的 root,缺省为当前目录(显式 --root 优先)
  --json  值若以 { 开头按整段 JSON 解析;否则按 k=v 对解析(v 会尝试 JSON 解析,
          失败则按字符串),布尔/数字自动识别
  -h, --help     显示本帮助
  -v, --version  显示版本
  退出码: 0 = 成功(recall 无命中=0);1 = 工具 isError(archive 无 LOG=1、get 全未找到=1);
          2 = 命令行用法错误(未知参数/键、schema 类型不匹配)`;

const failUsage = (msg) => {
  process.stderr.write(`${msg}\n\n${USAGE}\n`);
  process.exit(2);
};

const parseValue = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const schemaTypeOf = (value) => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
};

const validateValue = (key, value, schema, label) => {
  if (!schema || !schema.type) return;
  const actual = schemaTypeOf(value);
  if (actual !== schema.type) {
    failUsage(`${label} \`${key}\` 需要 ${schema.type},收到 ${actual}。数组/对象参数请用整段 JSON,例如 --json '{"${key}":...}'。`);
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => validateValue(`${key}[${i}]`, item, schema.items, label));
  }
};

const argv = process.argv.slice(2);
if (argv[0] === '-h' || argv[0] === '--help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (argv[0] === '-v' || argv[0] === '--version') {
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version || 'unknown'; } catch { /* 打包损坏时仍可输出版本占位 */ }
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
if (argv.length === 0 || argv[0].startsWith('-')) {
  failUsage(`缺少工具名。第一个参数必须是工具名,例如 relay_verify。`);
}
const tool = argv[0];
const toolSchema = TOOLS.find((t) => t.name === tool)?.inputSchema;

let rootFlag;
let jsonArgs = {};

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') {
    const v = argv[++i];
    if (v === undefined) failUsage('--root 需要一个路径参数');
    rootFlag = v;
  } else if (a === '--json') {
    const parts = [];
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) parts.push(argv[j]);
    if (parts.length === 0) failUsage('--json 需要参数:JSON 对象或 k=v 对');
    i += parts.length;
    const joined = parts.join(' ').trim();
    if (joined.startsWith('{')) {
      try {
        const parsed = JSON.parse(joined);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          failUsage('--json 的 JSON 参数必须是对象');
        }
        jsonArgs = { ...jsonArgs, ...parsed };
      } catch (e) {
        failUsage(`--json JSON 解析失败: ${e.message}`);
      }
    } else {
      for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0) failUsage(`--json 键值对格式应为 k=v,收到: ${part}`);
        const key = part.slice(0, eq);
        const value = parseValue(part.slice(eq + 1));
        const schema = toolSchema?.properties?.[key];
        if (schema?.type === 'array' && !Array.isArray(value)) {
          const items = String(value).split(',').map((v) => parseValue(v.trim()));
          jsonArgs[key] = [...(Array.isArray(jsonArgs[key]) ? jsonArgs[key] : []), ...items];
        } else if (schema?.type === 'array' && Array.isArray(value)) {
          jsonArgs[key] = [...(Array.isArray(jsonArgs[key]) ? jsonArgs[key] : []), ...value];
        } else {
          jsonArgs[key] = value;
        }
      }
    }
  } else {
    failUsage(`无法识别的参数: ${a}`);
  }
}

if (rootFlag !== undefined) jsonArgs.root = rootFlag; // 显式 --root 优先

// MCP 由 inputSchema 校验;CLI 必须同样拒绝未知键/错误类型,不能静默丢弃。
// 例外:root 对所有工具通用(dispatch 统一消费),即使工具 schema 未声明也必须允许。
const UNIVERSAL_KEYS = new Set(['root']);
if (toolSchema) {
  for (const [key, value] of Object.entries(jsonArgs)) {
    if (UNIVERSAL_KEYS.has(key)) continue;
    if (!toolSchema.properties || Object.keys(toolSchema.properties).length === 0) continue; // 无参工具不拒收
    const schema = toolSchema.properties[key];
    if (!schema) {
      failUsage(`未知参数 \`${key}\`。${tool} 可用参数: ${Object.keys(toolSchema.properties).join(', ')}`);
    }
    validateValue(key, value, schema, tool);
  }
}

try {
  const result = await dispatch(tool, jsonArgs);
  const items = Array.isArray(result && result.content) ? result.content : [];
  for (const item of items) {
    if (item && item.type === 'text') process.stdout.write(`${item.text}\n`);
  }
  // 不用 process.exit():管道/重定向下异步 stdout 可能尚未排空,>64KB 输出会被截断。
  process.exitCode = result && result.isError ? 1 : 0;
} catch (err) {
  process.stderr.write(`cli 内部错误: ${err?.message || String(err)}\n`);
  process.exitCode = 1;
}
