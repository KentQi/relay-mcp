#!/usr/bin/env node
// relay-mcp — src/cli.mjs (W2)
// `node cli.mjs <tool> [--root path] [--json '{...}' | --json k=v k=v ...]`
// 复用 contract.mjs 的 dispatch,人类可读输出;isError → exit code 1。
// verify.sh 与 CI(workflow-relay.yml)通过本文件调用 relay_verify。
import { dispatch } from './contract.mjs';

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
  退出码: 0 = 成功;1 = 工具返回 isError;2 = 命令行用法错误`;

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

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('-')) {
  failUsage(`缺少工具名。第一个参数必须是工具名,例如 relay_verify。`);
}
const tool = argv[0];

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
        jsonArgs[part.slice(0, eq)] = parseValue(part.slice(eq + 1));
      }
    }
  } else {
    failUsage(`无法识别的参数: ${a}`);
  }
}

if (rootFlag !== undefined) jsonArgs.root = rootFlag; // 显式 --root 优先

try {
  const result = await dispatch(tool, jsonArgs);
  const items = Array.isArray(result && result.content) ? result.content : [];
  for (const item of items) {
    if (item && item.type === 'text') process.stdout.write(`${item.text}\n`);
  }
  process.exit(result && result.isError ? 1 : 0);
} catch (err) {
  process.stderr.write(`cli 内部错误: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
}
