# OpenClaw OTel 保留与回归修复设计

## 目标

保留 OpenClaw 官方 OTel 接入能力，修复 MR !203 引入的注册、安装、鉴权、契约、聚合和存储问题，同时保证 OpenCode、Claude Code、CodeAgent、Hermes、JiuwenSwarm 等既有链路行为不变。

## 边界

- 保留共享 OTLP traces/logs 端点及 OpenClaw 专属 adapter。
- OpenClaw OTel 与 watcher 是两条独立采集路径；setup 默认配置 OTel，watcher 仅作为兼容路径，禁止同一安装同时启用两者。
- watcher 的完整 record 进入通用 `/api/ingest/upload` 保存链路；旧 `/api/ingest/openclaw/upload` 保留为兼容入口，但不得再转换成有损 OTel span。
- 模型代理不属于 OTel 接入。停止转发并返回明确的停用响应，消除平台 key 外发风险。
- 不修改 Prisma schema，不删除历史 Trace，不自动修改用户机器上已经安装的脚本。

## 数据流

### OpenClaw OTel

1. `/api/ingest/otel/v1/traces` 完成身份解析和 OTLP JSON/Protobuf 解码。
2. 通用 normalizer 保留 `agent/tool/llm` 类型，并兼容 `witty.*` 与标准 `gen_ai.*` 属性。
3. `service.name=openclaw` 选择 OpenClaw adapter。
4. adapter 生成完整的 LLM、tool、skill 和 agent interactions，并派生调用次数、Token、最终输出及父子关系。
5. storage adapter 必须幂等，多次执行不能重复追加 tool block。

### OpenClaw watcher

1. 新 watcher 直接 POST `/api/ingest/upload`。
2. 旧 watcher POST `/api/ingest/openclaw/upload` 时，兼容 handler 原样复用通用上传 handler。
3. 缺失或错误 key 时沿用通用上传接口的 400/401，不得返回假成功。

## 兼容原则

- 对共享 normalizer 的修改只增加属性别名，不改变其他框架已有优先级。
- OpenClaw adapter 仅匹配 `service.name=openclaw/openclaw-agent`。
- setup 只恢复 MR !203 删除的非交互能力；保留后来加入的框架、OpenCode 修复和 CodeAgent 脚本模块化。
- 注册接口恢复 seed、大小写归一、邮箱校验和唯一键竞态处理，保留当前 API key 格式。

## 验收

- 每个缺陷先有能够稳定失败的自动化用例，再修改生产代码。
- OpenClaw JSON/Protobuf 契约样本必须得到一致 session、类型、Token、tool/skill 和 agent tree。
- watcher 必须保留全部 interactions，错误身份必须明确拒绝。
- OpenCode、Claude Code、CodeAgent、Hermes、JiuwenSwarm 定向测试全部通过。
- 使用隔离数据库运行全量测试和构建；最终再决定是否启动 dev 做浏览器与真实 OpenClaw 会话验收。
