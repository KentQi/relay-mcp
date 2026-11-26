---
title: relay_rescue 修复复验与后续改动审计 — T052–T058/T050/T051
version: 1.1
created: 2026-11-26
status: 现行
---

# relay_rescue 修复复验与后续改动审计

> **v1.1 说明**:本报告正文是 v1.0 审计当时(`4f1bdda`)的事实快照,保留原样以维持证据链。
> T059 已逐条复核并修复全部确认缺陷,复核校正与闭环矩阵见文末「附录 B」。
> 阅读结论时请以附录 B 为准。

## 结论

**request-changes。**

T052–T057 已全部完成并合并，T058/T050/T051 又交付了描述符通用化、只读 SQLite 来源与默认关闭的自动拉起；但原 15 条审计发现**并非全部闭环**：

- **8 条完全修复**：#1 #2 #4 #5 #8 #10 #11 #12；
- **5 条部分修复或留下相邻回归**：#3 #7 #13 #14 #15；
- **2 条明确回归**：#6（report 锁 token）、#9（快照密钥扫描时机）。

本轮对 `de146a7..4f1bdda` 的复验确认 **15 条新的重要缺陷**，全部有独立验证裁定与可复现触发。另有 7 条已确认候选因输出上限列入附录。

## 审计范围与方法

| 项 | 值 |
|---|---|
| 基线 | `de146a7`（上一轮 15 条审计报告提交） |
| 当前 | `4f1bdda`（T051 合并提交） |
| 差异 | 19 文件，+2586/−496；本地 main 领先 `origin/main` 25 个提交 |
| 角度 | 逐行、删除行为、跨文件、Node 陷阱、包装/执行面、项目规范 |
| 验证 | 每个候选由新鲜上下文独立验证器裁定；Phase 3 由顺序扫漏收尾 |
| 代码修改 | 除本报告外未修改任何代码；工作区在审计期间保持干净 |

## 修复后做了什么

| 任务 | 实际交付 |
|---|---|
| T052 | `state.json` 删除可派生字段；空哈希 fail-closed；围栏逐行加前缀；命令/路径脱敏；`agentId` 单行净化 |
| T053 | 用 `pendingToolUse` 集合识别悬空调用；历史工具报错不再单独判错 |
| T054 | takeover 写 TASKS 改走 `writeProtocolFile`，恢复密钥闸、内容 CAS 与 fencing |
| T055 | 修正 `manifest.rescue.*` 层级；快照失败原因可见；补 git 身份兜底；快照根改用被救 cwd |
| T056 | 试图用真实 token 释放接力锁；补提前返回释放、占位符拒收、drop 持有者/符号链接守卫 |
| T057 | 清理旧假绿断言；修 `ttl_hours`/recall 文案；补契约配置；版本升到 2.1.0 |
| T058 | 抽出 `rescue-profiles.mjs` 描述符层；核心零 harness 名；默认零扫描；归属 fail-closed |
| T050 | 新增通用 `sqlite-conversation` 描述符；`node:sqlite` 只读打开；schema 由 manifest 声明 |
| T051 | 新增 detached launch worker；`autoLaunch` 默认关闭；argv + `shell:false`；dispatch 生命周期 |
| T059 | **待办**：复核并发布下一版本；尚未打 `v2.1.0` tag，CHANGELOG 仍未定版 |

## 原 15 条闭环矩阵

| # | 原发现 | 复验状态 | 依据 |
|---|---|---|---|
| 1 | state.json 第二真相源/空哈希放行 | **已修复** | 可派生字段已移除；`loadTranscript` 空哈希拒绝 |
| 2 | transcript 可闭合围栏 | **已修复** | `neutralizeFence` 逐行加 `│` 前缀 |
| 3 | 中断分类双向错判 | **部分修复/新回归** | 原 `pendingToolUse` 问题已修；但跨轮次终态、工具报错后文本仍误判 |
| 4 | `manifest.rescue.*` 读错层级 | **已修复** | 消费端已读 `cfg.rescue.*` |
| 5 | takeover 绕过协议写入 | **已修复** | 已走 `writeProtocolFile` + CAS |
| 6 | report 空 token 释放 | **回归** | takeover 至今未把 `lock.token` 写入 state |
| 7 | takeover 提前返回泄漏锁 | **部分修复** | 已覆盖已知提前返回；主 state 写盘异常仍泄漏 |
| 8 | 快照失败静默/无身份 | **已修复** | `snapshotNote` 可见；复用 `gitIdentityArgs` |
| 9 | 快照密钥防护 | **回归/不完整** | 内容扫描发生在 `write-tree` 之后，拒绝时 blob 已入对象库 |
| 10 | 占位 model/同名 adopt | **已修复** | 占位符与控制字符已拒收 |
| 11 | 命令/路径不脱敏 | **已修复** | 卡片、commands view、接力提示词均已脱敏 |
| 12 | agentId 伪造任务行 | **已修复** | 写 TASKS 前单行净化 |
| 13 | 快照拍错工作区 | **部分修复** | capture 已用被救 cwd；drop/edits 仍读错仓库 |
| 14 | drop 无持有者/符号链接防线 | **部分修复** | 守卫已加；过期 TTL、检查—删除竞态、测试覆盖仍不足 |
| 15 | 假绿断言 | **部分修复** | 旧恒真断言已删；新增 `ok(true)` 且 report 释放仍未被断言 |

## 本轮确认 Findings（15）

### 1. 拒绝快照时，密钥 blob 已经写入 Git 对象库

`src/engines/rescue.mjs:446`

用户在普通文件名中硬编码密钥样式串时，capture 会报告“拒绝生成快照”，但 `write-tree` 在内容扫描之前执行，密钥 blob 已真实存在于对象库，后续 `git cat-file` 可以读回。Fix: 在 `add/write-tree` 前扫描工作区内容，或从临时 index 读取 blob 并在任何对象落盘前拒绝；`diff` 失败也必须 fail-closed。

### 2. 自动拉起把未脱敏原始 prompt 写入 argv 与 dispatch.json

`src/engines/rescue.mjs:73`

启用 `autoLaunch` 且使用 `{{prompt}}` 时，完整 transcript prompt 未经脱敏或裁剪就进入子进程 argv，并持久化在 `dispatch.json` 和临时配置中。长 prompt 可触发 `E2BIG`，密钥可暴露在进程参数与默认权限文件。Fix: 通过 stdin 或 0600 文件传递有界、脱敏的数据包，并在 spawn 前限制参数长度。

### 3. report 返回成功，但接力锁仍残留 240 分钟

`src/engines/rescue.mjs:1033`

takeover 取得 `lock.token` 后只保存 `{model, at, task}`，report 读不到 token，无法按 fencing 释放锁，却仍清空 `state.takeover` 并返回成功。Fix: 持久化 token，仅在真实 token 释放成功后清空 takeover 并报告成功。

### 4. state 写盘异常造成锁与状态分裂

`src/engines/rescue.mjs:1035`

takeover 的主状态写入不在 `try/finally` 内，磁盘满或权限失败会泄漏 240 分钟无心跳锁；report 则先释放锁再写状态，写失败后出现“锁已释放、状态仍显示持有”。Fix: 用统一 `try/finally` 管理锁；report 先持久化结果再释放，失败保留可恢复状态。

### 5. 快速自动拉起任务可能永久卡在 running

`src/engines/rescue.mjs:106`

父进程在 `spawn/unref` 之后才写 `running` 占位；极快 worker 先写 `completed/failed` 后，会被父进程占位覆盖，之后没有 worker 再修正状态。Fix: spawn 前原子写占位，或用 CAS 禁止覆盖已存在的终态。

### 6. dispatch.json 半写可绕过 report/drop/takeover 守卫

`src/engines/rescue-launch-worker.mjs:25`

worker 用 `writeFileSync` 截断覆盖状态文件，并发读取可能看到空/半 JSON；`readDispatch` 把解析失败当 `null`，于是运行中守卫失效。Fix: 临时文件加 rename 原子发布；已存在但损坏的状态按 busy/fail-closed 处理。

### 7. 超时不杀进程树，孙进程可让 worker 永久 running

`src/engines/rescue-launch-worker.mjs:61`

超时只向直接 child 发 SIGTERM/SIGKILL；若孙进程继承 stdout/stderr，`close` 永不触发，dispatch 保持 running，report/drop 永久被拒。Fix: POSIX 用独立进程组并终止整组，Windows 用 Job Object，或给 close 设置有界收尾。

### 8. drop 忽略过期锁，且检查到删除之间存在 takeover 竞态

`src/engines/rescue.mjs:1181`

drop 只凭 holder 判断持有，不检查 TTL；超过 240 分钟的崩溃锁仍阻止删除。检查后直接 `rm`，另一进程可在此窗口 takeover，随后唯一现场被删。Fix: 复用带 `staleMs` 与 token fencing 的锁流程，获取删除锁后重查 state/dispatch 再删除。

### 9. 历史完成/429 信号污染后续轮次

`src/engines/rescue-profiles.mjs:169`

`explicitCompletion` 与 `apiError` 一旦置位便不清除，并优先于当前 `pendingToolUse`。多轮会话中，早期完成会掩盖后续中断，早期 429 会把已恢复会话误判 quota。Fix: 按轮次重置终态信号，只依据最后一个有效轮次分类。

### 10. 工具报错后只输出分析文本，会被误判正常完成

`src/engines/rescue.mjs:304`

序列 `tool_use → is_error tool_result → assistant 分析文本 → 被杀` 中，`trailingToolError` 仍为真，但分类器要求末条是 `user-result`，最终落入 `complete`，capture 拒绝抢救。Fix: 工具错误信号保持到成功结果或明确 completion，不能仅因后续 assistant 文本清除。

### 11. SQLite 行内 JSON 损坏被静默吞掉

`src/engines/rescue-sqlite-profile.mjs:47`

`jsonParse` 把损坏 JSON 降为 fallback，错误消息或工具 part 的证据消失，失败会话可能被判正常完成。Fix: 显式报告解析失败并降级，不要把损坏数据当空对象继续分类。

### 12. SQLite 工具结果生成条件混淆状态与输出类型

`src/engines/rescue-sqlite-profile.mjs:161`

只有字符串 output 或 `status==='error'` 才生成 `tool_result`；completed + 对象输出会留下假悬空调用，running + 字符串输出反而提前配对。Fix: 按终态状态决定是否生成结果，并对任意 output 类型安全序列化。

### 13. SQLite maxRows 在全量读取后才生效

`src/engines/rescue-sqlite-profile.mjs:117`

messages/parts 先 `.all()` 物化全部行，再检查 `maxRows`；超大 session 会在拒绝前产生显著内存放大。Fix: SQL 使用 `LIMIT maxRows+1` 或流式迭代，并在物化过程中持续累计字节。

### 14. scan 在 maxBytes 检查前无界读取整个 transcript

`src/engines/rescue.mjs:594`

候选缺 cwd 时，归属推断直接读取并解析整个 transcript；之后才在 `describeCandidate` 检查 `maxBytes`。约 96 MiB JSONL 在 64 MiB 堆上限下可使 scan OOM。Fix: 先 stat/有界前缀，确认大小与首条 cwd 后再决定是否完整读取。

### 15. T058 前捕获的旧接力单升级后丢失任务与现场证据

`src/engines/rescue.mjs:521`

旧卡使用 `state.harness` 而没有 `state.profile`；新代码只按 profile 找解析器，缺失时静默返回 `parsed=null`。show/takeover 仍成功，但原始 prompt、叙述、命令、改动全部丢失。Fix: 迁移 legacy harness→profile，或保留兼容解析路径并明确提示升级。

## 附录：因 15 条上限截断的确认候选

以下候选同样已 CONFIRMED，但严重度/影响面低于前 15 条，未挤占正式 findings：

1. **快照根错配**：`src/engines/rescue.mjs:1219` drop/edits 用 `executionRoot`，而 capture 的 ref 可能在 `snapshotRoot`；嵌套仓库会留下孤儿快照 ref。
2. **显式 metadata.json 回归**：`src/engines/rescue.mjs:175` 同一文件作为目录可 capture，作为显式 source 被拒。
3. **非法 autoLaunch 配置半写**：`src/engines/rescue.mjs:1047` 先写 TASKS/state 后校验，失败遗留孤儿待办，重试重复登记。
4. **fieldMap 转发缺失**：`src/engines/rescue-profiles.mjs:138` `roleMap` 未传、`message.stop_reason` 未读、嵌套 `apiErrorStatusPath` 未按路径解析。
5. **T055–T057 完成证据缺口**：`TASKS.md:40` 三项标完成，但 LOG 无独立完成条目；`relay_doctor` D8 实测 WARN。
6. **drop 符号链接测试恒真**：`scripts/smoke-rescue.mjs:750` 新增 `ok(true)`，整段在 `if (heldId)` 内，未调用 drop。
7. **README/CHANGELOG 漂移**：`README.md:142` 与 `:172` 自相矛盾；CHANGELOG 仍写自动发现、24 套测试及 T050/T051 范围外。

## 验证与未覆盖边界

| 检查 | 结果 |
|---|---|
| `npm test` | **26 套全绿**；rescue 133、SQLite 22、autoLaunch 26 断言通过 |
| `relay_verify full` | PASS 11 · WARN 0 · ERROR 0 · SKIP 2（R5 merge、R8 无 format 工具链） |
| `relay_doctor` | 1 WARN：T055/T056/T057 缺 LOG 完成证据 |
| `git diff --check` | 通过 |
| CI | **未覆盖当前 HEAD**；远端 main 仍停在审计基线，最近 CI 是 v2.0.0 |
| 运行时 | 本机仅 Node v26.12.1；SPEC 要求的 Node 22/24/26 三矩阵尚未验证 |
| 发布 | `package.json`/`plugin.json` 已为 2.1.0，但无 `v2.1.0` tag，CHANGELOG 仍为 Unreleased；T059 待办 |

## 建议修复顺序

1. **先堵安全边界**：快照密钥对象、原始 prompt 进 argv。
2. **再修锁与生命周期**：token 持久化、state 原子性、dispatch 竞态、进程树超时、drop 竞态。
3. **再修核心分类**：跨轮次终态、工具报错文本、SQLite JSON/tool_result。
4. **再修资源边界**：SQLite maxRows、scan 无界读取。
5. **再补兼容与证据**：旧卡迁移、T055–T057 LOG、假绿测试、文档漂移。

---

## 附录 B：复核校正与修复闭环(T059)

上报后对每条 finding 做了逐条复核与修复，结论与原文有三处口径差异，一并记录：

**复核校正**

1. 原 Finding #2「原始 prompt 进入 argv 与 dispatch.json」：argv 部分成立（`{{prompt}}` 原样替换），但 **`dispatch.json` 从未持久化 command/prompt**——原报告该半句不成立。修复后 argv 仍保留 prompt（这是占位符合约的语义），但增加了总字节上限(16 KiB)与更严格的 cwd 存在性校验。
2. 附录第 5 条「T055–T057 缺 LOG 完成证据」**不成立**：`LOG.md` 的 T054 条目明确列出并覆盖 T055/T056/T057，D8 按完成条目里的任务号取证据，不要求每个任务单独标题。
3. 原 Finding #3 / 矩阵 #6 措辞「report 空 token 释放」不准确：代码当时读取的是 `state.takeover.token`，但 takeover 从未写入该字段，因此真实缺陷是**token 未持久化 → 释放必然失败**，而不是空 token 放行。

**修复状态（全部已闭环并有回归）**

| 原 finding | 修复 | 回归断言 |
|---|---|---|
| 1 快照密钥已入对象库 | 内容扫描前移到 `add`/`write-tree` 之前；读取失败 fail-closed；快照总量受 maxBytes | 「密钥内容从未进入 git 对象库」「密钥文件未被任何树对象引用」 |
| 2 prompt 进 argv | argv 总字节上限 + cwd 存在性校验（`dispatch.json` 本就不存 prompt） | 非法配置不留孤儿待办 |
| 3 report 报成功但锁残留 | token 持久化 + 释放失败即 isError 且保留 takeover | 「report 后锁文件真的被删除」「锁被接管时 report 报错」 |
| 4 state 写盘异常锁状态分裂 | takeover 锁生命周期统一 `finally`；report 先持久化再释放 | 释放失败保留 takeover 状态 |
| 5 快速拉起被 running 覆盖 | 先原子发布占位再 spawn，父进程不再回写 | 「快速命令终态保持 completed」「500ms 后仍是 completed」 |
| 6 dispatch 半写绕过守卫 | 临时文件 + rename；损坏态按 `invalid` → busy | 「半写时 report/drop/takeover 全部被拒」 |
| 7 超时不杀进程树 | detached 进程组 + `kill(-pid)`；超时+8s 有界结算 | 「孙进程持有管道时仍有界结算」 |
| 8 drop 忽略过期锁 | 按锁文件 mtime 与 TTL 判定过期 | 「TTL 过期锁不再阻止 drop」 |
| 9 历史终态信号污染 | 只依据最后一个有效轮次；陈旧 completion 作废 | 「早期 429 恢复后不再误判 quota」「陈旧 end_turn 不能掩盖悬空调用」 |
| 10 报错后文本洗成完成 | `trailingToolError` 保持到成功结果或明确收尾 | 「工具报错后的分析文本不能洗成正常完成」 |
| 11 SQLite 行内 JSON 损坏被吞 | `jsonParse` 返回 `{value, ok}`；`parseIssues` → 分类降级 error | 「行内 JSON 损坏的会话仍列为可抢救」「损坏被显式报告」 |
| 12 tool_result 生成条件混淆 | 按终态生成 + 任意 output 安全序列化 | 「completed + 对象输出不误判悬空」 |
| 13 maxRows 全量后生效 | SQL `LIMIT maxRows+1` | 源码断言 + 超限显式失败 |
| 14 scan 无界读 | 先 stat、有界前缀读 cwd；超限候选保留并明确失败 | 超限 transcript 被拒且无半写 |
| 15 旧卡丢失任务与证据 | `harness → profile` 映射；缺标识 fail-closed | 「旧卡(仅 harness 字段)仍能解析出原始任务」 |
| 附录 1 快照根错配 | drop/edits 用 `state.snapshotRoot` | 嵌套仓库清理（结构断言） |
| 附录 2 显式 metadata 回归 | 显式 `metadata.json` 按所在目录处理 | 「显式 metadata.json 文件可作为 source」 |
| 附录 3 非法配置半写 | 校验前移到任何 TASKS/state 写入之前 | 「被拒后没有遗留孤儿待办」「TASKS 逐字节未变」「锁未遗留」 |
| 附录 6 假绿 `ok(true)` | 删除；改为真实构造 `.relay/rescue` 符号链接并调用 drop | 「符号链接时 drop 被拒绝」「外部目标未被删除」 |

**验证**：`scripts/smoke-rescue.mjs` 172 断言、`scripts/smoke-rescue-zcode-db.mjs` 27 断言、`scripts/smoke-rescue-autolaunch.mjs` 40 断言,三套全绿;`npm test` 26 套(1052 断言);`tools/list` 10,219 / 10,240 字节;`relay_verify full` PASS 11 · WARN 0 · ERROR 0 · SKIP 2。

**复审中追加修复的两条**(不在原 15 条内,由 T059 自身复审发现):
- 快照扫描面曾按前 500 个文件截断,第 501 个起会被 `git add -A` 暂存却未做密钥检查 → 改为「超过上限整体拒绝」。
- `fieldMap` 的 `apiErrorMarker` 只认布尔 `true`,声明式描述符里常见的「错误对象」形态会漏判 → 同时接受对象值。

**仍未覆盖**:Node 22/24/26 三矩阵 CI 需推送后验证;`v2.1.0` tag、CHANGELOG 定版与 Release 属 T059 的人工授权动作,本轮未执行。

