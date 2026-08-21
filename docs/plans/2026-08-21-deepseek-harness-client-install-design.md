# DeepSeek Harness 统一客户端安装设计

## 目标

将已验证的 DeepSeek Harness 独立观测安装器纳入 Agent Insight 的统一“客户端安装”入口，使页面预选、普通 setup、auto setup、交互选择与非交互安装对同一框架值 `deepseek-harness` 保持一致。

## 方案选择

1. **复用独立安装器（采用）**：统一脚本只负责识别选择，并把当前平台地址和 API Key 传给 `/api/ingest/setup/deepseek-harness`。优点是安装、摘要校验、profile 配置和幂等逻辑只有一份。
2. 在普通 setup 与 auto setup 中复制 Harness 安装逻辑：生成脚本更自包含，但三份安装实现容易漂移。
3. 仅在安装页增加独立卡片：改动最小，但不能参与多框架安装，也无法覆盖 CLI auto setup。

采用方案 1。

## 行为设计

- 安装页增加 `DeepSeek Harness` 选项，生成 `frameworks=deepseek-harness`。
- 普通 setup 与 auto setup 的白名单、交互选择器和安装 flag 同步增加该值。
- Unix/macOS 安装分支调用现有独立安装器，并通过子进程环境传入 `AGENT_INSIGHT_BASE_URL` 与 `AGENT_INSIGHT_API_KEY`；密钥不进入下载 URL或落入生成脚本文案。
- PowerShell 分支识别该选择，但明确输出“当前仅支持 macOS/Linux，Windows 请使用 WSL”，不显示安装成功摘要。
- 多框架安装时 Harness 失败不阻断其他框架；摘要只在 Harness 安装成功时显示。

## 测试

- 源码契约：安装页、普通 setup、auto setup 均声明同一框架值。
- 生成脚本契约：Unix 脚本包含独立安装器委托和成功摘要；PowerShell 包含 unsupported 提示且没有 Harness 成功摘要。
- 保留既有 DeepSeek Harness 安装器、插件与 OTLP 接入测试。

