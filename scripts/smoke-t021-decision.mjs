#!/usr/bin/env node
// T021 验收断言(红灯协议):T018 检索寻址的收益复核结论必须落成 DECISIONS.md 条目,
// 且必须锚定**不可变证据**——只写「保留」两个字不算通过(protocol-eng 复核:审计痕迹 ≠ 证据)。
// 通过条件:标题含 T018 + 状态行 + 明确结论(保留/已回退) + 引用真实存在的 git sha + 可测复评阈值。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(path.join(root, 'DECISIONS.md'), 'utf8');
const blocks = text.split(/\n## /).slice(1);
const entry = blocks.find((b) => /T018/.test(b.split('\n')[0]));
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

if (!entry) {
  fail('DECISIONS.md 中没有标题含 T018 的决策条目。完成动作:写一条含理由/结论/状态的决策条目。');
}
if (!/状态:\s*(现行|已废弃)/.test(entry)) fail('T018 决策条目缺少「状态: 现行|已废弃」行。');
if (!/保留|已回退/.test(entry)) fail('T018 决策条目未给出明确结论(正文需含「保留」或「已回退」)。');

// 证据锚点 1:必须引用一个真实存在的提交 sha(git cat-file 反查)
const shas = [...entry.matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]);
const realSha = shas.find((s) => {
  const r = spawnSync('git', ['-C', root, 'cat-file', '-e', `${s}^{commit}`], { encoding: 'utf8' });
  return r.status === 0;
});
if (!realSha) fail('T018 决策条目未引用真实存在的 git 提交 sha(需引用 T017 的完成提交,脚本用 git 反查)。');

// 证据锚点 2:必须有可测的复评阈值
if (!/(LOG\s*[≥>=]+\s*\d+|阈值|条目数\s*[≥>=]+\s*\d+)/.test(entry)) {
  fail('T018 决策条目缺少可测的复评阈值(如「LOG ≥ 30 条时复评」)。');
}

console.log(`PASS: T018 收益复核已落成决策条目(证据 sha=${realSha.slice(0, 7)},含状态/结论/可测阈值)。`);
