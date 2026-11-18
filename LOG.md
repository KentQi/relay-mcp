# 会话日志(最新在上)

## 2026-11-18 16:24 | model=claude-fable-fix-20261118 | task=T040 完成
- 摘要: T040 复核并修复 R11 密钥扫描面：确认「安全面不随证据面收窄」——verify.mjs 的归档扫描恢复 docs/archive/**/*.md 全量（含 ARCHIVED-* 文档旧版），D8 完成态证据与 R12 指针仍只认 LOG-*.md；R11 规则行/README/AGENTS 模板/CONTRACT/CHANGELOG 同步，smoke-security 改为「非 LOG 归档含密钥 → ERROR」并保留 LOG-* 用例（26 断言全绿）。同时按 R12 触发归档 13 条旧 LOG 条目到 docs/archive/LOG-2026-09-11.md（活跃区 156→53 行，R12 PASS），并同步归档头注的内容区间到 2026-11-18。
- 事实(v2): mode=single | 文件 10 | ± +20/-12 | base=- | sha=- | branch=main || 验收: 通过 | verify: PASS 12·WARN 0·ERROR 0 | 耗时: 48s
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
