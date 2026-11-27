---
title: 自更新启动器审计索引（并入深层扫描报告）
version: 1.0
created: 2026-11-28
status: 现行
---

# 自更新启动器审计索引

原始审查会话 `446b3766` 的自更新启动器发现已并入 [深层原子级扫描审计 v2.1](13-audit-deep-scan-v2.1.md) 的 §9，后续 T073 复核与修复证据在同报告 §12 及当前任务分支的 LOG 中。

本文件仅补齐 T067 的历史引用，避免 `TASKS.md` 指向不存在的审计入口。

## T073 最终回归

- `fetch` 后固定 before/upstream 两个 SHA，后续 ahead/behind、祖先判断、CAS 发布和终检均使用不可变对象；HEAD ABA 与比较途中 ref 移动都按 fail-closed 处理。
- `refs/heads/main` 发布前写 `relay-autoupdate-transaction.json`；发布走 `git update-ref <new> <old>`（支持 SHA-256 与 reftable），工作树同步改用 `read-tree -m -u <before> <upstream>`，并发 tracked edit 不会被 `--reset` 覆盖。
- 每次启动在 6h/10min 节流之前检查 transaction journal；SIGKILL 留下的「HEAD 已前移、index/worktree 仍旧」混合树直接拒绝启动，不获得 `checking` 冷却豁免。
- `smoke-autoupdate.mjs` 覆盖 HEAD ABA、ref 竞态、Git 原生转换拒绝本地编辑、ref 发布前后强制终止、SHA-256 与 reftable；当前为本机 Node 26 下 **125/0**。
