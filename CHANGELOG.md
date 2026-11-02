# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式;
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- `relay_verify` 单轮只读一次 LOG/TASKS/manifest(此前 4/2/2 次),git 子进程从 9 收敛到 2–4;`resolveRelayRoots` 对普通仓库走 fs 快路径(recall/get 的 git 调用 2→0);async 路径不再同步探测 git(T022)
- 新增 `scripts/smoke-perf.mjs`(24 断言,计数钩子而非计时阈值)接入 `npm test`;`RELAY_TRACE_FILE` 可观测单轮读取/子进程计数

### Changed(T023)
- **事实行升 v2**:以 `||` 拆两段——机检段 `mode | 文件 N | ± +x/-y | base | sha | branch`(检查时点可从 git 重算)与叙述段 `验收 | verify 汇总 | 耗时`(写时快照,仅结构校验)。机检段任一字段与 git 重算不符 → R10 **ERROR**(不再依赖 `facts.strict`);叙述段被改**不误红**
- **R10 去 fail-open**:无法定位对应提交(伪造 sha、提交被重写、历史被裁剪)→ **WARN,永不 PASS**;缺事实行维持 WARN;v1 旧行继续可解析,只对文件数

### Added(T024)
- **R12 LOG 边界**:LOG 活跃区(归档指针之前的行)>150 行 或 完成条目 >20 → WARN(`manifest.logBoundary.strict=true` 升 ERROR);只报警、不自动归档,归档动作留人工;阈值按现状设定(本仓库当前 139 行 / 16 完成条目,落地即绿)
- `scripts/smoke-r12-boundary.mjs`(18 断言)接入 `npm test`

### Added(T025)
- `package.json` 补 `repository` / `bugs`(npm provenance 发布前置);`smoke-pack` 增加 2 条机检断言(28→30),打包边界不回归

### Fixed(PR #8 审计,详见 `docs/04-test/06-audit-pr8-v1.0.md`)
- **HIGH**:`collectGit` 的 `__COMMIT__` 文本哨兵改为 NUL 记录前缀——同名文件不再能伪造提交头让 R5 静默失明
- **HIGH**:v1 事实行不再参与数字对账(行自带的 base/sha 是自证),只做结构校验并 WARN;数字权威仅 v2
- **MEDIUM**:R10 增加 branch 归属校验(分支存在但不含声明 sha → ERROR,分支已删除 → WARN);single 模式 ± 明确为写时近似、不构成机检字段;三处一致断言升级为内容比对并清掉 README 英文半边与 `src/**` 的 `R1–R11` 残留;同步 `isGitRepo()` 删除、全引擎改 async;R12 归档指针必须指向真实存在的 `docs/archive/*.md`(否则按全文计算),两轴共用同一活跃区
- **LOW**:v2 分隔符改按「空格||空格」解析(分支名含 `|`、叙述段含 `||` 均不再截断);recall 同时剥离 v1/v2 事实行前缀;任务树检查不再取提交历史(省一次 git);R12 修复文案删除「拆小任务粒度」
- **复审 N1**:`smoke-perf` 的 managed 用例改跑**真双根**(从 executionRoot verify),断言双根分支 + `manifest` 读 1 次 + git ≤8(实测 5–7);此前 `git=2` 是单根路径误测
- **复审 N2**:R5 在最新提交为 merge 时改为**显式 SKIP**(不再因 `git log --name-only` 不列 merge 文件而假 PASS),双根由成对证据兜底
- **合并后清理**:删除已合并任务分支后 R10 不再永久 WARN——声明分支已删除、但「T### 完成」提交仍在当前分支历史 → PASS 带注记(伪造分支名/历史外提交仍 WARN);回归 `smoke-facts`
- **R7 维护会话口径**:`task=无`(引擎无 done_task 的维护出场)与 `task=维护` 一样不计入发散窗口;否则连续几次维护出场会误触发「3 条任务会话无完成」停机;回归 `smoke.mjs`
- **T001 LOG 归档机制**:新增 `relay_archive_log` 工具(默认 dry-run,`confirm:true` 执行)——只从尾部搬、live 至少保留 3 条、边界早于最新完成条目、归档文件 `docs/archive/LOG-*.md` 只追加;控制面提交白名单扩展为 TASKS/LOG/docs/archive,`PROTOCOL_FILES` 与 R11 扫描面同步扩展;`smoke-archive-log.mjs`(18 断言)接入 `npm test`
- **T002 写入竞争治理**:`writeProtocolFile` 增加内容 CAS(`expectedHash`)——claim/session_end 读 TASKS/LOG 后记哈希,写前对两文件同时预检,任一被外部改过(人类手改/旧版本进程/TTL 接管窗口)就整体拒绝、不写不提交;`smoke-concurrency.mjs`(14 断言)接入 `npm test`(CAS 冲突、并发认领不丢更新、幂等、无残留)
- **T026 会话启动读放大收敛**:`relay_session_start` 的 manifest 读 6→1、LOG 2→1、TASKS 3→1(worktree 配置/自动清理/简报回显/verify 快检共用同一份内存快照);git 子进程 7 来自自动清理与未合并分支探测,非读放大;`smoke-session-perf.mjs` 由红灯转绿并接入 `npm test`
- **LOG 归档(人工执行一次)**:R12 连续 WARN 触发 T001——20 条历史条目搬入 `docs/archive/LOG-2026-09-11.md` 并在 LOG.md 留指针,R12 转 PASS;自动化归档引擎仍推迟(控制面白名单/PROTOCOL_FILES/R11 扫描面需同步扩展)
- **R10 单根定位**:单根事实行没有 sha 时按「T### 完成」反查完成提交,完成之后的普通维护提交(归档/changelog)不再让 R10 失去定位能力;回归 `smoke-facts`
### Fixed(第五轮独立复验审计,详见 `docs/04-test/07-audit-round5-v1.5.0.md`)
- **P0-1 写盘穿越**:`relay_init`/`relay_onboard` 写任何文件前检查 root 与目标目录组件不是符号链接(`assertSafeWriteLayout`);`relay_archive_log` 写归档前过协议布局闸 + 父目录断言——`docs -> 仓库外` 不再能把骨架/归档写到仓库之外
- **P0-2 项目名注入**:项目名先净化(控制字符 → 空格、丢弃 `{}`、80 字符上限)再过密钥闸;渲染顺序改为 `{{PROJECT_NAME}}` 最后(不再二阶展开 `{{TODAY}}`/`__RELAY_HOME__`),渲染后内容再过密钥闸——伪造任务行/密钥不再随首个提交进入 git 历史
- **P0-3/P1-1 归档方向与 R7 防线**:LOG「最新在上」→ 保留头部 `keep` 条、归档其余(此前搬反:live 只剩最旧);边界覆盖最新完成条目 → 拒绝执行;归档不再能把发散证据搬进归档来洗绿 R7
- **P1-2 出场半写**:LOG 条目构造 + 密钥闸 + TASKS/LOG 双文件 CAS 预检全部前移到任何写盘之前;失败时两文件均未变,不再出现「TASKS 已写、LOG 被拦」
- **P2 裁判面补洞**:R10 单根反查完成提交取最多 10 个候选、按 diff 文件数与事实行一致挑选(防「消息含 T### 完成」的无关提交劫持);R11 扫描面扩到入口/协议 8 文件 + `docs/archive/**/*.md`(快照只复用 TASKS/LOG);R12 指针必须 realpath 仍在仓库内、失效指针 → WARN(不静默 PASS);`next.acceptance` 的 `test:` 路径在写入 TASKS 前校验;无变更提交幂等跳过、同一秒备份加序号、`relay_onboard` 内容一致不重写 manifest/不新建备份;bare 仓库 init 直接拒绝
- 新增 `scripts/smoke-security.mjs`(25 断言)接入 `npm test`;`smoke-archive-log.mjs` 18→25(方向/R7/符号链接/幂等),`smoke-compat.mjs` C1 期望改为幂等

- 回归规模:`npm test` 18 套 / 677 断言全绿(含第五轮审计新增安全回归)

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