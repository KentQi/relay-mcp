---
name: relay-protocol
description: >
  用 relay-mcp 的仓库接力协议接续多模型 / 多会话开发。开工先 relay_session_start 拿简报,
  按 TASKS 认领任务,代码小步实现后 relay_verify 自检,收尾用 relay_session_end 过 R1–R12
  绿闸并留下事实底账。需要新建 / 接入 / 标准化项目时用 relay_init / relay_onboard /
  relay_restructure。适用于长任务交接、会话中断恢复、多 agent 并行与人类审计场景。
license: MIT
compatibility: 需要 Node.js >= 18;MCP server relay-mcp 必须可用
---

# relay-protocol — 仓库即交接棒

relay-mcp 把交接状态写进仓库文件(START / SPEC / DECISIONS / TASKS / LOG),由 R1–R12 机检规则与可执行验收共同守门。本技能是使用这套协议的操作手册。

## 何时用

- 长任务跨会话 / 跨模型接力,或会话可能中断、需要从文件恢复上下文
- 多 agent 并行改同一仓库,需要认领锁、写入竞争治理与原子出场
- 需要人类可审计的决策记录、事实底账与可回放的任务历史

## 六步循环

1. **进场**:`relay_session_start {root}` → 读简报(当前任务、最近 LOG、verify 快检、下一个建议动作)。
2. **认领**:`relay_claim {root, task, model}` → TASKS 标 `[~]` 并加认领锁;启用 worktree 时返回 controlRoot / executionRoot,代码只在 executionRoot 写。
3. **实现**:小步改代码,红灯优先;一轮只做一个任务,边做边写负结果。
4. **自验**:`relay_verify {root, full:true}` → 全量 R 系列无 ERROR;错误行以「修复:」开头,照做即可。
5. **出场**:`relay_session_end {root, model, summary, done_task?, next?}` → 绿闸 + 可执行验收都通过才提交;失败不写 TASKS/LOG、不提交、保留认领锁。
6. **交接**:LOG 记录负结果与下一步;下一个会话从简报恢复,而不是从聊天记录恢复。

## 工具速查

| 场景 | 工具 |
|---|---|
| 新建项目(0→1) | `relay_init`(preset: `node` / `minimal`) |
| 接入存量项目 | `relay_onboard` |
| 存量目录标准化 | `relay_restructure` |
| 进场简报 | `relay_session_start` |
| 认领任务 | `relay_claim` |
| 出场绿闸 | `relay_session_end` |
| 规则自检 | `relay_verify`(全量)/ `relay_rules` |
| 检索历史 | `relay_recall` / `relay_get` |
| 只读环境诊断 | `relay_doctor` |
| 入口文件重投影 | `relay_sync` |
| LOG 归档(默认 dry-run) | `relay_archive_log` |
| worktree 清理(默认 dry-run) | `relay_worktree_cleanup` |

## 关键约束

- **不绿不提交**:verify 有 ERROR 或验收不通过 → 不更新 TASKS/LOG、不提交、保留认领锁。
- **受保护路径**:`verify` 脚本、`.relay/**`、`tests/**` 与测试文件改动不自动提交,需人类批准。
- **密钥闸(R11)**:协议面文件命中密钥样式内容会在任何写盘前阻断;密钥不要写进协议文件。
- **任务认领**:一个任务一个认领;并发会话必须用不同 `model` 标识,否则无法区分持有者。
- **LOG 边界(R12)**:活跃区 >150 行或完成条目 >20 → WARN;用 `relay_archive_log` 归档旧条目(只从尾部搬)。
- **事实底账(R10)**:`事实(v2)` 行由引擎写入,模型不得手写或改写;伪造/无法定位 → WARN 或 ERROR,永不假绿。
- **双根语义**:managed 出场要求「任务分支代码提交 + controlRoot 控制面提交」成对存在;任务分支验收通过 ≠ 已合并。

## 失败处理

- 认领锁残留:等待 240 分钟 TTL 到期接管,或由原会话出场释放;`relay_doctor` 可诊断。
- 出场报内容冲突:说明 TASKS/LOG 被外部改过;重跑 `relay_session_end` 会重读后重建,不要手工合并。
- 入口漂移(R1):运行 `relay_sync` 重投影;无标记的既有 AGENTS.md 用 `relay_onboard` 接管。
