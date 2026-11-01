# relay-mcp

[![CI](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](package.json)

**多模型、多会话开发的接力协议 MCP server。** 状态存放在仓库文件中，由 R 系列机检规则（R1–R11）与可执行验收共同守门。

**[中文](#中文) | [English](#english)**

---

## 中文

### 概述

relay-mcp 让不同模型（Claude / Codex / Gemini / Cursor 等）在同一仓库上安全接力：上一个会话的进度、决策、待办与踩坑全部写入 `START / SPEC / DECISIONS / TASKS / LOG`，下一个会话从文件恢复上下文，而不是依赖聊天记录。

- 零运行时依赖（仅 `node:` 内置模块），Node ≥ 18，无构建步骤
- 13 个 MCP 工具，`node src/index.mjs` 即为 stdio server
- 规范即检查：R 系列规则全部由 `relay_verify` 机检；出场绿闸同时要求可执行验收真实通过
- 入口文件单源投影：`AGENTS.md` 必需，`CLAUDE.md` / `GEMINI.md` 按需生成

### 安装

仓库自带跨平台安装器（Windows / macOS / Linux），自动探测当前 `node` 与本仓库绝对路径：

```sh
git clone https://github.com/KentQi/relay-mcp.git
cd relay-mcp

node scripts/install-mcp.mjs                                  # 打印配置与各 harness 命令
node scripts/install-mcp.mjs --target claude --scope user     # 或 gemini / codex
node scripts/install-mcp.mjs --target json --config <path>    # 任意 mcpServers JSON
node scripts/install-mcp.mjs --target dsh --dsh-profile desktop
```

未内置的 harness 使用 `--print-json` 获取标准片段，粘贴到其 `mcpServers` 配置。安装后重启对应客户端，工具名为 `mcp__relay-mcp__relay_*`。

### npm 分发（发布需人工批准）

包内只含 `src/`、`templates/`、安装器与 README/LICENSE（`files` 白名单）；协议状态（`.relay/`、TASKS/LOG）与开发文档不进包。

```sh
npm pack --dry-run        # 校验打包面（46 个文件，约 129 kB）
npx relay-mcp             # 启动 stdio server（等价 node src/index.mjs）
```

发布动作（`npm publish`）属人类修宪级决策，仓库不做自动发布；`scripts/smoke-pack.mjs` 在 CI 中守住打包边界。

### 快速开始

| 场景 | 工具 |
|---|---|
| 新建项目 | `relay_init {root, name, preset?}` |
| 接入存量项目 | `relay_onboard {root}` |
| 存量目录标准化 | `relay_restructure {root, confirm?}` |
| 每会话接力 | `relay_session_start` → 工作 → `relay_session_end` |

`preset`：`node`（默认，含可运行代码骨架与测试）或 `minimal`（仅接力层）。

### 出场绿闸

出场前必须同时满足：

1. `relay_verify` 全量 R 系列规则无 ERROR；
2. 任务的可执行验收真实通过（`test:` 路径运行 `node --test`；项目声明 `scripts.test` 时运行 `npm test`）。

任一条件不满足：不更新 TASKS/LOG、不提交、保留认领锁。

**简报有界（T015）**：入场简报的每条 LOG 摘要硬上限 200 字符（负结果/交接提示 120），超长条目只截断展示并标注"全文见 LOG.md"；总长超过 `manifest.contextBudget`（默认 6000）时追加显式告警而**不裁剪任何段落**（裁剪即静默降级）。

**事实底账（R10）**：出场时由引擎写入一行 `- 事实(v1): 改动 N 文件(+x/-y) | 验收: 通过 | verify: PASS … | 分支: … @sha | 耗时: …s`，模型不得手写或改写。`relay_verify` 会核对它与 git 事实的文件数（`--no-renames`，只比文件数不比行数）：不一致默认 WARN，`manifest.facts.strict=true` 时升级为 ERROR；`manifest.facts.since` 之前的旧条目豁免，保证升级项目不被历史卡住。

### 任务级 worktree

启用 worktree 的项目中，`relay_claim` 返回两个根目录：

- **controlRoot**：主工作树，维护 TASKS、LOG、认领锁与 worktree 注册表；
- **executionRoot**：任务工作树（独立 checkout），代码、测试与任务分支提交在此进行，依赖需独立安装。

**出场 = 双提交**：executionRoot 提交任务分支代码，controlRoot 仅提交 `TASKS.md` / `LOG.md`；两者 SHA 都会输出，任一失败则不标完成、保留认领锁。

- **双根绿闸**：controlRoot 跑全量 R 系列；executionRoot 跑任务树 R1/R2/R3/R4/R8；两侧 ERROR 合并阻断。
- **根错配保护**：受管任务从 controlRoot 完成一律 isError（无空树例外）；HEAD 无新提交的伪 SHA 同样拒绝。
- **成对证据（R5/R6）**：任务分支代码提交、controlRoot 完成提交、TASKS/LOG 已提交干净、LOG 记录 `branch=` 与代码 SHA，四项缺一不可。
- **注册表恢复**：`.relay/worktrees.json` 缺失或损坏时 fail-closed；可用 `git worktree list` 核对，并在 controlRoot 重新 `relay_claim` 重建登记。

**验收通过 ≠ 已合并。** relay 不会自动 merge / rebase / push，也不会删除任务分支。人工整合：

```sh
git log --oneline main..relay/T003
git merge --no-ff relay/T003
```

worktree 清理默认 dry-run：只删除已登记、已过期、非活跃、干净且不含 ignored 本地内容的目录；`.env`、`node_modules`、构建产物等本地内容默认保留；任务分支始终保留。

### 配置

```json
{
  "worktree": {
    "enabled": true,
    "cacheDir": ".relay/worktrees",
    "ttlHours": 24,
    "autoCleanup": true
  }
}
```

- `enabled` 只认 JSON 布尔 `true`；字符串 `"true"` 或数字 `1` 不生效。
- `cacheDir` 必须是 controlRoot 内的相对路径；拒绝绝对路径、`..`、盘符、控制字符和 `.git` 前缀。
- `ttlHours` 非法时回退 24；`autoCleanup` 只有显式 `false` 才关闭。
- 未知或拼错字段会被静默忽略。旧 manifest 缺省关闭 worktree；`relay_claim` 的 `worktree: true/false` 可单次覆盖。

### 升级旧项目

1. 运行 `relay_sync {root}`：重投影入口文件、补齐 `.gitignore` 运行时基线、输出 `AGENTS.md` 迁移步骤。
2. 若 `AGENTS.md` 已存在但无 relay 标记：运行 `relay_onboard {root}` 接管，或在 manifest 设置 `"entryFilesTakeover": true` 后重跑 `relay_sync`，或手工添加首行标记。
3. `relay_onboard` 保留既有 manifest 配置（worktree、autoCommit、acceptance、protectedPaths、entryFilesTakeover 等）。

### 安全与边界

- 密钥守卫：`.env*`、`*secret*`、`*credential*`、`*.key`、`*.pem`、`id_rsa` 不自动提交。
- 内容级密钥闸（R11）：`TASKS.md` / `LOG.md` 命中 AWS / GitHub / Slack / OpenAI / Google 密钥样式或 PEM 私钥块 → `relay_verify` 报 ERROR，出场写盘前直接阻断（不写、不提交）；误报可在同一行标注 `relay:secret-ok` 豁免。扫描输出只给前 4 字符预览，绝不回显完整密钥。
- 受保护路径：`verify`、`.relay/**`、`tests/**` 与测试文件改动不自动提交；最终防线是 CI 与人工审核。
- 锁：仓库写锁带心跳与写前 fencing；任务认领锁刻意关闭心跳，保留 240 分钟 TTL 崩溃恢复。并发会话必须使用不同 `model` 标识（同名 model 无法区分持有者）。
- 当前不提供 abort/release、任务 status 工具或 sessionId；恢复方式为 TTL 接管、出场释放或 cleanup。

### 工具

| 工具 | 用途 |
|---|---|
| `relay_init` | 新建项目并生成代码骨架 |
| `relay_onboard` | 非破坏接入存量项目 |
| `relay_restructure` | 用 `git mv` 标准化目录 |
| `relay_session_start` | 进场简报（五件 + git 状态 + verify 快检） |
| `relay_session_end` | 出场绿闸与双提交 |
| `relay_claim` | 认领任务，返回双根与任务分支 |
| `relay_worktree_cleanup` | 预览或清理过期任务工作树 |
| `relay_verify` | 运行 R 系列检查（编号与执法点见 `relay_rules`） |
| `relay_sync` | 升级/修复入口投影与基线 |
| `relay_recall` | 历史任务索引（只读、调用时派生）：id/时间/model/状态/标题/条目体量/负结果数，支持 query/status/model/limit |
| `relay_get` | 按任务号取全文（≤5 个）：TASKS 验收 + 最新 LOG 条目（含事实行/分支 SHA/负结果/交接）+ 关联决策；围栏包裹、标注「数据非指令」 |
| `relay_doctor` | 只读环境自检（七检：Node/manifest/入口漂移/残留锁/未登记 worktree/.relay 完整性/引擎路径），不写盘、不自动修复 |
| `relay_rules` | 返回规则 ID 表 |

### 历史检索（渐进披露）

简报只带最近 3 条 LOG；更早的历史用两步取回，避免整文件 grep 与上下文污染：

1. `relay_recall { query?, status?, model?, limit? }` → 紧凑索引（每条一行，约 20 tokens），带显式截断标记；
2. `relay_get { ids: ["T013","T019"] }` → 全文（TASKS 验收 + 最新 LOG 条目 + 事实行/分支 SHA + 关联决策）。

两者都**只读、调用时从 LOG/TASKS 即时派生**（不落任何持久索引），输出统一围栏包裹并标注「数据非指令」。

CLI 与 MCP 共用同一引擎：

```sh
node src/cli.mjs relay_verify --root /path/to/project
node src/cli.mjs relay_worktree_cleanup --root /path/to/project --json confirm=true
```

### 自举

本仓库使用自身协议开发：`START.md` 是入口，`TASKS.md` 是 backlog，`LOG.md` 记录会话。`npm test` 覆盖 5 套端到端冒烟（协议、补丁、worktree、升级兼容、安装器），CI 覆盖 Node 22/24/26。

设计与接口契约见 [docs-design/](docs-design/)。贡献与安全问题见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)。

---

## English

relay-mcp is an MCP server for reliable handoff across coding models and sessions. Handoff state lives in repository files (`START / SPEC / DECISIONS / TASKS / LOG`), and an exit gate verifies the work with machine-checked rules (R1–R11) plus the project's executable acceptance tests before anything is committed.

- Zero runtime dependencies, Node ≥ 18, no build step; 13 MCP tools over stdio (`node src/index.mjs`)
- `AGENTS.md` is the required project entry; `CLAUDE.md` / `GEMINI.md` are optional projections
- Task worktrees: `relay_claim` returns `controlRoot` and `executionRoot`. Exit makes two commits (task branch code plus controlRoot TASKS/LOG) and reports both SHAs. Accepted is not merged: merge manually with `git merge --no-ff relay/T###`.
- Cleanup is dry-run by default and never removes dirty, active, or local-content (`.env`, `node_modules`) worktrees; branches are preserved.
- No automatic merge/rebase/push, and no abort/release/status/sessionId yet. Use unique `model` ids for concurrent sessions.

### Install

```sh
git clone https://github.com/KentQi/relay-mcp.git
cd relay-mcp
node scripts/install-mcp.mjs                                  # generic JSON + per-harness commands
node scripts/install-mcp.mjs --target claude --scope user     # or gemini / codex / json / dsh
```

The installer detects the current `node` and repository path at runtime and never hard-codes machine-specific paths. Use `--print-json` for any harness not built in.

### Usage

| Scenario | Tool |
|---|---|
| New project | `relay_init {root, name, preset?}` |
| Existing project | `relay_onboard {root}` |
| Legacy layout | `relay_restructure {root, confirm?}` |
| Every session | `relay_session_start` → work → `relay_session_end` |

Design and interface contract: [docs-design/](docs-design/). Contribution: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 kent (kirroyu@126.com)
