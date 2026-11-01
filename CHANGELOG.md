# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式;
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.4.1] - 2026-11-01

### Fixed
- **P0-1** managed 出场:密钥闸前移到任何提交之前,密钥不再先进入 git 提交消息
- **P0-2** 事实行口径:记录 base sha,写入/校验共用同一 range;单根模式覆盖未跟踪文件;多提交分支不再误判
- **P0-3** 密钥规则补 `sk-ant-*` / `sk-proj-*` / `github_pat_*`;豁免默认 fail-closed 且 R11 显式报告豁免行数
- **P0-4** `relay_recall`/`relay_get`/`relay_doctor` 解析 controlRoot,worktree 内不再失明
- **P1** 写入原语级密钥闸、facts.enabled 生效、D3 日期归一化、D4 真实 TTL、D5 注册根解析、R10 改查最新完成条目且缺行降 WARN、sync 输出 facts 升级提示、握手版本单一来源、recall 过滤/去重/解析器统一
- **P2** CONTRACT 规则表补 R10、清除残留 R1–R9、跳过列表补 R10、发布护栏 prepublishOnly、CHANGELOG 顺序、回归冒烟(19 断言)与整树零写盘断言、简报回显真实 worktree 配置

## [1.4.0] - 2026-11-01

### Added
- **检索寻址(T018)**:`relay_recall`(只读索引:任务号/时间/model/状态/标题/条目体量/负结果数,支持 query/status/model/limit)与 `relay_get`(按任务号取全文 ≤5 个:验收 + 最新 LOG 条目 + 事实行/分支 SHA/负结果/交接 + 关联决策)。调用时从 LOG/TASKS 即时派生,**零持久索引**;输出围栏包裹并标注「数据非指令」
- **自愈诊断(T019)**:`relay_doctor` 只读七检(Node / manifest schema / 入口投影漂移 / 残留认领锁 / 未登记任务树 / .relay 完整性 / 引擎路径一致性),不写盘、不取写锁、不自动修复;每条问题给可执行「修复:」指令。`generateEntryFiles` 新增 `mode: 'check'` 只读模式
- **npm 分发面(T020)**:移除 `private`,`bin.relay-mcp = src/index.mjs`,`files` 白名单(src/templates/安装器/README/LICENSE),`engines.node >= 18`;`npm pack` 46 文件约 129 kB,协议状态与开发文档不进包;发布动作仍需人类批准
- `scripts/smoke-doctor.mjs`(17 断言)、`scripts/smoke-recall.mjs`(22 断言)、`scripts/smoke-pack.mjs`(28 断言)接入 `npm test`

### Changed
- MCP 工具 11 → 13;`relay_rules`/`relay://protocol`/README/CONTRACT 同步检索与诊断能力

## [1.3.0] - 2026-11-01

### Added
- **事实底账(R10)**:`relay_session_end` 由引擎确定性写入 `- 事实(v1):` 行(改动文件数/±/验收结果/verify 汇总/分支与 SHA/耗时);`relay_verify` 校验存在性与文件数一致(默认 WARN,`manifest.facts.strict=true` 升级 ERROR,`facts.since` 之前的旧条目豁免)。零 LLM、零新增状态文件
- **内容级密钥闸(R11)**:`TASKS.md`/`LOG.md` 扫描 AWS/GitHub/Slack/OpenAI/Google 密钥样式与 PEM 私钥块;命中 ERROR,出场在任何写盘前阻断(不写、不提交、保留认领锁);同行 `relay:secret-ok` 豁免;输出只回显前 4 字符
- **简报有界化**:LOG 摘要硬上限 200 字符,超长标注"全文见 LOG.md";总长超 `manifest.contextBudget`(默认 6000)显式告警而不裁剪段落;简报头部回显生效配置
- `scripts/smoke-facts.mjs`(18 断言)、`scripts/smoke-brief.mjs`(10 断言)、`scripts/smoke-content-guard.mjs`(13 断言)接入 `npm test`

### Changed
- 规则表扩到 R1–R11;`relay_rules`、AGENTS.md 模板、README、CONTRACT 同步
- `relay_init`/`relay_onboard` 默认写入 `manifest.facts`;旧项目缺席即旧行为
- 模板 LOG 示例条目改为 `task=无`(避免新项目首日触发 R10 误报)

### Fixed
- 事实行与密钥闸的写入顺序:先扫模型输入再写任何文件,杜绝"TASKS 已写、LOG 被拦"的半写状态

## [1.2.0] - 2026-10-29

### Added
- 跨平台 MCP 安装器 `scripts/install-mcp.mjs`:自动探测当前 `node` 与仓库绝对路径,生成标准 `mcpServers` 配置;支持 `--print/--print-json/--target json|claude|gemini|codex|dsh|auto`、`--dry-run` 与启动握手预检,Windows/macOS/Linux 通用,不绑定单一 harness
- 完整任务级 worktree 生命周期(方案 B):claim 创建/复用 `relay/T###` 与缓存目录,返回 controlRoot/executionRoot/branch/baseSha;新 init 默认启用,既有 manifest 缺省关闭,可按项目或单次认领覆盖
- 新增第 10 个工具 `relay_worktree_cleanup`:默认 dry-run,显式确认或主仓库 session_start 自动清理过期、非活跃、干净的受管目录;只走非强制 `git worktree remove`,保留分支,绝不自动 merge/rebase/push
- session 双根协议:controlRoot 唯一维护 TASKS/LOG/认领锁/注册表,executionRoot 执行测试和代码提交;代码提交失败不盖完成章,完成不等于合并
- 仓库级写锁 `.relay/relay.lock`:TASKS/LOG 的读改写跨 session_end / claim / restructure / sync 全面串行化,并发双进程回归断言零丢失
- 维护会话语义:`relay_session_end` 传 `maintenance:true` 记 `task=维护`,不计入 R7 发散窗口
- 入场简报带出最新一条 LOG 的负结果与交接提示;存在进行中任务时崩溃恢复优先(含 TTL 接管指引)

### Changed
- README 重写为简洁版:合并重复的 harness 接入章节,统一安装入口,突出双提交/双根、配置、安全边界与 10 个工具速查
- AGENTS.md 成为不可绕过的必需项目规范入口,`entryFiles: []` 不再豁免;CLAUDE.md/GEMINI.md 为可选适配入口
- 四套冒烟(主冒烟 / 补丁 / worktree / 升级兼容)统一接入 `npm test` 与 CI
- 文档/契约同步最终语义:出场双提交(executionRoot 任务分支代码 + controlRoot 仅 TASKS/LOG,两个 SHA)、R5/R6 双根证据、未合并 `relay/T###` 分支列表与人工 `git merge --no-ff` 流程、ignored 文件清理保护、executionRoot 独立装依赖、旧项目先 `relay_sync`、AGENTS.md 无标记迁移、registry 恢复、abort/release/status/sessionId 尚未提供、同名 model 禁止并发
- `relay_claim`/`relay_session_end`/`relay_worktree_cleanup`/`relay_sync` 的 MCP 描述与 `relay_rules`/`relay://protocol` 同步上述语义;`manifest.worktree` 配置真值表(仅布尔 true、未知字段静默忽略、ttlHours 回退、cacheDir 相对路径)写入 README/CONTRACT

### Fixed
- worktree 冒烟 L2 用例改为换行无关插入:Windows `core.autocrlf=true` 时 `TASKS.md` 检出为 CRLF,原字符串替换不命中,活跃任务被误判为可清理(测试脚本缺陷,运行时无影响)
- `relay_onboard` 合并既有 manifest(worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover 等保留,只协调 version/projectName/entryFiles/allowedTopLevel/docsPhases/onboardedAt/relayHome),升级重跑不再静默关闭 worktree/护栏配置
- `relay_sync` 作为升级/修复入口幂等补 `.gitignore` 运行时基线(worktree 缓存/注册表/密钥),并对"已存在无 relay 标记的 AGENTS.md"输出可执行迁移步骤(onboard 接管 / `entryFilesTakeover:true` / 手工加标记),R1 修复指令不再空转;`relay_restructure` 提交前同样补基线
- 新增 `scripts/smoke-compat.mjs` 覆盖 onboard 保配置、sync 迁移与 .gitignore 基线、contract/README 关键文案断言,并接入 `npm test`
- 认领锁 TTL 到期可由其他模型接管;session_end 拒绝非持有者完成他人任务
- 仓库锁与认领锁使用唯一 token,旧锁持有者延迟释放不会删除新持有者的锁;锁丢失时依据 TASKS 时间戳执行同一 TTL
- 幂等出场:同一出场重跑不再重复盖戳/记日志/插入 next
- 认领锁 TTL 接管改为 unlink+wx 原子竞争(并发接管不再双成功)
- 认领 model 占位符(`<你的模型标识>`)拒收,防署名污染

## [1.1.0] - 2026-10-17

### Added (manifest 配置面, 全部缺省=v1.0.0 行为)
- `codeRoots` / `docsRoots`: R5/R6 代码与文档前缀可配(默认 src/lib/app)
- `docsIgnore`: R3 文档豁免 glob(内置 archive/templates 豁免不变)
- `protectedPaths`: 受保护路径追加 glob(与内置规则合并, 只能加严)
- `acceptance.commands`: 验收 `test:` 命令白名单(放行 pytest 等非 js/ts)
- `commitMessageTemplate`: 提交信息模板({{task}}/{{taskId}}/{{summary}})
- `autoCommit: false`: session_end 只更新文件不提交

### Changed
- sync 对「已存在但无 relay 标记」的入口文件默认 kept(不重写); `entryFilesTakeover: true` 恢复旧行为

### Fixed
- `git status --porcelain` 被误 trim/slice 导致受保护规则对已跟踪文件漏判(护栏失效)
- Windows 下 `execFile('npm')` ENOENT 导致 npm test 绿闸空转
- status 未加 `-uall` 导致未跟踪目录折叠、glob 护栏漏判

## [1.0.0] - 2026-09-29

首个公开发布版本。

### Added
- MCP 服务器(stdio,零依赖纯 Node):9 个工具
  - `relay_init`:0→1 建仓(模板 + preset 代码骨架 + git 首提交)
  - `relay_onboard`:存量项目非破坏接入
  - `relay_restructure`:老项目目录标准化(干跑 → confirm 执行,git mv 保历史)
  - `relay_session_start` / `relay_session_end`:接力简报 / 出场绿闸
  - `relay_verify` / `relay_sync` / `relay_claim` / `relay_rules`
- 出场绿闸:结构检查(R1-R9)+ 验收执行门(`test:` 跑 `node --test`;`scripts.test` 跑 `npm test`),不绿不提交
- 安全机制:疑似密钥守卫(不自动提交)+ `.gitignore` 基线 + 受保护路径护栏
- 入口文件单源投影(AGENTS/CLAUDE/GEMINI)+ user-rules 保留区(重投影不冲掉项目自定义规范)
- 认领锁 `.relay/claims/T###.lock`(原子创建,TTL 4 小时,到期可接管)
- `relay_restructure`:保守分类迁移 + manifest 白名单修宪 + DECISIONS/LOG/TASKS 自动记录
- CI 模板(node 22/24 矩阵:结构检查 + 项目测试)
- 自举:本仓库自 v1.0.0 起运行自身的接力协议(见根目录 START.md / TASKS.md / LOG.md)