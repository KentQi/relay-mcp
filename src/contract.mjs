// relay-mcp — src/contract.mjs (W2)
// 工具 / 资源 / 提示词的定义表 + dispatch。
// 本文件只做:定义(英文 description,陌生模型看描述即会)→ 参数默认值补齐 → 调 engines。
// 引擎(./engines/*.mjs)由 W3/W4 并行开发,采用懒加载 import:
// 缺失时 server 仍可启动,仅对应工具返回 isError 说明,便于集成前联调 rpc 层。
import path from 'node:path';
import { templatesDir, readFileSafe } from './util.mjs';

/* ------------------------------- TOOLS ------------------------------- */

const ROOT_DESC = 'Project root; defaults to the server cwd.';

export const TOOLS = [
  {
    name: 'relay_init',
    description:
      'Bootstrap a new project into the relay protocol (0→1): all relay files from templates (START/SPEC/' +
      'DECISIONS/TASKS/LOG/verify/entry files/.relay manifest/docs skeleton) plus a code skeleton from ' +
      'preset (node | minimal | none), git init and the first commit. Refuses when START.md exists unless ' +
      'force=true (then prefer relay_onboard). Next step: relay_session_start.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        name: {
          type: 'string',
          description: 'Project name written into the scaffold (optional).',
        },
        preset: {
          type: 'string',
          description: 'Code skeleton: "node" (default), "minimal" (relay only) or "none". Unknown → minimal.',
        },
        force: {
          type: 'boolean',
          description: 'Overwrite an existing START.md (backup first). Default false.',
        },
      },
    },
  },
  {
    name: 'relay_onboard',
    description:
      'Adopt the relay protocol on an existing project, non-destructively: backs up every file it touches ' +
      '(<file>.relay-bak-<timestamp>), unions allowedTopLevel, records the actual docs layout, installs core ' +
      'files + verify.sh + entry files + .gitignore baseline, then reports changes. Existing manifest config ' +
      '(worktree/autoCommit/acceptance/protectedPaths/...) is PRESERVED, so re-running never disables ' +
      'features. Prefer over relay_init when the directory is not empty.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
      },
    },
  },
  {
    name: 'relay_sync',
    description:
      'Upgrade/repair entry point: regenerate AGENTS.md and the optional adapter entry files from the single ' +
      'source, report drift, and idempotently append the .gitignore runtime baseline. When an unmarked ' +
      'AGENTS.md blocks R1, prints executable migration steps. Run after upgrading a project or editing ' +
      'canonical templates.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
      },
    },
  },
  {
    name: 'relay_session_start',
    description:
      'MUST be the first call of every session (protocol step 1). Returns a briefing: reads START/SPEC/' +
      'DECISIONS/TASKS/LOG, reconciles git state (uncommitted changes, last commit), runs a fast verify, and ' +
      'proposes the first action — the topmost actionable task or the red-light test left by the previous ' +
      'session.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
      },
    },
  },
  {
    name: 'relay_session_end',
    description:
      'MUST be the last call of every session (step 6). Green gate: full verify plus executable acceptance ' +
      'must pass before anything is written or committed; else isError + fix list, nothing marked done. In a ' +
      'managed worktree it makes two commits (executionRoot code on relay/T###, controlRoot TASKS.md+LOG.md ' +
      'with "T### 完成") and reports both SHAs — accepted but NOT merged. Fill next{title, acceptance} and ' +
      'negative_results. Protected paths are never auto-committed. Full rules: relay_rules / relay://protocol.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        model: { type: 'string', description: 'Unique model/agent id (e.g. "claude-a"); duplicates cannot prove claim ownership.' },
        summary: {
          type: 'string',
          description: 'One-paragraph summary of what this session actually did.',
        },
        done_task: {
          type: 'string',
          description: 'Task ID completed this session, e.g. "T003" (optional).',
        },
        blocked: {
          type: 'string',
          description: 'Blocker needing human arbitration, if any (optional).',
        },
        next: {
          type: 'object',
          description: 'Handoff to the next session.',
          properties: {
            title: { type: 'string', description: 'Short imperative title of the next task.' },
            acceptance: {
              type: 'string',
              description: 'Verifiable acceptance criteria (executable command or test: path).',
            },
            notes: { type: 'string', description: 'Pointers the next model needs (optional).' },
          },
          required: ['title', 'acceptance'],
        },
        negative_results: {
          type: 'array',
          items: { type: 'string' },
          description: 'Approaches proven NOT to work (optional).',
        },
      },
      required: ['model', 'summary'],
    },
  },
  {
    name: 'relay_verify',
    description:
      'Run all repo checkers R1–R13 and return a | ID | 结果 | 详情 | table; every failure line starts with ' +
      '"修复:" plus an executable fix. Any error-level check → isError. full=false (default) skips R5/R6/R8; ' +
      'relay_session_end always runs the full set. Call before handing off or to inspect repo health.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        full: {
          type: 'boolean',
          description: 'Run full check set including R5/R6/R8. Default false (fast).',
        },
      },
    },
  },
  {
    name: 'relay_restructure',
    description:
      'Normalize an existing project\'s layout toward the relay standard (code → src/, tests → tests/, tooling ' +
      '→ scripts/). Conservative: only unambiguous dirs and loose root files move; ambiguous entries (app/, ' +
      'server/, packages/) are listed for a human and never touched. Dry-run by default; confirm=true needs a ' +
      'clean git repo, moves with git mv (history preserved), amends the manifest whitelist, appends ' +
      'DECISIONS/TASKS entries and commits.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        confirm: {
          type: 'boolean',
          description: 'false/omitted = dry-run (plan only). true = execute (clean git repo required).',
        },
      },
    },
  },
  {
    name: 'relay_claim',
    description:
      'Parallel mode: claim a task before starting work. Marks it [~] with your model name and timestamp so ' +
      'two models never grab the same task. When worktree is enabled, also creates/reuses .relay/worktrees/' +
      'T### + branch relay/T### and returns controlRoot, executionRoot, branch, baseSha — edit code and run ' +
      'relay_session_end in executionRoot. Without a usable git HEAD it degrades to a single-root claim with ' +
      'a WARN.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        task: { type: 'string', description: 'Task ID to claim, e.g. "T003".' },
        model: { type: 'string', description: 'Model/agent identifier claiming the task.' },
        worktree: { type: 'boolean', description: 'Override manifest.worktree.enabled. Only JSON true enables; legacy manifests default false.' },
      },
      required: ['task', 'model'],
    },
  },
  {
    name: 'relay_worktree_cleanup',
    description:
      'Inspect or clean expired managed task worktrees. Dry-run by default; confirm=true removes only ' +
      'registered, inactive, clean (no untracked/ignored content), unlocked, expired paths in the managed ' +
      'cache — never local secrets/deps. Branches are preserved and listed; no merge/rebase/push/force-remove. ' +
      'Recovery: claim TTL, relay_session_end, or this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        confirm: { type: 'boolean', description: 'false/omitted = dry-run; true = execute.' },
        ttl_hours: { type: 'number', description: 'Expiration override in hours (default: manifest value, 24).' },
      },
    },
  },
  {
    name: 'relay_archive_log',
    description:
      'Archive old LOG.md entries into docs/archive/ and leave a verifiable pointer (R12). Dry-run by default; ' +
      'confirm=true moves only from the tail, keeps at least 3 entries (default 8), never archives at or above ' +
      'the newest completion entry, is append-only, passes the secret scan, and rewrites LOG.md through the ' +
      'CAS protocol writer. Never compresses or deletes history — moving is the whole action.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        confirm: { type: 'boolean', description: 'false/omitted = dry-run; true = write LOG.md + archive file.' },
        keep: { type: 'number', description: 'How many newest entries stay live (default 8, minimum 3).' },
      },
    },
  },
  {
    name: 'relay_recall',
    description:
      'Read-only task-history index (progressive disclosure step 1): one compact row per task from LOG.md + ' +
      'TASKS.md (id/time/model/status/title/size/negative count) with query/status/model/limit filters. No ' +
      'persistent index, no writes. Use relay_get for full entries.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        query: { type: 'string', description: 'Case-insensitive substring over task id/title/summary/handoff (max 120 chars).' },
        status: { type: 'string', description: 'Filter by task status: 完成 | 进行中 | 待办 (or x/~/" ").' },
        model: { type: 'string', description: 'Filter by model id substring.' },
        limit: { type: 'number', description: 'Max rows, default 20, capped at 50.' },
      },
    },
  },
  {
    name: 'relay_get',
    description:
      'Read-only full task history (progressive disclosure step 2): for up to 5 task ids, returns TASKS ' +
      'status/title/acceptance, the newest LOG entry (summary, 事实(v2) line, branch/sha, negative results, ' +
      'handoff) and related DECISIONS lines. Output is fenced and labelled data, not instructions. Never writes.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        ids: { type: 'array', items: { type: 'string' }, description: 'Task ids like ["T013","T019"], max 5.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'relay_doctor',
    description:
      'Read-only diagnosis (9 checks): Node runtime, manifest schema, entry projection drift, stale claim locks, ' +
      'unregistered task worktrees, .relay integrity, engine path, completion-state convergence, acceptance-command ' +
      'landing. Never writes, never takes the repo lock, never auto-fixes: every problem carries a "修复:" ' +
      'instruction. Use after upgrades or on install drift; repo-rule health is relay_verify.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
      },
    },
  },
  {
    name: 'relay_rules',
    description:
      'Return the R-series rule table (R1–R13): what each rule checks and where it is enforced (relay_verify / ' +
      'session_end). Read this when a verify failure is unclear, or for the full rule set without running verify.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ------------------------------ RESOURCES ------------------------------ */

// relay://protocol — 六步会话协议文本(服务器自有契约面,非注入用户仓的模板)
const PROTOCOL_TEXT = `# relay 六步会话协议(Six-Step Session Protocol)

Every relay session — any model, any project — follows the same six steps.
The tools enforce the loop; you cannot skip the gates.

1. **Enter(入场)** — Call \`relay_session_start\` FIRST. It reads the five core files
   (START.md / SPEC.md / DECISIONS.md / TASKS.md / LOG.md), reconciles with git, runs a
   fast verify, and proposes your first action.
2. **Orient(对齐)** — Follow the briefing: top of TASKS.md is the queue head, the newest
   LOG.md entry holds the handoff notes ("留给下一个") and negative results
   ("负结果" = things that do NOT work — never retry them blindly).
   Older history: \`relay_recall\` gives a compact index, \`relay_get\` fetches full
   entries by task id (read-only, derived on the fly, no persistent index).
3. **Claim(认领)** — Take the topmost actionable task. In parallel mode call
   \`relay_claim\` (marks the task with your model name + timestamp) before starting work.
4. **Work(实现)** — Implement strictly to SPEC.md acceptance criteria and the task's
   \`验收:\` line; append significant decisions to DECISIONS.md as you make them.
   When claim returns a managed executionRoot, edit code and run tests there; controlRoot
   remains the sole TASKS/LOG protocol surface. A task worktree is an independent
   checkout: node_modules / .env are NOT shared with controlRoot — install/configure
   dependencies inside executionRoot before running R8/tests.
   A \`test:<failing-test-path>\` acceptance means the previous session left a red test
   on purpose — your job is to make it green.
5. **Verify(验证)** — Run \`relay_verify\` (full) until green; execute every \`修复:\`
   instruction it gives. In a managed worktree the gate checks controlRoot (R1–R13) and the
   task checkout (code rules), so R5/R6 commit evidence comes from both the control-plane
   commit and the task-branch commit. Never hand off a red repo.
6. **Exit(出场)** — Call \`relay_session_end\` LAST with model, summary, done_task,
   negative_results and a concrete \`next\` handoff (title + acceptance). In a managed
   worktree the green gate makes TWO commits: code on executionRoot branch \`relay/T###\`,
   then controlRoot with ONLY TASKS.md/LOG.md updated; both SHAs are reported. In a managed
   worktree, done_task MUST match the task registered for the executionRoot you call from;
   a mismatched task id is rejected (no cross-task completion). The task
   branch is accepted, not merged: merge it yourself with
   \`git merge --no-ff relay/T###\` after reviewing \`git log controlRoot..relay/T###\`
   (relay never merges/rebase/pushes or deletes task branches). Worktrees with ignored
   local files are kept by cleanup. Not green / commit failed → isError, nothing is
   marked done, claim lock kept, fix and re-run.

Capabilities today: there is no abort/release tool for a claim, no per-task status
tool and no sessionId. Recovery = wait for the claim TTL, finish via
\`relay_session_end\`, or clean expired worktrees with \`relay_worktree_cleanup\`.
Concurrent sessions MUST use distinct \`model\` ids (same id cannot prove ownership).

Rules in short: state lives in files, not in your context. Trust nothing you did not
read this session. The verify gate, not your judgment, decides when you may leave.
Rule details: call \`relay_rules\`. Spec entry template: read resource \`relay://spec\`.
`;

export const RESOURCES = [
  {
    uri: 'relay://spec',
    name: 'relay-spec-entry',
    description:
      'The canonical spec entry template (templates/AGENTS.md.tpl) that relay projects into every ' +
      'entry file (AGENTS.md/CLAUDE.md/GEMINI.md). Single source of truth for the relay rules; ' +
      'edit here, then run relay_sync to re-project.',
    mimeType: 'text/markdown',
    load: async () => {
      const p = path.join(templatesDir(), 'AGENTS.md.tpl');
      const text = await readFileSafe(p, null);
      if (text === null) {
        throw { code: -32602, message: `Spec template not found (W1 pending?): ${p}` };
      }
      return text;
    },
  },
  {
    uri: 'relay://protocol',
    name: 'relay-six-step-protocol',
    description:
      'The six-step relay session protocol (enter → orient → claim → work → verify → exit) every ' +
      'relay session must follow, with the gate conditions between steps.',
    mimeType: 'text/markdown',
    load: async () => PROTOCOL_TEXT,
  },
];

/* ------------------------------- PROMPTS ------------------------------- */

export const PROMPTS = [
  {
    name: 'relay-session-start',
    description:
      'Kick off a relay relay work session: get the entry briefing, pick up the top task or red test, ' +
      'work to its acceptance criteria, verify green, then hand off with relay-session-end.',
    arguments: [
      { name: 'root', description: 'Project root (defaults to the server cwd).', required: false },
      { name: 'task', description: 'Optional task ID to focus on, e.g. T003.', required: false },
    ],
    render: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `You are joining a relay relay project${args.root ? ` at ${args.root}` : ''}. ` +
            'Follow the six-step relay protocol:\n' +
            '1) Call the tool relay_session_start and read the briefing it returns.\n' +
            '2) Check the top of TASKS.md and the newest LOG.md entry for handoff notes; ' +
            'respect recorded negative results — do not retry what already failed.\n' +
            `3) ${args.task ? `Claim/focus task ${args.task}` : 'Take the topmost actionable task'}; ` +
            'in parallel mode call relay_claim first.\n' +
            '4) Implement strictly to SPEC.md and the 验收: line of the task. If acceptance is ' +
            'test:<path>, make that failing test green.\n' +
            '5) Run relay_verify (full) and execute every 修复: instruction until green.\n' +
            '6) Call relay_session_end with model, summary, done_task, negative_results and a ' +
            'concrete next handoff (title + acceptance). Do not leave the repo red.\n' +
            'State lives in files, not in your context: re-read, never assume.',
        },
      },
    ],
  },
  {
    name: 'relay-session-end',
    description:
      'Close out a relay relay work session: summarize honestly, record negative results, write a ' +
      'verifiable handoff, and pass the green gate before leaving.',
    arguments: [
      { name: 'root', description: 'Project root (defaults to the server cwd).', required: false },
      { name: 'task', description: 'Task ID completed this session, e.g. T003.', required: false },
      { name: 'summary', description: 'One-paragraph summary of what was done.', required: false },
    ],
    render: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `You are ending a relay relay session${args.root ? ` at ${args.root}` : ''}. ` +
            'Before leaving, do this:\n' +
            '1) Run relay_verify (full). If not green, fix per the 修复: instructions first — ' +
            'the green gate is non-negotiable.\n' +
            '2) Compose your handoff: summary of what actually changed' +
            `${args.summary ? ` (draft: ${args.summary})` : ''}` +
            `${args.task ? `, done_task=${args.task}` : ''}, negative_results (approaches that ` +
            'failed, so nobody retries them), and next = { title, acceptance } where acceptance is ' +
            'an executable command or test:<path>.\n' +
            '3) Call relay_session_end with those fields. It updates TASKS.md and LOG.md and commits ' +
            'only if verify is green; protected paths (verify, .relay/**, tests) are never ' +
            'auto-committed.\n' +
            '4) If you are blocked, say so in the blocked field — escalation to a human beats ' +
            'silent divergence.',
        },
      },
    ],
  },
];

/* ------------------------------- RULES ------------------------------- */

const RULES_TEXT = `# relay 规则表(R 系列)

机检规则与执法点。任一 error 级规则失败 → relay_verify / relay_session_end 返回 isError:true;
每条失败详情以 \`修复:\` 开头,给出可执行指令。

| ID | 规则 | 机制 | 执法点 |
|---|---|---|---|
| R1 | AGENTS.md 必需且带 relay 标记 | AGENTS.md + manifest.entryFiles 其他入口逐个存在,首行含 \`<!-- relay:generated\`;entryFiles=[] 也不能豁免。修复:缺失→\`relay_sync\`;已存在无标记→\`relay_onboard\`(原正文包进 user-rules)、manifest \`entryFilesTakeover:true\` 后 \`relay_sync\`、或手工加标记 | relay_verify |
| R2 | 顶层结构白名单 | git ls-files 顶层条目 ⊆ manifest.allowedTopLevel;越界 → 修复:显式修宪(改 .relay/manifest.json) | relay_verify |
| R3 | docs 命名+frontmatter | docs/**/*.md(templates/archive 除外)匹配 \`^[0-9]{2}-(sow\\|prd\\|ard\\|test\\|delivery)?-.*-v\\d+\\.\\d+\\.md$\`,或宽松模式(frontmatter 含 title+status;onboard 项目记录宽松位) | relay_verify |
| R4 | 入口/START 无时变词 | AGENTS/CLAUDE/GEMINI/START 中 grep -E 'TODO\\|进行中\\|下周\\|待办:' 为空 | relay_verify |
| R5 | 提交原子性 | 最近 1 条 commit 触碰 (src\\|lib\\|app)/** 而未触碰 TASKS.md\\|LOG.md → warn(本地提示,不阻断);最新提交是 merge → skip(不再假 PASS) | relay_verify(full) |
| R6 | 文档 staleness | src 近 20 commit 有改动而 docs 0 改动 → warn | relay_verify(full) |
| R7 | 发散报警 | LOG 最近 3 条任务会话(task=维护 / task=无 的条目不计入)task 均非「T### 完成」→ error:停机,升级人类仲裁 | relay_verify |
| R8 | 风格归一化 | 项目存在 prettier/eslint 配置或 package.json scripts.format → 提示运行;不存在 → skip(不强加工具链) | relay_verify(full) |
| R9 | LOG/TASKS 一致性 | LOG 最新条目 task=Txxx 完成 而 TASKS 中 Txxx 仍为未完成 → error | relay_verify / session_end 绿闸 |
| R10 | 事实对账 | LOG 最新完成条目必须含引擎写入的「事实(v2)」行;机检段(mode/文件数/base/sha/branch)与 git 重算逐字段一致(managed 另含 ±),不一致 → ERROR;branch 必须真实包含声明的 sha(存在但不含 → ERROR;已删除但完成提交仍在当前分支历史 → PASS 带注记,否则 WARN);叙述段(验收/verify/耗时)不参与对账;无法定位提交 → WARN(永不 PASS);v1 旧格式只做结构校验 → WARN(数字权威仅 v2);缺事实行 → WARN;早于 facts.since 的旧条目豁免 | relay_verify / session_end 绿闸 |
| R11 | 协议面敏感内容 | 协议面 8 个文件(TASKS/LOG/AGENTS/CLAUDE/GEMINI/START/SPEC/DECISIONS)+ docs/archive/**/*.md 内容级扫描(AWS/GitHub/Slack/OpenAI/Google 密钥样式与 PEM 私钥块);同行 \`relay:secret-ok\` 豁免;命中 → error,出场写盘前阻断且不提交 | relay_verify / session_end 绿闸 |
| R12 | LOG 边界 | 活跃区(归档指针之前的行)>150 行 或 活跃区内完成条目 >20 → WARN(manifest.logBoundary.strict=true 升 ERROR);归档指针必须指向真实存在、非空且 realpath 仍在仓库内的 docs/archive/*.md 才被承认,否则指针不被承认且 R12 报 WARN(不静默 PASS);只报警不自动归档 | relay_verify / session_end 绿闸 |
| R13 | 协议结构 | TASKS 任务行必须匹配契约正则且任务号唯一;[~] 必须带 (model, YYYY-MM-DD HH:mm),[x] 必须带 (YYYY-MM-DD);LOG 条目标题必须匹配「## 时间 ｜ model=名 ｜ task=…」;HTML 注释块与缩进行豁免;违规 → WARN(manifest.structure.strict=true 升 ERROR)——拼错的任务行/日志标题会被解析器静默跳过,本规则把「写错」与「没有」区分开 | relay_verify / session_end 绿闸 |

补充:

- 检查输出:\`| ID | 结果 | 详情 |\` 表格 + 末尾汇总;fast 模式(full=false)跳过 R5/R6/R8。
- **双根检查**:受管 worktree 中 controlRoot 跑全量 R 系列(协议面),executionRoot 跑代码向检查 R1/R2/R3/R4/R8(跳过 R7/R9/R10/R11/R12,避免读任务分支里的旧协议副本);两侧 ERROR 合并阻断。**成对证据**:managed 完成还须同时具备任务分支代码提交、controlRoot 完成提交(消息含 \`T### 完成\`)、controlRoot 的 TASKS/LOG 已提交干净、LOG 记录 branch+代码 SHA;任一缺失 → isError、不落完成状态、可重跑补交。R5/R6 仍按 controlRoot 历史计算(任务分支提交不进入其窗口),跨分支评估留待后续。
- **绿闸与双提交**:relay_session_end 默认全量 verify,全绿且验收通过后 → 先在 executionRoot 提交代码(\`git add -A && git commit\`),成功后 controlRoot 只提交 \`TASKS.md\`+\`LOG.md\`(路径限定,提交信息含 \`T### 完成\`);输出两个 SHA(代码 SHA + 控制面 SHA)。controlRoot 提交失败 → isError + 保留认领锁,修复后重跑补交;\`autoCommit:false\` 时明确"控制面未提交"。
- **根错配 fail-closed(严格)**:任务在 registry 仍有未完成记录时,从 controlRoot 完成出场**一律 isError**「根错配」,须在 executionRoot 出场(无"干净空树"例外);注册表缺失/损坏/记录丢失时用 \`git worktree list\` 反查 \`relay/<task>\` checkout 与受管缓存路径 \`.relay/worktrees/<task>\` 是否存在,命中同样拒绝;分支单独存在不算痕迹。managed 出场 HEAD==baseSha 且无改动 → 拒绝伪 SHA。未登记 linked worktree:完成出场 fail-closed,维护出场仅告警。
- **未合并分支**:任务分支 \`relay/T###\` 验收通过 ≠ 已合并;claim/session_start/cleanup 会列出未合并分支,由人工 \`git merge --no-ff relay/T###\` 整合(relay 不自动 merge/rebase/push/删分支)。
- **受保护路径**:\`verify\`(脚本)、\`.relay/**\`、\`*/tests/**\`、\`*.test.*\`、\`*.spec.*\` —— session_end 检测到本会话改动这些文件时不自动 commit,输出"涉及受保护路径(护栏),需人类批准后手动提交"并列出文件。
- 降级:git 不存在或 commit 失败(无身份配置等)→ 文件照常更新,报告"提交跳过+原因",不置 isError;claim 在无可用 HEAD/git 时降级单根认领并 WARN。
- **worktree 配置真值表**:\`enabled\` 只认 JSON 布尔 \`true\`(字符串 \`"true"\`/数字 1 静默按 false);\`cacheDir\` 只允许 controlRoot 内相对路径(绝对路径/.. /盘符/控制字符/.git 前缀非法,在创建目录前校验);\`ttlHours\` 非数字回退 24;未知/拼错字段静默忽略;\`claim\` 的 \`worktree:true/false\` 可单次覆盖配置。
- **清理保护**:含未跟踪或 ignored 本地内容(\`.env\`、\`node_modules\`、构建产物)的 worktree 默认保留,不自动删;删除只走非强制 \`git worktree remove\`,分支保留。
- **升级与迁移**:旧项目升级先跑 \`relay_sync\`(重投影入口 + 幂等补 .gitignore 运行时基线 + AGENTS 迁移指引);\`relay_onboard\` 保留既有 manifest 配置(worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover 等不被重置);claim 也会幂等补 .gitignore 基线。
- **registry fail-closed/恢复**:\`.relay/worktrees.json\` 损坏 → 完成出场/claim fail-closed 并提示备份或删除运行时注册表(不猜测受管状态);注册表缺失且目录是 linked worktree → 完成出场拒绝,可回 controlRoot 重新 \`relay_claim {worktree:true}\` 重建登记;cleanup 对未登记目录只报告不删。
- **协议写入 CAS**:claim/session_end 的 TASKS/LOG 写入带内容 CAS(读后写前重读比对哈希),冲突 → isError 且不写;锁防并发 relay 进程,CAS 防非协作写入者(人类手改/旧版本/TTL 接管窗口)。
- **锁心跳与崩溃恢复(两把锁语义不同)**:仓库写锁 \`.relay/relay.lock\` 约 20s 心跳续租 + 写前 fencing(长 cleanup/出场不被 120s stale 误判,写入前发现被接管则拒绝);任务认领锁 \`.relay/claims/T###.lock\` **刻意关闭心跳**,保留 240min TTL 崩溃恢复(agent 崩溃后到期可被其他模型接管);锁为 JSON v2(兼容旧文本),model 换行/控制字符由输入净化拒收。
- **尚未提供**:没有 claim 的 \`abort/release\`、没有按任务查询 \`status\` 的工具、没有 sessionId;可用恢复 = 认领锁 240min TTL 到期接管(可传 \`ttl_minutes\`)/ relay_session_end 出场释放 / relay_worktree_cleanup。并发会话必须用不同 model 标识(同名 model 无法区分持有者,会互锁)。
`;

/* ------------------------------ DISPATCH ------------------------------ */

// 工具名 → 引擎模块与实现函数(契约签名,全部 async → {content, isError?})
const ENGINE_OF = {
  relay_init: { module: './engines/bootstrap.mjs', fn: 'relayInit' },
  relay_onboard: { module: './engines/bootstrap.mjs', fn: 'relayOnboard' },
  relay_sync: { module: './engines/sync.mjs', fn: 'relaySync' },
  relay_verify: { module: './engines/verify.mjs', fn: 'relayVerify' },
  relay_session_start: { module: './engines/session.mjs', fn: 'relaySessionStart' },
  relay_session_end: { module: './engines/session.mjs', fn: 'relaySessionEnd' },
  relay_claim: { module: './engines/session.mjs', fn: 'relayClaim' },
  relay_restructure: { module: './engines/restructure.mjs', fn: 'relayRestructure' },
  relay_worktree_cleanup: { module: './engines/worktree.mjs', fn: 'relayWorktreeCleanup' },
  relay_doctor: { module: './engines/doctor.mjs', fn: 'relayDoctor' },
  relay_recall: { module: './engines/recall.mjs', fn: 'relayRecall' },
  relay_get: { module: './engines/recall.mjs', fn: 'relayGet' },
  relay_archive_log: { module: './engines/archive.mjs', fn: 'relayArchiveLog' },
};

const engineModuleCache = new Map();
const loadEngineModule = async (specifier) => {
  if (!engineModuleCache.has(specifier)) {
    engineModuleCache.set(specifier, import(specifier));
  }
  try {
    return await engineModuleCache.get(specifier);
  } catch (err) {
    engineModuleCache.delete(specifier); // 失败不缓存,补齐文件后无需重启
    throw err;
  }
};

const textResult = (text, isError = false) =>
  isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };

const engineUnavailable = (name, spec, err) => {
  const why = err && err.code === 'ERR_MODULE_NOT_FOUND'
    ? `engine 模块尚未就绪(W3/W4 并行开发中,集成者补齐即可):${spec.module}`
    : `engine 模块加载失败:${spec.module} — ${err && err.message ? err.message : String(err)}`;
  return textResult(
    `**${name} 暂不可用**\n\n- 原因: ${why}\n- 说明: rpc/契约层正常;该工具的实现由 engines 提供,文件补齐后重试即可。`,
    true,
  );
};

/**
 * dispatch(name, args) → MCP 工具结果 {content:[{type:'text',text}], isError?:bool}
 * 只补默认值(root 默认 process.cwd()),然后调用对应引擎;relay_rules 在本文件实现。
 * 永不抛错:一切失败都编码为 isError 结果。
 */
export const dispatch = async (name, args) => {
  const callArgs = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  if (typeof callArgs.root !== 'string' || callArgs.root === '') {
    callArgs.root = process.cwd();
  }

  if (name === 'relay_rules') {
    return textResult(RULES_TEXT);
  }

  const spec = ENGINE_OF[name];
  if (!spec) {
    return textResult(
      `未知工具: ${String(name)}\n\n可用工具: ${Object.keys(ENGINE_OF)
        .concat('relay_rules')
        .join(', ')}\n用 tools/list 查看完整定义。`,
      true,
    );
  }

  try {
    const mod = await loadEngineModule(spec.module);
    const fn = mod[spec.fn];
    if (typeof fn !== 'function') {
      return textResult(
        `**${name} 暂不可用**\n\n- 原因: ${spec.module} 未导出 ${spec.fn}(签名不符契约)`,
        true,
      );
    }
    const result = await fn(callArgs);
    // 防御性归一:引擎必须返回 {content:[{type:'text',text}], isError?}
    if (result && Array.isArray(result.content)) {
      return result;
    }
    return textResult(
      `**${name} 返回格式异常**\n\n- 引擎返回值缺少 content 数组,原样转述:\n${JSON.stringify(result) ?? String(result)}`,
      true,
    );
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      return engineUnavailable(name, spec, err);
    }
    if (err instanceof SyntaxError || (err && err.code && String(err.code).startsWith('ERR_MODULE'))) {
      return engineUnavailable(name, spec, err);
    }
    // 引擎内部的业务异常也转为 isError 工具结果,不让 server 断线
    return textResult(
      `**${name} 执行失败**\n\n- ${err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : String(err)}`,
      true,
    );
  }
};
