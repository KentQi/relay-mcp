---
title: T061 复验审计 — done_tasks[] 多任务出场与 autoLaunch prompt 脱敏
version: 1.0
created: 2026-11-26
status: 现行
---

# T061 复验审计 — done_tasks[] 多任务出场与 autoLaunch prompt 脱敏

## 结论

**request-changes。**

T061 的两项交付都在，测试全绿，宣称基本属实。但 `done_tasks[]` 这条新路径有 **3 条可复现缺陷**（2 高 1 中），其中 2 条是**静默失败**：工具返回「绿闸:通过」，协议面却什么都没记下来——正是 `done_tasks[]` 要解决的那类问题在另一条路径上原样复现。

`autoLaunch` 的 prompt 脱敏**已真正闭环**，本轮未发现绕过路径。

## 审计范围与方法

| 项 | 值 |
|---|---|
| 基线 | `89c1722`（T059 合并提交） |
| 当前 | `7009cb4`（T061 合并 `9945b3d` + 报告 v1.2 `7009cb4`） |
| T061 差异 | 代码 `8630fde`（12 文件 +281/−68）；控制面 `29cc5af`（LOG.md +12 / TASKS.md +5） |
| 方法 | 逐行读差异 → 追踪调用链 → 构造临时仓库实跑 `relay_session_end` / `relay_verify` / `relay_doctor` |
| 取证方式 | 全部 3 条 finding 均为**实测复现**，非静态推断；探针脚本在 `/tmp/t061-probe{,2,3}.mjs` |
| 代码修改 | 除本报告外未修改任何代码；审计期间工作区保持干净 |

> **审计限制**：本轮原计划派 2 个独立审计子代理交叉验证，两个都被 Token Plan 429 打掉（`已达到 Token Plan 用量上限`），改由主会话顺序完成。结论因此**未经独立第二视角复核**，但每条 finding 都有可复现的实测证据。

## 一、状态记录宣称核对

| 宣称 | 核对结果 |
|---|---|
| T061 代码 `29cc5af` + 控制面 `8630fde` + merge `9945b3d` | SHA 齐全，但**职责标签贴反了**：`8630fde` 才是代码提交（12 文件，含 `src/engines/session.mjs`、`src/engines/rescue.mjs`、`scripts/`）；`29cc5af` 只含 `LOG.md`+`TASKS.md`，是控制面。协议顺序（先代码后控制面）本身正确 |
| `npm test` 26 套 / 1074 断言全绿 | ✓ 精确吻合（实测 26 套 / 1074 通过 / 0 失败，退出码 0） |
| rescue 三套断言 172 / 27 / 40；autolaunch 49 | ✓ autolaunch 实测 49/0；其余两套由 `npm test` 覆盖 |
| `tools/list` 10,218 / 10,240 | ✓ `scripts/smoke-budget.mjs` 的 `tools/list ≤ 10240 bytes` 断言通过 |
| 工作区干净 | ✓ `git status --porcelain` 空 |
| 未推送 31 个提交 | 实际 **32**（多出事后补交的报告 v1.2 `7009cb4`） |
| `relay_verify` PASS 10 · WARN 0 · ERROR 0 · SKIP 3 | 我实测 controlRoot 单根 full = **PASS 12 · WARN 0 · ERROR 0 · SKIP 1**。差异来自口径（记录里的数字是双根出场的合计，R5/R6/R8 在 executionRoot 侧另计），**不构成矛盾** |
| D8 仍报 T055–T057 WARN（有意保留，机制已补） | ✓ `relay_doctor` 实测一致：`D8 完成状态 \| WARN \| TASKS 标 [x] 但 LOG/归档无完成条目:T057, T056, T055`。DECISIONS 有 T061 条目记录该取舍 |
| autoLaunch prompt 脱敏「argv / dispatch.json / dispatch.log 均无原文」 | ✓ 实测通过，且追链未发现绕过（见第四节） |

**结论：宣称属实，无虚报。** 唯一的两处偏差是提交职责标签贴反与未推送计数差 1，均属记录瑕疵。

## 二、确认缺陷（3 条，均实测复现）

### F1（高）`done_tasks` 不带 `done_task` 时静默无操作——工具报「绿闸:通过」但一个字节都没记

`src/engines/session.mjs:1552`

```js
const doneTaskIds = doneTask ? [doneTask, ...extraTasks] : [];
```

`done_task` 在 schema 里是**可选**的（`src/contract.mjs:97` 的 `required: ['model', 'summary']`），但 `doneTaskIds` 一旦主任务缺席就退化成空数组。三个消费点各自踩坑：

| 消费点 | 位置 | `done_task` 缺席时的行为 |
|---|---|---|
| TASKS 盖戳 | `:1483-1486` — `for (const t of extraTasks) markTaskDone(t);` **嵌在 `if (doneTask) {` 内部** | 额外任务**不盖 `[x]`** |
| LOG 完成条目 | `:1587` — `const fields = doneTask ? [taskField, ...extraTasks.map(...)] : [taskField];` | LOG 只写一条 **`task=无`** 的条目，不是 `task=T### 完成` |
| 认领锁释放 | `:1827` — `const claimTokens = doneTaskIds.length ? doneTaskIds : [doneTask];` | 额外任务的**认领锁不释放**（继续挂 240 分钟 TTL） |

而验收门是照跑的：`:1271` 的 `acceptanceGate(root, t, cfg, executionRoot)` 对每个额外任务都执行。

**实测**（`relay_init` 临时仓，T903 已认领）：

```
relay_session_end { model:"probe-model", summary:"只传 done_tasks", done_tasks:["T903"] }
→ isError: false
→ 输出: "## 绿闸:通过" / "controlRoot 全量 13 项 — ERROR 0 · 无 WARN"
→ 验收执行门: "- [T903] - 项目测试入口:`npm test` 通过"      ← 跑了
→ TASKS 里有 [x] T903 : false                                ← 没记
→ LOG 里有 task=T903 完成: false                             ← 没记
→ LOG 实际条目: "## ... | model=probe-model | task=无"
→ 认领锁仍存在: true                                          ← 没释放
```

**后果**：调用方（含模型）看到「绿闸:通过」，合理地认为 T903 已完成；而 D8 仍然看不见 T903——这正是 `done_tasks[]` 被造出来要消灭的那个缺口，换了一条路径原样复现。认领锁滞留还会让下一个会话在 240 分钟内无法认领该任务。

**修法**：`done_tasks` 非空时，`done_task` 缺失应当 isError 拒收（"请同时给出主任务 done_task"）；或把 `doneTaskIds` 改为 `doneTask ? [doneTask, ...extraTasks] : [...extraTasks]`，并把 `:1483` 的 `if (doneTask)` 块改成对 `doneTaskIds` 统一遍历。**任一方向都必须是 fail-closed**——现状是 fail-open。

**契约违反**：`docs-design/CONTRACT.md:463-464` 明文承诺「每个任务都会得到自己的 TASKS `[x]` 行、自己的认领锁释放、以及独立的 LOG 完成条目」。实现未兑现。

### F2（高）`done_tasks` 里的任务号在 TASKS 中不存在时，会写入一条**假的完成条目**，且 R9 结构性地看不见它

`src/engines/session.mjs:1464` · `src/engines/session.mjs:963` · `src/engines/verify.mjs:355`

三处叠加：

1. **所有权校验放行**：`completionOwnershipError`（`:963`）对找不到的任务行 `if (idx < 0) return null;`——直接返回"无错误"。`done_task` 走这条路径是既有行为，但 `done_tasks` 把一个**拼错的/尚未登记的任务号**也放进了同一个入口。
2. **盖戳只警告不失败**：`markTaskDone`（`:1464`）对 `findTaskIdx` 返回 -1 的任务只 push 一条 `警告: TASKS.md 未找到任务行 ${taskId}`，然后继续往下走。
3. **R9 只看最新一条完成条目**：`checkR9`（`verify.mjs:355`）取 `const newest = entries[0];`——文件顺序里的第一条。多任务出场时文件顺序是 `[主任务, 额外任务…]`，额外任务的条目**永远不是 `entries[0]`**，于是 R9 永远不核对它们。

**实测**（`done_task:"T901"` + `done_tasks:["T999"]`，T999 不在 TASKS）：

```
isError: false
TASKS 有 [x] T901: true    TASKS 有 T999 行: false
LOG 里有 task=T999 完成: true
LOG 条目: ["## … | task=T901 完成", "## … | task=T999 完成", …]
relay_verify full → | R9 | PASS | LOG/TASKS 一致(T901 已标 [x]) |
                     | R7 | PASS | 最近 2 条任务会话中 2 条为「T### 完成」… |
                     汇总: PASS 12 · WARN 0 · ERROR 0 · SKIP 1 — 通过
```

**后果**：LOG 里留下一条声称「T999 完成」但 TASKS 里根本没有 T999 的**假完成证据**。R9 看不见（只查第一条），D8 也不管（它查 TASKS→LOG 方向），R7 反而把它计为一次"完成"从而消掉发散报警。三条机检同时失效——这正是 R10/D8 一直在防的"手写假绿"，只是这次由引擎自己写。

引擎其实**知道** T999 是幽灵任务——同一次输出里就写着 `⚠ [T999] 任务 T999 认领锁释放缺少 token,拒绝按归属不明删除`——但它仍然照写了完成条目。

**修法**：`done_tasks` 的每一项在写入任何东西之前必须存在 TASKS 任务行，否则 isError 拒收（fail-closed）。附带修 R9：多任务出场后应核对**全部**完成条目而非仅 `entries[0]`。

### F3（中）额外任务的完成提交无法被 R10 反查，额外任务条目一旦成为「最新完成条目」，R10 退化为 WARN

`src/engines/session.mjs:1380` · `src/engines/verify.mjs:487` · `src/engines/facts.mjs:222-230`

- **提交消息里只有主任务号**：`:1380` 的 `const managedHead = doneTask ? \`${doneTask} 完成 · \` : '';`（单根路径同理）。实测 `git log --grep "T902 完成"` **命中为空**，只有 `git log --grep "T901 完成"` 命中。
- **R10 靠这条 grep 反查完成提交**：单根模式下事实行不带 sha，R10 用 `git log --10 --fixed-strings --format=%H --grep "${taskId} 完成"` 定位（`verify.mjs:487`），再挑「diff 文件数与事实行声明一致」的那一个。
- **回退路径也会失效**：grep 无命中 → `completionSha = ''` → `recomputeCommitStats` 退回「HEAD 就是完成提交」，但该路径要求 HEAD 的 subject 匹配 `/T\d+\s*完成/`（`facts.mjs:229`）。HEAD 一旦是维护提交或别的任务的提交，就返回 null → R10 WARN。

**触发路径**（主任务条目被幂等去重时，额外任务条目就会顶到文件第一位）：会话 1 完成 T901 → 会话 2 幂等重跑 T901 + 补交付 T902（T901 条目被去重，T902 条目新写，落到文件顶部）→ 会话 3 维护出场（HEAD 变成维护提交）。

**实测**：

```
会话 2 后 LOG 条目顺序: ["… task=T902 完成", "… task=T901 完成", …]
会话 3 后 relay_verify full:
  | R10 | WARN | 事实行存在(声明 0 文件),但无法定位对应提交,数字对账无法完成 |
  汇总: PASS 11 · WARN 1 · ERROR 0 · SKIP 1 — 通过
```

**后果**：R10 是"完成条目必须有可复算事实"的执法点。额外任务的完成条目一旦落到第一位，对账能力就归零——不是"对不上"（那会 ERROR），而是"算不了"（WARN，`facts.strict` 打开即升 ERROR，会卡死下一棒出场）。默认 WARN 不阻断，所以这是**沉默的能力退化**，不是显性故障。

**附带**：协议自述的完成戳考古路径也断了。`TASKS.md:7` 的行注释与 `session.mjs:1475` 的代码注释都写着「完成提交反查 `git log --grep "T### 完成"`」，而完成戳本身不记 sha。对额外任务，这条路径**必然返回空**。

**修法**（二选一）：
- 提交消息里带上全部任务号（如 `T901 完成 · T902 完成`），让 grep 能命中；
- 或让 R10 在多任务条目下回退到"按 facts.since 之后的候选提交 + 文件数匹配"定位，而不是依赖 task 号 grep；
- 或给额外任务的完成条目写**各自独立**的事实行（含各自 sha）。

## 三、修复优先级建议

| 序 | 缺陷 | 建议动作 | 验收 |
|---|---|---|---|
| 1 | F1 | `done_tasks` 非空且 `done_task` 缺失 → isError 拒收（fail-closed） | 断言：拒收后 TASKS/LOG 逐字节未变、认领锁仍在、**验收门未被执行** |
| 2 | F2 | `done_tasks` 每项必须存在 TASKS 任务行，否则 isError；R9 改为核对全部完成条目 | 断言：`done_tasks:["T999"]` 被拒且不写 LOG；R9 能发现「LOG 有完成条目但 TASKS 无该行」 |
| 3 | F3 | 提交消息含全部任务号，或 R10 改用不依赖 task 号的定位 | 断言：`git log --grep "T902 完成"` 有命中；额外任务条目在首位时 R10 仍 PASS |

建议登记为 **T062**（修复 `done_tasks[]` 三条缺陷），验收写成可执行命令；T060（发布）应排在它之后——带着这三条发版，等于把新参数的第一版缺陷发出去。

## 四、已核实**没有**问题的部分（避免只报问题不报好消息）

| 检查项 | 结论 |
|---|---|
| **autoLaunch 脱敏链路完整性** | `validateAutoLaunch`（`rescue.mjs:60-101`）是**唯一**构造子进程 argv 的地方（全文件仅一处调用点 `:1086`）；vars 全量过 `redactSecrets`；`{{}}` 用函数式 replace，替换值不二次展开；`launch.command`（已脱敏）→ `startAutoLaunch` → `cfg.command` → worker `spawn(cfg.command[0], cfg.command.slice(1))`，链上无旁路 |
| **卡片落盘面** | `rescue.mjs:855` 写进接力单的 prompt 也已过 `redactSecrets`；`.relay/rescue/` 已在 `.gitignore:16`；`dispatch.json`/`dispatch.log` 实测无密钥原文 |
| **受管 worktree 拒绝 `done_tasks` 的时序** | `managed` 定义于 `:1039`，拒绝分支在 `:1082`，**早于**验收门（`:1268` / `:1271`）、TASKS 盖戳（`:1461`）、仓库锁获取（`:1310`）→ 无半写。**变量定义顺序也正确**（`:1039` < `:1082`），不是 TDZ 隐患 |
| **D5 冒烟 9 断言** | 覆盖 happy path 属实：双 `[x]`、两条独立完成条目、两个认领锁都释放、非法入参（非数组 / 非任务号）不写 LOG |
| **LOG 幂等回归修复** | `taskAlreadyDone` 改按「任务实际已完成才查重」，维护出场（`task=维护`/`task=无`）不再被误判为重复——P6 回归确已修复 |
| **多任务时间戳顺序** | `stamp()` 是分钟精度（`util.mjs:155`），同一次出场的多条目时间戳相同，LOG「最新在上」的顺序不破（跨分钟边界才可能倒序，属极窄窗口） |
| **`done_tasks` 与受管树的衔接** | 受管树下 `done_tasks` 直接 isError，理由（一个任务 = 一条分支 + 一条 registry 记录）写进输出，方向正确 |

## 五、文档与记录层的不一致（轻微）

1. **提交职责标签贴反**：状态记录写「代码 `29cc5af` + 控制面 `8630fde`」，实际 `8630fde` 是代码（12 文件含 `src/`），`29cc5af` 是控制面（仅 LOG.md + TASKS.md）。协议顺序正确，只是标签贴反。
2. **未推送提交数**：记录说 31，实测 32（多了事后单独补交的报告 v1.2 `7009cb4`）。
3. **`docs-design/CONTRACT.md:463-468`** 未写明 `done_task` 与 `done_tasks` 的从属关系（"每个任务都会得到…"读起来像是 `done_tasks` 自足），这是 F1 能存在的契约侧原因。修 F1 时应同步补这一句。
4. `session.mjs:1779` 的输出提示只提主任务的 `git log --grep "${doneTask} 完成"`，多任务时对额外任务是误导（见 F3 附带）。

## 六、未覆盖边界

| 项 | 说明 |
|---|---|
| 独立第二视角 | 2 个审计子代理均被 Token Plan 429 打掉，本轮结论未经跨模型复核 |
| 受管 worktree 多任务路径 | 受管树下 `done_tasks` 被直接拒收，该路径只有"拒绝"一个分支可达，未深入构造多根场景 |
| Node 22/24/26 三矩阵 | 本机仅 Node 26；CI 未覆盖当前 HEAD |
| 发布面 | `v2.1.0` tag / CHANGELOG 定版 / GitHub Release 均未做（属 T060，人工授权动作） |
| 历史 T055–T057 缺口 | 仍报 D8 WARN（有意保留，DECISIONS 已记录）；本轮未回填——手写完成条目与引擎写的不可区分，正是 R10/D8 要防的假绿 |

## 七、与上一轮审计报告的关系

`docs/04-test/10-audit-rescue-fixes-v1.0.md`（v1.2）附录 C 的 D8 裁定在本轮**继续成立**：`doctor.mjs:62-68` 的 `completionIdsOf` 只读条目标题的 `task=` 字段，T054 条目正文里的「T054–T057」不参与取证，`relay_doctor` 在当前 HEAD `7009cb4` 上仍报同样的 WARN（已实测）。附录 B 第 2 条的撤回是正确的。

T061 新增的 `done_tasks[]` **没有**改变这条取证口径——它是在 D8 之上另开了一条「一次多任务」的路径，而这条路径本身有 F1/F2/F3 三处 fail-open。
