# MCTS xGovernor Trace 非侵入式接入

本指南面向已经部署好 MCTS 和 xGovernor 的用户。Agent Insight 接入由外部启动器完成：启动器在 MCTS 执行机的回环地址创建透明代理，给 MCTS 子进程注入 `XGOVERNOR_BASE_URL`，采集 xGovernor HTTP/SSE 数据并上传。Pi 由 xGovernor 执行，因此这条链路使用 MCTS 专用代理采集。

接入过程无需修改 MCTS 源码，也无需重新部署已有的 xGovernor 服务；需要在 MCTS 的连接配置中保留代理注入的地址。所有仓库路径都填写执行机上的实际目录。

## 接入前确认

MCTS 服务由使用方负责准备；接入前应满足：

- MCTS 原命令能够连接 xGovernor，并在完成任务后生成 `artifact.patch`；
- 执行机有 Python 3.11+，运行 MCTS 的 Python 环境已安装 `datasets`；
- xGovernor 主机已安装 Pi CLI 和桥接扩展，并配置好模型凭据、E2B 凭据及 `swepro-docker` 模板；
- 执行机有 Node.js 22.19.0+，能够访问 Agent Insight，且已有平台账号的 API Key。

xGovernor 与执行机可以分机部署。E2B 和模型的真实密钥保留在 xGovernor 服务的环境中，Agent Insight 接入不需要再配置这些密钥。

以下示例用 `/path/to/MCTS` 代表用户的 MCTS 仓库，`~` 代表运行 MCTS 和 Agent Insight 客户端的账户。采集器应安装在该账户下。

## 能看到什么

- MCTS coordinator，以及每个真正提交过 turn 的 xGovernor Runtime；
- xGovernor 标准化 turn 的输入、assistant 输出、模型、Token、状态与耗时；
- `tool_activity` 的工具输入、结果摘要和成功/失败状态；
- `checkpoint(A) → load(checkpoint, B) → turn(B)` 证实的 Runtime 父子关系；
- MCTS stdout 中稳定的 startup、choose、node score、final tree 和 official PASS/FAIL 摘要。

Runtime 角色按可验证行为标记为 `solver-initial`、`solver-child`、`author`、`selector`、`memory-helper` 或 `unknown`。采集初期允许暂时显示 `unknown`；后续出现 checkpoint、load、文件读取或 profile 证据后，最终角色会覆盖早期未知状态。始终没有可靠证据时才保留 `unknown`，不会按并发先后猜测。

## 安装

推荐从 Agent Insight 的“安装指导”页面安装：

1. 只勾选 `MCTS (xGovernor)`；它是独立安装项，不会连带安装 Pi Agent、xiaoO 或 Goal Plus。
2. 填写 MCTS 主机能够访问的 xGovernor 地址，默认是 `http://127.0.0.1:8787`。
3. 在运行 MCTS 的 Linux/macOS 主机执行页面生成的命令。Windows 主机应在 WSL 内安装和运行。

页面生成的命令会使用当前登录账号的 API Key 下载并校验专用安装包，然后创建：

- `~/.agent-insight/collectors/mcts-xgovernor-proxy/`：透明代理运行文件和权限为 `0600` 的配置；
- `~/.local/bin/agent-insight-mcts-run`：包裹原 MCTS 命令的启动器。

安装器不会写入 MCTS 仓库。若 `~/.local/bin` 不在 PATH，可直接使用启动器的完整路径。

在 agent-insight 源码仓库内开发或排查安装器时，也可直接执行：

```bash
AGENT_INSIGHT_API_KEY='<your-api-key>' \
AGENT_INSIGHT_BASE_URL='http://127.0.0.1:3000' \
AGENT_INSIGHT_MCTS_UPSTREAM_URL='http://127.0.0.1:8787' \
node scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs
```

`AGENT_INSIGHT_MCTS_UPSTREAM_URL` 是安装配置的唯一上游环境变量；未设置时使用默认回环地址，不读取旧安装变量。

安装时的三个主要配置如下。安装器会保存到 `~/.agent-insight/collectors/mcts-xgovernor-proxy/config.json`，后续运行无需反复设置环境变量。

| 安装变量 | 含义 |
|---|---|
| `AGENT_INSIGHT_BASE_URL` | 执行机能够访问的 Agent Insight 平台地址 |
| `AGENT_INSIGHT_API_KEY` | 平台账号的 Trace 上报 API Key |
| `AGENT_INSIGHT_MCTS_UPSTREAM_URL` | 执行机能够访问的真实 xGovernor 地址，例如同机的 `http://127.0.0.1:8787` |

`AGENT_INSIGHT_API_KEY` 与 MCTS 的 `XGOVERNOR_API_TOKEN` 分别用于平台上报和 xGovernor 访问。跨机器连接时，按 MCTS README 选择 admin 端口的 SSH 转发或 tenant 端口，并保留与端口匹配的 token、Git 工作区配置。变更平台地址或账号时重新执行平台生成的安装命令，刷新上传地址与凭据。

## 保留代理注入的连接地址

检查 MCTS 仓库中的 `testcases_union/config.env`。如果它直接给 `XGOVERNOR_BASE_URL` 赋固定值，会覆盖启动器传入的代理地址。将这一项配置为保留已有环境值，并保留文件中的访问 token、模型和其他配置：

```bash
export XGOVERNOR_BASE_URL="${XGOVERNOR_BASE_URL:-http://127.0.0.1:8787}"
```

这里的默认地址换成用户原来的 xGovernor 地址。真实上游地址也应在采集器安装时填写；启动器读取采集配置后创建本次运行的临时代理，MCTS 使用注入值连接它。该调整只涉及部署配置文件。

## 运行 MCTS

首次联调可以使用 MCTS README 的快速验证参数。先选用 MCTS 的 Python 环境，再把运行命令放在 `--` 后面：

```bash
cd /path/to/MCTS
export PATH="$PWD/.venv/bin:$PATH"
~/.local/bin/agent-insight-mcts-run --strict -- \
  bash testcases_union/run_union.sh \
  --mode sweverified \
  --runtime pi \
  --testbench sweverified \
  --instance-id astropy__astropy-12907 \
  --split test \
  --max-iters 1 \
  --branching 1 \
  --max-turns-init 20 \
  --max-turns-step 10 \
  --max-turns-author 20 \
  --max-turns-author-step 10 \
  --token-fuse-limit 0 \
  --output-dir insight-smoke
```

示例 Case ID 可以换成实际任务。重复验证时换一个输出目录名。完成后检查 `testcases_union/output/sweverified/insight-smoke/artifact.patch`，并在平台链路追踪中查看 coordinator 和子 Runtime。正式运行省略快速验证的搜索参数，以使用 MCTS 默认配置。

临时覆盖 xGovernor 地址：

```bash
agent-insight-mcts-run --upstream http://127.0.0.1:8787 -- <原 MCTS 命令>
```

默认是 fail-open：缺少 API Key 或本地代理启动失败时，启动器提示原因并直接执行原命令。要求观测不可用时拒绝启动，可增加 `--strict`。推理正文默认不采集；明确需要时增加 `--capture-reasoning`。

同一能力也可用环境变量控制：`AGENT_INSIGHT_MCTS_PROXY_ENABLED`、`AGENT_INSIGHT_MCTS_UPSTREAM_URL`、`AGENT_INSIGHT_MCTS_CAPTURE_REASONING`、`AGENT_INSIGHT_MCTS_BYPASS_ON_START_FAILURE` 和 `AGENT_INSIGHT_MCTS_STRICT`。命令行 `--upstream`、`--capture-reasoning`、`--strict` 的优先级更高。

## 用于平台 Benchmark 实验

采集器负责 Trace；平台下发 Benchmark Case 还需要兼容版本的常驻 Reliability Client。通过平台“客户端安装”页生成安装命令，在同一个执行账户下完成安装或更新，再在执行机的 `~/.agent-insight/.env` 中增加仓库路径：

```dotenv
AGENT_INSIGHT_MCTS_REPO_DIR=/path/to/MCTS
```

客户端启动时读取该文件，读取位置不依赖工作目录。设置了 `AGENT_INSIGHT_HOME` 时，读取 `$AGENT_INSIGHT_HOME/.env`。路径填写该执行机上的绝对路径；修改配置后需要重启客户端。其他两项通常可以省略：

| `.env` 变量 | 默认值 | 兼容的 JSON 字段 |
|---|---|---|
| `AGENT_INSIGHT_MCTS_REPO_DIR` | 无，必填 | `mctsRepoDir` |
| `AGENT_INSIGHT_MCTS_PYTHON` | `<MCTS 仓库>/.venv/bin/python` | `mctsPython` |
| `AGENT_INSIGHT_MCTS_TRACE_LAUNCHER` | `~/.agent-insight/collectors/mcts-xgovernor-proxy/run.cjs` | `mctsTraceLauncher` |

`AGENT_INSIGHT_MCTS_PYTHON` 是解释器文件的绝对路径；`AGENT_INSIGHT_MCTS_TRACE_LAUNCHER` 是代理安装目录中 `run.cjs` 的绝对路径。`~/.local/bin/agent-insight-mcts-run` 是同一启动器的命令包装。配置优先级为：进程环境变量 → `.env` → `client/config.json` → 默认值，空值跳过。如果此前在 systemd 服务配置中设置了同名变量，需要移除或同步更新，否则它会覆盖 `.env`。客户端从 `.env` 只读取表中的三个 MCTS 配置项。

更新 `.env` 后重启客户端即可，无需 `daemon-reload`。Linux systemd 系统服务可以执行：

```bash
sudo systemctl restart agent-insight-client.service
```

在平台确认客户端在线且 `pi-mcts` 已就绪，再创建 SWE-bench Benchmark 实验，选择 `mcts-coordinator` Agent、`pi-mcts` 执行平台和平台默认模型，并设置足够长的 Agent 超时。模型沿用 MCTS/xGovernor 的部署配置。

客户端会直接调用配置的 Python 解释器，保留该虚拟环境中的依赖，不需要在交互终端中激活环境。

平台自动通过严格模式代理运行 MCTS，传入 Case ID、`--testbench sweverified` 和 `--output-dir <runId>`；搜索参数保留正式默认值。用户无需每次手动运行启动命令或填写输出路径。执行器读取最终选中的 `artifact.patch`，生成并上传 `model.patch`，同时关联本次根 Trace；平台仍会独立运行 Benchmark 评测。停止实验会向进程组发送 SIGINT，留出 30 秒让 MCTS 释放本次会话/checkpoint 并刷新 Trace。实验 Agent 超时从 MCTS 命令启动时计时，覆盖准备、搜索、MCTS 官测和退出上传；根 Trace 从首次 xGovernor 调用开始记录，显示耗时可能短于实验执行耗时。采集到分支 Trace 不代表已生成最终提交物。

常驻客户端需要包含 `executor/mcts-runtime.cjs` 和 `pi-mcts` 能力发现逻辑；仅安装采集代理不会自动获得 Benchmark 执行能力。部署与评测服务要求见 [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md#72-接入-pi-mcts-执行器)。

## 数据流与展示

```text
MCTS 子进程
  ├─ stdout ──> 稳定摘要白名单
  └─ xGovernor HTTP/SSE
        └─ 127.0.0.1 透明代理 ──> 原 xGovernor
                 ├─ OTLP Trace ──> Runtime / LLM / Tool
                 └─ Collaboration ──> coordinator / Runtime 父子关系

Agent Insight 链路追踪
  └─ coordinator
       ├─ initial Runtime
       ├─ author / helper Runtime
       └─ checkpoint 派生 Runtime
            └─ LLM / Tool
```

每个 Runtime 使用独立 Trace Session，父子关系通过现有跨 Session binding/event 接口上报。运行期间每 10 秒尝试增量上传；只要启动器管理的 MCTS 子进程仍存活，还会每 60 秒刷新同一个 coordinator Agent 快照。这个保活不会新增 Tool/LLM 节点或调用次数，但能让长时间 official test、远端 exec 等无模型事件阶段继续显示“执行中”。结束时启动器写入终态并再做一次有界刷新。进程异常退出或被中断时，根 Trace 显示执行失败。关系数据和 Trace 可乱序到达；网络失败时本地 spool/outbox 会保留并在后续刷新时重试。

“观测超时”表示连续 10 分钟没有收到采集更新，不能据此断定 MCTS 已停止。正常运行的启动器会通过上述保活避免这种状态；如果启动器被强制终止、宿主机掉电或采集网络长期不可用，远端任务可能仍在继续，而页面会显示“观测超时”。新 Trace 到达后状态会自动恢复为“执行中”。

父级的 TASK 行表示一次 Runtime 派生关系，不是另一次 LLM 调用。TASK 的 `session_id` 与子 Runtime 的逻辑 Session ID 精确一致时，子 Agent 会展开在该 TASK 下，并显示子 Trace 的真实耗时；关系尚未定位时显示 `-`，不会把瞬时关系事件误报为 `0ms`。stdout 调度摘要只显示对应的观测/Tool 行，不代表发生了一次模型调用，也不会额外生成 LLM 行。

xGovernor 把工具输入放在 `tool_activity(begin)`、把结果放在 `tool_activity(end)`。透明代理按同一个 activity ID 合并两端，因此 Bash 等工具的 Input 显示实际结构化参数，Output 显示执行结果。若上游未发送 begin，Input 保持空对象并在 Trace 元数据中标记采集缺失；采集到的字段仍经过通用密钥、账号和本地路径脱敏。

## 隐私和边界

- 代理不解析 `exec`、`files/write`、checkpoint delete 等敏感请求正文；`files/read` 只统计调用次数，不保存路径或响应内容。
- checkpoint、Runtime、turn 和 run 标识在本地状态及平台关系中使用稳定摘要，不保存原始 checkpoint ID。
- system prompt 只保留 SHA-256 摘要。推理流默认丢弃。
- stdout 只识别固定格式；未识别行仍原样显示在终端，但不会进入 Agent Insight。
- 观察队列与单 turn 正文都有上限；溢出时继续透传业务流量，保留 terminal 事件，并把 capture fidelity 标为 `degraded`。
- 当前 xGovernor 一次提交只暴露一个标准化 turn；其内部多次 LLM 调用不可从现有协议恢复。
- 并发 MCTS 的 `node_id ↔ runtime_id` 没有稳定协议字段，因此 node score/tree 摘要显示在 coordinator 下，不伪造与 Runtime 的绑定。

本实现不改动 MCTS 文件，但透明代理位于运行时网络路径中。默认启动失败会旁路；运行过程中代理进程异常仍可能导致当前 xGovernor 请求失败，这是剩余风险。启动器会在正常退出及 `SIGHUP`、`SIGINT`、`SIGTERM` 路径停止保活、写入 coordinator/Runtime 终态并刷新本地数据；`SIGKILL`、OOM 或宿主机掉电无法执行进程内清理，只能由“观测超时”标识失联。

## 排查

启动时 stderr 应出现 `Agent Insight MCTS observer active`。如果平台没有新 Trace：

1. 确认 MCTS 确实通过 xGovernor 发起 `open/load/turns`；
2. 确认 `AGENT_INSIGHT_BASE_URL` 与 API Key 有效；
3. 查看 `~/.agent-insight/otel_data/mcts-xgovernor/<api-key-hash>/` 是否有待上传事件和关系 outbox；
4. 去掉 `--strict` 可验证 MCTS 原命令本身是否正常；
5. 用 `--upstream` 明确指定原 xGovernor 地址，避免安装时配置已过期。

如果执行记录显示“观测超时”但远端任务仍在运行，先检查 `agent-insight-mcts-run` 是否仍存活。启动器存活时应至少每 60 秒产生一次 coordinator 快照；只有 xGovernor/E2B 远端任务存活而本地启动器已经退出时，Agent Insight 无法继续确认其执行状态。
