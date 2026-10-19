# 统一推理转发实现计划

1. 在 `test/inference-gateway.test.ts` 编写真实 HTTP 的失败测试，覆盖转发、统一请求头、流式响应、失败重试及安全路由边界。
2. 实现 `scripts/inference_gateway.mjs` 独立入口与原子关联记录。默认本机监听，配置固定上游，不自动重试。
3. 先补 Qoder / OpenCode 采集关联测试，再修改 collector、plugin、uploader、OTLP adapter 与 Trace 目标解析。统一 ID 与原生 ID 分开；未确定归属保留在 Trace。
4. 更新已有使用指南和开发者契约，保留前端外部 URL 未配置状态。
5. 通过真实 CLI、模拟推理服务、上传处理器、隔离 SQLite 和最终 LLM 节点验证，保存可复核证据；执行聚焦测试与全量测试，分别报告结果。

本计划沿用本会话已确认方案，只验证数据链路，不启动开发服务或浏览器。安装验收使用隔离 HOME 和配置，完成后提交并推送 upstream/dev-jh。

## curl 安装与配置托管

1. 先用失败测试固定 JSON/JSONC 字段改写、首次备份、重复安装、模型/Provider 变更及保留后续修改的恢复语义，再实现独立配置内核。
2. 实现本机网关生命周期、健康检查、单实例锁、后台同步、启动前同步和恢复命令；配置改写只能发生在网关健康后。
3. OpenCode 在现有插件 config 钩子处理最终合并配置；Qoder CLI 安装受管启动入口，在原 CLI 读取配置之前同步。保持原命令、模型名、Provider 名和凭证。
4. 将运行文件接入已有安装组件白名单与 Bash curl 流程，生成一键恢复入口；修改相应用户指南和开发者契约。
5. 在隔离环境执行生成的安装脚本片段与真实 CLI，连接模拟推理服务，覆盖安装、模型切换、新增 Provider、失败重试、恢复，核对上游 ID、采集和最终 Trace/LLM。
6. 做专项与全量测试、独立审查，记录已知基线失败和支持范围，提交并验证 upstream/dev-jh 的远端 SHA。

## OpenCode 2.x 与 1.x 并行兼容

1. 固定 2.0.32 的真实失败基线：V1 插件函数被拒绝，已有代理请求有调用 ID 但缺少会话/消息归属，新 Provider 的首请求绕过代理。
2. 保留 V1 下载产物与 Hook；安装时识别 CLI 主版本，为 V2 分发 `id + setup` 入口。V2 将原生 step、text、tool、session 事件转换为已有采集记录，先分配 transport request / attempt UUID，待原生 step 公布 assistantMessageID 后用唯一生命周期证据回填，再以 session/transport/attempt 三元组关联 journal；歧义留在 Trace，辅助请求不冒充主循环 LLM。
3. 扩展 JSON/JSONC 字段托管到 V2 `providers.*.settings.baseURL`；V2 HTTP 请求发送前同步路由，支持运行时 Provider/模型地址，独立生成每次 attempt，失败响应也保留统一调用 ID。保留字段备份与无损恢复。
4. 先补事件转换、并发归属、重试、缺失身份、分发和原生 V2 配置的失败测试，再实现适配。复用上传与最终节点聚合，不新增数据库模型或 API 路由。
5. 用真实 2.x 和保留的 1.x CLI 连接模拟推理服务，验证多次调用、并发子 Agent、失败重试、模型切换、新 Provider 首请求、恢复及重复上报后的精确关联。执行专项、类型与全量检查，只验证数据链路；刷新对应指南。


本轮完成 2.0.32 原生插件、旧配置兼容、原生 Provider 配置托管及失败节点关联。ARM64 真实 CLI 使用模拟推理服务，三组版本/配置各验证六场景（含重试后最终失败）：40 次实际请求、18 条 Trace、30 个 LLM 节点全部精确关联，重复上传保持一致；三份配置恢复保留新增 Provider 和用户后续修改，原有 1035 个用户配置文件未改动。83 项专项、类型检查及分发路由 ESLint 通过。全量测试 3653 项中 3493 通过、141 失败、19 跳过，未获得全量通过；未验证浏览器、真实云模型及 Windows。验证证据保存在本地 `exclude/diagnostics/opencode-v2-final-20261019/verification.json`。
