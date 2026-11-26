# 会话日志(最新在上)

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

## 2026-11-26 01:03 | model=zcode-deepseek-t054 | task=T054 完成
- 摘要: 本次会话在同一分支上完成 T054–T057 四个审计修复任务（同批文件，避免反复重置 worktree）。T054(#5 协议写入旁路)：takeover 写 TASKS.md 从裸 writeFileAtomic 改为 writeProtocolFile(内置 scanSecrets 密钥闸 + expectedHash 内容 CAS + fencing)，并加 RELAY_TEST_EXTERNAL_TASKS_WRITE 钩子验证并发手改不被覆盖；密钥型 agentId 进入标题时现在会被拒且 TASKS 逐字节不变。T055(#4 #8 #9 #13)：修正 manifest.rescue.sources/maxAgeDays 读取层级（此前恒 undefined，7 天窗口变 NaN 导致年龄过滤完全失效）；快照失败原因 snapshotNote 落盘并在 capture/show 区分「无改动」与「失败(原因)」；commit-tree 补 gitIdentityArgs 兜底；快照密钥防护改 fail-closed（status 失败即拒绝快照）+ 对暂存内容跑 scanSecrets（此前只看文件名）；快照根改用被救子代理的 cwd 而非调用者的 executionRoot。T056(#6 #7 #10 #14)：report 改用 takeover 时存下的真实 token 释放接力锁（此前空 token 必然 no-op 再按 holder 名手工 unlink，绕过 fencing）；takeover 的每条提前 return 与 state 写盘失败都释放接力锁（此前泄漏 240 分钟且卡片仍显示待接力）；拒收 `<你的模型标识>` 占位符（与 relay_claim 同口径，此前 sameHolder adopt 会让互斥失效）；drop 加持有者守卫 + 符号链接防线（此前可删掉正在接力的卡与唯一快照 ref）。T057(#15 + Notes)：修 ttl_hours 默认值事实错误（真实来源是 manifest.worktree.ttlHours）与 relay_recall 的 status " " 约定；CHANGELOG/CONTRACT 的 T049→T051 漂移；CONTRACT 配置面补 manifest.rescue；package.json/plugin.json 同步升 2.1.0（描述写 15 工具而版本仍是已发布的 2.0.0）。另修一个由测试暴露的真实缺陷：接续链 chainPrev 仅按毫秒级 createdAt 排序，同毫秒两卡会随机错指/为空，改为 (createdAt, id) 复合键。rescue 套件 126 断言全绿（连跑 8 次 + 全量 3 次稳定），npm test 24 套全绿，verify 双根全绿。
- 事实(v2): mode=managed | 文件 7 | ± +312/-53 | base=bbea28c466e05031d2defe686acef6003d022355 | sha=0e7a544f1ae0ec1ccb6de47e1b8089a9c463e734 | branch=relay/T054 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 51s
- worktree: branch=relay/T054; sha=0e7a544f1ae0ec1ccb6de47e1b8089a9c463e734; 已验收,未合并(是否合并由人工决定)
- 负结果: rescue 的 TASKS 写入必须走 writeProtocolFile,而不是「自己实现一个 fencing 回调」:fencing 只保证锁归属,不含密钥闸与内容 CAS。审计用「agentId 带 sk-ant」复现了密钥直入 git 历史。
- 负结果: 快照的密钥防护不能只看文件名:仓库早就有内容级 scanSecrets(R11 在用),但快照路径从未调用。且 status 失败时把排除列表当空等于全放行——必须 fail-closed。
- 负结果: 接力锁的释放必须用 takeover 时拿到的 token;空 token 调 releaseFileLock 是必然 no-op,此时再按 holder 名 unlink 就绕过了 fencing(同名 model 可删他人活锁)。
- 负结果: 接续链排序不能只用毫秒级 createdAt:同毫秒两张卡会随机取错,必须用 (createdAt, id) 复合键。这个缺陷是测试偶发失败(1/3 概率)暴露的,单跑不易复现。
- 负结果: worktree 的 baseSha 会被 registry 缓存:合并上一个任务后重新 claim 仍基于旧 main,必须手动 git reset --hard 到最新 main 才能拿到前序修复。
- 负结果: 测试不要依赖前面测试段留下的锁状态:同签名告警改用独立仓库夹具后从偶发失败变为确定性通过。
- 留给下一个: T048 只交付「接力单 + 可派发的接力提示词」。自动化需先决定:命令执行面(信任边界,参考 acceptance.commands 的逐字符签字)、后台进程生命周期与回收、重试上限、以及与 relay 认领锁/接力锁的衔接。开工前先记 DECISIONS(减法问)。对应任务 T051。ZCode 完整对话抢救为 T050(需人类授权只读 SQLite)。

## 2026-11-26 00:38 | model=zcode-deepseek-t053 | task=T053 完成
- 摘要: T053 修复审计 #3 的中断分类双向错判，先红后绿。(a) 旧实现只看「最后一条记录是否 assistant+tool_use」判悬空，导致子代理死在「tool_result 已落盘、下一轮 assistant 未开口」时被判 complete、不可抢救——恰是本工具的核心场景。改为在解析器里维护 pendingToolUse 集合（发 tool_use 时加入、收到 tool_result 时按 tool_use_id 删除），悬空判定 = 集合非空；evidence 报出未配对数量与末条记录类型。(b) 旧实现只要历史出现过一次 is_error 就判 error，把正常跑完的代理也列为可抢救并登记假接管任务。改为：只有「最后一条记录本身就是那个 is_error 的 tool_result、模型之后没再开口」才算停因（stoppedAfterToolError）；历史报错仅作为正常完成时的说明性证据，不改判类别。顺带修掉一个真实缺陷：新增参数漏进 classifyFailure 解构导致解析器抛 ReferenceError，而 catch 把它吞成 transcriptOk:false（所有卡片被误标「转录损坏」）——这正好证明了审计对「异常被静默吞掉」的担忧。新增 6c 测试段（5 条断言 + 4 份定向夹具：末条 assistant 悬空、末条 user-result 但有未配对、历史报错后正常收尾、正常完成）。rescue 套件 99/0，npm test 24 套全绿。
- 事实(v2): mode=managed | 文件 2 | ± +275/-43 | base=e5229208534e9b334422843329b763e273f04eb5 | sha=4ef6c05a4571af01df4ee74d36277422afe40e11 | branch=relay/T053 || 验收: 通过 | verify: PASS 15·WARN 0·ERROR 0 | 耗时: 66s
- worktree: branch=relay/T053; sha=4ef6c05a4571af01df4ee74d36277422afe40e11; 已验收,未合并(是否合并由人工决定)
- 负结果: 解析器的 `catch { parsed = null }` 会把任何异常静默降级为 transcriptOk:false —— 新增字段漏进 classifyFailure 解构时,全部卡片被误标「转录损坏」而毫无报错。定位时必须临时把 catch 改成打印 stack。
- 负结果: 「末尾相邻」不能只看 lastRecordKind === 'user-result'(tool_result 之后就会设成它);必须同时检查最后一条记录本身是否含 is_error 的 tool_result,否则正常收尾的 end_turn 也会被误判为停因。
- 负结果: worktree 的 baseSha 会被 registry 缓存:合并了上一个任务后重新 claim,T053 仍基于旧 main(e522920),必须手动 git reset --hard 到最新 main 才能拿到 T052 的修复。后续任务合并后应同步清理 registry 记录或手动重置。
- 留给下一个: 见报告 #5。rescue.mjs 的 takeover 用裸 writeFileAtomic 写 TASKS.md,违反 util.mjs「TASKS/LOG 只能经由 writeProtocolFile 落盘」。后果:(1) 无 scanSecrets 闸 → 密钥样式串可进 git 历史,且此后每次 relay_claim/session_end 都会被 ProtocolSecretError 锁死;(2) 无 expectedHash 内容 CAS → 读改写之间的人工改动被静默覆盖。改用 writeProtocolFile(controlRoot,'TASKS.md',text,{token:repoLock.token,lockLabel:'仓库写锁',expectedHash:sha256Hex(tasksRaw)})。补「密钥串被拒」「并发手改不被覆盖」用例。对应任务 T054。

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

<!-- relay:log-archive: docs/archive/LOG-2026-09-11.md -->
