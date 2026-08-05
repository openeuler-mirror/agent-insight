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

- AC5～AC34 均有可重复脚本、结果 JSON、验证器和说明文档；安装指导另有 Linux/Windows 路由测试。
- `npm run test`、`npm run build`、Python `pytest`、`ruff check`、`mypy` 通过；仓库既有失败需与本功能隔离说明。
- Git 工作树只包含本功能文件，不提交 API Key、spool、构建产物或虚拟环境。
- 未经用户进一步授权不 push、不创建 MR、不启动常驻 dev server。

## 5. 验证记录（2026-08-03）

- Python collector 测试 `41 passed`；服务端 LlamaIndex 定向测试 `23 passed, 1 platform skip`。
- 所有外部验收 case 均确认实际加载 collector `0.2.0`、官方 `llama-index-observability-otel 0.6.4`、官方兼容 Handler 子类和 `AgentInsightSpanExporter`，不是旧版回调实现。
- 真实 DeepSeek Agent/Tool/LLM/RAG/Workflow 用例全部通过；`LLAMAINDEX-UI-SMOKE` 同时覆盖 Multi-Agent、Skill、FunctionTool 和 MCP Tool，并已成功进入本地 Agent Insight。
- AC23 的受控 LLM 中位延迟增幅为 `1.2792%`；AC24 RSS 增量为 `5.836 MiB`；AC25 在一个 1000 ms 上传仍进行时，40 个异步提交于 `231.933 ms` 内完成。
- AC31 父子关联正确率为 `100%`；AC32 三次真实 DeepSeek Token 对比误差均为 `0%`；AC33 三次规范化结构一致，SHA-256 为 `711714064ea4c710ce7c0436db43968ff223032aaea0d664f90d85b571219013`；AC34 三次 ExecutionRecord 均通过契约校验。
- AC26/AC27/AC29 的停止采集、显式 purge 和重新安装流程通过；卸载不移除同 Python 环境中可能被其他组件复用的官方 OTel 依赖。
- 历史兼容实验还覆盖 LlamaIndex Core `0.12.52.post1`、`0.13.6` 与 `0.14.23`。当前标准验收基线为 `0.14.23`。

外部验收脚本保存在工作区 `demos/`，不进入项目源码或 npm 制品。`llamaindex_case_bootstrap.ps1` 负责选择当前源码/部署目录和 Python；`llamaindex_case_common.py` 提供官方 OTel 运行时断言；每组 case 都包含执行脚本、结果 JSON、验证器和独立说明。

## 6. 发布前剩余项

1. 将 LlamaIndex `0.12/0.13/0.14`、Linux/Windows 安装卸载与构建制品安装加入持续集成，而不只保留本地/目标机验证。
2. 用独立 stdio 或 HTTP MCP Server 补充远程 transport 级验收；当前 AC9～AC11 已覆盖真实 LlamaIndex `McpToolSpec` 到 Agent Insight 的 Tool Trace 路径，但 MCP client 为测试实现。
3. 生产环境仍需执行足够时长的 soak test；当前已完成泄漏风险审计、120,000 Span 状态释放实验及短时 RSS/异步 IO 验收，不能据此宣称完成 8 小时长期运行验证。
4. 为最终待提交 commit 重跑全量构建与仓库测试，记录上游既有失败与本功能定向测试结果，避免沿用中间工作树的历史数字。

## 7. 详细 AC 对照（2026-08-03）

| AC | 状态 | 证据或限制 |
|-|-|-|
| AC1 | 已实现（当前发布模式） | npm 安装 Agent Insight 服务端并携带采集器源码；setup/auto setup 在所选 Python 中用 pip 安装官方 OTel 依赖，再直接下载、校验和部署 Agent Insight 运行时归档。采集器本体不是 PyPI 包。 |
| AC2-AC4 | 已实现 | 新增公开 `setup()`；默认创建 `~/.agent-insight/otel_data/llamaindex/account-<key摘要>/spool/`，切换 API Key 自动换隔离目录且不暴露 key。 |
| AC5-AC8 | 已实现 | ReActAgent、AgentWorkflow、Multi-Agent handoff、嵌套 Workflow 真实 LlamaIndex 测试及浏览器 Trace 树已通过。 |
| AC9-AC11 | 通过 | 真实 DeepSeek Agent 调用了 FunctionTool、QueryEngineTool 与 `McpToolSpec` Tool；名称、参数、结果、耗时和所属 Agent 均通过验证。远程 MCP transport 是增强项。 |
| AC12-AC15 | 通过 | 真实 DeepSeek chat/reasoner 的 model、provider、usage、latency 均采集；超过 2000 字符的 prompt/response 正确截断并保留元数据。 |
| AC16-AC18 | 已实现 | Retriever 节点来源、score、文档数，Synthesizer 输出及 Workflow Step 名称/状态/耗时已有 Python 与 TypeScript 测试。 |
| AC19 | 已实现 | 周期扫描继续保留；root Agent/Workflow 完成 span 现在立即落 spool 并唤醒 uploader。 |
| AC20-AC21 | 已实现 | shutdown 先 flush 到持久 spool；claim/ack、超时 claim 恢复和服务端 span-id 聚合避免正常恢复时重复入库。进程在服务端已接收但本地尚未 ack 的极窄崩溃窗口仍依赖服务端幂等。 |
| AC22 | 已实现 | 前 3 次失败使用基础重试间隔，第 4 次起按 2、4、8…倍指数退避并受最大值限制。 |
| AC23 | 通过 | 同一固定延迟 LLM 在关闭/开启采集器两组中的中位延迟增幅为 `1.2792%`，小于 5%。 |
| AC24 | 通过 | 常驻 RSS 增量 `5.836 MiB`，小于 50 MiB。 |
| AC25 | 通过当前“异步 IO 不阻塞”口径 | 模拟 1000 ms 上传期间，40 个异步提交于 `231.933 ms` 内完成。长期 soak test 仍是生产发布建议，不把短测等同于 8 小时结论。 |
| AC26 | 进程边界内满足 | 专属卸载脚本删除采集器源码和环境入口后，新 Python 进程无法加载采集器；已经 import 的进程需要停止或重启。 |
| AC27 | 已实现显式安全清理 | 卸载默认保留 config/spool；传入 `--purge`/`-Purge` 才删除 LlamaIndex 专属运行时数据。 |
| AC28 | 已实现 | purge 只允许删除校验后的 LlamaIndex spool 和 `llamaindex.json`，不会操作其他 framework 目录。 |
| AC29 | 通过 | “部署→导入/采集→卸载→重新部署→再次采集”流程通过；两次运行均确认官方 OTel 机制，卸载保留共享依赖。 |
| AC30-AC31 | 通过 | Agent/Tool/LLM/RAG/Workflow 五类完整产出；规范任务父子关联正确率 `100%`。 |
| AC32 | 通过 | 三次真实 DeepSeek provider usage 与 Agent Insight Token 统计误差均为 `0%`，小于 5%。 |
| AC33 | 通过 | 相同任务三次规范化结构完全一致，结构项数 20，SHA-256 为 `711714064ea4c710ce7c0436db43968ff223032aaea0d664f90d85b571219013`。 |
| AC34 | 通过 | 三次服务端 LlamaIndex Adapter 输出均满足 ExecutionRecord 契约。 |

上述“通过”对应 2026-08-03 保存的结果 JSON 和验证器输出。真实 API Key 不写入脚本、结果、文档或仓库。
