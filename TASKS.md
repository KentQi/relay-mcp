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
- [ ] T006 git 历史身份重写(与本次树内修改同主题)
  验收: git log 全部提交 an/committer 为 kent <kirroyu@126.com>,远端 force push 后 CI 仍全绿
  备注: 零 fork 窗口期内一次性完成;重写后旧 commit sha 全部变化
- [ ] T005 CI 矩阵三绿确认与 README badge 补链
  验收: GitHub Actions node 22/24/26 三个 job 全绿后,把 badge 链接到实际 Actions 页
  备注: 首跑失败日志:git commit fatal(无身份);本地 macOS 因 hostname 自动兜底而全绿——环境差异只能靠真机 CI 抓
- [ ] T001 LOG 归档机制(LOG 只增不减,与"有限上下文"公理矛盾,长期使用后条目膨胀)
  验收: verify 全绿 且 `npm test` 通过 且 归档后 relay_session_start 简报仍只含最近 3 条
- [ ] T002 认领锁文件级竞争治理(单任务锁不覆盖 TASKS.md 整体写入,TTL 接管覆写非原子;三轮审计 N7 记录在案)
  验收: verify 全绿 且 `npm test` 通过 且 新增并发认领回归断言(两模型同时 claim 不同任务,两条认领均不丢失)

## 已完成
- [x] T004 CI 真机核验(GitHub Actions 首跑结果确认)  (2026-09-29)
  验收: GitHub 仓库 Actions 页三个矩阵 job 全绿;如红,按日志修复
  备注: 已本地预演两步全绿;badge 待 CI 绿后补进 README
- [x] T003 CI workflow 真机验证(模板仅本地推演,未在 GitHub Actions 实跑)  (2026-09-29)
  验收: 推送 GitHub 后 Actions 双版本矩阵(node 22/24)全绿
(空)
