#!/usr/bin/env node
// T031 冒烟:R13 协议结构机检 —— 任务行/LOG 条目标题契约校验(WARN 起步,strict 升 ERROR)。
// 红线:模板项目不误报(HTML 注释/缩进行豁免);坏任务行/重复任务号/[~] 缺元数据/[x] 缺日期/坏 LOG 标题 → WARN;
// manifest.structure.strict=true → ERROR;修宪四处一致(CONTRACT / relay_rules / AGENTS 模板 / README)+ 根 AGENTS.md 投影。
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; console.log('  ✗ FAIL ' + label + (extra ? ' — ' + String(extra).slice(0, 500) : '')); }
};

const cli = (tool, args) => spawnSync(
  process.execPath,
  [path.join(RELAY, 'src/cli.mjs'), tool, '--json', JSON.stringify(args)],
  {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || '/tmp/npm-cache' },
  },
);
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const row = (text, id) => (text.match(new RegExp('^\\| ' + id + ' \\|.*$', 'm')) || [''])[0];
const edit = (dir, file, fn) => {
  const p = path.join(dir, file);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
};
const fresh = (name) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-structure-'));
  tmpDirs.push(dir);
  const r = cli('relay_init', { root: dir, name });
  if (r.status !== 0) throw new Error('relay_init 失败:' + out(r).slice(0, 800));
  return dir;
};
const verify = (dir, full = false) => cli('relay_verify', { root: dir, full });

try {
  console.log('== 1. 模板项目不误报:注释示例/缩进行不算协议行 ==');
  {
    const dir = fresh('structure-fixture');
    const v = verify(dir);
    ok(/R13\s*\|\s*PASS/.test(row(out(v), 'R13')), '模板项目 R13 PASS', row(out(v), 'R13'));
    // 注释块内写列首坏行,仍不得误报
    edit(dir, 'TASKS.md', (t) => t + '\n<!--\n- [ ]T998 注释内非法任务行\n- [~] T997 注释内缺元数据\n-->\n');
    edit(dir, 'LOG.md', (t) => t + '\n<!--\n## 2026-11-09 15:00 model=x task=无\n-->\n');
    const v2 = verify(dir);
    ok(/R13\s*\|\s*PASS/.test(row(out(v2), 'R13')), 'HTML 注释块内的坏行被豁免', row(out(v2), 'R13'));
  }

  console.log('\n== 2. TASKS 结构违规 → WARN(默认不阻断) ==');
  {
    const dir = fresh('structure-bad-task');
    edit(dir, 'TASKS.md', (t) => t.replace('## 待办', '## 待办\n- [ ]T999 缺空格任务行'));
    const r = verify(dir);
    const line = row(out(r), 'R13');
    ok(/R13\s*\|\s*WARN/.test(line), '无法解析的疑似任务行 → WARN', line);
    ok(/无法解析/.test(line), 'WARN 详情指明无法解析', line);
    ok(r.status === 0 || r.status === null, 'WARN 不阻断 verify 退出码', 'status=' + r.status);
  }
  {
    const dir = fresh('structure-dup');
    edit(dir, 'TASKS.md', (t) => t.replace('## 待办', '## 待办\n- [ ] T002 重复编号的任务'));
    const line = row(out(verify(dir)), 'R13');
    ok(/R13\s*\|\s*WARN/.test(line) && /重复/.test(line), '任务号重复 → WARN 并点名重复', line);
  }
  {
    const dir = fresh('structure-trim');
    edit(dir, 'TASKS.md', (t) => t.replace(/- \[ \] T002 用户表迁移/, '- [~] T002 用户表迁移'));
    const line = row(out(verify(dir)), 'R13');
    ok(/R13\s*\|\s*WARN/.test(line) && /缺少/.test(line) && /已认领/.test(line), '[~] 缺 (model, 时间) → WARN', line);
  }
  {
    const dir = fresh('structure-done');
    edit(dir, 'TASKS.md', (t) => t.replace(/- \[ \] T003 实现登录接口/, '- [x] T003 实现登录接口'));
    const line = row(out(verify(dir)), 'R13');
    ok(/R13\s*\|\s*WARN/.test(line) && /完成日期/.test(line), '[x] 缺完成日期 → WARN', line);
  }

  console.log('\n== 3. LOG 坏条目标题 → WARN ==');
  {
    const dir = fresh('structure-bad-log');
    edit(dir, 'LOG.md', (t) => t.replace('# 会话日志(最新在上)', '# 会话日志(最新在上)\n\n## 2026-11-09 15:00 model=x task=无'));
    const line = row(out(verify(dir)), 'R13');
    ok(/R13\s*\|\s*WARN/.test(line) && /标题|条目/.test(line), 'LOG 疑似条目缺分隔符 → WARN', line);
  }

  console.log('\n== 4. manifest.structure.strict=true → ERROR ==');
  {
    const dir = fresh('structure-strict');
    edit(dir, 'TASKS.md', (t) => t.replace('## 待办', '## 待办\n- [ ]T999 缺空格任务行'));
    edit(dir, '.relay/manifest.json', (t) => {
      const m = JSON.parse(t);
      m.structure = { strict: true };
      return JSON.stringify(m, null, 2) + '\n';
    });
    const r = verify(dir);
    const line = row(out(r), 'R13');
    ok(/R13\s*\|\s*ERROR/.test(line), 'strict 下结构违规升 ERROR', line);
    ok(r.status === 1, 'ERROR 使 verify 退出码为 1', 'status=' + r.status);
  }

  console.log('\n== 5. 修宪四处一致 + 根 AGENTS 投影 + 测试链 ==');
  {
    const contract = readFileSync(path.join(RELAY, 'docs-design', 'CONTRACT.md'), 'utf8');
    const tpl = readFileSync(path.join(RELAY, 'templates', 'AGENTS.md.tpl'), 'utf8');
    const agents = readFileSync(path.join(RELAY, 'AGENTS.md'), 'utf8');
    const readme = readFileSync(path.join(RELAY, 'README.md'), 'utf8');
    const rules = cli('relay_rules', { root: RELAY });
    const r13 = {
      CONTRACT: (contract.match(/^\| R13 \|.*$/m) || [''])[0],
      relay_rules: (out(rules).match(/^\| R13 \|.*$/m) || [''])[0],
      'AGENTS 模板': (tpl.match(/^\| R13 \|.*$/m) || [''])[0],
      'AGENTS.md 投影': (agents.match(/^\| R13 \|.*$/m) || [''])[0],
    };
    for (const [name, text] of Object.entries(r13)) {
      ok(/structure\.strict/.test(text) && /warn/i.test(text) && /任务/.test(text),
        name + ' 的 R13 行包含结构键/WARN/任务', text.slice(0, 220));
    }
    ok(/R1–R13/.test(readme) && !/R1–R12/.test(readme) && !/R1–R11/.test(readme),
      'README 规则区间为 R1–R13 且无旧区间残留');
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const stale = walk(path.join(RELAY, 'src')).filter((f) => {
      const s = readFileSync(f, 'utf8');
      return s.includes('R1–R12') || s.includes('R1–R11');
    });
    ok(stale.length === 0, 'src/** 无 R1–R12 / R1–R11 残留', stale.map((f) => f.replace(RELAY + '/', '')).join(','));
    const pkg = JSON.parse(readFileSync(path.join(RELAY, 'package.json'), 'utf8'));
    ok(String(pkg.scripts.test || '').includes('scripts/smoke-structure.mjs'), 'npm test 链包含 smoke-structure');
  }
} catch (e) {
  fail += 1;
  console.log('\n✗ FATAL: 套件中途未捕获异常,判失败\n' + (e && e.stack ? e.stack : e));
} finally {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}
