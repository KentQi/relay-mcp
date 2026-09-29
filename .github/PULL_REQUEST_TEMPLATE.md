## What / 做了什么

<!-- 一两句话;动了模板还是引擎 -->

## Why / 为什么

<!-- 关联 Issue 号或任务号(T###);写清动机 -->

## Acceptance evidence / 验收证据

<!-- 按本仓库协议:不贴运行结果的 PR 不会被 review -->

```sh
# 你跑过的验证命令及其结果摘要(npm test / ./verify ...)
```

- [ ] `npm test` 全绿(改动涉及 Node 版本行为的,至少两个大版本各跑一遍)
- [ ] `./verify` 无 ERROR
- [ ] 动了 `templates/` → 已评估 `relay_sync` 对已接入项目的非破坏性
- [ ] 动了检查器 → CONTRACT.md / README.md 规则表已同步
