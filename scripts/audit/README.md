---
title: T061 审计探针 — done_tasks[] 可复算证据
version: 1.0
created: 2026-11-26
status: 现行
---

# T061 审计探针

`docs/04-test/11-audit-t061-donetasks-v1.0.md` 里三条缺陷的**可复算证据**。
每个脚本在临时目录建独立 git 仓（`relay_init`），跑真实的 `relay_session_end` /
`relay_verify` / `relay_doctor`，打印观察结果后删除临时仓。

**这些是审计探针，不是回归测试**——它们只打印现象、不做断言、退出码恒为 0。
修完 T062 后，正确的形态是把这三个场景改写成 `scripts/smoke.mjs` 里的**断言**
（红→绿），那时探针即可退役。

| 脚本 | 场景 | 对应缺陷 |
|---|---|---|
| `t061-probe.mjs` | A:只传 `done_tasks` 不传 `done_task`（静默无操作）<br>B:`done_tasks` 含 TASKS 里不存在的任务号（假完成条目）<br>C:正常单任务（对照） | F1 / F2 |
| `t061-probe2.mjs` | C(修正):正常单任务出场<br>D:happy path —— `done_task` + `done_tasks` 双任务出场 | F1 的对照 |
| `t061-probe3.mjs` | 主任务条目被幂等去重 → 额外任务条目顶到 LOG 首位 → 后续维护出场使 R10 退化 | F3 |

跑法（各自独立，无需参数）：

```bash
node scripts/audit/t061-probe.mjs
node scripts/audit/t061-probe2.mjs
node scripts/audit/t061-probe3.mjs
```

**注意**：脚本会在 `relay_init` 的目标目录里建 git 仓库并跑 `npm test`；
它们只操作 `mkdtemp` 出来的临时目录，不会碰 relay-mcp 仓库本身。
