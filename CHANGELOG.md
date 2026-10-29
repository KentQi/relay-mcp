# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式;
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 完整任务级 worktree 生命周期(方案 B):claim 创建/复用 `relay/T###` 与缓存目录,返回 controlRoot/executionRoot/branch/baseSha;新 init 默认启用,既有 manifest 缺省关闭,可按项目或单次认领覆盖
- 新增第 10 个工具 `relay_worktree_cleanup`:默认 dry-run,显式确认或主仓库 session_start 自动清理过期、非活跃、干净的受管目录;只走非强制 `git worktree remove`,保留分支,绝不自动 merge/rebase/push
- session 双根协议:controlRoot 唯一维护 TASKS/LOG/认领锁/注册表,executionRoot 执行测试和代码提交;代码提交失败不盖完成章,完成不等于合并
- 仓库级写锁 `.relay/relay.lock`:TASKS/LOG 的读改写跨 session_end / claim / restructure / sync 全面串行化,并发双进程回归断言零丢失
- 维护会话语义:`relay_session_end` 传 `maintenance:true` 记 `task=维护`,不计入 R7 发散窗口
- 入场简报带出最新一条 LOG 的负结果与交接提示;存在进行中任务时崩溃恢复优先(含 TTL 接管指引)

### Changed
- AGENTS.md 成为不可绕过的必需项目规范入口,`entryFiles: []` 不再豁免;CLAUDE.md/GEMINI.md 为可选适配入口
- 三套冒烟统一接入 `npm test` 与 CI(182 项断言)

### Fixed
- 认领锁 TTL 到期可由其他模型接管;session_end 拒绝非持有者完成他人任务
- 仓库锁与认领锁使用唯一 token,旧锁持有者延迟释放不会删除新持有者的锁;锁丢失时依据 TASKS 时间戳执行同一 TTL
- 幂等出场:同一出场重跑不再重复盖戳/记日志/插入 next
- 认领锁 TTL 接管改为 unlink+wx 原子竞争(并发接管不再双成功)
- 认领 model 占位符(`<你的模型标识>`)拒收,防署名污染

## [1.1.0] - 2026-10-17

### Added (manifest 配置面, 全部缺省=v1.0.0 行为)
- `codeRoots` / `docsRoots`: R5/R6 代码与文档前缀可配(默认 src/lib/app)
- `docsIgnore`: R3 文档豁免 glob(内置 archive/templates 豁免不变)
- `protectedPaths`: 受保护路径追加 glob(与内置规则合并, 只能加严)
- `acceptance.commands`: 验收 `test:` 命令白名单(放行 pytest 等非 js/ts)
- `commitMessageTemplate`: 提交信息模板({{task}}/{{taskId}}/{{summary}})
- `autoCommit: false`: session_end 只更新文件不提交

### Changed
- sync 对「已存在但无 relay 标记」的入口文件默认 kept(不重写); `entryFilesTakeover: true` 恢复旧行为

### Fixed
- `git status --porcelain` 被误 trim/slice 导致受保护规则对已跟踪文件漏判(护栏失效)
- Windows 下 `execFile('npm')` ENOENT 导致 npm test 绿闸空转
- status 未加 `-uall` 导致未跟踪目录折叠、glob 护栏漏判

## [1.0.0] - 2026-09-29

首个公开发布版本。

### Added
- MCP 服务器(stdio,零依赖纯 Node):9 个工具
  - `relay_init`:0→1 建仓(模板 + preset 代码骨架 + git 首提交)
  - `relay_onboard`:存量项目非破坏接入
  - `relay_restructure`:老项目目录标准化(干跑 → confirm 执行,git mv 保历史)
  - `relay_session_start` / `relay_session_end`:接力简报 / 出场绿闸
  - `relay_verify` / `relay_sync` / `relay_claim` / `relay_rules`
- 出场绿闸:结构检查(R1-R9)+ 验收执行门(`test:` 跑 `node --test`;`scripts.test` 跑 `npm test`),不绿不提交
- 安全机制:疑似密钥守卫(不自动提交)+ `.gitignore` 基线 + 受保护路径护栏
- 入口文件单源投影(AGENTS/CLAUDE/GEMINI)+ user-rules 保留区(重投影不冲掉项目自定义规范)
- 认领锁 `.relay/claims/T###.lock`(原子创建,TTL 4 小时,到期可接管)
- `relay_restructure`:保守分类迁移 + manifest 白名单修宪 + DECISIONS/LOG/TASKS 自动记录
- CI 模板(node 22/24 矩阵:结构检查 + 项目测试)
- 自举:本仓库自 v1.0.0 起运行自身的接力协议(见根目录 START.md / TASKS.md / LOG.md)
