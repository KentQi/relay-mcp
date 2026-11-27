# 会话日志(最新在上)

## 2026-11-28 02:05 | model=codex-audit-followup-final | task=维护
- 摘要: T073 最终续作已合并：PR #12 终稿代码 dfe39d1，GitHub merge commit 738240c，Node 22/24/26 两事件矩阵 6 个 CI job 全绿；本地在合并后的 main 上 npm test 31 套全绿（0 失败），双根 verify 为 controlRoot PASS 9/WARN 1/ERROR 0、executionRoot PASS 4/WARN 0/ERROR 0，插件校验 0 fatal，npm pack dry-run 56 文件，git diff --check 通过。MAX 审计确认项已全部落地并有行为回归；T055–T057 仍按 DECISIONS 有意保留 R9 WARN。T073 既有完成证据不改写，本次以维护出场记录后续修复、PR 合并与最终验证。
- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 10·WARN 1·ERROR 0 | 耗时: 113s
- 负结果: 不要用 done_task=T073 重跑完成出场：T073 已是 [x]，registry 仍保存 ecad5e4/b95ecf0 的旧成对证据；最终续作应走无 done_task 维护出场。
- 负结果: T055–T057 是经批准保留的历史 R9 缺口，不得回填或伪造完成证据。
- 负结果: 便携 Node 自更新仍保留已写入 CONTRACT 的最终内容 CAS rename 与锁释放 unlink 两个不可完全原子化窗口，不应在本任务中扩展架构重写。

## 2026-11-27 17:12 | model=codex-audit-followup | task=T073 完成
- 摘要: 复核 PR #12 基线 4203d78，Node 22/24/26 共 6 个 CI job 成功。补齐 R9/R10 完成证据、半写与重复出场恢复、同日归档保全、不可读配置、验收输出与时限、原始文件名守卫、并发接力和启动器冷却。认领锁与出场恢复冒烟已接入 npm test。审计逐项结果见任务分支 docs/04-test/13-audit-deep-scan-v2.1.md 第 12 节。任务分支 relay/T073 待人工复核。
- 事实(v2): mode=managed | 文件 67 | ± +4200/-1902 | base=0d8764b11b886c748c6b04544d0c97d95d8d4cd9 | sha=ecad5e455b8f9e1e21ed961388f4ff4d34b5eced | branch=relay/T073 || 验收: 通过 | verify: PASS 15·WARN 1·ERROR 0 | 耗时: 111s
- worktree: branch=relay/T073; sha=ecad5e455b8f9e1e21ed961388f4ff4d34b5eced; 已验收,未合并(是否合并由人工决定)
- 负结果: v1 事实行的非 ERROR 结果只证明兼容降级，不能作为分支前移回归。新夹具使用真实受管出场和追加提交，并要求 R10 PASS。

## 2026-11-27 15:46 | model=hungerg-audit-fix | task=T072 完成
- 摘要: T072 推进:推送 T071 的三个 CI 修复(813d148 TDZ、27fc10a 分支名假设、4f5b81a R10 锚点改用 LOG 成对证据行)到 origin/relay/T071;PR #12 已更新。等待三矩阵 CI(22/24/26)结果。
- 事实(v2): mode=single | 文件 1 | ± +7/-1 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 114s
- 留给下一个: CI 结果见 gh pr checks 12;若仍红用 gh run view --log-failed 定位。审计报告在分支 docs/04-test/13-audit-deep-scan-v2.1.md。

## 2026-11-27 14:15 | model=hungerg-audit-fix | task=T071 完成
- 摘要: T071 全面修复深层审计确认项：R10 独立锚定重写（任务分支 tip + registry.baseSha 祖先，字段对账先于分支归属）、R9 全局化并给本会话收尾任务崩溃恢复豁免、R2 改 readdir+git 并集并用 manifest.runtimeTopLevel 显式声明运行时目录、进程组终止修正（child.detached 恒为 undefined 导致只杀直接子进程）、认领锁 claimLockExpiry 单一真相源与 ttl_minutes 覆盖、CLI schema 校验与 stdout 不截断、recall 纳入无 LOG 待办并合并归档、archive 与 R12 共用合法指针且保留 3 个任务会话、sync/restructure/rescue 符号链接防线与 writeProtocolFile、自更新启动器 fail-closed 与并发锁、退役 scripts/audit 与死代码、pack 纳入启动器、文档口径与版式修正。29/29 套件全绿，verify 双层 PASS 10/WARN 1(历史 T055-T057 已批准缺口)/ERROR 0。
- 事实(v2): mode=managed | 文件 59 | ± +2849/-1157 | base=0d8764b11b886c748c6b04544d0c97d95d8d4cd9 | sha=e3f660d9871b96ff100092fbe86c7c1c9c2a92a0 | branch=relay/T071 || 验收: 通过 | verify: PASS 14·WARN 1·ERROR 0 | 耗时: 100s
- worktree: branch=relay/T071; sha=e3f660d9871b96ff100092fbe86c7c1c9c2a92a0; 已验收,未合并(是否合并由人工决定)
- 留给下一个: PR 待你复核。R9 的历史 T055–T057 WARN 按 DECISIONS 2026-11-26 T061 有意保留，不得回填。manifest.runtimeTopLevel 已在 controlRoot 与本 worktree 声明 .claude/.v2c/.zcode/out。

## 2026-11-27 06:32 | model=hungerg-free | task=T068 完成
- 摘要: T068 发布 v2.1.1。内容:v2.1.0 之后的 T064(LOG 归档 + worktree/分支清理)+T065/T067(自更新启动器 scripts/relay-mcp-autoupdate.mjs 入库、仓库路径自推导、四重守卫[main 分支/非 linked worktree/工作区干净/无独有提交]、rev-list fail-closed、merge SIGTERM 宽限+postMergeCheck+入口健康复核、状态原子写、预算夹取、DECISIONS ff-merge 授权边界、隔离夹具行为断言 18 条)+T066(14 个 harness 注册面切换到仓库内启动器,新增 smoke-harness-paths.mjs 39 断言本机验收)。版本三方同步:package.json/plugin.json 2.1.1,CHANGELOG [2.1.1] - 2026-11-27(由 [Unreleased] 定版)。验证:npm test 27 套 1122 断言全绿,verify 双根 PASS 10·WARN 0·ERROR 0 / PASS 4·WARN 0·ERROR 0。前置确认:当前 HEAD(8c9d550)的三矩阵 CI 45868154259 success(Node 22/24/26)。推送/tag/Release 为用户已授权的外向动作,出场合并后执行。
- 事实(v2): mode=managed | 文件 3 | ± +3/-3 | base=8c9d550f1645a2fac47ee81481bf316f388ff8cc | sha=b5d4551662c3d06eedcf3603ddb553548cbf7136 | branch=relay/T068 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 63s
- worktree: branch=relay/T068; sha=b5d4551662c3d06eedcf3603ddb553548cbf7136; 已验收,未合并(是否合并由人工决定)
- 负结果: 发布 tag 只能打在三矩阵 CI 全绿的提交上:本机只有 Node 26,44 个提交的跨版本行为差异(如 node --test 的 NODE_TEST_CONTEXT 注入)只有 CI 矩阵能暴露;先 push 看 CI 再 tag,顺序不能反
- 负结果: 版本号三方必须同步:package.json、plugin.json、CHANGELOG 的 [x.y.z] - 日期段,任一漂移都会让 tag 与制品声明脱节
- 负结果: 发布后出现的修复要进 CHANGELOG 新段而不是塞回已发布的 [2.1.0]:本节 [2.1.1] 记 T064–T067(自更新启动器入库/加固/harness 注册面切换)
- 留给下一个: v2.1.1 已发布(待确认推送后 CI)。仓库无待办;新工作需先与人类定义任务。若再修问题,版本号顺延 2.1.2 并在 CHANGELOG 新段记录。

## 2026-11-27 01:28 | model=hungerg-free | task=T066 完成
- 摘要: T066 收尾 harness 注册面切换并补可执行验收。切换本身在上一轮已执行完毕(逐个备份 .relay-bak-20261127-004651 后纯文本替换,JSON 校验合法),本任务补齐审计指出的两个缺口:(1) T065 完成态标题曾声称「已切换全部 harness」,已在 TASKS 收窄为实际交付并加注说明切换顺延至 T066(历史提交不改写);(2) T066 原验收 git push origin main 不可判定——远端已同步时 Everything up-to-date 退出 0,零交付即绿。改为新增 scripts/smoke-harness-paths.mjs(39 断言,本机专用验收,不接入 npm test 以免 CI 因缺 home 配置而红):14 个注册面逐个断言指向 scripts/relay-mcp-autoupdate.mjs、无 ~/.relay-mcp 旧路径残留、12 个 JSON 配置解析合法。实测 39/0。同时澄清 LOG 历史 T065 条目的 PASS 10(手写快检口径)与 PASS 16(出场全量机检口径)差异。出场前 npm test 27 套 1122 断言全绿、verify PASS 10/WARN 0/ERROR 0。
- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 11·WARN 0·ERROR 0 | 耗时: 66s
- 负结果: 外向动作完成后把「推送+tag」写进 next 会生成已完成的重复任务;已完成的工作应据实关闭而非空跑
- 负结果: 验收行写 git push origin main 不可判定:远端已同步时 Everything up-to-date 退出 0,零交付即绿;交付物是外部配置时验收必须写成可执行检查(本任务改为 test:scripts/smoke-harness-paths.mjs,39 断言钉住 14 个注册面指向仓库内启动器且无旧路径残留、JSON 仍合法)
- 负结果: 任务完成态标题不得声称超出实际交付的内容:T065 曾在切换未做时盖 [x] 声称已切换,下一会话会据此跳过真正的后续任务;事后只能收窄表述并加注,历史提交不改写
- 负结果: 批量替换外部配置文件必须逐个先备份(.relay-bak-时间戳)再替换,JSON 替换后立即校验合法性;纯文本路径替换能保留原格式,JSON.stringify 全量重写会搅动无关字段
- 负结果: 旧路径残留检查要区分活跃配置与备份文件:备份(.relay-bak-*)含旧路径是预期,只证明备份做过
- 留给下一个: T066 已闭环:14 个 harness 注册面全部指向 scripts/relay-mcp-autoupdate.mjs(启动器已随 T067 加固并入库),无旧路径残留,JSON 全部合法,备份在各配置旁(.relay-bak-20261127-004651)。~/.relay-mcp/ 旧启动器已无引用,目录保留。注意事项:LOG 历史 T065 条目摘要的「PASS 10」是手写快检口径,事实行「PASS 16」是出场全量机检口径,以事实行为准。仓库当前无待办,远端已同步;新工作需先与人类定义任务。

## 2026-11-27 01:25 | model=hungerg-free | task=T067 完成
- 摘要: T067 修复自更新启动器 max 级审计的全部 4 major 与可修 minor,并把冒烟重写为隔离夹具行为断言。Major:(1) 分支/worktree 守卫——此前 ff-only 会移动「当前分支」引用,任何落后且无独有提交的任务分支/release 分支/detached HEAD(bisect 现场)都会被静默快进;现在要求 symbolic-ref 必须是 main、git-dir 与 git-common-dir 相同(非 linked worktree)才更新,否则跳过。(2) rev-list 失败曾折算成 0 并 finish(ok) 写 6 小时成功静默;现在「无法判定」一律 fail 并冷却。(3) merge 超时曾 SIGKILL 直杀,残留 index.lock 与半更新工作树后仍启动 MCP;改为 SIGTERM→SIGKILL 并等 close 结算,失败后 postMergeCheck 复核 HEAD ∈ {更新前,origin/main} 且无 index.lock,可疑的树直接拒绝启动 MCP 并给人工恢复命令。(4) TASKS.md T065 完成态夸大(标题声称已切换 14 个 harness,当时实际未做)——标题收窄为实际交付,加注说明切换顺延至 T066 且已于本轮完成。Minor 一并修:git stdout/stderr 分流(porcelain 判定不再被 warning 污染)、状态原子写(临时文件+rename)、预算 NaN/越界夹取([1s,60s])、信号转发后 process.exit 替代自递归重投递(修复 wrapper 永不退出)、merge 后入口存在性+node --check 健康复核(坏上游拒绝启动并给人工恢复命令)、fallback 状态按仓库指纹分目录(worktree 不再共用节流)、stderr 同步写防截断、超时只杀直接 git 子进程的边界写入注释、DECISIONS 补「自动 ff-merge 授权边界」条目(main 自身 vs 任务分支的区分与四重守卫)。冒烟重写为隔离夹具行为断言(18 断言):bare origin+clone+最小 MCP 应答器,覆盖干净落后真快进、本地独有提交不动、预算耗尽不动、非 main 分支不动、无效 REPO exit 2、无参数自推导、合并调用点精确 --ff-only(不再是源码 grep 假绿);probe 超时杀整组并立即结算。另新增 scripts/smoke-harness-paths.mjs(39 断言,本机验收)钉住 14 个注册面指向仓库内启动器,作为 T066 的可执行验收(原「git push origin main」不可判定)。过程中修掉自己三处错误:夹具把启动器提交在 work 侧导致分叉、ff 场景测不到;ESM 套件误用 require;probe 的 scriptPath 需显式参数以测无效 REPO。最终 npm test 27 套 1122 断言全绿(autoupdate 18),verify 双根全绿。
- 事实(v2): mode=managed | 文件 5 | ± +395/-109 | base=73c53671148192b8b6ea492419aacf1ac87f2290 | sha=18d032a7e1353c2ab1c3815560ea63f4332059d1 | branch=relay/T067 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 64s
- worktree: branch=relay/T067; sha=18d032a7e1353c2ab1c3815560ea63f4332059d1; 已验收,未合并(是否合并由人工决定)
- 负结果: 「无法判定」必须 fail-closed:rev-list 失败/预算耗尽曾把 behind 折算成 0 并 finish(ok),写 6 小时成功静默,更新通道静默失效;对照 fetch 失败路径的正确写法可见这是遗漏
- 负结果: ff-only 会移动『当前分支』的引用:不校验当前分支是否 main,任何落后且无独有提交的分支(任务分支/release 分支/detached HEAD 的 bisect 现场)都会被静默快进,用户检出现场被换掉;linked worktree 的任务分支尤其不能自动指到 origin/main(验收通过 ≠ 已合并)
- 负结果: merge 超时不能直接 SIGKILL:git 被杀无法捕获信号,.git/index.lock 残留+工作树新旧混合,后续 session_end 全部失败;必须 SIGTERM 留宽限、等 close 结算,并在失败后复核 HEAD ∈ {更新前, origin/main} 且无 index.lock,可疑的树拒绝启动 MCP
- 负结果: git 的 stdout/stderr 必须分流域收集:混进一条 warning 就会把干净工作树判成 dirty,启动器从此每 10 分钟重试永不更新;计数解析也可能变 NaN
- 负结果: 状态文件必须原子写(临时文件+rename):截断写被并发/被杀打断会丢全部节流;fallback 状态要以仓库路径指纹分目录,否则多个 worktree 共用一份节流互相干扰
- 负结果: 信号转发后不能 process.kill(process.pid, sig) 重投递:它会再次进入自己注册的 handler,wrapper 永不退出,留下孤儿 node 进程;转发后直接 process.exit(按信号定退出码)
- 负结果: 自更新启动器合并后的树不可信:启动 MCP 前必须复核入口存在性 + node --check;坏上游提交不自动 reset(不自动改写用户仓库),给出人工恢复命令并拒绝启动
- 负结果: 冒烟测自更新必须用隔离夹具(bare origin + clone + 最小 MCP 应答器)做行为断言:源码 grep /ff-only/ 是假绿(注释里就有这个词);且启动器提交必须放在 origin 侧再 clone,留在 work 侧会让 work 分叉、wrapper 正确拒绝合并,ff 场景永远测不到(实测踩过)
- 负结果: probe 超时要杀整组并立即结算:wrapper 以 inherit stdio 拉起 MCP 孙进程,只杀 wrapper 时孙进程持有管道,close 永不触发,套件无限挂起
- 负结果: 预算环境变量必须夹取:RELAY_AUTOUPDATE_BUDGET_MS=NaN 会让 setTimeout 退化 ~1ms,每条 git 被立即杀,自动更新静默失效
- 留给下一个: T067 已闭环(max 审计 4 major + 全部可修 minor)。T066(切抰 14 个 harness 注册面)已在上一轮完成,正在本轮一并出账:其验收已改为可执行的 test:scripts/smoke-harness-paths.mjs(39 断言,本机专用,不接入 npm test)。注意 LOG 历史条目 T065 摘要写「verify 双根 PASS 10/WARN 0」而事实行写 PASS 16:前者是 summary 手写口径,后者是出场全量机检口径,以此为准;下不为例。~/.relay-mcp/ 旧启动器已无任何配置引用,目录保留(含历史备份与回滚脚本)。

## 2026-11-27 00:46 | model=hungerg-free | task=T065 完成
- 摘要: T065 把承担全部 harness 更新通道的自更新启动器纳入 relay-mcp 仓库版本控制。背景:14 个 harness 注册面(Claude Code/Desktop/3p、Codex、DeepSeek desktop+web、Gemini、Kimi/Kimi Code、Mavis、MiniMax x2、VS Code、ZCode)的 relay MCP 条目都指向 ~/.relay-mcp/relay-mcp-autoupdate.mjs——一个手工文件,不在版本控制里,换机无法迁移、改动无法 review,且硬编码仓库路径。改动:(1) 复制为 scripts/relay-mcp-autoupdate.mjs,新增「argv[2] 缺席时按 import.meta.url 自推导仓库路径(scripts/../)」,显式传参向后兼容;(2) 新增 scripts/smoke-autoupdate.mjs 11 断言接入 npm test(第 27 套):启动器在位、含 ff-only 逻辑与预算环境变量、可自推导路径、经包装器 initialize 应答 relay-mcp + 语义化版本、无效 REPO exit 2 且报错明确、无参数自推导可启动;SPEC/README 套数同步 26→27,CHANGELOG 新增 [Unreleased] 段。测试要点:冒烟用 RELAY_AUTOUPDATE_BUDGET_MS=1 强制自检快速失败,保证 npm test 期间不会真的 ff-merge origin/main;并清掉 NODE_TEST_CONTEXT(T063 同款教训)。最终 npm test 27 套 1115 断言全绿(新增 11),verify 双根 PASS 10/WARN 0/ERROR 0。剩余(下一步,非本任务):把 14 处 harness 配置的脚本路径切到仓库内新路径——纯配置变更,须逐个备份后替换并实测。
- 事实(v2): mode=managed | 文件 6 | ± +316/-3 | base=fb21ac6498839e0ed002697b7953a7aa10af91c8 | sha=edd5a08e39a2eb531f1ed8deb9ab93185206bbd5 | branch=relay/T065 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 107s
- worktree: branch=relay/T065; sha=edd5a08e39a2eb531f1ed8deb9ab93185206bbd5; 已验收,未合并(是否合并由人工决定)
- 负结果: 承担全部 harness 更新通道的启动器必须进版本控制:它在 ~/.relay-mcp/ 里时换机无法迁移、改动无法 review、git log 查不到为什么改
- 负结果: 启动器必须能从 import.meta.url 自推导仓库路径:否则仓库移动或 worktree 场景下,harness 配置里的第二个参数就变成第二处要同步维护的硬编码
- 负结果: ESM 套件里不能用 require:第一版 smoke-autoupdate 在 ESM 中调 require 读取脚本内容,抛 ReferenceError 被 try 吞成空串,第 1 段 4 条断言全假红;用顶层 import 读取才正确
- 负结果: 冒烟测自更新必须用 RELAY_AUTOUPDATE_BUDGET_MS=1 强制快速失败:否则 npm test 期间会真的 ff-merge origin/main,同一进程树里后面的套件可能跑在新版文件上
- 负结果: 外层 node --test 的 NODE_TEST_CONTEXT 必须在冒烟里清掉:T063 的教训在自更新套件同样适用,子进程退出码语义会被污染
- 留给下一个: 启动器已纳入仓库(scripts/relay-mcp-autoupdate.mjs)并已出验收入库。剩余步骤:合并 relay/T065 到 main 后,把 14 个 harness 注册面(~/.claude.json、~/.zcode/cli/config.json、~/.gemini/settings.json、~/.minimax/mcp.json x2、~/.kimi/mcp.json、~/.kimi-code/mcp.json、~/.mavis/mcp.json、~/Library/Application Support/Code/User/mcp.json、Claude/Claude-3p 的 claude_desktop_config.json、~/.codex/config.toml、~/.dsh/profiles/{desktop,web}/plugins/dsh-mcp-relay-mcp/cordis.patch.yml)里 relay 条目的脚本路径从 ~/.relay-mcp/relay-mcp-autoupdate.mjs 改为 <repo>/scripts/relay-mcp-autoupdate.mjs;逐个先备份 .relay-bak-时间戳再改,改完 grep 确认无残留旧路径并实测 MCP initialize 返回 2.1.0。~/.relay-mcp/ 目录保留(含历史备份与回滚脚本),旧启动器文件不再被引用。

## 2026-11-27 00:12 | model=hungerg-free | task=T064 完成
- 摘要: T064 收尾发布后的清理与状态收拢。(1) 核实 T064 验收四项已全部达成:未推送提交 0、tag v2.1.0 指向 HEAD(ae4af52)、GitHub Release 已发布(非 draft)、CI 三矩阵 22/24/26 全 success——该任务本是上一轮 next 字段自动生成的重复登记,据实关闭而非空跑。(2) worktree 清理:11 个任务 worktree 全部删除(先手工移除 T048/T061 里 relay_sync 遗留的 *.relay-bak-* 备份,它们是唯一让 cleanup 判定不干净的 ignored 内容),registry 清空为 worktrees:[],空的 .relay/worktrees/ 目录一并移除。(3) 分支清理:15 个 relay/* 分支逐个确认 ahead=0 后用 git branch -d 安全删除(T031–T034、T048、T050–T054、T058–T063);git worktree list 现只剩主工作树。(4) R12 的 LOG 边界超限(156 行 > 150)用 relay_archive_log 归档 7 条历史条目到 docs/archive/LOG-2026-09-11.md,活跃区降到 96 行/8 条,指针保留且归档只移动不删除。(5) 清理后 verify 全绿 PASS 10/WARN 0/ERROR 0,R10 正确识别「分支已合并删除」并给 PASS 带注记,npm test 26 套 1104 断言通过。仓库现已收拢到 v2.1.0 且无残留分支/worktree。
- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 11·WARN 0·ERROR 0 | 耗时: 103s
- 负结果: relay_session_end 的 next 字段会生成新任务行:发布完成后若把「推送+tag+Release」写进 next,下一轮会拿到一个已经做完的重复任务;外向动作完成后应收尾成「无待办」而不是留给下一棒
- 负结果: worktree 清理会保留含 ignored 本地内容的目录:relay_sync 每次重投影入口都会生成 *.relay-bak-* 备份(已在 .gitignore 基线),它们会让 cleanup 判定「不干净」而保留;确认无价值后先手工删备份再重跑 cleanup
- 负结果: git branch -d 是删除已合并分支的安全闸:全部 15 个 relay/* 分支 ahead=0 才批量删除,-d 会在未合并时拒绝而不是强删
- 负结果: R10 能正确识别「分支已合并但已删除」:完成提交仍在当前分支历史时给 PASS 并带注记,不需要保留分支来维持事实对账
- 留给下一个: v2.1.0 已发布(远端 main 同步,三矩阵 CI 全绿,GitHub Release 已建)。worktree 与 relay 分支已全部清理,registry 为空。R12 已通过归档降到 96 行/8 条。仓库当前无待办;下一个会话可直接 relay_session_start 查看状态,若要开新工作先与人类定义任务。

## 2026-11-26 22:55 | model=hungerg-free | task=T060 完成
- 摘要: T060 完成发布前可做的全部代码面工作:CHANGELOG 从 [Unreleased] 定版为 [2.1.0] - 2026-11-26,并把本轮全部实质修复写进 Fixed(T061–T063) 段——重点是三条安全/正确性修复:验收门 NODE_TEST_CONTEXT 绕过(relay 跑在 node --test 里时嵌套 runner 跳过执行并 exit 0,失败/伪装测试文件反而变绿,整道 H-A 防线失效)、提交消息锚点被 80 字上限截断导致 R10 反查失败、以及 done_tasks[] 的三条 fail-open;另含旧接力单 harness 兼容回归、快照密钥扫描文件名旁路、dispatch 状态卡死、report 锁释放顺序。规模段同步为真实数字(smoke 124、rescue 174、sqlite 27、autolaunch 53、budget 37;npm test 26 套 1104 断言)。版本号三方一致(package.json 2.1.0、plugin.json 2.1.0、CHANGELOG [2.1.0] - 2026-11-26)。verify 双根全绿(R3 11 个 md 合规、R11 无密钥),npm test 26 套 1104 断言通过。未执行(需人工授权的外向动作):git push、打 tag v2.1.0、建 GitHub Release、观察 Node 22/24/26 三矩阵 CI。本机只有 Node 26,矩阵验证必须靠 CI。
- 事实(v2): mode=managed | 文件 1 | ± +10/-3 | base=3fa1539eba7f23bfbecda963c9b6cdd95b6e1b75 | sha=af2c779db0e326579b64a7d53d729d8aa1058631 | branch=relay/T060 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 92s
- worktree: branch=relay/T060; sha=af2c779db0e326579b64a7d53d729d8aa1058631; 已验收,未合并(是否合并由人工决定)
- 负结果: 发布链分两步:CHANGELOG 定版与版本号同步属于代码面(可以走任务分支),推送/tag/GitHub Release 是外向动作,必须单独获授权后执行
- 负结果: CHANGELOG 必须把「验收门 NODE_TEST_CONTEXT 绕过」写进 Fixed 段:它是 2.1.0 里唯一的安全级修复,漏写会让升级方无从判断是否需要立即跟进
- 负结果: 版本号同步要核对三个面:package.json、plugin.json、CHANGELOG 的 [x.y.z] - 日期段;三者不一致会让发布 tag 与制品声明脱节
- 负结果: 发布前不得只依赖本机 Node 26:CI 矩阵 22/24/26 是唯一能证明跨版本行为的证据,node --test 这类行为差异正是版本矩阵该捕获的
- 留给下一个: CHANGELOG 已定版 [2.1.0] - 2026-11-26,package.json/plugin.json 均为 2.1.0。推送后需观察 Node 22/24/26 三矩阵 CI(.github/workflows/ci.yml),三绿后在 GitHub 建 v2.1.0 Release(正文引用 docs/04-test/10、11、12 三份审计报告与本轮 T061–T063 修复)。出隔断确认:本机只有 Node 26,三矩阵必须靠 CI。

## 2026-11-26 20:12 | model=hungerg-free | task=T063 完成
- 摘要: T063 收口 T062 复验三条残留,并修掉一个真实验收门绕过。D1(LOG 摘要原地手改):按 T046 口径在 controlRoot DECISIONS 记明校正与依据(保留而非回退的理由、原文、约束);smoke 加间接约束——DECISIONS 必须含「引擎写的协议行不得原地改写」与「校正与依据」,LOG 每条「- 注:」须写明依据并可关联任务号,并有无依据说明会被判负的反向对照;明确声明摘要行是否被改过本身无法机检。协议面检查改为显式读 controlRoot(RELAY_CONTROL_ROOT 或从 .relay/worktrees/T### 回溯),避开 worktree 里的过期副本。D2(多任务提交消息截断):renderCommitMessage 把 {{task}}/{{taskId}} 视为不可截断锚点,只裁 summary 其次 evidence;新增 N=2/6/7/8/12、summary 超长仍保留全部任务号、单任务逐字符不变等断言。D3(T048 历史值):核实只有 zcode/claude 真实写入过,explicit 仅出现在比较分支、从无赋值点;注释与 controlRoot LOG 表述同步更正。额外发现并修复:验收门执行 node --test 未剥 NODE_TEST_CONTEXT,外层 node --test 注入它后嵌套 runner 跳过执行并 exit 0,失败/伪装测试文件反而变绿,整道 H-A 防线失效;已在 runCmd 剥离该变量并加断言(原生 spawnSync 注入,撤销修复实测变红)。过程中修掉自己四处错误:renderCommitMessage 初版把 evidence 也算不可裁锚点;NODE_TEST_CONTEXT 断言因 spawnSync2 只收两参而静默未注入 env;把 LOG/DECISIONS 改在 worktree 里被 session_end 以协议文件改动拒绝;D1 断言读 worktree 过期 LOG 而假红。最终 npm test 26 套 1104 断言全绿,node --test scripts/smoke.mjs 真绿(124 断言,此前 120/2),verify 全绿。
- 事实(v2): mode=managed | 文件 4 | ± +149/-11 | base=5518a447a594733145e7c08a07f14d987c69f56b | sha=93842d7f76f9e165bd8961ebca9cdcc1a35fc0f8 | branch=relay/T063 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 67s
- worktree: branch=relay/T063; sha=93842d7f76f9e165bd8961ebca9cdcc1a35fc0f8; 已验收,未合并(是否合并由人工决定)
- 负结果: 引擎写的协议行不得原地改写:更正须另起回填条目或回退交引擎重写,并在 DECISIONS 记依据;R10 机检面只到事实行,摘要与负结果无任何机检
- 负结果: 提交消息截断不能按字符数一刀切:{{task}}/{{taskId}} 是 R10 反查完成提交的唯一锚点,必须不可截断;只裁 summary 其次 evidence,单任务渲染逐字符不变
- 负结果: 验收门跑 node --test 必须剥掉 NODE_TEST_CONTEXT:外层 node --test 会注入它,嵌套 runner 跳过执行并 exit 0,失败测试反变绿,整道 H-A 防线失效
- 负结果: 断言必须验证它真能失败:第一版 NODE_TEST_CONTEXT 断言仍绿,因为本地 spawnSync2(cmd,args) 只收两参、第三个 env 被静默丢弃;换原生 spawnSync 并撤销修复实测变红才有效
- 负结果: 协议面(LOG/TASKS/DECISIONS)只能在 controlRoot 改,不能在任务 worktree 改:worktree 里的副本是检出快照,改了会被 session_end 以『executionRoot 出现协议文件改动』拒绝,且检查协议面的断言必须显式指到 controlRoot(RELAY 不在 worktree 里时用 RELAY_CONTROL_ROOT 或向上回溯)
- 负结果: 并行跑多个 smoke 套件会造成资源竞争:autolaunch 的 300ms 超时用例在负载高时假红,隔离后连跑 3 次 53/0 稳定
- 负结果: NODE_OPTIONS=--test 不是真实绕过面:Node 直接拒绝;断言应写『两条路都 fail-closed』
- 留给下一个: T063 已闭环。发布链 T060 待人工授权:推送全部提交、Node 22/24/26 三矩阵 CI(本机只有 Node 26)、CHANGELOG 定版、tag v2.1.0、GitHub Release。D8 对历史 T055–T057 的 WARN 是有意保留的诚实偏差(DECISIONS 2026-11-26 T061 条),不是回归。

## 2026-11-26 16:49 | model=hungerg-free | task=T062 完成
- 摘要: T062 修复 done_tasks[] 三条 fail-open 缺陷,并收掉独立复审(T059 修复)报告的遗留问题。(1) done_tasks 非空而 done_task 缺席时原本 TASKS 不盖戳/LOG 只写 task=无/认领锁不释放,却仍报「绿闸:通过」→ 改为 isError 拒收;(2) 额外任务号在 TASKS 中不存在会写出幽灵完成条目(R9 只比对最新条目看不见,R7 反计一次完成)→ 写盘前校验存在性并拒收;(3) 提交消息只含主任务号,额外任务条目顶到 LOG 首位时 R10 的 git log --grep 反查失败 → 逐任务带「T### 完成」。复审回收:旧卡 harness 兼容此前是假绿(测试伪造了旧版从不写的 harness='jsonl-agent';真实值只有 zcode/claude(explicit 仅出现在比较分支、从无赋值点),映射移到描述符层 legacyProfileFor);快照密钥扫描的文件名旁路改用 porcelain -z;dispatch 占位永久卡死改为失败回写终态 + 未知 status fail-closed + 无 pid 超 120s 宽限;report 改为先写 state 再释放锁并支持回滚;worker 同步 spawn 失败也删除含 prompt 的临时配置。过程中自己引入并修掉两个回归:doneTaskIds 前移后引用顺序没跟上(所有 session_end 抛 ReferenceError);T062 原验收 test:scripts/smoke.mjs 在 node --test 下自指干扰(基线即有 2 条 H-A 假红),改用 npm test。npm test 26 套 1089 断言全绿,verify PASS 12/WARN 0/ERROR 0。
- 注: 本条目首版摘要误写为「验收诊断2」——当时把 relay_session_end 当成只读的验收检查来复跑,但它本身就是出场动作,已真实出场。这是操作失误,不是工具缺陷;内容在此更正,历史提交不改写(校正依据见 DECISIONS 2026-11-26 T063 条)。
- 事实(v2): mode=single | 文件 7 | ± +305/-86 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 145s
- 负结果: relay_session_end 不是只读的验收检查:它就是出场动作,复跑会真实提交并盖戳;诊断验收门应看 isError 与输出,不要用同一条命令试跑
- 负结果: 验收行不能写 test:scripts/smoke.mjs:该套件测的正是「验收门拒绝伪装/逃逸测试文件」,在 node --test 下自指干扰,基线即有 2 条 H-A 假红(git stash 复现确认);应写 npm test
- 负结果: 旧卡兼容必须先查真实历史值:把 harness 映射写进核心既违反零 harness 名(被 smoke 6f 抓住),又因测试伪造旧版从不写的值而假绿;真实值只有 zcode/claude/explicit
- 负结果: porcelain 行不能 split(' -> ') 手工解析:含引号/反斜杠/换行/字面箭头的文件名会被当「已删除」跳过,而 git add -A 仍暂存其内容;必须用 -z
- 负结果: 先发布 running 占位就必须有收尾人:占位后任何抛错会让 dispatch.json 永久停在 running;未知 status 也会被当成「没有任务」
- 负结果: done_tasks[] 的三条 fail-open 同一个错误:新增入口只接了主路径,缺 done_task 时工具报「绿闸通过」却一字节不记
- 负结果: 断言必须能失败:report 半写用例的卡从未 takeover,在持有者校验就返回,根本走不到 dispatchBusy 守卫

<!-- relay:log-archive: docs/archive/LOG-2026-09-11.md -->
