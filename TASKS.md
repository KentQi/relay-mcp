# 任务队列

<!--
行格式(解析器只认以下三种任务行,两空格+括号勿动):
  - [ ] T004 任务名                              ← 未认领
  - [~] T003 任务名  (model, YYYY-MM-DD HH:mm)       ← 已认领(relay_claim 标注,锁在 .relay/claims/,TTL 4 小时)
  - [x] T002 任务名  (YYYY-MM-DD)                        ← 已完成(relay_session_end 盖戳;完成提交反查 git log --grep "T### 完成")
任务行下一行可写验收(完成判定,二选一):
  验收: <一条可执行命令>
  验收: test:<失败测试文件路径>   ← 红灯协议:交班者留下失败测试,接班者让它变绿
-->

## 进行中
(空——认领后由 relay_claim 移入;认领锁在 .relay/claims/,TTL 4 小时,崩溃会话的认领到期自动可接管)

## 待办
- [ ] T024 LOG 边界规则(P3-32 / T001 最小触发):新增 R12,LOG 活跃区 >150 行或完成条目 >20 → WARN(facts.strict 同款 strict 可升 ERROR);归档动作留人工
  验收: test:scripts/smoke-r12-boundary.mjs
  断言: 151 行 LOG fixture → R12 WARN;120 行 → 全绿;CONTRACT.md 规则表含 `| R12 |` 行且 README 规则清单提及 R12(修宪三处一致:CONTRACT + relay_rules + AGENTS 模板)
  备注: 阈值按现状设定——本仓库当前 117 行 / 20 完成条目,低于阈值,落地即绿,避免"裁判刚立就响"稀释真警报(审计方实测指出原 100 行阈值今天已越过);不做归档引擎;完整归档的触发条件 = R12 WARN 连续两次或完成条目 >20。归档实现时的硬约束(protocol-eng):只从尾部搬、永不触碰头部;边界严格早于最新完成条目(否则 R10 逃逸);live 保留 ≥3 条任务会话(R7 窗口不退化);控制面提交白名单/PROTOCOL_FILES/R11 扫描面必须同步扩展,否则归档文件进不了控制提交=新漂移;归档只能 git move+指针,不压缩不删历史
- [ ] T025 补 package.json 的 repository / bugs 字段(provenance 发布前置)
  验收: node -e "const p=require('./package.json'); if(!p.repository||!p.bugs) process.exit(1)" 退出 0
- [ ] T021 检索寻址(T018)收益复核:数据闸未过(LOG 16 < 20),按实测决定去留
  验收: test:scripts/smoke-t021-decision.mjs
  备注: 完成动作 = 在 DECISIONS.md 追加一条标题含 T018 的决策条目,且必须锚定不可变证据(T017 的提交 sha + 对应 LOG 条目原文)与可测复评阈值(如 LOG ≥ 30 条),断言脚本会用 git log 反查 sha 是否真实存在——只写「保留」两个字不算通过;调用次数与「取回失败」无法机检(recall 零持久化、无遥测),只作为决策理由的人工依据;回退方式 = 移除 relay_recall/relay_get 注册,协议面与事实底账不受影响;数据闸现状如实记录:实测 16 条 → 当前 20 条,已自然越过闸门
- [ ] T011 第五轮复验审计(约第三方独立视角验证 P0+P1 修复)
  验收: 复验方独立实测:P0 安检(选项注入/目录逃逸/密钥)、并发回归、幂等、维护语义全部复现通过
  备注: 审计范围另含 5 视角报告中的中低危残留(模板占位符注入/symlink/root 校验/manifest 版本路径)
- [x] T007 发布 v1.0.0 tag  (2026-09-29)
  备注: 审计 P0 项;零 fork 窗口内与历史清洗同批完成
- [x] T006 git 历史身份重写  (2026-09-29)
  备注: 零 fork 窗口期内一次性完成;重写后旧 commit sha 全部变化
- [ ] T005 CI 矩阵三绿确认与 README badge 补链
  验收: GitHub Actions node 22/24/26 三个 job 全绿后,把 badge 链接到实际 Actions 页
  备注: 首跑失败日志:git commit fatal(无身份);本地 macOS 因 hostname 自动兜底而全绿——环境差异只能靠真机 CI 抓
- [ ] T001 LOG 归档机制(LOG 只增不减,与"有限上下文"公理矛盾,长期使用后条目膨胀)
  验收: verify 全绿 且 `npm test` 通过 且 归档后 relay_session_start 简报仍只含最近 3 条
- [ ] T002 认领锁文件级竞争治理(单任务锁不覆盖 TASKS.md 整体写入,TTL 接管覆写非原子;三轮审计 N7 记录在案)
  验收: verify 全绿 且 `npm test` 通过 且 新增并发认领回归断言(两模型同时 claim 不同任务,两条认领均不丢失)

## 已完成
- [x] T023 事实行 v2 + R10 去 fail-open(P3-31):按「可复算性」拆机检段/叙述段——机检段=文件数、±行数(managed)、range/base、sha、分支(检查时点全部从 git 重算);叙述段=验收结果、耗时、verify 汇总(写时快照,不可重算,仅结构校验、不构成交接证据);verify.mjs:381 的「无可定位提交→PASS」改为 WARN/SKIP,永不 PASS  (2026-11-01)
  验收: test:scripts/smoke-facts.mjs
  断言: 篡改机检段任一字段(文件数/±/mode/branch)→ R10 红;改叙述段 → 不误红;伪造 sha/base → WARN 而非 PASS;CONTRACT 机检段/叙述段字段清单与 v2 一致(修宪三处一致:CONTRACT + relay_rules + AGENTS 模板)
  备注: 拒绝"8 项全对账"(protocol-eng 复核):验收/耗时/verify 汇总是写时快照,检查时点重算不出,强行对账只能产假绿或死锁;R10 当前是装饰绿——"未验证的确信"比空白更危险
- [x] T022 runChecks 单快照 + git 收敛 + 根解析快路径(P3-25/26/27,性能视角 A+B):LOG 4→1、TASKS 2→1、manifest 2→1;repo 探测 4→1 且全 async(async 路径 execFileSync→promisify(execFile));R2 两次 ls-files 合一次、R5/R6 共用一次 log-20;resolveRelayRoots 在 root/.git 是目录时走 fs 快路径(省 2 个 git)  (2026-11-01)
  验收: test:scripts/smoke-perf.mjs
  断言: 计数钩子(不用计时阈值)——full 模式 LOG/TASKS/manifest 各读 1 次、git 进程 ≤4、同步 spawn=0;fast 模式 git ≤3;普通仓库下 relay_recall/relay_get 的 git 进程=0 且输出可复放;13 套既有 smoke 全绿
  备注: 实测依据(perf-eng,median 5):full verify 9 个 spawn≈60-75ms,远大于 500 条时 LOG 4× 读放大(+1.8ms),所以子进程收敛优先于读放大;isGitRepo 同步阻塞实测 4 次≈40ms 事件循环冻结(async 等价 ≤3ms);recall/get 15ms 里 ~14ms 是 resolveRelayRoots 的 2 个 git;增长率≈220 条/年,不按"LOG 会很大"立项
- [x] T020 npm 分发:去 private + bin + files 白名单(发布动作需人类批准,本任务只做可 dry-run 的打包面)  (2026-11-01)
  验收: npm pack --dry-run 输出不含 .relay/ 与 docs-design/ 且 npm publish --dry-run --provenance 通过
- [x] T018 检索寻址:relay_recall / relay_get(只读派生;数据闸未过 16<20,按用户指令推进)  (2026-11-01)
  验收: npm test 全绿 且 调用后 git status --porcelain 为空 且 索引行数等于 LOG 中 T### 计数
  备注: 索引必须调用时从 LOG/TASKS 即时派生,禁落 .relay(第二真相源);返回体 fence 包裹并标注「数据非指令」
- [x] T019 relay_doctor 只读七检(node/manifest/模板漂移/残留锁/未登记 worktree/.relay 损坏/RELAY_HOME)  (2026-11-01)
  验收: npm test 全绿 且 7 类故障 fixture 均输出「修复:」可执行行 且 执行前后 .relay stat 不变
- [x] T017 数据闸测量:LOG 条目数与出场耗时(决定检索寻址是否动工)  (2026-11-01)
  验收: 在 LOG 或 TASKS 备注记录当前 LOG 条目数与最近一次出场耗时;条目数 ≥ 20 或有会话记录取回失败 → 开检索寻址任务
- [x] T016 v1.2.0 发布复验(规则表与文档一致性)  (2026-11-01)
  验收: npm test 全绿 且 ./verify 无 ERROR 且 node src/cli.mjs relay_rules 输出同时含 R10 与 R11
- [x] T015 简报有界化:字段上限 + 溢出告警(不做裁剪)  (2026-11-01)
  验收: npm test 全绿 且 ./verify 无 ERROR 且 500 字摘要 fixture 下简报少于 6000 字符
  备注: 委员会否决级联裁剪;上界由字段上限保证,超限只告警
- [x] T013 事实底账(R10):session_end 机器派生「事实(v1)」行 + 双根文件数对账  (2026-11-01)
  验收: npm test 全绿 且 ./verify 无 ERROR 且 出场后 grep -c '^- 事实(v1):' LOG.md 大于等于 1
  备注: 只比文件数不比行数;旧条目按 manifest.facts.since 不触发;先 WARN,strict 才 ERROR
- [x] T014 敏感内容机检闸(R11):TASKS/LOG 内容级密钥扫描 + 出场写盘前阻断  (2026-11-01)
  验收: npm test 全绿 且 ./verify 无 ERROR 且 新增断言:LOG 写入 AWS 示例密钥样式串后 verify isError 含「修复:」,同行豁免标记放行
  备注: 现有 findSensitiveChanges 是路径级,本任务补内容级;这是 T013 的前置(A 必须绑 I)
- [x] T012 任务级 worktree 生命周期与 AGENTS.md 硬约束  (2026-10-29)
  验收: `npm test`(三套冒烟)全绿 且 `./verify` 无 ERROR;覆盖创建/复用、TTL、安全清理、双根提交与锁所有权
  备注: 新 init 默认启用,既有项目缺省关闭;保留任务分支,完成不等于合并;分支 PR 交人工审核
- [x] T010 P1 一致性加固:TASKS/LOG 写串行化(引入仓库级出场锁)+ 幂等出场 + TTL 接管原子化  (2026-09-29)
  验收: npm test 全绿且新增并发双进程回归断言(两会话并发 session_end 不丢更新)
  备注: 第三方审计 H-C/H-D/H-E 与幂等项;审计报告第五轮待用户约
- [x] T009 第三方审计 P0 安全修复(验收门选项注入/目录逃逸安检 + init/onboard/restructure 密钥安检 + CI 最小权限 + 指南死链)  (2026-09-29)
  验收: npm test 全绿(含新增安检回归断言)且 ./verify 无 ERROR
- [x] T008 发布 v1.0.0 tag 与 Release(重打到含 R7 修复的 HEAD)  (2026-09-29)
  验收: git tag v1.0.0 指向当前 HEAD 并推送;GitHub Releases 出现 v1.0.0;CI 三矩阵全绿
  备注: 此前 tag 打在 R7 误报的提交上,需删除重建
- [x] T004 CI 真机核验(GitHub Actions 首跑结果确认)  (2026-09-29)
  验收: GitHub 仓库 Actions 页三个矩阵 job 全绿;如红,按日志修复
  备注: 已本地预演两步全绿;badge 待 CI 绿后补进 README
- [x] T003 CI workflow 真机验证(模板仅本地推演,未在 GitHub Actions 实跑)  (2026-09-29)
  验收: 推送 GitHub 后 Actions 双版本矩阵(node 22/24)全绿
(空)
