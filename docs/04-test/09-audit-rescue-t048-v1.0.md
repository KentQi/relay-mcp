---
title: relay_rescue(T048) 独立审计报告 — max 级多专家并行 + 原子级验证
version: 1.0
created: 2026-11-26
status: 现行
---

# relay_rescue(T048) 独立审计报告

## 审计配置

| 项 | 值 |
|---|---|
| 执行器 | MCP `cc-code-review` v1.19.0(claude CLI 2.1.325) |
| 模型 | MiniMax-M3(经 cc-switch 本地代理 `127.0.0.1:15721`) |
| 级别 | `reviewLevel=max` / `effort=max` |
| 管道 | fleet:10 个 finder 专家并行 → 每候选独立验证器 → Phase 3 缺口扫 |
| 范围 | `baseRef=acab8de..HEAD`(4 commits,28 文件,+1688/−115) |
| 核心对象 | 新增 `src/engines/rescue.mjs`(991 行)与第 15 个 MCP 工具 `relay_rescue` |
| 预算 | 不限额 |
| 结论 | **request-changes** — 15 条 finding,全部经独立验证器逐条裁定 |

## 总评

`relay_rescue` 的骨架、文档与工具契约都很扎实,但新引擎在**五个安全/正确性边界**上不成立:

1. 不可信 transcript 的围栏可被 payload 自己闭合;
2. `state.json` 明文写入了铁律禁止落盘的 `prompt`,并被当作「原任务」直接派发;
3. `Bash` 命令完全绕过 `redactSecrets`;
4. takeover 绕过 `writeProtocolFile` 直写 `TASKS.md`(丢掉密钥闸与内容 CAS);
5. **中断分类双向错判**——子代理恰好死在「工具已执行、下一轮还没开口」时会被判成「正常完成」而**根本不可抢救**;正常跑完的代理只要历史上出现过一次工具报错就会被判成「可抢救」。

此外两个新配置项 `manifest.rescue.sources` / `maxAgeDays` 因读错层级而完全失效(7 天窗口永不生效);快照链路静默吞掉失败并谎报「无未提交改动」,且密钥防护只看文件名不看内容;接力锁在两条提前 return 上泄漏 240 分钟;`report` 的手工 unlink 绕过 token fencing;`drop` 不检查是否有人持有就会递归删掉卡片与快照 ref。

这些不是风格问题——它们分别会让「抢救」静默失效、让未提交改动丢失、或让不可信文本进入下一模型的指令位。

## Findings(15)

### [CRITICAL] 1. state.json 明文落盘 `prompt`/`classification`,接力提示词用的正是未被哈希覆盖的那份

`src/engines/rescue.mjs:699-701, 854`

铁律 2 与公开契约都写死「`state.json` 只存**不可派生**的锚点…prompt / 中断类别 / 末尾叙述每次调用从 transcript 即时派生,**不落盘**…因此没有第二真相源」,但 `state` 对象恰恰写入了 `prompt: described.prompt`、`lastNarrative`、`classification`。`loadTranscript` 的 sha256 复核只覆盖 `transcript.json` 副本,`state.json` 自身无任何完整性校验;而 `actTakeover` 用的是 `state.prompt`(不是刚解析出来、已被校验的 `t.parsed.prompt`)。

**更糟的是这道闸是自指的**:期望哈希就存在同一份未受保护的 `state.json` 里,任何能写该目录的进程同时改掉 `transcript.json` 与 `state.sha256` 即可通过;而 `if (state.sha256 && …)` 在哈希为空时**整道检查被静默跳过**。ZCode 纯元数据卡(`transcriptFile === ''`)更是全程无任何校验。

**修复**:从 `state` 删除 `prompt`/`lastNarrative`/`classification`,一律从**已校验的** transcript 重新派生;哈希为空时 fail-closed 而非跳过;期望哈希移出 `state.json`(或用 HMAC 覆盖 `state.json` 自身)。

### [CRITICAL] 2. 围栏不转义反引号,transcript 可自行闭合围栏并把内容推进「指令位」

`src/engines/rescue.mjs:49, 851`

`fence()` 只是 `['```'+lang, text, '```'].join('\n')`,不处理 payload 里的 ```。payload 是完全可控的多行文本(第一条 user message 原样拷入)。攻击者只需在 prompt 里单独一行放 ```,围栏即提前闭合,其后内容(包括注入文本与 `RELATED_TASK=…`/`交回结果:{…}` 等 relay 自己的指令行)以**普通 markdown** 落在围栏之外——正是「数据非指令」边界要防的位置。`DATA_BANNER` 只是建议性文案,不是结构性屏障。

日常场景(父代理在 prompt 里贴代码块)也会无恶意地破坏这个边界。

**修复**:对所有不可信文本先转义反引号(如替换为 `` `\`\` ``),或改固定长度 fence + 逐行加前缀;并把接力提示词改成「描述原任务」而非把原文嵌进可派发提示词。

### [MAJOR] 3. 中断分类双向错判

`src/engines/rescue.mjs:197, 210, 254-257`

`danglingToolUse` 只在**最后一条**记录是 assistant 且含 `tool_use` 时为真(`:210`),`toolError` 却是**扫描全部历史记录**得到的(`:197`)。于是:

- **(a)** 子代理死在「工具已执行、tool_result 已落盘、下一轮 assistant 还没开口」这个窗口——也就是「悬空工具调用」最典型的形态——最后一条是 `user(tool_result)`,`danglingToolUse=false`、`toolError=false`、无 apiError,一路落到默认分支 `kind:'complete'`。`renderScan` 把它放进「已正常完成」,`actCapture` 再以「已正常完成」拒绝。**这个工具存在的核心场景反而查不到人**;只发过一条 prompt 就被杀的代理(仅 `[user]` 一条记录)同样如此。
- **(b)** 反方向:代理某条命令失败过一次、重试成功并正常收尾,那一条历史 `is_error` 让 `toolError=true` → 判为 `kind:'error'` → 列为可抢救,还附上**事实错误**的证据;`takeover` 于是为一只已跑完的代理登记假的接管任务。

**修复**:把「末条」判定改成「末条 assistant 之前是否存在未配对的 tool_use」;「末条是 user(tool_result) 且其 tool_use 无后续 assistant 回应」直接判 `interrupted`;`toolError` 只在**末尾相邻**的工具调用失败时才算;夹具补「末条是 user」与「历史报错但正常完成」两种形状。

### [MAJOR] 4. `manifest.rescue.sources` / `maxAgeDays` 读错层级 → 完全失效

`src/engines/rescue.mjs:416, 452`

`readManifestConfig` 把它们放在 `cfg.rescue.sources` / `cfg.rescue.maxAgeDays`(`src/config.mjs:186-192`),但消费者读顶层 `cfg.maxAgeDays`(`:416`)与 `cfg.sources`(`:452`)——两处恒为 `undefined`。

- `configured` 恒为 `[]`,`manifest.rescue.sources` 无法限制扫描范围;
- `maxAgeMs = undefined * 86400000 = NaN` → `cutoff = NaN` → 年龄过滤彻底失效,用户历史上**所有**子代理(每适配器上限 400)都会被列为可抢救并逐个解析。

同一函数里 `maxBytes` 却读的是 `cfg.rescue.maxBytes`(`:627`/`:655`),自证这两个是笔误。

**修复**:`:416` 改 `cfg.rescue.maxAgeDays`,`:452` 改 `cfg.rescue.sources`;补「maxAgeDays=1 时超过 1 天的候选不出现」断言(当前零覆盖)。

### [MAJOR] 5. takeover 用裸 `writeFileAtomic` 直写 TASKS.md,绕过密钥闸与内容 CAS

`src/engines/rescue.mjs:802`

`util.mjs:346-347` 明写「TASKS/LOG 只能经由本函数落盘,任何调用点(claim / session_end / **未来工具**)都自动受保护」,所有其他写入点都走 `writeProtocolFile`。rescue 绕过它 →

- **无 `scanSecrets` 闸**:写进 TASKS.md 的 `备注: …接力者 ${model}` 与标题里的 `state.agentId` 可含密钥样式串,而 TASKS.md 在控制面提交白名单内,下一次 `relay_session_end` 会把它 commit 进 git 历史(不可撤回);更糟的是此后**每一次** `relay_claim`/`relay_session_end` 都会被 `scanSecrets` 抛 `ProtocolSecretError`,协议写面被一张接力单锁死;
- **无 `expectedHash` 内容 CAS**:读(`:798`)与写(`:802`)之间的人工改动被静默覆盖。

**修复**:改用 `writeProtocolFile(controlRoot, 'TASKS.md', inserted.text, { token: repoLock.token, lockLabel: '仓库写锁', expectedHash: sha256Hex(tasksRaw) })`。

### [MAJOR] 6. `report` 用空 token 调 `releaseFileLock`(必然失败)后按 holder 名手工 unlink → 绕过 token fencing

`src/engines/rescue.mjs:893-903`

`releaseFileLock(..., '', ...)` 命中 `util.mjs:606` 的空 token 早退,恒返回 `{ok:false}`,所以 `rel` 是死变量;真正的释放走「读文件 → 比对 holder 字符串 → `unlink`」,全程不校验 token、也不做符号链接拒绝。

协议自己警告「同名 model 无法区分持有者」,而 `acquireFileLock` 的 `sameHolder` 分支恰好让同名会话 **adopt** 同一 token——于是 A 的 report 会把 B 正在持有的活锁删掉,派发权互斥消失。另外 `state.takeover = null` 在**任何释放之前**就写盘了,锁释放失败时状态与锁即已脱节。

**修复**:把 takeover 拿到的 `lock.token` 存进 `state.json`(如 `state.takeover.token`),report 时用真实 token 释放;删掉手工 unlink 分支。

### [MAJOR] 7. takeover 的两条提前 `return` 泄漏接力锁 → 卡片被锁 240 分钟却仍显示「待接力」

`src/engines/rescue.mjs:797, 799`

`:797`(`!fence.held`)与 `:799`(`TASKS.md` 不存在)都在 `try` 内 `return fail(...)`——`fail` 是普通 return 不是 throw,`catch` 不执行,而 `finally` 只释放 **repoLock**;接力锁留在盘上(holder=本次 model、heartbeat:false)。

`state.takeover` 只在 `:822` 赋值,所以磁盘上仍是 `null`,卡片在简报里继续显示「待接力」,但任何**其它**模型的 takeover 会因 `staleMs=240min` 被判未过期而拒绝。`:824` 的 `state.json` 写盘抛异常同样会带着锁一起逃逸。

**修复**:把 `try` 块整体包进 `try { … } finally { 释放接力锁 }`,或在所有失败路径显式 `lock.release()`。

### [MAJOR] 8. 快照失败被静默吞掉并谎报「无未提交改动」;`commit-tree` 缺身份兜底

`src/engines/rescue.mjs:360, 723`

`snapshotWorktree` 在每条错误路径上都认真算了 `note`,但 `actCapture` 只取 `snap.ref / snap.commit / snap.excluded`——全文件对 `snap.` 的读取只有三处,`snap.note` **从未被读**,也从未落进 `state.json`。于是 `snapshotRef` 为空时输出恒打印「(无未提交改动或非 git 仓库)」,**「快照失败」与「现场本来就干净」在输出上完全不可区分**。

而 `:360` 的 `git commit-tree` 没走仓库自带的 `gitIdentityArgs` 兜底(`util.mjs:141-152`,注释明写「CI 容器常无 user.name/email…曾导致本地绿 CI 红」),在无身份容器里必然 fatal。**可证伪信号**:`smoke-rescue.mjs:119` 建基线提交只带单次 `-c` 覆盖、不落任何 `user.*` 配置,因此在无身份环境里这条路径会红——本分支尚未推送,CI 还没跑到。

**修复**:把 `snap.note` 落进 `state.json` 并在 capture/show 输出区分「无改动」与「快照失败(原因)」;`commit-tree` 加 `...(await gitIdentityArgs(executionRoot))`;快照失败时 fail-closed 或显式告警。

### [MAJOR] 9. 快照的密钥防护只覆盖文件名,且「失败即全放行」

`src/engines/rescue.mjs:344-352, 363-364`

`:343` 的注释承诺「排除疑似密钥文件:快照会进 git 对象库,密钥一旦成对象就难撤回」,但有两层漏洞:

- **只看文件名不看内容**:`findSensitiveChanges` 只匹配路径,而仓库**已经有**内容级扫描器 `scanSecrets` 却从未被快照路径调用。被救代理在任意**其它**文件里硬编码的 `sk-ant-…` / `AKIA…` 会被 `git add -A` 正常暂存、写进**真实对象库**、并被 `update-ref refs/relay/rescue/<id>` 永久挂住,一次 `git push --mirror` 就出机器。
- **排除逻辑失败即全放行**:`statusRes.ok ? … : []` → `excluded` 变空 → `git add -A` 不带任何排除 pathspec。触发面是 status 单独失败(真实 index 损坏、`.git/index.lock` 争用),此时 `read-tree`/`add` 走临时 index 照常成功,于是密钥入对象库,而输出仍呈现为一次正常快照。

**修复**:status 失败时 **fail-closed**(仓库已有范式:`session.mjs:1348` 的 `rejectCommit`);并对暂存内容跑 `scanSecrets`,命中则拒绝快照。

### [MAJOR] 10. takeover 接受 `<你的模型标识>` 占位符(而工具自己就打印它)+ `sameHolder` adopt → 互斥失效

`src/engines/rescue.mjs:754, 769`

`relay_claim` 明确拒收占位符(`session.mjs:747`),而 rescue 的 takeover 只拒控制字符,**工具自己在 `:591` 与 `:732` 打印的就是 `"model": "<你的模型标识>"`**。

模型照抄后:接力锁 holder 变成占位符;第二个同样照抄的会话因 `sameHolder` 命中 adopt 分支,**拿到 `ok:true` 而不报「派发权已被持有」**,互斥直接消失;而它随后按提示去 `relay_claim` 会被拒收 → 卡片被一个永远无法认领的 holder 占住 240 分钟。

**修复**:takeover 复用 claim 的同一套 model 净化(`/[<>]/`、`你的模型|your model`、控制字符)。

### [MAJOR] 11. transcript 的 Bash 命令完全不经 `redactSecrets` 回显,并进入「可直接派发的接力提示词」

`src/engines/rescue.mjs:557, 576, 859`

`redactSecrets` 被逐字用在 prompt / narrative / todos / description / evidence / note / summary 上,唯独**命令列表**三处出口全部裸奔:卡片「跑过的命令」、`view=commands`、接力提示词里的「它跑过的命令」。

子代理一次 `export ANTHROPIC_AUTH_TOKEN=sk-ant-…` 或 `curl -H 'x-api-key: sk-ant-…'` 就会把密钥原样搬进模型上下文和下一棒的派发提示词——而铁律 5 与契约都宣称「输出前脱敏密钥样式串」。夹具把密钥放在 narrative(会被脱敏)里,所以现有断言照常绿。

**修复**:`commands` 与 `edits[].path` 同样过 `redactSecrets`;冒烟加「命令中含密钥」夹具。

### [MAJOR] 12. 未净化的 `agentId` 被写进 TASKS.md → 换行可伪造任务行,密钥样式串可入库

`src/engines/rescue.mjs:800`

`title = \`接手抢救单 ${state.agentId || state.id}(…)\`.slice(0,120)`,`insertTodo` 原样拼成 `- [ ] __ID__ ${title}` 并 splice 进 TASKS.md;`slice(0,120)` 不会去掉换行。

`agentId` 来自 ZCode `metadata.json` 的自由 JSON 字段或显式 `source` 指定的**任意** metadata.json(该分支明确「不校验归属」)。`model` 有控制字符检查,`agentId` **一个都没有**——与既有铁律「model/task 会写入锁文件与 TASKS 任务行,换行/控制字符可伪造协议行 → 拒收」自相矛盾。R13 只是事后检查器,伪造行若格式合法、日期合法、无重号会直接判 PASS。

**修复**:对写入 TASKS.md 的所有外部字符串先过 `hasControlChars` + 单行化,再走 `writeProtocolFile`。

### [MAJOR] 13. 工作区快照拍的是抢救者的 `executionRoot`,不是被救子代理的 `cwd`

`src/engines/rescue.mjs:675`

`snapshotWorktree(executionRoot, …)` 里所有 git 操作都用**发起调用这次会话**的 `executionRoot`;被救子代理自己的 cwd 被解析出来并写进 `state.cwd`,却**从未被任何地方读取**。

受管 worktree 模式下 `controlRoot ≠ executionRoot`,而归属过滤接受两者内的任意 cwd,于是「子代理在主仓根干活、抢救者在 `.relay/worktrees/T###`」是合法且常见的组合——此时快照里装的是**无关会话的脏改动**,被救代理的未提交改动一个字节都没进去;而输出仍对接手模型宣称「未提交改动的快照在 git ref X」,接手者据此认为现场已保存,放弃重建。若被误拍的工作树恰好干净,连那句误导性提示都没有——现场被静默丢弃。

**修复**:快照根改用 `described.cwd`(realpath 后校验仍在控制根内);两者不一致时卡片与提示词必须显式说明「快照的是 X 目录,不是 Y 目录」。

### [MAJOR] 14. `drop` 不检查是否有人持有、也没有符号链接防线 → 递归删掉卡片与快照 ref

`src/engines/rescue.mjs:933`

`actDrop` 只检查 `isSafeId(id)` 与「state 存在」,**没有 `model` 参数、没有 `state.takeover` 判断、没有锁文件读取**;`confirm:true` 之后无条件 `rm(rescueDir, {recursive:true, force:true})` + `git update-ref -d state.snapshotRef`。

接力锁就住在被删目录里,快照 ref 是那份未提交改动的**唯一引用**(不建分支/tag),`update-ref -d` 之后该 commit 变成不可达、最终被 gc。结果:正在接手的模型其 `report` 直接报「接力单不存在」,结果无处落盘;被救现场永久丢失——正是这个工具要保的东西。

同文件 `actCapture` 有 `assertNoSymlinkComponents`,`actDrop` 没有;若 `.relay` 或 `.relay/rescue` 是符号链接,`rm` 会作用到仓库外子树。该路径零测试。

**修复**:`drop` 前检查持有者;补 `assertNoSymlinkComponents`;dry-run 打印持有者;补「持有中不可删」与「`.relay` 为符号链接时拒绝」两个用例。

### [MINOR] 15. `smoke-rescue.mjs` 存在恒真/空转断言,自己声明的红线「report 释放」从未被断言

`scripts/smoke-rescue.mjs:194, 350, 362`

- `:350` `const state = JSON.parse(before ? '{}' : '{}'); ok(state !== null, '夹具占位')` —— 两分支相同、断言恒真,标签自称「夹具占位」;
- `:194` 对**相对路径** `refs/relay/rescue-stash/T048SMOKE` 做文件检查,且该 ref 从未被创建,永不可能失败;
- `:362-364` 的「无待接力单时简报不出现待接力小节」被 `if (remaining === 0)` 包住,而按执行序列 `remaining === 2`,**该断言根本不执行**;
- 脚本头声明的红线「report 释放」**没有任何断言**——两个 report 点都不检查 `takeover.lock` 是否已删,而 report 的释放失败被吞进 `released = false`,这类回归照样全绿。
- `:263` 注释写「模拟 201 分钟前」而代码回拨 241 分钟,一旦按注释改回 201,断言会在锁**未过期**时因错误原因通过。

「80 断言」算术上对(79 处源码 `ok(`,运行时执行 80 次),虚高的是**有效可证伪率**。

**修复**:删恒真断言;`:234` 改成断言**新增**任务号与标题(现正则未限定「待办」小节,模板自带的 T002/T003/T004 会让它空转通过);无条件执行简报小节断言;补「report 后 `takeover.lock` 不存在」;注释与代码对齐。

## Notes — 已核实但严重度低于 15 条

- **`status=running` 一律判「疑似被杀」,无停滞判据**(`:252`):契约写「元数据仍为 running **且已停滞**」(「已停滞」在 `src/` 里根本不存在)、夹具 prompt 写「还在跑,不应被列为可抢救」、而冒烟却断言它**必须**出现在可抢救区——三方口径互相矛盾;活着的代理会被二次派工。
- **环境变量绕过 manifest 护栏**(`:963-964`):`config.mjs:5-6` 写着「配置面全部落在 `.relay/manifest.json`…**不接受环境变量——护栏若可被环境绕过,就不是护栏**」,而 `RELAY_RESCUE_MAX_BYTES` 覆写 `cfg.rescue.maxBytes`,还把它当正式补救途径推荐给用户。
- **`MAX_SCAN_CANDIDATES=400` 在归属过滤之前就截断且不报告**:有 800+ 子代理的机器上,本项目的失败代理可能正好落在 400 之外,于是 scan 打印「可抢救(0) — 没有属于本项目的失败/中断子代理」,一句不成立的话。
- **超限 transcript 在 scan 里两边都不出现**:`oversize` 既进不了 `rescuable` 也进不了 `done`,只剩 notes 而 notes 只对 rescuable 打印 → 「可抢救(0)」,而 capture 的「提高 maxBytes」提示从 scan 根本够不着。
- **capture 吞掉另外三处诊断**:`scanned.notes`/`scanned.skipped`、`described.sourceError`、`described.notes` 均无输出读者。
- **START.md 准入探测用 `inputRoot` 而非 `controlRoot`**(`:953`):`relay_rescue {root:"/repo/src"}` 会被误报「尚未接入」,而其他工具都是先解析 controlRoot,rescue 是唯一例外。
- **显式 `source` 按 `process.cwd()` 解析、`~` 不展开**:`source:"~/.zcode/…"` 被当字面量;相对路径相对于 **MCP server 的 cwd** 而非 `root`。
- **归属闸 fail-open(完整触发面)**:首行解析失败、首行可解析但不带 `cwd`、前导空行、BOM、记录里没有 `cwd`——任一情况都会让 `cwd` 为空并被放行。`claudeCandidates` 从不给候选设 `cwd`,所以**每个** Claude 候选都走这条路径;ZCode 分支在缺 cwd 时则是跳过的——两个 harness 方向相反。
- **`scan` 输出没有「数据非指令」横幅也不加围栏**:不可信的 prompt/错误原文与可直接执行的 capture JSON 模板处在同一段上下文,而 scan 是模型看到的第一个 relay 输出。
- **`redactSecrets` 只替换 PEM 头**:私钥 base64 正文原样输出且被标成已脱敏,比直接漏掉更危险。(该 helper 的 `new RegExp(re.source, flags+'g')` 写法本身**没有问题**——每条规则新建实例,无 `lastIndex` 残留。)
- **`git status` 会刷新真实 index 的 stat 缓存**(`:344`):该调用未带 `GIT_INDEX_FILE` 也未设 `GIT_OPTIONAL_LOCKS=0`,所以「绝不触碰真实 index」字面上不成立——但只是 stat 缓存刷新,**暂存内容不变**,影响低;而冒烟的「index 逐字节不变」断言恰好对这次写入盲视。
- **`relay_rescue` 的 inputSchema 缺 `task`**,而引擎会读 `args.task`;`model` 描述未说明 report 必须与 takeover 持有者一致;`show` 在描述里没提。
- **`tools/list` 压缩的一处事实错误**:`relay_worktree_cleanup` 的 `ttl_hours` 默认值被写成「24」,真实默认是 `manifest.worktree.ttlHours`——模型可能据此显式传 `ttl_hours:24` 提前回收任务 worktree。`relay_recall` 的 `status:" "` 约定也被删而注释仍声称承诺。其余压缩(`Only JSON true`/`ignored`/`two commits`)都还在且被 `smoke-compat` 钉住,预算未被放宽。
- **`session_start` 优先级被悄悄改了**:`rescueSection` 分支插在 `firstTodo` 之前(完整链 errors → inProgress → rescueSection → firstTodo),而工具描述/`relay://protocol`/CONTRACT/CHANGELOG 都仍写「topmost actionable task」,无测试守护。饿死是**软锁**:同一模型可自己接管自己那张卡。同一份接力列表在简报里出现两次,「≤5 行」实际约 11 行,`共 N 张` 用的是全部卡片数而非待接力数。
- **文档漂移**:CHANGELOG 与 CONTRACT 仍写「抢救后自动拉起 = **T049**」,而 T049 已并入 T051;CONTRACT 的「完整配置面」清单没补 `rescue` 键;`plugin.json` 描述改成「15 个工具」但版本仍是已发布的 `2.0.0`,且 `smoke-plugin` 只校验版本号不校验描述。
- **死代码**:`MAX_TASKS_PER_TAKEOVER` 与 `snapshotWorktree` 的 `sensitiveSkipped` 声明后从未使用;接续链实际是「最近一张卡」而非「同一代理的链」,导致同签名告警既会误报也会漏报。

## 修复顺序建议(审计方给出)

1. **先堵信任边界**:#1 state.json 真相源、#2 围栏逃逸、#11 命令脱敏、#12 agentId 注入
2. **再修分类器**:#3 双向错判
3. **再修协议写入**:#5 TASKS 旁路
4. **配置与快照**:#4 配置层级、#8 快照静默失败、#9 快照密钥防护
5. **最后收口锁与测试**:#6 report fencing、#7 锁泄漏、#10 占位符、#14 drop、#15 测试有效性

## 审计方法学备注

- **原子级验证**:每条候选由独立验证器复核,只保留可逐行复现的(15/86 通过验证,无一条被推翻)。被驳回或降级的候选未列入本报告。
- **并发上限**:3 个验证器因 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20` 触顶被跳过,其后由重试代理完成,结论已并入最终版。
- **仓库未被修改**:`git status` 全程干净,未向 GitHub 发布任何内容。
- **模型一致性**:经 cc-switch 代理时模型 id 被统一路由到 MiniMax-M3;`~/.claude/settings.json` 的 remap 已在隔离 `CLAUDE_CONFIG_DIR` 中避开,未改动用户全局配置。
- **只读策略告警**:审计期间 89 条 Bash 命令未被执行策略拦截(均为 `git log/diff/status`、`ls`、`grep`、`gh` 等只读命令),属审查器沙箱的 hook 覆盖缺口,已记录但不影响结论。

## 后续

本报告只做记录,**未据此修改任何代码**。修复按「同一根因合并」登记为任务,每条带可执行验收。
