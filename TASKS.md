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
- [ ] T001 LOG 归档机制(LOG 只增不减,与"有限上下文"公理矛盾,长期使用后条目膨胀)
  验收: verify 全绿 且 `npm test` 通过 且 归档后 relay_session_start 简报仍只含最近 3 条
- [ ] T002 认领锁文件级竞争治理(单任务锁不覆盖 TASKS.md 整体写入,TTL 接管覆写非原子;三轮审计 N7 记录在案)
  验收: verify 全绿 且 `npm test` 通过 且 新增并发认领回归断言(两模型同时 claim 不同任务,两条认领均不丢失)
- [ ] T003 CI workflow 真机验证(模板仅本地推演,未在 GitHub Actions 实跑)
  验收: 推送 GitHub 后 Actions 双版本矩阵(node 22/24)全绿

## 已完成
(空)
