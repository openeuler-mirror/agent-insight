# 统一推理转发实现计划

1. 在 `test/inference-gateway.test.ts` 编写真实 HTTP 的失败测试，覆盖转发、统一请求头、流式响应、失败重试及安全路由边界。
2. 实现 `scripts/inference_gateway.mjs` 独立入口与原子关联记录。默认本机监听，配置固定上游，不自动重试。
3. 先补 Qoder / OpenCode 采集关联测试，再修改 collector、plugin、uploader、OTLP adapter 与 Trace 目标解析。统一 ID 与原生 ID 分开；未确定归属保留在 Trace。
4. 更新已有使用指南和开发者契约，保留前端外部 URL 未配置状态。
5. 通过真实 CLI、模拟推理服务、上传处理器、隔离 SQLite 和最终 LLM 节点验证，保存可复核证据；执行聚焦测试与全量测试，分别报告结果。

本计划沿用本会话已确认方案，不启动开发服务或浏览器，不修改全局 Agent 配置，不提交或推送代码。
