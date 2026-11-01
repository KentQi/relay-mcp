#!/usr/bin/env node
// T021 验收断言(红灯协议):T018 检索寻址的收益复核结论必须落成 DECISIONS.md 条目。
// 本脚本在结论落地前**故意失败** —— T021 的完成动作 = 追加决策条目(保留 / 已回退 + 理由 + 状态)。
// 取数不可行的那部分(调用次数)不冒充机检:它只作为决策理由的人工依据写进条目正文。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(path.join(root, 'DECISIONS.md'), 'utf8');
const blocks = text.split(/\n## /).slice(1); // 每个决策条目以 "## " 开头
const entry = blocks.find((b) => /T018/.test(b.split('\n')[0]));

if (!entry) {
  console.error('FAIL: DECISIONS.md 中没有标题含 T018 的决策条目。');
  console.error('T021 的完成动作:把检索寻址(T018)的收益复核结论写成一条决策条目(标题含 T018,正文含理由与「保留」/「已回退」,并给出状态)。');
  process.exit(1);
}
if (!/状态:\s*(现行|已废弃)/.test(entry)) {
  console.error('FAIL: T018 决策条目缺少「状态: 现行|已废弃」行。');
  process.exit(1);
}
if (!/保留|已回退/.test(entry)) {
  console.error('FAIL: T018 决策条目未给出明确结论(正文需含「保留」或「已回退」)。');
  process.exit(1);
}
console.log('PASS: T018 收益复核结论已落成决策条目(含状态与明确结论)。');
