# Security Policy / 安全策略

## Supported versions / 支持版本

| Version | Supported |
|---|---|
| main branch | ✅ |

## Reporting a vulnerability / 报告漏洞

**不要用公开 Issue 报告安全漏洞。**

- English: use GitHub's [private vulnerability reporting](https://github.com/KentQi/relay-mcp/security/advisories/new), or email the maintainer **kirroyu@126.com**.
- 中文:请通过 GitHub 私密漏洞报告(同上链接)或发邮件至 **kirroyu@126.com**,我们会在 72 小时内响应。

## Scope notes / 范围说明

这个项目的信任模型特意做了以下声明,审计时可重点关注:

1. `relay_session_end` 的验收执行门只执行两类已知入口:`test:` 路径的 `node --test` 与项目自身 `package.json` 声明的 `scripts.test`(npm test)。**验收行里的自由文本命令从不被解析执行**。
2. 疑似密钥文件(`.env*`/`*secret*`/`*credential*`/`*.key`/`*.pem`/`id_rsa`)与受保护路径(`verify`/`.relay/**`/`tests/**`/`*.test.*`/`*.spec.*`)的改动**不会自动提交**。
3. 已知边界:受保护路径护栏只看未提交 diff,模型中途自行 `git commit` 可绕过本地护栏——最终防线在 CI 与人工抽查(README 有声明)。
