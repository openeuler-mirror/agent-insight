# agent-insight-llamaindex

`agent-insight-llamaindex` 是 Agent Insight 的 LlamaIndex Trace 采集器。它通过
LlamaIndex instrumentation dispatcher 采集 Agent、子 Agent、Tool、LLM、RAG 和
Workflow 调用链，先将数据持久化到本地 spool，再由后台线程异步上传到 Agent
Insight。

采集器不修改 LlamaIndex 业务对象。业务线程只执行有界序列化和非阻塞入队，文件写入与
网络上传由后台线程处理。

## 支持范围

| 类型 | 已采集信息 |
| --- | --- |
| Agent | sessionId、query、Agent 名称与实例、模型、Token、耗时、状态和最终结果 |
| 子 Agent | 父子关系、任务描述、实例标识、状态、Token 和耗时，支持嵌套与并发 |
| Tool | FunctionTool、QueryEngineTool、MCP Tool 的名称、参数、返回值、状态和耗时 |
| LLM | modelName、provider、prompt/completion/total tokens、输入输出、状态和推理耗时 |
| RAG | Retriever 查询、文档来源、文档数量、相关性得分，以及 Synthesizer 输入输出 |
| Workflow | Workflow 与步骤名称、输入输出、父子关系、状态和耗时 |

已验证的 LlamaIndex Core 版本为 `0.12`、`0.13` 和 `0.14`。采集器要求 Python 3.10
或更高版本。

## 安装

Agent Insight 服务端通过 npm 安装；LlamaIndex 可观测插件源码随服务端制品携带，由安装
接口直接部署，不发布到 pip 或 npm 仓库。本地开发环境先构建并安装 Agent Insight 服务端 tarball
（不要执行 `npm publish`）：

```bash
npm run build
mkdir -p dist-local
npm pack --pack-destination dist-local
npm install --global ./dist-local/agent-insight-0.5.4.tgz
agent-insight start
```

然后打开 Agent Insight 的“安装指导”页面，在一键脚本中选择 `LlamaIndex Trace Collector`。
安装器从当前 Agent Insight 实例下载只包含采集器模块的 zip，并部署到：

```text
~/.agent-insight/collectors/llamaindex/current/agent_insight_llamaindex/
```

`curl | bash` / `irm | iex` 一键安装由 `/api/ingest/setup` 生成；本地 npm 服务端安装后的自动
配置使用 `/api/ingest/setup/auto`。两个入口采用相同的直接下载、暂存解压和目录替换流程，
不会调用 pip，也不会写入 Python `site-packages`。安装器生成专属的
`~/.agent-insight/llamaindex_env.sh/.ps1`，仅把上述唯一模块目录加入 `PYTHONPATH`；采集器仍需
通过 `setup()` 或专用 `cli run` 显式启用，不会自动影响其他 Python 应用或采集器。

若 LlamaIndex 位于虚拟环境，执行安装指导命令前指定该环境的 Python：

```bash
export AGENT_INSIGHT_LLAMAINDEX_PYTHON=/path/to/venv/bin/python
```

```powershell
$env:AGENT_INSIGHT_LLAMAINDEX_PYTHON = "C:\path\to\venv\Scripts\python.exe"
```

这个 Python 只用于确认 Python 3.10+、检查项目已安装 LlamaIndex、解压归档和写入配置；
安装器不会替项目安装或升级 LlamaIndex 依赖。零代码 `run` 只对子进程注入包内 bootstrap，
不注册全局 `sitecustomize`、不改写其他采集器配置，也不删除其他框架目录。

## 快速开始

### 方式一：零代码运行

先写入 Agent Insight 连接配置：

```bash
export AGENT_INSIGHT_API_KEY="<your-agent-insight-api-key>"

python -m agent_insight_llamaindex.cli configure \
  --endpoint https://agent-insight.example.com \
  --api-key "$AGENT_INSIGHT_API_KEY" \
  --user "$USER"
```

然后通过自动插桩入口启动现有应用：

```bash
python -m agent_insight_llamaindex.cli run -- python app.py
```

`run` 只给它启动的子进程注入专用 bootstrap，不设置持久化环境变量，也不会自动注册到
其他 Python 进程。

Windows PowerShell 示例：

```powershell
$env:AGENT_INSIGHT_API_KEY = "<your-agent-insight-api-key>"
python -m agent_insight_llamaindex.cli configure `
  --endpoint https://agent-insight.example.com `
  --api-key $env:AGENT_INSIGHT_API_KEY `
  --user $env:USERNAME
python -m agent_insight_llamaindex.cli run -- python app.py
```

### 方式二：一行代码注册

应用已经自行管理启动方式时，在创建或调用 LlamaIndex Agent 前注册采集器：

```python
import agent_insight_llamaindex; agent_insight_llamaindex.setup()
```

完整示例：

```python
import agent_insight_llamaindex
from agent_insight_llamaindex import shutdown, trace_context

agent_insight_llamaindex.setup()

with trace_context(
    session_id="order-42",
    query="查询订单",
    agent_name="Coordinator",
):
    result = agent.run(user_msg="查询订单")

shutdown()
```

`setup()` 与 `instrument()` 等价，并且重复调用是幂等的。`trace_context()` 是可选的；
LlamaIndex 自身产生的父子 span 会自动关联。显式上下文用于提供稳定的业务 sessionId、
原始查询和 Agent 名称，建议在并发、多 Agent 或跨服务检索场景使用。

## 配置

### 配置文件与优先级

默认配置文件为：

```text
~/.agent-insight/llamaindex.json
```

优先级从高到低为：

1. `CollectorConfig` 或 `setup()` 的显式参数；
2. 环境变量；
3. `llamaindex.json`；
4. 内置默认值。

配置文件包含 API Key，创建时会尽可能设置为仅当前用户可读。不要将该文件提交到版本库。

`configure` 还支持以下选项：

```bash
python -m agent_insight_llamaindex.cli configure \
  --endpoint http://localhost:3000 \
  --api-key "$AGENT_INSIGHT_API_KEY" \
  --user llamaindex-user \
  --max-content-chars 2000
```

使用 `--no-content` 可关闭 prompt、响应、Tool 输入输出和检索正文采集。

### 环境变量

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `AGENT_INSIGHT_HOST` | Agent Insight 服务地址，自动补全 OTLP Trace 路径 | 空 |
| `AGENT_INSIGHT_OTLP_ENDPOINT` | 完整 OTLP 地址或服务地址，优先于 `AGENT_INSIGHT_HOST` | 空 |
| `AGENT_INSIGHT_API_KEY` | Agent Insight API Key | 空 |
| `AGENT_INSIGHT_USER` | Trace 所属用户 | 当前系统用户 |
| `AGENT_INSIGHT_LLAMA_CONFIG` | 自定义配置文件路径 | `~/.agent-insight/llamaindex.json` |
| `AGENT_INSIGHT_LLAMA_ENABLED` | 启用或关闭采集 | `true` |
| `AGENT_INSIGHT_LLAMA_SERVICE_NAME` | OTLP service.name | `llamaindex` |
| `AGENT_INSIGHT_LLAMA_CAPTURE_CONTENT` | 是否采集正文 | `true` |
| `AGENT_INSIGHT_LLAMA_MAX_CONTENT_CHARS` | 单个正文字段保留的最大字符数 | `2000` |
| `AGENT_INSIGHT_LLAMA_QUEUE_SIZE` | 非阻塞内存队列容量 | `2048` |
| `AGENT_INSIGHT_LLAMA_MAX_OPEN_SPANS` | 未结束 span 的内存保护上限 | `2048` |
| `AGENT_INSIGHT_LLAMA_BATCH_SIZE` | 单个 spool 批次的最大 span 数 | `64` |
| `AGENT_INSIGHT_LLAMA_SPOOL_DIR` | 自定义 spool 目录 | 见“本地存储” |
| `AGENT_INSIGHT_LLAMA_SPOOL_MAX_BYTES` | spool 总容量上限 | `536870912` |
| `AGENT_INSIGHT_LLAMA_SPOOL_CLAIM_TIMEOUT_SECONDS` | 崩溃上传 claim 的回收时间 | `300` |
| `AGENT_INSIGHT_LLAMA_MODEL_ENV` | `run` 加载的模型环境变量文件 | `~/.agent-insight/llamaindex.env` |

`AGENT_INSIGHT_LLAMA_MODEL_ENV` 文件按简单 `KEY=VALUE` 格式解析，不执行 shell 代码，
并且不会覆盖进程中已经存在的变量。它可用于复用 OpenClaw、DeepSeek 或 OpenAI 兼容模型
配置。不要把模型 API Key 写入示例代码或版本库。

### Python 高级配置

需要设置上传周期、超时或重试参数时，可直接传入 `CollectorConfig`：

```python
from agent_insight_llamaindex import CollectorConfig, setup

config = CollectorConfig.load(
    flush_interval_seconds=2.0,
    upload_interval_seconds=2.0,
    request_timeout_seconds=10.0,
    retry_base_seconds=1.0,
    retry_max_seconds=60.0,
)
setup(config)
```

## 本地存储与账号隔离

默认 spool 路径为：

```text
~/.agent-insight/otel_data/llamaindex/account-<API-Key-SHA256前16位>/spool/
```

API Key 只用于计算账号目录摘要，不会出现在目录名中。切换 API Key 后，采集器会自动使用
另一个隔离目录，避免不同账号的数据相互上传。

如果显式设置 `AGENT_INSIGHT_LLAMA_SPOOL_DIR`，该路径会被原样使用；多账号部署时需要为
每个 API Key 手动指定不同目录。

spool 文件状态：

- `*.ready`：等待上传；
- `*.uploading-*`：已由某个采集进程原子 claim；
- `*.rejected`：服务端返回不可重试错误，保留用于排查；
- `.*.tmp`：原子写入过程中的临时文件，正常完成后不会残留。

## 上传与进程退出

完成的 span 会先通过临时文件、`fsync` 和原子 rename 写入 `.ready`，然后才开始网络
上传。上传成功后删除文件；网络中断、超时、HTTP 408/429/5xx 和认证失败会保留数据并
重试。前三次失败使用基础间隔，之后使用带随机抖动的指数退避，最大间隔默认 60 秒。

root Agent 或 Workflow 完成时会立即写入 spool 并唤醒 uploader；其他数据也会按批次大小
或周期落盘。多个进程共享同一 spool 时通过原子 rename 避免同时上传同一个文件。进程
崩溃留下的 claim 会在超时后恢复为 `.ready`。

正常退出时调用：

```python
from agent_insight_llamaindex import flush, shutdown

uploaded = flush(timeout=10.0)
shutdown(timeout=5.0)
```

`flush()` 返回是否在超时内完成落盘和上传。即使网络仍不可用，已写入 spool 的数据会在
下次启动后继续上传。进程在服务端已接收、但本地尚未删除 claim 的极窄崩溃窗口可能再次
发送同一 span；服务端使用稳定的 Trace/span 标识执行幂等聚合。

## 内容、安全与 Token

- prompt、响应、Tool 参数/结果和检索正文默认最多保留 2000 字符，并写入截断元数据；
- 设置 `AGENT_INSIGHT_LLAMA_CAPTURE_CONTENT=false` 可完全关闭正文采集；
- 结构化数据中名称为 API Key、authorization、password、secret、token 等的字段会脱敏；
- modelName、provider 和 Token 使用 LlamaIndex/provider 返回的 metadata；provider 不返回
  usage 时 Token 可能显示为 0；
- `achat → chat → complete` 等同一逻辑调用的包装 span 会在服务端聚合时去重，避免 Token
  和 LLM 次数重复计算。

关闭正文采集不会关闭名称、状态、耗时、Token 和父子关系采集。

## 性能与资源上限

采集路径使用非阻塞有界队列；队列满时优先保证 LlamaIndex 业务继续运行，而不是等待网络。
默认资源保护包括：

- 内存队列最多 2048 条；
- 未结束 span 最多保留 2048 条，异常未配对的旧 span 会被释放；
- spool 包含 ready、uploading 和 rejected 文件在内最多 512 MiB；
- 正文、集合长度和序列化深度均有上限。

目标机加速实验中，连续处理 120,000 个 span 后未发现 `open_spans` 或 identity 残留；
默认队列按每条 10,000 字符的保守负载填满时，RSS 增量约 21.43 MiB。该结果不能替代
生产环境 8 小时或更长时间的 soak test。

## 状态检查与故障排查

查看脱敏配置和等待上传的批次数：

```bash
python -m agent_insight_llamaindex.cli status
```

常见问题：

### `status` 返回未就绪

确认已经设置 endpoint 和 API Key。可重新运行 `configure`，或检查
`AGENT_INSIGHT_HOST`、`AGENT_INSIGHT_OTLP_ENDPOINT` 和
`AGENT_INSIGHT_API_KEY`。

### 找不到 `agent_insight_llamaindex`

确认采集器目录存在，并在当前终端加载安装器生成的环境入口：

```bash
source ~/.agent-insight/llamaindex_env.sh
python -c "import agent_insight_llamaindex; print(agent_insight_llamaindex.__file__)"
```

Windows PowerShell 使用 `. "$HOME\.agent-insight\llamaindex_env.ps1"`。虚拟环境变化后，
重新设置 `AGENT_INSIGHT_LLAMAINDEX_PYTHON` 并运行一键安装即可；不需要安装
`opentelemetry-instrument` 或任何 Agent Insight Python 包。

### spool 长期存在 `.ready`

检查 Agent Insight 地址、网络连通性和 API Key。修复后重新启动应用，采集器会继续上传
遗留文件。

### 出现 `.rejected`

这通常表示请求格式、地址或其他不可重试的 4xx 错误。文件不会阻塞后续批次，但会计入
spool 容量；修复配置并确认数据不再需要后再执行清理。

### Trace 中 Token 为 0

确认模型 provider 的响应 metadata 是否包含 usage。MockLLM、部分本地模型或错误响应可能
不提供 Token 使用量。

### 多 Agent 关系不稳定

尽量在最外层任务使用 `trace_context(session_id=..., query=...)`，并确保不同并发任务使用
不同 sessionId。采集器会继续使用 LlamaIndex Workflow context 和 Agent instance 标识区分
同名并发子 Agent。

## 卸载与清理

先停止正在运行的 LlamaIndex 应用。已加载到进程内存的 handler 需要进程退出后才会停止。

默认卸载只删除直接部署的采集器源码、环境入口和 shell/profile 注册，保留配置及未上传 Trace：

```bash
~/.agent-insight/uninstall_llamaindex_collector.sh
```

需要同时清理 `llamaindex.json`、`llamaindex.env` 和所有默认 LlamaIndex 账号 spool 时：

```bash
~/.agent-insight/uninstall_llamaindex_collector.sh --purge
```

Windows PowerShell：

```powershell
& "$HOME\.agent-insight\uninstall_llamaindex_collector.ps1"
& "$HOME\.agent-insight\uninstall_llamaindex_collector.ps1" -Purge
```

卸载脚本只处理 `collectors/llamaindex`、LlamaIndex 环境入口以及可选的 LlamaIndex
config/spool，不删除共享 `~/.agent-insight/.env`，也不处理 OpenCode、Claude Code、Hermes、
Jiuwen 或其他框架采集器的数据。

## 开发与验证

在 Agent Insight 仓库中：

```bash
cd scripts/llamaindex_extension
python -m pytest
python -m ruff check src tests
python -m mypy src
```

当前自动化测试覆盖配置优先级、正文脱敏与截断、并发父子关系、Agent/Tool/LLM/RAG/
Workflow、MCP Tool、spool 原子写入和恢复、容量保护、上传重试、进程退出、重复注册卸载、
以及同一 Agent 任务三次执行的结构一致性。

## 许可证

MIT
