# START — 接力引导扇区

> 项目:{{PROJECT_NAME}} · 初始化:{{TODAY}} · 本文件 ≤1 页,保持常青

任何模型、任何会话,开工前只做三步:

## 第一步 验状态

`./verify`(委托 relay 引擎机检 R1-R9)。有 error → 先按输出中的“修复:”指令处理,再继续;仅 warn(R5/R6/R8)→ 可继续,记得补课。
若本机没有 relay 引擎:`export RELAY_HOME=/path/to/relay-mcp` 后再跑;没有挂 MCP 时也可用 CLI:`node "$RELAY_HOME/src/cli.mjs" relay_verify --root .`

## 第二步 领任务

读 `TASKS.md`:顶部第一个未认领的 `T###` 就是你的任务;已认领(行尾带模型名+时间戳)的不要碰。并行协作先 `relay_claim` 认领。

- 意图与验收标准(做到什么算完)→ `SPEC.md`
- 已定的技术选择(勿重复论证)→ `DECISIONS.md`
- 上个会话干了什么、踩了什么坑 → `LOG.md`

## 第三步 按协议干

`relay_session_start` 进场简报 → 小步实现(红灯协议:验收为 `test:<路径>` 的任务,先让失败测试存在)→ 自验 verify → `relay_session_end` 出场绿闸:verify 全量通过才自动更新 TASKS/LOG 并提交,不绿不提交。

## 红线

- 受保护路径(`verify`、`.relay/`、`tests/`、`*.test.*`、`*.spec.*`)的改动不会自动提交,需人类批准;疑似密钥文件(`.env*`、`*secret*`、`*.key`、`*.pem`)同理
- 出场绿闸会实际执行可执行验收(`test:` 路径跑 `node --test`;有 `package.json` 的 `scripts.test` 就跑 `npm test`)——不绿不提交
- LOG 连续 3 条无“完成”(R7)→ 停机升级人类仲裁,不要硬干
- 验收标准不可执行 = 没有验收标准;一个会话内搞不定 → LOG 写负结果,换路或拆任务
