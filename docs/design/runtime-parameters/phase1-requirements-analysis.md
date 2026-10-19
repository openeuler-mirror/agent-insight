# Runtime 参数配置需求

将 MCTS 参数列表、校验、默认值、预设和 CLI 映射迁移到 Runtime YAML，执行客户端上报生效定义，平台动态生成表单。参数属于执行 Runtime，可跨 Benchmark 使用，并扩展普通实验的 OpenCode 等 Runtime。

用户已确认直接切换新协议，不兼容、不迁移旧 `agentOptions.mcts`。历史旧参数不展示或复用。平台和客户端需同步升级。

不修改 Prisma、不新增 API 路由。已有实验快照、客户端能力 JSON 和执行目标接口承载新字段。
