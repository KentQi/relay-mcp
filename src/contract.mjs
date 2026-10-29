// relay-mcp — src/contract.mjs (W2)
// 工具 / 资源 / 提示词的定义表 + dispatch。
// 本文件只做:定义(英文 description,陌生模型看描述即会)→ 参数默认值补齐 → 调 engines。
// 引擎(./engines/*.mjs)由 W3/W4 并行开发,采用懒加载 import:
// 缺失时 server 仍可启动,仅对应工具返回 isError 说明,便于集成前联调 rpc 层。
import path from 'node:path';
import { templatesDir, readFileSafe } from './util.mjs';

/* ------------------------------- TOOLS ------------------------------- */

const ROOT_DESC =
  'Project root directory (absolute or relative). Defaults to process.cwd() of the server.';

export const TOOLS = [
  {
    name: 'relay_init',
    description:
      'Bootstrap a brand-new project into the relay relay protocol (0→1). Instantiates every relay ' +
      'file from templates (START.md boot sector, SPEC.md, DECISIONS.md, TASKS.md, LOG.md, verify, ' +
      'entry files AGENTS.md/CLAUDE.md/GEMINI.md, .relay/manifest.json, docs/ five-phase skeleton) ' +
      'PLUS a code skeleton from the chosen preset (default "node": package.json + src/ + tests/ with ' +
      'a passing smoke test, so the project is green from commit zero). Available presets: node, ' +
      'minimal (relay layer only). Runs `git init` when needed and makes the first commit. ' +
      'Non-destructive: refuses with isError if START.md already exists unless force=true — in that ' +
      'case call relay_onboard instead. After a successful init, the next step in the protocol is ' +
      'relay_session_start.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        name: {
          type: 'string',
          description: 'Human-readable project name written into the scaffold (optional).',
        },
        preset: {
          type: 'string',
          description: 'Code skeleton preset: "node" (default; package.json + src/ + tests/ + green smoke test), "minimal" (relay layer only), or "none". Unknown values fall back to minimal with a note.',
        },
        force: {
          type: 'boolean',
          description: 'Allow overwriting an existing START.md (backup first). Default false.',
        },
      },
    },
  },
  {
    name: 'relay_onboard',
    description:
      'Adopt the relay relay protocol on an EXISTING project (1→10 / 10→100). Non-destructive merge: ' +
      'scans the repo, backs up any file it must touch (renamed <file>.relay-bak-<timestamp>, never ' +
      'deletes user files), unions allowedTopLevel with entries already present, records actual docs/ ' +
      'layout, installs core relay files + verify.sh + entry files + .gitignore baseline, then reports ' +
      'what changed. Existing manifest configuration is PRESERVED: onboard only reconciles ' +
      'version/projectName/entryFiles/allowedTopLevel/docsPhases/onboardedAt/relayHome and keeps ' +
      'worktree / autoCommit / acceptance / protectedPaths / entryFilesTakeover and any other custom ' +
      'keys untouched, so re-running it on an upgraded project never silently disables features. ' +
      'Prefer this over relay_init whenever the directory is not empty.',
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
      'Upgrade/repair entry point: regenerate AGENTS.md (always required) and the optional adapter entry ' +
      'files in manifest.entryFiles from the single source of truth, report drift, and idempotently append ' +
      'the .gitignore runtime baseline (`.relay/worktrees/`, `.relay/worktrees.json`, secrets, …) that older ' +
      'projects are missing. When an unmarked AGENTS.md blocks R1, the output contains the executable ' +
      'migration steps (relay_onboard takeover / entryFilesTakeover=true / manual marker). Run it after ' +
      'upgrading a project and after editing canonical spec content.',
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
      'MUST be the first call of every work session (step 1 of the six-step relay protocol — see ' +
      'resource relay://protocol). Returns an entry briefing: reads the five core files ' +
      '(START/SPEC/DECISIONS/TASKS/LOG), reconciles with git state (uncommitted changes, last commit), ' +
      'runs a fast verify, and proposes the first action — usually the topmost actionable task in ' +
      'TASKS.md or a red-light test left by the previous session to turn green.',
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
      'MUST be the last call of every work session (step 6 of the six-step protocol). Green gate: runs ' +
      'FULL verify first (controlRoot protocol checks plus executionRoot code checks when in a managed ' +
      'task worktree); only if all checks pass, and after the acceptance gate is green, does it write ' +
      'TASKS/LOG and commit. Two commits are made in a managed worktree: (1) executionRoot code commit on ' +
      'branch relay/T###, (2) controlRoot commit containing ONLY TASKS.md + LOG.md (message contains ' +
      '"T### 完成"). Both SHAs are reported; the task branch stays accepted but unmerged. If the code ' +
      'commit or the control-plane commit fails → isError, TASKS/LOG not marked done, claim lock kept, ' +
      're-run after fixing to finish. If verify is not green → isError + fix list + explicitly NOT ' +
      'committed. Handoff quality is the contract: fill `next` (title + acceptance a stranger can ' +
      'verify) and negative_results (things that do NOT work, so the next model does not retry them). ' +
      'Protected paths (verify script, .relay/**, tests) are never auto-committed — they need human ' +
      'approval.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        model: { type: 'string', description: 'Model/agent identifier. Must be unique per concurrent session: two sessions sharing one model id cannot prove ownership and will deadlock on claim locks, e.g. "claude-a" / "claude-b".' },
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
          description: 'Approaches proven NOT to work, so they are not retried (optional).',
        },
      },
      required: ['model', 'summary'],
    },
  },
  {
    name: 'relay_verify',
    description:
      'Run all repo checkers R1–R9 and return a | ID | 结果 | 详情 | table; every failure line starts ' +
      'with "修复:" followed by an executable fix instruction. Any error-level check → isError true. ' +
      'full=false (default) is the fast pass that skips R5/R6/R8 (commit atomicity, doc staleness, ' +
      'style); relay_session_end always runs the full set internally. Call this any time you want to ' +
      'know repo health or before handing off.',
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
      'Normalize an existing project\'s top-level layout toward the relay standard (code → src/, tests → ' +
      'tests/, tooling → scripts/). Conservative by design: only unambiguous code/test/tool dirs and ' +
      'loose root source/test files are moved; ambiguous entries (app/, server/, packages/, unknown) are ' +
      'listed for a human decision and never touched. Dry-run by default (returns the migration plan); ' +
      'confirm=true requires a clean git repo and executes with git mv (history preserved, rollback ' +
      'possible), amends the manifest whitelist, appends a DECISIONS entry, inserts a follow-up TASKS ' +
      'entry to fix import paths (that part is model work, gated by tests), logs to LOG.md and commits. ' +
      'Call after relay_onboard when you want the old project aligned to the standard skeleton.',
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
      'Parallel mode: claim a task in TASKS.md before starting work when multiple agents share one ' +
      'queue. Marks the task in-progress with your model name and timestamp in the trailing ' +
      'annotation, e.g. "- [~] T003 … (claude, 2026-09-29 14:05)", so two models never grab the same ' +
      'task. task is the ID like "T003". When worktree is enabled, also creates/reuses the managed task ' +
      'worktree `.relay/worktrees/T###` + branch `relay/T###` and returns controlRoot, executionRoot, ' +
      'branch, baseSha; edit code/tests in executionRoot and run relay_session_end there (it resolves ' +
      'controlRoot itself). Without a usable git HEAD (no git / unborn branch) worktree creation degrades ' +
      'to a single-root claim with a WARN instead of failing. Use a unique model id per concurrent ' +
      'session — two sessions with the same model id cannot prove claim ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        task: { type: 'string', description: 'Task ID to claim, e.g. "T003".' },
        model: { type: 'string', description: 'Model/agent identifier claiming the task.' },
        worktree: { type: 'boolean', description: 'Optional per-claim override. Default: manifest worktree.enabled. Only JSON boolean true in the manifest enables it: the string "true", 1 and other truthy values are silently treated as false, unknown/misspelled keys are silently ignored, an invalid ttlHours falls back to 24 and cacheDir must be a controlRoot-relative path. New init=true; onboard/legacy manifests=false.' },
      },
      required: ['task', 'model'],
    },
  },
  {
    name: 'relay_worktree_cleanup',
    description:
      'Inspect or clean expired relay-managed task worktrees. Dry-run by default; confirm=true removes only ' +
      'registered, inactive, clean, unlocked, expired paths inside the managed cache. "Clean" includes ' +
      'untracked AND ignored content checks: a worktree containing ignored local files (.env, node_modules, ' +
      'build output) is KEPT by default — never delete local secrets/deps automatically. Task branches are ' +
      'always preserved and listed; merging them stays a human decision. Never merges, rebases, pushes, or ' +
      'force-removes a worktree. There is no per-task status/abort/release subcommand: to recover, wait for ' +
      'the claim TTL, finish via relay_session_end, or clean expired worktrees here.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESC },
        confirm: { type: 'boolean', description: 'false/omitted = dry-run; true = execute safe removals.' },
        ttl_hours: { type: 'number', description: 'Optional expiration override in hours (default: manifest worktree.ttlHours, 24).' },
      },
    },
  },
  {
    name: 'relay_rules',
    description:
      'Return the R1–R9 rule table: which repo rules are machine-checked, what each checks, and where ' +
      'it is enforced (relay_verify / session_end green gate). Read this when a verify failure is ' +
      'unclear, or to see the whole rule set without running verify.',
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
   instruction it gives. In a managed worktree the gate checks controlRoot (R1–R9) and the
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

const RULES_TEXT = `# relay 规则表(R1–R9)

机检规则与执法点。任一 error 级规则失败 → relay_verify / relay_session_end 返回 isError:true;
每条失败详情以 \`修复:\` 开头,给出可执行指令。

| ID | 规则 | 机制 | 执法点 |
|---|---|---|---|
| R1 | AGENTS.md 必需且带 relay 标记 | AGENTS.md + manifest.entryFiles 其他入口逐个存在,首行含 \`<!-- relay:generated\`;entryFiles=[] 也不能豁免。修复:缺失→\`relay_sync\`;已存在无标记→\`relay_onboard\`(原正文包进 user-rules)、manifest \`entryFilesTakeover:true\` 后 \`relay_sync\`、或手工加标记 | relay_verify |
| R2 | 顶层结构白名单 | git ls-files 顶层条目 ⊆ manifest.allowedTopLevel;越界 → 修复:显式修宪(改 .relay/manifest.json) | relay_verify |
| R3 | docs 命名+frontmatter | docs/**/*.md(templates/archive 除外)匹配 \`^[0-9]{2}-(sow\\|prd\\|ard\\|test\\|delivery)?-.*-v\\d+\\.\\d+\\.md$\`,或宽松模式(frontmatter 含 title+status;onboard 项目记录宽松位) | relay_verify |
| R4 | 入口/START 无时变词 | AGENTS/CLAUDE/GEMINI/START 中 grep -E 'TODO\\|进行中\\|下周\\|待办:' 为空 | relay_verify |
| R5 | 提交原子性 | 最近 1 条 commit 触碰 (src\\|lib\\|app)/** 而未触碰 TASKS.md\\|LOG.md → warn(本地提示,不阻断) | relay_verify(full) |
| R6 | 文档 staleness | src 近 20 commit 有改动而 docs 0 改动 → warn | relay_verify(full) |
| R7 | 发散报警 | LOG 最近 3 条任务会话(task=维护 的条目不计入)task 均非「T### 完成」→ error:停机,升级人类仲裁 | relay_verify |
| R8 | 风格归一化 | 项目存在 prettier/eslint 配置或 package.json scripts.format → 提示运行;不存在 → skip(不强加工具链) | relay_verify(full) |
| R9 | LOG/TASKS 一致性 | LOG 最新条目 task=Txxx 完成 而 TASKS 中 Txxx 仍为未完成 → error | relay_verify / session_end 绿闸 |

补充:

- 检查输出:\`| ID | 结果 | 详情 |\` 表格 + 末尾汇总;fast 模式(full=false)跳过 R5/R6/R8。
- **双根检查**:受管 worktree 中 controlRoot 跑全量 R1–R9(协议面),executionRoot 跑代码向检查 R1/R2/R3/R4/R8(跳过 R7/R9,避免读任务分支里的旧协议副本);两侧 ERROR 合并阻断。**成对证据**:managed 完成还须同时具备任务分支代码提交、controlRoot 完成提交(消息含 \`T### 完成\`)、controlRoot 的 TASKS/LOG 已提交干净、LOG 记录 branch+代码 SHA;任一缺失 → isError、不落完成状态、可重跑补交。R5/R6 仍按 controlRoot 历史计算(任务分支提交不进入其窗口),跨分支评估留待后续。
- **绿闸与双提交**:relay_session_end 默认全量 verify,全绿且验收通过后 → 先在 executionRoot 提交代码(\`git add -A && git commit\`),成功后 controlRoot 只提交 \`TASKS.md\`+\`LOG.md\`(路径限定,提交信息含 \`T### 完成\`);输出两个 SHA(代码 SHA + 控制面 SHA)。controlRoot 提交失败 → isError + 保留认领锁,修复后重跑补交;\`autoCommit:false\` 时明确"控制面未提交"。
- **根错配 fail-closed(严格)**:任务在 registry 仍有未完成记录时,从 controlRoot 完成出场**一律 isError**「根错配」,须在 executionRoot 出场(无"干净空树"例外);注册表缺失/损坏/记录丢失时用 \`git worktree list\` 反查 \`relay/<task>\` checkout 与受管缓存路径 \`.relay/worktrees/<task>\` 是否存在,命中同样拒绝;分支单独存在不算痕迹。managed 出场 HEAD==baseSha 且无改动 → 拒绝伪 SHA。未登记 linked worktree:完成出场 fail-closed,维护出场仅告警。
- **未合并分支**:任务分支 \`relay/T###\` 验收通过 ≠ 已合并;claim/session_start/cleanup 会列出未合并分支,由人工 \`git merge --no-ff relay/T###\` 整合(relay 不自动 merge/rebase/push/删分支)。
- **受保护路径**:\`verify\`(脚本)、\`.relay/**\`、\`*/tests/**\`、\`*.test.*\`、\`*.spec.*\` —— session_end 检测到本会话改动这些文件时不自动 commit,输出"涉及受保护路径(护栏),需人类批准后手动提交"并列出文件。
- 降级:git 不存在或 commit 失败(无身份配置等)→ 文件照常更新,报告"提交跳过+原因",不置 isError;claim 在无可用 HEAD/git 时降级单根认领并 WARN。
- **worktree 配置真值表**:\`enabled\` 只认 JSON 布尔 \`true\`(字符串 \`"true"\`/数字 1 静默按 false);\`cacheDir\` 只允许 controlRoot 内相对路径(绝对路径/.. /盘符/控制字符/.git 前缀非法,在创建目录前校验);\`ttlHours\` 非数字回退 24;未知/拼错字段静默忽略;\`claim\` 的 \`worktree:true/false\` 可单次覆盖配置。
- **清理保护**:含未跟踪或 ignored 本地内容(\`.env\`、\`node_modules\`、构建产物)的 worktree 默认保留,不自动删;删除只走非强制 \`git worktree remove\`,分支保留。
- **升级与迁移**:旧项目升级先跑 \`relay_sync\`(重投影入口 + 幂等补 .gitignore 运行时基线 + AGENTS 迁移指引);\`relay_onboard\` 保留既有 manifest 配置(worktree/autoCommit/acceptance/protectedPaths/entryFilesTakeover 等不被重置);claim 也会幂等补 .gitignore 基线。
- **registry fail-closed/恢复**:\`.relay/worktrees.json\` 损坏 → 完成出场/claim fail-closed 并提示备份或删除运行时注册表(不猜测受管状态);注册表缺失且目录是 linked worktree → 完成出场拒绝,可回 controlRoot 重新 \`relay_claim {worktree:true}\` 重建登记;cleanup 对未登记目录只报告不删。
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
