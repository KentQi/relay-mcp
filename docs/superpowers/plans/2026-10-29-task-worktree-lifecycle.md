---
title: 任务级 worktree 生命周期实施计划
status: 现行
---

# 任务级 worktree 生命周期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 relay 增加 AGENTS.md 硬约束、任务级 worktree 创建/复用/过期清理，并修复认领与锁所有权缺陷。

**Architecture:** 新增独立 worktree 引擎负责注册表、根目录解析和安全清理；session 引擎只编排控制面与执行面。主仓库保存协议状态，任务 worktree 保存代码变更；不自动合并、推送或删除分支。

**Tech Stack:** Node.js >= 18、纯 ESM、仅 `node:` 内置模块、Git CLI、Node 脚本端到端冒烟测试。

**Spec:** `docs/superpowers/specs/2026-10-29-task-worktree-lifecycle-design.md`

## Global Constraints

- 保持零运行时依赖、无构建步骤和现有 MCP/CLI 文本结果契约。
- 新项目默认启用 worktree；既有项目缺少 `worktree.enabled` 时默认 false。
- 自动清理只处理 relay 登记、非活跃、干净、路径受管且过期的 worktree，保留分支。
- 不自动 merge/rebase/push，不使用 `rm -rf` 清理 worktree。
- 未经用户明确要求不创建 Git 提交；每个任务以测试和 diff 检查作为检查点。

## Review Focus

- 注册表被篡改为仓库外路径：必须拒绝清理，并有路径逃逸测试（Task 3）。
- 活跃任务或 dirty worktree 超过 TTL：必须保留并说明原因（Task 3）。
- 旧 manifest 没有 worktree 配置：claim 行为必须保持原样（Task 4）。
- 在任务 worktree 出场：主仓库 TASKS/LOG 与任务分支代码必须各自正确落账（Task 5）。
- 锁过期接管与原持有者延迟释放：不能误删新持有者锁（Task 2）。

---

### Task 1: AGENTS.md 必需约束

**Files:**
- Modify: `src/engines/verify.mjs`
- Modify: `src/engines/sync.mjs`
- Modify: `templates/AGENTS.md.tpl`
- Modify: `src/contract.mjs`
- Test: `scripts/smoke-patches.mjs`

**Interfaces:**
- Consumes: 现有 `manifest.entryFiles`、`generateEntryFiles(root, ctx)`。
- Produces: `entryFiles` 的有效集合始终包含 `AGENTS.md`；R1 无条件检查该文件。

- [ ] **Step 1: 写失败回归**：将 `entryFiles` 设为 `[]`，删除 AGENTS.md，断言 verify 的 R1 为 ERROR；执行 sync 后断言 AGENTS.md 重建且 R1 恢复；同步改写旧 P5“空数组不投影任何入口”的过时断言。
- [ ] **Step 2: 运行 `node scripts/smoke-patches.mjs`，确认新增断言失败且失败原因正确。**
- [ ] **Step 3: 实现最小修改**：sync 合并 AGENTS.md；R1 独立检查 AGENTS.md，再检查其余配置入口；更新 R1 文案，其他入口不再被描述为一律必需。
- [ ] **Step 4: 重跑补丁回归和 `npm test`，确认无既有行为回归。**
- [ ] **Step 5: 检查本任务 diff，只保留 AGENTS.md 硬约束相关变更。**

### Task 2: TTL 接管与锁所有权

**Files:**
- Modify: `src/util.mjs`
- Modify: `src/engines/session.mjs`
- Modify: `src/engines/sync.mjs`
- Modify: `src/engines/restructure.mjs`
- Test: `scripts/smoke-worktrees.mjs`

**Interfaces:**
- Consumes: `acquireRepoLock(root, holder, options)`、`releaseRepoLock(root)`、`acquireClaimLock(...)`。
- Produces: 锁句柄含唯一 `token`；`releaseRepoLock(root, token)` 与 `releaseClaimLock(root, task, token)` 只释放持有者的锁。

- [ ] **Step 1: 新建失败测试**：复现极短 TTL 后 model-B 无法接管、model-B 可完成 model-A 任务、旧锁句柄可释放新锁三个问题。
- [ ] **Step 2: 运行新测试，确认三项按预期失败。**
- [ ] **Step 3: 实现 token 句柄与所有权校验**：session/sync/restructure 的所有锁获取与释放调用点传 token；不同模型认领先经过锁 TTL 裁决；session_end 拒绝非持有者完成 `[~]` 任务，同模型完成重跑保持幂等。
- [ ] **Step 4: 运行新旧测试，确认接管、拒绝越权、幂等与并发场景通过。**
- [ ] **Step 5: 检查所有 acquire/release 调用点无遗漏，并审查锁释放异常路径。**

### Task 3: worktree 注册表与安全清理器

**Files:**
- Create: `src/engines/worktree.mjs`
- Modify: `src/config.mjs`
- Modify: `src/engines/bootstrap.mjs`
- Modify: `src/contract.mjs`
- Modify: `.gitignore`
- Test: `scripts/smoke-worktrees.mjs`
- Test: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: `gitRun`、`readManifestConfig`、仓库写锁。
- Produces:
  - `resolveRelayRoots(root) -> Promise<{controlRoot, executionRoot, managed}>`。
  - `readWorktreeConfig(root) -> Promise<{enabled, cacheDir, ttlHours, autoCleanup}>`。
  - `cleanupWorktrees(controlRoot, {confirm, ttlHours, now}) -> Promise<{removed, kept, errors}>`。
  - MCP `relay_worktree_cleanup {root, confirm?, ttl_hours?}`，默认 dry-run。

- [ ] **Step 1: 写失败测试**：构造注册表和真实 Git worktree，覆盖过期 completed 可删且分支保留，以及未到期、活跃、dirty、locked、未登记、路径越界均保留；dry-run 不删除。
- [ ] **Step 2: 运行测试，确认工具尚不存在且断言失败。**
- [ ] **Step 3: 实现配置、注册表原子读写、Git porcelain 解析和清理器**：所有删除走 `git worktree remove`，清理前重新核验 realpath、Git 登记、分支引用和状态。
- [ ] **Step 4: 接入第 10 个 MCP 工具及 `.gitignore` 基线，同步 tools/list 数量断言；新 init 写入启用配置，旧 manifest 缺省关闭。**
- [ ] **Step 5: 运行新测试与两套旧测试，确认清理矩阵和工具契约通过。**

### Task 4: claim 创建与复用任务 worktree

**Files:**
- Modify: `src/engines/worktree.mjs`
- Modify: `src/engines/session.mjs`
- Modify: `src/contract.mjs`
- Test: `scripts/smoke-worktrees.mjs`

**Interfaces:**
- Consumes: Task 3 的注册表、配置与锁句柄。
- Produces: `ensureTaskWorktree(controlRoot, task, model, config) -> Promise<{path, branch, baseSha, reused}>`；relay_claim 新增可选 `worktree` 参数。

- [ ] **Step 1: 写失败测试**：启用配置后 claim 必须创建 `relay/T###` 和对应目录；同模型重复 claim 复用；不同任务目录隔离；缺省旧配置不创建。
- [ ] **Step 2: 运行测试确认失败。**
- [ ] **Step 3: 实现创建/复用及失败回滚**：基于 HEAD 记录 baseSha，成功后才落 TASKS 和注册表；输出 controlRoot、executionRoot、branch、baseSha。
- [ ] **Step 4: 运行测试，验证创建、复用、并发认领和旧行为兼容。**
- [ ] **Step 5: 检查失败路径不会留下半认领 TASKS 或可用锁被误释放。**

### Task 5: session 双根目录与自动清理

**Files:**
- Modify: `src/engines/session.mjs`
- Modify: `src/engines/worktree.mjs`
- Test: `scripts/smoke-worktrees.mjs`

**Interfaces:**
- Consumes: `resolveRelayRoots`、注册表状态、清理器、claim 返回的执行根。
- Produces: session_start/end 在 managed worktree 中正确使用 controlRoot/executionRoot；完成日志包含 branch/SHA；session_start 触发非阻断自动清理。

- [ ] **Step 1: 写失败测试**：在 executionRoot 修改代码并出场，断言测试在 executionRoot 执行、代码提交落在任务分支、controlRoot TASKS/LOG 更新且含 branch/SHA；当前 worktree 不自我清理。
- [ ] **Step 2: 写自动清理测试**：completed 且过期记录在后续主仓库 session_start 被清理，清理故障不阻断简报。
- [ ] **Step 3: 运行测试确认失败。**
- [ ] **Step 4: 实现双根编排**：协议检查、任务定义与 TASKS/LOG 使用 controlRoot，测试命令、代码 status/commit 使用 executionRoot；主仓库调用保持现有单根路径，代码提交失败时不得把 controlRoot 任务标为完成。
- [ ] **Step 5: 运行全部测试，检查幂等、护栏、非 Git 降级和无 worktree 路径不回归。**

### Task 6: 文档、配置与全量验收

**Files:**
- Modify: `README.md`、`CHANGELOG.md`、`SPEC.md`、`DECISIONS.md`、`TASKS.md`、`LOG.md`
- Modify: `templates/START.md`、`templates/TASKS.md`、`templates/AGENTS.md.tpl`
- Modify: `.relay/manifest.json`
- Modify: `docs/superpowers/specs/2026-10-29-task-worktree-lifecycle-design.md`
- Modify: `package.json`、`.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1–5 的最终行为。
- Produces: 可复核的公开契约、迁移说明和统一测试门。

- [ ] **Step 1: 将设计状态改为已批准，记录 controlRoot/executionRoot、保留分支、不自动合并和 AGENTS.md 硬约束决策。**
- [ ] **Step 2: 把三套冒烟统一接入 `npm test` 与 CI，更新工具数量、配置、使用示例和测试数量。**
- [ ] **Step 3: 运行 `npm test`、`node scripts/smoke-patches.mjs`、`./verify` 和 `git diff --check`。**
- [ ] **Step 4: 审核最终 diff、Git worktree 列表和主仓库状态；确认没有运行时缓存、临时文件或无关变更进入交付。**
