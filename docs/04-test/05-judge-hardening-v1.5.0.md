---
title: v1.5.0 裁判加固验收记录(T022–T025)
status: 现行
---

# v1.5.0 裁判加固验收记录(T022–T025)

本批只做「裁判加固」:不新增功能面,只让机检规则更难被绕过、更少误判。范围与推迟项见 `DECISIONS.md` 的 v1.5.0 条目。

## 范围与证据

| 任务 | 变更 | 机检证据 | 代码提交 | 控制面提交 |
|---|---|---|---|---|
| T022 | `relay_verify` 单快照:LOG/TASKS/manifest 各读 1 次;git 子进程 9→2–4;`resolveRelayRoots` fs 快路径(recall/get git 2→0) | `scripts/smoke-perf.mjs`(23 断言,计数钩子非计时) | `6096407` | `a270891` |
| T023 | 事实行 v2:机检段(mode/文件数/±/base/sha/branch)与叙述段(验收/verify/耗时)以 `\|\|` 分隔;R10 去 fail-open(无法定位提交 → WARN,永不 PASS);机检段结构自洽 | `scripts/smoke-facts.mjs`(33 断言) | `dd816d6` | `e1609c1` |
| T024 | 新增 R12 LOG 边界:活跃区 >150 行或完成条目 >20 → WARN(`manifest.logBoundary.strict` 升 ERROR);只报警不归档 | `scripts/smoke-r12-boundary.mjs`(13 断言) | `aff8eeb` | `0be6c4d` |
| T025 | `package.json` 补 `repository` / `bugs`(provenance 前置) | `scripts/smoke-pack.mjs`(30 断言) | `93b68c1` | `f0520ae` |

修宪三处一致:CONTRACT 规则表 / `relay_rules` / AGENTS 模板规则表;R12 由 `smoke-r12-boundary.mjs` 对三处做机检断言。

## 验证命令与结果

```
npm test   # 14 套冒烟 / 606 断言,全绿(含 PR #8 审计修复、复审 N1/N2 与合并后清理的回归)
./verify   # fast:PASS 8 · WARN 1 · ERROR 0(唯一 WARN 为 R12,见下)
node src/cli.mjs relay_verify --root . --json '{"full":true}'   # PASS 10 · WARN 1 · ERROR 0
```

- 每任务出场绿闸:controlRoot 全量 12 项 ERROR 0 + executionRoot 任务树 5 项 ERROR 0;验收 `node --test <任务脚本>` 与 `npm test` 均实际执行通过。
- 成对证据:每个任务都有代码提交(任务分支)+ 控制面提交(仅 TASKS/LOG),LOG 事实行记录 branch 与代码 SHA。

## 已知 WARN(不阻断)

- **R12(LOG 边界)**:本批四个会话让 LOG 从 117 行增长到 159 行,越过 150 行阈值 → WARN。这是规则按设计触发,不是回归;WARN 不阻断出场(ERROR 才阻断)。归档动作(T001)的登记触发条件 = R12 WARN 连续两次,当前 1/2。
- **R6(文档 staleness)**:本文件即对应动作;提交后近 20 次提交内 docs/ 有改动,R6 转 PASS。

## 推迟项(触发条件见 DECISIONS)

发布线 / 归档引擎 / harness 抽取 / protocol-text 叶子模块均维持推迟,不在本批实现。R12 只做裁判,不替人归档:归档需人工判断哪些条目算历史,并遵守「只从尾部搬、边界早于最新完成条目、live 保留 ≥3 条任务会话」的硬约束。
