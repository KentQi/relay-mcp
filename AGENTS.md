<!-- relay:generated v1 -->
# relay-mcp — 规范入口(canonical)

本文件由 relay-mcp 单源投影生成(2026-10-29);CLAUDE.md 与 GEMINI.md 只是它的指针副本。
规则要改:改 relay 引擎模板后运行 `relay_sync` 重投影;不要只手改其中一份(会漂移,R1 拦)。

## 项目身份
- 项目:relay-mcp
- 规范的可执行形式:`./verify`(委托 relay 引擎机检 R1-R9)

## 开工必读
先读 `./START.md`(三步引导:验状态 → 领任务 → 按协议干)。任务与验收看 `TASKS.md`,意图与验收标准看 `SPEC.md`,既定决策看 `DECISIONS.md`(勿重复论证),上个会话的产出与踩坑看 `LOG.md`。

## 六步会话协议(一句话版)
进场简报(session_start)→ 领任务/定验收(claim,启用 worktree 时返回 controlRoot/executionRoot)→ 小步实现(红灯优先,代码只在 executionRoot 写)→ 自验(verify)→ 出场绿闸(session_end:全绿才双提交——executionRoot 任务分支代码 + controlRoot 仅 TASKS/LOG)→ 留给下一个(LOG 记负结果与下一步)。

## 任务级 worktree(启用时)
- **双根**:`relay_claim` 返回 controlRoot(协议控制面:TASKS/LOG/认领锁/注册表)与 executionRoot(独立检出:代码/测试/任务分支提交);代码与测试只在 executionRoot 执行。
- **独立依赖**:executionRoot 是独立 checkout,`node_modules`/`.env` 不与主工作树共享;在其中装好依赖再跑 R8/测试。
- **双提交出场**:绿闸通过后先在 executionRoot 提交代码到 `relay/T###`,再在 controlRoot 只提交 `TASKS.md`+`LOG.md`;输出两个 SHA(代码 + 控制面)。控制面提交失败 → 重跑出场补交;成对证据要求两提交 + LOG 记录 branch/sha 齐备。
- **双根绿闸**:controlRoot 全量 R1–R9;executionRoot R1/R2/R3/R4/R8(跳过 R7/R9);两侧 ERROR 合并阻断。
- **根错配(严格)**:任务仍有 registry 未完成记录时,从 controlRoot 完成**一律被拒**(无空树例外),须在 executionRoot 出场;注册表缺失/损坏/记录丢失时用 `git worktree list` 反查 `relay/<task>` checkout 与受管缓存路径,命中同样拒绝;未登记 linked worktree 完成出场 fail-closed。
- **未合并语义**:任务分支验收通过 ≠ 已合并;relay 不自动 merge/rebase/push/删分支。人工流程:`git log <controlRoot>..relay/T###` 复核 → `git merge --no-ff relay/T###` → 需要时 `git branch -d`。
- **清理保护**:`relay_worktree_cleanup` 默认 dry-run;含未跟踪/ignored 本地内容(`.env`、`node_modules`、构建产物)的 worktree 默认保留;只删干净、过期、非活跃、已登记的目录,分支保留。
- **升级/迁移**:旧项目先跑 `relay_sync`(重投影入口 + 幂等补 .gitignore 运行时基线 + AGENTS 迁移指引);`relay_onboard` 保留既有 manifest 配置;无标记 AGENTS.md 用 onboard 接管或手工加标记后 sync。
- **配置面**:`manifest.worktree.enabled` 只认 JSON 布尔 `true`;`cacheDir` 只允许 controlRoot 内相对路径;未知/拼错字段静默忽略(不报错,改完建议跑一次 claim/cleanup 验证)。
- **锁语义**:仓库写锁 `.relay/relay.lock` 约 20s 心跳 + 写前 fencing(长 cleanup/出场不被 120s 误判);任务认领锁 `.relay/claims/T###.lock` **不心跳**,保留 240min TTL 崩溃恢复(agent 崩溃后到期可接管);model 含换行/控制字符会被拒收。
- **能力边界**:暂无 claim 的 abort/release、按任务查询 status、sessionId;恢复靠认领锁 240min TTL 到期接管 / relay_session_end 释放 / relay_worktree_cleanup。并发会话必须用不同 model 标识。

## 规则速查 R1-R9
| ID | 一句话 |
|---|---|
| R1 | AGENTS.md 必需;其与已配置适配入口均须存在且首行带 relay 生成标记(缺失→relay_sync;已存在无标记→onboard 接管 / `entryFilesTakeover:true` / 手工加标记) |
| R2 | 顶层目录白名单;越界须显式修 `.relay/manifest.json`(修宪) |
| R3 | docs 文档命名(`NN-类型-主题-vX.Y.md`)与 frontmatter 合规 |
| R4 | 入口文件与 START 保持常青,不得出现时变词汇 |
| R5 | 动了 src 就要同步动 TASKS/LOG(提交原子性;双根下由成对证据兜底:任务分支代码提交+controlRoot 完成提交) |
| R6 | 代码连动而文档未动 → staleness 提醒 |
| R7 | 会话日志连续 3 条任务会话(维护不计入)无「T### 完成」→ 停机,人类仲裁 |
| R8 | 项目配了 format 工具链就跑;没配不硬加 |
| R9 | LOG 记完成的任务,TASKS 里必须已完成 |

细则与执法点:`relay_rules`;完整规范见 relay-mcp 仓库与全局 CLAUDE-PROJECT-RULES。

<!-- relay:user-rules-start(本区为项目自定义规范:relay_sync 只原样保留本区,模板重投影不会冲掉) -->
<!-- relay:user-rules-end -->

