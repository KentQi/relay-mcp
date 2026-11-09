#!/usr/bin/env node
// v1.7.0 上下文预算回归:tools/list 是每个会话都要付出的固定成本,
// 规则条文应留在 relay_rules / relay://protocol(按需读取),不膨胀工具描述。
// 预算 = 10 KiB(UTF-8). 超了要么压缩描述,要么把内容搬进资源,不允许悄悄涨。
import { TOOLS, RESOURCES, dispatch } from '../src/contract.mjs';

const BUDGET_BYTES = 10240;
const EXPECTED_TOOLS = [
  'relay_init', 'relay_onboard', 'relay_sync', 'relay_session_start', 'relay_session_end',
  'relay_verify', 'relay_restructure', 'relay_claim', 'relay_worktree_cleanup', 'relay_archive_log',
  'relay_recall', 'relay_get', 'relay_doctor', 'relay_rules',
];

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};

try {
  console.log('== tools/list 体积预算 ==');
  const payload = JSON.stringify({ tools: TOOLS });
  const bytes = Buffer.byteLength(payload, 'utf8');
  console.log(`  当前: ${payload.length} chars / ${bytes} bytes (${(bytes / 1024).toFixed(2)} KB),预算 ${BUDGET_BYTES} bytes`);
  ok(bytes <= BUDGET_BYTES, `tools/list ≤ ${BUDGET_BYTES} bytes`, `${bytes} bytes(超 ${bytes - BUDGET_BYTES})`);

  console.log('\n== 形状与完整性(压缩不得伤可用性)==');
  ok(TOOLS.length === EXPECTED_TOOLS.length, `工具数 = ${EXPECTED_TOOLS.length}`, String(TOOLS.length));
  for (const name of EXPECTED_TOOLS) ok(TOOLS.some((t) => t.name === name), `工具在册: ${name}`);
  ok(TOOLS.every((t) => typeof t.description === 'string' && t.description.trim().length > 0), '每个工具描述非空');
  ok(TOOLS.every((t) => t.inputSchema && t.inputSchema.type === 'object'), '每个工具 inputSchema 是 object');
  ok(TOOLS.every((t) => !/R1–R12 表|worktree 配置真值表/.test(t.description)), '规则条文不回流到工具描述');

  console.log('\n== 规则条文仍在按需读取的载体里 ==');
  const rules = RESOURCES.find((r) => r.uri === 'relay://protocol');
  ok(!!rules, 'relay://protocol 资源存在');
  const protocol = rules ? await rules.load() : '';
  ok(protocol.includes('六步') || protocol.includes('step'), '协议资源承载流程语义');
  const rulesText = ((await dispatch('relay_rules', {})).content || []).map((c) => c.text || '').join('\n');
  ok(rulesText.includes('worktree 配置真值表'), 'RULES_TEXT 仍含配置真值表');
  ok(rulesText.includes('ignored'), 'RULES_TEXT 仍含 ignored 保护');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常\n${e?.stack || e}`);
}

process.exit(fail ? 1 : 0);
