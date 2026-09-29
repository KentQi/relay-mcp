# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式;
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 仓库级写锁 `.relay/relay.lock`:TASKS/LOG 的读改写跨 session_end / claim / restructure / sync 全面串行化,并发双进程回归断言零丢失
- 维护会话语义:`relay_session_end` 传 `maintenance:true` 记 `task=维护`,不计入 R7 发散窗口
- 入场简报带出最新一条 LOG 的负结果与交接提示;存在进行中任务时崩溃恢复优先(含 TTL 接管指引)

### Fixed
- 幂等出场:同一出场重跑不再重复盖戳/记日志/插入 next
- 认领锁 TTL 接管改为 unlink+wx 原子竞争(并发接管不再双成功)
- 认领 model 占位符(`<你的模型标识>`)拒收,防署名污染

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
