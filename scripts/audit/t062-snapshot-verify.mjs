#!/usr/bin/env node
// T062 独立复验探针 2:快照 porcelain -z 修复
// 复审指控:旧实现手工切分 porcelain 行,文件名含引号/反斜杠/换行/字面 " -> " 时
// 解析失配 → 该文件不进扫描面,但 `git add -A` 仍会暂存其内容 → 未扫描内容入对象库。
// 验证:文件名含 " -> " 且内容含密钥样式串时,capture 必须拒绝快照,且密钥不得进对象库。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(RELAY, 'src', 'cli.mjs');
const FIXTURES = path.join(RELAY, 'scripts', 'fixtures', 'rescue');
const cli = (root, tool, args = {}) => spawnSync(process.execPath, [CLI, tool, '--root', root, '--json', JSON.stringify(args)], { encoding: 'utf8', timeout: 300000 });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const git = (root, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
const tmpDirs = [];
const mkTmp = (t) => { const d = mkdtempSync(path.join(tmpdir(), `t062b-${t}-`)); tmpDirs.push(d); return d; };
const copyFixture = (name, destRoot, vars) => {
  const walk = (rel) => {
    const from = path.join(FIXTURES, name, rel);
    const to = path.join(destRoot, rel);
    if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); for (const e of readdirSync(from)) walk(path.join(rel, e)); return; }
    let text = readFileSync(from, 'utf8');
    for (const [k, v] of Object.entries(vars)) text = text.split(`<<${k}>>`).join(v);
    writeFileSync(to, text);
  };
  walk('');
};
const SECRET = 'AKIAIOSFODNN7EXAMPLE';

try {
  const repo = mkTmp('repo');
  const r0 = cli(repo, 'relay_init', { name: 'snap' });
  if (r0.status !== 0) throw new Error(out(r0).slice(0, 300));
  const H = mkTmp('home');
  copyFixture('zcode', path.join(H, 'zc'), { ROOT: repo });
  const mp = path.join(repo, '.relay', 'manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.rescue = { ...(m.rescue || {}), sources: [{ profile: 'zc-ref', root: path.join(H, 'zc', 'agents') }],
    profiles: [{ id: 'zc-ref', title: 'ref', kind: 'json-metadata', metaFile: 'metadata.json' }] };
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');

  // 三个刁钻文件名:字面箭头、带双引号、带反斜杠
  const names = ['weird -> name.txt', 'quo"te.txt', 'back\\slash.txt'];
  for (const n of names) writeFileSync(path.join(repo, n), `key=${SECRET}\n`);
  console.log('  造出待暂存文件:', names.join(' | '));

  const cap = cli(repo, 'relay_rescue', { action: 'capture', id: 'agent-zcode-ok', confirm: true });
  const txt = out(cap);
  console.log('  --- capture 完整输出(前 900 字)---');
  console.log(txt.slice(0, 900));
  console.log('  capture isError:', cap.status !== 0);
  console.log('  输出提到拒绝快照:', /拒绝|密钥/.test(txt));
  const note = txt.split('\n').filter((l) => /拒绝|密钥|快照/.test(l)).slice(0, 3).join(' | ');
  console.log('  输出片段:', note.slice(0, 400));

  // 密钥是否进了对象库?
  const objs = git(repo, 'cat-file', '--batch-all-objects', '--batch-check').stdout || '';
  let leaked = 0;
  for (const line of objs.split('\n')) {
    const sha = (line.split(' ')[0] || '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const body = git(repo, 'cat-file', '-p', sha).stdout || '';
    if (body.includes(SECRET)) leaked += 1;
  }
  console.log('  对象库里含密钥原文的 blob 数:', leaked, leaked ? '← 泄漏' : '(无泄漏)');
  // 是否有任何快照 ref 被建立
  const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/relay').stdout || '';
  console.log('  建立的快照 ref:', refs.trim() || '(无)');
  // 对照:同样文件名但不含密钥 → capture 必须成功(证明上一条不是因为别的原因失败)
  {
    const repo2 = mkTmp('ctrl');
    const r0 = cli(repo2, 'relay_init', { name: 'snap-ctrl' });
    const H2 = mkTmp('home2');
    copyFixture('zcode', path.join(H2, 'zc'), { ROOT: repo2 });
    const mp2 = path.join(repo2, '.relay', 'manifest.json');
    const m2 = JSON.parse(readFileSync(mp2, 'utf8'));
    m2.rescue = { ...(m2.rescue || {}), sources: [{ profile: 'zc-ref', root: path.join(H2, 'zc', 'agents') }],
      profiles: [{ id: 'zc-ref', title: 'ref', kind: 'json-metadata', metaFile: 'metadata.json' }] };
    writeFileSync(mp2, JSON.stringify(m2, null, 2) + '\n');
    writeFileSync(path.join(repo2, 'weird -> name.txt'), 'no secret here\n');
    const cap2 = cli(repo2, 'relay_rescue', { action: 'capture', id: 'agent-zcode-ok', confirm: true });
    console.log('  对照(同名文件但无密钥) capture isError:', cap2.status !== 0);
    console.log('  对照输出片段:', out(cap2).split('\n').filter((l) => /快照|接力单|失败/.test(l)).slice(0, 3).join(' | ').slice(0, 300));
  }
} catch (e) {
  console.log('FATAL', e && e.stack ? e.stack : e);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
