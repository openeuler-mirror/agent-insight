# 统一模型转发与推理关联

## 需求与边界

Qoder、OpenCode 通过我们维护的入口访问实际推理服务；推理服务只读取 `X-Agent-Insight-Call-Id`，将其与一次物理 HTTP 模型请求绑定。整条 Trace 提供调用 ID 集合，LLM 节点提供属于该节点的调用 ID 集合。重试各有 ID，不把逻辑消息 ID 当成物理调用 ID。

本阶段使用本地独立 Node.js 进程，不新增平台数据库表。转发与采集在同机、同一 Agent Insight 账号目录运行。中央网关到远端采集器的关联记录传输不属于本阶段。外部分析页面地址仍待约定。

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

## 自动配置与恢复

Unix curl 安装分发独立运行文件，先建立本机网关并检查健康，再备份和原子改写可识别的自定义 Provider 地址。JSONC 保留注释与无关格式。原始字节备份只创建一次，状态记录每个托管字段的原始值和写入值；目录 0700、备份和状态 0600。凭证保留在原配置；备份也属于敏感本地文件，不上传。

OpenCode 的现有 config 插件处理最终合并配置，覆盖显式 Base URL 的全局、项目和环境来源。Qoder CN CLI 启动器在配置读取前同步全局、项目、local 和显式 settings；后台轮询用于及时同步已登记文件，不作为新 Provider 首次请求绝不绕行的保证。Qoder 运行中新增或修改 Provider 后须重新启动 CLI；已托管 Provider 之间切换模型无需更改用户操作。未识别协议、内置账号服务以及 IDE 私有配置不声称已托管。

后台路由保留旧版本，避免用户更换上游后中断已经载入旧地址的会话。每个物理请求仍生成独立调用 ID。恢复先通过独占锁暂停配置同步，再逐字段撤销仍属于我们的改写；已被用户再次修改的字段不覆盖，新增 Provider/模型等其他字段保留。未修改文件恢复为首次备份字节。配置恢复失败时保持原启用状态；恢复成功后才停用同步、停止网关、还原仍由我们管理的 CLI 启动入口；升级或用户替换过的启动入口保持原样。安装失败回滚本轮改写，不能以已完成状态掩盖失败。

### OpenCode 2.x 兼容边界

沿用现有出站 `X-Agent-Insight-Call-Id`、spool、上传接口与数据库字段，不要求推理服务按 Agent 或主版本适配。2.x 请求发送前尚无原生 assistantMessageID，插件先登记 transport request / attempt 标识，收到唯一可确认的原生 step 后回填消息身份；uploader 按 session/transport/attempt 的原生绑定证明关联 journal，失败和成功重试均保留独立 call ID。多个候选或缺失事件不猜测归属。1.x 仍使用原有 chat.headers/fetch 路径。

2.x 配置支持 `providers.*.settings.baseURL`，保留字节备份及按字段恢复；实际 HTTP hook 同步最终请求地址，覆盖新 Provider 首请求。受管请求只走支持的 HTTP 协议，未知路径或 WebSocket 不静默绕过代理。安装按 CLI 主版本分发不同插件入口；跨主版本升级需重新运行安装命令。
