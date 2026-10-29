# relay-mcp — 接力棒 MCP

[![CI](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/relay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](package.json)
[![tests](https://img.shields.io/badge/self--hosted-npm%20test%20green-success)](#自举)

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
| 日常接力(每会话) | `relay_session_start` / `relay_session_end` | 进场简报(五件 + git 对账 + verify 快检)/ 出场绿闸(全绿才双提交:任务分支代码 + controlRoot 的 TASKS/LOG) |

preset 可选:`node`(默认,交付即 `npm test` 全绿)/ `minimal`(仅接力层,不建代码骨架);自定义 preset = 在 `templates/presets/` 下放一个目录即可。

辅助工具:`relay_sync`(升级/修复入口:重投影入口文件、幂等补 `.gitignore` 运行时基线、对无标记 `AGENTS.md` 输出迁移指引;报告漂移,`user-rules` 保留区原样携带)、`relay_claim`(并行认领,原子锁 `.relay/claims/T###.lock`,TTL 4 小时,到期可接管)+ 仓库级出场锁 `.relay/relay.lock`(TASKS/LOG 写串行化,双进程并发实测零丢失)与幂等出场(重复调用不重复记账)、`relay_verify`(随时机检)、`relay_rules`(规则 ID 表)。

**AGENTS.md 是必需的项目规范入口**,`entryFiles: []` 不能绕过它;CLAUDE.md / GEMINI.md 只是可选适配入口。规则修改仍以上游 `templates/AGENTS.md.tpl` 为单源,项目自定义内容放在 AGENTS.md 的 `user-rules` 保留区。旧项目升级时若 `AGENTS.md` 已存在但无 relay 标记,R1 会报错且 `relay_sync` 按非破坏原则不改写它——按 sync 输出执行迁移(`relay_onboard` 接管 / `entryFilesTakeover: true` / 手工加标记),不要把 R1 修复指令反复空转。

### 任务级 worktree 生命周期

`relay_claim {root, task, model}` 在项目启用 worktree 时创建或复用 `.relay/worktrees/T###` 与 `relay/T###` 分支,并返回两个根目录:

- **controlRoot**:主工作树,TASKS / LOG、认领锁、注册表与所有协议提交的唯一控制面。
- **executionRoot**:任务工作树(独立检出),代码修改、测试和任务分支提交的执行面。

**出场 = 双提交**。绿闸(verify 全量 + 验收执行门)通过后:

1. executionRoot 提交代码到 `relay/T###`(SHA₁);
2. controlRoot 只提交 `TASKS.md` + `LOG.md`(SHA₂,提交信息含 `T### 完成`)。

输出同时给出两个 SHA;未合并的 `relay/T###` 分支清单在 `relay_claim` / `relay_session_start` / `relay_worktree_cleanup` 输出中列出(`relay_session_end` 只声明当前任务「已验收、未合并」)。任一提交失败 → isError、不标完成、保留认领锁,修复后重跑补交;`autoCommit:false` 时会明确"控制面未提交"(代码提交照常,控制面需人工提交)。

**双根绿闸**:controlRoot 跑全量 R1–R9;executionRoot 跑 R1/R2/R3/R4/R8(跳过 R7/R9,避免读任务分支里的旧协议副本);两侧 ERROR 合并阻断,不在任务树里的代码违规不会被静默提交。

**根错配保护(严格)**:任务在 `.relay/worktrees.json` 仍有未完成记录时,从 controlRoot 完成出场**一律 isError**,不再有"工作树干净/空树可单根完成"的兼容例外——受管任务必须在 executionRoot 出场才能取得成对证据。若注册表缺失/损坏/记录丢失,relay 不会当作单根静默完成:它会用 `git worktree list` 反查 `relay/<task>` 分支是否仍被某个 worktree checkout,并检查受管缓存路径 `.relay/worktrees/<task>`(以及注册表残留记录路径)是否存在,命中同样拒绝并给出重建登记/从 executionRoot 出场的修复指令(`relay/<task>` 分支单独存在不算痕迹——清理后保留分支属正常)。managed 出场但 HEAD==baseSha 且无改动 → 拒绝伪 SHA。未登记的 linked worktree:完成出场 fail-closed,维护出场仅告警。

**未合并 ≠ 未完成**。任务分支验收通过不代表已合入主线;relay 不自动 merge / rebase / push,也不删分支。人工整合流程:

```sh
git log --oneline main..relay/T003   # 复核任务分支提交
git merge --no-ff relay/T003         # 人工合并
git branch -d relay/T003             # 可选:确认合并后删分支
```

`relay_claim` / `relay_session_start` / `relay_worktree_cleanup` 都会列出未合并的 `relay/T###` 分支。

**独立依赖**:executionRoot 是独立 checkout,`node_modules`、`.env` 等不在工作树之间共享;进入后先按项目方式安装依赖(如 `npm install`),再跑测试与 R8。

**成对证据(双提交)与 R5/R6**:受管完成必须同时具备四项证据——任务分支代码提交、controlRoot 完成提交(消息含 `T### 完成`)、controlRoot 的 TASKS/LOG 已提交干净、LOG 记录 `branch=`+代码 SHA;任一缺失 → isError、不落完成状态、可重跑补交。R5/R6 仍按 controlRoot 历史计算(任务分支提交不进入其窗口),因此双提交不会触发"代码提交未同步 TASKS/LOG"的原子性误报;跨分支意义上的 R5/R6 评估留待后续版本。

**清理保护**:`relay_worktree_cleanup {root}` 默认只预览,`confirm: true` 才清理;主仓库 session_start 可按 `autoCleanup` 自动清理,失败只报告、不阻断简报。只有已登记、超 TTL、非活跃、干净(**无未跟踪文件,且无 ignored 本地内容**)、未 locked 且 realpath 仍在受管缓存中的 worktree 才会通过非强制 `git worktree remove` 删除。含 `.env`、`node_modules`、构建产物等 ignored 内容的现场默认保留,避免误删本地密钥/依赖;已登记但未合并的分支一律保留并展示,后续认领可复用原分支。

**升级旧项目(重要)**

1. 先跑 `relay_sync {root}`:重投影入口文件、幂等补 `.gitignore` 运行时基线(`.relay/worktrees/`、`.relay/worktrees.json`、`.relay/worktrees.lock` 等),并对无标记 `AGENTS.md` 输出可执行迁移步骤。
2. `AGENTS.md` 已存在但无 relay 标记(旧项目常见):跑 `relay_onboard {root}`(原正文包进 `user-rules` 保留区,不丢内容),或在 `.relay/manifest.json` 置 `"entryFilesTakeover": true` 后重跑 `relay_sync`,或手工在首行加 `<!-- relay:generated v1 -->`。
3. worktree 配置对旧 manifest 缺省关闭,不会改变原认领行为;需要时在 manifest 显式开启。claim 时也会再幂等补一次 `.gitignore` 基线作为双保险。
4. `relay_onboard` 保留既有 manifest 配置(worktree / autoCommit / acceptance / protectedPaths / entryFilesTakeover 等只会被保留,不会被重置),升级重跑不会静默改变行为。

**配置面(manifest.worktree)** —— 拼错不报错,只会静默失效:

- `enabled`:只认 JSON 布尔 `true`;字符串 `"true"`、数字 `1` 等一律按 false 静默处理;
- `cacheDir`:只允许 controlRoot 内相对路径;绝对路径、`..`、盘符、控制字符、`.git` 前缀非法,校验发生在创建目录之前;
- `ttlHours`:非数字/负数回退 24;`autoCleanup`:只有显式布尔 `false` 才关闭;
- 未知/拼错字段(如 `enable`、`cache_dir`)静默忽略;改完建议跑一次 `relay_claim{worktree:false}` 或 `relay_worktree_cleanup` 验证实际行为。

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

`relay_claim` 的 `worktree: true/false` 可单次覆盖配置;无可用 HEAD/git(unborn 分支、非 git 目录)时自动降级为单根认领并 WARN,不会硬失败。

**registry 恢复**:`.relay/worktrees.json` 损坏时完成出场/claim fail-closed,提示备份或删除该运行时注册表(relay 不猜测受管状态);注册表缺失且当前目录是 linked worktree 时,完成出场拒绝——可在 controlRoot 重新 `relay_claim {task:"T###",worktree:true}` 重建登记,或离开该 worktree 在 controlRoot 操作;`relay_worktree_cleanup` 对未登记目录只报告不删。

**锁心跳与崩溃恢复(两把锁语义不同)**:

- **仓库写锁** `.relay/relay.lock`:持锁期间约 20 秒心跳续租 + 写前 fencing 校验,长 cleanup / 出场不会被 120 秒 stale 规则误判;写入前发现锁已被接管则拒绝写入。
- **任务认领锁** `.relay/claims/T###.lock`:**刻意关闭心跳**,保留 240 分钟 TTL 的崩溃恢复语义——agent 崩溃(即使 server 进程仍存活)后锁不再续租,到期即可被其他模型安全接管;锁内容为 JSON(v2,兼容旧文本),`model` 等字段拒收换行/控制字符(输入净化)防注入,与心跳无关。

同名 `model` 禁并发仍然适用。

**能力边界**:当前没有 claim 的 `abort/release`、没有按任务查询 `status` 的独立工具、没有 `sessionId`。可用恢复手段:认领锁 240 分钟 TTL 到期后接管(可传 `ttl_minutes` 覆盖)、`relay_session_end` 出场释放、`relay_worktree_cleanup` 清理过期目录。并发会话必须使用**不同 `model` 标识**(同名 model 无法区分持有者,会互相阻塞或误判完成权限)。

CLI 同样可用:

```sh
node src/cli.mjs relay_worktree_cleanup --root /path/to/project --json confirm=true
```

安全机制一览:密钥守卫(工作区出现 `.env*`/`*secret*`/`*credential*`/`*.key`/`*.pem`/`id_rsa` → 不自动提交,转人工批准;init/onboard/sync/restructure 自动幂等补 `.gitignore` 基线,claim 启用 worktree 时也会补);受保护路径(`verify`/`.relay/**`/`tests/**`/测试文件改动不自动提交——注意该护栏只看未提交 diff,模型中途自行 commit 可绕过,最终防线在 CI 与人工抽查)。`verify` 脚本可移植:换机后 `export RELAY_HOME=/path/to/relay-mcp` 即可。

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

stdio JSON-RPC(MCP 子集):`src/index.mjs` 启动 → `rpc.mjs` 按行读取请求 → `contract.mjs` 定义 10 个工具并 dispatch → `engines/` 执行(bootstrap = init/onboard + preset,sync = 入口投影,verify = 检查器,session = 会话协议,worktree = 任务目录与缓存生命周期,restructure = 目录标准化)。全部脚手架模板在**运行时**从 `templates/` 读取(`templatesDir()`),绝不硬编码——规范的单源在模板,目标项目里的入口文件只是投影。目标仓库侧只落一组纯文本文件(核心五件 + AGENTS.md 与按需适配入口 + `verify` + `.relay/manifest.json`),对 harness 零侵入;git 缺失或提交失败时自动降级(文件照常更新,报告原因)。

### 自举

**本仓库自己运行 relay 协议**:`START.md` 是它的引导扇区,`TASKS.md` 是它的真实 backlog,每次引擎改动经 `relay_session_end` 出场——绿闸会实跑 `npm test`(四套端到端冒烟:主冒烟 / 补丁 / worktree / 升级兼容)作为放行条件。想看协议长什么样,直接读本仓库根目录;想给本项目贡献代码,见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### FAQ

1. **老项目接入会被改坏吗?** 不会。`relay_onboard` 对已存在文件一律先备份为 `*.relay-bak-<时间戳>` 再写,永不删除用户文件,并**保留既有 manifest 配置**(worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover 等不会被重置);`relay_init` 遇到已存在的 START.md 会拒绝并建议改用 onboard。
2. **不接 MCP、在 CI 里怎么跑?** 每个接入项目根有 `verify` 脚本,它只是委托本引擎:`./verify` 等价于 `node src/cli.mjs relay_verify --root .`;GitHub Actions 工作流模板(node 22/24 双矩阵)由 init/onboard 装好。
3. **多个模型并行会打架吗?** 开工前 `relay_claim {task, model}` 认领:任务行标 `[~]` + 原子锁 `.relay/claims/T###.lock`(TTL 4 小时,崩溃会话到期自动可接管);R5 / R9 保证任务队列与会话日志同步,冲突面被压缩到单个任务内。
4. **清理 worktree 会丢代码或合并分支吗?** 不会。只清过期、非活跃、干净(且无 ignored 本地内容)的已登记目录;任务分支保留并列出,dirty/ignored/活跃现场不动;relay 不自动合并、推送或删分支,人工决定是否整合。
5. **旧项目升级要注意什么?** 先 `relay_sync`(重投影入口 + 补 .gitignore 基线 + AGENTS 迁移指引);worktree 对旧 manifest 缺省关闭,需要时再显式开启;`relay_onboard` 不会重置既有 manifest 配置。无可用 HEAD/git 时 claim 自动降级为单根认领并 WARN。
6. **任务分支怎么合并回主线?** relay 只验收不合并:`git log --oneline <控制面分支>..relay/T###` 复核 → `git merge --no-ff relay/T###` 人工合并 → 可选删分支;合并后再 `relay_worktree_cleanup` 清理过期目录。

---

## English

relay-mcp is an MCP server that lets **any coding model (Claude / Codex / Gemini / Cursor / …) continue the work of any previous one** on the same repository. Handoff state lives in repo files (START / SPEC / DECISIONS / TASKS / LOG). AGENTS.md is the required project instruction entry; CLAUDE.md/GEMINI.md are optional adapters projected from the same source. The exit gate refuses to commit until structure checks (R1–R9) **and the project's executable acceptance actually pass** (`test:` paths run via `node --test`; `npm test` when declared). Handoff runs on evidence, not on trust.

- Zero runtime dependencies (pure `node:` builtins), no build step, Node ≥ 18
- 10 tools: `relay_init` (0→1 with preset code skeleton), `relay_onboard` (non-destructive adoption of existing projects), `relay_restructure` (normalize legacy layout via `git mv`), `relay_session_start` / `relay_session_end` (briefing / green-gate exit), `relay_worktree_cleanup` (dry-run by default), `relay_verify` / `relay_sync` / `relay_claim` / `relay_rules`
- Task lifecycle: `relay_claim` creates or reuses `relay/T###`; controlRoot owns TASKS/LOG while executionRoot (an independent checkout — install dependencies there) owns code and tests. Exit makes two commits (task branch code + controlRoot TASKS/LOG only) and reports both SHAs. New projects opt in by default; existing manifests stay off until explicitly enabled (boolean `true` only) and are preserved by `relay_onboard`. Upgrade path: run `relay_sync` (re-project entries, append the .gitignore baseline, print AGENTS.md migration steps). Cleanup removes only registered, inactive, clean worktrees without ignored local content, and preserves branches. Accepted is not merged: no automatic merge, rebase, push, or branch deletion; merge manually with `git merge --no-ff relay/T###`. No abort/release/status/sessionId yet; use unique model ids per concurrent session.
- Safety: secret guard (`.env*`, `*.key`, … never auto-committed), protected paths, owner-checked claim locks with TTL
- **Self-hosted**: this repository runs its own protocol — read `START.md`, `TASKS.md`, `LOG.md` to see it in action

Quick start:

```sh
git clone https://github.com/KentQi/relay-mcp.git
claude mcp add relay -- node $PWD/relay-mcp/src/index.mjs
# then, in any model session: "按 START.md 干活" / "follow START.md"
```

Design derivation & interface contract (Chinese): [docs-design/](docs-design/). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 kent (kirroyu@126.com)
