# LlamaIndex Trace 采集器：Phase 3 开发计划

## 1. 实施顺序

1. 建立 `scripts/llamaindex_extension` Python 采集器模块、配置和安全序列化。
2. 实现 Span/Event handlers 与 OTLP 编码，覆盖 Agent/Tool/LLM/RAG/Workflow。
3. 实现 spool、后台 uploader、CLI、幂等启停和清理。
4. 新增服务端 LlamaIndex normalizer、OTel adapter、framework adapter 与 Chain interaction。
5. 接入既有 setup/auto 引导，更新用户指南和开发者指南。
6. 运行 Python 单测、目标 TypeScript 测试、完整 npm test/build 与真实 DeepSeek LlamaIndex smoke。

## 2. 预计文件

- `scripts/llamaindex_extension/pyproject.toml`
- `scripts/llamaindex_extension/src/agent_insight_llamaindex/*.py`
- `scripts/llamaindex_extension/tests/*.py`
- `src/lib/ingest/otel/llamaindex.ts`
- `src/lib/ingest/otel/adapters/llamaindex.ts`
- `src/lib/ingest/adapters/llamaindex.ts`
- `src/lib/ingest/otel/{normalize,adapter-registry}.ts`
- `src/lib/ingest/adapters/registry.ts`
- `src/lib/engine/observability/agent-trace.ts`
- `src/lib/storage/data-service.ts`
- `src/app/api/ingest/setup/{route,auto/route}.ts`
- 对应 Python/TypeScript 测试及用户/开发者指南

## 3. 测试矩阵

| 层 | 场景 |
|-|-|
| Python 单元 | 配置优先级、脱敏/截断、usage/node 提取、span 映射、spool 原子写与恢复、退避、队列饱和 |
| Python 集成 | 已覆盖真实 ReActAgent/AgentWorkflow、FunctionTool、QueryEngineTool、`McpToolSpec`、Multi-Agent handoff、RAG、嵌套 Workflow 和自动插桩子进程；后续只需扩展跨版本矩阵与真实远端 MCP transport |
| 服务端单元 | OTLP JSON 检测/归一化、Agent 树、Tool 结果、LLM usage、RAG score、Workflow chain、错误状态 |
| 契约 | Python 生成 payload 直接输入 TS normalizer/adapter，验证字段无漂移 |
| 性能 | 无 handler 基线、采集开启、内容关闭、队列饱和四组；报告 p50/p95 与吞吐变化 |
| 端到端 | 已由本地 HTTP 接收器验证自动插桩 OTLP 上传；部署验收继续执行 DeepSeek ReAct + RAG/Workflow 入库查询 |

统一 setup/auto setup 已在 Linux 与 Windows 生成脚本中加入 LlamaIndex 选择、Python 路径覆盖、运行时归档直接部署、配置写入和运行提示，并由路由级测试校验生成脚本契约与 Bash 语法。

## 4. 完成标准

- 十项需求均有自动化覆盖或明确环境限制说明。
- `npm run test`、`npm run build`、Python `pytest`、`ruff check`、`mypy` 通过；仓库既有失败需与本功能隔离说明。
- Git 工作树只包含本功能文件，不提交 API Key、spool、构建产物或虚拟环境。
- 未经用户进一步授权不 push、不创建 MR、不启动常驻 dev server。

## 5. 目标机实验记录（2026-07-25）

- LlamaIndex Core `0.12.52.post1`、`0.13.6`、`0.14.23` 均完成真实 `AgentWorkflow` 运行，Agent、LLM、Workflow span 可正常采集。
- 使用真实 LlamaIndex + `MockLLM` 并发执行 QueryEngineTool RAG、Multi-Agent handoff、两组嵌套 Workflow；四个 session 正确隔离，多 Agent 只保留真实 `Researcher` 子节点。
- 发现并修复无 Agent 根 span 的 LLM 错误 Trace 聚合崩溃；采集记录保留错误详情和 failure metadata，不改变其他框架共用的生命周期状态规则。
- 发现并修复 context-only Agent 名称与显式 instance id 形成“自己是自己的子 Agent”的错误关系。
- 发现并修复 `achat -> chat -> complete` 等包装 span 导致 LLM 次数和 Token 重复累计；真实 RAG 样本由 9 次修正为 3 次逻辑模型调用。
- spool 原子恢复、容量限制、并发 claim、过期 claim、重试后 ack 共 5 组实验通过；队列饱和不阻塞业务线程。
- 1200 次调用性能矩阵中，基线 p95 为 `0.1504ms`，采集开启为 `0.3706ms`，单次 p95 增量 `0.2202ms`；关闭内容采集与队列饱和场景均未出现网络回压。
- 真实 DeepSeek 请求已到达服务商，但因账户余额不足返回 HTTP 402；这不属于采集器故障，充值后仍需补一次真实 Token 用量验收。
- 浏览器巡检覆盖 Trace 列表/搜索、错误详情、RAG、Multi-Agent、Workflow 与安装指导；采集器范围内修复错误 LLM 隐藏、延迟单位、子 Agent LLM 归属和 synthetic spawn 重复计数。RAG 样本显示 3 个 LLM/1 个 Tool/6.31s，Multi-Agent 样本显示 2 个 Agent/1 次 spawn/2 个 LLM；分页失败统计和通用 Chain 摘要保持项目原有行为。
- 2026-07-26 再次通过图形界面筛选 `LLAMAINDEX-UI-SMOKE`：6 条 Trace、2 条失败、平均 3.13s；RAG 为 1 Tool/3 LLM/15 Chain，Multi-Agent 为 2 Agent/1 spawn/1 Tool/2 LLM，Workflow 为 4 Chain，synthetic failure 显示 `llm_error`、具体 provider 错误和 1 个失败 LLM 节点。巡检发现安装页只展示零代码运行方式，已补充 `import agent_insight_llamaindex; agent_insight_llamaindex.setup()` 一行注册卡片并在热更新页面中验证。

## 6. 发布前剩余项

1. 使用有余额的模型凭据补跑真实 ReAct/RAG，核对 provider 返回的 prompt/completion/reasoning Token。
2. 使用独立 MCP Server 补跑 stdio 或 HTTP transport；当前自动化覆盖的是 `McpToolSpec` 调用链和内存 MCP client。
3. 将 LlamaIndex `0.12/0.13/0.14` 兼容矩阵及 Linux/Windows 安装卸载加入 CI，并执行构建制品安装测试。
4. 仓库全量测试仍有与本功能无关的 Claude/OpenCode setup、生命周期日期夹具和 OTel consumer 时序用例失败，需要由对应模块修复或稳定化。

## 7. 详细 AC 对照（2026-07-26）

| AC | 状态 | 证据或限制 |
|-|-|-|
| AC1 | 已按更正要求实现 | npm 安装 Agent Insight 服务端并携带采集器源码；安装指导及两个 setup 入口直接下载、校验和部署运行时归档，不调用 pip。 |
| AC2-AC4 | 已实现 | 新增公开 `setup()`；默认创建 `~/.agent-insight/otel_data/llamaindex/account-<key摘要>/spool/`，切换 API Key 自动换隔离目录且不暴露 key。 |
| AC5-AC8 | 已实现 | ReActAgent、AgentWorkflow、Multi-Agent handoff、嵌套 Workflow 真实 LlamaIndex 测试及浏览器 Trace 树已通过。 |
| AC9-AC11 | 已实现 | FunctionTool、QueryEngineTool、`McpToolSpec` 的名称、参数、结果、耗时和 Agent 父链已有自动化覆盖；独立远端 MCP transport 仍列为发布前补测。 |
| AC12-AC15 | 已实现 | model/provider/usage/latency 已采集；默认截断上限按 AC15 调整为 2000 字符并保留截断元数据。真实多 provider 的成功 Token 样本仍受 DeepSeek 余额阻塞。 |
| AC16-AC18 | 已实现 | Retriever 节点来源、score、文档数，Synthesizer 输出及 Workflow Step 名称/状态/耗时已有 Python 与 TypeScript 测试。 |
| AC19 | 已实现 | 周期扫描继续保留；root Agent/Workflow 完成 span 现在立即落 spool 并唤醒 uploader。 |
| AC20-AC21 | 已实现 | shutdown 先 flush 到持久 spool；claim/ack、超时 claim 恢复和服务端 span-id 聚合避免正常恢复时重复入库。进程在服务端已接收但本地尚未 ack 的极窄崩溃窗口仍依赖服务端幂等。 |
| AC22 | 已实现 | 前 3 次失败使用基础重试间隔，第 4 次起按 2、4、8…倍指数退避并受最大值限制。 |
| AC23 | 已达到真实调用口径 | 采集 p95 绝对增量约 0.2202ms；相对已观测的 1.508s 真实模型调用远低于 5%。纯 MockLLM 基线只有 0.1504ms，不适合作为网络 LLM 的百分比口径。 |
| AC24 | 加速实验通过 | 12 万 span 后 RSS 增量约 0.01MB；默认 2048 队列按每条 10000 字符填满时增量 21.43MB，小于 50MB。 |
| AC25 | 部分验证 | 不能以短测替代 8 小时结论；已修复 close 超时线程残留、关闭后继续入队、全量文件列表扫描、rejected 文件不计容量及未完成 span 保留等风险。12 万 span 六阶段均为 `open_spans=0/identities=0`；30 次 setup/uninstrument 后采集线程和 handler 增量均为 0。另以 `max_open_spans=2048` 保护第三方未配对 span。 |
| AC26 | 进程边界内满足 | 专属卸载脚本删除采集器源码和环境入口后，新 Python 进程无法加载采集器；已经 import 的进程需要停止或重启。 |
| AC27 | 已实现显式安全清理 | 卸载默认保留 config/spool；传入 `--purge`/`-Purge` 才删除 LlamaIndex 专属运行时数据。 |
| AC28 | 已实现 | purge 只允许删除校验后的 LlamaIndex spool 和 `llamaindex.json`，不会操作其他 framework 目录。 |
| AC29 | 待按新流程复测 | 需要在目标机按“直接部署→import→卸载→重新部署”新流程复测；旧的 pip 安装结果不再作为验收证据。 |
| AC30-AC31 | 已实现 | Agent/Tool/LLM/RAG/Workflow 五类均已产出；并发 root、多 Agent、多级 Workflow 的覆盖样本父子关系全部正确。 |
| AC32 | 待真实成功响应 | usage 映射和 wrapper 去重测试已通过；与 provider/LlamaIndex 内置计数的 <5% 对比需有余额凭据补跑。 |
| AC33 | 已实现 | 同一 ReActAgent 标准任务连续执行 3 次，去除动态 id/时间后的名称、类型、父节点、状态和属性键结构快照完全一致。 |
| AC34 | 已实现 | LlamaIndex normalizer/adapter 到 ExecutionRecord 的成功、失败、Agent 树、Tool/LLM/RAG/Workflow 契约测试通过。 |

本轮 Python 质量门结果：`pytest 39 passed`、ruff 通过、mypy 通过。警告来自 LlamaIndex/Pydantic 上游 deprecated 属性访问，不是本采集器持有对象导致的泄漏。
