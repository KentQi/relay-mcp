# relay-mcp 接口契约

> 注:本文档是开源前并行开发的内部 memo("W1-W4"为当时的专家分工编号),保留作为设计记录;绝对路径已脱敏为占位符。

接力棒 MCP:让任意模型(Claude/Codex/Gemini/Cursor/ZCode…)在任意项目上接力开发。
零依赖纯 Node ESM(仅用 node: 内置模块),**无构建步骤**,入口 `node src/index.mjs`。

- 项目根:`<relay-mcp 安装目录>`
- Node >= 18,所有源码 `.mjs`,严格用 `import`/`export`
- 每个文件写完必须 `node --check <file>` 通过
- 模板在**运行时**从 `templates/` 读取(用 `templatesDir()` 解析),绝不硬编码模板内容

## 2026-10-29 生命周期补充契约

以下为现行增量,覆盖本文历史 memo 中的对应字段:

- 第 10 个工具 `relay_worktree_cleanup {root, confirm:boolean?, ttl_hours:number?}`:默认 dry-run;仅清理已登记、过期、非活跃、干净、未 locked、realpath 位于受管缓存且分支仍存在的 worktree。删除只走非强制 `git worktree remove`,分支保留;错误逐项报告。
- `relay_claim` 新增 `worktree:boolean?`,单次覆盖 `manifest.worktree.enabled`;新 init 默认 true,既有 manifest 缺省 false。返回 controlRoot、executionRoot、`relay/T###` 分支和真实 baseSha。
- 引擎新增 `src/engines/worktree.mjs`,管理双根解析、原子注册表、任务目录复用和安全清理;新 init/onboard 的 `.gitignore` 基线包含注册表与缓存,旧项目由 `relay_sync`(以及 claim 启用 worktree 时)幂等补齐。controlRoot 唯一维护 TASKS/LOG、认领锁和注册表,executionRoot 负责代码、验收和任务分支提交。
- 任务分支代码提交成功才更新 controlRoot 的完成状态;提交失败不改 TASKS/LOG、保留认领锁。完成不等于合并,不自动 merge/rebase/push 或删除分支。
- R1 无条件要求 AGENTS.md 存在且首行带 relay 标记;`entryFiles: []` 不再豁免,其他适配入口仍按配置生成。
- 认领锁和仓库锁含唯一 token,释放需匹配 owner;TTL 接管后旧句柄不得删除新锁。session_end 仅允许原持有者完成 `[~]` 任务;锁丢失但 TASKS 活跃时按 TASKS 时间戳判定同一 TTL,时间戳无效则拒绝自动接管。
- worktree 生命周期与既有两套冒烟统一由 `npm test` 执行,CI 三版本矩阵继续使用同一入口。

## 2026-10-29 升级兼容与双提交补充契约(Fix3)

以下为修复轮补充的现行语义,覆盖上文同名字段的早期表述:

- **出场双提交**:绿闸(verify 全量 + 验收执行门)通过后,executionRoot 提交任务分支代码(`relay/T###`,SHA₁);成功后 controlRoot **只** `git add -- TASKS.md LOG.md` 并提交(SHA₂,提交信息含 `T### 完成`)。输出两个 SHA;代码提交或控制面提交任一失败 → isError、TASKS/LOG 不改完成状态、保留认领锁,修复后重跑补交。`autoCommit:false` 明确"控制面未提交"。executionRoot 内出现 TASKS/LOG 改动时拒绝/排除,协议文件只由 controlRoot 写。
- **双根 verify / 成对证据**:受管 worktree 中 controlRoot 跑全量 R1–R9,executionRoot 跑代码向检查(R1/R2/R3/R4/R8;跳过 R7/R9 以免读任务分支里的旧协议副本);两侧 ERROR 合并阻断。managed 完成额外校验四项成对证据:任务分支代码提交、controlRoot 完成提交(消息含 `T### 完成`)、controlRoot 的 TASKS/LOG 已提交干净、LOG 记录 branch+代码 SHA;任一缺失 → isError、不落完成状态、可重跑补交。R5/R6 仍按 controlRoot 历史计算(任务分支提交不进入其窗口),跨分支评估留待后续。
- **根错配 fail-closed(严格)**:任务在 registry 中仍有未完成记录时,从 controlRoot 完成出场**一律 isError**「根错配」并提示在 executionRoot 出场;不再有"干净空树可单根完成"的兼容例外。注册表缺失/损坏/记录丢失时,用 `git worktree list` 反查 `relay/<task>` 是否仍被某 worktree checkout,并检查受管缓存路径 `.relay/worktrees/<task>` / 残留记录路径是否存在——命中同样拒绝(给出重建登记或 executionRoot 出场的修复指令);分支单独存在不视为痕迹。managed 出场 HEAD==baseSha 且无改动 → 拒绝伪 SHA。未登记 linked worktree 的完成出场 fail-closed,维护出场仅告警。
- **未合并分支可见性与人工合并**:任务分支验收通过 ≠ 已合并;relay 不自动 merge/rebase/push、不删分支。claim/session_start/cleanup 输出未合并 `relay/T###` 清单;人工流程 `git log <控制面分支>..relay/T###` → `git merge --no-ff relay/T###` → 可选 `git branch -d`。
- **清理保护(ignored)**:清理前用 `git status --porcelain --ignored=matching -uall` 检查;含未跟踪或 ignored 本地内容(`.env`、`node_modules`、构建产物)的 worktree 默认保留并给出理由,不自动删除;删除只走非强制 `git worktree remove`,分支保留。
- **executionRoot 依赖隔离**:任务 worktree 是独立 checkout,`node_modules`/`.env` 不共享;R8 与测试前需在 executionRoot 内单独安装依赖,claim/session_start 输出包含该提示。
- **旧项目升级路径**:先 `relay_sync`(重投影入口 + 幂等补 `.gitignore` 运行时基线 + 无标记 AGENTS.md 的可执行迁移指引);`relay_onboard` 以既有 manifest 为基合并,只协调 version/projectName/entryFiles/allowedTopLevel/docsPhases/onboardedAt/relayHome,保留 worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover 等自定义配置并在报告中列出;claim 启用 worktree 时同样幂等补 .gitignore 基线。`relay_restructure` 提交前也补一次基线。
- **AGENTS.md 迁移**:R1 无条件要求 AGENTS.md 存在且首行带 `<!-- relay:generated`。缺失 → `relay_sync` 重建;已存在无标记 → `relay_onboard`(备份 + 原正文包进 user-rules)、manifest `entryFilesTakeover:true` 后 `relay_sync`、或手工加标记;verify/sync 输出给出上述可执行选项,不再让修复指令空转。
- **worktree 配置真值表**:`enabled` 只认 JSON 布尔 `true`(字符串 `"true"`/数字 1 静默按 false);`cacheDir` 只允许 controlRoot 内相对路径(绝对路径、`..`、盘符、控制字符、`.git` 前缀非法,在任何目录创建之前校验);`ttlHours` 非有限数/负数回退 24;`autoCleanup` 仅显式布尔 false 关闭;未知/拼错字段静默忽略;单次 `worktree:true/false` 覆盖配置。无可用 HEAD/git 时 claim 降级为单根并 WARN,不硬失败。
- **registry 恢复**:`.relay/worktrees.json` 损坏 → 完成出场/claim fail-closed,提示备份或删除该运行时注册表(不猜测受管状态);注册表缺失且目录是 linked worktree → 完成出场拒绝,可回到 controlRoot 重新 `relay_claim {worktree:true}` 重建登记;cleanup 对未登记目录只报告不删,注册表损坏时输出恢复指引。
- **锁心跳与崩溃恢复(两把锁语义不同)**:仓库写锁 `.relay/relay.lock` 持锁期间约 20s 心跳续租 + 写前 fencing 校验,长 cleanup/出场不会被 120s stale 规则误判,写入前发现被接管则拒绝;任务认领锁 `.relay/claims/T###.lock` **刻意关闭心跳**,保留 240min TTL 崩溃恢复语义(agent 崩溃后到期可被其他模型接管,不因 server 进程存活而永久占用)。锁协议为 JSON v2(兼容旧文本),model 等字段的换行/控制字符由输入净化拒收,防注入不依赖心跳。
- **尚未提供**:claim 无 abort/release,无按任务查询 status 的独立工具,无 sessionId;可用恢复 = 认领锁 240min TTL 到期接管(可传 ttl_minutes)/ relay_session_end 出场释放 / relay_worktree_cleanup。并发会话必须使用不同 model 标识,同名 model 无法区分持有者。

## 目录与文件归属( exclusive,谁的东西谁写,别人不碰)

```
relay-mcp/
├── CONTRACT.md            # 本文件(已写好,只读)
├── README.md              # W1
├── templates/             # W1(脚手架模板,运行时被引擎读取;含 presets/ 代码骨架)
│   ├── START.md           # 引导扇区(<=1页):跑 verify→读 TASKS 顶部→按协议干
│   ├── SPEC.md            # 意图+可验证验收标准(占位骨架)
│   ├── DECISIONS.md       # 追加式决策日志(骨架+1条例子)
│   ├── TASKS.md           # 任务队列(骨架+格式说明+1条例子)
│   ├── LOG.md             # 会话日志(骨架+格式说明)
│   ├── verify.sh          # 委托脚本(见下)
│   ├── AGENTS.md.tpl      # 规范入口(canonical,含 <!-- relay:generated v1 --> 标记)
│   ├── CLAUDE.md.tpl      # 内容仅一行 @AGENTS.md + 标记
│   ├── GEMINI.md.tpl      # 平文指针"开工前先读并遵守 ./AGENTS.md 与 ./START.md" + 标记
│   ├── workflow-relay.yml # GitHub Actions:checkout→node verify
│   └── docs/              # docs/ 五件套骨架
│       ├── README.md      # 文档索引
│       ├── 01-sow/ 02-prd/ 03-ard/ 04-test/ 05-delivery/   # 各放一个 .gitkeep 或说明
│       ├── archive/.gitkeep
│       └── templates/     # 五件套文档模板(带 YAML frontmatter: title/version/created/status)
├── src/
│   ├── index.mjs          # W2:入口,启动 stdio server
│   ├── rpc.mjs            # W2:JSON-RPC stdio 循环(MCP 子集)
│   ├── contract.mjs       # W2:工具/资源/prompt 定义表 + dispatch
│   ├── cli.mjs            # W2:CLI(relay verify --root X),供 verify.sh 与 CI 调用
│   ├── util.mjs           # W2:fs/git 公共助手
│   └── engines/
│       ├── bootstrap.mjs  # W3:relay_init / relay_onboard
│       └── sync.mjs       # W3:relay_sync + 入口文件生成(供 init/onboard 复用)
│       ├── verify.mjs     # W4:relay_verify + 全部检查器(R4 豁免 user-rules 保留区)
│       ├── restructure.mjs # 老项目目录标准化(干跑→confirm 执行)
│       └── session.mjs    # W4:relay_session_start / relay_session_end / relay_claim
└── scripts/
    └── smoke.mjs          # 集成者写(不属于任何专家)
```

## W2 必须导出的公共接口(其余专家 import 自这些文件)

`src/util.mjs`:
```js
export const templatesDir = () => /* relay-mcp/templates 绝对路径,基于 import.meta.url 向上一级再进 templates */
export const readFileSafe = async (p, fallback = null) => /* 读文件,不存在返回 fallback */
export const writeFileIfAbsent = async (p, content) => /* 已存在则返回 false 不覆盖,成功返回 true */
export const backupFile = async (p) => /* 存在则改名 <p>.relay-bak-<yyyyMMddHHmmss>,返回新路径或 null */
export const isGitRepo = (root) => boolean
export const gitRun = async (root, ...args) => /* execFile('git',['-C',root,...args]) 包裹,返回 {ok,stdout,stderr};ok=exit 0 */
export const ensureDir = async (p) => /* recursive mkdir */
export const stamp = () => /* 'YYYY-MM-DD HH:mm' 本地时间 */
export const nowIso = () => /* ISO 日期 */
```

`src/rpc.mjs`:
```js
export const startServer = async ({ onInit, onMethod }) => {
  // stdin 按行读取 JSON-RPC 2.0;notification(无 id)直接忽略不回;
  // method 分派:onMethod(method, params) → 返回 result 或抛 {code,message};
  // 每条响应单行 JSON 写 stdout。initialize→onInit(params) 返回 {protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'relay-mcp',version:'1.0.0'}}
  // 必须响应:initialize, ping(→{}), tools/list, tools/call, resources/list, resources/read, prompts/list, prompts/get
  // 其余未知 method 且带 id → 错误 -32601
}
```

`src/contract.mjs` 导出 `TOOLS`(数组,每项 `{name, description, inputSchema}`)、`RESOURCES`、`PROMPTS`、`dispatch(name, args)`(async → MCP 工具结果 `{content:[{type:'text',text}], isError?:bool}`;未知工具 → isError true + 提示)。**工具实现只做参数默认值补齐,然后调 W3/W4 引擎。**

工具清单(description 必须写清协议,让陌生模型看描述就会用;英文,简洁):

| name | inputSchema | 职责(引擎) |
|---|---|---|
| `relay_init` | `{root:string(cwd默认), name:string?, preset:string?(默认 node), force:bool?}` | 0→1 建仓:实例化全部模板+**preset 代码骨架(src/tests/package.json,模板在 templates/presets/)**+git init+首提交(W3) |
| `relay_onboard` | `{root:string}` | 老项目接入:扫描→非破坏合并(备份不删除)→装核心件+verify+入口(W3) |
| `relay_sync` | `{root:string}` | 重生成入口文件,报告漂移(W3) |
| `relay_session_start` | `{root:string}` | 入场简报:读五件+对账 git+verify 快检+建议首个动作(W4) |
| `relay_session_end` | `{root, model:string, summary:string, done_task:string?(如T003), blocked:string?, next:{title, acceptance:string, notes:string?}?, negative_results:string[]?}` | 出场:绿闸→更新 TASKS/LOG→git 提交(W4) |
| `relay_verify` | `{root, full:bool?}` | 运行全部检查,返回逐条 pass/fail+修复指令(W4) |
| `relay_restructure` | `{root, confirm:bool?}` | 老项目目录标准化:干跑出方案→confirm 执行(git mv+白名单修宪+DECISIONS/LOG/TASKS 记录)(restructure.mjs) |
| `relay_claim` | `{root, task:string, model:string}` | 并行模式:认领任务,标注 model+时间(W4) |
| `relay_rules` | `{}` | 返回规则 ID 表(哪些可机检、执法点在哪) |

`src/cli.mjs`:`node cli.mjs <toolname> [--root path] [--json k=v ...]` → 复用 dispatch,人类可读输出;`verify.sh` 与 CI 走它。

## 仓库文件格式(跨专家一致性关键,W1 模板与 W4 解析器必须完全对齐)

### TASKS.md(最新在上)
```md
# 任务队列

## 进行中
- [~] T003 实现登录接口  (claude, 2026-09-29 14:05)

## 待办
- [ ] T004 对接支付回调
  验收: verify 全绿 且 `npm test -- login` 通过

## 已完成
- [x] T002 用户表迁移  (2026-09-29)
```
- 任务行正则(解析器只认这个):`/^- \[( |~|x)\] (T\d+) (.*?)(?:  \((.*)\))?$/`
- 认领信息写在行尾 `(model, YYYY-MM-DD HH:mm)`;完成写 `(YYYY-MM-DD)`——完成提交的消息含「T### 完成」token,考古用 `git log --grep "T### 完成"` 反查(单提交内盖戳+记自身 sha 自指无解)
- `验收:` 是完成判定:或是一段可执行命令,或是 `test:<失败测试文件路径>`(红灯协议——交班者留下失败测试,接班者让变绿)

### LOG.md(追加在**文件顶部**、标题行之后;最新在上)
```md
# 会话日志(最新在上)

## 2026-09-29 14:05 | model=claude | task=T003 完成
- 摘要: 完成登录接口与集成测试
- 负结果: 内存会话方案不可行,redis 前必须先升级 (可选行)
- 留给下一个: callback 签名见 SPEC.md §2 (可选行)
```
- 条目标题正则:`/^## (.+?) \| model=(.+?) \| task=(.+)$/`

### START.md / SPEC.md / DECISIONS.md
- DECISIONS 条目:`## YYYY-MM-DD — <决定>` + `- 理由:` + `- 否决:` + `- 状态: 现行|已废弃(被X取代,日期)`

### `.relay/manifest.json`(relay_init/onboard 生成,verify 与 sync 依赖)
```json
{ "version": 1,
  "entryFiles": ["AGENTS.md","CLAUDE.md","GEMINI.md"],
  "allowedTopLevel": ["src","docs","scripts","tests",".relay",".github", "README.md","SPEC.md","DECISIONS.md","TASKS.md","LOG.md","START.md","verify","package.json",".gitignore",".editorconfig"],
  "docsPhases": ["01-sow","02-prd","03-ard","04-test","05-delivery","archive","templates"],
  "onboardedAt": "ISO", "relayHome": "<relay-mcp 绝对路径>" }
```
- onboard 时 `allowedTopLevel` = 已有顶层条目 ∪ 默认集(不破坏现状),`docsPhases` 若项目已有 docs/ 布局则记实际布局

### verify.sh(单源指针)

模板即唯一真相:`templates/verify.sh`(要点:RELAY_HOME 环境变量优先 → 实例化时固化的 `__RELAY_HOME__` 兜底 → 找不到引擎时输出明确修复指引并 exit 2)。此处不复制脚本内容,防止契约与模板各自漂移。

## 检查器规则表(relay_verify 实现,W4;错误文本必须以 `修复:` 开头给可执行指令)

| ID | 规则 | 机制 |
|---|---|---|
| R1 | 入口文件齐全且带 relay 标记 | manifest.entryFiles 逐个存在 + 首行含 `<!-- relay:generated` |
| R2 | 顶层结构白名单 | git ls-files 未跟踪+已跟踪的顶层条目 ⊆ allowedTopLevel;越界 → 修复:改 .relay/manifest.json(显式修宪) |
| R3 | docs 命名+frontmatter | docs/**/*.md(templates/archive 除外)匹配 `^[0-9]{2}-(sow|prd|ard|test|delivery)?-.*-v\d+\.\d+\.md$` **或** 已有项目宽松模式(有 frontmatter title+status 即可);onboard 项目记录宽松位 |
| R4 | 入口/START 无时变词 | AGENTS/CLAUDE/GEMINI/START 中 grep -E 'TODO|进行中|下周|待办:' 为空 |
| R5 | 提交原子性 | 存在 git 时:最近 1 条 commit 若触碰 (src|lib|app)/** 而未触碰 TASKS.md|LOG.md → warn(本地提示,不阻断) |
| R6 | 文档 staleness | src 与 docs 同期对比:src 最近 20 commit 内有改动而 docs 0 改动 → warn |
| R7 | 发散报警 | LOG 最近 3 条任务会话(task=维护 的条目不计入)task 均非「T### 完成」→ error:停机,升级人类仲裁 |
| R8 | 风格归一化 | 项目存在 prettier/eslint 配置或 package.json scripts.format → 提示运行;不存在 → skip(不强加工具链) |
| R9 | LOG/TASKS 一致性 | LOG 最新条目里 task=Txxx 完成 而 TASKS 中 Txxx 仍为未完成 → error |
| R11 | 协议文件敏感内容 | TASKS.md/LOG.md 内容级扫描(AWS/GitHub/Slack/OpenAI/Google 密钥样式 + PEM 私钥块);同行 `relay:secret-ok` 豁免;命中 → error,`relay_session_end` 在任何写盘前阻断 |

- 检查输出:`| ID | 结果 | 详情 |` 表格 + 末尾汇总;任一 error → isError:true(fast 模式跳过 R5/R6/R8,session_end 默认 fast=false 全量)
- **受保护路径**:`verify`(脚本)、`.relay/**`、`*/tests/**`、`*.test.*`、`*.spec.*` —— relay_session_end 若检测到本会话改动了这些文件,则**不自动 commit**,输出"涉及受保护路径(护栏),需人类批准后手动提交"并列出文件

## 安全与降级(全体遵守)

- 仓库级写锁:`.relay/relay.lock`(O_EXCL,持锁超 2 分钟视为崩溃残留可接管)序列化一切 TASKS/LOG 读改写;出场/认领/重构/重投影四个写入口均先取锁。

- 非破坏:onboard 对已存在文件一律 `backupFile` 后再写,永不删除用户文件;init 若 START.md 已存在且无 force → 拒绝并提示用 relay_onboard
- git 不存在或 commit 失败(无身份配置等)→ 降级:文件照常更新,报告"提交跳过+原因",isError 不置位
- 所有工具输出:简洁 markdown,中文标签;路径用相对 root 的写法
- relay_session_end 绿闸:verify 全量通过才允许 `git add -A && git commit -m "relay: session end — <summary 首行>"`;不绿 → isError + 修复清单 + 明确"未提交"

## W1 专属:规范文档改写目标

把 `<claude 配置目录>/CLAUDE-PROJECT-RULES.md`(先读原文)改造为 v3:五公理→三原则(最小充分状态/无信任交接/规范即检查)→仓库文件集(START/SPEC/DECISIONS/TASKS/LOG/verify + docs 五件套**原样保留**)→单源投影注入(入口文件生成,CI 零 diff)→六步会话协议→规则 ID 表(同上 R1-R9)→人类四件事(验收标准/仲裁阻塞/抽查/批准护栏修改)→三场景使用(0→1 用 relay_init;1→10/10→100 用 relay_onboard;日常用 session_start/end)→失效模式表→自检清单。≤220 行,注明"本规范的可执行形式 = relay-mcp"。
## 2026-11-01 T014 补充契约(内容级密钥闸 / R11)

- **分层**:`findSensitiveChanges`(util)继续负责**路径级**密钥守卫(`.env*`/`*secret*`/`*.key`/`*.pem`/id_rsa 不自动提交);新增 `scanSecrets` 负责**内容级**扫描,二者互补,任一不得单独移除。
- **规则 R11**:`relay_verify` 扫描 controlRoot 的 `TASKS.md` + `LOG.md`(fast 与 full 均执行;executionRoot 任务树不跑,同 R7/R9 边界)。命中 → ERROR,详情以 `修复:` 开头;输出只含命中行号、规则名与**前 4 字符**预览,绝不回显完整密钥。
- **规则集(刻意窄,宁漏不误报)**:AWS `AKIA[0-9A-Z]{16}`、GitHub `gh[pous]_[A-Za-z0-9]{36}`、Slack `xox[baprs]-…`、OpenAI 风格 `sk-[A-Za-z0-9]{20,}`、Google `AIza…`、PEM 私钥块 `-----BEGIN … PRIVATE KEY-----`。
- **豁免**:同一行出现 `relay:secret-ok` 即跳过该行(人类可见、进 diff、可审计);不提供 manifest 白名单——少一个绕过面。
- **出场前置闸**:`relay_session_end` 在**任何文件写入之前**扫描本次输入(`model`/`summary`/`blocked`/`done_task`/`next.*`/`negatives[]`);命中 → isError,不写 TASKS、不写 LOG、不提交、不释放认领锁(避免「TASKS 已写、LOG 被拦」的半写状态)。
- **写盘二次扫描**:TASKS/LOG 序列化后的全文在 `writeProtocolFile` 前再扫一次(兜住既有条目里已存在的密钥),命中同样阻断。
- **不可逆语义**:密钥一旦进入 git 历史即不可撤回;R11 只防「未来写入」,不救已提交内容——修复指令明确要求轮换密钥。
- **冒烟**:`scripts/smoke-content-guard.mjs` 覆盖命中/豁免/阻断/无半写四类断言,已接入 `npm test` 链。
## 2026-11-01 T013 补充契约(事实底账 / R10)

- **写入**:`relay_session_end` 在 LOG 条目「摘要」之后追加一行 `- 事实(v1): …`,内容由引擎确定性派生,**模型不得手写或改写**。字段:改动文件数与 ± 行数、验收执行结果、verify 汇总(PASS/WARN/ERROR 计数)、分支与代码 SHA(单根未提交时标 `@未提交`)、耗时。
- **口径**:
  - managed(受管 worktree):`git diff --name-only --no-renames <baseSha>..HEAD`(executionRoot 任务分支)。
  - 单根:工作区 vs HEAD(`git diff HEAD`),此时代码尚未提交,故不写 SHA。
  - 非 git / git 不可读:退化为 `git status` 文件数,± 记 0(不假装知道)。
  - 协议文件 `TASKS.md`/`LOG.md` 恒不计入改动文件数。
- **校验 R10**(仅 controlRoot,同 R7/R9 边界):
  - 10.1 最新完成条目缺「事实(v1)」行 → **ERROR**(防手写伪造完成条目);
  - 10.2 行格式不可解析 → **ERROR**(说明被手改或引擎回退);
  - 10.3 可定位提交时重算文件数,不一致 → **WARN**;`manifest.facts.strict=true` → **ERROR**;
  - 10.4 `manifest.facts.enabled` 未开 / `since` 未设 / 条目早于 `since` → **SKIP**(升级兼容)。
- **配置**(`.relay/manifest.json`):
  `"facts": { "enabled": true, "since": "YYYY-MM-DD HH:mm", "strict": false }`。
  `relay_init` / `relay_onboard` 默认写入 `enabled:true` 与启用时刻 `since`;旧项目缺席即旧行为(不写事实行、R10 跳过),`relay_sync` 输出升级提示但不改写 manifest(非破坏)。
- **为何只比文件数**:行级 ±x/-y 会被 CRLF、重命名、合并与跨多提交污染,成为恒过或恒错的假裁判;文件数在同一 `--no-renames` 口径下稳定可复现。
- **冒烟**:`scripts/smoke-facts.mjs` 覆盖写入/存在性/数字 WARN/strict ERROR/升级 SKIP 五类断言,已接入 `npm test` 链。
## 2026-11-01 T015 补充契约(简报有界化 / 预算告警)

- **字段上限**:入场简报中每条 LOG 摘要最多 200 字符(负结果、留给下一个仍为 120),超限以 `…[截断 N 字,全文见 LOG.md]` 标注;**只截断展示,不改 LOG 本体**。
- **结构上界**:简报由固定段落 + 字段上限构成硬上界(3 条 LOG × (200+120+120) + 3 条决策 + 前 3 待办 + git 5 条 + verify 表),因此不存在"越写越大"的无界增长;这是不引入级联裁剪状态机的前提。
- **预算告警**:渲染完成后统计字符数,超过 `manifest.contextBudget`(默认 6000)时在简报尾部追加 `> ⚠ 简报 N 字符超出预算 M…` 并提示读 LOG.md/TASKS.md;**不丢弃任何段落、不静默降级**(委员会一致否决 claude-mem 式"按最便宜先丢"的级联裁剪)。
- **生效配置回显**:简报头部新增一行 `- 生效配置: facts=… contextBudget=…`,让 manifest 里被静默忽略的拼错字段当场可见。
- **配置**:`"contextBudget": 6000`;非有限数或非正数回退默认(不改变既有行为,只影响告警阈值)。
- **冒烟**:`scripts/smoke-brief.mjs` 覆盖截断/总长/告警/不裁剪段落四类断言,已接入 `npm test` 链。
## 2026-11-01 T019 补充契约(relay_doctor 只读七检)

- **定位**:`relay_doctor` 诊断「环境/安装面」漂移,`relay_verify` 诊断「仓库规范面」;二者不互相替代。
- **只读铁律**:不写任何文件、不取仓库写锁、不自动修复。修复指令只引用 relay 原生命令,**绝不输出 rm**。
- **七检**:
  - D1 Node 运行时 ≥ 18;
  - D2 `.relay/manifest.json` 可解析 + schema 兼容(version=1,关键字段);
  - D3 入口文件与模板投影漂移(复用 `generateEntryFiles` 新增的 **check 只读模式**,绝不落盘);
  - D4 `.relay/claims/*.lock` 残留/过期(TTL 240min;空/半初始化锁也报);
  - D5 未登记的 relay 任务树(`git worktree list` 对比注册表;分支 `relay/*` 或位于受管缓存);
  - D6 `.relay` 存在、非符号链接、注册表可解析;
  - D7 引擎路径一致性(`RELAY_HOME`、`manifest.relayHome` vs 实际 `templates/` 的父目录)。
- **退出语义**:存在 ERROR → isError true(WARN 不阻断);输出 `| 检查 | 结果 | 详情 |` 表 + 按序「修复:」清单。
- **sync.mjs 新增只读模式**:`generateEntryFiles(root, { mode: 'check' })` 只报告漂移/缺失,不写盘、不备份;doctor 专用,其余模式行为不变。
- **冒烟**:`scripts/smoke-doctor.mjs` 覆盖健康仓库 + 6 类故障 fixture(manifest 缺失/损坏、引擎路径错配、过期锁、未登记 worktree、入口漂移、注册表损坏)+ `.relay` 零写盘快照断言,已接入 `npm test`。
