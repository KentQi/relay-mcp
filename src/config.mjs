// relay-mcp — src/config.mjs (补丁新增:manifest 配置面单一读取点)
// 设计铁律:本文件是「新增策略项」的唯一默认值来源,且每个默认值必须与补丁前
//   v1.0.0 的行为逐字符一致(=向后兼容底线)。任何新增项在 manifest 缺席时,
//   引擎走 DEFAULT_* 分支,行为与补丁前完全相同。
// 配置面全部落在 .relay/manifest.json(仓库属主任意文本即代码),不接受环境变量——
//   护栏若可被环境绕过,就不是护栏。
import { readFileSafe } from './util.mjs';
import { join } from 'node:path';

// —— 默认值(= v1.0.0 原值,勿随手改)——
export const DEFAULT_CODE_ROOTS = ['src', 'lib', 'app'];      // verify.mjs R5 的 /^(src|lib|app)\//
export const DEFAULT_DOCS_ROOTS = ['docs'];                    // verify.mjs R6 的 startsWith('docs/')
export const DEFAULT_COMMIT_TEMPLATE = 'relay: session end — {{task}}{{summary}}';

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

// 读 manifest 并归一全部策略项。manifest 缺失/损坏 → 全部走默认(= 补丁前行为)。
export const readManifestConfig = async (root) => {
  const raw = await readFileSafe(join(root, '.relay', 'manifest.json'), null);
  let m = null;
  if (raw != null) {
    try { const p = JSON.parse(raw); if (p && typeof p === 'object') m = p; } catch { m = null; }
  }
  const codeRoots = strArr(m && m.codeRoots);
  const docsRoots = strArr(m && m.docsRoots);
  const docsIgnore = strArr(m && m.docsIgnore);
  const protectedPaths = strArr(m && m.protectedPaths);
  const acceptanceCmds = strArr(m && m.acceptance && m.acceptance.commands);
  return {
    manifest: m,
    codeRoots: codeRoots.length ? codeRoots : [...DEFAULT_CODE_ROOTS],
    docsRoots: docsRoots.length ? docsRoots : [...DEFAULT_DOCS_ROOTS],
    docsIgnore: docsIgnore.map((p) => ({ pattern: p, re: globToRegExp(p) })),
    protectedPaths: protectedPaths.map((p) => ({ pattern: p, re: globToRegExp(p) })),
    acceptanceCommands: acceptanceCmds,
    commitMessageTemplate:
      typeof (m && m.commitMessageTemplate) === 'string' && m.commitMessageTemplate.trim()
        ? m.commitMessageTemplate
        : DEFAULT_COMMIT_TEMPLATE,
    // autoCommit 默认 true = 补丁前的「自动提交」行为;只有 JSON 布尔 false 关闭(missing/undefined/其他一律 true)。
    // 改这行语义前先 grep 全部提交分支:session.mjs 出场绿闸/护栏跳过/autoCommit, restructure.mjs, bootstrap.mjs
    autoCommit: !(m && m.autoCommit === false),
    // entryFilesTakeover 默认 false = sync 不接管「已存在但无 relay 标记」的入口文件(非破坏)
    entryFilesTakeover: !!(m && m.entryFilesTakeover === true),
  };
};