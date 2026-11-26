# 会话日志(最新在上)

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

## 2026-11-26 14:01 | model=hungerg-free | task=T061 完成
- 摘要: T061 收尾第二轮审计遗留的两件事。(1) autoLaunch prompt 脱敏:注入 argv 的每个占位符变量(含 transcript 派生的 prompt)在替换前统一过 redactSecrets,并显式报告脱敏处数;argv 会出现在 ps/进程审计里,比 .relay/rescue/ 更难清理。补 9 条断言:含密钥 prompt 时 argv/dispatch.json/dispatch.log 均无原文、非密钥部分保留、脱敏可见。原 Finding #2 的 argv 半句至此真正闭环(dispatch.json 从不存 prompt 这半句本就成立,报告已校正)。(2) D8 证据缺口:核实 completionIdsOf 只读 LOG 标题行的 task= 字段,我在附录 B 里『附录第 5 条不成立』的更正是错的,已撤回并新增附录 C 记录根因与处置。根因是 relay_session_end 只接受单个 done_task,一次交付多任务无法留逐任务证据。按用户决定实现 done_tasks[]:每个任务各得独立 LOG 完成条目、自己的 [x]、自己的认领锁释放与各自验收门;仅单根(受管 worktree 拒绝,成对证据无法凑齐)。探针实测 D8 从 WARN 变 OK。历史 T055–T057 缺口按 DECISIONS 决定保留可见,不回填——手写完成条目与引擎条目不可区分,正是 R10/D8 要防的假绿。同步 CONTRACT/README/skills/AGENTS 模板/DECISIONS/CHANGELOG,relay_sync 重投影。修复过程中自己的改动引入一个回归:LOG 幂等去重改成无条件按 (model,task) 全局比对,导致维护出场被误判重复、LOG 不写、提交不发生(smoke-patches P6 挂掉);已改为仅在任务实际已完成时去重。最终 npm test 26 套 1074 断言全绿,verify 双根 PASS 10/WARN 0/ERROR 0,tools/list 10218/10240。
- 事实(v2): mode=managed | 文件 12 | ± +281/-68 | base=89c1722ef49d941ad01f85aebae561acbf533d09 | sha=8630fde3f383cfc072f479d3f4894004cb340f5e | branch=relay/T061 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 144s
- worktree: branch=relay/T061; sha=8630fde3f383cfc072f479d3f4894004cb340f5e; 已验收,未合并(是否合并由人工决定)
- 负结果: D8/R9 的取证只读 LOG 标题行的 task= 字段(DONE_TASK_RE=^T\d+\s*完成$),摘要正文提到别的任务号不构成证据;我先前采信『T054 条目正文覆盖 T055-T057』是错的,附录 B 的更正已撤回
- 负结果: 手写 `## ... | task=T055 完成` 与引擎写出的条目不可区分,正是 R10/D8 要防的假绿:历史缺口只能由人批准后回填,不能为了让 WARN 消失而补记
- 负结果: 受管 worktree 无法支持 done_tasks[]:成对证据要求『一个任务 = 一条分支 + 一条 registry 记录』,多任务同时出场只能凑出半套证据
- 负结果: LOG 幂等去重不能无条件按 (model, task) 全局比对:维护出场(task=维护/无)会在同一仓库重复出现,那样会把第二次维护出场误判为重复,导致 LOG 不写、提交不发生(smoke-patches P6 实测挂掉)
- 负结果: autoLaunch 的 argv 会出现在 ps/进程审计里,比 .relay/rescue/ 更难清理:transcript 派生的 prompt 必须在替换占位符之前脱敏,且脱敏发生处数要显式报告
- 负结果: tools/list 预算只能靠压缩低频描述腾出:加 done_tasks 字段后超 167 字节,压 relay_rescue/init/onboard 的冗余措辞才回到 10218/10240
- 留给下一个: T061 已交付:done_tasks[] 多任务出场 + autoLaunch prompt 脱敏。发布链仍是 T060。特别注意 D8 仍会对历史 T055–T057 报 WARN——这是有意保留的诚实偏差(见 DECISIONS 2026-11-26 T061 条),不是回归;新交付不会再复现,探针实测 D8 OK。若要消除该 WARN,须由人批准后按 T046 先例补记。发布前还需:推送并观察 Node 22/24/26 三矩阵 CI(本机只有 Node 26)、CHANGELOG 定版、tag、GitHub Release。

## 2026-11-26 12:58 | model=hungerg-free | task=T059 完成
- 摘要: T059 复核并修复第二轮审计的全部确认缺陷(原 15 条 + 7 条附录 + 复审新发现 2 条)。核心修复:(1) 快照密钥扫描前移到 git add/write-tree 之前,拒绝时对象库不残留 blob;扫描面超过 500 文件改为整体拒绝而非截断。(2) 接力锁 token 持久化进 state.json,report 用真实 token fencing 释放,释放失败即 isError 且保留 takeover;takeover 锁生命周期收敛到统一 finally。(3) dispatch.json 改临时文件+rename 原子发布,损坏态按 invalid→busy,takeover/report/drop 全部 fail-closed;父进程不再回写 state。(4) worker 用 detached 进程组 + kill(-pid) 终止整棵树,并加「超时+8s」有界结算兜底。(5) 分类器只依据最后一个有效轮次:早期 completion 作废、恢复后的 429 不再判 quota、工具报错后的分析文本不再洗成完成;新增 parseIssues 让行级损坏降级为 error。(6) SQLite 的 maxRows 下推 SQL LIMIT,jsonParse 返回 {value,ok},tool_result 按终态生成并安全序列化对象输出。(7) scan 归属推断改为先 stat 再有界前缀读 cwd。(8) 旧卡 harness→profile 映射、显式 metadata.json source、drop/edits 用 snapshotRoot、drop 识别过期锁。(9) autoLaunch 配置校验前移到任何 TASKS/state 写入之前。(10) fieldMap 的 roleMap/嵌套路径/对象型 apiErrorMarker 全部接通。文档:README 默认零扫描口径、CHANGELOG 补齐 T050/T051/T058 与本轮修复、CONTRACT 新增 T059 契约段、审计报告加附录 B 复核校正与闭环矩阵。验证:npm test 26 套 1056 断言全绿(抢救 172+27+40),relay_verify full PASS 11 WARN 0 ERROR 0, tools/list 10219/10240。
- 事实(v2): mode=managed | 文件 12 | ± +1163/-274 | base=4f1bdda730dbc99f9315976ce5920dd4d87a6970 | sha=19836a7d5d0b7d01d11de86a485a7304bcc5f175 | branch=relay/T059 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 55s
- worktree: branch=relay/T059; sha=19836a7d5d0b7d01d11de86a485a7304bcc5f175; 已验收,未合并(是否合并由人工决定)
- 负结果: 快照密钥不能只靠「文件名规则 + 事后 diff 扫描」:扫描必须在 git add/write-tree 之前,否则拒绝时 blob 已进对象库
- 负结果: 按前 N 个文件截断扫描不会降低风险:未扫描的文件照样会被 git add -A 暂存,只能整体拒绝
- 负结果: 接力锁 token 必须随 takeover 一起持久化进 state.json:没有 token 的释放必然失败,而『报成功但留着锁』比直接报错更糟
- 负结果: dispatch.json 不能用 writeFileSync 截断覆盖:半写会被读成『没有任务』,必须临时文件+rename,损坏态一律按 busy fail-closed
- 负结果: worker 超时只 kill 直接子进程不够:孙进程继承管道会让 close 永不触发,必须 detached 进程组 + 有界结算兜底
- 负结果: 分类器的 explicitCompletion/apiError 不能是『一旦置位就永远为真』:只认最后一个有效轮次,否则早期 end_turn/429 会掩盖真正的中断
- 负结果: 工具报错后只输出分析文本不算恢复:trailingToolError 必须保持到成功结果或明确收尾
- 负结果: SQLite 行内 JSON 损坏不能当空对象继续分类:必须变成显式 parseIssue 并降级为 error
- 负结果: SQLite 的 maxRows 必须下推到 SQL LIMIT:先 .all() 再比较等于上限形同虚设
- 负结果: scan 归属推断不能先整份读 transcript:先 stat 再有界前缀读 cwd,否则大文件在 maxBytes 检查前就 OOM
- 留给下一个: T052–T058 的功能与第二轮审计修复均已合并到 main 并通过本机 26 套测试(1056 断言)。发布前需人工决定:版本号是否维持 2.1.0、CHANGELOG 是否把本轮修复并入同一版本、是否推送并观察 Node 22/24/26 三矩阵 CI(本机只有 Node 26,CI 未覆盖当前 HEAD)。tag/Release 属人工授权动作。

## 2026-11-26 09:26 | model=hungerg-t051 | task=T051 完成
- 摘要: T051 完成 manifest 声明的通用自动拉起，保持核心不为任何具体 harness 开发。新增 src/engines/rescue-launch-worker.mjs 独立 detached worker：takeover 后按 manifest.rescue.autoLaunch 的 argv 数组启动子进程(shell:false)，worker 负责 stdout/stderr→dispatch.log、生命周期→dispatch.json(running/completed/failed/timed_out)、超时 SIGTERM→2s 后 SIGKILL、输出字节上限。autoLaunch 默认关闭；command 必须是非空非 NUL 字符串数组；cwd realpath 必须在 controlRoot 内；支持 {{prompt}}/{{root}}/{{task}}/{{rescueId}}/{{model}} 占位符，原样替换不经 shell,prompt 里的 ; touch 等元字符不会被执行。配置非法在启动前 fail-closed，撤销移交、释放接力锁、不写 dispatch。dispatch running 时 report/drop 被拒；同一卡已有 dispatch 不重复启动；show 展示 dispatch 状态。顺带修复一个通用数据建模缺陷：metadata candidate 的 profileId(agent 类型)占用了 profile 字段，覆盖格式描述符 id，导致 metadata 卡 fallback 到 jsonl-agent、running/failed 被误判 complete；改为 agentType 独立字段，格式描述符 id 由 scanSources 强制设置。纯元数据来源现在物化最小 JSONL(user prompt + status/error)，原始任务可哈希校验、可供 {{prompt}} 使用，同时保留 transcriptless 标记让状态分类仍以 metadata 为权威。新增 scripts/smoke-rescue-autolaunch.mjs 26 断言并接入 npm test(26 套)，覆盖默认关闭、argv 原样传递、shell 元字符不执行、状态/日志、幂等、运行中 report/drop 拒绝、超时、非法 command/cwd、核心零 harness 名。npm test 26 套全绿，auto-launch 26/0、rescue 133/0、SQLite 22/0，verify 双根全绿，tools/list 10219/10240。
- 事实(v2): mode=managed | 文件 11 | ± +533/-26 | base=96ed65dbe8011fc085fe9c9c77b2fd1ac0aedc28 | sha=6fe04b16e9e695c043f10a590571b4a27d208017 | branch=relay/T051 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 58s
- worktree: branch=relay/T051; sha=6fe04b16e9e695c043f10a590571b4a27d208017; 已验收,未合并(是否合并由人工决定)
- 负结果: 自动拉起必须在 manifest 明确启用:默认启动任意命令风险不可接受;未配置时 takeover 只生成接力单。
- 负结果: command 必须是 argv 数组且 shell:false;经 shell 拼接 prompt 会把 transcript 注入升级成命令执行。
- 负结果: metadata 的 profileId 是 agent 类型,不能占用格式描述符 id 字段;否则 candidate 会 fallback 到错误描述符,把 running/failed 误判为正常完成。
- 负结果: 纯元数据卡也要物化最小任务记录:否则自动拉起的 {{prompt}} 无源、原始任务无法哈希校验;但仍须保留 transcriptless 标记,让状态分类以 metadata 为权威。
- 负结果: dispatch running 时 report/drop 必须拒绝;否则会删掉正在执行的任务与唯一现场。
- 留给下一个: 所有功能与审计修复已合并 main。发布版本/tag/GitHub Release 属人工授权动作;当前 package.json/plugin.json 为 2.1.0,发布前需人工确认版本策略与 CHANGELOG 定版。

## 2026-11-26 09:06 | model=hungerg-t050 | task=T050 完成
- 摘要: T050 完成通用只读 SQLite 会话抢救，同时保持 T058 的「核心不为任何具体 harness 开发」。新增 src/engines/rescue-sqlite-profile.mjs，实现 kind=sqlite-conversation 描述符：表名/列名/session-directory 字段/message-part 关联全部由 manifest.rescue.profiles 纯 JSON 声明，核心不认识任何具体库 schema。node:sqlite 用 readOnly:true 打开、查询后 close，绝不写库；受控 SQL 标识符白名单(拒绝 SQL 关键字/非法字符)；message.data.error 为嵌套 JSON 字符串时二次 JSON.parse 后取出 code/statusCode/name，进入统一 toolSignals.apiError，复用 quota/error 分类；session/message/part 物化为标准 JSONL，工具调用与结果拆成 assistant(tool_use)/user(tool_result) 两条记录，step_finish(reason=stop)/stop_reason=end_turn 作为明确正常收尾信号；message/part 行数受 maxRows 限制、物化字节受 manifest.rescue.maxBytes 限制，超限显式失败不静默截断；库损坏/缺表/模块不可用由 scan「说明」明确报告，不静默变 0 候选。描述符新增可选 loadTranscript(candidate) 接口，核心只负责读取字节→hash→parse→capture，文件读取仅是默认路径；resolveAllProfiles 改异步以懒加载 SQLite 模块，未配置该 kind 的项目不付 import 成本。顺带修两个通用缺陷：(1) describeCandidate 对象里 profile 键重复；(2) fence() 改为不可信文本逐行加 │ 前缀，彻底阻断任意长度反引号逃逸(比固定三反引号转义更可判定)。新增 scripts/smoke-rescue-zcode-db.mjs 22 断言并接入 npm test(25 套)，覆盖只读文件不变、quota 分类、完整任务/show/takeover、正常完成不误报、损坏/空库/maxRows、核心零 harness 名。原 rescue 套件 133/0，npm test 25 套全绿，verify 双根全绿。
- 事实(v2): mode=managed | 文件 10 | ± +611/-39 | base=f4d297b53a0acce19b4be638a3cd33408c8d826b | sha=a499c25c9301591ace17f0624b958ef0fbe1f216 | branch=relay/T050 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 57s
- worktree: branch=relay/T050; sha=a499c25c9301591ace17f0624b958ef0fbe1f216; 已验收,未合并(是否合并由人工决定)
- 负结果: SQLite 描述符不能写死首个用户的表名/列名/错误字段:那会重新引入 T058 禁止的 harness 特例。schema 只能由 manifest 的纯 JSON 声明。
- 负结果: 固定三反引号围栏不安全:payload 含四反引号或恰好以三反引号开头时可逃逸。改为逐行加 │ 前缀,保证 payload 不可能出现行首围栏标记。
- 负结果: 工具调用与结果必须拆成 assistant(tool_use)/user(tool_result) 两条记录;塞在同一条 assistant 内容里会导致 pendingToolUse 永远删不掉,正常完成被误判为悬空。
- 负结果: 正常完成必须有明确信号(end_turn/stop/step_finish),否则历史残留 tool_use 会让分类器误判;这个信号由描述符从来源状态映射,核心不感知具体 schema。
- 负结果: node:sqlite 是 Node>=22.13 才可用;不可用时要明确报告,不能静默跳过或伪造转录损坏。
- 留给下一个: T048 只交付「接力单 + 可派发的接力提示词」。自动化需先决定:命令执行面(信任边界,参考 acceptance.commands 的逐字符签字)、后台进程生命周期与回收、重试上限、以及与 relay 认领锁/接力锁的衔接。开工前先记 DECISIONS(减法问)。注意 T058/T050 已确立「核心不为任何具体 harness 开发」,该任务同样不得绑定特定 harness 的 CLI 或启动方式。对应任务 T051。

## 2026-11-26 08:46 | model=zcode-deepseek-t058 | task=T058 完成
- 摘要: T058 抢救引擎通用化：核心零 harness 耦合。新增 src/engines/rescue-profiles.mjs 描述符层，把「在哪找、怎么读」从核心彻底移出：(1) 描述符契约 {id,title,roots,discover,parse,transcriptless}，discover 返回统一候选、parse 返回统一摘要(含 toolSignals)；(2) 三种接入方式——内置参考描述符(jsonl-agent 一行一条 JSON / json-meta 纯元数据目录)、声明式(manifest.rescue.profiles 纯 JSON，kind=jsonl-message|json-metadata + fieldMap)、函数式(宿主注入 _profiles)；(3) 核心 rescue.mjs 现在零 harness 专有名(注释也算)、零硬编码安装路径，原 31 处耦合全部消除；(4) 默认不扫描任何目录——未声明 manifest.rescue.sources 时 scan 不读 home、不猜安装位置，来源一律显式；(5) 归属 fail-closed(既无 cwd 又无 transcript 佐证的候选跳过并说明)；(6) 分类只看描述符归一后的 toolSignals，不再感知任何 harness 语义；(7) state 用 profile 记录来源描述符 id，未注册时 show/takeover 明确报错而非静默降级。测试全部从 RELAY_RESCUE_HOME 环境变量改为声明式 sources + 自定义描述符(与真实用户用法一致)，并新增 6f 架构段 8 条断言：核心零 harness 正则扫描、不硬编码安装目录、注册表导出、声明式支持、默认零扫描、以及「用一份从未见过的 brand-new 描述符验证不改核心代码即可发现并正确分类」。修复过程中还发现描述符层缺少 import 导致 discover 被 try/catch 静默吞成空结果(与审计对「异常静默吞掉」的警告同型)。rescue 套件 134 断言全绿(连跑 3 次稳定)，npm test 24 套全绿，verify 双根全绿，tools/list 10075/10240。
- 事实(v2): mode=managed | 文件 8 | ± +802/-351 | base=d63d210cac90c1d0fc247d5edd71bed94cd134b9 | sha=ff71159d572d1a561477bd633f80141385e87674 | branch=relay/T058 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 59s
- worktree: branch=relay/T058; sha=ff71159d572d1a561477bd633f80141385e87674; 已验收,未合并(是否合并由人工决定)
- 负结果: 核心一旦硬编码具体 harness 就不再通用:判断「是不是 API 错误、有没有悬空工具调用」是结构问题,不是 harness 语义问题;抽成描述符后核心的分类/快照/锁/协议写入全部与 harness 无关。
- 负结果: 描述符层漏了 import 时,discover 的异常被 try/catch 静默吞成「0 候选」,表现为「扫描正常但找不到任何东西」——与审计点名的「异常静默吞掉」同型缺陷,必须靠直接单测 discover 暴露。
- 负结果: manifest 只能存 JSON,函数无法序列化:自定义描述符必须支持**声明式纯数据**形态(kind + fieldMap),否则用户根本无法在自己的项目里注册新 harness。
- 负结果: 测试夹具不应依赖环境变量(RELAY_RESCUE_HOME)注入来源:那会让核心保留一条绕过 manifest 的配置通道,违反「配置面只在 manifest」铁律。改用 manifest.rescue.sources 后,测试与真实用法一致。
- 留给下一个: T048 只交付「接力单 + 可派发的接力提示词」。自动化需先决定:命令执行面(信任边界,参考 acceptance.commands 的逐字符签字)、后台进程生命周期与回收、重试上限、以及与 relay 认领锁/接力锁的衔接。开工前先记 DECISIONS(减法问)。注意 T058 已确立「核心不为任何具体 harness 开发」,该任务同样不得绑定特定 harness 的 CLI 或启动方式。对应任务 T051。ZCode SQLite 抢救为 T050(需人类授权,且应实现为**声明式描述符的一种**,而不是核心特例)。

<!-- relay:log-archive: docs/archive/LOG-2026-09-11.md -->
