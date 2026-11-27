# 企业版 WebSocket 实验实施计划

**Goal:** 配置本地凭据、curl 安装后，从实验页选择授权 Agent 并通过 #588 WS 执行，关联真实 Trace 与评测。
**Architecture:** 本地企业身份与目录模块 + 既有 WebSocket runtime + 能力 agentCatalog + 既有实验 UI。
**Tech Stack:** Node 原生 HTTP/fetch、已有 RFC6455 客户端、TypeScript/Next.js。

1. 新增 test/jiuwen-enterprise-ws.test.ts：本地身份测试服务、真实 WS，验证权限、登录刷新、授权变动、空目录、重名与安全；先看到功能缺失失败，再实现 scripts/jiuwen-enterprise-ws.cjs。
2. 扩展 test/jiuwen-experiment-runtime.test.ts：企业目标运行 session.create/chat.send、目标拒绝及模型不可用；实现 enterprise socket 适配，个人版兼容，空模型 probe 修复。
3. 扩展能力与现有实验 agents 合约测试，agentCatalog 规范化和 per-Agent 模型；实验选择器展示友好名，稳定 id 下发。
4. 安装器与 bundle 纳入模块，安装时登录发现并明确结果；能力定时异步刷新，运行前强制重新授权。不新增路由/数据库。
5. 同步中英文实验/环境/客户端安装文档。npm test、类型检查、聚焦回归、构建镜像。
6. OpenShift 部署读回 digest 和健康；只用凭据文件 + 发布 curl；浏览器选择 test1 创建真实实验，验证 session 因果 Trace 和精确评测，保留脱敏证据与人工步骤。
