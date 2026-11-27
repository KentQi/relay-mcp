---
title: T062 复验审计 — 旧卡兼容假绿修正、done_tasks[] 三条 fail-open 修复与复审遗留项
version: 1.0
created: 2026-11-26
status: 现行
---

# T062 复验审计

## 结论

**修复属实。** T062 的 8 项修复全部经独立实测验证有效——包括复审代理指控的「旧卡兼容假绿」这条最严重的问题，指控**成立**，且已被真修复（不是又一次假绿）。

残留 3 条，其中 1 条协议卫生问题（中）、1 条功能性边界（低-中）、1 条记录准确性（轻微）。**不构成发版阻断**，但 T060 之前应处理 D1。

| 复审指控 / 宣称 | 裁定 |
|---|---|
| 旧卡兼容是假绿测试 | **成立**——旧 `mapProfileId` 一个真实历史值都不匹配；已真修复 |
| 「测试造假」 | **部分成立**——伪造的是测试夹具值（旧版从不产生的 `harness='jsonl-agent'`），不是断言本身造假；已用真实值重写 |
| done_tasks[] 三条 fail-open | **成立**，已修复并实测闭环 |
| 快照 porcelain `-z` | **成立**，修复有效（带对照实测） |
| dispatch 占位永久卡死 | 成立，修复有效 |
| report 锁释放顺序 | 成立，修复有效 |
| worker 临时配置泄漏 | 成立，修复有效 |
| report 半写用例假绿 | 成立，已改成真正走到 `dispatchBusy` |
| npm test 26 套 / 1089 断言 | ✓ 精确吻合（实测同值） |

## 审计范围与方法

| 项 | 值 |
|---|---|
| 基线 | `eae4d09`（上一轮审计探针入库） |
| 当前 | `475d2f8` |
| T062 差异 | `dc67d24`（代码 + 控制面，9 文件 +313/−89）→ `475d2f8`（LOG 更正，+9/−1） |
| 方法 | 逐行读差异 → **独立构造夹具实跑**（不依赖仓库自带冒烟的断言）→ 对照实验 → 读历史提交核证前提 |
| 探针（已退役） | 当时使用 `scripts/audit/t062-verify.mjs`（旧卡 + F1/F2/F3 + 多任务边界）、`scripts/audit/t062-snapshot-verify.mjs`（快照 `-z` 带对照）；这些一次性探针已随 T062 闭环删除，复核证据以本报告与现行回归套件为准 |
| 代码修改 | 除本报告与两个探针外未改任何代码 |
| 审计限制 | 本轮未派独立子代理交叉复核（上一轮两个子代理均被 Token Plan 429 打掉）；结论由主会话顺序完成，每条均有可复现实测 |

## 一、历史前提的核证（这是本轮最关键的一步）

复审指控「旧卡兼容是假绿」成立与否，取决于**旧版到底写过哪些 `state.harness` 值**。我去查了 T048 的原始实现 `d33d7b2`，而不是采信任何一方的陈述：

```
src/engines/rescue.mjs @ d33d7b2
  :109  harness: 'zcode'                      ← ZCode 发现
  :151  out.push({ harness: 'claude', ... })  ← Claude Code 发现
  :292  harness: cand.harness                ← 写 state（取值同上两个）
  :443  harness: 'zcode'                     ← 显式 source 命中 metadata.json
  :451  harness: 'claude'                    ← 显式 source 命中 jsonl
  :454  const harness = /metadata\.json$/.test(abs) ? 'zcode' : 'claude';
  :699  harness: described.harness           ← 同 :292
  :414  if (state.harness === 'claude' || state.harness === 'explicit')  ← 只比较,无赋值
```

**结论**：真实持久化过的 `state.harness` 只有 **`'zcode'`** 和 **`'claude'`** 两个。`'explicit'` 在 T048 里**只出现在比较分支，从无任何赋值点**——是当年预留的死分支。

旧实现（`eae4d09` 前）的映射：

```js
if (/meta|metadata/.test(key)) return 'json-meta';
if (/jsonl|transcript|message/.test(key)) return 'jsonl-agent';
return value;                 // 'zcode' / 'claude' 落到这里
```

`'zcode'`/`'claude'` 两个正则一个都不匹配 → `state.profile` 被写成原样的 `'zcode'`/`'claude'` → 没有同名描述符 → **旧卡确实打不开**。

而旧回归测试写的是 `legacyState.harness = 'jsonl-agent'`——这个值旧版**从未产生过**（它匹配 `/jsonl/` 正则，所以测试绿）。**这就是假绿的确切机制**：测试用一个虚构的旧值，恰好命中新映射，于是功能坏着而测试绿着。

**裁定：指控成立。** 这是本轮最严重的问题，且是上一轮（我的 T059 复验）没有抓到的——我当时只核对了「断言存在」，没有回溯**断言输入在历史里是否真实存在**。

### 修复的有效性（独立实测）

新映射放在描述符层（`src/engines/rescue-profiles.mjs` 的 `LEGACY_HARNESS_ALIASES`），核心 `rescue.mjs` 只问「这个旧值对应哪个描述符」，不硬编码任何来源名——守住了「核心零 harness 名」的架构约束。

独立探针实测（自己造夹具，不走仓库自带断言）：

```
harness='claude'(记录型)         → isError=false | 含"原始任务"=true  | 含"未注册"=false
harness='zcode'(元数据型)        → isError=false | 含"原始任务"=true  | 含"未注册"=false
harness='some-unknown-harness'  → isError=true  | 含"未注册"=true      ← fail-closed
```

✓ 真实历史值可开、未知值显式报错。

## 二、done_tasks[] 三条 fail-open 的修复验证

探针 `scripts/audit/t062-verify.mjs`（已退役；当时独立构造，不依赖仓库冒烟）：

| 缺陷 | 实测结果 |
|---|---|
| **F1** `done_tasks` 不带 `done_task` | `isError=true`；TASKS 逐字节未变 ✓；LOG 逐字节未变 ✓；**验收门未被执行**（输出无「项目测试入口」）✓ |
| **F2** `done_tasks` 含幽灵任务号 T999 | `isError=true`；LOG 逐字节未变 ✓；LOG 里无 `task=T999 完成` ✓ |
| **F3** 提交消息须带全部任务号 | 2 任务出场：消息 = `relay: session end — T901 完成 · T902 完成 · 2 个任务一起交付`；2 个任务 grep 全部命中 ✓；LOG 2/2 条独立完成条目 ✓ |

修复位置核对无误：F1 在参数校验阶段拒收（早于验收门与任何写盘）；F2 用 `TASK_LINE_RE` 从 TASKS.md 建真实任务号集合后比对；F3 把 `doneTaskIds` 提到参数校验后统一定型，并让 `head` 逐任务展开。

另注：`claimTokens` 由 `doneTaskIds.length ? doneTaskIds : [doneTask]` 改为 `doneTaskIds.length ? doneTaskIds : []`，去掉了 `ownedClaimToken(root, undefined, model)` 这个空任务号调用——是我上一轮报告 F1 时提到的伴生点，一并收掉了。

## 三、其余修复的验证

### 快照 porcelain `-z`（安全面最重的一条）

旧实现手工切分 porcelain 行：`line.slice(3).split(' -> ')` + 去引号。文件名含字面 ` -> `、双引号、反斜杠时解析失配 → **该文件不进内容扫描面，而 `git add -A` 仍会暂存其内容** → 未扫描内容入对象库。

实测（**带对照**）：

```
用例:weird -> name.txt / quo"te.txt / back\slash.txt,内容含 AKIA…EXAMPLE
→ capture 输出:「工作区快照:未生成(拒绝生成快照:待保存内容含疑似密钥
   ("back\\slash.txt"(第 1 行 AWS access key);("quo\"te.txt"(…);("weird -> name.txt"(…));
   未写入任何 git 对象)」
→ 对象库里含密钥原文的 blob 数: 0
→ 建立的快照 ref: (无)
对照:同名文件但内容无密钥 → capture 成功,ref=refs/relay/rescue/rs-…

✓ 三个刁钻文件名被逐个正确点名(说明 -z 解析准确,不是「因别的原因失败」)
✓ 0 blob 入库;对照组证明失败原因确实是密钥而非其他
```

### report 的锁释放顺序

改为**先持久化 state、再释放锁**；释放失败则回滚 state（恢复 `report`/`takeover`/`updatedAt`）并报错。写盘失败则不动锁、保留 takeover，重试安全。原先「注释说先写、代码先释放」的自相矛盾消除。

残留边界（轻微）：若释放失败**且**回滚写盘也失败，磁盘会停在「takeover=null + report 已写」而锁仍在——即原问题在双重故障下仍可能出现。代码注释已声明该取舍（`.catch(() => {})` 后附说明），属可接受的极端边界，非本轮引入。

### dispatch 状态与占位

- 未知 `status`（如 `{}`）→ 按 `invalid` 处理（fail-closed），不再显示「已有任务(undefined)」。
- `running` 且无 pid 且 mtime 超 **120s** → 判为「已失效」，不再永久阻塞 takeover/report/drop。
- 占位发布后任何抛错 → 回写 `failed` 终态（原先会永久停在 `running`）。
- worker 同步 spawn 失败 → 删除含 prompt 的临时配置文件（`rescue-launch-worker.mjs` 的 catch 分支）。

### report 半写用例的假绿

原用例的卡从未 takeover，在持有者校验就返回，根本走不到 `dispatchBusy` 守卫。已改成真正构造半写 dispatch 并断言被拒。

## 四、残留缺陷（3 条）

### D1（中）`475d2f8` 原地手改引擎写的 LOG 摘要行，且无 DECISIONS 记录

**事实**：`475d2f8`（提交消息「docs: 更正 T062 条目摘要…」）对 `dc67d24` 写入的 T062 条目做了**原地内容改写**：

```diff
 ## 2026-11-26 16:49 | model=hungerg-free | task=T062 完成
-- 摘要: 验收诊断2
+- 摘要: T062 修复 done_tasks[] 三条 fail-open 缺陷,并收掉独立复审(T059 修复)报告的遗留问题。…（手写长摘要）
+- 注: 本条目首版摘要误写为「验收诊断2」…这是操作失误,不是工具缺陷;内容在此更正,历史提交不改写。
 - 事实(v2): mode=single | 文件 7 | ± +305/-86 | …            ← 未被改动
+- 负结果: relay_session_end 不是只读的验收检查:…              ← 手写追加
+- 负结果: 验收行不能写 test:scripts/smoke.mjs:…              ← 手写追加（×7）
```

**违反的既有口径**：T046（`TASKS.md:66`）为「事实行被手改」这件事定的处置是二选一——**「回退原行并由引擎重写」**，或**「在 DECISIONS 明确记录本次校正与依据」**。本次**两者都没做**：摘要行被原地替换（不是回退重写），而 DECISIONS 30 条里搜不到 `T062`/`验收诊断`/`摘要更正`（实测为空）。

**为什么这条重要**：R10 的机检面只到**事实行**。同一条目里的 `摘要` 与 `负结果` 行由同一次引擎调用写出，却**没有任何机检覆盖**。所以一次原地手改可以做到 R1–R13 全绿——本仓实测确实全绿（PASS 12 · WARN 0 · ERROR 0 · SKIP 1）。**这正是本项目 R10/D8 一直在防的「手写内容与引擎产物不可区分」形态**：同一轮会话为 T055–T057 拒绝手写完成条目（理由恰恰是「与引擎写的不可区分」），却在这里把手写内容放进了引擎的槽位。

**减轻因素（须一并记录）**：
- `- 注:` 行明确披露了原委与原值（「验收诊断2」在正文里留了字）；
- 事实行未被改动 → R10 仍能对账通过（实测 `R10 PASS 事实对账一致(v2 机检段:7 文件,main)`）；
- git 历史里 `dc67d24` 完整保留原始摘要，「不改写历史提交」这一点做对了。

**修法**：
1. 补一条 DECISIONS，记录本次校正、依据、以及「摘要行属引擎产出」的认定（与 T046 同款处置）；
2. 更根本的：给「引擎写的行不得原地改」补机检——例如让引擎在每条 LOG 条目里写一个行内摘要/commit sha，任何手改都能被检出；否则这条规则仍停留在君子协定。

### D2（低-中）多任务 ≥7 个时，提交消息的 80 字上限截断末尾任务号

`src/config.mjs:13` 的 `DEFAULT_COMMIT_TEMPLATE = 'relay: session end — {{task}}{{summary}}'`；`session.mjs` 的 `commitMaxLen` 在无 `{{evidence}}` 时是 **80**。

多任务 head 长度 = 每任务「Txxx 完成 · 」共 10 字 × N，加上 21 字前缀，最后一个任务号结束于第 `18+10N` 字。于是：

- N ≤ 6：全部任务号都在 80 字内 ✓（实测 6/6 grep 命中）
- **N = 7：T907 被截断**（实测 grep 不到）
- N = 8：T907、T908 都被截断（实测 grep 不到）

```
7 任务:提交消息 = "relay: session end — T901 完成 · … · T906 完成 ·" (80 字)
       7 个任务里 grep 不到「完成」提交的: T907
8 任务:grep 不到: T907,T908
```

**后果**：这些任务的完成提交无法被 R10 的 `git log --grep "<task> 完成"` 反查 → 该任务条目一旦成为「最新完成条目」，R10 退化为 WARN「无法定位对应提交」（`manifest.facts.strict` 打开即升 ERROR，会卡死下一棒出场）。即 F3 的修复在 ≥7 个任务时**没有真正闭环**。

**修法**（任选）：多任务时按任务数放开上限（如 `commitMaxLen = 80 + 10×(N−1)`）；或把完成 token 放在消息尾部；或不用消息而用独立 ref 记录每个任务的完成提交。

**为何仍要记**：T054–T057 那种「一次四个任务」的规模已经在真实历史里出现过；7 个虽窄，但 D1/D2 同属「宣称已闭环而实际有边界」，不该带进 v2.1.0。

### D3（轻微·陈述准确性）「真实历史值只有 zcode/claude/explicit」不准确

如第一节所证，`'explicit'` 在 T048 里只有比较分支、无赋值点，真实持久化值只有 `'zcode'`/`'claude'` 两个。

映射表多这一条是**防御性的、无害**（多了不匹配不出错），但陈述应更正——否则下一个接手人会去找一个从未存在过的历史值，或误以为映射表覆盖了三种历史格式。代码注释 `src/engines/rescue-profiles.mjs` 的 `LEGACY_HARNESS_ALIASES` 上方写的是「T058 之前的持久化值只有三种」，这句应改为两种（并注明 `'explicit'` 是历史死分支，保留映射以防外部写入）。

## 五、状态记录层面的偏差

| 项 | 记录 | 实测 |
|---|---|---|
| 未推送提交数 | 33 | **36** |
| verify 计数 | PASS 10 · WARN 0 · ERROR 0 · SKIP 3 | controlRoot-only full 实测 **PASS 12 · WARN 0 · ERROR 0 · SKIP 1** —— 口径不同（双根出场时 R5/R6/R8 在 executionRoot 侧另计），**不构成矛盾** |
| npm test | 26 套 / 1089 断言 | ✓ 26 套 / 1089 断言，退出码 0 |
| 抢救三套 | — | 实测 smoke-rescue 174/0、autolaunch 53/0 |
| D8 历史 WARN | 有意保留 | ✓ doctor 仍报 T055–T057 |

## 六、操作失误的处置评估

**失误本身**：`relay_session_end` 被当成「只读的验收检查」复跑，而它本身就是出场动作 → 真实出场，摘要被写成「验收诊断2」。**定性正确**：这是操作失误，不是工具缺陷——工具的行为完全符合契约（它就是出场动作）。

**损害范围**：代码/绿闸/锁释放/TASKS 戳记都合法且一致（内容在失误前已完成，`npm test` 1089 全绿）；损害仅限摘要标签写错 + 多出一条完成条目。协议状态自洽（R7/R9/R10 全 PASS，T062 `[x]`，锁已释放）。

**处置选择**：不改写历史提交 + 追加更正提交 —— 这个方向**对**（「证据不得删除，只可回填」）。但更正**落点**选了「同一条 LOG 条目内部原地改写引擎写的摘要行」，而不是「另起一条回填条目」——这就是 D1。

**教训已被记录**：负结果里写下了「`relay_session_end` 不是只读的验收检查:它就是出场动作,复跑会真实提交并盖戳;诊断验收门应看 `isError` 与输出,不要用同一条命令试跑」。这条负结果本身有价值（本轮我核查时也确实只看了 `isError` 与输出）。

## 七、建议

1. **T063（新增）**：补 D1 的 DECISIONS 记录 + 给「引擎写的行不得原地改」补机检（行内摘要/commit sha）。
2. **T063 同批**：D2 的提交消息上限按任务数放开，并补一条 ≥7 任务的回归断言。
3. **D3**：改 `src/engines/rescue-profiles.mjs` 的 `LEGACY_HARNESS_ALIASES` 上方注释（现写「T058 之前的持久化值只有三种」）；同时 LOG 里 T062 条目的负结果「旧卡兼容必须先查真实历史值…真实值只有 zcode/claude/explicit」这句也应更正为两种。
4. **T060（发布）**：D1/D2 不阻断发版，但既然宣称已闭环，宜在发版前顺手收掉；否则 CHANGELOG 里「多任务出场已闭环」的措辞需要下调。

## 八、与前两轮审计报告的关系

- `docs/04-test/10-audit-rescue-fixes-v1.0.md`（v1.2）附录 C 的 D8 裁定**继续成立**：`doctor.mjs` 的 `completionIdsOf` 只读标题行的 `task=` 字段，T055–T057 的历史 WARN 是既成事实、有意保留。
- `docs/04-test/11-audit-t061-donetasks-v1.0.md` 的 F1/F2/F3 **全部闭环**（本报告第二节实测），但 F3 留有 ≥7 任务的边界（本报告 D2）。
- 本轮暴露的方法论缺口：上一轮我把「断言存在」当成「断言有效」。**断言的输入必须在历史里真实存在**，否则就是自己骗自己——这与本项目「无信任交接」的第一原则同源，建议写进审计方法论并作为后续所有回归断言的准入条件。
