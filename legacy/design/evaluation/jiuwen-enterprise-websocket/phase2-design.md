# JiuwenSwarm 企业版授权与 WebSocket 实验

## 已确认流程

用户在客户端 `$AGENT_INSIGHT_HOME/client/jiuwen-enterprise.json`（默认 `~/.agent-insight/client/jiuwen-enterprise.json`）配置 `baseUrl`、`username`、`password`，权限 600；运行当前账号 curl 安装；实验页面选择授权 Agent、客户端、模型和数据集，执行后查看真实 Trace 与评测结果。凭据仅留客户端，不通过安装 URL、平台 API 或命令参数上传。

## 方案

沿用 #588 的 session.create / chat.send / chat.final WebSocket 协议与原生 session-index Trace 关联。客户端向企业入口登录和请求 agent-contexts，自动从企业入口建立带身份、实例 cookie 及授权路由的 /ws；不使用 HTTP/SSE 下发，不改变浏览器当前实例。采用客户端本地登录，避免平台保存用户密码；仅做固定 bot 配置无法满足多 Agent 选择。

不增加数据库字段或 API 路由；扩展既有能力 JSON 的 agentCatalog（稳定 id、显示名、目标自己的模型、就绪状态），通过现有注册、能力刷新与实验 agents 接口传递。稳定标识绑定入口/实例/组织/bot/user，重名不冲突。界面只展示名称，执行传 id。每次执行重新请求授权列表，撤权、改密码、空模型或发现失败均显式阻断，不回退 main_agent 或其他 Agent。未配置企业文件的个人版保持兼容。

令牌只在客户端进程内存保存，临期刷新；401 只重放只读发现请求，不自动重放任务。失败日志使用固定错误信息，不包含密码/令牌/响应正文。配置变化使令牌和目录缓存失效，账号文件不可读或权限过宽时安装报错。

## 验证

先测试权限/错误密码/401 刷新/撤权/多 Agent/重名/模型隔离/无泄密/WS 精确选路；跑 npm test，对照基线失败。构建 OpenShift 镜像后，在 AgentServer 本地只写三项企业配置、清除旧手工 WS 路由，执行发布的 curl 安装。平台 UI 选 test1、真实模型执行工具任务，检查 WSS 命令、原生 session、原始 span、严格评测结果，并记录每处必要人工操作与失败，绝不导入伪造 Trace。

仅覆盖普通实验；Skill 隔离、FI、Benchmark 不随此次宣称支持。初次 Trace 扩展加载仍可能要求重启 AgentServer，容器后台客户端重启后的托管由部署生命周期负责，文档明确边界。
