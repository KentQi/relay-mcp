#!/usr/bin/env node
// v1.7.0 上下文预算回归:tools/list 是每个会话都要付出的固定成本,
// 规则条文应留在 relay_rules / relay://protocol(按需读取),不膨胀工具描述。
// 预算 = 10 KiB(UTF-8). 超了要么压缩描述,要么把内容搬进资源,不允许悄悄涨。
import { TOOLS, RESOURCES, PROMPTS, dispatch } from '../src/contract.mjs';
import { renderCommitMessage, evidenceSummary, commitTemplateUsesAnchors } from '../src/engines/session.mjs';

const BUDGET_BYTES = 10240;
const EXPECTED_TOOLS = [
  'relay_init', 'relay_onboard', 'relay_sync', 'relay_session_start', 'relay_session_end',
  'relay_verify', 'relay_restructure', 'relay_claim', 'relay_worktree_cleanup', 'relay_archive_log',
  'relay_recall', 'relay_get', 'relay_doctor', 'relay_rules', 'relay_rescue',
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
  console.log(`  当前: ${payload.length} chars / ${bytes} bytes (${(bytes / 1024).toFixed(2)} KB),预算 ${BUDGET_BYTES} bytes,余量 ${BUDGET_BYTES - bytes}`);
  ok(bytes <= BUDGET_BYTES, `tools/list ≤ ${BUDGET_BYTES} bytes`, `${bytes} bytes(超 ${bytes - BUDGET_BYTES})`);
  const schema = (name) => TOOLS.find((t) => t.name === name)?.inputSchema?.properties || {};
  ok(schema('relay_claim').ttl_minutes?.type === 'number', 'relay_claim.ttl_minutes 在 MCP schema 可达');
  ok(schema('relay_session_end').maintenance?.type === 'boolean', 'relay_session_end.maintenance 在 MCP schema 可达');
  ok(schema('relay_rescue').task?.type === 'string', 'relay_rescue.task 在 MCP schema 可达');
  ok(!Object.prototype.hasOwnProperty.call(schema('relay_rescue'), '_profiles'), '内部 _profiles 不在 MCP schema 中暴露');
  ok(!/W1 pending|W3\/W4 并行开发|relay relay/.test(JSON.stringify({ tools: TOOLS, prompts: PROMPTS })), '用户可见契约无过时工作包标记/重复 relay 文案');

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

  console.log('\n== 提交模板渲染(managed/单根共享实现)==');
  ok(renderCommitMessage('relay: session end — {{task}}{{summary}}', { task: 'T003 完成 · ', summary: 'x' })
    === 'relay: session end — T003 完成 · x', '默认模板渲染逐字符不变');
  ok(renderCommitMessage('{{taskId}} {{evidence}}', { taskId: 'T003', evidence: 'verify 1P/0W/0E · 验收 1 项' })
    === 'T003 verify 1P/0W/0E · 验收 1 项', '{{evidence}} 渲染');
  ok(renderCommitMessage('{{summary}}', { summary: 'x'.repeat(300) }).length === 80, '无 {{evidence}} 时上限 80');
  ok(renderCommitMessage('{{evidence}}', { evidence: 'x'.repeat(300) }, { maxLen: 240 }).length === 240, '含 {{evidence}} 时上限 240');
  // D2(审计 T063):任务号是不可截断锚点 —— R10 靠 `git log --grep "<task> 完成"` 反查完成提交。
  // 旧实现按字符数一刀切,多任务时 7 个起末尾任务号被截掉(R10 对它们退化为 WARN)。
  {
    const tpl = 'relay: session end — {{task}}{{summary}}';
    for (const n of [2, 6, 7, 8, 12]) {
      const ids = Array.from({ length: n }, (_, i) => `T${String(901 + i).padStart(3, '0')}`);
      const head = `${ids.map((t) => `${t} 完成`).join(' · ')} · `;
      const msg = renderCommitMessage(tpl, { task: head, taskId: ids.join(','), summary: '多任务交付' });
      const missing = ids.filter((t) => !msg.includes(`${t} 完成`));
      ok(missing.length === 0, `N=${n} 任务时全部任务号都在提交消息里(不被截断)`, missing.join(','));
    }
    // 单任务行为必须逐字符不变(向后兼容)
    const single = renderCommitMessage(tpl, { task: 'T003 完成 · ', taskId: 'T003', summary: 's' });
    ok(single === 'relay: session end — T003 完成 · s', '单任务渲染仍逐字符不变');
    // 锚点本身超限时保留锚点(宁可超长,也不能丢可反查性)
    const many = Array.from({ length: 12 }, (_, i) => `T${String(901 + i).padStart(3, '0')}`);
    const longMsg = renderCommitMessage(tpl, { task: `${many.map((t) => `${t} 完成`).join(' · ')} · `, taskId: many.join(','), summary: 'x'.repeat(200) });
    ok(many.every((t) => longMsg.includes(`${t} 完成`)), 'summary 超长时仍保留全部任务号(牺牲长度而非可反查性)');
    ok(commitTemplateUsesAnchors('{{task}}{{summary}}') && !commitTemplateUsesAnchors('{{summary}}'),
      'commitTemplateUsesAnchors 能识别模板是否含 R10 锚点');
  }
  ok(evidenceSummary([{ result: 'PASS' }, { result: 'WARN' }], [{ result: 'ERROR' }], { executed: 2 })
    === 'verify 1P/1W/1E · 验收 2 项', 'evidenceSummary 汇总格式');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常\n${e?.stack || e}`);
}

process.exit(fail ? 1 : 0);
