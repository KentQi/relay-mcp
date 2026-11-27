#!/usr/bin/env node
// v1.7.0 测试框架元负控:防"套件没跑完却报绿"。
// 事故形态(v1.6.1 前 smoke-worktrees):try { … } finally { 打印汇总; process.exit(0) } 无 catch,
// 中途异常进入 finally → 打印「N 通过 / 0 失败」→ exit(0),异常被吞,后半断言静默未执行。
// 本套件三件事:
//   1) 负例复现:构造上述坏套件并运行,断言它确实假绿(exit 0) —— 证明规则不是空谈;
//   2) 正例对照:同样抛异常但带 catch 的套件必须 exit 1;
//   3) 静态规则:仓库内所有 smoke-*.mjs,顶层 try/finally 必须配 catch,且 catch 里递增 fail。
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SELF = path.basename(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ FAIL ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
};

const BAD = `let pass = 0, fail = 0;
try {
  console.log('  ✓ 前半段跑完'); pass += 1;
  throw new Error('fixture boom');
} finally {
  console.log(\`\\n===== 结果: \${pass} 通过 / \${fail} 失败 =====\`);
  process.exit(fail ? 1 : 0);
}
`;
const GOOD = `let pass = 0, fail = 0;
try {
  console.log('  ✓ 前半段跑完'); pass += 1;
  throw new Error('fixture boom');
} catch (e) {
  fail += 1;
  console.log('  ✗ FATAL: ' + e.message);
} finally {
  console.log(\`\\n===== 结果: \${pass} 通过 / \${fail} 失败 =====\`);
  process.exit(fail ? 1 : 0);
}
`;

// 轻量词法扫描:去掉注释/字符串/模板/正则字面量,只保留标识符与标点。
// 旧实现用「顶格 } catch」正则,缩进或换行写法能绕过;这里用 token 结构和括号配对。
const sourceTokens = (src) => {
  const out = [];
  let i = 0;
  const regexPrefix = new Set(['=', '(', '[', '{', ',', ':', ';', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>']);
  const regexKeywords = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      out.push({ type: 'literal', value: quote });
      continue;
    }
    if (c === '/') {
      const prev = out[out.length - 1];
      const canRegex = !prev || prev.type === 'punc' && regexPrefix.has(prev.value)
        || prev.type === 'id' && regexKeywords.has(prev.value);
      if (canRegex) {
        i += 1; let inClass = false;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { i += 1; while (/[a-z]/i.test(src[i] || '')) i += 1; break; }
          else if (src[i] === '\n') break;
          i += 1;
        }
        out.push({ type: 'literal', value: '/regex/' });
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      out.push({ type: 'id', value: src.slice(i, j) }); i = j; continue;
    }
    out.push({ type: 'punc', value: c }); i += 1;
  }
  return out;
};
const matchingBrace = (tokens, open) => {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i].value !== '{' && tokens[i].value !== '}') continue;
    if (tokens[i].value === '{') depth += 1;
    else { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
};
const blockAfter = (tokens, start) => {
  if (tokens[start] && tokens[start].value === '{') return matchingBrace(tokens, start);
  if (tokens[start] && tokens[start].value === '(') {
    let depth = 0;
    for (let i = start; i < tokens.length; i += 1) {
      if (tokens[i].value === '(') depth += 1;
      else if (tokens[i].value === ')' && --depth === 0) return i;
    }
  }
  return -1;
};
const falseGreenOffender = (src) => {
  const t = sourceTokens(src);
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].type !== 'id' || t[i].value !== 'try') continue;
    const open = i + 1;
    if (t[open] && t[open].value !== '{') continue;
    const close = matchingBrace(t, open);
    if (close < 0) continue;
    let cursor = close + 1;
    let catchEnd = -1;
    let catchOpen = -1;
    let finallyEnd = -1;
    if (t[cursor] && t[cursor].value === 'catch') {
      const paramsEnd = t[cursor + 1] && t[cursor + 1].value === '(' ? blockAfter(t, cursor + 1) : cursor;
      const bodyOpen = paramsEnd + 1;
      catchOpen = bodyOpen;
      catchEnd = t[bodyOpen] && t[bodyOpen].value === '{' ? matchingBrace(t, bodyOpen) : -1;
      if (catchEnd >= 0) cursor = catchEnd + 1;
    }
    if (t[cursor] && t[cursor].value === 'finally') {
      const bodyOpen = cursor + 1;
      finallyEnd = t[bodyOpen] && t[bodyOpen].value === '{' ? matchingBrace(t, bodyOpen) : -1;
    }
    if (finallyEnd < 0) continue;
    const finOpen = cursor + 1;
    const finallyText = t.slice(finOpen + 1, finallyEnd).map((x) => x.value).join(' ');
    if (!/process\s*\.\s*exit\s*\(/.test(finallyText)) continue;
    // 只认「catch 体紧跟 try」的判负语句;finally 里的清理 catch 不算顶层捕获。
    const catchText = catchOpen >= 0 ? t.slice(catchOpen + 1, catchEnd).map((x) => x.value).join(' ') : '';
    if (!catchText || !/fail\s*\+\s*=\s*1/.test(catchText)) return true;
  }
  return false;
};

try {
  console.log('== 1. 负例复现:无 catch + finally 内 exit 会假绿 ==');
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-meta-'));
  try {
    const badPath = path.join(dir, 'bad-smoke.mjs');
    writeFileSync(badPath, BAD);
    const bad = spawnSync(process.execPath, [badPath], { encoding: 'utf8', timeout: 30000 });
    ok(bad.status === 0, '坏套件中途抛异常却 exit 0(假绿形态可复现)', `status=${bad.status}`);
    ok(/0 失败/.test(bad.stdout || ''), '坏套件打印「0 失败」汇总', (bad.stdout || '').slice(-120));
    ok(!/FATAL/.test(bad.stdout || ''), '坏套件未报告异常(异常被 finally 吞掉)');

    console.log('\n== 2. 正例对照:同样异常但带 catch 必须判负 ==');
    const goodPath = path.join(dir, 'good-smoke.mjs');
    writeFileSync(goodPath, GOOD);
    const good = spawnSync(process.execPath, [goodPath], { encoding: 'utf8', timeout: 30000 });
    ok(good.status === 1, '带 catch 的套件 exit 1(异常判负生效)', `status=${good.status}`);
    ok(/FATAL/.test(good.stdout || ''), '带 catch 的套件打印 FATAL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n== 3. 静态规则:仓库内 smoke 套件不得回归假绿形态 ==');
  const files = readdirSync(SCRIPTS).filter((f) => /^smoke.*\.mjs$/.test(f) && f !== SELF).sort();
  ok(files.length >= 15, `扫到 ${files.length} 个 smoke 套件`);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(path.join(SCRIPTS, f), 'utf8');
    // token 级规则对缩进/换行/参数换行都有效;exit 在 finally 之外仍不算假绿。
    if (falseGreenOffender(src)) offenders.push(f + '(finally 内 exit 且无有效 catch 判负)');
  }
  ok(offenders.length === 0, '顶层 try/finally 均配 catch 且 catch 递增 fail', offenders.join(', '));

  // 负控:旧正则会漏掉的缩进/换行坏套件,新词法规则必须抓到。
  const negDir = mkdtempSync(path.join(tmpdir(), 'relay-meta-negative-'));
  try {
    const INDENTED_BAD = `let pass = 0, fail = 0;\n  try {\n    throw new Error('x');\n    } catch {\n    // 故意不递增 fail\n    } finally {\n    process.exit(0);\n    }\n`;
    const indentedPath = path.join(negDir, 'indented-bad.mjs');
    writeFileSync(indentedPath, INDENTED_BAD);
    ok(falseGreenOffender(INDENTED_BAD), '缩进/参数省略/换行坏套件被词法规则识别', indentedPath);
    const stringTrap = 'const text = "} catch (e) { fail += 1 } finally { process.exit(0) }";';
    ok(!falseGreenOffender(stringTrap), '字符串里的伪 catch/finally 不触发误报');
  } finally {
    rmSync(negDir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail += 1;
  console.log(`\n✗ FATAL: 套件中途未捕获异常,判失败\n${e?.stack || e}`);
}

process.exit(fail ? 1 : 0);
