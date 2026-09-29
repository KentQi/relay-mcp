# relay-mcp 接口契约

> 注:本文档是开源前并行开发的内部 memo("W1-W4"为当时的专家分工编号),保留作为设计记录;绝对路径已脱敏为占位符。

接力棒 MCP:让任意模型(Claude/Codex/Gemini/Cursor/ZCode…)在任意项目上接力开发。
零依赖纯 Node ESM(仅用 node: 内置模块),**无构建步骤**,入口 `node src/index.mjs`。

- 项目根:`<relay-mcp 安装目录>`
- Node >= 18,所有源码 `.mjs`,严格用 `import`/`export`
- 每个文件写完必须 `node --check <file>` 通过
- 模板在**运行时**从 `templates/` 读取(用 `templatesDir()` 解析),绝不硬编码模板内容

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
