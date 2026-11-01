---
title: PR #6 多专家原子级并行审计报告 — 吸收 claude-mem 机制层(v1.3.0–v1.4.0)
version: 1.0
created: 2026-11-01
status: 现行
---

# PR #6 多专家原子级并行审计报告

> 审计对象:GitHub PR #6 `feat: 吸收 claude-mem 机制层 — 事实底账(R10)/密钥闸(R11)/有界简报/检索寻址/doctor/npm 分发 (v1.3.0–v1.4.0)`
> 本报告是**审计产物**,不是协议文件;不改 TASKS/LOG/SPEC,不参与 R 系列的机检结论。

---

## 1. 审计元数据

| 项 | 值 |
|---|---|
| 仓库 | `/Users/kent/Desktop/projects/relay-mcp` |
| PR | #6,base = `origin/main`(`1cc8ad7`),head = `origin/feat/claude-mem-absorption`(`75ac3b7`) |
| 规模 | 33 文件,+1474 / −30;`src/` +`scripts/` 占 17 文件 1216 行 |
| 审计日期 | 2026-11-01 |
| 运行环境 | Node v26.12.1,macOS (Darwin 27.2.0),仓库工作树 == PR head 且干净 |
| 审计强度 | max effort:10 个独立发现角度 → 1-vote 验证 → 缺口清扫 → ≤15 条上报 |

**注意(合并状态)**:本地 `main` 的 tip 已经等于 PR head(`75ac3b7`),即本 PR 的内容**已在本地 main 上合并**(经 `Merge T013`~`Merge T020` 若干 merge 提交),但 GitHub 侧 `origin/main` 仍停在 `1cc8ad7`,PR #6 状态仍为 **OPEN**。因此审计范围取 `origin/main...origin/feat/claude-mem-absorption`(2054 行 unified diff),工作树读到的即为 PR head 状态。

---

## 2. 结论摘要

**总体判定:不建议合并。** 4 条 P0 缺陷已在本机**实测复现**,其中 2 条直接击穿本 PR 自己写下的硬红线。

| 等级 | 条数 | 说明 |
|---|---|---|
| P0(高危·已复现) | 4 | 可造成**密钥永久写入 git 历史**、**正确会话被机检误判**、**最可能泄露的密钥格式完全漏扫**、**检索工具在任务 worktree 内完全失明** |
| P1(中高) | 14 | 半写状态(降级)、闸门层次错误、opt-out 未实现、R10 存在性 ERROR 死锁、R10 只查最新条目、日期漂移误报、协议正则双份、过滤失效、控制根路由错误、版本号漂移 |
| P2(中·契约/规约/覆盖) | 8 | 规则表缺 R10 行、全局残留 "R1–R9"、跳过列表不完整、发布护栏被移除且无替代、CHANGELOG 段序破坏自述格式、冒烟脚本绕开会暴露 P0 的路径、doctor 零写盘断言只覆盖 .relay/、简报不回显真实 worktree 值 |
| P3(低·清理/效率) | 12 | 死代码、未用导入、代理对截断、重复 harness、阻塞式 git 调用、升级提示缺失 |

### 与 PR 自述硬红线的直接冲突

| PR 声明 | 实际 |
|---|---|
| 红线 5:「A 必须绑 I——事实落账与密钥闸同批,否则把路径/密钥形状永久写进 git 历史」 | **被违反**:managed 模式先提交代码(提交消息含 summary 首行)再跑密钥闸;实测密钥已进入 commit message,而闸门仍输出「未提交」 |
| 「边界必须显式可见,fail-closed 优先于优雅降级」 | **被违反**:密钥闸位于 3 个调用点而非写入原语;`relay_claim` 与 `relay_restructure` 两条写盘路径完全绕过闸门 |
| 「机检只裁判结构与数字」 | R10 只对账**文件数**一个数字,同一行里其余 7 个断言(验收 / verify 计数 / 分支 / sha / 耗时)从不对账,却看起来像被机检覆盖;R10 的存在性检查又只查「最新条目」而非「最新完成条目」,伪造的完成条目可以逃逸 |
| 「检索索引不落盘——否则成为第二真相源」 | 索引确实零落盘,但**读取源选错了根**:在任务 worktree 内读到的是 baseSha 快照,不是控制面 |

---

## 3. 审计方法

### 3.1 十个独立发现角度(并行)

| # | 角度 | 定位 | 产出 |
|---|---|---|---|
| A | 逐行 diff 扫描 | 8 | 事实行 git 口径、密钥规则漏扫、事实行 opt-out |
| B | 删除行为审计 | 8 | "R1–R9" 残留、`private:true` 被删、模板 LOG 示例被改 |
| C | 跨文件调用追踪 | 7 | 事实行口径不一致、R10 存在性 ERROR 锁死出场、`relay_sync` 缺升级提示 |
| D | JS/ESM 语言陷阱 | 8 | `git diff HEAD` 漏未跟踪文件、`statusOf` trim 陷阱、代理对截断 |
| E | 包装/路由正确性 | 8 | `relay_recall`/`relay_doctor` 不解析控制根、doctor 的 D3/D4/D5 缺陷 |
| Reuse | 复用 | 8 | 协议正则双份、git worktree 解析器重写、`readText` 四份拷贝 |
| Simplification | 简化 | 8 | 同一数字两处独立派生、bootstrap 事实默认值写死两遍 |
| Efficiency | 效率 | 8 | `isGitRepo` 阻塞式 `execFileSync`、R10 三次 git 进程、LOG.md 四次重读 |
| Altitude | 根因深度 | 8 | 闸门应在 `writeProtocolFile` 原语内、摘要上限应在生产者侧 |
| Conventions | CLAUDE.md/AGENTS.md | 8 | CONTRACT 规则表缺 R10 行、三处一致被破 |

### 3.2 验证(1-vote,3 态)

每个候选由独立验证者裁定 **CONFIRMED / PLAUSIBLE / REFUTED**。本报告中的 P0/P1 条目**全部由本机实测复现**强于语言模型投票,复现脚本见 §5。

### 3.3 缺口清扫

在已有清单基础上做一次纯缺口复查,重点扫描:新冒烟脚本的 setup/teardown 不对称、contract schema 与引擎实参不匹配、模板与引擎产出不一致、`files` 白名单与运行时实际读取路径、init/onboard 的 `facts` 默认值分歧、CI 在工具数 10→11→13 变化后是否仍通过。

**清扫产出 8 条,其中 3 条为新增并已并入 §4**:R10 只查最新条目(P1-16)、MCP 握手版本漂移(P1-17)、doctor 零写盘断言只覆盖 `.relay/`(P2-22);另加简报不回显真实 worktree 值(P2-23)。其余 3 条与既有条目重合(模板跳过列表、contract 的 "R1–R9"、PROTOCOL_TEXT 规则区间)。

**清扫过程中另外确认了两处「无问题」**(值得记下来,免得后续重复怀疑):`relay_init` 与 `relay_onboard` 写入的 `facts` 默认值一致(都是 `{enabled:true, since:stamp(), strict:false}`,`bootstrap.mjs:293` 与 `:431`);CI 工作流 `.github/workflows/ci.yml:25` 跑的是 `npm test`,已包含全部 11 个冒烟套件。

---

## 4. 发现清单(按严重度排序)

### P0-1 · managed 模式:密钥在密钥闸之前被写进 git 提交消息 【CONFIRMED·已复现】

**位置**:`src/engines/session.mjs:1180-1184`(提交消息构造)与 `:1230`(提交执行);密钥闸在 `:1296-1301`。

```js
// session.mjs:1180 —— 提交消息里嵌入 summary 的第一行
const managedMessage = ((cfg && cfg.commitMessageTemplate) || DEFAULT_COMMIT_TEMPLATE)
  .replaceAll('{{task}}', managedHead)
  .replaceAll('{{taskId}}', doneTask)
  .replaceAll('{{summary}}', summary.split('\n')[0].trim())   // ← 模型自由文本
  .slice(0, 80);
// session.mjs:1230 —— 代码提交,发生在密钥闸之前
const committed = await gitRun(executionRoot, ...(await gitIdentityArgs(executionRoot)), 'commit', '-m', managedMessage);
```

**失效场景**:managed(受管 worktree)出场时,若 `summary` 首行含密钥样式串,该串在第 1230 行就被写进**任务分支的 git 提交消息**;第 1296 行的密钥闸随后才运行并阻断 TASKS/LOG 写入。密钥已永久进入 git 历史(事后不可撤回,正如 PR 自己在 `src/engines/session.mjs:1297` 的注释所写)。更糟的是闸门的输出文案宣称:

```
本次未写入任何文件、未提交、未释放认领锁。
```

在 managed 模式下这句是**假的**——代码提交已经发生。

**实测复现**(临时仓库,worktree 启用,`summary` 首行含 `AKIA` + 16 位大写字母):

```
session_end status: 1
gate message present: true
gate claims "未提交": true
--- git log --all ---
422c582 relay: init project
91f3f46 relay: session end — T001 完成 · 泄漏 AKIA…EXAMPLE
>>> SECRET PRESENT IN GIT COMMIT MESSAGE: YES — LEAKED before the gate ran
```

**修复方向**:把密钥闸前移到**任何提交之前**(即 `:1176` managed 块之前),或把 `{{summary}}` 从提交消息模板中移除 —— 提交消息不应承载模型自由文本。

---

### P0-2 · 事实底账的文件数口径与校验侧不一致,正确会话被 R10 误判 【CONFIRMED·已复现】

**位置**:`src/engines/facts.mjs:51-53`(写入侧)与 `:129-142`(校验侧)。

写入侧:
```js
stat = managed && baseSha
  ? await diffStat(executionRoot, [`${baseSha}..HEAD`])   // 整条任务分支
  : await diffStat(executionRoot, ['HEAD']);               // 工作区 vs HEAD
```
校验侧:
```js
if (parsed && parsed.sha && /^[0-9a-f]{7,40}$/.test(parsed.sha)) {
  range = [`${parsed.sha}^`, parsed.sha];                   // 只有最后一个提交
} else {
  range = ['HEAD^', 'HEAD'];
}
```

两处**命令相同、范围不同**,而 `src/engines/facts.mjs:5` 的铁律注释写的是「写入侧与校验侧使用同一条 git 命令(--name-only --no-renames),口径天然一致」—— 该断言不成立。

另有第二重偏差:单根模式下 `git diff HEAD` **不包含未跟踪文件**,而随后的 `git add -A` 会把它们纳入提交,于是写入侧少算、校验侧多算。

**实测复现 A(两提交任务分支)**:临时仓库造 `base → commit1(2 文件) → commit2(1 文件)`,调用真实引擎函数:

```
writer fact line : - 事实(v1): 改动 3 文件(+3/-0) | ... | 分支: relay/T999 @cf66d50
checker recompute: 1
R10 verdict      : MISMATCH -> WARN/ERROR (声明 3 vs 实测 1)
```

**实测复现 B(单根 + 新建文件,端到端)**:全新仓库、正常单根会话、新建 1 个文件、正常提交:

```
1) fact line written by engine : - 事实(v1): 改动 1 文件(+2/-2) | ... | 分支: main @未提交
2) manual commit exit status   : 0
3) files in that commit        : .relay/manifest.json, src/brand-new.mjs
4) relay_verify exit status    : 0
5) R10 line(s):
   R10 | WARN | 事实行声明 1 文件,git 实测 2 文件(只比文件数,--no-renames)
```

**为何现有分支没暴露**:本仓库 6 条真实任务分支(T013/T014/T015/T018/T019/T020)经 `.relay/worktrees.json` 的 `baseSha`/`commitSha` 逐一核对,**每条都恰好只有 1 个提交**,两个范围恰好重合:

```
task  baseSha->commitSha(writer)  commitSha^->commitSha(checker)  AGREE?
T014  12  12  yes   (branch commits since base: 1)
T013  13  13  yes   (branch commits since base: 1)
T015   6   6  yes   (branch commits since base: 1)
T019   8   8  yes   (branch commits since base: 1)
T018   7   7  yes   (branch commits since base: 1)
T020   4   4  yes   (branch commits since base: 1)
```

即:**这是一个潜伏缺陷,不是已爆缺陷**。触发条件有两条,都很常见:①模型在任务中途自行 `git commit`(仓库自己的 `src/engines/session.mjs:8` 就写着「护栏只看未提交 diff——模型中途自行 git commit 即可绕过」);②同一任务跑第二次 `relay_session_end`(T015 的负结果明确记录了 MCP 出场与 CLI 出场各跑一次)。

**升级为 ERROR 后无法自愈**:R10 给出的修复指令是「删除该行后重跑 relay_session_end 重写」,而重写会用**同一条错口径**再次得到同一个错误数字 —— 绿闸被永久卡死。

**修复方向**:把「用哪个 range」变成事实行的一部分(记录 base sha),或抽出一个 `changedFiles(root, base, head)` 供两侧共用,并在单根模式用 `git status --porcelain` 之类能覆盖未跟踪文件的口径。

---

### P0-3 · 密钥扫描规则漏掉本仓库用户最可能泄露的密钥格式 【CONFIRMED·已复现】

**位置**:`src/util.mjs:156-163`。

```js
export const SECRET_CONTENT_RULES = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pous]_[A-Za-z0-9]{36}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['OpenAI-style key', /sk-[A-Za-z0-9]{20,}/],     // ← 见下
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
```

`sk-[A-Za-z0-9]{20,}` 要求 `sk-` 之后**连续 20 位以上字母数字**。Anthropic 的 `sk-ant-api03-…` 只有 `ant` 三位就遇到连字符,OpenAI 的项目密钥 `sk-proj-…` 同理,GitHub 的细粒度令牌 `github_pat_…` 前缀也不在字符集里。

**实测**(直接调用 `scanSecrets`):

```
CAUGHT  AWS access key            AKIA…EXAMPLE
CAUGHT  GitHub classic token      ghp_…(36)
*** MISSED ***  GitHub fine-grained   github_pat_…
CAUGHT  Slack xoxb                xoxb-…
CAUGHT  OpenAI legacy sk-         sk-…
*** MISSED ***  OpenAI project sk-proj sk-proj-…
*** MISSED ***  ANTHROPIC sk-ant-      sk-ant-api03-…
*** MISSED ***  Anthropic admin key    sk-ant-admin01-…
CAUGHT  Google API key            AIza…
CAUGHT  PEM private key           -----BEGIN RSA PRIVATE KEY-----
*** MISSED ***  marker bypass        AKIA…EXAMPLE relay:secret-ok
```

`sk-ant-*` 恰恰是 Claude/Anthropic 生态里最常被写进日志的密钥形态 —— 本 PR 的受众正是 Claude Code 用户。

**附带**:`relay:secret-ok` 标记命中后**整行跳过**(`src/util.mjs:168`),而该标记本身是模型可写的自由文本。模型只要在同一行追加 `relay:secret-ok`,密钥闸与 R11 会双双放行,且不留任何豁免记录。

**修复方向**:规则集补 `sk-ant-[A-Za-z0-9_-]{20,}`、`sk-proj-[A-Za-z0-9_-]{20,}`、`github_pat_[A-Za-z0-9_]{20,}`;豁免标记改为需要显式配置项开启,或至少在 R11 输出里列出被豁免的行。

---

### P0-4 · 检索工具在任务 worktree 内完全失明(读到 baseSha 快照而非控制面) 【CONFIRMED·已复现】

**位置**:`src/engines/recall.mjs:94`、`:140`;`src/engines/doctor.mjs:152`。

```js
const root = String((args && args.root) || process.cwd());   // recall.mjs:94 / :140
// 然后 buildModel() 直接读 join(root,'LOG.md') / join(root,'TASKS.md') / join(root,'DECISIONS.md')
```

仓库里所有其他对根敏感的引擎都先调 `resolveRelayRoots`(session.mjs:426/695/918、verify.mjs:473、worktree.mjs:728),把「控制根 vs 执行根」分开。`recall.mjs` 与 `doctor.mjs` **没有做这件事**,直接用 `args.root`。

在任务 worktree 里,`TASKS.md`/`LOG.md` 是 baseSha 时刻的**快照**(这正是 `src/engines/verify.mjs:409` 注释「executionRoot 里的 TASKS/LOG 只是 baseSha 快照,同 R7/R9 边界」所描述的边界)。所以在 worktree 里调用检索工具读到的是过期协议面。

**实测**(认领 T001 → 在控制面把它标为完成并追加 LOG 条目 → 分别在控制根与 worktree 里调 `relay_recall`):

```
--- relay_recall in CONTROL root (correct) ---
命中 1 条(索引约 32 tokens…)
T001|2026-11-01 21:00|m1|完成|认领测试|6t|负结果:0

--- relay_recall in TASK WORKTREE (what an agent in the worktree gets) ---
命中 0 条(索引约 1 tokens…)
无命中:放宽 query/status 或省略过滤条件。
```

即:**agent 在自己的任务 worktree 里查历史,永远查不到东西**。而 worktree 正是本仓库的默认模式(`.relay/manifest.json` 的 `worktree.enabled = true`),也正是 `relay_recall`/`relay_get` 最有价值的场景。

`relay_doctor` 同理:D4/D5/D6 依赖 `.relay/` 下的注册表与认领锁,而 `.relay/` 是 gitignored 的,**只存在于控制根**;在 worktree 里跑 doctor 会得到「未登记的任务树」等假 ERROR。

**修复方向**:`recall.mjs` / `doctor.mjs` 改用 `resolveRelayRoots(root)` 取 `controlRoot` 读协议面、`executionRoot` 读代码树。

---

### P1-5 · LOG 密钥闸位于 TASKS 写入之后 —— 顺序缺陷成立,但**本轮未能构造出可达触发** 【PLAUSIBLE·复现未触发】

**位置**:`src/engines/session.mjs:1318`(TASKS 写入)→ `:1363`(LOG 闸)。

PR 自己在 `:1296-1297` 写下的设计意图是「必须在任何写入之前拦截,否则会出现「TASKS 已写、LOG 被拦」的半写状态」。前置输入闸(读 `modelText`)确实在写盘前,但 **LOG 文件闸扫的是整个 LOG.md**(含历史条目),而它位于 TASKS 写入之后:

```js
await writeProtocolFile(root, 'TASKS.md', tasksText, {...});   // :1318 已落盘,T001 已标 [x]
...
const logSecret = secretGateBlock('LOG.md', logTextOut);        // :1363 才扫
if (logSecret) { out.push(logSecret); return {..., isError: true}; }
```

**我的复现尝试与结果(诚实记录)**:构造「LOG.md 历史条目含密钥 + 本次摘要干净」的会话,期望触发半写 —— **未触发**。绿闸阶段(`session.mjs:1051` 的 `runChecks`)的 R11 先一步拦下:

```
[绿闸:未通过 — 未提交]
- **R11**(controlRoot) 协议文件含疑似密钥内容(1 处): LOG.md:4 命中 AWS access key AKIA…(20 chars)
TASKS.md CHANGED anyway?  : false
TASKS.md marks T001 [x]?   : false
```

逐条核对后确认:**LOG 闸当前实际上不可达**。它要触发需要「新内容既不在磁盘上的 LOG.md 里、又不在 `modelText` 里」,而写入 LOG 的每一段自由文本(`summary` / `next.title` / `next.acceptance` / `next.notes` / `negatives` / `blocked`)都已被 `:1298` 的 `modelText` 覆盖,引擎派生的字段(事实行、worktree 行)不含自由文本。

**因此本条降级为潜在顺序缺陷 + 冗余代码**,而非可触发的 bug。保留它的理由是:一旦未来有人给 LOG 条目加一个新的自由文本字段(而忘了把它加进 `modelText`),这个闸就是唯一防线 —— 它位于 TASKS 写入之后,届时它会**一边阻断、一边留下半写状态**,并且仍会输出「本次未写入任何文件」这句不实陈述。**建议**:要么把它与输入闸合并前置,要么直接删除(它已被绿闸 R11 与输入闸完全覆盖),避免留下一枚位置错误但看起来在生效的防线。

**修复方向**:把 LOG 全量预扫提到 `:1296` 附近(与输入闸并列),或删除该闸并在 `:1318` 之前保留一次「将要写入的 LOG 全量」预扫。

---

### P1-6 · 密钥闸挂在调用点而非写入原语,`relay_claim` 写盘路径完全绕过 【CONFIRMED·已复现】

**位置**:`src/util.mjs:257`(`writeProtocolFile` —— 唯一收口 TASKS/LOG 的写入原语,内部**不含** `scanSecrets`);闸门散落在 `src/engines/session.mjs:1300 / 1313 / 1363`。

`grep -n "scanSecrets\|secretGate" src/engines/session.mjs` 的全部命中只有:第 13 行(import)、第 56-57 行(定义)、第 1300 / 1313 / 1363 行(三处调用点)。**写入原语本身没有闸**。

绕过者:

| 路径 | 证据 |
|---|---|
| `relay_claim` 写 TASKS.md | `src/engines/session.mjs:831` `await writeProtocolFile(root, 'TASKS.md', tidy(lines), {...})` —— 写入前**无**任何 `scanSecrets` 调用 |
| `relay_restructure` 写 TASKS/LOG | `src/engines/restructure.mjs:125 / 142 / 157` 使用裸 `writeFile`,既绕过密钥闸,也绕过 `writeFileAtomic` 的符号链接防线与 fencing |

**实测复现**(`relay_claim` 的 `model` 是调用方自由文本,被写进 TASKS.md 的认领戳):

```
relay_claim status: 0
gate message present: false
TASKS.md contains the secret after claim? true
  offending line: - [~] T001 认领旁路测试  (smoke-AKIA…EXAMPLE, 2026-11-01 20:09)
relay_verify status: 1
  R11 says: R11 | ERROR | 协议文件含疑似密钥内容(1 处): TASKS.md:18 命中 AWS access key AKIA…(20 chars)
```

即:密钥**已经落盘**,R11 只在**下一次** verify 时才报出来 —— PR 宣称的「出场写盘前直接阻断(不写、不提交)」在该路径上不成立。这是典型的「检测器代替了拦截器」:污染先发生,报告后到。

**修复方向**:把 `scanSecrets` 放进 `writeProtocolFile`(fail-closed,写前阻断),把 `relay_verify` 的 R11 保留为探测器,把 `session_end` 的输入扫描降级为「预检提示」。这样任何写盘路径都自动受保护,不必逐个调用点补闸。

---

### P1-7 · 事实行无视 `manifest.facts.enabled`,与自家契约冲突 【CONFIRMED】

**位置**:`src/engines/session.mjs:1332-1348`。

`grep -n "facts" src/engines/session.mjs` 全仓库只有两处命中:第 21 行(import)与第 627 行(简报回显)。事实行的计算与写入**没有任何 `cfg.facts.enabled` 判断**:

```js
const factLine = formatFactLine(await deriveFacts({ executionRoot, managed, ... }));
const entry = [ `## ${stamp()} | model=${model} | task=${taskField}`, `- 摘要: ${summaryFlat}`, factLine ];
```

而契约两处明确承诺了相反的行为:

- `src/config.mjs:116` —「事实底账(T013/R10):**缺席 = 旧行为(不写事实行、R10 跳过)**;init/onboard 显式开启。」
- `docs-design/CONTRACT.md:227` —「旧项目缺席即旧行为(**不写事实行**、R10 跳过)」

**失效场景**:一个把 `facts` 从 manifest 里删掉(或显式 `enabled:false`)的旧项目,升级后**依然**会被写上机器事实行;R10 因为 `facts.enabled` 为假而 SKIP,于是这些行永远无人校验 —— 账本看起来像被机检守着,实际不是。

**修复方向**:写入侧按 `cfg.facts.enabled` 决定是否追加 `factLine`,与 R10 的开关读同一个字段。

---

### P1-8 · doctor 的 D3 入口漂移检测每天误报一次 【CONFIRMED·已复现】

**位置**:`src/engines/doctor.mjs:53`;根因在 `src/engines/sync.mjs:56`(`today: ctx.today || stamp().slice(0,10)`)与 `templates/AGENTS.md.tpl:4`(含 `{{TODAY}}`)。

`generateEntryFiles(root, { mode:'check' })` 用**当天日期**渲染模板,再与磁盘上的 AGENTS.md 比对。AGENTS.md 里带的是**上次生成日期**,所以从生成次日 起,每一个健康仓库都会报 D3 WARN。

**实测**(同一仓库,只改 `today`):

```
today=2026-11-01 -> drift entries: 0 (none)
today=2026-11-02 -> drift entries: 1 AGENTS.md
    {"file":"AGENTS.md","diff":"第 4 行起:旧 22 行 / 新 22 行
      旧: 本文件由 relay-mcp 单源投影生成(2026-11-01);…
      新: 本文件由 relay-mcp 单源投影生成(2026-11-02);…"}
```

差异**只有日期**。而 D3 给出的修复建议是「运行 relay_sync 重新投影入口文件」—— 这会重写用户的 AGENTS.md 并留下 `AGENTS.md.relay-bak-<ts>` 备份文件,而 `git add -A` 会把它提交进仓库根目录(本仓库 LOG.md 的 T014 负结果已经记录过同类 `.relay-bak` 残留问题)。

**修复方向**:D3 比较时把 `{{TODAY}}` 归一化(两侧都用同一占位符),或从比较中排除日期行。

---

### P1-9 · 同一协议格式存在两套解析器 【CONFIRMED】

**位置**:`src/engines/recall.mjs:9-10` 与 `:164`。

```js
// recall.mjs:9-10 —— 自己抄了一份
const TASK_LINE_RE = /^- \[( |~|x)\] (T\d+) (.*?)(?:  \((.*)\))?$/;
const LOG_TITLE_RE = /^## (.+?) \| model=(.+?) \| task=(.+)$/;
```

`src/engines/verify.mjs:12-13` 已经导出同名常量,且其文件头声明「TASKS 任务行与 LOG 条目标题的正则与契约逐字符一致,绝不改动」;`src/engines/session.mjs:19` 与 `src/engines/worktree.mjs:11` 都从 verify.mjs 导入。`recall.mjs` 是唯一的例外,连 `parseLog` 也另起炉灶(`recall.mjs:39`,而 `verify.mjs:41` 有 `parseLogEntries`)。

`recall.mjs:164` 还用动态正则重建了一遍事实行解析(`field(e.block, '事实\\(v1\\)')`),而 `src/engines/facts.mjs:8-9` 已经导出了 `FACT_LINE_PREFIX` / `FACT_LINE_RE` / `parseFactLine`。

**失效场景**:契约改一行任务行格式或事实行前缀,verify/session/worktree 跟进,recall 不跟进 —— 校验器判对,检索器判错,两套真相对同一格式各说各话。这正是项目「两份会漂移的真相比一份过期的真相更危险」所禁止的。

---

### P1-10 · 契约宣称的 `status:" "` 过滤是静默空操作 【CONFIRMED】

**位置**:`src/engines/recall.mjs:72-79`。

```js
const statusOf = (v) => {
  const s = String(v ?? '').trim();     // ← ' ' 被 trim 成 ''
  if (!s) return null;                  // ← 返回 null = “不筛”
  ...
  if ([' ', '待办', 'todo', 'pending'].includes(s)) return ' ';   // ← 永远不可达
};
```

`src/contract.mjs:245` 对外公布的取值是「完成 | 进行中 | 待办(or x/~/" ")」—— 空格形态是**契约明文承诺**的入参,但 `trim()` 把它变成空串,`statusOf` 返回 `null`,`relayRecall:108` 的 `if (statusFilter && ...)` 于是**完全不筛**。

**失效场景**:`relay_recall { status: " " }` 返回全部任务(含已完成),而不是只返回待办;返回文案不含任何提示,调用方无从察觉。

---

### P1-11 · 去重先于过滤,被过滤掉的任务整条消失 【CONFIRMED】

**位置**:`src/engines/recall.mjs:104-115`。

```js
for (const e of entries) {
  if (seen.has(e.id)) continue;      // ← 先占位
  seen.add(e.id);
  const t = tasks.get(e.id) || null;
  if (statusFilter && (!t || t.status !== statusFilter)) continue;   // ← 后过滤
  if (modelFilter && ...) continue;
  if (query) { ... if (!hay.includes(query.toLowerCase())) continue; }
```

`seen.add` 在三个过滤条件**之前**执行。LOG.md 同一任务有多条条目时,最新一条先占位;若最新那条不匹配 query/model/status,更早的**匹配**条目被 `seen.has` 跳过。

**失效场景**:T005 最新条目摘要「重构登录」、旧条目摘要「支付回调签名验证」;`relay_recall { query:"支付" }` 返回 0 条,尽管 T005 的历史里确实有「支付」。命中计数 `total` 也随之少算。

---

### P1-12 · doctor 的 D5 用错误的根解析注册表路径,绝对路径分支是死代码 【CONFIRMED】

**位置**:`src/engines/doctor.mjs:108-110`。

注册表记录里存的是**控制根相对路径**(本仓库 `.relay/worktrees.json` 实际值:`"path": ".relay/worktrees/T014"`),因此必须相对 **controlRoot** 解析;`resolve(root, w.path)` 只有在 `root` 恰为 controlRoot 时才对。同时 `if (w && typeof w.absPath === 'string')` 这一分支永远不执行 —— 本仓库 `.relay/worktrees.json` 中 `absPath` 出现 **0 次**,记录字段实为 `task, createdAt, path, branch, baseSha, owner, status, lastUsedAt, commitSha, controlSha, controlCommitted`。

**失效场景**:在非控制根下运行 doctor → 所有已登记任务树都匹配不上 → D5 报「N 个 relay 任务树未登记」ERROR,并给出「在 controlRoot 重新 relay_claim 重建登记」这条**错误**的修复建议(注册表其实完好)。

---

### P1-13 · doctor 的 D4 写死 240 分钟 TTL,忽略 `relay_claim` 的 `ttl_minutes` 覆盖 【CONFIRMED】

**位置**:`src/engines/doctor.mjs:12`(`const CLAIM_TTL_MIN = 240;`)与 `:83`;`src/engines/session.mjs:748` 支持 `ttl_minutes` 覆盖:

```js
// session.mjs:748
const ttlMin = Number(args.ttl_minutes) > 0 ? Number(args.ttl_minutes) : CLAIM_TTL_MIN;
```

该值作为 `acquireFileLock` 的 `staleMs` 生效;而锁文件本身(`src/util.mjs:294` `serializeLock`)**不落 TTL**,因此 doctor 只能靠硬编码判断。

**失效场景**:以 `ttl_minutes: 600` 认领的任务,在第 241 分钟被 D4 判为「已过期」,并建议「relay_claim 同一 task 即可按 TTL 接管」—— 而真实的锁在 600 分钟内仍然有效,接管会失败,用户被引导到一个错误结论。doctor 的 D4 建议与其所建议的动作不自洽。

**修复方向**:把 TTL 写进锁文件(`serializeLock` 加 `ttlMinutes` 字段),doctor 从锁文件读真实 TTL;或至少在 D4 输出里说明「按默认 240 分钟判定」。

---

### P1-14 · R10 的存在性 ERROR 会锁死 session_end,而它给的修复指令正是被阻断的动作 【CONFIRMED】

**位置**:`src/engines/verify.mjs:366-369`(R10 存在性检查)与 `src/engines/session.mjs:1051`(出场绿闸调用 `runChecks(root,{full:true})`)。

```js
// verify.mjs:366
if (factIdx < 0) {
  return bad('R10', 'ERROR', `最新完成条目(${entry.time} ${entry.task})缺少机器写入的「事实(v1)」行`,
    '重跑 relay_session_end 由引擎补写(不要手写该行);若该条目确由旧版本引擎生成,把 manifest.facts.since 前移到该条目之后即可豁免');
}
```

**失效场景**:LOG.md 最新一条完成条目缺事实行(旧版本引擎写的、手写的、或该条目被手工裁剪过)且其时间 ≥ `facts.since`:

1. `relay_session_end` 在第 1051 行跑绿闸 → R10 ERROR → 出场被拒,**任何任务都无法完成**;
2. R10 给的修复指令是「**重跑 relay_session_end** 由引擎补写」—— 而 `relay_session_end` 就是被阻断的那个调用方;
3. 更关键:`grep -n "事实(v1)\|FACT_LINE" src/engines/session.mjs` **无任何命中** —— session_end 只在**新条目**里追加事实行(`formatFactLine` 来自 `facts.mjs`),**从不回填既有条目的缺失事实行**。

即:修复指令不可执行,唯一出路是手工编辑 LOG.md 或把 `facts.since` 前移。这与 P0-2 的「strict 模式下无法自愈」是同一类死锁。

**修复方向**:R10 的存在性 ERROR 改为 WARN(或在 `session_end` 内部豁免「本次即将写入的条目」);或让 `session_end` 在绿闸前识别「最新条目缺事实行」并自动补写。

---

### P1-15 · `relay_sync` 从不输出承诺的事实底账升级提示 【CONFIRMED】

**位置**:`src/engines/sync.mjs`(全文)。

`grep -c "facts" src/engines/sync.mjs` → **0**。该模块完全没有提及 facts,因此不可能输出任何事实底账相关的升级提示;它只打印 worktree 配置的升级提示。

而 `docs-design/CONTRACT.md:227` 承诺:「旧项目缺席即旧行为(不写事实行、R10 跳过),**relay_sync 输出升级提示但不改写 manifest(非破坏)**」。

**失效场景**:一个存量项目升级后跑 `relay_sync`,拿不到任何关于「事实底账未启用」的提示;R10 每次校验都静默 SKIP,项目看起来「全绿」,实际上本次 PR 的核心机制之一根本没有生效 —— 正是「机检只裁判结构与数字」这条红线担心的那种静默降级。

---

### P1-16 · R10 只检查「最新条目」而非「最新完成条目」,伪造的完成条目可以逃逸 【CONFIRMED】

**位置**:`src/engines/verify.mjs:352-360`。

```js
for (let i = 0; i < lines.length; i++) {
  if (LOG_TITLE_RE.test(lines[i])) { start = i; break; }   // ← 最新条目(LOG 顶部)
}
...
const m = lines[start].match(LOG_TITLE_RE);
const entry = { time: m[1], model: m[2], task: m[3] };
if (!isDoneTaskField(entry.task)) return pass('R10', `最新条目未声明完成(task=${entry.task}),无需事实对账`);
```

`start` 取的是**最新一条**条目(LOG 顶部),而不是**最新一条完成条目**。LOG 顶部完全可能是 `task=无`(任何不带 `done_task` 的出场都会写这种条目,维护会话尤其常见)。一旦最新条目不是完成条目,R10 **直接返回 PASS,一行都不查**。

**失效场景**:LOG.md 顶部是 `## … | task=无`(正常维护会话),其下一条是 `## … | task=T999 完成` —— 该条目若是旧版本引擎写的、或被人工手写、或被裁剪掉了事实行 —— R10 **一律不报**。

而契约 10.1 明写这条检查的目的是「**防手写伪造完成条目**」,`relay_rules` 也写着「最新**完成**条目必须含引擎写入的「事实(v1)」行」。实现取的却是「最新条目」。

**修复方向**:在 `start` 之后继续向后找**第一条完成条目**(跳过非完成条目),再对它做存在性与数字对账;或至少在最新条目非完成条目时继续向后扫描而不是 PASS。

---

### P1-17 · MCP 握手仍自报 version 1.0.0,而包已经是 1.4.0 【CONFIRMED】

**位置**:`src/index.mjs:11`。

```js
serverInfo: { name: 'relay-mcp', version: '1.0.0' },
```

本 PR 把 `package.json` 的 `version` 从 `1.0.0` 提到 `1.4.0` 并新增了 npm 分发面(`bin` / `files` / `engines`),但**没有**同步这个硬编码字面量。`scripts/install-mcp.mjs:243` 正是从握手结果里读版本:

```js
version: init.result?.serverInfo?.version || '',
...
logErr(`· 预检通过: ${result.serverName}@${result.version || '?'}，${result.tools.length} 个工具`);
```

**失效场景**:一个 1.4.0 的已发布包,`node scripts/install-mcp.mjs` 会打印「预检通过: relay-mcp@**1.0.0**,13 个工具」;任何按 `serverInfo.version` 做版本固定/判断的 MCP 客户端看到的是过期版本。`scripts/install-mcp.mjs:387` 还有第二处硬编码 `'1.0.0'`。

**修复方向**:从 `package.json` 读版本(`createRequire` 或 `readFileSync`),或至少在 CI 加一条「`serverInfo.version` == `package.json.version`」的断言。

---

### P2-22 · smoke-doctor 的「零写盘」断言只快照 `.relay/`,新加的 check 模式守卫没被测到 【CONFIRMED】

**位置**:`scripts/smoke-doctor.mjs:50`。

该文件唯一的零写盘断言是 `snapshot(path.join(tmp,'.relay')) === before` —— **只快照 `.relay/` 目录**。而本 PR 在 `src/engines/sync.mjs` 新增的两个 `mode === 'check'` 守卫,保护的恰恰是**仓库根目录**下的文件(AGENTS.md / CLAUDE.md / GEMINI.md 的创建与重写、`.relay-bak-<ts>` 备份)。

**失效场景**:把这两个守卫删掉,`relay_doctor` 会落进 onboarding 分支,在仓库根目录创建缺失的入口文件、或备份并重写无标记的 AGENTS.md —— 这些全部发生在 `.relay/` 之外,快照看不见,冒烟**依然全绿**,而 doctor 的「只读」铁律已经被破坏。

**修复方向**:零写盘断言应快照整个仓库树(至少 `tmp` 根下的一级条目 + 文件 mtime/内容),而不是只快照 `.relay/`。

---

### P2-23 · 简报的「生效配置」行对 worktree 硬编码「见 manifest」,不回显真实生效值 【CONFIRMED】

**位置**:`src/engines/session.mjs:627`。

```js
`- 生效配置: worktree=${briefCfg ? '见 manifest' : '?'} facts=${briefCfg.facts.enabled ? …} contextBudget=${briefCfg.contextBudget}`,
```

`readManifestConfig` 永远返回一个对象,所以 `: '?'` 分支不可达;而 `worktree=见 manifest` 是**一句硬编码**,既不是生效值也不是任何真实配置项 —— `readManifestConfig` 的返回值里根本没有 worktree 字段(worktree 由 `worktree.mjs` 单独解析)。

**失效场景**:manifest 写成 `{"worktree":{"enabled":"true"}}`(字符串 —— 项目自己文档化的「配置拼错静默失效」场景)时,worktree 实际是**关闭**的,而简报照旧打印 `worktree=见 manifest`;agent 据此以为任务 worktree 生效,实际 `relay_claim` 会静默退化成单根。这与该行存在的目的(「让配置错误当场可见」)正好相反。

**修复方向**:把 worktree 的解析结果(enabled / cacheDir / ttlHours)也纳入 `readManifestConfig` 并在简报里回显真实值。

---

### P2-16 · CONTRACT 规则表缺 R10 行,违反「三处一致」 【CONFIRMED】

**位置**:`docs-design/CONTRACT.md:185`。

规则表从第 184 行 `| R9 | LOG/TASKS 一致性 | …` 直接跳到第 185 行 `| R11 | 协议文件敏感内容 | …` —— **没有 R10 行**。

**违反的规约**:`CONTRIBUTING.md:20` —「**规则改动走修宪**:新增/修改检查器(R1-R9)必须同步 docs-design/CONTRACT.md 的规则表与 README,**三处一致才算完整**;」

本 PR 新增了两个检查器(`src/engines/verify.mjs:438-439` 的 `checkR10` / `checkR11`),但只同步了两处。PR 自己的 `CHANGELOG.md:26` 还宣称「规则表扩到 R1–R11;`relay_rules`、AGENTS.md 模板、README、CONTRACT 同步」—— 对 CONTRACT.md 的规则表而言这是**不实陈述**。

---

### P2-17 · "R1–R9" 在六个位置残留,却被投喂给每个 MCP 会话 【CONFIRMED】

**位置**:

| 文件:行 | 内容 |
|---|---|
| `src/contract.mjs:153` | `relay_verify` 的工具描述:`Run all repo checkers R1–R9 and return a | ID | 结果 | 详情 | table;` |
| `src/contract.mjs:319` | `In a managed worktree the gate checks controlRoot (R1–R9) and the` |
| `src/contract.mjs:468` | PROTOCOL_TEXT(作为 `relay://protocol` 投喂给每个会话):「controlRoot 跑全量 R1–R9(协议面)…」 |
| `START.md:9` | 「`./verify`(委托 relay 引擎机检 R1-R9)。」 |
| `templates/START.md:9` | 同上 —— **每个新建项目**都会继承这句话 |
| `docs-design/CONTRACT.md:30` | 「controlRoot 跑全量 R1–R9,executionRoot 跑代码向检查…」 |
| `SPEC.md:17` | 「AC3: …结构检查(R1-R9)+ 验收执行门(npm test)双绿才入库」 |

讽刺的是,同一个 PR 把 `src/contract.mjs:285` 的 `relay_rules` 描述改成了 `R-series rule table (R1–R11)`,把 `AGENTS.md:9` 改成了「R 系列规则」,却在同文件里留着 `relay_verify` 自己的描述写着 R1–R9。

**失效场景**:MCP 模型调用 `relay_verify` 看到的是「9 个检查器」;当返回表里出现 R10(缺事实行)或 R11(密钥闸)两行时,它会把这**已知 ID 认成未知规则**,不执行它们的「修复:」指令,转而去改代码。

---

### P2-18 · 入口文件的 executionRoot 跳过列表漏了 R10 【CONFIRMED】

**位置**:`templates/AGENTS.md.tpl:21` 与投影出的 `AGENTS.md:21`:
「executionRoot R1/R2/R3/R4/R8(**跳过 R7/R9/R11**)」

而 `src/engines/verify.mjs` 的 `runTaskTreeChecks` 实际只跑 `checkR1/checkR2/checkR3/checkR4/checkR8` —— **R10 也被跳过了**。`docs-design/CONTRACT.md:220` 也写明「校验 R10(仅 controlRoot,同 R7/R9 边界)」。

即:文档说跳 3 条,实际跳 4 条。新会话据此推断「任务树里会跑 R10」,而代码不会跑 —— 任务分支里的事实行永远不被对账。

---

### P2-19 · 移除 `private:true` 后没有任何替代的发布护栏 【CONFIRMED】

**位置**:`package.json:5`(删除 `"private": true`)。

原 `"private": true` 是 npm 的**机器级拒绝**(publish 直接被拒)。删除后:

- 无 `.npmrc` 的 `ignore-publish=true`(文件不存在);
- `.github/workflows/` 下无任何 publish 闸(grep 无命中);
- `scripts/smoke-pack.mjs:20` 反而断言 `pkg.private !== true` —— **断言护栏已被移除**。

现在唯一的约束是 README 里的一句散文。按项目自己的公理「写进规范但无法检查的规则等于没写」,这条发布约束已从「机检」退化为「散文」。

**修复方向**:加 `.npmrc` 的 `ignore-publish=true`,或加一条 CI 规则禁止从主干分支 publish。

---

### P2-20 · CHANGELOG 的 `[Unreleased]` 被压到已发布段之下 【CONFIRMED】

**位置**:`CHANGELOG.md:33`。本 PR 插入了 `[1.4.0]`(第 6 行)与 `[1.3.0]`(第 17 行)两段,把原本位于文件头的 `## [Unreleased]` 挤到了第 33 行。

违反本文件第 3 行自述的格式规则:「本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式;」—— 该格式要求 Unreleased 段置于顶部。

---

### P2-21 · 新增冒烟脚本恰好绕开了会暴露 P0-1/P0-2 的两条路径 【CONFIRMED】

**位置**:`scripts/smoke-content-guard.mjs:45`、`scripts/smoke-facts.mjs:36`。

| 脚本 | 认领方式 | 覆盖缺口 |
|---|---|---|
| `smoke-content-guard.mjs:45` | `cli('relay_claim', { task: 'T003', model: 'smoke-secret', **worktree: false** })` | 只测**单根**路径。managed 路径(代码提交先于密钥闸 → P0-1)完全未被覆盖 |
| `smoke-facts.mjs:36` | `cli('relay_claim', { task: 'T003', model: 'smoke-facts', **worktree: false** })`,摘要自述「只改协议文件」 | 既不覆盖 managed 的 `baseSha..HEAD` 口径,也不覆盖「新建未跟踪文件」与「多提交分支」 |

更关键的是 `smoke-facts.mjs:55` 的数字对账用例:

```js
writeFileSync(logPath, log.replace(/改动 (\d+) 文件/, (_, n) => `改动 ${Number(n) + 7} 文件`));
```

它**手工篡改**已写入的事实行,断言 R10 报 WARN/ERROR。这验证的是「R10 能发现**被手改的**事实行」,而不是「引擎**自己写出的**事实行是对的」—— 而后者正是 P0-2 的失效面。P0-2 的两个触发条件(未跟踪新文件、两提交分支)在整个测试套件里都没有对应用例。

**失效场景**:PR 自称「本机全绿:smoke-facts 18 断言」,但这套断言对 P0-1 与 P0-2 完全无感 —— 绿灯并不代表这两处正确。

**修复方向**:给 `smoke-content-guard` 增加一个 managed 用例(启用 worktree → 认领 → 在 executionRoot 改代码 → 出场带密钥摘要 → 断言 **git log 里没有密钥**);给 `smoke-facts` 增加两个用例(新建未跟踪文件、多提交分支 → 断言 `relay_verify` 的 R10 报「一致」而非 WARN/ERROR)。

---

### P3-21 ~ P3-30 · 清理与效率

| # | 位置 | 问题 |
|---|---|---|
| 21 | `src/engines/recall.mjs:87` | `chars: e.block.join('\n').length` 计算后**从未被读取**(全仓库无消费者),却为每个 LOG 条目做一次全文拷贝 |
| 22 | `src/engines/session.mjs:20` | `DEFAULT_CONTEXT_BUDGET` 被 import 但文件内**无任何使用**(默认值实际由 `readManifestConfig` 注入) |
| 23 | `src/engines/session.mjs:520`、`src/engines/recall.mjs:169` | `slice(0, n)` 按 **UTF-16 码元**截断,可能把代理对劈成半个高代理(渲染为 U+FFFD);同一文件 `session.mjs:1388` 却已用 `Array.from(...).slice(0,80)` 的码点安全写法 |
| 24 | `src/engines/recall.mjs:66` | `parseTasks` 的 `map.set` 后写覆盖前写:**同号任务取最后一条**,而 TASKS.md 的完成区在上、待办区在下,重复号时状态会取到「待办」 |
| 25 | `src/util.mjs:65` | `isGitRepo` 用**阻塞式 `execFileSync`**,却在 `deriveFacts`(`facts.mjs:48`)、`recomputeCommitFileCount`(`facts.mjs:130`)等 async 路径里被调用 → 在长驻 MCP server 里阻塞整个事件循环 |
| 26 | `src/engines/facts.mjs:135-139` | R10 每次校验起 3 个 git 进程(`isGitRepo` + `git log` + `git diff`);一条 `git show --pretty=%s --name-only HEAD` 可同时拿到 subject 与文件列表 |
| 27 | `src/engines/verify.mjs` | 一次 `runChecks` 把 LOG.md **读 4 遍**(R7/R9/R10/R11)、TASKS.md 读 2 遍,每次都重新 split 成整行数组 |
| 28 | `src/engines/facts.mjs:14-15` | `diffStat` 连跑 `git diff --name-only` 与 `git diff --numstat`;`--numstat` 的行本身就带路径,一次即可同时得到文件数与 ±数 |
| 29 | `src/engines/{verify,recall,doctor,session}.mjs` | `readText` 助手在四个引擎里各抄一份(字节级相同);`scripts/smoke-*.mjs` 共 11 个文件各抄一份 ~20 行 harness(仓库原有 5 份,本 PR 又加 6 份) |
| 30 | `scripts/smoke-doctor.mjs:84` | 「未登记 worktree」fixture 把 worktree 建在**临时目录的同级目录**(`path.join(tmp,'..',…)`,即系统 temp 根下),`git worktree remove` + `git branch -D` 写在 try 体内而 finally 只 `rmSync(tmp)` —— 中途抛异常就在系统 temp 里遗留一个完整 checkout 与 `relay/T999` 分支;名字按 PID 命名,不复用时会与残留冲突 |

---

### P3-31 · R10 只对账一个数字,其余七个断言无人校验 【PLAUSIBLE·设计层】

**位置**:`src/engines/verify.mjs`(`checkR10` 只比较 `recomputed !== parsed.files`)。

事实行声称了 8 个事实:`改动 N 文件`、`+x/-y`、`验收: 通过`、`verify: PASS a·WARN b·ERROR c`、`分支`、`sha`、`耗时`。其中**只有文件数**被对账。`验收: 通过` 与 `verify: PASS 13·WARN 1·ERROR 0` 可以被手改成任意值而 R10 依然通过(只要文件数对得上)。

PR 自己的红线 1 说「机检只裁判结构与数字,不裁判叙述真伪」—— 但这些**是数字**,且现在看起来像被机检守着。修复方向:要么把可对账的数字全部对账,要么把事实行拆成「机检段」与「叙述段」并显式标注权威性。

---

### P3-32 · 摘要上限只加在消费端,LOG.md 仍无界增长 【PLAUSIBLE·设计层】

**位置**:`src/engines/session.mjs:520`(`clip` 只作用于 `relay_session_start` 的简报输出)与 `:1347`(写入 LOG.md 的是**完整** summary)。

200 字符上限只挡住了简报。写进 LOG.md 的摘要仍是模型原文,每场会话累积;而 `relay_recall`/`relay_get` 每次调用都要整读并重新 split 整个 LOG.md(`recall.mjs:82-84`),`limit` 只限制**输出行数**、不限制**读取字节数**。同时负结果/留给下一个仍是裸 `slice(0, 120)` 且**无截断标记**(README 却宣称「超长条目只截断展示并标注"全文见 LOG.md"」)。

修复方向:上限加在生产者侧(session_end 写入时),让所有消费方自动继承边界。

---

### P3-33 · 模板 LOG.md 的示例条目被改成非完成态 【PLAUSIBLE】

**位置**:`templates/LOG.md:3`。

原示例为 `## {{TODAY}} 14:05 | model=claude | task=T002 完成`,本 PR 改为 `task=无`。而 `templates/TASKS.md` 仍保留 `- [x] T002 用户表迁移`,两者不再配对:新建项目的 TASKS 声称 T002 已完成,LOG 里却没有对应条目(R7/R9/R10 都解析该形状),且 `relay_recall` 会因 `buildModel` 过滤无 T 号条目而索引不到它。同时模板失去了唯一一处「T### 完成」条目的示范。

---

## 5. 复现脚本

本次审计的复现脚本置于 `/tmp/pr6-audit/`(非仓库内,不污染工作树):

| 脚本 | 验证的缺陷 |
|---|---|
| `managed-leak-test.mjs` / `two-bugs-test.mjs` | P0-1 managed 密钥泄漏 |
| `two-commit-test.mjs` | P0-2 两提交分支口径不一致 |
| `e2e-r10-test.mjs` | P0-2 单根未跟踪文件端到端误判 |
| `range-test.mjs` | P0-2 在 6 条真实分支上的口径核对(当前恰好一致) |
| `verify-scan.mjs` | P0-3 密钥规则漏扫矩阵 |
| `recall-root-test.mjs` | P0-4 worktree 内检索失明 |
| `d3-date-test.mjs` | P1-8 日期漂移误报 |
| `claim-bypass-test.mjs` | P1-6 `relay_claim` 写盘绕过密钥闸 |
| `halfwrite-test.mjs` / `halfwrite-test2.mjs` | P1-5 半写状态**复现未触发**(绿闸 R11 先行拦截)→ 该条降级 |

全部在临时目录内构造仓库,运行后清理;未修改被审计仓库的任何文件。

---

## 6. 测试执行结果

> **关于「pytest 用 xdist 模式」**:本仓库是**纯 Node.js 项目**(`type: module`,ESM `.mjs`,零运行时依赖,Node ≥ 18)—— `find . -name "*.py"` 无结果,无 `pytest.ini` / `pyproject.toml` / `setup.cfg` / `conftest.py`,因此**没有 pytest 可用,也没有 xdist 可加**。等价诉求(缩短测试套件墙钟)以 Node 原生并行方式落实:

| 方式 | 命令 | 墙钟 | 结果 |
|---|---|---|---|
| 顺序 | `npm test`(11 个冒烟脚本 `&&` 串联) | **32.34 s** | 全部 exit 0 |
| 并行 | 11 个 `node scripts/smoke-*.mjs` 并发 | **17.81 s** | 全部 exit 0 |
| 加速比 | — | **1.82×** | — |

并行运行各套件退出码:

```
smoke:0  smoke-patches:0  smoke-worktrees:0  smoke-compat:0  smoke-install-mcp:0
smoke-content-guard:0  smoke-facts:0  smoke-brief:0  smoke-doctor:0  smoke-recall:0  smoke-pack:0
```

建议(若要固化):把 `package.json` 的 `test` 脚本改为 `node scripts/run-all.mjs`(自建并发运行器,失败时聚合全部退出码),而不是 `&&` 串联;`node --test` 的内置并发也可作为备选。

**审计本身也受限于此**:所有验证脚本均为 Node 脚本,跑在真实引擎函数与真实 CLI 上,而非 mock。

---

## 7. 建议修复顺序

| 序 | 条目 | 理由 |
|---|---|---|
| 1 | **P0-1** managed 密钥泄漏 | 已造成不可逆的 git 历史污染;修复前不应再有任何 managed 出场 |
| 2 | **P0-3** 密钥规则补全 | 同上,漏的是最常见格式 |
| 3 | **P0-2** 事实行口径统一 | 否则每次新增文件的任务都会产生假 WARN,开 strict 后直接锁死绿闸 |
| 4 | **P1-6 + P1-5** 密钥闸下沉到 `writeProtocolFile` 并前置 | 一并解决半写状态与两条绕过路径 |
| 5 | **P0-4** `recall`/`doctor` 解析控制根 | 决定这两个新工具在默认(worktree)模式下是否可用 |
| 6 | **P1-14 + P1-16** R10 不再锁死出场 / 改为查最新完成条目 | 当前无自愈出路,存量项目一撞就卡死;且伪造的完成条目可以逃逸 |
| 7 | **P1-7** 事实行遵守 `facts.enabled` | 契约一致性 |
| 8 | **P1-15** `relay_sync` 输出事实底账升级提示 | 避免「机制看着在、其实没跑」的静默降级 |
| 9 | **P1-17** `serverInfo.version` 跟 `package.json` 对齐 | npm 分发面一旦发布就对外可见 |
| 10 | **P1-8** D3 归一化日期 | 每天误报一次,且给的修复建议会污染仓库 |
| 11 | **P1-9 / P1-10 / P1-11** 解析器统一、过滤器修正 | 检索工具的可用性 |
| 12 | **P2-16 ~ P2-23** 契约、规约与测试覆盖同步 | CONTRIBUTING「三处一致」是本仓库的宪法条款;P2-21 是 P0-1/P0-2 的回归防线,P2-22 是 doctor 只读铁律的回归防线 |
| 13 | **P3-21 ~ P3-33** 清理与效率 | 可择机处理 |

---

## 8. 审计边界与未覆盖项(诚实声明)

- **十个角度全部回传**:A/B/C/D/E/Reuse/Simplification/Efficiency/Altitude/Conventions;角度 C 的产出新增两条 P1(R10 存在性 ERROR 死锁、`relay_sync` 缺失升级提示),已并入 §4。
- **一条候选被我自己的复现推翻**:初稿曾把「LOG 密钥闸在 TASKS 写入之后 → 半写状态」记为 CONFIRMED;构造「历史 LOG 含密钥 + 本次摘要干净」的会话后**未能触发** —— 绿闸阶段的 R11 先一步拦截,TASKS.md 未被写。逐条核对 `modelText` 覆盖范围后确认该闸当前不可达,已降级为 P1-5「潜在顺序缺陷」并在 §4 记录了完整的未触发证据。**这一条是本报告唯一的降级项,其余条目均未因复现而撤回。**
- **未审计**:运行时(MCP 传输层、stdio 行为)、`src/rpc.mjs` 的并发模型、CI 工作流的实际执行结果(只静态检查了 workflow 内容)。
- **未验证的真实触发**:P1-13 已在本轮补验(注册表记录确无 `absPath` 字段、`ttl_minutes` 覆盖确实存在),其余标为 PLAUSIBLE 的 P3-30 / P3-31 / P3-32 为静态判定,给出的是「什么会确认它」。
- **未修改任何被审计文件**:全部复现都在临时目录内进行,工作树保持干净(仅新增本报告文件)。
- **本报告本身未提交**:`docs/04-test/04-audit-pr6-v1.0.md` 是新增未跟踪文件,是否入库由人决定(按项目规约,文档改动应走 `[docs]` 前缀的独立提交)。
- **本报告未改动任何协议状态**:TASKS.md / LOG.md / SPEC.md / DECISIONS.md 均未触碰,`relay_verify --full` 在本报告落盘后仍为 PASS 9 · WARN 1(R6 既有口径)· ERROR 0 · SKIP 1。

---

## 9. 一句话结论

本 PR 的机制设计(零持久索引、只读诊断、字段上限而非级联裁剪、引擎写事实行)方向正确且有想法,但**三条「硬红线」里有两条在实现层被违反**:密钥闸没有真正先于写盘(managed 模式甚至先把密钥写进了提交消息),机检只裁判结构与数字的原则在事实行上只落实了八分之一。加上事实底账自身的 git 口径与校验侧不一致、检索与诊断工具在默认 worktree 模式下读错了根,**建议先修 P0-1 / P0-2 / P0-3 / P0-4 四项再考虑合并**。
