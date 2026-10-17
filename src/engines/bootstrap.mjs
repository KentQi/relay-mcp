// relay-mcp · W3 引导引擎 — relay_init / relay_onboard
// 依据 CONTRACT.md「仓库文件格式」「安全与降级」「工具清单」:
// - 模板运行时从 templates/ 逐个实例化,占位符 {{PROJECT_NAME}}/{{TODAY}}/__RELAY_HOME__ 由本引擎替换,
//   .tpl 去后缀落盘;映射:verify.sh → verify(可执行),workflow-relay.yml → .github/workflows/;
// - 非破坏:init 撞已有 START.md 且无 force → 拒绝并提示 relay_onboard;onboard 对已存在文件
//   一律不删,改写前先 backupFile;核心五件(START/SPEC/DECISIONS/TASKS/LOG)已存在的完全不碰;
// - manifest 按 CONTRACT schema;allowedTopLevel = 实际顶层 ∪ 契约默认(排除 .git);
// - git:init 未 init 则先 git init,再 add -A + commit;onboard 仅在已是仓库时提交。
//   任何 git 失败一律降级为报告说明,不置 isError;
// - 输出:简洁 markdown,中文标签,路径相对 root。
// 零依赖:仅 node: 内置。

import { basename, dirname, join, relative, resolve } from 'node:path';
import { access, chmod, readdir, writeFile } from 'node:fs/promises';
import {
  backupFile, ensureDir, findSensitiveChanges, gitIdentityArgs, gitRun, isGitRepo, nowIso,
  readFileSafe, stamp, templatesDir, writeFileIfAbsent,
} from '../util.mjs';
import { generateEntryFiles } from './sync.mjs';

const CORE_FILES = ['START.md', 'SPEC.md', 'DECISIONS.md', 'TASKS.md', 'LOG.md'];
const ENTRY_TPLS = new Set(['AGENTS.md.tpl', 'CLAUDE.md.tpl', 'GEMINI.md.tpl']);
const DEFAULT_ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const DEFAULT_ALLOWED_TOP_LEVEL = [
  'src', 'docs', 'scripts', 'tests', '.relay', '.github',
  'README.md', 'SPEC.md', 'DECISIONS.md', 'TASKS.md', 'LOG.md', 'START.md',
  'verify', 'package.json', '.gitignore', '.editorconfig',
];
const DEFAULT_DOCS_PHASES = ['01-sow', '02-prd', '03-ard', '04-test', '05-delivery', 'archive', 'templates'];

const ok = (text) => ({ content: [{ type: 'text', text }], isError: false });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

const pathExists = async (p) => {
  try { await access(p); return true; } catch { return false; }
};

const firstLine = (s) => (String(s || '').trim().split('\n')[0] || '').slice(0, 160);

const relOf = (root, p) => (p ? relative(root, p) : '');

const render = (raw, vars) => raw
  .replaceAll('{{PROJECT_NAME}}', vars.projectName)
  .replaceAll('{{TODAY}}', vars.today)
  .replaceAll('__RELAY_HOME__', vars.relayHome);

// 模板相对路径 → 目标相对路径(特殊映射集中在这里)
const mapTemplatePath = (rel) => {
  if (rel === 'verify.sh') return { target: 'verify', executable: true };
  if (rel === 'workflow-relay.yml') return { target: '.github/workflows/workflow-relay.yml', executable: false };
  if (rel.endsWith('.tpl')) return { target: rel.slice(0, -4), executable: false };
  return { target: rel, executable: false };
};

// 递归列出 templates/ 内容(按名排序,保证报告顺序稳定);rel 使用 '/'
const walkTemplates = async (dir, base = '', out = []) => {
  const dirents = (await readdir(dir, { withFileTypes: true }))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push({ rel, isDir: true });
      await walkTemplates(join(dir, d.name), rel, out);
    } else if (d.isFile()) {
      out.push({ rel, isDir: false });
    }
  }
  return out;
};

const listTop = async (root) => {
  try { return (await readdir(root, { withFileTypes: true })).map((d) => d.name); }
  catch { return null; }
};

// docs 布局:是否存在 + 直接子目录名(排序);不存在时 phases 为 null
const docsLayout = async (root) => {
  const docsDir = join(root, 'docs');
  if (!(await pathExists(docsDir))) return { exists: false, phases: null };
  try {
    const phases = (await readdir(docsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    return { exists: true, phases };
  } catch {
    return { exists: true, phases: null };
  }
};

// 契约默认 ∪ 入口文件 ∪ 实际顶层(排除 .git);默认在前、附加项按字典序,结果确定。
// 入口文件必须显式并入:onboard 的顶层扫描发生在入口生成之前,漏并则首次 R2 即误红
const mergeAllowed = (topNames) => {
  const seen = new Set([...DEFAULT_ALLOWED_TOP_LEVEL, ...DEFAULT_ENTRY_FILES]);
  const extras = [];
  for (const n of topNames || []) {
    if (n === '.git' || seen.has(n)) continue;
    seen.add(n);
    extras.push(n);
  }
  extras.sort();
  return [...DEFAULT_ALLOWED_TOP_LEVEL, ...DEFAULT_ENTRY_FILES, ...extras];
};

const readManifest = async (root) => {
  const raw = await readFileSafe(join(root, '.relay', 'manifest.json'), null);
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
};

const safeGit = async (root, ...args) => {
  try { return await gitRun(root, ...args); }
  catch (e) { return { ok: false, stdout: '', stderr: (e && e.message) || String(e) }; }
};

// 统一的提交流:可选 git init → add -A → commit;任何失败降级为说明行,绝不抛错。
// 无身份环境(CI 容器)自动注入仅本条命令生效的 -c 兜底身份,见 util.gitIdentityArgs。
const gitCommitFlow = async (root, needInit, message) => {
  const lines = [];
  if (needInit) {
    const r = await safeGit(root, 'init');
    if (!r.ok) {
      lines.push(`git init 失败,跳过版本化:${firstLine(r.stderr)}`);
      return lines;
    }
    lines.push('已初始化 git 仓库');
  }
  // 密钥安检(H-B):与 session_end 同一条规则——工作区有疑似密钥/私钥文件,拒绝自动入库,转人工
  const stSec = await safeGit(root, '-c', 'core.quotePath=false', 'status', '--porcelain');
  const sens = stSec.ok ? findSensitiveChanges(stSec.stdout.split('\n')) : [];
  if (sens.length) {
    lines.push(`提交跳过:发现疑似密钥/敏感文件,拒绝卷入 git 历史(需人工处理后再提交):${sens.slice(0, 3).map((s) => s.path).join(', ')}${sens.length > 3 ? ` 等 ${sens.length} 项` : ''}`);
    return lines;
  }
  const add = await safeGit(root, 'add', '-A');
  if (!add.ok) {
    lines.push(`提交跳过:git add 失败(${firstLine(add.stderr)})`);
    return lines;
  }
  const fallback = await gitIdentityArgs(root);
  // 注入参数必须在子命令之前:git -c k=v commit -m …(git commit -c 是"复用消息",另一回事)
  const c = await safeGit(root, ...fallback, 'commit', '-m', message);
  if (c.ok) {
    lines.push(fallback.length ? `已提交(引擎注入了临时提交身份 relay-bot@localhost,未写入全局配置):${message}` : `已提交:${message}`);
  } else {
    lines.push(`提交跳过:${firstLine(c.stderr)}(文件已全部写入,不受影响;可稍后手工提交)`);
  }
  return lines;
};

// 实例化单个模板文件到 root/target:缺失→写;已存在→保留(无 force)或备份后重写(force)
const writeTemplatedFile = async ({ tdir, rel, target, root, vars, force, executable }) => {
  const raw = await readFileSafe(join(tdir, rel), null);
  if (raw === null) return { status: 'skipped', target };
  const content = render(raw, vars);
  const dest = join(root, target);
  if (await writeFileIfAbsent(dest, content)) {
    if (executable) await chmod(dest, 0o755).catch(() => {});
    return { status: 'created', target };
  }
  if (!force) return { status: 'kept', target };
  const backup = await backupFile(dest);
  await writeFile(dest, content, 'utf8');
  if (executable) await chmod(dest, 0o755).catch(() => {});
  return { status: 'rewritten', target, backup };
};

const bullet = (items) => (items.length ? items.map((f) => `- \`${f}\``) : ['- (无)']);

// .gitignore 基线(H3):密钥/私钥/认领锁/杂物不得进 git;已存在则只补缺失行,绝不删改用户条目
const GITIGNORE_BASELINE = ['.env', '.env.*', '*.key', '*.pem', 'node_modules/', '.DS_Store', '.relay/claims/', '.relay/relay.lock', 'coverage/', '*.log'];
const ensureGitignore = async (root) => {
  const p = join(root, '.gitignore');
  const cur = await readFileSafe(p, null);
  if (cur === null) {
    await writeFile(p, `${GITIGNORE_BASELINE.join('\n')}\n`, 'utf8');
    return '.gitignore(新建,密钥/杂物基线)';
  }
  const have = new Set(cur.split('\n').map((s) => s.trim()).filter(Boolean));
  const missing = GITIGNORE_BASELINE.filter((b) => !have.has(b));
  if (!missing.length) return null;
  await writeFile(p, `${cur.replace(/\s*$/, '')}\n${missing.join('\n')}\n`, 'utf8');
  return `.gitignore(补 ${missing.length} 条基线:${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})`;
};

// ---------------------------------------------------------------------------
// relay_init:0→1 建仓
// args: { root?: string, name?: string, force?: bool }
// ---------------------------------------------------------------------------
export const relayInit = async (args = {}) => {
  const a = args || {};
  const root = resolve(a.root || process.cwd());
  const force = a.force === true;
  try {
    // 1) 非破坏闸门:已有 START.md 且无 force → 拒绝,引导去 relay_onboard
    if (!force && (await pathExists(join(root, 'START.md')))) {
      return err([
        '已存在 `START.md`,拒绝初始化(非破坏闸门)。',
        '- 该目录已有项目内容:请改用 relay_onboard(扫描→非破坏合并,永不删除)',
        '- 确要重铺脚手架:请传 force:true(已存在文件将先备份为 *.relay-bak-* 再重写)',
      ].join('\n'));
    }

    const tdir = templatesDir();
    let plan;
    try { plan = await walkTemplates(tdir); }
    catch (e) {
      return err(`模板目录不可读:${tdir}(${firstLine(e && e.message)})。relay-mcp 安装不完整(templates/ 缺失)。`);
    }

    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : basename(root);
    const vars = { projectName: name, today: stamp().slice(0, 10), relayHome: dirname(tdir) };
    await ensureDir(root);

    // 2) 实例化非入口模板(入口三件交给 generateEntryFiles)
    const created = [];
    const kept = [];
    const rewritten = [];
    const notes = [];
    for (const item of plan) {
      if (ENTRY_TPLS.has(item.rel)) continue;
      if (item.rel === 'presets' || item.rel.startsWith('presets/')) continue; // preset 走单独通道
      const { target, executable } = mapTemplatePath(item.rel);
      if (item.isDir) {
        await ensureDir(join(root, target));
        continue;
      }
      await ensureDir(dirname(join(root, target)));
      const r = await writeTemplatedFile({ tdir, rel: item.rel, target, root, vars, force, executable });
      if (r.status === 'created') created.push(target);
      else if (r.status === 'kept') kept.push(target);
      else if (r.status === 'rewritten') rewritten.push(r);
    }
    if (!plan.some((p) => !p.isDir)) {
      notes.push('templates/ 内没有模板文件:仅写入 manifest 与 git 记录(relay-mcp 安装可能不完整)');
    }

    const entry = await generateEntryFiles(root, { mode: 'init', force, projectName: name });
    if (entry.kept.length && !force) {
      notes.push('入口文件已存在且未改动:若这是既有项目,建议改用 relay_onboard 完成非破坏接入');
    }

    // 2.5) preset 代码骨架:新项目交付即含标准结构(src/tests/…),不留给模型自由发挥
    const slug = (s) => String(s).toLowerCase().trim()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
    const reqPreset = typeof a.preset === 'string' && a.preset.trim()
      ? a.preset.trim().toLowerCase() : 'node';
    const presetTop = join(tdir, 'presets');
    let preset = reqPreset;
    let presetDir = join(presetTop, preset);
    let available = [];
    try {
      available = (await readdir(presetTop, { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch { /* presets/ 不存在 */ }
    const presetFiles = [];
    if (preset === 'none' || preset === 'minimal') {
      notes.push(`preset=${preset}:仅接力层,不建代码骨架`);
    } else if (!available.includes(preset)) {
      notes.push(`preset="${preset}" 不存在(可用:${available.join(', ') || '无'}),回退 minimal:仅接力层`);
      preset = 'minimal';
      presetDir = join(presetTop, preset);
    } else {
      const pplan = await walkTemplates(presetDir);
      for (const item of pplan) {
        // walkTemplates 以 presetDir 为根,rel 已是相对 preset 的路径,直接作 target;
        // 读模板时再拼回 templates 根的完整相对路径
        const target = item.rel;
        if (item.isDir) { await ensureDir(join(root, target)); continue; }
        await ensureDir(dirname(join(root, target)));
        // package.json 的 name 字段要求 URL 安全,中文项目名转 slug;其余占位照常
        const pvars = target === 'package.json' ? { ...vars, projectName: slug(name) } : vars;
        const r = await writeTemplatedFile({ tdir, rel: `presets/${preset}/${item.rel}`, target, root, vars: pvars, force, executable: false });
        if (r.status === 'created') { created.push(target); presetFiles.push(target); }
        else if (r.status === 'kept') kept.push(target);
        else if (r.status === 'rewritten') rewritten.push(r);
      }
    }

    // 3) manifest(按契约 schema;allowedTopLevel = 默认 ∪ 实际顶层,兜住 init 前已有的杂项)
    const giNote = await ensureGitignore(root);
    if (giNote) created.push(giNote);
    const top = (await listTop(root)) || [];
    const manifest = {
      version: 1,
      projectName: name || basename(root),
      preset,
      entryFiles: [...DEFAULT_ENTRY_FILES],
      allowedTopLevel: mergeAllowed(top),
      docsPhases: [...DEFAULT_DOCS_PHASES],
      onboardedAt: nowIso(),
      relayHome: dirname(tdir),
    };
    await ensureDir(join(root, '.relay'));
    const manifestRel = '.relay/manifest.json';
    const manifestPath = join(root, manifestRel);
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    if (await writeFileIfAbsent(manifestPath, manifestJson)) created.push(manifestRel);
    else if (force) {
      const backup = await backupFile(manifestPath);
      await writeFile(manifestPath, manifestJson, 'utf8');
      rewritten.push({ target: manifestRel, backup });
    } else kept.push(manifestRel);

    // 4) git(失败降级,不置 isError)
    const gitLines = await gitCommitFlow(root, !isGitRepo(root), 'relay: init project');

    // 5) 报告
    const L = [
      `## relay:init — ${name}`,
      '',
      `### 新建(${created.length + entry.created.length})`,
      ...bullet([...created, ...entry.created]),
      '',
      `### 保留(已存在,未改动)(${kept.length + entry.kept.length})`,
      ...bullet([...kept, ...entry.kept.map((k) => k.file)]),
    ];
    if (rewritten.length || entry.rewritten.length) {
      L.push('', `### 备份后重写(force)(${rewritten.length + entry.rewritten.length})`);
      for (const r of [...rewritten, ...entry.rewritten]) {
        L.push(`- \`${r.target || r.file}\`(原文件:\`${relOf(root, r.backup)}\`)`);
      }
    }
    if (notes.length || entry.notes.length) {
      L.push('', '### 说明', ...[...notes, ...entry.notes].map((n) => `- ${n}`));
    }
    L.push(
      '',
      '### git',
      ...gitLines.map((l) => `- ${l}`),
      '',
      '### 下一步',
      '1. 读 `START.md`(引导扇区,一页以内:跑 verify → 读 TASKS 顶部 → 按协议干)',
      '2. 运行 `./verify`(需 Node >= 18)确认环境可用',
      ...(presetFiles.includes('tests/smoke.test.js')
        ? ['3. 跑 `npm test`(等价 `node --test`):骨架交付即全绿,是后续一切改动的基线',
           '4. 调用 `relay_session_start` 开始首个会话']
        : ['3. 调用 `relay_session_start` 开始首个会话']),
    );
    return ok(L.join('\n'));
  } catch (e) {
    return err(`relay_init 执行失败:${firstLine(e && e.message) || String(e)}`);
  }
};

// ---------------------------------------------------------------------------
// relay_onboard:老项目接入(非破坏铁律:备份不删除,已存在核心件完全不碰)
// args: { root?: string }
// ---------------------------------------------------------------------------
export const relayOnboard = async (args = {}) => {
  const root = resolve((args && args.root) || process.cwd());
  try {
    if (!(await pathExists(root))) return err(`目录不存在或不可访问:${root}`);
    const tdir = templatesDir();

    // 1) 扫描
    const git = isGitRepo(root);
    const top = (await listTop(root)) || [];
    const docs = await docsLayout(root);
    const existed = {
      'AGENTS.md': await pathExists(join(root, 'AGENTS.md')),
      'CLAUDE.md': await pathExists(join(root, 'CLAUDE.md')),
      'GEMINI.md': await pathExists(join(root, 'GEMINI.md')),
      'README.md': await pathExists(join(root, 'README.md')),
      verify: await pathExists(join(root, 'verify')),
    };
    const vars = { projectName: basename(root), today: stamp().slice(0, 10), relayHome: dirname(tdir) };

    // 2) 核心五件:writeFileIfAbsent;已存在的一律不碰(提示人工合并)
    const created = [];
    const keptCore = [];
    const notes = [];
    for (const f of CORE_FILES) {
      const raw = await readFileSafe(join(tdir, f), null);
      if (raw === null) {
        notes.push(`templates/${f} 缺失,\`${f}\` 未生成`);
        continue;
      }
      if (await writeFileIfAbsent(join(root, f), render(raw, vars))) created.push(f);
      else keptCore.push(f);
    }

    // 3) 入口文件:AGENTS.md 接管(备份+顶部插入标记与指引);CLAUDE/GEMINI 仅缺失时生成
    const entry = await generateEntryFiles(root, { mode: 'onboard', projectName: vars.projectName });

    // 4) verify 脚本:已存在 → 保留;缺失 → 实例化(占位替换 + 可执行)
    let keptVerify = false;
    if (existed.verify) {
      keptVerify = true;
    } else {
      const raw = await readFileSafe(join(tdir, 'verify.sh'), null);
      if (raw === null) notes.push('templates/verify.sh 缺失,`verify` 未生成');
      else {
        await writeFile(join(root, 'verify'), render(raw, vars), 'utf8');
        await chmod(join(root, 'verify'), 0o755).catch(() => {});
        created.push('verify');
      }
    }

    // 5) manifest:allowedTopLevel = 实际顶层 ∪ 默认;docsPhases = 实际 docs 布局或默认
    const giNote = await ensureGitignore(root);
    if (giNote) created.push(giNote);
    const docsPhases = docs.exists && Array.isArray(docs.phases) && docs.phases.length
      ? docs.phases : [...DEFAULT_DOCS_PHASES];
    const oldManifest = await readManifest(root);
    const entryFiles = [...DEFAULT_ENTRY_FILES];
    const oldEntries = oldManifest && Array.isArray(oldManifest.entryFiles)
      ? oldManifest.entryFiles : [];
    for (const f of oldEntries) {
      if (typeof f === 'string' && f && !entryFiles.includes(f)) entryFiles.push(f);
    }
    const manifest = {
      version: 1,
      projectName: basename(root),
      entryFiles,
      allowedTopLevel: mergeAllowed(top),
      docsPhases,
      onboardedAt: nowIso(),
      relayHome: dirname(tdir),
    };
    await ensureDir(join(root, '.relay'));
    const manifestPath = join(root, '.relay', 'manifest.json');
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    let manifestBackup = null;
    if (await writeFileIfAbsent(manifestPath, manifestJson)) created.push('.relay/manifest.json');
    else {
      manifestBackup = await backupFile(manifestPath);
      await writeFile(manifestPath, manifestJson, 'utf8');
    }

    // 6) git(仅已是仓库时提交;失败降级)
    const gitLines = git
      ? await gitCommitFlow(root, false, 'relay: onboard existing project')
      : ['非 git 仓库,提交跳过(文件已全部写入;如需版本化请先 git init,再重跑 relay_onboard 或手工提交)'];

    // 7) 报告:发现什么 / 建了什么 / 保留了什么 / 需人工注意什么
    const attention = [];
    if (keptCore.length) {
      attention.push(`已存在 ${keptCore.map((f) => `\`${f}\``).join('、')}:relay 完全未改动;建议人工把 relay 协议要点(开工读 START.md → 按 TASKS 干 → 收尾 relay_session_end)合并进去`);
    }
    for (const k of entry.kept) {
      if (k.file === 'AGENTS.md') attention.push(`\`AGENTS.md\` 已带 relay 标记,视为已接管,未改动`);
      else if (k.reason.startsWith('已存在')) attention.push(`\`${k.file}\` 已存在,未接管;如需统一入口,请人工改为指向 \`AGENTS.md\` 的指针(参考 templates/${k.file}.tpl)`);
    }
    for (const r of entry.rewritten) {
      attention.push(`\`${r.file}\` 已被接管:原文件备份于 \`${relOf(root, r.backup)}\`,新文件 = relay 标记 + 「开工前先读 ./START.md」 + 原正文`);
    }
    if (manifestBackup) attention.push(`原 \`.relay/manifest.json\` 已备份(\`${relOf(root, manifestBackup)}\`)后重写为合并结果`);
    if (keptVerify) attention.push('`verify` 已存在,未覆盖;如需 relay 托管请人工核对(模板见 templates/verify.sh)');
    if (docs.exists) {
      if (docsPhases.length && JSON.stringify(docsPhases) !== JSON.stringify(DEFAULT_DOCS_PHASES)) {
        attention.push(`docs/ 已有布局(${docsPhases.join('、')})已按实际记入 manifest.docsPhases;R3 将按已有项目宽松模式对待`);
      }
    } else {
      notes.push('docs/ 不存在:onboard 不主动铺文档骨架;docsPhases 已记默认五件套,日后可人工创建');
    }
    if (!top.filter((n) => n !== '.git').length) {
      notes.push('目录为空:这种情况通常更适合 relay_init(本次 onboard 结果与 init 等效)');
    }

    const scan = [
      `- git 仓库:${git ? '是' : '否'}`,
      `- 顶层条目 ${top.length} 个:${top.length ? top.slice(0, 12).join('、') + (top.length > 12 ? ` …等` : '') : '(空)'}`,
      `- docs/:${docs.exists ? `已存在${docs.phases && docs.phases.length ? `(子目录:${docs.phases.join('、')})` : '(无子目录)'}` : '不存在'}`,
      `- 已有入口/说明文件:${Object.entries(existed).filter(([, v]) => v).map(([k]) => k).join('、') || '无'}`,
    ];

    const keptOther = [...entry.kept.map((k) => k.file), ...(keptVerify ? ['verify'] : [])];
    const L = [
      `## relay:onboard — ${basename(root)}`,
      '',
      '### 现状扫描',
      ...scan,
      '',
      `### 新建(${created.length})`,
      ...bullet(created),
      '',
      `### 保留现状(未改动)(${keptCore.length + keptOther.length})`,
      ...bullet([...keptCore, ...keptOther]),
    ];
    if (entry.rewritten.length) {
      L.push('', `### 备份后接管(${entry.rewritten.length})`);
      for (const r of entry.rewritten) {
        L.push(`- \`${r.file}\` → 原文件备份于 \`${relOf(root, r.backup)}\`;新文件顶部为 relay 标记 + 「开工前先读 ./START.md」,正文为原内容`);
      }
    }
    if (notes.length || entry.notes.length) {
      L.push('', '### 说明', ...[...notes, ...entry.notes].map((n) => `- ${n}`));
    }
    L.push('', '### git', ...gitLines.map((l) => `- ${l}`));
    if (attention.length) L.push('', '### 需人工注意', ...attention.map((t) => `- ${t}`));
    L.push(
      '',
      '### 下一步',
      '1. 处理上方「需人工注意」条目(如有)',
      '2. 读 `START.md`(新建的或原有的)确认协议',
      '3. 调用 `relay_session_start` 开始会话',
    );
    return ok(L.join('\n'));
  } catch (e) {
    return err(`relay_onboard 执行失败:${firstLine(e && e.message) || String(e)}`);
  }
};
