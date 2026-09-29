<!-- relay:generated v1 -->
# relay-mcp — 规范入口(canonical)

本文件由 relay-mcp 单源投影生成(2026-09-29);CLAUDE.md 与 GEMINI.md 只是它的指针副本。
规则要改:改 relay 引擎模板后运行 `relay_sync` 重投影;不要只手改其中一份(会漂移,R1 拦)。

## 项目身份
- 项目:relay-mcp
- 规范的可执行形式:`./verify`(委托 relay 引擎机检 R1-R9)

## 开工必读
先读 `./START.md`(三步引导:验状态 → 领任务 → 按协议干)。任务与验收看 `TASKS.md`,意图与验收标准看 `SPEC.md`,既定决策看 `DECISIONS.md`(勿重复论证),上个会话的产出与踩坑看 `LOG.md`。

## 六步会话协议(一句话版)
进场简报(session_start)→ 领任务/定验收(claim)→ 小步实现(红灯优先)→ 自验(verify)→ 出场绿闸(session_end:全绿才更新 TASKS/LOG 并提交)→ 留给下一个(LOG 记负结果与下一步)。

## 规则速查 R1-R9
| ID | 一句话 |
|---|---|
| R1 | 本文件与 CLAUDE/GEMINI 入口齐全,且首行带 relay 生成标记 |
| R2 | 顶层目录白名单;越界须显式修 `.relay/manifest.json`(修宪) |
| R3 | docs 文档命名(`NN-类型-主题-vX.Y.md`)与 frontmatter 合规 |
| R4 | 入口文件与 START 保持常青,不得出现时变词汇 |
| R5 | 动了 src 就要同步动 TASKS/LOG(提交原子性) |
| R6 | 代码连动而文档未动 → staleness 提醒 |
| R7 | 会话日志连续 3 条无“完成” → 停机,人类仲裁 |
| R8 | 项目配了 format 工具链就跑;没配不硬加 |
| R9 | LOG 记完成的任务,TASKS 里必须已完成 |

细则与执法点:`relay_rules`;完整规范见 relay-mcp 仓库与全局 CLAUDE-PROJECT-RULES。

<!-- relay:user-rules-start(本区为项目自定义规范:relay_sync 只原样保留本区,模板重投影不会冲掉) -->
<!-- relay:user-rules-end -->

