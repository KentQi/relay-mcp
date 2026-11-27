---
title: 深层原子级扫描审计 — 中低危、损坏/不一致/低效/冗余清单与逆向压力测试
version: 2.1
created: 2026-11-27
status: 现行
---

# 深层原子级扫描审计(v2.1.1 基线)

## 结论

**不是「全部没问题」,但也不是「推翻重做」。** 代码主干(锁协议、CAS、原子写、fencing、双根绿闸)经得起复核,没有发现需要推翻架构的缺陷。但存在 **核心 10 条 HIGH + 自更新集成面 4 条 HIGH**;其中 5 条是主审**亲手复现**的(仓库外写入、整进程永久挂死、跨机器复现性断裂、R10 空洞对账、未过期锁被接管),其余由独立代理复现后主审核对代码路径。另有 **20+ 条 MEDIUM 候选**(M7 因可达性降级为 LOW)、**36+ 条 LOW/TRIVIAL**(含文档措辞、退出码不统一、测试假绿/重复、冗余/不再需要物)。

**本次审计推翻了自己的一条既有结论**:R10「事实对账」的机检段不是「与 git 重算逐字段一致」——`base`/`sha` 是**被信任的输入**,且它们**定义**了被重算的区间。该弱点此前已被 DECISIONS(T061)作为「手写完成条目不可区分」的诚实取舍记录,但 `AGENTS.md`/`relay_rules` 曾写着「base/sha 与 git 重算逐字段一致」——**这句在旧口径下是假的**,必须改口径;T071 已把目标契约改为 registry/commit 独立锚定,实现仍须按该目标验收。

审计以只读方式进行;真实仓库的代码与协议文件未被改动(HEAD 仍是 `0d8764b`)。唯一新增物是本报告 `docs/04-test/13-audit-deep-scan-v2.1.md`(未跟踪)。

---

## 1. 方法与边界

- **6 个专家代理并行**,分维度:文档一致性 / 退出码与错误统一 / 死代码与冗余 / 测试质量与脆弱性 / 协议规则实现漂移 / 自更新与 harness 集成。
- **专家结论一律不直接采信**。所有 HIGH/MEDIUM 主张均由主审**独立复现或逐行核对代码**后才进入本报告;未能复现的一律降级或剔除(见 §3 边界假设推翻)。
- 复现一律在 `/tmp` 的克隆或副本内进行,`git clone` / `cp -R` 后再动手;真实仓库全程 `git status` 干净。

---

## 2. 逆向压力测试(5 组边界异常 / 假设推翻)

> 每组:先立一个「看起来没问题」的假设 → 构造边界异常 → 逆向施压 → 结论。

### 压力测试 1 — 「R2 通过 = 顶层结构合规」

- **假设**:本机 `relay_verify` 报 `R2 PASS(共 27 项)`,顶层结构没问题。
- **边界异常**:把仓库克隆到 `/tmp`,模拟一个**正常使用 ZCode / video2code 的开发者**(这两个工具本会话就在本机创建了 `.zcode/plans/`、`.v2c/`、`out/`)。
- **施压结果**:
  ```
  | R2 | ERROR | 顶层越界: .zcode, out ⊄ allowedTopLevel
  | 汇总 | PASS 9 · WARN 1 · ERROR 1 — 不通过(存在 ERROR)
  ```
  **整个出场绿闸被阻断。**
- **假设推翻的原因**:本机之所以 PASS,是因为 `.git/info/exclude` 里手写了 `.v2c/`、`.zcode/`、`out/` 三行——**这个文件不在版本控制里**,克隆不过去。CI 之所以绿,是因为 runner 上没有这些目录。**R2 的 PASS 依赖两处都不在仓库里的状态。**
- **二阶影响**:R2 的修复指令写的是「**显式修宪**:编辑 `.relay/manifest.json` 的 allowedTopLevel 加入 [.zcode, out]」。开发者照做就会把本机工具目录**永久写进项目宪法**,并影响所有克隆者。而 `.gitignore` 一行就能解决(已实测:R2 回到 PASS)。**协议给的修复建议会把一个 gitignore 遗漏升级成修宪。**
- **结论**:`.gitignore` 补 3 行(**不要**改 `allowedTopLevel`)。

### 压力测试 2 — 「`relay_recall` 是待办队列的索引」

- **假设**:契约写「one compact row per task from LOG.md + TASKS.md」(`src/contract.mjs:206`),recall 应该能列出待办。
- **边界异常**:本仓库 `TASKS.md` 有 2 行 `[ ]` 待办,`LOG.md` 里没有它们的任何条目(它们从未被执行过)。
- **施压结果**:
  ```
  relay_recall --status 待办  →  命中 0 条
  无命中:放宽 query/status 或省略过滤条件。
  ```
- **假设推翻的原因**:`relayRecall` 的行**只从 LOG 条目派生**(`src/engines/recall.mjs:131`),`tasks` 表只用来给已有 LOG 条目补状态。**没有 LOG 条目的待办任务在结构上不可见。** 而错误提示「放宽 query/status」把模型指向**错误的方向**(真实原因是「无 LOG 条目」)。
- **二阶影响**:`relay_get` 的指引是「先 relay_recall 拿索引」——**导航路径在最需要它的地方断了**。一个只读 `relay://protocol` 就按流程走的模型,会先信 recall(0 条,停工),再读 TASKS.md(看到队列头,去认领)——两个信号互相矛盾。

### 压力测试 3 — 「『无待办』占位任务不是真任务」

- **假设**:TASKS.md 的 `- [ ] T070 无待办 — v2.1.1 已发布…` 只是占位说明。
- **边界异常**:让一个模型**严格按协议走**:`relay_session_start` → 认领队首 → 干活 → `relay_session_end`。
- **施压结果**(在 `/tmp` 副本里完整跑完一轮):
  ```
  STEP 1  session_start →「待办(前 3): - [ ] T070 无待办 …」
  STEP 2  relay_claim T070 → 成功:建 worktree、建 relay/T070 分支、建 240min 认领锁、TASKS 挪进「进行中」
  STEP 3  relay_session_end →「验收执行门:未通过 — npm test 超时(180s)被终止」
          修复建议:「让上述测试真正通过(而不是删测试/改验收行),再重跑 relay_session_end」
  ```
  残留状态:`.relay/claims/T070.lock`(持有中)、`.relay/worktrees/T070`、`relay/T070` 分支、registry `status:"active"`、TASKS 里 T070 是 `[~]`、LOG 里 **0 条** T070。
- **假设推翻的原因**:占位任务**完全可认领**。而且它带一个真实验收行(`npm test && ./verify`),于是绿闸拿它当真任务跑;跑不过就**建议模型去修测试**——而真正的问题是**这个任务不该存在**。模型既不能完成(验收跑不过),也不能放弃(协议明确「没有 abort/release 工具」),只能等 **240 分钟 TTL**。
- **三阶影响**:
  1. 每次空转都留一个 worktree + 分支 + 锁,进而在 `relay_claim`/`session_start` 里以 `listUnmergedTaskBranches` 的成本反复出现。
  2. 若最终被认领并完成,会往 LOG 写一条「T070 完成 · 无待办」的**假完成条目**,而 **R9 随后会要求 TASKS 里 T070 也是 `[x]`**——**协议会为这个假任务背书**。
  3. 每条完成条目消耗 LOG 活跃区行数,把 R12 推向超限(本仓库当前已 152 > 150,WARN 常驻)。
- **结论**:占位行不该是 `[ ]`。要么用**引擎不解析的状态**(如缩进/HTTP 注释),要么让引擎识别「无待办」类标题并不入可认领队列。

### 压力测试 4 — 「CLI 与 MCP 同源,行为一致」

- **假设**:`src/cli.mjs` 与 MCP 都调 `dispatch()`,工具逻辑不会分叉。
- **边界异常**:用 CLI 的「顺手」写法 `--json ids=T067,T068` 传数组参数。
- **施压结果**:
  ```
  node src/cli.mjs relay_get --root . --json ids=T067,T068
  → 「缺少 ids:传 ids: ["T013", "T019"]」   ← 参数其实传了
  ```
  根因:`--json k=v` 用 `parseValue` 逐个解析,`"T067,T068"` 解析失败 → **回落成字符串**;`relayGet` 收 `Array.isArray(ids)` 为 false → 报「缺少 ids」。
- **假设推翻的范围**:契约里 `relay_get.ids`、`relay_session_end.done_tasks`、`relay_session_end.negative_results` 是数组,`relay_session_end.next` 是对象——**4 个结构化参数在 CLI 的 k=v 模式下全部不可达**,且失败信息都指向「没传」。
- **二阶影响**:`done_tasks[]` 正是 T061/T062 两轮刚做完的核心能力(多任务出场逐任务落证据),它的**验收路径是 CLI**(`验收: npm test && ./verify`)。也就是说**这个特性在 CLI 的易用模式下根本用不了**,只有 MCP 或整段 JSON 才能触达。
- **附带**:`--json next.title=x` → 键名带点 → 引擎读到 `args.next === null` → **静默不创建 next 任务,退出码 0**;`--json negative_results=-foo` → 同样静默丢弃。同一个根因,两种可见性。

### 压力测试 5 — 「CLI 输出完整」

- **假设**:`src/cli.mjs:105` 写完 stdout 就 `process.exit()`,输出不会丢。
- **边界异常**:stdout 是**管道**且输出超过管道缓冲。
- **施压结果**:
  ```
  期望 300000 字节 → 管道实收 131072 字节(截掉 56%)
  ```
  (写文件重定向不丢,只有管道丢——因为文件写是同步的,管道写是异步的。)
- **假设推翻的原因**:`process.stdout.write` 对管道是异步的,`process.exit()` 不等它排空。这是 Node 的经典陷阱,而 `templates/verify.sh` 与本仓库 `verify` 都是 `exec node src/cli.mjs relay_verify …`,输出通常直接进终端/管道。
- **二阶影响**:`relay_verify` 输出若被截断,**表格尾部(含「汇总」行)会消失**——CI 里 `verify | tail -1` 之类的用法会读到**空的或半截的**结论。当前输出仅 ~1.9 KB 未触发,但 `relay_get`(最多 5 个完整条目)与 `relay_session_start` 简报量级不同,一旦 LOG 变长就会踩到。
- **结论**:退出前等 stdout 排空(`await new Promise(r => process.stdout.write('', r))`),或改用 `process.exitCode = N` 让 Node 自然退出。

---

## 3. HIGH(7 条)

| # | 问题 | 位置 | 证据 | 影响 |
|---|---|---|---|---|
| **H1** | `relay_sync` 经**悬空符号链接**把入口文件写到**仓库外**,且报告为正常成功 | `src/engines/sync.mjs:127` | 实测:`AGENTS.md -> /tmp/EVIL-OUTSIDE.md`(悬空)→ sync 输出「AGENTS.md \| 重建(原缺失)」→ **`/tmp/EVIL-OUTSIDE.md` 被创建,6292 字节,首行 `<!-- relay:generated v1 -->`** | 任意路径写入(以当前用户权限);**无告警、无错误**。入口文件被链到仓库外很常见(dotfiles / monorepo) |
| **H2** | `acquireFileLock` **无限忙等**:`readLockSnapshot` 抛错被 `.catch(()=>null)` 吞掉 → `continue` **同时跳过 deadline 检查与 200ms 退避** | `src/util.mjs:525-526` | 实测:`.relay/relay.lock` 权限 000 → `readFile` EACCES → `relay_claim` **15 秒超时仍未返回**(exit 124);隔离到 `acquireRepoLock` 同样挂死 | **整个 MCP server 永久挂死**:`rpc.mjs` 是严格串行队列,一个永不 resolve 的 promise 会让后续所有工具调用排队到天荒地老。且 `relay_claim`/`session_end`/`sync`/`restructure`/`archive`/`cleanup` 全部取这把锁 |
| **H3** | R2 顶层白名单依赖**不在版本控制里**的 `.git/info/exclude` | `.gitignore` / `.relay/manifest.json` | 实测:克隆 + 建 `.zcode/`、`out/` → **R2 ERROR → 绿闸阻断**;补 3 行 `.gitignore` → R2 PASS | 见压力测试 1。**跨机器复现性断裂** |
| **H4** | `relay_sync` / `relay_restructure` / `relay_rescue` **完全没有符号链接防线** | 三引擎均未调用 `checkProtocolFilesSafe` / `assertNotSymlinkFile` | 全库映射:`session.mjs`/`archive.mjs`/`bootstrap.mjs`/`worktree.mjs`/`config.mjs` **有**;`sync.mjs`/`restructure.mjs`/`rescue.mjs` **无** | H1 是它的实例;`restructure.mjs:135,153,170` 写 TASKS/LOG/DECISIONS 也走同一条路 |
| **H5** | `relay_restructure` 用裸 `writeFile` 写 **TASKS.md / LOG.md / DECISIONS.md / manifest.json**:无原子性、无 CAS、无 fencing;而它自己的注释宣称「与 writeProtocolFile 同一口径」 | `src/engines/restructure.mjs:20,135,153,170,238` | 逐行核对:`assertNoSecrets` 只复制了**密钥闸**,没有 CAS/原子重写/fencing | 崩溃 → 半份 TASKS.md(整个任务队列没了,尚未提交,git 也救不回);并发 → 覆盖他人写入;**注释与实现不符 = 文档级不一致** |
| **H6** | `relay_session_end` 的临界区是 `try{…}finally{…}`,**没有 catch** | `src/engines/session.mjs:1408` 起,`:1986` 收尾 | 逐行核对:其余引擎(`relay_claim:951`/`sync:305`/`restructure:280`/`onboard:579`/`rescue:1305`)都有 catch | 异常逃到 `dispatch` 的通用兜底 `contract.mjs:554` → **吐 4 行 JS 栈(含绝对路径)**;若发生在 TASKS 写成功、LOG 写失败之间 → **TASKS 已盖 `[x]`、LOG 无条目**,R9 从此长期报错,认领锁不释放 → 只能人工收拾 |
| **H7** | R10 的「事实对账」是**自指**的:`base`/`sha` 被信任,且它们**定义**了被重算的区间 | `src/engines/facts.mjs:213-217` | 实测:把真实事实行(base=8c9d550…,sha=b5d4551…,文件 3)改成 `base=sha=b5d4551…\|文件 0\|±+0/-0` → **`R10 PASS`**(真实提交改的是 3 个文件) | **注**:此弱点的「手写条目不可区分」部分已由 DECISIONS(T061)显式接受为诚实取舍。**新问题是文档口径**:`AGENTS.md` 与 `relay_rules` 写着「机检段(mode/文件数/base/sha/branch)与 git 重算逐字段一致」——**base/sha 从来没被重算过**,这句是假的。要么改口径,要么把 `base` 锚到 registry 的 `baseSha`/`merge-base`,并要求 `sha` 必须是带 `T### 完成` 主题的那个提交 |

| **H8** | **认领锁过期判定有两个真相源,可导致未过期锁被接管**:`readLockSnapshot` 用**文件 mtime**算 `ageMs`(`util.mjs:475-477`),doctor 用锁内 `acquiredAt` 并先 `Math.round` 到分钟(`doctor.mjs:208-213`)。**主审双向实测**:(A) `acquiredAt` 旧、mtime 新 → doctor 与 claim 不一致;(B) `acquiredAt` 刚写、mtime 被设旧 240m29s → **doctor 报「1 把锁均在 TTL 内」,claim 却成功「接管自 ghost」**。恢复旧备份会自然带回旧 mtime;同持有者补写 token 的原子 rename 则会把 mtime 刷新,造成另一种「该过期却接不过」 | `util.mjs:475-477`、`doctor.mjs:208-213` | **仅对 `heartbeat:false` 的认领锁**改用锁内 `acquiredAt` 精确毫秒比较;有心跳的仓库写锁必须继续用 mtime(否则 20s 心跳只更新 mtime、不更新 acquiredAt,会把活锁误判过期)。doctor/claim 共享同一过期助手;补 mtime/acquiredAt 背离测试 |
| **H9** | **验收超时只杀直接子进程,孙进程可在绿闸失败后继续写仓库** | `src/engines/session.mjs:182,196` | **主审 500ms 最小复现**:`execFile` 超时回调 `killed:true`,父进程已死,但其 detached 孙进程 3 秒后仍成功写出 `SURVIVED` 文件。`exec`/`execFile` 的 `timeout` 不会递归杀进程树。**三阶风险**:绿闸已返回失败/退出,测试进程却继续跑,可能继续产生构建产物、接触文件、甚至执行到测试里的写操作;下一次 session 看到的是「被一个已判失败的验收污染的现场」 | POSIX `spawn(...,{detached:true})` + 超时杀 `-pid` 整组并等待 close;Windows `taskkill /T /F`;或至少明确记录孙进程残留风险 |
| **H10** | **测试套件存在结构性假绿**:`smoke-rescue.mjs:646-648` 只对源码正则检查三个导出;把 `BUILTIN_PROFILE`/`profileFromSpec`/`resolveAllProfiles` 实现删掉或改成抛错,断言仍通过。`smoke-doctor.mjs:51` 名义「覆盖 D1–D9」,实际只检查输出含 `D1` 和 `D9`;删掉 D2–D8 的实现也绿 | `scripts/smoke-rescue.mjs:646-648`、`scripts/smoke-doctor.mjs:51` | 主审逐行确认。改为运行时 import 后调用真实函数;doctor 对 D1..D9 **逐项**断言存在且各行有预期结果/修复语义 |

---

## 4. MEDIUM(20 条)


**协议行为类**

- **M1** 「无待办」占位任务可被认领 → 240 分钟死锁(压力测试 3)。
- **M2** `relay_recall` 只索引有 LOG 条目的任务,待办不可见;契约文案overclaim(压力测试 2)。
- **M3** CLI `--json k=v` 无法表达数组/对象;`ids`/`done_tasks`/`negative_results`/`next` 不可达;未知键被静默丢弃(压力测试 4)。
- **M4** CLI 管道输出被 `process.exit` 截断(实测 131072/300000)(压力测试 5)。
- **M5** **`ttl_minutes` 与 `maintenance` 未进 MCP `inputSchema`**。`relay_rules:453` 与 `AGENTS.md` 都把「传 `ttl_minutes` 覆盖 TTL」写成崩溃恢复路径,但 `relay_claim` 的 schema 只有 `{root,task,model,worktree}`——**MCP 驱动的 agent 无法缩短 TTL,只能干等 240 分钟**;`maintenance` 是唯一能把 LOG 写成 `task=维护`(从而被 R7 排除)的开关,同样不可达 → **CLI 与 MCP 会产出结构不同的 LOG 历史**。
- **M6** `tools/list` 预算只剩 **22 字节**(实测 10218/10240),而**加一句话要 105 字节** → 任何一次常规文案增补都会红 CI;且「砍哪句」是任意的,长期会系统性削掉对模型最重要的指引。
- **M7** `relay_sync` 在**引擎自己的** `templates/*.tpl` 缺失时会输出**自相矛盾的一对句子**:`全部入口文件与模板再生内容一致,无漂移。`(`sync.mjs:291-295`,要求 `rewritten/created/drift` 三者皆空)+ `### 说明 - templates/AGENTS.md.tpl 缺失,AGENTS.md 跳过`(`sync.mjs:114-117` 的 note)。**首次尝试未能复现**——因为 `templatesDir()` 解析的是**引擎模块所在目录**(`util.mjs:36-37`),不是目标仓的 `templates/`;只有当**引擎自身的模板目录**受损(损坏安装)时才走到。附带结论:**`relay_sync` 投影的是「引擎所在处」的模板**,目标仓自带的 `templates/` 不参与——对 relay-mcp 自身即同一棵树,对「用别的路径上的 relay-mcp 接管的仓」则两者可能不一致。此项降为 LOW(仅损坏安装可达),但那句「无漂移」是**在同一次输出里说谎**,应当改成有 note 时不提「一致」。
- **M8** manifest 损坏被静默吞掉 → **全部策略回落默认值**(`worktree.enabled=false`、`facts.enabled=false`、`protectedPaths=[]`、`acceptance.commands=[]`);而 manifest 本身又是裸 `writeFile` 写的(`bootstrap.mjs:348,499`、`restructure.mjs:238`)→ 截断即降级。
- **M9** `relay_sync` 写入口文件、`rescue.mjs:1053` 写 transcript.json 都是裸 `writeFile`。transcript.json 正是被 sha256 保护的那份 artifact —— 半写会让「篡改检测」误报成「被篡改」。
- **M10** `relay:secret-ok` 的修复建议在写入路径**不生效**:`writeProtocolFile` 的 `scanSecrets` 明确不接受标记豁免(`util.mjs:378`),但 R11 检测器接受 → 照工具自己的建议做,会得到一个「R11 通过但引擎拒绝写」的死循环。
- **M11** R12 的修复建议可能是死路:`verify.mjs` 只承认**第一个有效**指针,`archive.mjs:25` 认**第一个指针行** → 上面放一个失效指针,R12 说「去跑 relay_archive_log」,而后者是 no-op。
- **M12** `relay_recall`/`relay_get` 归档后失明:`buildModel` 只读 `LOG.md`,不读 `docs/archive/LOG-*.md` → 被归档任务的「负结果 / 留给下一个」从检索面消失(`session.mjs:576` 明确说这是「LOG 的存在理由」)。**实测**:归档前 recall 命中 13 条 → `relay_archive_log {keep:8}` 后命中 8 条;`relay_get T059` 返回「日志: (无对应 LOG 条目)」,而归档文件里明明还有 4 处 T059。**这条与 R12 构成正面冲突**:R12 的修复建议就是「跑 relay_archive_log」,而跑完之后,5 条历史任务的负结果(协议明确要求「不要盲目重试负结果」)就从检索面消失了 —— **为了满足边界规则,牺牲了协议最核心的「负结果可取回」承诺**。
- **M13** R7 的 3 会话窗口在归档后**可能退化到 <3**:`archive.mjs:67` 保留的是 N 条**条目**,不是 N 条**任务会话**;维护条目(`task=无/维护`)不计入 R7 却占保留位。本仓库当前无维护条目故未触发,但 `maintenance` 不在 MCP schema(M5)意味着 MCP 会话普遍会写 `task=无` → **触发条件反而被 M5 放大**。

**执行面类**

**退出码实测表(`src/cli.mjs` 的口径只有 0 / 1 / 2)**

| 情形 | 退出码 | 是否合理 |
|---|---|---|
| 工具正常返回 | 0 | ✅ |
| 工具返回 `isError:true` | 1 | ✅ |
| CLI 用法错误(未知参数 / JSON 非法 / `--root` 缺值) | 2 | ✅ |
| 未知工具名 | 1 | ✅ |
| **`relay_archive_log`:目标目录没有 LOG.md** | **0** | ❌ 「查无此项」被当成成功 |
| **`relay_recall`:query 一条都没命中** | **0** | ❌ 同上 |
| **`relay_get`:ids 全部未找到** | **1** | ✅ |
| **`relay_rescue`:接力单不存在** | **1** | ✅ |
| **`relay_verify`:有 WARN(如 R12 超限)** | **0** | ⚠️ 可接受,但 CI 无法要求「WARN 也红」 |
| `relay_session_end`:提交失败已降级 | 0 | ⚠️ 只在文本里说,退出码区分不了「已提交」与「提交失败」 |
| 测试钩子 `RELAY_CRASH_AT_WRITE` / `RELAY_CRASH_BEFORE_COMMIT` | 137 | ⚠️ 生产代码里的崩溃注入点(见 §5 L28) |

同一语义类(「你问的东西不存在」)给出 **0 / 1 两种结果**:CI 里用 `relay_archive_log` 探「归档是否最新」,路径写错时会**假绿**。


- **M14** `listUnmergedTaskBranches` 是 1+N 次 git 子进程(每个 `relay/*` 分支一次 `merge-base`),且在**每次 session_start 和每次 claim** 都跑(实测 4 分支 = 5 次 / 792ms)。可换成 1 次 `git branch --no-merged HEAD --list 'relay/*'`。
- **M15** `relay_session_end` 把 manifest **读 3 次**,而它自己的注释写着「一次性读入」(`session.mjs:1302-1308`)——既浪费,也带来**撕裂读**窗口(三次读可能返回不同 manifest)。`session_start` 已经用对了模式(`session.mjs:610`)。
- **M16** `MAX_SCAN_CANDIDATES = 400`(`rescue.mjs:39`)**是死常量**;真正生效的 400 在 `rescue-profiles.mjs:278,297,361`——**跨全部 source 的聚合上限根本不存在**,`scanSources` 会把各 source 各 profile 的候选全攒起来。
- **M17** `relay_rescue action=capture` **不可重入**:每次调用生成新 card id + 新 git ref(`rescue.mjs:992`),客户端超时重试就会产生两张卡、两个 ref,两条接续链 → 两个 agent 可能同时接手同一份死掉的工作。
- **M18** 「查无此项」的退出码不统一:`relay_archive_log` 无 LOG → **0**;`relay_recall` 无命中 → **0**;`relay_get` 全未找到 → **1**;`relay_rescue` 缺卡 → **1**。CI 里「探一下归档是否最新」会因路径错而**假绿**。
- **M19** 验收门 180s 超时对本仓库**偏紧**:压力测试 3 里 `npm test` 触发「超时(180s)被终止」。**该次测量处于并发负载下**(同机另有 2 个 `npm test` 与多个代理的临时副本在跑),因此不能断言「干净环境也超 180s」。**续跑逐套测量(27/27 exit 0)总计 143.53s,余量仅 36s(20%)** → 正确结论是「**不是结构上必超时,而是门限脆弱**」,详见 §9 计时表。验收门仍把「测试慢」与「测试红」压成同一条错误信息(「`npm test` 失败(项目测试入口不绿)」),模型无从区分,于是会去改测试。超时时长硬编码在 `session.mjs:179,194,371`(`timeoutMs = 180000`),**不可配置**(`manifest.acceptance` 的白名单里只有 `commands`)。
- **M20** `.relay/worktrees.lock` 是**从未被创建过**的文件的 gitignore 条目,却被 `smoke-compat.mjs:129` 与 `smoke-worktrees.mjs:610` 两条断言**钉死存在** → CI 为一个不存在的文件保绿。

---

## 5. LOW / TRIVIAL(29 条)

**文档措辞与版式**

- **L1** `src/contract.mjs:350,362,382,395` —— **「relay relay」重复 4 处**(`relay relay work session` / `relay relay project` / `relay relay session`)。这是直接给模型看的 prompt 文本。
- **L2** `src/rpc.mjs:21` `DEFAULT_INIT_RESULT` 硬编码 `version: '1.0.0'`,而 `src/index.mjs:15` 用 `PKG.version`(=2.1.1)。该函数实际是死代码(`index.mjs` 总会传 `onInit`),但版本号漂移留在源码里。
- **L3** 过时的工作包标记:`contract.mjs:4` 「由 W3/W4 并行开发」、`:328` 「Spec template not found (W1 pending?)」、`:495` 「engine 模块尚未就绪(W3/W4 并行开发中,集成者补齐即可)」——**这三条会展示给用户**,2026 年了还在叫模型等集成者。全库另有 9 个文件头带 `(W2)/(W3)/(W4)`。
- **L4** `AGENTS.md` / `relay_rules` 对 R3 的表述默认读作「命名始终强制」,实际默认是宽松模式(只有 frontmatter 生效,命名只在 `strictDocs:true` 时查)。T071 已同步目标模板/契约,待实现与入口重投影验收。
- **L5** `AGENTS.md` 的 R4 说「AGENTS/CLAUDE/GEMINI/START 中 grep」,实际 R4 只查 `manifest.entryFiles` + `START.md`,**不含 AGENTS.md**(除非它恰好在 entryFiles 里);而 R1 又强制要求 AGENTS.md 存在。规则表两处口径不一致。T071 模板目标已改为 AGENTS.md 必查。
- **L6** `AGENTS.md` 的 R9 读作全局不变量,旧实现只对**最新一条** LOG 条目对账;`relay_doctor` D8 才是全局的,且 D8 **不在绿闸里**。T071 已把目标规则改为全局核对,并要求 T055–T057 具名 WARN、不得汇总 PASS。
- **L7** R12 阈值(150 行 / 20 条)在 `AGENTS.md`、`docs-design/CONTRACT.md:191`、`src/contract.mjs:435` **三处散文重复**,改一处要改三处。
- **L8** `docs/superpowers/` 的 plan/spec 已过时:曾写「接入第 10 个 MCP 工具」、Node ≥18、`resolveRelayRoots` 三字段、24 个复选框全未勾;T071 已标记完成并修正为 Node ≥22、六字段、实际清理/ignored 保护口径。两个文件名仍不匹配 R3 严格命名,文档头已注明,建议主审通过 docsIgnore 或重命名处理。
- **L9** `CHANGELOG.md` 缺 `[Unreleased]` 段(Keep a Changelog 惯例);`npm pack` 实测 55 文件/208KB,而 `[2.0.0]` 段仍写「51 文件/164KB」。T071 已新增 Unreleased;历史版本段保留当时事实,不改写。
- **L10** `src/engines/facts.mjs:22` 手工切 porcelain 行(`slice(3)`)——`rescue.mjs:545-548` 刚因同一类问题改用 `-z`(NUL 分隔、不做 C 转义),两边口径不一;文件名含引号/换行时会解析错(文件计数不受影响,路径级密钥规则受影响)。

**不再需要 / 冗余**

- **L11** `scripts/audit/`(5 个探针 + README)——**它自己的 README 写着**「修完 T062 后…探针即可退役」,而 T062 已闭环。5 个探针「只打印现象、不做断言、退出码恒为 0」,是**假保证陷阱**;~440 行被跟踪但没有 CI 跑。**2026-11-27 已删除该目录**,相关历史引用改指审计报告或标注已退役。
- **L12** `scripts/smoke-t021-decision.mjs` 现在是 **exit 0**,却不在 `npm test` 里;而 `docs/04-test/06-audit-pr8-v1.0.md:279` 仍写着它「保持红灯(exit 1)」——**审计报告与现实脱节**。
- **L13** `~/.relay-mcp/relay-mcp-autoupdate.mjs`(旧启动器)**仍在磁盘上且可运行**,内容是 T067 加固**之前**的版本:实测 `symbolic-ref` 0 处、`git-common-dir` 0 处、`postMergeCheck` 0 处、`index.lock` 0 处,且 `behind.ok ? Number(...) : 0` —— **正是 T067 修掉的 fail-open**。仓库文档只说「目录保留」,没说保留的是**未加固**的那份。
- **L14** `~/.relay-mcp/state/`(旧节流状态)、`backup-20261109/`、`cleanup-legacy.sh`、`rollback.sh` —— 旧通道的死重。
- **L15** `AGENTS.md.relay-bak-*` 2 个(11/9、11/18)——`backupFile()` 每次 sync/onboard 都生成,**从不清理**,无上限。
- **L16** `resolveProfiles`(`rescue-profiles.mjs:383`)——上轮审计时仍是真死导出,已被 `resolveAllProfiles` 取代;两个近似实现并排,下一个人容易挑错。**后续实现已删除该导出**;本报告保留审计时点记录,不再作为当前缺陷。
- **L17** 7 个局部死符号:`rescue.mjs:39,40,45,52`、`session.mjs:115,1671`、`sync.mjs:46`(`pathExists`,与 `bootstrap.mjs:35` 重复)。其中 `MAX_SCAN_CANDIDATES`「看起来像上限,其实不是」(见 M16);`DISPATCH_LOG` 的值在 worker 里被**硬编码复制**成字面量。
- **L18** 23 处近似重复的助手函数:`readText`×4、`textResult`×4、`ok`/`err`×3、`firstLine`×3、`pathExists`/`exists`×3、码点安全截断×4 且**四种不同的截断后缀**。另:TTL `240` 散在 3 个文件、`7 天` 散在 3 处、候选上限 `400` 散在 4 处 —— `doctor.mjs:14` 的 `CLAIM_TTL_MIN` 与 `session.mjs:412` 的同名常量**各自独立,改一处 doctor 就误判锁过期**。
- **L19** `facts.strict` 已标注废弃,**但 `relay_init` 仍在写**(`bootstrap.mjs:337`)、`relay_sync` 仍在提示(`sync.mjs:251`);`docsPhases` / `restructuredAt` / `manifest.preset` 写了从不读;反过来 `manifest.structure.strict` 真的在读,却**不在** `docs-design/CONTRACT.md:170` 的「完整配置面」清单里。
- **L20** `relay-mcp-autoupdate.mjs` 有 shebang 但 git 模式是 `100644`(不可执行);三个脚本磁盘权限是 `0600`(git 不跟踪读位,但很反常)。
- **L21** `scripts/smoke-harness-paths.mjs:13` 硬编码 `$HOME/Desktop/projects/relay-mcp/...` → 仓库换位置就静默失效(应从 `import.meta.url` 推导)。
- **L22** `package.json` 的 `files[]` **不含** `scripts/relay-mcp-autoupdate.mjs` → `npm pack` 产出里没有启动器。npm 已冻结(`private:true`,`[2.0.0]` 段已记「npm 分发冻结」),所以当前不致命;但一旦解冻,包是残的。**同一段 CHANGELOG 里 `[1.4.0]` 的「npm 分发面(T020)」与 `[2.0.0]` 的「npm 冻结」并存**,读者容易误读。
- **L23** `relay_verify` 的表格用 `<br>` 拼多行,CLI 纯文本渲染会**原样显示 `<br>`**。
- **L24** `relayClaim` 的 `try` 块(`session.mjs:808-976`)缩进与 `catch`/`finally` 不齐 → 容易在错误的作用域里 `return`。
- **L29** 自更新启动器的 **linked-worktree 守卫是 fail-open**(`scripts/relay-mcp-autoupdate.mjs:216`):`if (gd.ok && cd.ok && …)`——只要 `rev-parse --path-format=absolute --git-common-dir` **失败**(`--path-format` 需 git ≥ 2.31),`cd.ok` 为 false → 整个条件为假 → **守卫被跳过,更新照做**,而这正是该守卫要防的场景。**实测**:本机 git 2.54 时守卫本身工作正常(linked worktree 里 `git-dir ≠ git-common-dir` → 跳过;且 `git merge --ff-only origin/main` 在 `relay/T900` 上是 no-op,`Already up to date`),所以**当前机器上不触发**。但与启动器自己写下的原则（「『无法判定』一律按失败处理,绝不把 rev-list 失败折算成『已是最新』」)自相矛盾——修法:`gd`/`cd` 任一失败即 `finish('fail')` 跳过更新。启动器**自身没有锁**,并发启动靠 git 自己的 `index.lock` 与 `postMergeCheck` 兜底(可接受,但值得写进注释)。
- **L28** **生产代码里有两个崩溃注入钩子**,只靠环境变量开启:`util.mjs:376`(`RELAY_CRASH_AT_WRITE=N` → 第 N+1 次协议写前 `process.exit(137)`)与 `session.mjs:1709`(`RELAY_CRASH_BEFORE_COMMIT=1` → **TASKS/LOG 已写、提交未发生**时退出 137)。它们是「崩溃点矩阵」测试的基础,设计如此;但 `RELAY_CRASH_BEFORE_COMMIT=1` 一旦残留在用户 shell 的环境里,**每一次出场都会在写完协议面后自杀** —— 表现为「TASKS 已盖 `[x]`、LOG 无条目、认领锁不释放」的半死状态(正好是 H6 那条路径)。建议:钩子只在 `NODE_ENV==='test'` 或显式 `RELAY_TEST_HOOKS=1` 时生效。

**仓库当前状态(非本次审计造成)**

- **L26** **R12 WARN 常驻**:LOG 活跃区 152 行 > 150。T064 归档过,但后续会话又顶回去 → 仓库长期停在 WARN,**训练人忽略 WARN**。
- **L27** **D8 WARN 常驻**:T055/T056/T057 标了 `[x]` 但 LOG/归档无完成条目。这是 DECISIONS(T061)明文保留的诚实偏差,**不要「修」**——手写完成条目正是 R10/D8 要防的假绿。
- **L30** **测试重复**:`scripts/smoke-r12-boundary.mjs:110` 与 `scripts/smoke-structure.mjs:134` 是**逐字节相同**的断言(实测确认);`smoke-content-guard.mjs:35` 与 `smoke-facts.mjs:65` 是同一条 `/修复:/` 子串断言(3 个字符的子串检查,规则文案改语言也不会红);11 个套件各自重复断言同一条「`relay_init` 成功」的夹具守卫。这些是可删的冗余,但**删除前要先确认另一侧真的覆盖**。
- **L31** 专家曾报「`smoke-t021-decision.mjs` 硬编码 `process.exit(1)`、0 断言」——**实测不成立**:exit 1 只在 `fail()` 辅助函数里(`:14`),成功路径落到文件末尾,实测 **exit 0**。该文件有 4 条真实检查(T018 决策条目存在 / 状态行 / 结论词 / 真实 sha / 复评阈值)。**结论保留 L12(它绿灯但没接进 `npm test`),撤回「硬编码 exit 1」这条指控。**

---

## 6. 二阶 / 三阶影响(只看直接效果会漏掉的)

1. **「协议给自己打分」的闭环有洞**:R10 对账的输入(`base`/`sha`)是协议自己写的,而校验方不复算它 —— 于是**被审计者可以自己定义审计区间**。这条弱点的二阶影响不是「R10 偶尔误判」,而是**整套「文件即状态 + 机检裁判」的可信度是单点的**:它假设没人手改 LOG。而项目自己的 LOG 里就写着「手写完成条目与引擎条目不可区分」(L27)——**这个假设已经被现实证伪过一次**。要么把 `base` 锚到 registry,要么在 `relay_rules` 里如实把 R10 降级为「形状 + 分支归属检查」。
2. **三处「重复实现」的漂移都是同向的**:H4(缺符号链接防线)、H5(缺 CAS/原子写)、H7(缺 catch)——**三处都发生在「非 session_end 路径」**。因为 session_end 被四轮审计反复加固,其他引擎就没跟上。二阶后果:**审计强度在模块之间极不均衡**,而用户以为「协议整体是审过的」。`restructure`/`sync`/`rescue` 是三个审计盲区。
3. **「本机绿 ≠ 仓库绿」**已经出现三次(H3 的 `.git/info/exclude`、L13 的旧启动器、L15 的 relay-bak)。共同根因:**把机器状态写进了仓库结论**。这三处的三阶影响是:**换机/换 CI 后,第一次运行就会红或更糟**——而红的原因往往在仓库之外,排查成本极高。
4. **协议给自己的修复建议可能有害**:H3 里 R12/R2 建议「修宪」,会把一次 gitignore 遗漏写进项目宪法;压力测试 3 里验收门建议「去修测试」,会让模型去改测试来迎合一个不该存在的任务。**建议本身是协议的一部分**,它的质量决定模型会不会做错事。
5. **两个「已知债务」其实是同一个模式**:`recomputeCommitFileCount`/`lockTiming` 标了「v2.0 删」却还在;`facts.strict` 标了废弃却还在写。**协议对自己的死代码没有收口机制** —— 标注了,但没人会真的删。三阶后果:每加一个功能就多一批「待删」符号,v2.0 会变成一次不可能完成的清理。
6. **CLI 与 MCP 的差距在变大而不是收敛**:M3/M4/M5 都指向同一件事——**CLI 是二等公民**,而验收行(`npm test && ./verify`)恰恰走 CLI。协议的核心承诺「可执行验收」因此在 CLI 路径上是有损的。

---

## 7. 建议修复顺序

**先做(有独立复现证据、影响面清晰)**

1. **H2** `util.mjs:525` —— 把 deadline 检查提到 `continue` 之前,并给 `!snap` 路径加 200ms 退避;顺带区分 ENOENT(锁消失)与其它错误(直接报错)。**一行级改动,消除整 server 挂死。**
2. **H1 + H4** —— `sync.mjs` 写前 `assertNotSymlinkFile(target, name)`;`restructure.mjs` / `rescue.mjs` 补 `checkProtocolFilesSafe`。`assertNotSymlinkFile` 已存在于 `util.mjs`,**是复用不是新建**。
3. **H3** —— `.gitignore` 补 `out/`、`.v2c/`、`.zcode/` 三行(**不要**改 `allowedTopLevel`)。已实测有效。
4. **H6** —— `session.mjs:1408` 的 `try` 加 `catch`,按 `relay_claim:951` 的形状返回「## 出场异常 + 修复:」而不是裸栈。
5. **H5** —— `restructure.mjs:135,153,170` 改走 `writeProtocolFile(root, name, content, { token: rLock.token, expectedHash })`;**并改掉 `restructure.mjs:20` 那句不实的注释**。

**同批做(小、互相独立)**

6. **M1/M2** —— TASKS 的「无待办」占位不再用 `[ ]`;`relayRecall` 补一行「只有 TASKS、没有 LOG」的待办(状态列标 `待办(无日志)`)。
7. **M3** —— `cli.mjs` 按工具的 `inputSchema` 校验 `--json` 的键与类型:未知键 → exit 2 并列出可用键;schema 说 array/object 而给了标量 → 明确提示用整段 JSON。
8. **M4** —— `cli.mjs` 退出前等 stdout 排空(改 `process.exitCode` 让 Node 自然退出最省事)。
9. **M5** —— 把 `ttl_minutes` / `maintenance` / `relay_rescue.task` 补进 `inputSchema`(代价是 tools/list 字节,M6 会顶破 → 先解决 M6)。
10. **M6** —— 先把预算**改成按 token 计**并让套件**报告余量**(而不只是断言 ≤),再决定要不要调数;否则下个特性必然红 CI。

**口径修正(改文档,不改行为)**

11. **H7 / L4 / L5 / L6** —— `AGENTS.md` 与 `relay_rules` 如实描述 R3/R4/R9/R10 的实际口径(含宽松模式、entryFiles 范围、只对账最新条目、base/sha 被信任)。**这批是纯措辞,但它决定了模型会不会相信这套机检。**
12. **L1** —— 修掉 4 处「relay relay」;**L3** —— 修掉 3 处「W1 pending / W3/W4 并行开发中」的用户可见字符串;**L2** —— 删掉 `rpc.mjs` 里那段死掉的 `DEFAULT_INIT_RESULT`。

**清理(低风险、可批量)**

13. **L11/L12/L16/L17** —— 退役 `scripts/audit/`(其 README 已宣告退役条件满足);`smoke-t021-decision.mjs` 要么进 `npm test`、要么退役并改 T021 的验收行;删 `resolveProfiles` 与 7 个死符号(但 `MAX_SCAN_CANDIDATES` 应当**接上**而不是删,见 M16)。
14. **L13/L14** —— `~/.relay-mcp/relay-mcp-autoupdate.mjs` **建议删除或就地覆盖为仓库版**:留着未加固的启动器,等于给旧文档/旧配置留了一条能静默快进任务分支的通路。
15. **L20/L22** —— 启动器加执行位;`files[]` 补启动器(或在 README 明确 npm 包不含启动器)。
16. **L26** —— 跑一次 `relay_archive_log {confirm:true}` 把 R12 拉回线内,并考虑把保留位按**任务会话**计数(M13)。

**不建议做的**

- 不要**为 D8 的 T055/T057 补写完成条目**(L27)——手写条目正是 R10/D8 要防的假绿。
- 不要**把 `scripts/audit/*` 接进 `npm test`**——它们没有断言、恒退出 0,只会给 CI 一张假绿卡。
- 不要**把 `smoke-harness-paths.mjs` 接进 `npm test`**——它断言 `~/.claude.json` 等本机路径,runner 上必红。
- 不要**为了消掉 R2 越界去改 `allowedTopLevel`**(H3)——用 `.gitignore`;改白名单会影响所有克隆者。
- 不要**大改 `relaySessionEnd`**(904 行)——它是最要害的函数,历次审计都是原地加固的,重写会作废审计历史。要拆就先抽纯函数。
- 不要**删 `legacyProfileFor` 兼容垫片**——2026-11-25 之前生成的接力单还要靠它读。

---

## 8. 复现命令(全部在 /tmp 副本内,不动真实仓库)

```bash
# H3:R2 依赖未入库的 .git/info/exclude
git clone <repo> /tmp/r2 && cd /tmp/r2 && mkdir -p .zcode out && echo x > .zcode/a.md
node <repo>/src/cli.mjs relay_verify --root /tmp/r2 --json full=true | grep '^\| R2'
printf '\n.v2c/\n.zcode/\nout/\n' >> .gitignore   # 修复后 R2 PASS

# H1:relay_sync 经悬空符号链接写到仓库外
mv AGENTS.md /tmp/AGENTS.orig && ln -s /tmp/EVIL.md AGENTS.md
node <repo>/src/cli.mjs relay_sync --root <copy>   # → /tmp/EVIL.md 被创建

# H2:锁文件不可读 → acquireFileLock 无限忙等
chmod 000 .relay/relay.lock
timeout 15 node <repo>/src/cli.mjs relay_claim --root <copy> --json task=T001 model=p   # exit 124

# H7:R10 自指 → base=sha 即空区间
#   把事实行改成 base=sha=<同一 sha>、文件 0 → relay_verify 报 R10 PASS

# 压力测试 4:CLI 数组参数不可达
node <repo>/src/cli.mjs relay_get --root . --json ids=T067,T068   # → 「缺少 ids」

# 压力测试 5:管道截断
node -e "process.stdout.write('Y'.repeat(300000));process.exit(0)" | wc -c   # → 131072
```

---

## 9. 自更新启动器与 harness 集成面(独立代理复核 + 主审抽查)

| 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|
| **HIGH** | linked-worktree 守卫 **fail-open**:`if (gd.ok && cd.ok && …)` —— `rev-parse --path-format=absolute --git-common-dir` 一旦失败(`--path-format` 需 git ≥ 2.31),`cd.ok` 为 false → 整个条件为假 → **守卫被跳过,更新照做**,而这正是该守卫要防的场景。**主审实测**:本机 git 2.54 上守卫本身工作正常(linked worktree 里 `git-dir ≠ git-common-dir` → 跳过;`git merge --ff-only origin/main` 在 `relay/T900` 上是 no-op),故**当前机器不触发**。**独立代理已复现后果**:守卫被绕过时 ff 在 linked worktree 里执行,**移动了共享的 `main`**,并让另一个 worktree 的 index 变成陈旧(残留 `D README2.md` staged) | `scripts/relay-mcp-autoupdate.mjs:214-220` | 代码可判定;后果由代理复现 |
| **HIGH** | `postMergeCheck` 只查 `.git/index.lock` 与 `HEAD ∈ {before, origin/main}`。**代理已用 `/tmp` 夹具完整复现**:预置 `refs/heads/main.lock` → merge 已改写 index/工作树但 ref 更新失败 → `postMergeCheck` **判 safe**,wrapper exit 0 并启动新入口;stdout 返回 `version:"MIXED-TREE"`,HEAD 仍旧,`status` 为 `M src/index.mjs`。即**从一棵 ≠ HEAD 的混合树启动 MCP,并永久留下脏仓库** | `scripts/relay-mcp-autoupdate.mjs:181-191` | 代理实测;主审核对代码路径。合并失败后除 HEAD/锁探针外,还必须验 `git status --porcelain --untracked-files=no` 为空(或与合并前快照一致);异常时拒绝启动 |
| **HIGH** | **并发 launcher 无更新锁**:两个 harness 同时启动,经 fetch barrier 同时进入 merge → 一方成功,另一方报 `.git/index.lock` 残留并 **exit 2**;最终 HEAD/index/磁盘一致,但启动是确定性失败 | `scripts/relay-mcp-autoupdate.mjs:257-276` | 代理实测。增加仓库级更新互斥(如 `.git/relay-autoupdate.lock`,O_EXCL + 有界等待);拿不到锁时**跳过更新、仍启动当前版本**,不要让 harness 启动失败 |
| **HIGH** | 启动器**不在 `package.json` 的 `files[]`** → `npm pack` 产出里没有它(主审实测:`autoupdate shipped? false`);README 教用户注册的是 `src/index.mjs` 而非启动器 → **新用户拿不到自更新通道**;README 还引用了同样未打包的 `scripts/smoke-plugin.mjs` | `package.json:5-14`、`README.md:35-47` | **主审实测** |
| **MEDIUM** | `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 会覆盖 `-C REPO`,使 git 操作指向另一仓。**代理仅完整复现了前两者导致 fetch 失败;三者在 merge 写路径上的完整复现未完成** | `scripts/relay-mcp-autoupdate.mjs:134` | 子进程环境显式删除这些变量(及 `GIT_OBJECT_DIRECTORY` / `GIT_COMMON_DIR`),固定 `-C` 目标 |
| **MEDIUM** | `deadline` 在检查中途才被设置(`:230`),之前的 git 调用用 `remainingMs()`=20000 → **实际预算约 2×8s**;且 `remainingMs()===0` 时传给 `git()` 的 `timeoutMs` 为 0,而 `git()` 的语义是「0 = 不限时」→ **预算耗尽反而变成不限时**。实测启动耗时 46s,而注释写 8s | `scripts/relay-mcp-autoupdate.mjs:54,138,230` | 代理实测。进 checkAndUpdate 立即设 deadline;耗尽时传一个最小正超时或直接跳过,不能传 0 |
| **MEDIUM** | `scripts/smoke-autoupdate.mjs:57` 的夹具提交**没有 `-c commit.gpgsign=false`** → 任何全局 `commit.gpgsign=true` 的开发者跑 `npm test` 会 FATAL | `scripts/smoke-autoupdate.mjs:57` | 代理复现。夹具 commit 统一加 `-c commit.gpgsign=false`(所有 fixture git commit 点) |
| **LOW** | 合并成功后**不校验 `HEAD == origin/main`**:`after.ok === false` 时仍 `finish('ok')` → 写 6 小时成功静默 | `scripts/relay-mcp-autoupdate.mjs:273-276` | `after.ok===false` 必须 `finish('fail')`,不能写 ok |
| **LOW** | 锁探测路径 `REPO/.git/index.lock` 对 linked worktree 是错的(真实路径 `.git/worktrees/<n>/index.lock`)→ 该探测在那里是 no-op。**代理本轮未独立触发中间态**,只确认路径错 | `scripts/relay-mcp-autoupdate.mjs:182` | 用 `git rev-parse --git-path index.lock` 取真实路径,不要手拼 |
| **LOW** | 冒烟**完全没覆盖**:linked worktree、守卫 fail-open、并发合并、shallow clone、缺 origin/main、submodule、部分脏合并 | `scripts/smoke-autoupdate.mjs` | 至少补前三项的行为断言(不是源码 grep) |
| **TRIVIAL** | `TASKS.md:37` 引用了**不存在的** `docs/04-test/13-audit-autoupdate-v1.0.md`(T067 的审计产物从未提交)——**与本报告的文件名撞号**,需改一个 | `TASKS.md:37` | 主审发现 |

### 续跑新增/修正(文档专家 + 死代码专家,主审逐条核对)

| 级别 | 新发现 / 修正 | 位置 | 证据与修法 |
|---|---|---|---|
| **HIGH** | **认领锁过期判定有两个真相源,可导致未过期锁被接管**:`readLockSnapshot` 用**文件 mtime**算 `ageMs`(`util.mjs:475-477`),doctor 用锁内 `acquiredAt` 并先 `Math.round` 到分钟(`doctor.mjs:208-213`)。**主审双向实测**:(A) `acquiredAt` 旧、mtime 新 → doctor 与 claim 不一致;(B) `acquiredAt` 刚写、mtime 人为设旧 240m29s → **doctor 报「1 把锁均在 TTL 内」,claim 却成功「接管自 ghost」**。文件复制/恢复/工具改写会自然改变 mtime,不需要攻击者手工 `touch` | `util.mjs:475-477`、`doctor.mjs:208-213` | 以锁内 `acquiredAt` 为唯一真相源,精确毫秒比较;doctor/claim 共享同一 `claimLockExpired(info)` 助手。`smoke-doctor.mjs:109-114` 只测 2020 年时间,需补 mtime/acquiredAt 背离边界 |
| **MEDIUM** | **CONTRACT 规则表管道符未转义**:R3/R4/R5 行分别有 8/7/7 个 `\|`,而四列表应为 5 → **Markdown 渲染列数错乱**;同文件 R11 行也有同类问题 | `docs-design/CONTRACT.md` 规则表 | T071 已修复为 `\\|` 并机检实际列数 |
| **MEDIUM** | **R11 扫描面文档收窄**:CONTRACT 只写 `docs/archive/LOG-*.md`,实现实际扫 `docs/archive/` 下**全部 `.md`** | `docs-design/CONTRACT.md`、`verify.mjs:571-577` | 文档改为 `docs/archive/*.md` 更精确;若要承诺递归才需同时改实现 |
| **MEDIUM** | **SECURITY 的信任声明不完整**:写「只执行两类入口…自由文本从不执行」,但 `test:<命令>` 逐字符命中 `acceptance.commands` 后会经 shell 执行 | `SECURITY.md:20`、`session.mjs:330-344` | 补第三类:「或逐字符命中白名单的 `test:<命令>`(经 shell,白名单即授权边界)」 |
| **MEDIUM** | **README 注册表恢复建议对损坏无效**:「缺失或损坏…重新 claim 重建」;损坏时 `relay_claim` 明确拒绝,不会重建 | `README.md:113`、`session.mjs:783-790` | 改为「缺失:controlRoot 重新 claim;损坏:先备份并人工修复/删除注册表,再 claim」 |
| **LOW** | `docs/superpowers/` 设计文档与实现漂移:清理要求、ignored 保护、Node 下界与 `resolveRelayRoots` 签名等 | `docs/superpowers/specs/...design.md`、`docs/superpowers/plans/...md` | T071 已标记完成,修正 Node ≥22、六字段、TASKS 活跃集与 ignored 保护;strictDocs 兼容交主审处理 |
| **LOW** | `docs-design/CONTRACT.md` 曾写旧锁语义「持锁超 2 分钟视为崩溃残留可接管」;现行是约 20s 心跳 + 写前 fencing | `docs-design/CONTRACT.md` 安全段 | T071 已改为现行语义 |
| **LOW** | `TASKS.md:52` 的 `verify.mjs:355` 被 Markdown 当成相对链接;`LOG.md:36` 错字「切抰」;`TASKS.md:224` 遗留 `(空)` 占位行 | 对应行 | 分别加反引号 / 改「切换」/ 删除占位行 |
| **LOW** | `docs/04-test/12-audit-t062-v1.0.md:12` 含 **3 个 U+FFFD 替换字符**(「修复属实」被损坏) | 对应行 | T071 已修复为「修复属实」 |
| **LOW** | `templates/START.md` 宣称 claim 可传 `ttl_minutes`、出场可传 `maintenance`,两者均未进 MCP schema | `templates/START.md`、`contract.mjs` | 目标是把两字段补进 MCP inputSchema;T071 模板已按该目标写明,最终以 schema 与 smoke 验收为准 |
| **TRIVIAL** | **代理更正**:上轮死代码专家称「`resolveProfiles` 已删除」——**审计时点不成立**,它当时仍在 `rescue-profiles.mjs:383` | `src/engines/rescue-profiles.mjs` | 主审 grep + `git status` 确认当时仓库无代码改动;保留 L16 的时点记录。后续实现已删除 |
| **TRIVIAL** | **代理更正**:导出总数 128、零外部引用 19(不是上轮的 20);当时 `resolveProfiles` 仍是死导出,其余 19 个均在本文件内使用 | `src/**` | 统计口径变化,不新增缺陷。后续实现已删除 `resolveProfiles`,当前状态以源码扫描为准 |
| **TRIVIAL** | **代理修正**:跨套件重复的「init 成功」是各自夹具前置条件,**不可删**;真正可去重的是 `smoke-r12-boundary.mjs:105-112` 与 `smoke-structure.mjs:130-137` 的整段扫描+断言 | 对应文件 | 与 L30 一致;只删重复侧,保留夹具守卫 |

### 测试质量续跑(主审逐行核对)

| 级别 | 问题 | 位置 | 修法 |
|---|---|---|---|
| **HIGH** | 描述符导出断言只 grep 源码文本,不验证实现可调用 | `scripts/smoke-rescue.mjs:646-648` | 已列入 H10:运行时 import + 调用 |
| **HIGH** | 「覆盖 D1–D9」只断言首尾两个 ID 出现 | `scripts/smoke-doctor.mjs:51` | 已列入 H10:D1..D9 逐项断言 |
| **MEDIUM** | 元测试假绿检测只匹配顶格 `} catch (` / `} finally {`,缩进或换行写法会漏检 | `scripts/smoke-meta.mjs:76-82` | 用 AST 或更宽容的词法规则;至少加一个「坏套件」负控夹具 |
| **MEDIUM** | 固定全局哨兵 `/tmp/relay-launch-should-not-exist`,并行测试/遗留文件会制造假 RED,且套件不清理已有哨兵 | `scripts/smoke-rescue-autolaunch.mjs:116,139` | 哨兵放进本次 `mkdtemp` 目录,断言后清理 |
| **LOW** | worktree 套件固定 sleep 320ms + 260ms(另有 20/100ms) | `scripts/smoke-worktrees.mjs:704,727` | 改为有界状态轮询,总等待预算封顶 |
| **TRIVIAL** | `docs/04-test/05-judge-hardening-v1.5.0.md:15-16` 五列表格实际被 `\|\|` 拆成 7 列 | 对应行 | T071 已转义为 `\\|\\|` 并检查五列 |
| **TRIVIAL** | `docs-design/CONTRACT.md` 「第 10 个工具 relay_worktree_cleanup」已过时;当前注册 15 个 | `docs-design/CONTRACT.md` 生命周期段 | T071 已删除「第 10 个」 |

### 逐套计时(续跑,27/27 exit 0)

> 测量环境仍有一定后台负载(6 个审计代理),因此是**保守上界**,不是空闲环境的精确耗时。逐套串行总计 **143.53s**;验收门上限 **180s**,余量约 **36s**。

| 套件 | 秒 | | 套件 | 秒 |
|---|---:|---|---|---:|
| smoke.mjs | 31.02 | | smoke-patches.mjs | **33.19** |
| smoke-worktrees.mjs | **32.23** | | smoke-compat.mjs | 2.50 |
| smoke-content-guard.mjs | 0.87 | | smoke-facts.mjs | 4.89 |
| smoke-brief.mjs | 1.55 | | smoke-doctor.mjs | 1.27 |
| smoke-recall.mjs | 0.62 | | smoke-review-regressions.mjs | 3.09 |
| smoke-perf.mjs | 1.05 | | smoke-r12-boundary.mjs | 0.51 |
| smoke-session-perf.mjs | 0.34 | | smoke-concurrency.mjs | 1.21 |
| smoke-archive-log.mjs | 1.06 | | smoke-security.mjs | 4.60 |
| smoke-plugin.mjs | 0.16 | | smoke-crash-matrix.mjs | 2.40 |
| smoke-budget.mjs | 0.04 | | smoke-meta.mjs | 0.09 |
| smoke-structure.mjs | 1.46 | | smoke-sync-backup.mjs | 0.98 |
| smoke-doctor-archive.mjs | 1.42 | | smoke-rescue.mjs | 7.14 |
| smoke-rescue-zcode-db.mjs | 1.58 | | smoke-rescue-autolaunch.mjs | 6.80 |
| smoke-autoupdate.mjs | 1.45 | | **总计** | **143.53** |

**二阶影响**:前三套合计 **96.4s(67%)**,都是真实 `relay_init/session_end/worktree` 生命周期,不是纯 sleep。把它们并行需要处理共享用户 HOME、git 全局配置与端口/进程冲突,不能直接上 `Promise.all`。可做的低成本优化是让每套输出流式写(当前计时器用 `execFileSync` 捕获全部输出,额外有缓冲成本),但收益不足以抵掉复杂度。**M19 结论修正**:不是「结构上必超 180s」,而是**余量只有 20%,属于脆弱门限**;建议把超时做成 manifest 可配,而不是简单调大常量。

---

## 10. 撤回 / 更正

诚实记录本次审计中**被推翻或降级**的主张,避免它们以「审计结论」的形态沉淀下来:

1. **「CHANGELOG 漏记 npm 冻结」——不成立。** CHANGELOG `[2.0.0]` 段已明写「npm 分发冻结:`package.json` 置 `private: true`,移除 `bin`/安装器…」,DECISIONS 也有对应条目。`[1.4.0]` 段的 T020 描述是**该版本当时的状态**,属正常 changelog 语义。真正剩下的只是 L22(启动器不在 `files[]`)。
2. **「`smoke-t021-decision.mjs` 硬编码 `process.exit(1)`、0 断言」——不成立。** exit 1 只在 `fail()` 辅助函数里(`:14`),成功路径落到文件末尾,主审实测 **exit 0**;文件有 4 条真实检查。撤回该指控,保留 L12(绿灯但未接进 `npm test`)。
3. **「`relay_sync` 缺模板时报『无漂移』——首次复现失败。** 因为 `templatesDir()` 解析的是**引擎模块所在目录**(`util.mjs:36-37`)而非目标仓的 `templates/`,删目标仓的模板不触发该路径。改为按代码路径重述(M7),并降为 LOW(仅损坏安装可达)。
4. **「R10 的可伪造性」——是**已知且已接受**的债务,不是本次新发现。** DECISIONS(T061)已把「手写完成条目与引擎条目不可区分」记为诚实取舍。本次的**新增**只有两点:(a) `base=sha` 使文件计数**完全空洞**(主审实测:声称「0 文件」的行被判 PASS,而真实提交改了 3 个文件);(b) `facts.since` 可让一条回填日期的行**整条跳过 R10**。因此**真正需要改的是文档口径**(AGENTS.md / relay_rules 声称 base/sha「与 git 重算逐字段一致」——这句不成立),而不是推翻该取舍。
5. **「D8 对 T055/T056/T057 的 WARN」——是有意保留的诚实偏差,不可「修」。** 手写完成条目正是 R10/D8 要防的假绿。
6. **「CHANGELOG `26 套 / 1104 断言` 是漂移」——不成立。** 该行位于 **`[2.1.0]` 段内**(`CHANGELOG.md:14` 起,行 63 在其中),而 **`v2.1.0` tag 的 package.json 实测就是 26 套**(`git show v2.1.0:package.json` → 26;`v2.1.1` → 27)。**历史版本段记录它当时的真实状态,不是漂移。**
7. **「README 的套件清单与实际不符」——不成立。** README 写「27 套」并列出 **27 个名字**,与 `package.json` 的 **27 套**逐条 1:1 对应(协议=smoke、补丁=patches、……、通用 SQLite 会话来源=rescue-zcode-db、manifest 声明的自动拉起=rescue-autolaunch、自更新启动器=autoupdate),**没有多列也没有漏列**。唯一不在 `npm test` 里的 `smoke-harness-paths.mjs` 属**故意排除**(本机验收),且已在脚本头与 TASKS 里写明。
8. **「`docs-design/CONTRACT.md:170` 的『完整配置面』漏了键」——成立。** 该清单列 13 个键,**漏了 `structure`(R13 的严格度开关,`src/config.mjs` 白名单里有、真的被读)**;同时还漏了 `strictDocs`(R3 的命名开关,`verify.mjs:198` 真的在读)。**清单里却列了 3 个从不读的键**(`docsPhases`/`restructuredAt`/`preset`)—— 详见 L19。

---

## 11. 续跑:协议修复的最小设计(专家设计,待实施时再验)

> 以下不是新缺陷,是首轮缺陷的**修复方案**。避免实现时重新掉进同一个坑。

### R10:不引入秘密密钥的独立锚定

- **managed**:从 registry 取该任务的 `baseSha`,**忽略事实行自报的 base**;按 commit subject 精确匹配 `T### 完成` 定位完成提交;验 branch 包含该 SHA;重算 `baseSha..SHA` 的文件数与 ±。
- **single**:无 registry,按完成提交 subject 定位,以其父代为范围,明确标为**较弱证据**。
- registry 缺失、清理后记录被回收、重复/无法定位提交 → **WARN,永不 PASS**。合并删分支仍走现有祖先校验。
- **边界**:旧 single 记录兼容、多任务共用一个提交、registry 与 LOG 同时被改仍可能欺骗。独立锚点提高的是**篡改成本**,不是密码学防伪。

### R9:全局化,但不为历史缺口放假绿

- 检查 TASKS 所有 `[x]` 对照 live LOG + 归档,**新增缺口 ERROR**。
- 对既有 T055–T057,按 DECISIONS 的现行决定做**具名、带批准锚点的豁免**;输出固定为 `WARN:3 个已批准历史缺口`,**不能汇总为「通过」**。
  - 批准锚点已核对:`DECISIONS.md:27–35`,标题「2026-11-26 — 多任务出场用 `done_tasks[]` 落逐任务证据;历史 T055–T057 缺口保持可见(T061)」;第 31 行明确不回填、保留 D8 WARN,第 35 行要求消除 WARN 须由人批准后按 T046 先例补记。
  - **若把「保留 WARN」改成「工具自动豁免」,需要新的、由项目人类负责人明确批准的决策**;模型或工具不能把既有决定解释成自动豁免授权。
- 豁免只认任务号白名单,不扫摘要正文,不生成伪造完成条目。D8 与 R9 共用同一口径。

### recall:合并归档

- 读取 live LOG + **唯一合法指针**指向的归档;按时间倒序合并,同时间以文件顺序稳定决胜;先过滤、再按任务 ID 去重,保留最新匹配项。
- 单次调用构建模型,不建持久缓存(避免第二真相源);`get` 在 live 未命中时回查归档。

### R7:归档保留算法

- 维护条目不占配额:从最新往旧扫描,累计 **3 个 `task≠维护/无`** 的条目即停;边界不得越过首个完成条目。
- 默认 `keep` 仅作总条目上限,**不能替代**任务会话配额。这样 `[完成, 无, 无, …]` 也能保留最近 3 个任务会话。

### 需要专门处理的状态机缺口

1. **TASKS `[x]`、LOG 缺失、认领锁过期**:`completionOwnershipError` 只允许原 model 修,TTL 后无工具可接管。
2. **控制提交成功、registry 更新失败**:仅告警,需人工修注册表。
3. **认领锁已创建、worktree/TASKS 回滚失败**:可能留下 active registry 或无 `[~]` 的 worktree,只能 cleanup/人工。
4. **护栏降级后锁已释放,但 `[x]` 已写而代码未提交**:TASKS 看起来已完成,却缺「待提交」中间态。

## 12. T073 复核（以 PR #12 的 `4203d78` 为基线）

GitHub 上基线提交的 Node 22、24、26 共六个 job 通过，PR 仍待合并。

| 审计项 | 复核结果 |
|---|---|
| H7、L6 | R10 按同一完成条目的唯一配对 SHA 对账，注册表提供基点，追加提交不改变旧证据。早于 `facts.since` 的条目不会遮盖范围内的完成记录。R9 与 D8 共用普通 LOG 归档的完成证据，T055–T057 的 WARN 以 DECISIONS T061 为依据。 |
| H6、H8–H9、M8、M15、M19、L28 | 修复认领恢复、Git 提交失败的返回值、锁 TTL、不可读配置的早退、manifest 读取次数、验收计时与输出上限。批量出场共享一次项目测试。崩溃注入须显式开启测试开关。 |
| H1–H5、H10、M1–M4、M7、M9、M20 | T071 已落地写盘防线、路径与测试行为的主要修复。本次清理控制面的空队列占位，纳入验收时实际漏跑的 `smoke-lock-boundary` 和 `smoke-session-recovery`，并修正后者的受管恢复夹具。 |
| M5–M6、M18 | 补齐 CLI 边界的 schema 校验，MCP 的抢救任务字段说明与 capture 对齐。测试输出近似 token 用量与余量。缺失 LOG 报错，有效检索为空仍正常返回。 |
| M10–M14、L10 | R11 检查豁免与写入指引对齐。同日归档追加保留历史，维护条目的统计复用 R7。提交与快照守卫使用 Git 原始文件名。单次 Git 调用列出未合并任务分支已在 T071 落地。 |
| M16–M17 | 全局扫描上限只计算项目内候选。capture 按 ID 额外定位候选，相同请求并发时复用一张接力单。 |
| §9 启动器 | T071 已覆盖受管根守卫、合并后检查、仓库互斥、Git 环境与总时限。T073 修复失败冷却时间和并发状态覆盖，并补充预算边界验证。 |
| L8、L12、L19、L23、L30 | worktree 计划与设计按 R3 命名。T021 决策脚本已进 CI。sync 不再建议废弃的 facts.strict。CLI 表格移除 HTML 换行。结构与区间套件保留一份重复的代码扫描断言。 |

本次复核保留 T055–T057 的历史 WARN。启动器旧文件、旧状态和备份属于本机资料，清理由其持有人决定。R12 在复核时处于阈值内。

