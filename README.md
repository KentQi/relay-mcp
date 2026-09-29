# relay-mcp — 接力棒 MCP

[![CI](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](package.json)
[![tests](https://img.shields.io/badge/self--hosted-81%20checks%20green-success)](#自举)

**[English](#english) | [中文](#中文)**

---

## 中文

让任意模型(Claude / Codex / Gemini / Cursor / ZCode …)在任意项目上**接力开发**:上一个会话干到哪、为什么这么干、下一个从哪接手——全部写进仓库文件并由机检执法。**交接不靠聊天记录,不靠信任,只靠运行结果。**

- 零依赖纯 Node ESM(仅 `node:` 内置模块),无构建步骤,Node >= 18,入口 `node src/index.mjs`
- 规范即检查:R1-R9 全部由 `relay_verify` 机检;设计推导与接口契约见 [docs-design/](docs-design/)

### 解决什么问题

多模型、多会话协作的三个顽疾:

1. **状态不可见** —— 进度、计划、踩坑散落在聊天记录里,新会话两眼一抹黑
2. **规范会漂移** —— 各项目的 CLAUDE.md 手抄一份,改一条规则要改 N 处,永远改不齐
3. **"完成"无裁判** —— 模型说做完了,人类无法一键验证

relay 的答案:仓库内核心五件(START / SPEC / DECISIONS / TASKS / LOG)+ `verify` 脚本承载全部状态;入口文件(AGENTS / CLAUDE / GEMINI)由引擎**单源投影**生成(CI 零 diff,项目自定义规范装在 AGENTS.md 的用户保留区,重投影不冲掉,R4 时变词检查豁免该区);出场绿闸 = verify 全量通过 **且可执行验收真实跑绿**(`test:` 路径跑 `node --test`;`package.json` 有 `scripts.test` 就跑 `npm test`——后者执行的是**项目自己在 package.json 里声明的命令**,信任边界是项目自身的 package.json)才允许提交;验收行里的自由文本命令一律不解析执行。

### 三场景用法

| 场景 | 工具调用 | 发生什么 |
|---|---|---|
| 0→1 新项目 | `relay_init` `{root, name, preset?}` | 实例化全部模板 + **代码骨架(preset,默认 node:package.json + src/ + tests/ + 全绿的骨架测试)** + git init + 首提交 |
| 1→10 / 10→100 存量项目 | `relay_onboard` `{root}` | 扫描现状 → 非破坏合并(已有文件先备份,永不删除)→ 装核心件 + verify |
| 老项目目录标准化 | `relay_restructure` `{root, confirm?}` | 干跑出迁移方案(lib/ test/ 散文件 → src/ tests/ scripts/,语义不明项留给人工)→ `confirm:true` 以 git mv 执行 + 白名单修宪 + DECISIONS/LOG/TASKS 自动记录 |
| 日常接力(每会话) | `relay_session_start` / `relay_session_end` | 进场简报(五件 + git 对账 + verify 快检)/ 出场绿闸(全绿才更新 TASKS/LOG 并提交) |

preset 可选:`node`(默认,交付即 `npm test` 全绿)/ `minimal`(仅接力层,不建代码骨架);自定义 preset = 在 `templates/presets/` 下放一个目录即可。

辅助工具:`relay_sync`(重投影入口文件,报告漂移;AGENTS.md 的 `user-rules` 保留区原样携带)、`relay_claim`(并行认领,原子锁 `.relay/claims/T###.lock`,TTL 4 小时,到期可接管)、`relay_verify`(随时机检)、`relay_rules`(规则 ID 表)。

安全机制一览:密钥守卫(工作区出现 `.env*`/`*secret*`/`*credential*`/`*.key`/`*.pem`/`id_rsa` → 不自动提交,转人工批准;init/onboard 自动补 `.gitignore` 基线);受保护路径(`verify`/`.relay/**`/`tests/**`/测试文件改动不自动提交——注意该护栏只看未提交 diff,模型中途自行 commit 可绕过,最终防线在 CI 与人工抽查)。`verify` 脚本可移植:换机后 `export RELAY_HOME=/path/to/relay-mcp` 即可。

不接 MCP 也能用(CLI 与 CI 同一入口):

```sh
node src/cli.mjs relay_verify --root /path/to/project
```

### 注册到各 harness

以下 `~/path/to/relay-mcp` 按你的克隆位置替换。

**Claude Code**

```sh
claude mcp add relay -- node ~/path/to/relay-mcp/src/index.mjs
```

**Codex(`~/.codex/config.toml`)**

```toml
[mcp_servers.relay]
command = "node"
args = ["~/path/to/relay-mcp/src/index.mjs"]
```

**通用 JSON(Cursor / ZCode 及其他 MCP 客户端)**

```json
{
  "mcpServers": {
    "relay": { "command": "node", "args": ["~/path/to/relay-mcp/src/index.mjs"] }
  }
}
```

### 架构

stdio JSON-RPC(MCP 子集):`src/index.mjs` 启动 → `rpc.mjs` 按行读取请求 → `contract.mjs` 定义 9 个工具并 dispatch → `engines/` 执行(bootstrap = init/onboard + preset,sync = 入口投影,verify = 检查器,session = 会话协议,restructure = 目录标准化)。全部脚手架模板在**运行时**从 `templates/` 读取(`templatesDir()`),绝不硬编码——规范的单源在模板,目标项目里的入口文件只是投影。目标仓库侧只落一组纯文本文件(核心五件 + 三入口 + `verify` + `.relay/manifest.json`),对 harness 零侵入;git 缺失或提交失败时自动降级(文件照常更新,报告原因)。

### 自举

**本仓库自己运行 relay 协议**:`START.md` 是它的引导扇区,`TASKS.md` 是它的真实 backlog,每次引擎改动经 `relay_session_end` 出场——绿闸会实跑 `npm test`(81 项端到端断言)作为放行条件。想看协议长什么样,直接读本仓库根目录;想给本项目贡献代码,见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### FAQ

1. **老项目接入会被改坏吗?** 不会。`relay_onboard` 对已存在文件一律先备份为 `*.relay-bak-<时间戳>` 再写,永不删除用户文件;`relay_init` 遇到已存在的 START.md 会拒绝并建议改用 onboard。
2. **不接 MCP、在 CI 里怎么跑?** 每个接入项目根有 `verify` 脚本,它只是委托本引擎:`./verify` 等价于 `node src/cli.mjs relay_verify --root .`;GitHub Actions 工作流模板(node 22/24 双矩阵)由 init/onboard 装好。
3. **多个模型并行会打架吗?** 开工前 `relay_claim {task, model}` 认领:任务行标 `[~]` + 原子锁 `.relay/claims/T###.lock`(TTL 4 小时,崩溃会话到期自动可接管);R5 / R9 保证任务队列与会话日志同步,冲突面被压缩到单个任务内。

---

## English

relay-mcp is an MCP server that lets **any coding model (Claude / Codex / Gemini / Cursor / …) continue the work of any previous one** on the same repository. Handoff state lives in repo files (START / SPEC / DECISIONS / TASKS / LOG), entry files for every harness (AGENTS / CLAUDE / GEMINI) are **projected from a single source** so they never drift, and the exit gate refuses to commit until structure checks (R1–R9) **and the project's executable acceptance actually pass** (`test:` paths run via `node --test`; `npm test` when declared). Handoff runs on evidence, not on trust.

- Zero runtime dependencies (pure `node:` builtins), no build step, Node ≥ 18
- 9 tools: `relay_init` (0→1 with preset code skeleton), `relay_onboard` (non-destructive adoption of existing projects), `relay_restructure` (normalize legacy layout via `git mv`), `relay_session_start` / `relay_session_end` (briefing / green-gate exit), `relay_verify` / `relay_sync` / `relay_claim` / `relay_rules`
- Safety: secret guard (`.env*`, `*.key`, … never auto-committed), protected paths, claim locks with TTL
- **Self-hosted**: this repository runs its own protocol — read `START.md`, `TASKS.md`, `LOG.md` to see it in action

Quick start:

```sh
git clone https://github.com/KentQi/relay-mcp.git
claude mcp add relay -- node $PWD/relay-mcp/src/index.mjs
# then, in any model session: "按 START.md 干活" / "follow START.md"
```

Design derivation & interface contract (Chinese): [docs-design/](docs-design/). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 KentQi
