# LlamaIndex Trace 采集器：Phase 3 开发计划

## 1. 实施顺序

1. 建立 `scripts/llamaindex_extension` Python 采集器模块、配置和安全序列化。
2. 基于官方 `llama-index-observability-otel` 实现 Span/Event Handler 子类、隔离 Provider、非阻塞 exporter 与 OTLP 编码，覆盖 Agent/Tool/LLM/RAG/Workflow。
3. 实现 spool、后台 uploader、CLI、幂等启停和清理。
4. 新增服务端 LlamaIndex normalizer、OTel adapter、framework adapter 与 Chain interaction。
5. 接入既有 setup/auto 引导，更新用户指南和开发者指南。
6. 运行 Python 单测、目标 TypeScript 测试、完整 npm test/build 与真实 DeepSeek LlamaIndex smoke。

## 2. 实现文件

- `scripts/llamaindex_extension/pyproject.toml`
- `scripts/llamaindex_extension/src/agent_insight_llamaindex/*.py`
- `scripts/llamaindex_extension/tests/*.py`
- `src/lib/ingest/otel/llamaindex.ts`
- `src/lib/ingest/otel/adapters/llamaindex.ts`
- `src/lib/ingest/adapters/llamaindex.ts`
- `src/lib/ingest/otel/{normalize,adapter-registry}.ts`
- `src/lib/ingest/adapters/registry.ts`
- `src/lib/storage/data-service.ts`
- `src/app/api/ingest/setup/{route,auto/route}.ts`
- `src/app/api/ingest/setup/llamaindex-collector/{route,archive}.ts`
- `docs/user-guide/observability/llamaindex-trace-collector.md`
- 对应 Python/TypeScript 测试及开发者指南

`pyproject.toml` 只用于仓库内开发、测试和依赖声明，不进入 npm 包中的 collector ZIP。`docs/user-guide/observability/llamaindex-trace-collector.md` 随 Agent Insight npm 制品发布，并由归档路由作为根目录 `README.md` 写入运行时 ZIP；它是项目接入指南和离线安装说明的唯一内容源。共享 Trace renderer 只消费归一化 Interaction，不增加 `framework === 'llamaindex'` 分支；LlamaIndex 特有的错误摘要、包装 Span 去重与子 Agent 归属均在 Adapter 内完成。

## 3. 测试矩阵

| 层 | 场景 |
|-|-|
| Python 单元 | 配置优先级、脱敏/截断、usage/node 提取、span 映射、spool 原子写与恢复、退避、队列饱和 |
| Python 集成 | 真实 DeepSeek ReAct/AgentWorkflow、FunctionTool、QueryEngineTool、`McpToolSpec`、Multi-Agent handoff、RAG、嵌套 Workflow 和自动插桩子进程 |
| 服务端单元 | OTLP JSON 检测/归一化、Agent 树、Tool 结果、LLM usage、RAG score、Workflow chain、错误状态 |
| 契约 | Python 生成 payload 直接输入 TS normalizer/adapter，验证字段无漂移 |
| 性能 | 相同固定延迟 LLM 的关闭/开启对照、RSS 增量、慢上传期间并发提交耗时 |
| 端到端 | 真实 DeepSeek 任务上报至本地 Agent Insight，经 API 与浏览器 Trace 树核验 |
| 运行时守卫 | 每个外部 case 断言 collector 0.2.0、官方 OTel 0.6.4、Handler 继承/注册关系和 exporter 类型 |

统一 setup/auto setup 已在 Linux 与 Windows 生成脚本中加入 LlamaIndex 选择、Python 路径覆盖、运行时归档直接部署、配置写入和运行提示，并由路由级测试校验生成脚本契约与 Bash 语法。

## 4. 完成标准

- Agent、Tool、LLM、RAG、Workflow、上传恢复、性能、卸载重装和数据正确性均有可重复脚本、结果 JSON、验证器和说明文档；安装指导另有 Linux/Windows 路由测试。
- `npm run test`、`npm run build`、Python `pytest`、`ruff check`、`mypy` 通过；仓库既有失败需与本功能隔离说明。
- Git 工作树只包含本功能文件，不提交 API Key、spool、构建产物或虚拟环境。
- 未经用户进一步授权不 push、不创建 MR、不启动常驻 dev server。

## 5. 验证记录（更新于 2026-08-14）

- Python collector 测试 `45 passed`；服务端 LlamaIndex 定向测试
  `38 passed, 1 platform skip`。
- 所有外部验收 case 均确认实际加载 collector `0.2.0`、官方 `llama-index-observability-otel 0.6.4`、官方兼容 Handler 子类和 `AgentInsightSpanExporter`，不是旧版回调实现。
- 真实 DeepSeek Agent/Tool/LLM/RAG/Workflow 用例全部通过；`LLAMAINDEX-UI-SMOKE` 同时覆盖 Multi-Agent、Skill、FunctionTool 和 MCP Tool，并已成功进入本地 Agent Insight。
- 性能对照中，受控 LLM 中位延迟增幅为 `1.4786%`，RSS 增量为 `5.402 MiB`；在一个 1000 ms 上传仍进行时，40 个异步提交于 `237.716 ms` 内完成。
- 数据正确性测试中，父子关联正确率为 `100%`，三次真实 DeepSeek Token 对比误差均为 `0%`，三次规范化结构一致，SHA-256 为 `1b92c3bd20705636152de0a6b1b19ec84f46edb4761e231506babe7a70548adf`；三次 ExecutionRecord 均通过契约校验。
- 停止采集、显式 purge 和重新安装流程通过；卸载不移除同 Python 环境中可能被其他组件复用的官方 OTel 依赖。
- 历史兼容实验还覆盖 LlamaIndex Core `0.12.52.post1`、`0.13.6` 与 `0.14.23`。当前标准验收基线为 `0.14.23`。
- UI 可读性实验确认 LLM 不再显示 Completion/Chat JSON 或 ReAct Action 协议；Skill 节点显示
  名称、版本和 Markdown 正文，自定义 Tool 节点显示安全参数摘要；Skill→Tool case 的 CHAIN
  从 12 个运行时/业务混合节点收敛为 3 个 `Run agent step` 业务步骤。

外部验收脚本保存在工作区 `demos/`，不进入项目源码或 npm 制品。`llamaindex_case_bootstrap.ps1` 负责选择当前源码/部署目录和 Python；`llamaindex_case_common.py` 提供官方 OTel 运行时断言；每组 case 都包含执行脚本、结果 JSON、验证器和独立说明。

## 6. 发布前剩余项

1. 将 LlamaIndex `0.12/0.13/0.14`、Linux/Windows 安装卸载与构建制品安装加入持续集成，而不只保留本地/目标机验证。
2. 用独立 stdio 或 HTTP MCP Server 补充远程 transport 级验收；当前工具采集测试已覆盖真实 LlamaIndex `McpToolSpec` 到 Agent Insight 的 Tool Trace 路径，但 MCP client 为测试实现。
3. 生产环境仍需执行足够时长的 soak test；当前已完成泄漏风险审计、120,000 Span 状态释放实验及短时 RSS/异步 IO 验收，不能据此宣称完成 8 小时长期运行验证。
4. 为最终待提交 commit 重跑全量构建与仓库测试，记录上游既有失败与本功能定向测试结果，避免沿用中间工作树的历史数字。

## 7. 验收能力与实测结果（2026-08-14）

| 验收能力 | 状态 | 测试行为、证据或限制 |
|-|-|-|
| 安装采集器 | 已实现（当前发布模式） | npm 安装 Agent Insight 服务端并携带采集器源码；setup/auto setup 在所选 Python 中用 pip 安装官方 OTel 依赖，再直接下载、校验和部署 Agent Insight 运行时归档。采集器本体不是 PyPI 包。 |
| 一行注册、spool 创建与多账号隔离 | 已实现 | 调用公开 `setup()` 注册；默认创建 `~/.agent-insight/otel_data/llamaindex/account-<key摘要>/spool/`，切换 API Key 自动换隔离目录且不暴露 key。 |
| Agent、子 Agent 与 Workflow 链路 | 已实现 | 执行 ReActAgent、AgentWorkflow、Multi-Agent handoff 和嵌套 Workflow，验证会话信息、父子关系、步骤 Trace 及浏览器 Trace 树。 |
| FunctionTool、QueryEngineTool 与 MCP Tool 采集 | 通过 | 确定性 ReAct 控制器在单条 Agent trace 内依次调用三种真实 Tool，QueryEngineTool 内执行真实 DeepSeek 调用；验证工具名称、输入、输出、耗时、状态及所属 Agent。远程 MCP transport 是增强项。 |
| LLM 模型、Token、延迟与内容截断 | 通过 | 分别调用真实 DeepSeek chat/reasoner，验证 model、provider、prompt/completion/total tokens 和延迟；确认超过 2000 字符的 prompt/response 被正确截断。 |
| Retriever、Synthesizer 与 Workflow Step | 已实现 | 执行固定文档 RAG 和两步 Workflow，验证检索来源、文档数、score、生成结果及步骤名称、状态和耗时。 |
| 周期上传与会话结束触发上传 | 已实现 | 验证周期扫描继续工作；root Agent/Workflow 完成 span 会立即落 spool 并唤醒 uploader。 |
| 退出 flush、断点恢复与避免重复入库 | 已实现 | shutdown 先 flush 到持久 spool；验证 claim/ack、超时 claim 恢复和服务端 span-id 聚合。服务端已接收但本地尚未 ack 的极窄崩溃窗口仍依赖服务端幂等。 |
| 连续失败后的指数退避 | 已实现 | 模拟上传连续失败，验证前 3 次使用基础间隔，第 4 次起按 2、4、8…倍退避并受最大值限制。 |
| LLM 调用延迟开销 | 通过 | 对同一固定延迟 LLM 分别关闭/开启采集器，中位延迟增幅为 `1.4786%`，小于 5%。 |
| 常驻内存开销 | 通过 | 对比关闭/开启采集器后的 RSS，增量为 `5.402 MiB`，小于 50 MiB。 |
| 异步 IO 不阻塞 | 通过当前短时口径 | 模拟 1000 ms 上传期间，40 个异步提交于 `237.716 ms` 内完成。长期 soak test 仍是生产发布建议，不把短测等同于 8 小时结论。 |
| 卸载后停止采集 | 进程边界内满足 | 专属卸载脚本删除采集器源码和环境入口后，新 Python 进程无法加载采集器；已经 import 的进程需要停止或重启。 |
| 卸载时清理专属数据 | 已实现显式安全清理 | 卸载默认保留 config/spool；传入 `--purge`/`-Purge` 才删除 LlamaIndex 专属运行时数据。 |
| 不干扰其他框架采集器 | 已实现 | purge 只允许删除校验后的 LlamaIndex spool 和 `llamaindex.json`，不会操作其他 framework 目录。 |
| 卸载后重新安装 | 通过 | 执行“部署→导入/采集→卸载→重新部署→再次采集”；两次运行均确认官方 OTel 机制，卸载保留共享依赖。 |
| 五类 Trace 完整性与父子关联 | 通过 | 标准任务完整产出 Agent、Tool、LLM、RAG、Workflow 五类 Trace，父子关联正确率为 `100%`。 |
| Token 统计准确性 | 通过 | 三次真实 DeepSeek provider usage 与 Agent Insight Token 统计误差均为 `0%`，小于 5%。 |
| 重复执行的结构稳定性 | 通过 | 相同任务执行三次，规范化结构完全一致，结构项数 17，SHA-256 为 `1b92c3bd20705636152de0a6b1b19ec84f46edb4761e231506babe7a70548adf`。 |
| 服务端 Adapter 转换 | 通过 | 将三次上报数据交给 LlamaIndex Adapter，输出均满足 ExecutionRecord 契约。 |

上述“通过”对应 2026-08-14 保存的结果 JSON 和验证器输出。真实 API Key 不写入脚本、结果、文档或仓库。
