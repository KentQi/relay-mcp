# 会话日志(最新在上)

## 2026-11-26 00:29 | model=zcode-deepseek-t052 | task=T052 完成
- 摘要: T052 修复审计确认的 4 条信任边界缺陷，全部先红后绿。#1 单一真相源：从 state.json 删除 prompt/lastNarrative/classification 三个可派生字段（它们绕过 sha256 校验、构成第二真相源），改为每次读取时从**已校验**的 transcript 重新派生；loadTranscript 的 `if (state.sha256 && …)` 改成空哈希 fail-closed。renderCard/actTakeover/actShow 全部改为接收 derived 参数，chainWarn 也从上一棒已校验 transcript 派生。#2 围栏逃逸：新增 neutralizeFence，把 payload 里的三反引号转义为 `\`\`\`，fence() 统一走它——不可信文本无法再自行闭合围栏把注入推到指令位。#11 命令脱敏：三处命令出口（卡片「跑过的命令」、view=commands、接力提示词）与 edits[].path 全部过 redactSecrets，此前它们是唯一未脱敏的 transcript 派生字段。#12 agentId 净化：写 TASKS 前对 agentId 做控制字符→空格 + 折叠空白 + 截断（与 session.mjs 对 model/task 的口径一致），换行不再能伪造任务行。顺带删掉审计点名的 3 处假绿断言（恒真的三元、对未创建 ref 的检查、被 if 包住永不执行的死分支）。新增 6b 信任边界测试段（16 条断言，含 ZCode metadata.json 的 agentId 注入夹具）。npm test 24 套全绿、verify 双根 12P+4P 全绿。
- 事实(v2): mode=managed | 文件 2 | ± +164/-35 | base=de146a754eaf4c70ec90c02ec33179a45d52371a | sha=1a47ad43c46a9717b1bec87511fa9b6119d31cb8 | branch=relay/T052 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 69s
- worktree: branch=relay/T052; sha=1a47ad43c46a9717b1bec87511fa9b6119d31cb8; 已验收,未合并(是否合并由人工决定)
- 负结果: state.json 里存的 prompt/classification 是「自指校验」：期望哈希就存在同一份未受保护的文件里，任何能写该目录的进程同时改 transcript 与 state.sha256 即可通过；而哈希为空时旧代码 `if (state.sha256 && …)` 会静默跳过整道检查。正确做法是不落盘可派生字段 + 空哈希 fail-closed。
- 负结果: 围栏转义不能只做「标记成对」检查：转义前后三反引号计数都是偶数，必须逐行扫描「是否处于围栏内」再判断注入文本的位置。
- 负结果: ZCode 的 agentId 来自 metadata.json（外部可控），Claude Code 的 agentId 取自文件名（相对安全）；注入测试必须用 ZCode 夹具才能真正覆盖。
- 负结果: 断言 `restoreRef.includes(...)` 这类对被删变量的引用会在删代码后变 ReferenceError；删假绿断言时要连带清理其依赖的变量声明。
- 留给下一个: 见 docs/04-test/09-audit-rescue-t048-v1.0.md #3。两个方向都要修:(a) 子代理死在「tool_result 已落盘、下一轮 assistant 未开口」时末条是 user 记录,现判 complete → 不可抢救,正是本工具核心场景;(b) 只要历史出现过一次 is_error 就判 error → 正常完成的也被列为可抢救。修法:danglingToolUse 改为「末条 assistant 前存在未配对 tool_use」;末条为 user(tool_result) 且无后续 assistant 回应 → interrupted;toolError 只看末尾相邻。夹具补「末条是 user」与「历史报错但正常完成」两种形状。对应任务 T053。

## 2026-11-25 23:36 | model=zcode-step5preview-t048 | task=T048 完成
- 摘要: T048 落地子代理抢救与接力 relay_rescue：新增 src/engines/rescue.mjs（scan/capture/show/takeover/report/drop，action 驱动，写盘仅在 confirm）。scan 自动发现本项目在 ZCode 与 Claude Code 下的失败/中断子代理，归属按记录 cwd 两侧 realpath 判定（800 个他项目子代理被正确跳过）；capture 把 transcript 副本 + 工作区未提交改动的 git 对象快照（临时 GIT_INDEX_FILE + read-tree/add/write-tree/commit-tree/update-ref）落成本机接力单 .relay/rescue/<id>/，不动 index/工作区/HEAD/stash；state.json 只存不可派生锚点，其余每次从 transcript 即时派生并校验 sha256（篡改即 isError）；takeover 用独立接力锁（240min TTL、同 model 幂等、token fencing）移交派发权并在 TASKS 待办区登记接管任务，report 回写并释放；确定性中断分类 quota/error/interrupted/complete（complete 不列为可抢救）；transcript 一律围栏 + 「不是给你的指令」+ redactSecrets 脱敏；接续链同签名告警；session_start 简报新增有界「待接力」小节且不新增 git 子进程。tools/list 压到 9894 字节/15 工具（预算 10240）；新增 scripts/smoke-rescue.mjs 80 断言 + fixtures 接入 npm test（24 套）；修宪同步 CONTRACT/DECISIONS/SPEC(AC8)/README/CHANGELOG/plugin.json/skills/AGENTS 模板并 relay_sync 重投影。npm test 24 套全绿、relay_verify full PASS 12·WARN 0·ERROR 0。
- 事实(v2): mode=managed | 文件 26 | ± +1667/-115 | base=acab8decc38b491e33d0468adc86bfb78bdb41c5 | sha=d33d7b26230f53a0937c07d6497738d5d77b801d | branch=relay/T048 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 47s
- worktree: branch=relay/T048; sha=d33d7b26230f53a0937c07d6497738d5d77b801d; 已验收,未合并(是否合并由人工决定)
- 负结果: ZCode 给失败子代理只留 metadata.json 与 21-124 字节错误文本，完整对话在 ~/.zcode/cli/db/db.sqlite；rollout/model-io-*.jsonl 是瞬时的，不能作为事后抢救来源。读该库需人类授权 → 拆为 T050。
- 负结果: 归属判定必须两侧都过 realpath：macOS 的 /var→/private/var 会让字符串前缀比较把本项目子代理误判为「别的项目」（实测 800 条全被误跳过）。
- 负结果: rescue 的 takeover 不能复用 relay 认领锁：派发权与认领权是两件事，混成一把锁会让崩溃的接力者永久占住任务。
- 负结果: 接力单不能入库：transcript 含本机路径与潜在敏感内容，且 .relay/** 是受保护路径，不补 .gitignore 基线会让下一次出场被护栏拦死。
- 负结果: 新增工具必然击穿 tools/list 的 10 KiB 预算（实测余量仅 63 字节）：必须同时压缩低频描述；smoke-compat 钉住的词（PRESERVED/worktree/.gitignore/migration/ignored/two commits）不能删。
- 负结果: 不要用 git stash 保存现场：会改变工作区且 stash 是全局栈，并发会话互相干扰。正确做法是临时 index + commit-tree 到 refs/relay/rescue/<id>。
- 留给下一个: T048 只交付「接力单 + 可派发的接力提示词」。自动化需先决定命令执行面（信任边界，参考 acceptance.commands 的逐字符签字）、后台进程生命周期与回收、重试上限、与 relay 认领锁/接力锁的衔接。开工前先记 DECISIONS（减法问）。

## 2026-11-18 16:45 | model=claude-fable-release-20261118 | task=T037 完成
- 摘要: T037 发布 v2.0.0：package.json / plugin.json 版本同步 2.0.0；CHANGELOG 将 Unreleased 定版为 [2.0.0] - 2026-11-18，Breaking 段记录 Node >=22、npm 冻结、归档收窄与迁移指引，Fixed 段汇总 T038–T047 的多专家审计修复；npm test 23 套全绿、./verify 0 ERROR、relay_doctor 健康。tag / push / GitHub Release 由本会话随后执行。
- 事实(v2): mode=single | 文件 3 | ± +12/-3 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 45s
- 负结果: 发布 tag 必须打在 session_end 的完成提交上：先完成控制面提交，再在 main 上打 annotated tag 并推送，否则 Release 会指向旧提交。
- 负结果: private:true 不等于打包边界；发布前必须用 npm pack --dry-run 复核 files 白名单，本次实测 51 文件/164KB 且无协议状态。

## 2026-11-18 16:41 | model=claude-fable-fix-20261118 | task=T047 完成
- 摘要: T047 让 T030 冻结态与 DECISIONS 一致：从待办区移除 `[ ] T030` 任务行，新增「已冻结」分区（缩进备注，不参与任务行解析与 session_start 派发），保留冻结决定与分发方式说明；解冻需先在 DECISIONS 记录新决定并恢复任务行。
- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 47s
- 负结果: 冻结任务不能继续以 [ ] 留在待办：session_start 只按任务行解析，会把冻结项当可执行任务派发；必须移出任务行（冻结分区用缩进备注），靠 DECISIONS 保留决定。

## 2026-11-18 16:39 | model=claude-fable-fix-20261118 | task=T046 完成
- 摘要: T046 处置事实行手工校正：在 DECISIONS 记录 T035（7→6）与 T040（10→9）两次校正的事实、依据与影响，根因收敛为 single 模式写入侧从 porcelain 状态行派生文件数、与提交侧 numstat 在归档/重命名场景差 1（T039 已修 rename/大小写，剩余「多计 1」需改为暂存区 numstat 派生），并明确「事实行不得手改」无法机检、只能靠 session_end 流程与记录约束。
- 事实(v2): mode=single | 文件 1 | ± +9/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 47s
- 负结果: 「事实行不得手改」无法机检：手改为正确值与引擎输出不可区分，R10 只能发现数值不一致；只能靠流程约束与 DECISIONS 记录。
- 负结果: single 模式从 porcelain 状态行派生文件数会与提交侧 numstat 在归档/重命名场景差 1；根治需改为从暂存区 numstat 派生。

## 2026-11-18 16:37 | model=claude-fable-fix-20261118 | task=T045 完成
- 摘要: T045 修正 CHANGELOG 归类：把归档机检面收窄从 Changed 移入 Breaking，补充存量项目迁移动作（非 LOG 指针需运行 relay_archive_log {confirm:true} 新建 LOG-* 并改指），明确 R11 密钥扫描保持全量；同时修正 npm 条目中「移除 files」的过时表述（files 白名单已恢复为打包边界）。
- 事实(v2): mode=single | 文件 1 | ± +3/-6 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 62s
- 负结果: 归档收窄不是内部重构：存量项目可能仍用非 LOG 指针，升级后会静默失去边界；必须写进 Breaking 并给迁移动作，不能放在 Changed。

## 2026-11-18 16:35 | model=claude-fable-fix-20261118 | task=T044 完成
- 摘要: T044 同步分发面文案：README Node 徽章 18→22；src/cli.mjs 的 USAGE 与文件头主用法改为 node src/cli.mjs（移除已删除的 relay bin）；templates/verify.sh 的修复指引改为「克隆 relay-mcp 引擎后设 RELAY_HOME」；docs/04-test/08 的 doctor 命令改为 node src/cli.mjs 且不再要求 npm i -g；docs-design/CONTRACT.md 的 Node 基线与 CLI 契约同步到 >=22 / 无 bin。23 套全绿。
- 事实(v2): mode=single | 文件 5 | ± +10/-11 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 46s
- 负结果: 分发面文案不能只改 README 正文：徽章、CLI --help、模板 verify.sh、案例文档、契约基线是五处独立入口，任何一处残留都会把用户引向已删除的 relay bin 或不存在的 npm 安装。

## 2026-11-18 16:32 | model=claude-fable-fix-20261118 | task=T042 完成
- 摘要: T042 把删除 smoke-pack 时丢失的协议不变量补回机检：smoke-review-regressions 新增 engines.node >=22、零运行时依赖、两个入口 shebang、CLI --version 与 package.json 同步、files 白名单必需项，以及 npm pack --dry-run 的「协议状态与开发文档不进包」断言；43 断言全绿，23 套测试链不变。
- 事实(v2): mode=single | 文件 1 | ± +17/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 49s
- 负结果: 删除一套 smoke 不只删掉断言，还会让该套件覆盖的协议不变量静默消失；恢复时优先并入现有套件（避免套件计数与文档再次漂移），而不是新建一套。

## 2026-11-18 16:30 | model=claude-fable-fix-20261118 | task=T043 完成
- 摘要: T043 恢复打包边界：package.json 重新加入 files 白名单（src/、templates/、skills/、plugin.json、mcp.json、scripts/validate-plugin.mjs、README、LICENSE），保留 private:true 与 npm 冻结；smoke-review-regressions 的冻结断言改为「bin/安装器/发布护栏已移除」+「files 白名单保留」。npm pack --dry-run 实测 51 文件 / 164KB，协议状态与 docs/、docs-design/ 均不进包；23 套全绿。
- 事实(v2): mode=single | 文件 2 | ± +12/-1 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 46s
- 负结果: private:true 只阻止 npm publish，不阻止 npm pack；冻结 npm 仍必须保留 files 白名单，否则本地打包会把协议状态与开发文档带出去（实测 104 文件/371KB）。
- 负结果: 删除分发面时把 files 与 bin 一起删掉，会让「冻结发布」和「打包边界」两个独立约束被混为一谈；后续改动必须区分。

## 2026-11-18 16:27 | model=claude-fable-fix-20261118 | task=T041 完成
- 摘要: T041 修复 R12 悬空指针夹具：缺失目标改用 docs/archive/LOG-missing.md（合法 LOG-* 路径但文件缺失），并新增空目标文件用例，分别覆盖 findArchiveBoundary 的缺失与 size<=0 两条 fail-closed 分支；27 断言全绿。另按引擎修复指令把 T040 历史事实行的文件数从 10 校正为 9（git 实测），R10 恢复 PASS。
- 事实(v2): mode=single | 文件 1 | ± +6/-2 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 55s
- 负结果: R12 的悬空夹具若用 docs/archive/missing.md，会被 LOG-* 路径正则先挡在「路径不合规」分支；必须用 docs/archive/LOG-missing.md 才能覆盖「路径合法但目标缺失」。
- 负结果: single 模式事实行写入侧仍可能比提交侧多计 1 个文件（T040 本次实测 10 vs 9）；已按引擎指令校正历史行，根因需在 T046 用「staged diff 派生事实」彻底收敛。

## 2026-11-18 16:24 | model=claude-fable-fix-20261118 | task=T040 完成
- 摘要: T040 复核并修复 R11 密钥扫描面：确认「安全面不随证据面收窄」——verify.mjs 的归档扫描恢复 docs/archive/**/*.md 全量（含 ARCHIVED-* 文档旧版），D8 完成态证据与 R12 指针仍只认 LOG-*.md；R11 规则行/README/AGENTS 模板/CONTRACT/CHANGELOG 同步，smoke-security 改为「非 LOG 归档含密钥 → ERROR」并保留 LOG-* 用例（26 断言全绿）。同时按 R12 触发归档 13 条旧 LOG 条目到 docs/archive/LOG-2026-09-11.md（活跃区 156→53 行，R12 PASS），并同步归档头注的内容区间到 2026-11-18。
- 事实(v2): mode=single | 文件 9 | ± +20/-12 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 48s
- 负结果: R11 不能跟随证据面收窄：密钥扫描是安全面，漏扫的代价是密钥进入 git 历史且不可撤回；语义隔离只适用于 D8/R12 的证据判定。
- 负结果: 往已存在的归档文件追加条目会再次改变它的内容区间；归档头注必须随每次归档更新，否则文档会二次失真。

## 2026-11-18 16:21 | model=claude-fable-fix-20261118 | task=T039 完成
- 摘要: T039 统一事实行文件数口径：facts.mjs 新增 changedPathsFromStatus（porcelain 的 rename/copy 展开为两条路径，与 diff --numstat --no-renames 一致），单根与无 git 两条路径都改用它；isProtocolFile 的归档判定加 /i，与 verify/doctor 的大小写策略一致；smoke-facts 增加 5 条口径断言（rename 展开、协议面过滤、LOG-* 大小写），49 断言全绿。另删除出场时因 next 标题带任务号而误建的重复任务 T048。
- 事实(v2): mode=single | 文件 2 | ± +23/-8 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 57s
- 负结果: 仅把 isProtocolFile 改成 /i 不够：写入侧按 porcelain 的 rename 行只计 1，而校验侧 --numstat --no-renames 计 2；必须把 rename/copy 行展开成两条路径，两侧才对得上。

## 2026-11-18 16:18 | model=claude-fable-fix-20261118 | task=T038 完成
- 摘要: T038 修复归档指针写读口径分裂：src/engines/archive.mjs 的归档目标正则收窄到 docs/archive/LOG-*.md（与 R12/D8 一致），旧式非 LOG 指针改为新建 LOG-* 归档并保留旧文件不动；src/engines/doctor.mjs 的 D8 修复文案改为真能生效的动作；scripts/smoke-archive-log.mjs 的指针断言改为 LOG-*，并新增「旧式非 LOG 指针 → 新建 LOG-*、旧文件不改写、R12 PASS」用例（30 断言全绿）。
- 事实(v2): mode=single | 文件 3 | ± +26/-4 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 55s
- 负结果: 旧式非 LOG 指针不能继续追加：归档写侧若沿用旧指针，会把历史写进 R11/D8/R12 都不再承认的文件；正确做法是新建 LOG-* 归档并保留旧文件不动。
- 负结果: 归档指针的「写侧」与「校验侧」必须共用同一正则；本次修复前 archive.mjs 与 verify/doctor 各持一份，任何一侧收窄都会分裂。
- 留给下一个: 覆盖审计发现 2/6：facts.mjs:70 写入侧 porcelain 计数与校验侧 numstat --no-renames 在 git mv 时差 1；facts.mjs:19 归档谓词区分大小写而 verify/doctor 用 /i。要求两侧同口径并加用例。

## 2026-11-18 15:39 | model=claude-fable-audit-20261118 | task=无
- 摘要: 把多专家并行审计确认的 15 条缺陷全部登记为任务 T038–T047（按同一根因合并：归档指针口径 T038、事实行口径 T039、R11 密钥面 T040、R12 悬空夹具 T041、协议不变量机检 T042、打包边界 T043、分发面文案 T044、CHANGELOG Breaking 归类 T045、事实行手工改写处置 T046、T030 冻结态与账本一致 T047），每条带可执行验收与复现证据；DECISIONS 记录审计结论与根因判断（同一语义多份副本、只改其中几份）；T037 发布 v2.0.0 下移到修复之后。npm test 23 套全绿、./verify 0 ERROR、R13 解析新增任务行通过、relay_session_start 已把 T038–T040 列为待办首位。
- 事实(v2): mode=single | 文件 1 | ± +10/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 45s
- 负结果: 第一轮并行扇出有 31 个代理被账户 Token Plan 上限 429 截断；额度重置后改为分批验证（每代理 6 条、逐条独立投票）才跑通——说明「每个候选一个代理」的拓扑对本账户成本过高。
- 负结果: 「零调用导出」不等于可删：facts.strict 与 lockTiming 保留解析/白名单是为兼容已接入仓库的 manifest；直接删除会让旧项目触发 doctor D2 未知键告警。

## 2026-11-18 14:08 | model=claude-fable-tier2-20261118 | task=T036 完成
- 摘要: T036 Tier 2 三项决策落地：①npm 正式冻结——package.json 置 private=true，移除 bin/files/安装器/发布护栏，删除 install-mcp/check-publish-guard/smoke-install-mcp/smoke-pack，README 改为 git clone + Agent Plugins + mcpServers 片段，T030 保留为待办但明确冻结勿执行；②Node 下界 18→22——engines/doctor D1/bootstrap/skills/preset/CI 模板/README/SPEC 同步，CI 矩阵补 26；③归档机检收窄到 docs/archive/LOG-*.md——R11/D8 扫描面与 R12 指针同步，ARCHIVED- 文档版本归档不再被误扫，冒烟新增正反用例。期间修复 single 模式事实行把 LOG 归档计入文件数的口径 bug，并校正 T035 历史事实行。npm test 23 套全绿、./verify 0 ERROR、relay_doctor 健康。
- 事实(v2): mode=single | 文件 25 | ± +137/-805 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 46s
- 负结果: 单根事实行写入侧曾用 PROTOCOL_FILES 过滤，把 docs/archive/LOG-*.md 计入文件数，而校验侧用 isProtocolFile 排除它；T035 首次编辑归档时触发 R10 口径分裂。已修 facts.mjs 并校正 T035 历史事实行为 6。
- 负结果: 把冻结任务 T030 手工标 [x] 会触发 D8（无完成日志）；冻结任务应保留 [ ] + 明确『勿执行』标题，不伪造完成记录。
- 负结果: 删除 smoke-pack/安装器后，历史任务 T025 的 test: 验收路径会悬空；已完成任务只能加备注说明，不能改写历史验收。
- 留给下一个: 破坏性变更：Node >=22、npm 冻结、归档机检收窄。发布版本/tag/GitHub Release 需人类授权；发布前跑 npm test 与 ./verify。

## 2026-11-18 13:33 | model=claude-fable-tier1-20261118 | task=T035 完成
- 摘要: T035 Tier 1 真相清理：facts.strict 保留解析与 KNOWN_NESTED_KEYS 兼容，但简报不再回显、config/CONTRACT 明确标废弃（计划 v2.0 移除）；recomputeCommitFileCount 与 lockTiming 标 @internal（零调用，保留避免包外 import 断裂）；docs/archive/LOG-2026-09-11.md 补内容区间与顺序头注（实际覆盖 2026-09-29 ~ 2026-11-02，多次归档拼接、非全局有序），不重命名不重排；DECISIONS 新增 Tier 1 条目。npm test 全绿、./verify 0 ERROR、relay_doctor 健康。
- 事实(v2): mode=single | 文件 6 | ± +19/-2 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 43s
- 负结果: 硬删 facts.strict 会让旧 manifest 触发 doctor D2 未知键 WARN；选择保留解析与白名单、停止简报回显并标废弃。
- 负结果: 删除 recomputeCommitFileCount / lockTiming 对包外 import 不可观测；选择标 @internal 保留至 v2.0，避免破坏未知消费者。
- 留给下一个: 三项待决：①npm 发布走 scoped 包还是冻结；②Node 下界保持 >=18 还是上移 >=22；③templates/docs/README.md 的 ARCHIVED- 约定与 docs/archive 的 LOG 归档双语义如何隔离。每项先记 DECISIONS，再决定是否落代码。

## 2026-11-18 13:28 | model=claude-fable-tier0-20261118 | task=无
- 摘要: Tier 0 真相修复（零行为变更）：删除根目录 0 字节探针文件恢复 R2；doctor 的 CONTRACT 引用改为 docs-design/CONTRACT.md，D7 在未配置 relayHome 时不再谎称“一致”；CONTRIBUTING 规则区间 R1-R9→R1–R13 并纳入 smoke-r12-boundary 静态断言；CHANGELOG 工具计数修正为 10→13；docs/04-test/08 的套件数/检查数/规则区间与 CONTRACT 的 R1–R12 同步到当前事实；DECISIONS 将已被推翻的 npm 决策标为已废弃，并为 D11/D12/D14/D16 补后续注记。npm test 25 套全绿、./verify 无 ERROR、relay_doctor 健康。
- 事实(v2): mode=single | 文件 7 | ± +23/-10 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 11·WARN 0·ERROR 0 | 耗时: 47s
- 负结果: 直接删除 facts.strict 会让旧 manifest 被 doctor D2 报未知键；正确路径是保留键、停止宣传并登记废弃周期。
- 负结果: R5 对 merge 提交显式 SKIP（原子性无法判定）；managed 模式靠双提交成对证据兜底，不能靠 R5 本身。
- 留给下一个: 保留 facts.strict 解析与 KNOWN_NESTED_KEYS 兼容，仅从简报回显与文档移除并记 DECISIONS；recomputeCommitFileCount/lockTiming 删除或标 @internal；归档文件加内容区间头注，不重命名。

## 2026-11-09 15:32 | model=dsh-lead-deepseek-v4.1 | task=T034 完成
- 摘要: T034 发布 v1.9.0:package.json / plugin.json 版本同步 1.9.0(plugin 描述 R1–R12→R1–R13),CHANGELOG 定版 [1.9.0] - 2026-11-09(R13 协议结构机检、漂移备份闸、D8 归档证据面、文档与历史修正),README 冒烟套件计数 22→25,SPEC AC1 改为当前 25 套;npm test 25 套全绿、任务树 verify 全绿。出场后合并 relay/T034、在 main 上打 tag v1.9.0 并创建 GitHub Release,同时补建 v1.7.0/v1.8.0 缺失的 Release。
- 事实(v2): mode=managed | 文件 5 | ± +27/-5 | base=5c8f24f8ad8b918699ebbe94061f6c19351a22d2 | sha=de0ec377d6d03f5143f9518a51d6df299aaa2454 | branch=relay/T034 || 验收: 通过 | verify: PASS 16·WARN 0·ERROR 0 | 耗时: 49s
- worktree: branch=relay/T034; sha=de0ec377d6d03f5143f9518a51d6df299aaa2454; 已验收,未合并(是否合并由人工决定)
- 负结果: 发布 tag 必须打在合并后的 main 上:managed 任务分支的代码提交不是发布点,否则 Release 指向分支提交而非主干。
- 负结果: 补建 v1.7.0/v1.8.0 Release 时用既有 tag,gh release create 不会移动 tag;不要用 --target 触发新 tag。
- 负结果: 版本同步面=package.json + plugin.json(plugin 描述里的 R1–R12 也要一起改);smoke-plugin 只校验版本号,不校验描述,容易漏。
- 负结果: 发版是人工授权动作:CHANGELOG 定版后不再改写历史段,后续变更只能新开版本段。

## 2026-11-09 15:25 | model=dsh-lead-deepseek-v4.1 | task=无
- 摘要: 维护:将 T006/T007 两条已回填 [x] 任务从 TASKS 待办区挪入已完成区(分区归位,任务行与 2 空格续行备注整体搬移,内容与完成戳不变);快速 verify 全绿、doctor 保持健康(D8 OK:TASKS [x] 32 条与 LOG+归档完成条目一致)。
- 事实(v2): mode=single | 文件 0 | ± +0/-0 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 55s
- 负结果: TASKS 分区不在 R13 机检范围内(只查行合法),手工挪动必须整块搬运(任务行 + 2 空格续行),不要按行号脚本搬,易丢备注。

<!-- relay:log-archive: docs/archive/LOG-2026-09-11.md -->
