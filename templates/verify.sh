#!/bin/sh
# relay verify — 单一真相在 relay-mcp 引擎,本脚本只是委托。
# 换机 / 团队成员克隆后失效时:export RELAY_HOME=/path/to/relay-mcp(优先),否则用下方固化路径。
ROOT="$(cd "$(dirname "$0")" && pwd)"
RELAY_HOME="${RELAY_HOME:-__RELAY_HOME__}"
if [ ! -f "$RELAY_HOME/src/cli.mjs" ]; then
  echo "verify: 找不到 relay 引擎:$RELAY_HOME/src/cli.mjs" >&2
  echo "修复:安装 relay-mcp 后 export RELAY_HOME=<relay-mcp 绝对路径>,再重跑 ./verify" >&2
  exit 2
fi
exec node "$RELAY_HOME/src/cli.mjs" relay_verify --root "$ROOT"
