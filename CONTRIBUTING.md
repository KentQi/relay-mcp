# 贡献指南 / Contributing

谢谢你对 relay-mcp 的兴趣!这个项目自己就跑在自己的接力协议上——**给它贡献代码,请按 START.md 干活**。

Thank you for your interest in relay-mcp! The project dogfoods its own relay protocol — **to contribute, just follow `START.md` in the repo root.**

## 开发流程(即 relay 六步协议)

1. **进场**:通读根目录 `START.md`,跑 `./verify`(或 `npm run verify`)确认全绿;
2. **认领**:从 `TASKS.md` 待办区选任务(或与维护者讨论新任务,必须带可判定的 `验收:` 行),开工前 `relay_claim`(或手动把任务行标为 `[~] (你的名字, 日期)`);
3. **实现**:小步提交;引擎源码在 `src/`,模板在 `templates/`(模板运行时读取,改模板=改规范,走 `DECISIONS.md`);
4. **自验**:`npm test`(端到端冒烟,81+ 断言)必须全绿;改动涉及 Node 版本行为时,至少在两个 Node 大版本上各跑一遍;
5. **出场**:PR 描述写清"做了什么/为什么/验收证据(命令输出)";所有 CI 检查绿 + 维护者 review 通过后合并;
6. **不绿不合并**:CI 红的 PR 不会被看第二眼——这不是态度,是协议。

## 约定

- **零运行时依赖**:只用 `node:` 内置模块,禁止引入任何 npm 依赖(开发工具除外);
- **模板即真相**:项目脚手架/入口文件的内容只改 `templates/`,生成的文件是投影,不要直接改投影侧样例;
- **规则改动走修宪**:新增/修改检查器(R1-R9)必须同步 CONTRACT.md 的规则表与 README,三处一致才算完整;
- **非破坏铁律**:任何写盘操作对已存在的用户文件必须先备份(`*.relay-bak-*`),永不删除。

## 报告问题

用 Issue 模板。涉及安全漏洞请走 `SECURITY.md`,不要公开 Issue。
