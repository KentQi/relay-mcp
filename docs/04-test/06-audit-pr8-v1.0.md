---
title: PR #8 多专家原子级并行审计报告 — 裁判加固 v1.5.0(T022–T025)
version: 1.0
created: 2026-11-02
status: 现行
---

# PR #8 多专家原子级并行审计报告

> 审计对象:GitHub PR #8 `feat/v1.5.0-judge-hardening`(T022 性能收敛 / T023 事实行 v2 + R10 去 fail-open / T024 R12 LOG 边界 / T025 provenance)
> 本报告是**审计产物**,不是协议文件;不改 TASKS/LOG/SPEC,不参与 R 系列的机检结论。

---

## 1. 审计元数据

| 项 | 值 |
|---|---|
| 仓库 | `/Users/kent/Desktop/projects/relay-mcp` |
| PR | #8,base = `origin/main`(`e45cc9d`),head = `origin/feat/v1.5.0-judge-hardening`(`53607ee`) |
| 规模 | 23 文件,+782 / −157(diff 1540 行) |
| 审计日期 | 2026-11-02 |
| 运行环境 | Node v26.12.1,macOS;工作树 == PR head 且干净 |
| 审计强度 | 2 个独立角度 + 主审亲验;每条 P0/P1 均由本机复现脚本证实 |

**方法**:两个独立审计角度(①事实行 v2 与 R10 语义 ②R12 边界与 perf 计数不变量)并行跑;主审另写 12 套复现脚本逐条亲验,不复用角度结论。全部复现在临时仓库内构造、用后清理,未改动被审计代码。

---

## 2. 结论摘要

**判定:建议先修 2 条 HIGH 再合并。** PR #8 的方向是对的——把「机检只裁判结构与数字」从口号落成实现,拆段设计尤其正确。但**四条硬红线里又有一条被违反**,且是本 PR 自己在 CONTRACT.md 里写的:

> `docs-design/CONTRACT.md:310` —「R10 不再有 fail-open:无法定位提交(伪造 sha、提交被重写、历史被裁剪)→ **WARN,绝不 PASS**」

实测:**v1 事实行仍能让 R10 报 PASS**,且能把文件数对到任意提交上。这条不是「没实现」,是**实现了但只对新格式生效**。

| 等级 | 条数 | 摘要 |
|---|---|---|
| HIGH | 2 | ①`__COMMIT__` 哨兵文件名可伪造提交头,让 R5(提交原子性)静默失效(本 PR 引入的回归) ②v1 事实行可自选 base..sha range,R10 报 PASS |
| MEDIUM | 5 | branch 从不与 git 比对;single 模式 ± 从不对账;「三处一致」断言只查行存在不查内容一致;「全 async」只对 relay_verify 成立;R12 可被一行归档指针消音(且两轴口径不一致) |
| LOW | 5 | `\|` 在分支名导致假 ERROR;`split('||')` 截断;recall 不再剥离 v1 前缀;managed 路径 git 进程 6 非 2–4;R12 建议「拆小任务粒度」与阈值方向相反 |

---

## 3. 你点的四条重点:逐条核实结果

| 重点 | 结论 | 依据 |
|---|---|---|
| ①R10 是否还有 fail-open | **是,还有一条** | 旧格式 `事实(v1)` 走独立分支,可自选 range 并 PASS(见 P0-2) |
| ②叙述段篡改是否真的不误红 | **成立** | 叙述段改 `验收/verify/耗时` → R10 PASS;机检段 6 项篡改 → 4 ERROR + 2 WARN(见 §4 表) |
| ③R12 阈值与活跃区定义 | 阈值硬编码正确;**活跃区定义有洞** | 阈值 150/20 不可配置(刻意防消音)是对的,但归档指针可把活跃区归零;且两轴口径不一致(见 P1-5) |
| ④T022 单快照计数不变量 | **在 relay_verify 上成立,会话生命周期未收敛** | relay_verify:LOG/TASKS/manifest 各 1 次、git=2、sync=0 ✓;session_start:manifest 读 6 次、sync=1、git=7;session_end:sync=1、git=11 |

### 叙述段 vs 机检段:篡改矩阵(实测)

| 篡改项 | R10 判定 | 期望 |
|---|---|---|
| 叙述段:验收/verify 计数/耗时全改 | `PASS` | ✅ 不误红 |
| 机检段:文件数 2→9 | `ERROR` 文件数 声明 9 / 实测 2 | ✅ |
| 机检段:mode managed→single | `ERROR` 自相矛盾(带 base+ sha) | ✅ |
| 机检段:branch→非 `relay/` | `ERROR` 自相矛盾 | ✅ |
| 机检段:± 改(+999/-999) | `ERROR` ± 声明/实测不符 | ✅ |
| 机检段:base 改成假 sha | `WARN` 无法定位提交 | ⚠️ WARN 不阻断绿闸 |
| 机检段:sha 改成假 sha | `WARN` 无法定位提交 | ⚠️ 同上 |
| 机检段:**base+sha 一起改成别的真实提交** | `PASS` 事实对账一致 | ❌ **绕过** |
| 机检段:branch=zzz/zzz / relay/T999(不存在) | `PASS` | ❌ 未与 git 比对 |
| 机检段:single 模式 ± +999/-999 | `PASS` | ❌ 未对账 |

---

## 4. 发现清单

### P0-1 · `__COMMIT__` 哨兵文件名可伪造提交头,让 R5(提交原子性)静默失效 【HIGH·已复现·本 PR 引入的回归】

**位置**:`src/engines/verify.mjs:57`(标记)与 `:62`(判定)。

```js
const log = await gitRun(root, …, 'log', '-20', '--name-only', '--pretty=format:__COMMIT__%H%x09%s');
…
if (line.startsWith('__COMMIT__')) { cur = { sha, subject, files: [] }; ctx.commits.push(cur); }
else if (cur && line.trim()) { cur.files.push(line.trim()); }
```

`git log --name-only` 会把**文件名**和提交头混在同一行流里。base 版用的是 `--pretty=format:`(空格式),没有哨兵,所以文件名永远只是文件名;本 PR 引入 `__COMMIT__` 哨兵后,**一个根级文件名 `__COMMIT__*` 会被当成提交头**。

**实测复现**:

```
基线(提交只含 src/feature.js): | R5 | WARN | 最近一次提交触碰 src/feature.js 等代码…原子性缺口
攻击(同提交含 __COMMIT__notes.md): | R5 | PASS | 最近一次提交原子性合规
```

因为 `__COMMIT__notes.md` 被解析成新提交头,`src/feature.js` 被归到这个假提交下,`commits[0].files` 变空 → `code.length === 0` → R5 直接 PASS。

**为什么这条要紧**:R5 是「代码与任务状态必须同 commit 演进」的原子性护栏。一个想改 `src/` 却不更新 TASKS.md/LOG.md 的 agent,只要把某个文件命名为 `__COMMIT__` 开头,就能让这条规则对自己完全失效——**而且没有任何告警**。这是本 PR 为了省一次 git 子进程而引入的攻击面,base 版没有。

**修复方向**:用 NUL 分隔(`git log -z --name-only`)或用不可能与文件名冲突的标记;最稳的是不用文本哨兵,改成 `git log --format='%H%x09%s' --name-only` 后按「提交头行的 sha 长度=40」判定,或干脆分两次调用(`git log -1 --format=…` 取头 + `git diff-tree` 取文件)。

---

### P0-2 · v1 事实行可自选 base..sha range,R10 报 PASS 【HIGH·已复现】

**位置**:`src/engines/verify.mjs:451-458`(v1 分支);`src/engines/facts.mjs:160-166`(v1 解析 `base=` 与 `@sha`)。

v2 的结构自洽检查与逐字段对账都包在 `if (parsed.version === 2)` 里;v1 分支只比 `stats.files`,而 `stats` 的 range 来自**行自己提供的** `base`/`sha`:

```js
// facts.mjs(校验侧)
range = parsed.base && /^[0-9a-f]{7,40}$/.test(parsed.base)
  ? [`${parsed.base}..${parsed.sha}`]
  : [`${parsed.sha}^`, parsed.sha];
```

**实测复现**(managed 场景,本次会话真实改了 5 个文件):

```
真实事实行: - 事实(v2): mode=managed | 文件 5 | ± +5/-0 | base=7ab0d9c0… | sha=68c138bc… | branch=relay/T001 || …
攻击行(伪造 v1,指向无关提交):
  - 事实(v1): 改动 1 文件(+1/-0) | 验收: 通过 | verify: PASS 99·WARN 0·ERROR 0 | 分支: fake/branch @416194f5… base=7ab0d9c0… | 耗时: 1s
R10: | R10 | PASS | 事实对账一致(v1 旧格式,1 文件,fake/branch) |
verify status=0 (0=通过,不阻断绿闸)
```

会话改了 5 个文件、分支名是 `fake/branch`,R10 却报「对账一致」并放行绿闸。这正是 10.1「防手写伪造完成条目」要挡的事。

补充:即便数字对不上,v1 分支也只报 **WARN**(strict=false 默认),同样不阻断。

**为什么没被现有冒烟抓到**:`scripts/smoke-facts.mjs` 的每个用例都用 v2 行,v1 路径零覆盖;而仓库现存 LOG.md 里就有 3 条以上 v1 行(升级兼容路径是活的)。

**修复方向**:v1 分支不能接受行自带的 range——v1 行没有 base 字段时应一律用 `sha^..sha` 并要求 sha 是该完成条目的提交;或者更简单:v1 行只做「存在性 + 结构」校验,数字对账一律 WARN(不 PASS),把数字权威完全交给 v2。

---

### P1-3 · branch 从不与 git 比对,只做形状检查 【MEDIUM·已复现】

**位置**:`src/engines/verify.mjs:416`(managed 只要求 `/^relay\//`)与 `:420`(single 只要求非空)。

实测:`branch=zzz/zzz` → `PASS`;`branch=relay/T999`(该分支不存在)→ `PASS`。

但 `docs-design/CONTRACT.md:185` 把 branch 列入机检段,`:218` 写的是「检查时点**全部可从 git 重算**」。而 branch 是可以重算的(`git rev-parse --abbrev-ref HEAD`),只是没做。

**后果**:账本里的分支名可以任意伪造而不被发现,读者据此判断「这次改动在哪个分支上」会得到假信息。

---

### P1-4 · single 模式 ± 从不对账 【MEDIUM·已复现】

**位置**:`src/engines/verify.mjs:442` — `if (parsed.mode === 'managed' && (stats.insertions !== parsed.insertions || …))`。

实测:single 模式 `± +999/-999` → `PASS`。

注意这**不是**「不假装知道」的合理设计:写入侧在 single 模式明确用 `git status` 数文件数、用 `--numstat` 取 ±,这些值是真实可得的;契约把 ± 列在机检段,规则表 `:228` 又写「managed 另对 ±」——两处口径相反,实现选了不查。**要么改成查,要么把契约改准**。

---

### P1-5 · 「三处一致」断言只查「行存在」不查「内容一致」,三处 R12 表述已实际分歧 【MEDIUM·已复现】

**位置**:`scripts/smoke-r12-boundary.mjs:73-77`。

```js
ok(/^\| R12 \|/m.test(contract), 'CONTRACT 规则表含 | R12 | 行');
ok(/^\| R12 \|/m.test(out(rules)),   'relay_rules 输出含 R12 行');
ok(/^\| R12 \|/m.test(tpl),           'AGENTS 模板规则表含 R12 | 行');
```

三个断言只验「有一行 R12」,不验三处**内容相同**。实测三处已经不一致:

| 位置 | R12 表述 |
|---|---|
| `templates/AGENTS.md.tpl:44` | `LOG 活跃区 >150 行或完成条目 >20 → WARN(strict 升 ERROR)` —— **缺「归档指针之前的行」范围,缺 `manifest.logBoundary.strict` 键名** |
| `docs-design/CONTRACT.md:187` | `活跃区(归档指针之前的行)>150 行 或 完成条目 >20 → warn(manifest.logBoundary.strict=true 升 error)` |
| `src/contract.mjs:464` | 同 CONTRACT |

顺带:README 英文半边仍是 **R1–R11**(`README.md:180`),`src/engines/verify.mjs:1` 与 `src/engines/doctor.mjs:5` 同样写着 R1–R11;而 `scripts/smoke-r12-boundary.mjs:79` 只断言 `/R12/.test(readme)`(第 8 行的中文版有 R12 就通过),所以英文版残留永远抓不到。这正是 PR #6 的 P2-17(六处残留 R1–R9)以更小的形态复发。

**修复方向**:断言从「有 R12 行」升级为「三处的阈值数字、范围定义、开关键名一致」;README 英文半边的规则区间纳入断言。

---

### P1-6 · 「async 路径零同步 spawn」只对 relay_verify 成立,会话生命周期未收敛 【MEDIUM·已量化】

**位置**:`src/engines/session.mjs:572 / 801 / 1075 / 1159`、`src/engines/doctor.mjs:96` 仍在调**同步** `isGitRepo`(`src/util.mjs:82-89`,内部 `execFileSync`)。

用生产侧追踪缝(`RELAY_TRACE_FILE`)实测:

| 调用 | LOG/TASKS/manifest 读 | git 子进程 | **同步 spawn** |
|---|---|---|---|
| `relay_verify`(perf 冒烟量的就是这个) | 1 / 1 / 1 | 2 | **0** ✅ |
| `relay_session_start` | 2 / 3 / **6** | 7 | **1** ❌ |
| `relay_session_end` | 2 / 2 / 2 | 11 | **1** ❌ |

`CHANGELOG.md:34` 写的是「async 路径不再同步探测 git」;`scripts/smoke-perf.mjs:100-103` 的静态检查只覆盖 `src/engines/verify.mjs` 与 `src/engines/facts.mjs`,所以 session 层的残留对该冒烟不可见。

**为什么要在意**:MCP server 是长驻进程,每次 `relay_session_start`/`relay_session_end` 都有一次 `execFileSync` 把事件循环冻结住(单次 spawn 7–10ms)。DECISIONS 里「4 次同步 isGitRepo ≈ 40ms 事件循环冻结」正是立项理由,现在只是把 4 次里的 2 次换掉了。

**修复方向**:把 session 层的 `isGitRepo` 也换成 `isGitRepoAsync`(函数已存在),并把 perf 冒烟的静态检查范围扩到全部 `src/engines/`。

---

### P1-7 · R12 可被一行归档指针消音(行数轴),且两轴口径不一致 【MEDIUM·已复现】

**位置**:`src/engines/verify.mjs:496`(活跃区 = 归档标记之前的行)与 `:499`(完成条目数用**全文**)。

**实测**:

```
200 行 LOG(无归档标记): | R12 | WARN | LOG 边界超限:活跃区 212 行 > 150
同一 LOG,顶部加一行归档指针: | R12 | PASS | LOG 活跃区 0 行 / 完成条目 0 条,在边界内
```

`LOG_ARCHIVE_MARKER_RE = /^\s*(?:<!--\s*relay:log-archive|##\s*归档)/` 用 `findIndex` 取**第一个**匹配,放在文件顶部就把活跃区清零;而它指向的 `docs/archive/LOG-2026-01.md` 从不被校验存在。

这与「阈值固定不做可配置——避免把阈值调大成为消音手段」(`src/config.mjs:130-131`)的初衷直接冲突:阈值不能调大,但一行字能把活跃区归零,消音更容易。

同时两轴口径不一致:`activeLines` 用归档区,`doneEntries` 用全文 `parseLogEntries(t)`。实测 25 条完成条目 + 顶部归档指针 → 行数轴被消音、条目轴仍报 `WARN 完成条目 25 条 > 20`。而 `CONTRACT.md:317` 写的是「指针之后的行不再计入阈值」——与实现相反。

**修复方向**:两轴统一用同一个「活跃区」;归档指针必须指向真实存在的归档文件(校验路径存在),否则不承认它划定的边界。

---

### P2-8 · 分支名含 `|` → 解析出空 branch → 假 ERROR 【LOW·已复现】

`src/engines/facts.mjs:131` — `branch=([^|]+?)\s*$`,惰性类不跨 `|`。实测 `branch=relay/T1|x` → `branch=''` → R10 结构自洽检查判「branch 缺失」→ **ERROR**,合法的分支名让出场绿闸失败。git 接受含 `|` 的分支名(已实测 `git branch 'relay/T1|x'` 成功)。

---

### P2-9 · `body.split('||')` 只取前两段,机检段含 `||` 被截断 【LOW·已复现】

`src/engines/facts.mjs:117` — `const [machineRaw = '', narrativeRaw = ''] = body.split('||')`。实测 `branch=relay/T1||x` → `branch='relay/T1'`(被截断,但仍满足 `/^relay\//` → R10 PASS,账本记了一个从未写过的分支名),且 `acceptance=null`、`verifyPass=0`(叙述段被丢弃)。

---

### P2-10 · recall 不再剥离 v1 事实行前缀,输出双前缀 【LOW·已复现】

`src/engines/facts.mjs:11` 把 `FACT_LINE_PREFIX` 改成 `'- 事实(v2):'`,而 `src/engines/recall.mjs:192` 用它做 `replace`。升级前写的 v1 行前缀不再被剥离,`relay_get` 输出 `事实: - 事实(v1): 改动 3 文件(+10/-2) | …`。

---

### P2-11 · managed 路径的 git 进程数是 6,不是宣称的 2–4 【LOW·已量化】

`runTaskTreeChecks` 只喂 R1/R2/R3/R4/R8(只用 `git.tops`,不用 `git.commits`),但 `collectGit(executionRoot)` 仍跑 `git log -20 --name-only`。实测双根 verify = 6 个 git 子进程(2 resolveRelayRoots + 2 controlRoot + 2 executionRoot)。`scripts/smoke-perf.mjs:56` 的 `git <= 4` 只在 `relay_init` 夹具上量(此时 controlRoot === executionRoot,任务树检查提前返回),managed 路径从未被量到。

---

### P2-12 · R12 修复建议「拆小任务粒度」与阈值方向相反 【LOW】

`src/engines/verify.mjs:509` 把「或拆小任务粒度」与归档并列为两条出路。但每次 `relay_session_end` 都会往 LOG.md 顶部加一条条目,拆小任务只会产生**更多**会话、**更多** LOG 行,更快撞上 150 行 / 20 条两个阈值。协议把每条「修复:」都当作可执行指令,这条会引导用户做相反的事。

---

## 5. 复现脚本

全部在 `/tmp/pr8-audit/`,临时仓库内构造、用后清理,未改动被审计代码:

| 脚本 | 验证 |
|---|---|
| `commit-sentinel.mjs` / `sentinel2.mjs` | P0-1 `__COMMIT__` 哨兵文件名伪造提交头 → R5 失效 |
| `v1-bypass.mjs` | P0-2 v1 行自选 range → R10 PASS |
| `branch-pm.mjs` | P1-3 / P1-4 branch 与 single± 篡改不误红 |
| `r10-probe.mjs` | 解析器边界(9 组输入) |
| `pipe-branch.mjs` | P2-8 / P2-9 `|` 与 `||` 的解析断裂 |
| `r12-silence.mjs` | P1-7 归档指针消音 |
| `sync-count.mjs` | P1-6 三个入口的读/进程/同步计数 |
| `segment-test.mjs` | 叙述段 vs 机检段篡改矩阵 |

---

## 6. 独立验证过的「没问题」部分

为免重复怀疑,以下都实测过:

- **R2 的 `ls-files` 合并语义正确**:`ls-files -z --cached --others --exclude-standard` 与 base 版「两次 ls-files 取并集」等价,`-z` 还顺带修好了含换行文件名的解析。
- **R5/R6/R2/R7/R9/R11 判定与 base 一致**:差分跑同一夹具,只有 R10 变化——正是 T023 声明的 fail-open 修复。
- **R12 已注册到位**:`runChecks`(fast 与 full 都跑)、`relay_rules` RULES_TEXT、两个工具描述、CONTRACT 规则表、AGENTS 模板、README(中文)。
- **`resolveRelayRoots` 的 fs 快路径正确**:普通仓库(`.git` 目录)走 fs,linked worktree(`.git` 文件)正确回落到 git 探测,不会误判 worktree 为普通仓库——在真实 worktree 上验过。
- **R12 的 WARN 不阻断绿闸**(exit 0,只有 ERROR 才 isError)——符合「只报警不归档」的设计。
- **叙事段设计正确**:验收结果/耗时/verify 汇总是写时快照,检查时点不可重算,只做结构校验、不参与严重度判定——这个取舍是对的,PR 描述也准确。
- **测试规模属实**:14 套 573 断言全绿(并行 14.71s);`npm test` 24.91s;`smoke-t021-decision` 正确排除在 `npm test` 外并保持红灯(exit 1)。
- **仓库自身状态属实**:`relay_verify --full` = PASS 10 · WARN 1(R12,LOG 159 行 > 150)· ERROR 0 · SKIP 1。

---

## 7. 建议修复顺序

| 序 | 条目 | 理由 |
|---|---|---|
| 1 | **P0-1** `__COMMIT__` 哨兵 | 本 PR 引入的回归,且是静默失效;改用 `-z` 或双调用即可 |
| 2 | **P0-2** v1 行自选 range | 与 CONTRACT 明写的「绝不 PASS」直接冲突 |
| 3 | **P1-3 / P1-4** branch 与 single ± 不对账 | 契约已把这两项列为机检段,要么实现要么改契约,二者选一 |
| 4 | **P1-5** 三处一致断言升级为内容比对 | 顺带清掉 README 英文半边的 R1–R11 |
| 5 | **P1-7** R12 归档指针 | 消音口子与两轴口径一起修 |
| 6 | **P1-6** session 层同步探测 | perf 冒烟的静态检查范围扩到 `src/engines/` |
| 7 | P2 各项 | 择机 |

---

## 8. 一句话结论

**裁判加固的思路是对的**——尤其「按可复算性拆机检段/叙述段」这个修正,比「8 项全对账」高明得多(写时快照不可重算,强行对账只能产假绿或死锁);叙述段不误红也实测成立。但**「R10 不再有 fail-open」这句话目前还不成立**(v1 路径仍可 PASS),而且为了省一次 git 子进程引入的 `__COMMIT__` 哨兵,反而给 R5 开了一个静默失效的口子。**建议先修这两条 HIGH,再合并。**

---

## 9. 修复记录(2026-11-02,PR #8 分支)

| 发现 | 修复 | 回归断言 |
|---|---|---|
| P0-1 `__COMMIT__` 哨兵伪造 | `collectGit` 改用 NUL 记录前缀(`%x00%H%x09%s`):文件名不可能含 NUL,提交头只可能出现在 chunk 首行 | `smoke-review-regressions` F 段(白名单修宪允许该文件后 R5 仍 WARN,详情含 src 改动) |
| P0-2 v1 自选 range | v1 分支不再调用重算:只做结构校验 → WARN,数字权威仅 v2 | `smoke-facts` v1 用例(数字恰好对上也只 WARN、绝不 PASS) |
| P1-3 branch 未比对 | managed:`git branch --contains <sha>`(存在但不含 → ERROR,已删除/不可读 → WARN);single:代码未提交,只校验分支存在性(伪造分支名 → WARN) | `smoke-facts` 三分支用例 + single 分支伪造用例 |
| P1-4 single ± 未对账 | 契约与实现统一:文件数恒对账,± 仅 managed 可复算(single 的 ± 是写时近似) | 规则表 + CONTRACT T013 段措辞;`smoke-facts` 保持 managed ± 篡改 ERROR |
| P1-5 三处一致只查行存在 | 断言升级为内容比对(150/20/warn/`logBoundary.strict`);README 中英文两半 R1–R12、`src/**` 无 R1–R11 残留纳入断言 | `smoke-r12-boundary` 三处内容一致 + README/`src` 静态断言 |
| P1-6 会话层同步探测 | 删除同步 `isGitRepo()`;session/claim/doctor/bootstrap/restructure 全改 `isGitRepoAsync`;静态检查覆盖整棵 `src/`(15 文件) | `smoke-perf` 静态断言;`smoke-session-perf`(红灯,T026)验证 session_start sync=0 |
| P1-7 R12 指针消音 | 指针必须指向真实存在且非空的 `docs/archive/*.md`,否则按全文计算并标注「未被承认」;两轴共用活跃区 | `smoke-r12-boundary` 假指针仍 WARN / 真指针 PASS + 活跃区 0 行 |
| P2-8/9 `|`/`||` 解析断裂 | v2 按「空格||空格」切分;分支名含 `|`、叙述段含 `||` 均保留 | `smoke-facts` 解析器边界 3 断言 |
| P2-10 recall v1 前缀 | 导出 `FACT_LINE_PREFIX_RE` 同时剥离 v1/v2 | `smoke-recall` v1 前缀用例 |
| P2-11 任务树 git 进程 | `runTaskTreeChecks` 只取 `ls-files`(不取提交历史) | `smoke-perf`(此处 git=2 实为 controlRoot 单根路径的测量,真双根见 §11 N1 修正) |
| P2-12 R12 修复文案 | 删除「拆小任务粒度」(与阈值方向相反) | 文案断言(`/归档/`,不含错误指引) |

**复测**:`npm test` 14 套 / 595 断言全绿(复审后 N1/N2 修复补齐至 604,见 §11);`relay_verify --full` = PASS 10 · WARN 1(R12,LOG 159 行 > 150)· ERROR 0;CI(node 22/24/26)全绿。

**残留(已登记 T026)**:`session_start` 仍有 manifest 读 6 次 / git 7 次的读放大(同步 spawn 已清零);修复需把 manifest 配置沿 session_start 调用链单轮传递,不引入跨调用缓存。
---

## 10. 复审记录(2026-11-02,HEAD `0e509fa`)

复审方式:**重跑本报告 §5 的全部复现脚本**(脚本未改动,仍指向工作树=新 HEAD),加上新写的边界脚本。不采信修复说明,只认脚本输出。

### 10.1 12 条发现的复验结果

| 发现 | 复验实测 | 结论 |
|---|---|---|
| P0-1 `__COMMIT__` 哨兵伪造 | 同提交含 `src/feature.js` + `__COMMIT__notes.md` → `R5 \| WARN`(基线同夹具亦 WARN)。NUL 前缀解析实测:`commit f9178fe8 files=["__COMMIT__notes.md","src/feature.js"]` —— 文件名正确落在 chunk 后续行,伪造不再成立 | **已修复** |
| P0-2 v1 自选 range | 手写 v1 行、base/sha 指向无关提交、数字恰好对上 → `R10 \| WARN \| …v1 旧格式,只做结构校验(数字对账仅 v2 机检段权威)`,verify status 0 | **已修复** |
| P1-3 branch 未比对 | ①用 main 的真实 sha 冒充 → `ERROR \| branch=relay/T001 不包含声明的 sha=…(分支与提交不匹配)`;②分支合并后删除 → `WARN \| branch=relay/T001 无法验证(分支不存在,可能已合并删除)`;③single 伪造 `zzz/zzz` / `relay/T999` → 均 WARN | **已修复** |
| P1-4 single ± 不对账 | single `± +999/-999` → PASS(契约已改为「± 仅 managed 可复算」,并锁测试) | **已由契约统一** |
| P1-5 三处一致只查行存在 | `smoke-r12-boundary.mjs:98` 已改为内容比对(阈值 150/20/warn/开关键名);`README.md`/`src/**` 的 R1–R11 残留已清零 | **已修复** |
| P1-6 会话层同步探测 | relay_session_start:sync **1→0**;relay_session_end:sync **1→0**;`isGitRepo` 同步版已从 util 删除 | **已修复**(读放大登记 T026) |
| P1-7 R12 指针消音 | 旧格式指针→不被承认;新格式目标不存在→不被承认;目标为空→不被承认;指向 `../../etc/passwd`→不被承认;真指针→`PASS 活跃区 0 行`;两轴已共用同一活跃区 | **已修复** |
| P2-8/9 `|`/`\|\|` 断裂 | `branch=relay/T1\|x` → 解析出 `"relay/T1\|x"`;`branch=relay/T1\|\|x` → 保留且叙述段 `acceptance=通过 / verifyPass=1` | **已修复** |
| P2-10 recall v1 前缀 | 改用 `FACT_LINE_PREFIX_RE = /^- 事实\(v[12]\):\s*/` | **已修复** |
| P2-11 任务树多一次 git | `runTaskTreeChecks` 不再取提交历史 | **已修复**(但见 10.3) |
| P2-12 R12 文案 | 「拆小任务粒度」已删(残留命中是 R7 自己的文案,上下文不同) | **已修复** |

另验:NUL 解析对**中文名 / 空格 / 引号文件名**正确计入(文件数 3、± 对账一致);merge 提交作为最新提交时 R5 仍 PASS(见 10.3)。

### 10.2 修复后状态复核

```
npm test(14 套并行)      15.19s,全部 exit 0,595 断言全绿
smoke-session-perf.mjs   exit 1(红灯,登记为 T026,未进 npm test)✓
smoke-t021-decision.mjs  exit 1(红灯,T021 待办)✓
CI(node 22/24/26)        6/6 pass
```

### 10.3 复审新发现(2 条,均未修)

**N1 · perf 冒烟的「managed 双根」用例实际没走双根分支,§9 的「git=2」不准确 【MEDIUM】**

`scripts/smoke-perf.mjs:99-106` 标为「managed 双根」,但它跑的是 `relay_verify --root <controlRoot>`。`src/engines/verify.mjs:643` 的分支条件是 `roots.controlRoot === roots.executionRoot`,controlRoot 入参直接落进**单根分支**。而真正的双根分支(`relay_verify --root <executionRoot>`)恰恰是代码注释里点名要支持的场景(「避免『在 worktree 里 verify 出绿、出场绿闸却查 controlRoot』的分裂结论」),它**从未被该冒烟测量**。

实测两者的 git 子进程数(生产追踪缝 `RELAY_TRACE_FILE`):

| 调用 | git | sync |
|---|---|---|
| `relay_verify --root <controlRoot>`(冒烟所测) | 2 | 0 |
| `relay_verify --root <executionRoot>`(真双根) | **7** | 0 |

真双根 7 次已超出该冒烟宣称的 `≤ 5` 上界。本报告 §9 的「smoke-perf managed 双根 git=2 ≤ 5」因此既不是双根的数,也不是该分支的上界断言。

**N2 · R5 在最新提交为 merge 时静默空转(与 base 同行为,非本 PR 引入)【LOW】**

`git log --name-only` 对 merge 提交不显示文件,故 `commits[0].files` 为空 → R5 的 `code.length` 为 0 → 直接 PASS。实测把 HEAD 换成 `Merge tmpmerge` 后:`R5 | PASS`。base 版用 `git log -1 --name-only` 行为相同,**不是回归**;但本仓库提交史里 `Merge T018/T019/T020` 连续出现,意味着 R5 在相当一部分真实提交上处于「形同虚设」状态。若要修:`git log --first-parent` 或 `git show --name-only -m`。

### 10.4 复审结论

**12 条发现全部确认修复,可以合并。** P0-1 与 P0-2 都不是打补丁而是换机制:NUL 前缀让「文件名伪造提交边界」在类型层不成立;v1 不再调用重算、数字权威收敛到 v2。两处新发现(N1/N2)都不阻断合并,但 N1 建议顺手把冒烟的「managed 双根」用例改成真跑双根分支,否则那条 `≤ 5` 的上界保护的是没人走的路径。

---

## 11. 复审后修复(N1 / N2,2026-11-02)

复审 §10 的两条新发现均为「顺手可做」,已在同一 PR 内修复并补回归;§9 的 P2-11 测量口径也一并修正。

### N1 · 冒烟改跑真双根,上界断言改为真实路径

- `smoke-perf.mjs` 的 managed 用例不再跑 `--root <controlRoot>`(那条路径会落进单根分支),改为从 `claim` 返回的 **executionRoot** 跑 `relay_verify`,并断言输出含「双根模式」与 executionRoot 任务树段落。
- 断言:真双根 `sync=0`、`manifest` 读 **1** 次(meta 复用)、git 子进程 **≤ 8**。实测本仓库夹具 5 次;复审测得 7 次(其夹具含 v2 完成条目,R10 会多一次 branch 校验 + 一次 diff)——两者都在上界内。
- §9 P2-11 的「git=2」标注为单根路径测量,已加注指向本节;`verify.mjs` 双根输出标签同步修正为「R5/R6/R7/R9/R10/R11/R12 只在 controlRoot 跑」。

### N2 · R5 遇 merge 提交改为显式 SKIP,不再假 PASS

- `collectGit` 的提交头增加 `%P`(父提交),R5 识别 `parents.length > 1` 时返回 **SKIP** 并在文案里说明「merge 是集成提交、git log --name-only 不列 merge 文件、不是通过」,给出 `git show --name-only -m <merge-sha>` 的核对方式。
- 双根场景由 session_end 的成对证据(代码提交 + 控制面提交)兜底,与 AGENTS/CONTRACT 的 R5 口径一致。
- 回归:`smoke-review-regressions` G 段——构造 `--no-ff` merge 提交后断言 `R5 | SKIP` 且文案含 merge(旧行为是 PASS)。

### 复测(§11 修复后)

```
npm test(14 套)           全部 exit 0,604 断言全绿
relay_verify --full       PASS 10 · WARN 1(R12)· ERROR 0
smoke-session-perf.mjs    exit 1(红灯,T026)✓
smoke-t021-decision.mjs   exit 1(红灯,T021)✓
```

结论:**N1/N2 均修复**;R12 的 WARN 维持(归档引擎按 DECISIONS 推迟,触发条件 1/2),T021 仍待产品决策。