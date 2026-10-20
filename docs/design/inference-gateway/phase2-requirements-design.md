# 统一模型转发与推理关联

## 需求与边界

Qoder、OpenCode 通过我们维护的入口访问实际推理服务；推理服务只读取 `X-Agent-Insight-Call-Id`，将其与一次物理 HTTP 模型请求绑定。整条 Trace 提供调用 ID 集合，LLM 节点提供属于该节点的调用 ID 集合。重试各有 ID，不把逻辑消息 ID 当成物理调用 ID。

本阶段使用本地独立 Node.js 进程，不新增平台数据库表。转发与采集在同机、同一 Agent Insight 账号目录运行。中央网关到远端采集器的关联记录传输不属于本阶段。

外部分析页使用 `<origin>/model-performance?GlobalTrackNO=<call_id>`，参数仅支持一个调用 ID。平台通过运行时环境变量 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 配置协议、主机和端口。整条 Trace 弹窗列出每次请求，分别打开；单个 LLM 存在重试时，仅在开始时间能唯一确定顺序的情况下默认打开最近一次请求，其余请求保留独立入口。缺少统一调用 ID 时不使用会话、消息或响应 ID 替代。配置未填写或无效时展示原因，不生成链接。

## 接口契约

启动参数指定配置 JSON：监听地址（默认 loopback）、端口、路由列表。每条路由指定 `basePath`、`upstreamBaseUrl`、`agent`（qoder/opencode）和 `protocol`（openai/anthropic）。支持 `/chat/completions`、`/responses`、`/messages` 模型 POST 和 `/models` GET；不开放任意上游 URL 参数。协议原样转发，不进行模型协议转换。

每个模型 POST 生成 UUID，覆盖客户端同名请求头，发送给固定上游，并在响应头返回同一 ID。请求体、状态码及 SSE 数据保留；不自行重试，不跟随重定向，不记录密钥或提示词。上游认证默认透传，也可通过路由的环境变量引用设置。仅监听 loopback。

网关先持久化调用开始记录，再发请求；结束记录包含状态、响应 ID、完成/中断状态。Qoder 记录按账号、会话隔离，一请求一文件，原子更新。服务响应 ID 只从成功 JSON/SSE 协议对象读取，不采信本地错误 ID。冲突响应 ID 不匹配节点。

## 采集与展示

- OpenCode 插件从响应头获取统一 ID，沿 `llm.attempt`、uploader、interactions 保留到具体 LLM。一个逻辑节点的多次重试可对应多个统一 ID。
- Qoder collector 读取本地网关记录，以 session 与真实 response ID 唯一匹配成功 LLM。没有唯一匹配的记录保留为 Trace 级关联元数据，明确标记未归属，不能猜测并发子 Agent 或本地合成错误节点。
- `inference_call_ids` 是统一对外关联字段；原有原生 request/response/attempt ID 继续作为诊断字段。整体入口包含未归属尝试，单节点入口只包含精确匹配 ID。

## 验收

自动测试覆盖请求/响应透传、唯一 ID、流式协议解析、错误与重试、取消、并发、路径约束、歧义响应、采集及节点解析。真实 Qoder/OpenCode 使用隔离配置连接网关及本地模拟推理服务，检查同会话多调用、并发子 Agent、503 重试和最终持久化数据。只验证数据链路。

## 自动配置与安装前备份提示

Unix curl 安装分发独立运行文件，先建立本机网关并检查健康，再原子改写可识别的自定义 Provider 地址。JSONC 保留注释与无关格式。配置写入前检查原文未并发变化；只保留转发必需的上游映射、受管字段与路由元数据，目录 0700、状态文件 0600，不生成原配置的自动备份，也不另存已合并的认证信息。

安装修改采集 Hook/插件、模型地址及 Qoder CLI 启动入口前，明确提醒用户自行备份相关用户和项目配置。多文件处理中途失败时不整批回滚，用户应检查可能已修改的文件；不能以已完成状态掩盖失败。当前不提供自动卸载、字段回退或一键恢复入口。

OpenCode 的现有 config 插件处理最终合并配置，覆盖显式 Base URL 的全局、项目和环境来源。Qoder CN CLI 启动器在配置读取前同步全局、项目、local 和显式 settings；后台轮询用于及时同步已登记文件，不作为新 Provider 首次请求绝不绕行的保证。Qoder 运行中新增或修改 Provider 后须重新启动 CLI；已托管 Provider 之间切换模型无需更改用户操作。未识别协议、内置账号服务以及 IDE 私有配置不声称已托管。Qoder 启动器保留原二进制以继续执行原 CLI，这不属于配置备份能力。

后台路由保留旧版本，避免用户更换上游后中断已经载入旧地址的会话。每个物理请求仍生成独立调用 ID。用户自行恢复配置前需退出 Agent/IDE，并先停止后台同步，避免地址再次被改写；恢复时自行合并后续配置修改。既有 Trace、spool 和关联日志不因卸载/恢复功能移除而删除。

### OpenCode 2.x 兼容边界

沿用现有出站 `X-Agent-Insight-Call-Id`、spool、上传接口与数据库字段，不要求推理服务按 Agent 或主版本适配。2.x 请求发送前尚无原生 assistantMessageID，插件先登记 transport request / attempt 标识，收到唯一可确认的原生 step 后回填消息身份；uploader 按 session/transport/attempt 的原生绑定证明关联 journal，失败和成功重试均保留独立 call ID。多个候选或缺失事件不猜测归属。1.x 仍使用原有 chat.headers/fetch 路径。

2.x 配置支持 `providers.*.settings.baseURL`，沿用原子字段改写和并发变更检查；实际 HTTP hook 同步最终请求地址，覆盖新 Provider 首请求。受管请求只走支持的 HTTP 协议，未知路径或 WebSocket 不静默绕过代理。安装按 CLI 主版本分发不同插件入口；跨主版本升级需重新运行安装命令。
