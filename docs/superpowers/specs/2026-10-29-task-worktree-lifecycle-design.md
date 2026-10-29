---
title: 任务级 worktree 生命周期与 AGENTS.md 硬约束设计
status: 已批准
---

# 任务级 worktree 生命周期与 AGENTS.md 硬约束设计

日期：2026-10-29

## 1. 意图与背景

relay 当前以 TASKS/LOG 和认领锁协调多模型接力，但没有任务级 worktree 的创建、复用和清理能力。本次迭代建立完整、可恢复、默认防误删的 worktree 生命周期，同时把“AGENTS.md 是每个项目的必要规范入口”从默认行为升级为机器检查的硬约束。

审查已确认三个需要同步修复的问题：

- TASKS.md 的持有者判断会提前拒绝认领，导致 TTL 到期后仍无法接管。
- session_end 不校验任务持有者，其他模型可完成任务并释放其认领锁。
- 锁释放缺少持有者身份校验，过期接管可能误删新持有者的锁。

## 2. 目标

1. AGENTS.md 在所有接入项目中必需，并作为项目级规范入口；CLAUDE.md/GEMINI.md 是按需生成的适配指针。
2. relay_claim 能创建或复用任务级 worktree，并返回明确的执行目录、分支和基准提交。
3. relay 能识别主仓库控制目录与任务执行目录，协议状态不随 worktree 副本漂移。
4. 过期、不再活跃的缓存 worktree 可自动清理；清理失败只报告，不阻断正常接力。
5. 修复任务 TTL 接管、完成权限和锁所有权问题，并补足并发与崩溃恢复测试。

## 3. 非目标与反目标

- 不自动 merge/rebase 任务分支，不自动 push，不删除任务分支。
- 不清理用户手工创建、未登记在 relay 注册表中的 worktree。
- 不使用 `rm -rf` 强行删除 worktree；删除通过 `git worktree remove` 完成。
- 不因为 TTL 到期就删除仍在活跃任务中的 worktree。
- 不引入第三方运行时依赖，保持 Node.js 内置模块和无构建步骤。
- 不把“任务分支已验收”伪装成“已经合并进主分支”。

## 4. 方案比较与选择

### 方案 A：仅增加清理器

只清理外部工具已经创建的缓存 worktree。实现较小，但 relay 仍没有创建、复用和状态恢复能力，不能形成完整缓存生命周期。

### 方案 B：完整任务级生命周期（已选择）

relay_claim 创建/复用 worktree，session_start/session_end 维护状态，自动清理只处理 relay 登记且不再活跃的缓存。该方案与 relay 的任务认领模型一致，并能覆盖崩溃恢复和误删防护。

## 5. AGENTS.md 硬约束

### 5.1 单源关系

- 引擎级上游单源仍是 `templates/AGENTS.md.tpl`。
- 项目级规范入口是生成后的 `AGENTS.md`。
- 项目自定义规则只放在 AGENTS.md 的 `user-rules` 保留区。
- 新建的 CLAUDE.md/GEMINI.md 继续作为指针；已有未接管文件保持非破坏策略，不强制覆盖。

### 5.2 机检与迁移

- R1 无条件检查 AGENTS.md 存在且首行带 relay 标记，不再允许通过空 `entryFiles` 跳过。
- `manifest.entryFiles` 是“AGENTS.md + 其他适配入口”的集合；读取和 sync 时始终并入 AGENTS.md。
- 原有 `entryFiles: []` 项目会迁移为至少包含 AGENTS.md。这是有意改变，不再表示“不投影任何入口”。
- R1/R4 文档和模板同步改为“AGENTS.md 必需，其他入口按 manifest 配置”。
- verify 输出和 README 明确区分“引擎模板单源”与“项目规范入口”。

## 6. worktree 总体架构

### 6.1 两个根目录

- **controlRoot**：主工作树，唯一保存 TASKS.md、LOG.md、认领锁和 worktree 注册表的协议控制面。
- **executionRoot**：任务 worktree，代码修改、测试和任务分支提交的执行面。

从主工作树调用时二者相同，保持现有单提交行为。从 relay 管理的任务 worktree 调用 session_start/session_end 时，工具通过 Git common dir 和注册表找到 controlRoot，不读取任务分支里过期的协议副本作为控制状态。

### 6.2 缓存布局

默认位于主工作树内、Git 忽略的目录：

```text
.relay/worktrees/<task-id>/
.relay/worktrees.json
.relay/worktrees.lock
```

注册表至少记录：task、path、branch、baseSha、owner、status、createdAt、lastUsedAt。path 只用于定位，清理前必须重新做 realpath  containment 和 `git worktree list --porcelain` 双重核验，不能信任注册表中的任意路径。

### 6.3 配置与兼容

新增 manifest 配置：

```json
{
  "worktree": {
    "enabled": true,
    "cacheDir": ".relay/worktrees",
    "ttlHours": 24,
    "autoCleanup": true
  }
}
```

- 新 init 项目默认启用完整生命周期。
- 既有项目缺少 `worktree.enabled` 时默认 false，避免升级后突然改变认领行为；可显式开启。
- relay_claim 支持单次 `worktree: true/false` 覆盖配置。
- cacheDir 只允许 controlRoot 内的相对路径，拒绝绝对路径、`..` 和符号链接逃逸。

## 7. 生命周期

### 7.1 创建与复用

1. relay_claim 在 controlRoot 获取仓库写锁并校验任务。
2. 需要 worktree 时，以当前 HEAD 为 baseSha，使用分支 `relay/<task-id>` 和缓存路径 `.relay/worktrees/<task-id>`。
3. 注册表和 Git worktree 均有效时复用；陈旧的 Git 管理记录先安全 prune，再重建。
4. 创建成功后才写入 TASKS.md 认领状态和注册表；失败时不留下半认领状态。
5. 返回 controlRoot、executionRoot、branch、baseSha，以及后续应在 executionRoot 修改代码的明确提示。

### 7.2 活跃与完成

- claim、session_start、session_end 更新 lastUsedAt。
- session_end 在 executionRoot 执行验收、敏感文件与受保护路径检查、代码提交。
- 任务分支提交成功后，在 controlRoot 更新 TASKS/LOG；LOG 记录 branch 和代码提交 SHA，并明确“已验收，是否合并由人工决定”。
- 任务完成不等于已合并。relay 不自动整合任务分支，分支在 worktree 清理后仍保留，代码不会随目录删除而丢失。
- 当前目录就是待清理 worktree 时不清理自己；缓存清理由后续主仓库会话或显式命令执行。

### 7.3 过期清理

新增 `relay_worktree_cleanup`：

- 默认 dry-run，返回“可清理/保留及原因”；`confirm: true` 才执行。
- session_start 在 `autoCleanup: true` 时执行一次实际清理，但不因清理失败阻断简报。
- 只有同时满足以下条件才自动清理：
  - 在 relay 注册表内，且路径仍位于受管 cacheDir；
  - 注册状态为 completed，或任务已不处于 `[~]` 活跃状态；
  - lastUsedAt 已超过 ttlHours；
  - 不是当前 executionRoot，不是主工作树，没有被 Git lock；
  - worktree 干净，没有未提交或冲突状态；
  - 对应任务分支仍存在，提交有持久引用。
- `[~]` 活跃任务即使超过 TTL 也保留，避免把长任务或崩溃现场误删；接管或完成后再进入清理流程。
- 清理只解除 worktree 与目录，保留分支；失败项逐项报告，不用强制删除绕过 Git 安全检查。

## 8. 认领与锁修复

- 不同模型认领 `[~]` 任务时，先由认领锁判定是否可 TTL 接管，不再被 TASKS.md 的元数据提前拒绝。
- session_end 完成 `[~]` 任务时，model 必须与认领者一致；已完成任务仅允许同模型幂等重跑。未认领任务保留现有人工/单会话完成路径。
- 认领锁和仓库锁写入唯一 owner token；释放时必须匹配 token，避免原持有者误删新持有者的锁。
- 所有 claim 锁的创建、接管和释放继续在仓库写锁内串行化；仓库锁的过期接管增加身份复核与并发回归测试。
- session_end 返回的执行根与协议根必须清晰，避免调用方误在副本中查找主任务队列。

## 9. 测试与验收

新增端到端覆盖：

1. 新 init 项目缺 AGENTS.md 时 R1 ERROR，sync 可恢复；`entryFiles: []` 仍不能绕过。
2. claim 创建 worktree；重复 claim 复用；不同任务得到隔离目录。
3. 在 executionRoot 修改并提交代码，controlRoot 的 TASKS/LOG 正确更新且包含 branch/SHA。
4. 过期 completed worktree 被清理、分支保留；未到期、活跃、dirty、locked、路径越界、未登记 worktree 全部保留。
5. 自动清理失败不阻断 session_start；显式清理默认 dry-run。
6. TTL 到期可由另一模型接管；非持有者不能完成或释放他人任务锁。
7. 并发 claim/session_end、崩溃残留、重复出场不丢更新、不重复记账。
8. 既有项目未启用 worktree 时保持原认领行为。

验收命令：

```sh
npm test
node scripts/smoke-patches.mjs
./verify
```

文档同步：README、CHANGELOG、SPEC、DECISIONS、TASKS、LOG、相关模板与接口契约。实现提交遵守项目现有受保护路径人工批准规则。

## 10. 留给实现者的细节

- 注册表写入采用临时文件 + 原子 rename，并在仓库写锁内更新。
- 清理报告使用结构化内部结果，再格式化为 MCP 文本；自动清理与显式清理共用同一实现。
- Windows 路径、macOS `/tmp` realpath、Git porcelain 的定宽字段必须纳入实现检查。
- 不为假想功能增加插件系统、后台守护进程或定时器；自动清理只挂在现有会话入口。
