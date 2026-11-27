// relay-mcp — src/config.mjs (补丁新增:manifest 配置面单一读取点)
// 设计铁律:本文件是「新增策略项」的唯一默认值来源,且每个默认值必须与补丁前
//   v1.0.0 的行为逐字符一致(=向后兼容底线)。任何新增项在 manifest 缺席时,
//   引擎走 DEFAULT_* 分支,行为与补丁前完全相同。
// 配置面全部落在 .relay/manifest.json(仓库属主任意文本即代码),不接受环境变量——
//   护栏若可被环境绕过,就不是护栏。
import { readFileSafe, assertNoSymlinkComponents, assertNotSymlinkFile, writeFileAtomic } from './util.mjs';
import { join } from 'node:path';

// —— 默认值(= v1.0.0 原值,勿随手改)——
export const DEFAULT_CODE_ROOTS = ['src', 'lib', 'app'];      // verify.mjs R5 的 /^(src|lib|app)\//
export const DEFAULT_DOCS_ROOTS = ['docs'];                    // verify.mjs R6 的 startsWith('docs/')
export const DEFAULT_COMMIT_TEMPLATE = 'relay: session end — {{task}}{{summary}}';
// 简报字符预算(T015 使用):超限只告警、不裁剪(裁剪=静默降级,违反公理)。
export const DEFAULT_CONTEXT_BUDGET = 6000;
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 180000;
// 抢救扫描默认值(T048):7 天窗口、单份 transcript 8 MiB 上限。两者都可在 manifest.rescue 覆盖。
export const DEFAULT_RESCUE_MAX_AGE_DAYS = 7;
export const DEFAULT_RESCUE_MAX_BYTES = 8 * 1024 * 1024;
// worktree 配置真值表(解析在 worktree.mjs readWorktreeConfig,本文件只放默认值):
//   enabled    只认 JSON 布尔 true;字符串 "true"、数字 1、其它真值一律视为 false(静默关闭);
//   cacheDir   只允许 controlRoot 内相对路径(绝对路径 / .. / 盘符 / 控制字符 / .git 前缀非法);
//   ttlHours   非有限数或负数 → 回退 24(不报错);
//   autoCleanup 只有显式 JSON 布尔 false 才关闭,缺省 true(拼错字段会被忽略并保持默认)。
// 说人话:配置拼错不会报错,只会静默失效(v1.7.0 起 relay_doctor 会点名未知键并给近似建议);
// 要改这里先同步 README/CONTRACT 的配置章节。
export const DEFAULT_WORKTREE_CONFIG = Object.freeze({
  enabled: false, cacheDir: '.relay/worktrees', ttlHours: 24, autoCleanup: true,
});

// —— manifest 已知键白名单(v1.7.0:doctor 点名拼错,不再纯静默)——
// 只用于诊断提示,不参与解析:解析仍按上面的铁律走默认值,行为零变化。
export const KNOWN_MANIFEST_KEYS = Object.freeze([
  'version', 'projectName', 'preset', 'entryFiles', 'allowedTopLevel', 'docsPhases', 'onboardedAt',
  'relayHome', 'restructuredAt', 'strictDocs', 'worktree', 'facts', 'acceptance',
  'commitMessageTemplate', 'autoCommit', 'entryFilesTakeover', 'codeRoots', 'docsRoots',
  'docsIgnore', 'protectedPaths', 'logBoundary', 'structure', 'contextBudget', 'rescue',
  'runtimeTopLevel',
]);
export const KNOWN_NESTED_KEYS = Object.freeze({
  worktree: ['enabled', 'cacheDir', 'ttlHours', 'autoCleanup'],
  facts: ['enabled', 'since', 'baselineSha', 'strict'],
  logBoundary: ['strict'],
  structure: ['strict'],
  acceptance: ['commands', 'timeoutMs'],
  rescue: ['sources', 'maxAgeDays', 'maxBytes', 'profiles', 'autoLaunch'],
});
export const KNOWN_DEEP_KEYS = Object.freeze({
  'rescue.autoLaunch': ['enabled', 'command', 'cwd', 'timeoutMs', 'maxOutputBytes'],
});
export const KNOWN_ARRAY_OBJECT_KEYS = Object.freeze({
  'rescue.sources': ['profile', 'root'],
  'rescue.profiles': ['id', 'title', 'kind', 'roots', 'filePattern', 'metaFile', 'fieldMap', 'tables', 'session', 'message', 'part', 'maxRows'],
  'rescue.profiles.tables': ['session', 'message', 'part'],
  'rescue.profiles.session': ['id', 'directory', 'parentId', 'title'],
  'rescue.profiles.message': ['sessionId', 'data', 'sequence', 'id'],
  'rescue.profiles.part': ['sessionId', 'messageId', 'data', 'sequence', 'id'],
});

// 收集 manifest 里的未知键(顶层 + 已知对象层级)。纯函数,不做 I/O。
export const collectUnknownManifestKeys = (m) => {
  const unknown = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return unknown;
  for (const k of Object.keys(m)) if (!KNOWN_MANIFEST_KEYS.includes(k)) unknown.push(k);
  for (const [parent, keys] of Object.entries(KNOWN_NESTED_KEYS)) {
    const obj = m[parent];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) unknown.push(`${parent}.${k}`);
    }
  }
  for (const [parent, keys] of Object.entries(KNOWN_DEEP_KEYS)) {
    const obj = parent.split('.').reduce((cur, key) => (
      cur && typeof cur === 'object' && !Array.isArray(cur) ? cur[key] : null
    ), m);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) unknown.push(`${parent}.${k}`);
    }
  }
  const collectArrayObjects = (arr, prefix, keys) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i += 1) {
      const obj = arr[i];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const k of Object.keys(obj)) if (!keys.includes(k)) unknown.push(`${prefix}[${i}].${k}`);
    }
  };
  const rescue = m.rescue && typeof m.rescue === 'object' && !Array.isArray(m.rescue) ? m.rescue : null;
  collectArrayObjects(rescue?.sources, 'rescue.sources', KNOWN_ARRAY_OBJECT_KEYS['rescue.sources']);
  if (Array.isArray(rescue?.profiles)) {
    collectArrayObjects(rescue.profiles, 'rescue.profiles', KNOWN_ARRAY_OBJECT_KEYS['rescue.profiles']);
    for (let i = 0; i < rescue.profiles.length; i += 1) {
      const spec = rescue.profiles[i];
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
      for (const nested of ['tables', 'session', 'message', 'part']) {
        const obj = spec[nested];
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        const keys = KNOWN_ARRAY_OBJECT_KEYS[`rescue.profiles.${nested}`];
        for (const k of Object.keys(obj)) {
          if (!keys.includes(k)) unknown.push(`rescue.profiles[${i}].${nested}.${k}`);
        }
      }
    }
  }
  return unknown.sort();
};


// —— .gitignore 基线(H3 + worktree 生命周期)——
// 密钥/私钥/认领锁/注册表/缓存目录不得入库。三个入口共用同一份基线:
//   init/onboard(bootstrap.mjs)、relay_sync(升级/修复入口)、relay_restructure(执行提交前)。
// 只追加缺失行,绝不删改用户条目;幂等。返回 { status:'created'|'appended'|'unchanged', added:string[] }。
export const GITIGNORE_BASELINE = Object.freeze([
  '.env', '.env.*', '*.key', '*.pem', 'node_modules/', '.DS_Store',
  '.relay/claims/', '.relay/relay.lock',
  '.relay/worktrees/', '.relay/worktrees.json',
  '.relay/last-failure.json',
  // 抢救接力单(T048):本机运行时状态,内含 transcript 副本与工作区快照锚点。
  // 必须忽略:.relay/** 是受保护路径,不忽略会让下一次出场触发护栏而拒绝提交。
  '.relay/rescue/',
  '*.relay-bak-*',
  'coverage/', '*.log',
]);

export const ensureGitignoreBaseline = async (root, extraLines = []) => {
  const extra = (Array.isArray(extraLines) ? extraLines : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().replace(/\\/g, '/'));
  const baseline = [...new Set([...GITIGNORE_BASELINE, ...extra])];
  const p = join(root, '.gitignore');
  // .gitignore 与 TASKS/LOG 同属会被自动写入的协议文件:符号链接可把基线写穿到仓库外。
  await assertNotSymlinkFile(p, '.gitignore');
  const cur = await readFileSafe(p, null);
  if (cur === null) {
    await writeFileAtomic(p, `${baseline.join('\n')}\n`, { label: '.gitignore' });
    return { status: 'created', added: baseline };
  }
  const have = new Set(cur.split('\n').map((s) => s.trim()).filter(Boolean));
  const missing = baseline.filter((b) => !have.has(b));
  if (!missing.length) return { status: 'unchanged', added: [] };
  await writeFileAtomic(p, `${cur.replace(/\s*$/, '')}\n${missing.join('\n')}\n`, { label: '.gitignore' });
  return { status: 'appended', added: missing };
};

// —— glob → RegExp(.gitignore 语义的一个够用子集)——
//   **  跨 '/' 匹配任意长度(独占一段时等价于「可省略该段」)
//   *   不跨 '/'      ?  单字符(不跨 '/')
//   刻意不支持 [] {} !( negation:护栏白名单不需要这些,少支持=少攻击面。
export const globToRegExp = (glob) => {
  const g = String(glob || '').replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') { i += 1; out += '(?:.*/)?'; }   // 'a/**' 命中 'a' 本身与 'a/x/y'
        else out += '.*';   // 末尾 '**'(后随非 '/')→ 宽松前缀:命中 'a' 起始的任何路径名含 'aXYZ'(语义即「a 及其下所有」,从宽)
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

// 路径是否落在任一 root 之下(R5/R6 用;等价于原正则 `^(root)/` 的前缀语义)
export const underRoots = (roots, p) =>
  roots.some((r) => p === r || String(p).startsWith(`${r}/`));

// ignore 命中判定:目录额外用 `dir/` 复测一次,让 'archive/**' 能剪掉 archive 目录本身
export const matchesIgnore = (ignores, rel, isDir = false) =>
  ignores.some(({ re }) => re.test(rel) || (isDir && re.test(`${rel}/`)));

const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

// 读 manifest 并归一全部策略项。缺失仍走默认值;损坏则返回 manifestCorrupt/manifestError,
// 由状态变更入口 fail-closed。只读诊断可继续检查,但绝不能把损坏误当成合法默认配置。
// manifest 可预解析传入(T022):runChecks 已经把 manifest.json 读/解析一次,
// 这里不再重复读盘——单轮 verify 对 manifest 的读取次数恒为 1。
export const readManifestConfig = async (root, { manifest: preloaded } = {}) => {
  let m = null;
  let manifestCorrupt = false;
  let manifestError = '';
  if (preloaded !== undefined) {
    m = preloaded;
  } else {
    const target = join(root, '.relay', 'manifest.json');
    try {
      await assertNoSymlinkComponents(root, '.relay', '.relay');
      await assertNotSymlinkFile(target, '.relay/manifest.json');
      const raw = await readFileSafe(target, null, { onlyMissing: true });
      if (raw != null) {
        const p = JSON.parse(raw);
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('应是 JSON 对象');
        m = p;
      }
    } catch (e) {
      manifestCorrupt = true;
      manifestError = `.relay/manifest.json 读取或解析失败(${e?.code || e?.name || '无效文件'})`;
    }
  }
  const codeRoots = strArr(m && m.codeRoots);
  const docsRoots = strArr(m && m.docsRoots);
  const docsIgnore = strArr(m && m.docsIgnore);
  const protectedPaths = strArr(m && m.protectedPaths);
  const acceptanceCmds = strArr(m && m.acceptance && m.acceptance.commands);
  const timeout = m?.acceptance?.timeoutMs;
  return {
    manifest: m,
    manifestCorrupt,
    manifestError,
    unknownManifestKeys: collectUnknownManifestKeys(m),
    codeRoots: codeRoots.length ? codeRoots : [...DEFAULT_CODE_ROOTS],
    docsRoots: docsRoots.length ? docsRoots : [...DEFAULT_DOCS_ROOTS],
    docsIgnore: docsIgnore.map((p) => ({ pattern: p, re: globToRegExp(p) })),
    protectedPaths: protectedPaths.map((p) => ({ pattern: p, re: globToRegExp(p) })),
    acceptanceCommands: acceptanceCmds,
    acceptanceTimeoutMs: Number.isInteger(timeout) && timeout > 0 && timeout <= 2147483647
      ? timeout : DEFAULT_ACCEPTANCE_TIMEOUT_MS,
    commitMessageTemplate:
      typeof (m && m.commitMessageTemplate) === 'string' && m.commitMessageTemplate.trim()
        ? m.commitMessageTemplate
        : DEFAULT_COMMIT_TEMPLATE,
    // autoCommit 默认 true = 补丁前的「自动提交」行为;只有 JSON 布尔 false 关闭(missing/undefined/其他一律 true)。
    // 改这行语义前先 grep 全部提交分支:session.mjs 出场绿闸/护栏跳过/autoCommit, restructure.mjs, bootstrap.mjs
    autoCommit: !(m && m.autoCommit === false),
    // entryFilesTakeover 默认 false = sync 不接管「已存在但无 relay 标记」的入口文件(非破坏)
    entryFilesTakeover: !!(m && m.entryFilesTakeover === true),
    // 事实底账(T013/R10):缺席 = 旧行为(不写事实行、R10 跳过);init/onboard 显式开启。
    // since 是「从哪一刻起要求事实行」(YYYY-MM-DD HH:mm,与 LOG 条目时间同格式,字典序即时间序):
    // 早于 since 的旧条目一律豁免,保证升级项目不被历史条目卡住。
    facts: {
      enabled: !!(m && m.facts && m.facts.enabled === true),
      since: m && m.facts && typeof m.facts.since === 'string' && m.facts.since.trim() ? m.facts.since.trim() : null,
      baselineSha: m && m.facts && typeof m.facts.baselineSha === 'string' && /^[0-9a-f]{40}$/.test(m.facts.baselineSha)
        ? m.facts.baselineSha : null,
    },
    // LOG 边界(T024/R12):活跃区行数/完成条目数超限 → WARN;strict 同 facts.strict 风格可升 ERROR。
    // 阈值固定(150 行 / 20 完成条目),不做可配置——避免"把阈值调大"成为消音手段。
    logBoundary: {
      strict: !!(m && m.logBoundary && m.logBoundary.strict === true),
    },
    // 协议结构(T031/R13):TASKS 任务行/LOG 条目标题契约违规 → WARN;strict 同 facts 风格可升 ERROR。
    structure: {
      strict: !!(m && m.structure && m.structure.strict === true),
    },
    // 简报字符预算(T015):非有限数/非正数 → 回退默认;不改变既有行为(只影响告警阈值)。
    contextBudget: m && Number.isFinite(m.contextBudget) && m.contextBudget > 0 ? m.contextBudget : DEFAULT_CONTEXT_BUDGET,
    // 抢救(T048/T058):来源描述符、扫描窗口与单份 transcript 上限。
    // 缺省 = 内置参考描述符 + 7 天 + 8 MiB;显式 sources 时只扫声明的来源。
    rescue: {
      // sources 每条可以是裸路径字符串,或 { profile?, root } 对象(声明式来源,默认空 = 不扫描)。
      sources: Array.isArray(m && m.rescue && m.rescue.sources)
        ? m.rescue.sources.filter((x) => typeof x === 'string' || (x && typeof x === 'object'))
        : [],
      // 自定义格式描述符(声明式;核心只依赖描述符接口,见 rescue-profiles.mjs)。
      profiles: Array.isArray(m && m.rescue && m.rescue.profiles)
        ? m.rescue.profiles.filter((x) => x && typeof x === 'object')
        : [],
      maxAgeDays: m && m.rescue && Number.isFinite(m.rescue.maxAgeDays) && m.rescue.maxAgeDays > 0
        ? Math.floor(m.rescue.maxAgeDays) : DEFAULT_RESCUE_MAX_AGE_DAYS,
      maxBytes: m && m.rescue && Number.isFinite(m.rescue.maxBytes) && m.rescue.maxBytes > 0
        ? Math.floor(m.rescue.maxBytes) : DEFAULT_RESCUE_MAX_BYTES,
      // T051:通用自动拉起。默认关闭;command 是 argv 数组(不经 shell),不绑定任何 harness。
      autoLaunch: m && m.rescue && m.rescue.autoLaunch && typeof m.rescue.autoLaunch === 'object'
        ? {
          enabled: m.rescue.autoLaunch.enabled === true,
          command: Array.isArray(m.rescue.autoLaunch.command) ? m.rescue.autoLaunch.command : [],
          cwd: typeof m.rescue.autoLaunch.cwd === 'string' ? m.rescue.autoLaunch.cwd : '',
          timeoutMs: Number.isFinite(m.rescue.autoLaunch.timeoutMs) && m.rescue.autoLaunch.timeoutMs > 0
            ? Math.floor(m.rescue.autoLaunch.timeoutMs) : 300000,
          maxOutputBytes: Number.isFinite(m.rescue.autoLaunch.maxOutputBytes) && m.rescue.autoLaunch.maxOutputBytes > 0
            ? Math.floor(m.rescue.autoLaunch.maxOutputBytes) : 1024 * 1024,
        }
        : { enabled: false, command: [], cwd: '', timeoutMs: 300000, maxOutputBytes: 1024 * 1024 },
    },
  };
};
