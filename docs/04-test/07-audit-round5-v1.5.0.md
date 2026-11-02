---
title: 第五轮独立复验审计报告 — PR #8 后的裁判残留与写盘面(P0×3 / P1×2 / P2×6)
version: 1.0
created: 2026-11-02
status: 现行
---

# 第五轮独立复验审计报告

> 审计对象:`main` 在 PR #8 合并后的裁判面与写盘面(T022–T026、T001 `relay_archive_log`、T002 内容 CAS 均已落地)
> 本报告是**审计产物**,不是协议文件;不改 TASKS/LOG/SPEC,不参与 R 系列的机检结论。

---

## 1. 审计元数据

| 项 | 值 |
|---|---|
| 仓库 | `/Users/kent/Desktop/projects/relay-mcp` |
| 基线 | `main` @ `149351e`(PR #8 已合并;T011 工作区含本轮修复) |
| 审计范围 | 写盘面(init/onboard/archive/出场顺序)+ 裁判面(R10/R11/R12)+ 幂等与恢复面 |
| 审计日期 | 2026-11-02 |
| 运行环境 | Node v26.12.1,macOS;临时仓库构造,用后清理 |
| 审计强度 | 两个独立审计角度(写盘面 / 裁判面)并行 + 主审逐条复现;每条 P0/P1 均由本机脚本证实,修复后 1:1 收编为回归断言 |

**方法**:只读审计,不改被审计代码。所有复现在 `mkdtemp` 临时仓库内构造;复现脚本留在 `/tmp/relay-audit5/`(不进入仓库),证据已转写为 `scripts/smoke-security.mjs` 与 `scripts/smoke-archive-log.mjs` 的可执行断言。

---

## 2. 结论摘要

**复验前判定:不可发布。** 3 条 P0 可在正常使用路径上把文件写到仓库之外、把伪造内容写进 git 历史、把不可逆的归档搬反方向;2 条 P1 中一条能用归档工具洗绿 R7(停机判官),另一条会让出场留下半写状态。

**修复后判定:通过。** 11 项发现全部修复,每项都有 1:1 可执行回归;`npm test` 18 套 / 677 断言全绿,`relay_verify --full` PASS 11 · WARN 0 · ERROR 0 · SKIP 1。

| 等级 | 条数 | 摘要 |
|---|---|---|
| P0 | 3 | ①init/onboard/archive 符号链接写穿 ②项目名注入/密钥随首个提交进 git 历史 ③归档搬移方向反了(live 只剩最旧) |
| P1 | 2 | ①归档可洗绿 R7 ②出场半写(TASKS 已写、LOG 被密钥闸拦) |
| P2 | 6 | next.acceptance 预检 / R11 扫描面 / R12 指针可验证 / R10 反查劫持 / 幂等与备份 / bare 仓库 |

---

## 3. 逐条发现与修复对证

### P0-1 init / onboard / archive 符号链接写穿

**复现**(三条独立路径,均在本机证实):
1. `mkdir outside && ln -s outside docs` 后 `relay_init` → AGENTS/SPEC/START/docs 骨架全部写进仓库外目录,`git status` 干净,首次提交只包含少量文件;
2. `ln -s outside .relay` 后 `relay_onboard` → `manifest.json` 落在仓库外,而仓库内看起来没有 manifest;
3. `docs` 指向仓库外后 `relay_archive_log confirm:true` → 归档文件写在仓库外,但 LOG.md 指针仍写着仓库内相对路径 = 指针与内容分裂。

**影响**:协议文件的位置不再由仓库决定;审计者看到的路径与实际内容不是同一个东西;CI 中可把敏感内容写到工作区之外。

**修复**:`assertSafeWriteLayout(root, relPaths, label)` —— root 本身与「将要写入的每个路径」的既有目录组件都不得是符号链接(ENOENT 视为可创建);init/onboard 在写第一个文件前统一过闸;archive 写归档文件前过 `checkProtocolFilesSafe` + 只对父目录做 `assertNoSymlinkComponents`(文件叶子交给原子写)。拒绝文案明确「会把文件写到仓库之外」。

**回归**:`smoke-security.mjs` P0-1 段 4 断言(init 拒绝且仓库外目录零写入;onboard 拒绝且仓库外无 manifest);`smoke-archive-log.mjs` 符号链接段 2 断言(归档拒绝且仓库外目录零写入)。

### P0-2 项目名注入 / 密钥随首个提交进入 git 历史

**复现**:`relay_init {name: "audit\n- [x] T999 fake\nAKIA…"}` → 名称原样写进 AGENTS/SPEC/START/docs 并随首次提交进入 git 历史(伪造任务行 + 密钥);`name="P-{{TODAY}}"` → 模板渲染时被二阶展开成 `P-2026-11-02`(占位符注入)。

**影响**:密钥进入 git 历史不可撤回;伪造任务行会污染 TASKS 解析面;二阶展开让项目名之外的模板变量可被间接控制。

**修复**:`sanitizeProjectName`(控制字符 → 空格、丢弃 `{}`、折叠空白、80 字符上限,空则回落 basename)+ `scanSecrets` fail-closed;模板渲染顺序固定为 `{{TODAY}}` / `__RELAY_HOME__` 在前、`{{PROJECT_NAME}}` 最后;渲染后的内容再过 `scanSecrets`(变量夹带密钥 → 整次 init/onboard 拒绝,不写任何文件)。onboard 用目录 basename,同样净化 + 密钥闸。

**回归**:`smoke-security.mjs` P0-2 段 4 断言(密钥名拒绝且零写入;占位符不被展开;花括号被净化)。

### P0-3 归档搬移方向反了(搬走最新、留下最旧)

**复现**:10 条维护条目,`relay_archive_log {confirm:true, keep:3}` → 修复前 live 变成 m1/m2/m3(最旧三条),归档文件含 m10…m4(最新七条);LOG 指针语义(live = 最近历史)与 R7/R10 的窗口判定全部反向。

**影响**:live 只剩最旧条目 → R7「最近 3 条任务会话」看错窗口;最新完成条目可能被搬走 → R10 失去事实对账锚点;归档只增不改,搬错即永久错。

**修复**:LOG 是「最新在上」 → `kept = entries.slice(0, keep)`、`moved = entries.slice(keep)`;边界硬约束从「切到最新完成条目之后」改为「`newestDoneIdx >= keep` → 返回 isError 拒绝执行」并给增大 keep 的可执行指令;keep 下限 3。

**回归**:`smoke-archive-log.mjs` 方向段 4 断言(live 保留最新 m10/m9/m8;归档只含 m7…m1)+ confirm 段条目守恒(live + 归档 = 原条目数)。

### P1-1 归档可洗绿 R7(把发散证据搬进归档)

**复现**:构造顶部 7 条未完成任务会话 + 底部 3 条完成的 LOG(此时 `relay_verify` R7 ERROR);运行 `relay_archive_log {keep:3}` → 修复前会把顶部发散证据搬进归档,使 R7 转 PASS = **用归档工具洗绿停机判官**。

**修复**:同 P0-3 边界约束 —— 最新完成条目必须留在 live,`keep` 不得切到它之后;配合方向修正,发散证据无法被搬走。

**回归**:`smoke-archive-log.mjs` R7 段 3 断言(归档前 R7 ERROR;尝试 keep=3 → 拒绝执行;尝试后 R7 仍 ERROR)。

### P1-2 出场半写(TASKS 已写、LOG 被密钥闸拦)

**复现**:既有 LOG 尾行带 `AKIA… relay:secret-ok`(R11 探测器按设计豁免,但一条新条目要写入的内容会经过**写盘闸**,它不接受豁免)→ 修复前 session_end 先写 TASKS,再在 LOG 写入前被密钥闸拦下,留下 TASKS 已改、LOG 未写的半写状态,且输出「本次未写入任何文件」(不实)。

**影响**:控制面两文件不一致,下一次 R9/R10 报错,只能人工回滚;而 human 需要先相信「未写入」的提示。

**修复**:LOG 条目构造、密钥闸、TASKS/LOG 双文件内容 CAS 预检全部前移到**任何写盘之前**;全部通过后才写 TASKS、再写 LOG;任一步失败时两文件均未变。

**回归**:`smoke-security.mjs` 半写段 2 断言(session_end isError;TASKS 内容与出场前逐字节一致)。

### P2-1 `next.acceptance` 的 `test:` 路径未在写入前校验

**发现**:`test:-rf /tmp/x`、绝对路径、含 `..` 的路径会被先写进 TASKS 任务队列,等下一棒出场执行验收时才被拒 —— 危险值被持久化。

**修复**:写入 TASKS 之前按出场同款规则校验(非空、不以 `-` 开头、不含 `..`、非绝对路径),非法直接 isError 且不落盘。

**回归**:`smoke-security.mjs` 2 断言(`test:-rf /tmp/x` 写入前拒绝;拒绝时 TASKS 未变)。

### P2-2 R11 扫描面只覆盖 TASKS/LOG

**发现**:入口/协议文件(AGENTS/CLAUDE/GEMINI/START/SPEC/DECISIONS)与手写归档 md 不在扫描面;快照存在时 `snap && texts[f]` 会跳过未预载文件。

**修复**:协议面 = 8 个文件 + `docs/archive/**/*.md`(不只 `LOG-*.md`);快照只在 `texts[f] !== undefined` 时复用,其余必须读盘;命中 → ERROR。

**回归**:`smoke-security.mjs` 2 断言(AGENTS.md 含密钥 → R11 ERROR;归档 notes.md 含密钥 → R11 ERROR)。

### P2-3 R12 指针可经符号链接指向仓库外 / 悬空指针静默 PASS

**发现**:指针目标只要 stat 为文件且非空即被「承认」,即使它经符号链接指向仓库外;悬空指针只在 PASS 详情里附一句,不影响判定 = 静默消音。

**修复**:指针目标需同时满足「命中 `docs/archive/` 正则、stat 为文件且非空、父目录组件非符号链接、realpath 仍在仓库内」;失效指针 → **WARN 且文案说明未被承认**,不再静默 PASS。

**回归**:`smoke-security.mjs` 3 断言(绝对路径/越界指针 → WARN;文案含「未被承认」;悬空指针 → WARN)。

### P2-4 R10 单根反查完成提交可被「消息含 T### 完成」劫持

**发现**:`git log -1 --grep "T### 完成"` 只取第一条命中;任何无关提交只要消息里带同名 token,就能让事实行对账指向错误提交(仍可能 PASS)。

**修复**:取最多 10 个候选,逐个 `git diff --numstat` 计算文件数,选与事实行机检段声明一致的那个;消息 token 只是索引,不是证据。

**回归**:`smoke-security.mjs` 1 断言(追加一个消息含 T003 完成、文件数不同的无关提交后,R10 仍定位真正完成提交并 PASS)。

### P2-5 幂等与备份互覆盖

**发现**:①重复 session_end / 本次无改动时,`git add` 后无可提交内容 → 降级报「git commit 失败」(假红);②`relay_init --force` 同一秒内连续两次 → 备份文件名撞名,`rename` 覆盖前一份备份;③`relay_onboard` 内容未变仍刷新 `onboardedAt` → 重写 manifest、新建备份、产生无意义提交。

**修复**:无变更时提交段输出「无变更可提交(幂等跳过)」;`backupFile` 加序号(`-2`、`-3`…);onboard 生成内容与既有 manifest 一致时不重写、不备份、保持 `onboardedAt`。

**回归**:`smoke-security.mjs` 2 断言(两次 force 各留独立备份;第二次 session_end 成功且不报 commit 失败;LOG 照常增长)+ `smoke-compat.mjs` 2 断言(onboardedAt 保持;内容未变不新建备份)。

### P2-6 bare 仓库 init 产生嵌套 .git

**发现**:对 `git init --bare` 目录执行 relay_init 会建出嵌套 `.git` 与整棵文件却无法正常提交(无工作区)。

**修复**:初始化前 `git rev-parse --is-bare-repository`,为 true 直接拒绝并给 `git clone <bare> <dir>` 修复指令。

**回归**:`smoke-security.mjs` 2 断言(bare 仓库 → init 拒绝并给修复指令;bare 仓库未写入骨架)。

---

## 4. 修复后复核(独立复跑)

```
npm test   # 18 套 / 677 断言,全绿
node src/cli.mjs relay_verify --root . --json '{"full":true}'   # PASS 11 · WARN 0 · ERROR 0 · SKIP 1
./verify   # fast:PASS 9 · WARN 0 · ERROR 0 · SKIP 3
```

- **套件计数**:99 / 43 / 142 / 93 / 15 / 13 / 44 / 10 / 17 / 24 / 30 / 31 / 28 / 18 / 6 / 14 / 25 / 25 = 677;其中 `smoke-archive-log` 18→25、新增 `smoke-security` 25。
- **无退化**:与修复前基线逐套对比,除上述两套外其余 16 套断言数不变且全绿。
- **三处一致**:CONTRACT 规则表 / `relay_rules` / AGENTS 模板的 R11/R12 文案同步,`relay_sync` 重投影入口文件;`smoke-r12-boundary` 三处一致断言仍绿。
- **R12 现状**:活跃区 105 行 / 完成条目 9 条,PASS(归档在 T001 已执行)。

---

## 5. 残留与已知边界(诚实记录)

1. **TOCTOU**:布局闸只拦「已存在的符号链接组件」;检查与写入之间被换成链接的竞态不在本层解决。单机协作模型下不做 `O_NOFOLLOW` 级重构,记录为已知边界。
2. **项目名回落**:净化后为空时回落 `basename(root)`,不报错(可用性优先);`basename` 在极端目录名(纯控制字符)下可能仍为空,此时模板写入会得到空项目名 —— 不影响 R 系列,但会体现在文档首行。
3. **R10 候选匹配**以「diff 文件数」为键:若两个提交消息都含同一 `T### 完成` 且文件数恰好相同,会选历史更新的那一条。这属于提交历史本身异常,机检不能判定作者意图;仍不会让 R10 假 PASS(文件数须一致)。
4. **归档仍是人工确认动作**(默认 dry-run),R12 只报警 —— 维持 T001 的钢人论证结论,不在本轮改为自动。

---

## 6. 结论

三条 P0 与两条 P1 均为可利用缺陷,已全部修复;六项 P2 全部处置。每项发现都有可执行回归断言,修复后全套 677 断言与全量 R 系列复核通过。**T011 验收通过,无遗留项。**
