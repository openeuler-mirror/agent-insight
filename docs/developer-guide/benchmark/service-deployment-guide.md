# Benchmark 整体服务安装指南

本指南只说明安装步骤、执行命令和参数含义。架构与实现细节见 [`docs/design/benchmark/`](../../design/benchmark/README.md)。

## 1. 部署结构

本文假设三个运行角色分机部署，也可以按实际需求合并部署：

- **Agent Insight**：加载 Benchmark Manifest/Adapter，管理数据集、调度任务、保存并展示结果；
- **Agent 执行端**：准备工作区、运行 Agent，生成并上传 Submission Artifact；
- **Evaluator**：加载 Benchmark Evaluator，运行 Harness，回传进度、Evidence 和结果。

```text
Agent 执行端
     │ 领取任务、上传 Submission、回传执行状态
     ▼
Agent Insight :3000 ──下发评测任务──> Evaluator :3001
     ▲                                      │
     └──进度、Evidence 和结果回传──────────────────┘
```

## 2. 安装前检查

### 2.1 版本与接入包

三端使用相互兼容的代码版本。代码中应包含目标 Benchmark：

```text
benchmarks/<benchmark-key>/benchmark.yaml
benchmarks/<benchmark-key>/adapter/
benchmarks/<benchmark-key>/evaluator/
generated/benchmark-catalog/
```

开发或发布接入包时生成 Catalog：

```bash
npm run benchmark:catalog
```

### 2.2 运行环境

| 机器 | 必需环境 |
|---|---|
| Agent Insight | Git、Node.js、npm、Python 3、curl、tar |
| Agent 执行端 | Linux 或 macOS、Git、Benchmark 要求的 Agent Runtime |
| Evaluator | Linux 或 macOS、Git、Docker、Bash |

### 2.3 网络

确保以下方向可以访问：

| 访问方向 | 地址示例 |
|---|---|
| Agent 执行端 → Agent Insight | `http://<agent-insight-ip>:3000` |
| Agent Insight → Evaluator | `http://<evaluator-ip>:3001` |
| Evaluator → Agent Insight | `http://<agent-insight-ip>:3000` |

分机部署不能使用 `127.0.0.1` 代替另一台机器的地址。

### 2.4 地址选择：同机与分机

| 部署方式 | Evaluator 启动参数 `--platform-base-url` | Agent Insight 配置 `--evaluator-base-url` |
|---|---|---|
| 同机 | `http://host.docker.internal:3000` | `http://127.0.0.1:3001` |
| 分机 | `http(s)://<agent-insight-address>:3000` | `http(s)://<evaluator-address>:3001` |

## 3. 安装 Agent Insight

### 3.1 获取代码

```bash
git clone \
  --branch <branch-or-tag> \
  --single-branch \
  <repository-url> \
  /srv/agent-insight

cd /srv/agent-insight
npm ci
```

### 3.2 配置

平台配置文件默认位于 `~/.agent-insight/.env`。首次运行 `scripts/start.sh` 时若文件不存在，会从仓库的 `.env.example` 生成；之后请修改这个实际配置文件，改 `.env.example` 不会更新已生成的配置。不需要修改默认值时可以跳过。

```dotenv
AGENT_INSIGHT_PORT=3000
AGENT_INSIGHT_BENCHMARK=swe-bench
```

| 配置 | 含义 |
|---|---|
| `AGENT_INSIGHT_PORT` | Agent Insight 对外端口 |
| `AGENT_INSIGHT_BENCHMARK=swe-bench` | 启动时自动准备 SWE-bench Verified 数据集 |

旧变量 `PORT` 不再支持。

### 3.3 启动与验证

```bash
cd /srv/agent-insight
bash scripts/start.sh
curl -I http://127.0.0.1:3000
```

单次指定端口或 Benchmark：

```bash
bash scripts/start.sh --port 3100 --benchmark swe-bench
```

| 参数 | 含义 |
|---|---|
| `--port` | 本次启动使用的 Agent Insight 端口 |
| `--benchmark swe-bench` | 本次启动自动准备 SWE-bench Verified |

## 4. 安装 Benchmark 数据集

### 4.1 当前支持边界

当前提供自动安装流程的数据集是 SWE-bench Verified。

### 4.2 随服务启动自动安装

在 `~/.agent-insight/.env` 中设置：

```dotenv
AGENT_INSIGHT_BENCHMARK=swe-bench
```

然后启动 Agent Insight：

```bash
bash scripts/start.sh
```

首次启动会下载并导入数据集，后续启动会复用已安装的数据集。

如需使用内网文件或本机文件，可增加：

```dotenv
SWE_BENCH_DATASET_SOURCE=/srv/datasets/test.parquet
SWE_BENCH_SOURCE_ARCHIVE_SOURCE=/srv/datasets/source.tar.gz
```

两个配置也可以填写 HTTP/HTTPS 下载地址。

例如使用内网文件服务：

```dotenv
SWE_BENCH_DATASET_SOURCE=https://mirror.example.com/swe-bench/test.parquet
SWE_BENCH_SOURCE_ARCHIVE_SOURCE=https://mirror.example.com/swe-bench/source.tar.gz
```

### 4.3 其他 Benchmark

其他 Benchmark 必须提供自己的数据集安装方式。普通数据集页面导入不能替代 Benchmark 数据集安装。

## 5. 安装 Evaluator

Evaluator 机器需要与 Agent Insight 兼容的代码版本：

```bash
git clone \
  --branch <branch-or-tag> \
  --single-branch \
  <repository-url> \
  /srv/agent-insight

cd /srv/agent-insight
```

### 5.1 Agent Insight 与 Evaluator 分机部署

需要固定 Evaluator 端口时，在 Evaluator 机器的 `~/.agent-insight/.env` 中设置 `AGENT_INSIGHT_EVALUATOR_PORT=3001`，或启动时直接使用 `--port`。

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://<agent-insight-ip>:3000
```

例如 Agent Insight 地址为 `192.168.1.10:3100`，Evaluator 对外使用 `3101`：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://192.168.1.10:3100 \
  --port 3101
```

### 5.2 Agent Insight 与 Evaluator 本机部署

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://host.docker.internal:3000 \
  --bind-address 127.0.0.1
```

常用参数：

| 参数 | 含义 |
|---|---|
| `--platform-base-url URL` | Evaluator 回访 Agent Insight 的地址 |
| `--port PORT` | Evaluator 对外端口，默认 `3001` |
| `--bind-address ADDRESS` | Evaluator 监听地址，默认 `0.0.0.0` |
| `--evaluator-env NAME=VALUE` | 传入 Evaluator 环境变量 |

验证 Evaluator：

```bash
curl -fsS http://127.0.0.1:3001/health
bash scripts/evaluator-doctor.sh --smoke <evaluator-key>
```

健康接口应返回 `healthy`。没有提供 Smoke 的 Benchmark 可以跳过第二条命令。

### 5.3 可选：跨 Benchmark 共享镜像池

镜像池默认开启，无需额外参数。同一 Docker daemon 上的不同 Benchmark 和用户共享一个镜像池。

关闭镜像池：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url <agent-insight-url> \
  --evaluator-env IMAGE_POOL_ENABLED=false
```

镜像池详细设计见[镜像池设计方案](../../design/benchmark/image-pool.md)。

提前准备镜像默认开启，无需增加启动参数；默认的 `IMAGE_POOL_MAX_PULLS=2` 为按需拉取保留容量，开启预取时不能设为 1。平台通过 `/health` 发现预取状态，无需配置额外令牌。Evaluator 端口应只允许 Agent Insight 平台访问。需要关闭预取时，在 Evaluator 启动命令中增加：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://host.docker.internal:3000 \
  --bind-address 127.0.0.1 \
  --evaluator-env IMAGE_POOL_PREFETCH_ENABLED=false
```

分机部署时按 5.1 节替换地址和绑定参数。预取窗口及空间不足的处理见[并发调度方案](../../../评测服务文档/benchmark并发执行与评测调度方案.md#51-镜像准备)。

### 5.4 评测并发与 Case 数量上限

普通实验和 Benchmark 实验的“执行并发”由用户在实验创建向导设置，默认 1；操作方法见[实验使用指南](../../user-guide/evaluation/experiments.md)。以下是平台和 Evaluator 的部署配置：

| 配置 | 设置位置 | 默认值 | 含义 |
|---|---|---:|---|
| `EVALUATOR_MAX_CONCURRENCY` | Evaluator 启动参数 `--evaluator-env` 或启动进程环境 | 1 | 评测服务同时运行的 Case 数 |
| `AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER` | 平台机 `~/.agent-insight/.env` | 留空，跟随 Evaluator 总并发 | 单用户跨实验同时评测的 Case 数量上限 |
| `AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS` | 平台机 `~/.agent-insight/.env` | 256 | 全平台执行中或尚未完成评测的 Benchmark Case 数量上限 |
| `AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER` | 平台机 `~/.agent-insight/.env` | 128 | 每个用户执行中或尚未完成评测的 Benchmark Case 数量上限 |

表中四项均可省略或留空，分别按默认值生效；显式设置时须为正整数。Evaluator 启动脚本只会从评测机的 `~/.agent-insight/.env` 读取对外端口；评测并发须通过 `--evaluator-env` 或启动进程环境传入。

例如，设置评测总并发为 2，单用户额度留空。在平台机的 `~/.agent-insight/.env` 中加入或修改以下行，保留其他设置：

```dotenv
AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER=
AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS=
AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER=
```

重启 Agent Insight 使配置生效。在 Evaluator 机器运行（以下为本机部署示例；分机部署按 5.1 节替换地址和绑定参数）：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://host.docker.internal:3000 \
  --bind-address 127.0.0.1 \
  --evaluator-env EVALUATOR_MAX_CONCURRENCY=2
```

启动后验证：

```bash
curl -fsS http://127.0.0.1:3001/health
```

确认返回的 `maxConcurrency` 为 2；使用其他端口时替换 `3001`。并发值的实测方法、Case 数量上限的统计方式及调度行为见[并发调度方案](../../../评测服务文档/benchmark并发执行与评测调度方案.md)。

## 6. 配置 Agent Insight 与 Evaluator 的互访地址

以下命令在 Agent Insight 机器的仓库目录执行。

### 6.1 分机部署

```bash
node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://<evaluator-ip>:3001
```

例如 Evaluator 地址为 `192.168.1.20:3101`：

```bash
node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://192.168.1.20:3101
```

### 6.2 本机部署

```bash
node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://127.0.0.1:3001
```

| 参数 | 含义 |
|---|---|
| `--evaluator-base-url URL` | Agent Insight 调用 Evaluator 的地址 |
| `--allow-insecure-http true|false` | 是否允许非本机 HTTP 地址，默认 `true` |

配置会自动保存并在后续请求中生效，无需重启 Agent Insight。

## 7. 安装 Agent 执行客户端

在 Agent Insight 页面进入 **配置 → 客户端安装**，选择 Agent Runtime，并在执行机运行页面生成的命令：

```bash
curl -sSf "http://<agent-insight-ip>:3000/api/ingest/setup?key=<generated-api-key>&yes=1&frameworks=<agent-runtime>" | bash
```

请使用页面生成的完整命令，不要手工填写 API Key。

安装后确认：

- 客户端在平台显示为在线；
- 客户端具备 Benchmark 要求的 Agent Runtime；
- 客户端可以访问代码仓库和 Agent Insight。

### 7.1 配置 SWE-bench Case 源码来源（可选）

在 Agent 执行机上创建或编辑配置文件：

```bash
mkdir -p "${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
vi "${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}/.env"
```

使用本地缓存目录：

```dotenv
SWE_BENCH_GIT_SOURCE=/srv/swe-git
```

使用指定的 Git 服务：

```dotenv
SWE_BENCH_GIT_SOURCE=https://git.example.com
```

| 配置值 | 行为 |
|---|---|
| 不配置 | 从默认远程源获取，不保留本地缓存 |
| 本地目录，如 `/srv/swe-git` | 优先使用并维护本地仓库缓存 |
| Git 根地址，如 `https://git.example.com` | 优先从指定 Git 服务获取 |

Git 根地址会拼接为 `根地址/owner/repo.git`。例如 Flask 仓库对应 `https://git.example.com/pallets/flask.git`。

### 7.2 接入 pi-mcts 执行器

实验候选接口会独立合并已就绪的 Benchmark 执行目标，因此仅声明 `runBenchmarkCase` 的 `pi-mcts` 可直接出现在 Agent 列表；它不依赖普通执行能力或历史 Trace。同一客户端、平台和 Agent 的目标合并后保留各自的执行能力标记。

已有 MCTS/xGovernor 服务的使用方可直接按 [MCTS 接入指南](../../user-guide/observability/mcts-xgovernor.md#接入前确认) 完成采集器安装、连接配置和客户端绑定，无需重新部署已有服务。

`pi-mcts` 只用于 SWE-bench Benchmark 实验。按 MCTS README 完成一次性安装：**实际执行 Case 的客户端机器**准备 MCTS、Python 3.11+ 与 `datasets`、Reliability Client 和已启用的 `mcts-xgovernor-proxy` Trace 代理；**xGovernor 主机**准备 Pi CLI、Pi 桥接扩展和 Pi/E2B worker，并确保 E2B 的 SWE-bench 模板可用。两者可以分机部署，客户端不探测本地 Pi CLI。默认使用客户端 MCTS 仓库下的 `.venv/bin/python`；虚拟环境放在别处时可通过本机配置指定解释器。客户端不依赖交互终端的 venv 激活状态。MCTS 版本需支持 `--output-dir`，无需修改 MCTS 源码。执行机运行 Reliability Client 的账户必须能读取 MCTS 仓库及 `testcases_union/config.env`，并能在 `testcases_union/output/` 下写入；xGovernor 与 Trace 上报地址必须可达。

在每台需要执行 MCTS 的客户端机器上，更新兼容版本的客户端，将该机器的路径写入它自己的 `~/.agent-insight/.env`，然后重启该客户端。设置了 `AGENT_INSIGHT_HOME` 时使用 `$AGENT_INSIGHT_HOME/.env`，读取位置不依赖客户端的工作目录。路径无需与 Agent Insight 服务端或其他客户端相同：

```dotenv
AGENT_INSIGHT_MCTS_REPO_DIR=/path/on/this/client/MCTS
# 可选：虚拟环境放在仓库外时填写
AGENT_INSIGHT_MCTS_PYTHON=/path/on/this/client/python-env/bin/python
```

`AGENT_INSIGHT_MCTS_PYTHON` 可省略，此时使用 MCTS 仓库下的 `.venv/bin/python`。Trace 启动器默认是该客户端 `~/.agent-insight/collectors/mcts-xgovernor-proxy/run.cjs`；安装器生成的 `~/.local/bin/agent-insight-mcts-run` 包装同一个启动器，无需额外安装 Pi 原生采集器。若代理安装在其他位置，在 `.env` 中设置 `AGENT_INSIGHT_MCTS_TRACE_LAUNCHER`。

客户端启动时只读取 `.env` 中这三个 MCTS 路径变量，不向进程环境导入其他配置。配置优先级为：进程环境变量 → `.env` → 原有 JSON 字段 `mctsRepoDir` / `mctsPython` / `mctsTraceLauncher` → 默认值，空值跳过。已配置的 systemd 同名环境变量会覆盖 `.env`，迁移时应移除或同步更新。仅修改 `.env` 后执行 `systemctl restart agent-insight-client.service` 即可，无需 `daemon-reload`。

MCTS 就绪探测通过配置的 Python 检查版本及 `importlib.util.find_spec("datasets")`，不导入 `datasets` 及其传递依赖。探测上限为 5 秒，超时、无法启动、缺包、异常退出与版本不足分别返回明确原因，避免将执行机临时负载造成的超时误报为依赖未安装。实际 MCTS 运行仍正常导入依赖；运行时导入失败按实际进程错误处理。

这些是执行机本地配置，不进入服务端下发的 Case 任务。缺少 MCTS 脚本、Python、Trace 代理配置或所需 MCTS 版本时，客户端会将 `agent-runtime/pi-mcts/v1` 标为未就绪。`pi-mcts` 不会出现在普通生成 Trace 实验中。

Trace 代理的 `upstreamUrl` 或 `AGENT_INSIGHT_MCTS_UPSTREAM_URL` 填真实 xGovernor 地址。MCTS 的 `testcases_union/config.env` 需要保留启动器注入的地址，例如 `export XGOVERNOR_BASE_URL="${XGOVERNOR_BASE_URL:-http://127.0.0.1:8787}"`；直接赋值会覆盖代理地址并绕过采集。该文件中的访问 token 和模型设置由部署者配置。

每个 Case 的执行命令由客户端固定为 `run_union.sh --mode sweverified --runtime pi --testbench sweverified --instance-id <Case ID> --split test --output-dir <runId>`，并通过严格模式 Trace 代理启动。未携带搜索参数的历史任务仍使用 MCTS 配置；新建 SWE-bench 实验显式下发页面中的搜索参数，不自动注入 README 的快速验证参数（1 次迭代、1 个分支及 20/10 turns）；token 熔断可由 MCTS `config.env` 中的 `XIAOO_MCTS_TOKEN_FUSE_LIMIT` 配置。客户端创建本次运行专用的 `python` 启动脚本，直接 `exec` 配置的 Python 解释器，再运行原版 `run_union.sh`。启动脚本保留原解释器路径，使 Python 正确识别虚拟环境及 `datasets`；不要把 venv 解释器符号链接到外部目录后执行。MCTS 只将最终选中节点写入 `testcases_union/output/sweverified/<runId>/artifact.patch`；客户端检查 Patch 后应用到该 Case 的冻结 Git 工作区，再由现有 `git-patch/v1` Collector 生成并上传 `model.patch`。Trace 代理的本地状态按 Case 隔离，客户端从其运行记录取得根 Session ID（`mcts.run.<32 位十六进制>`），作为回调 `traceId`，与平台 `Execution.taskId` 保持一致。OTLP 的 32 位 Trace ID 仅用于传输，不直接用作页面跳转；历史误存 OTLP ID 的 Case 在读取时按同一账户下根 Session ID 的 SHA-256 精确映射，不按时间邻近猜测。停止实验时客户端向进程组发送 SIGINT，给 MCTS 的 `finally` 清理和 Trace 代理上传留出 30 秒，然后强制终止仍未退出的进程。

MCTS 自定义搜索参数使用 `agentConfig.agentOptions.mcts` 传递，字段为 `maxIters`、`branching`、`maxTurnsInit`、`maxTurnsStep`、`maxTurnsAuthor`、`maxTurnsAuthorStep`、`tokenFuseLimit`。前六项为正安全整数，Token 阈值为非负安全整数；`0` 显式关闭熔断，旧任务的缺省字段不追加 CLI 参数；新建实验预填并冻结完整七项参数，默认值为 `5、3、160、80、160、80、30000000`，恢复默认重新填入这些值，空输入校验失败。显式 CLI 参数覆盖执行机对应环境配置。配置保存到已有 `runConfigJson/configSnapshotJson`，纳入任务摘要，并在复用和重试时继承。详情仅展示 SWE-bench 实验已保存的参数，不推断历史实际值。参数白名单、默认值、校验和 CLI 映射共用 `services/executor/src/mcts-options.cjs`；模块随客户端 bundle 安装，运行时不依赖平台源码目录。

客户端在对应平台的 `runBenchmarkCase.agentOptionCapabilities` 中声明 `mcts-search-options/v1`，并将同名组件标为就绪。平台仅在关联 SWE-bench 数据集且目标声明该能力时显示参数配置，创建实验与每次下发前均检查能力；旧客户端仍可执行没有覆盖值的任务，自定义参数遇到旧客户端时返回 `CLIENT_UPGRADE_REQUIRED`。前端能力与 MCTS 配置跨运行时复用；执行器映射 `pi-mcts → pi`、`xiao-mcts → xiaoo`，本次客户端自动发现仍只注册已有 Pi 目标。运行事实记录 `mctsRuntime` 与本次 `agentOptions`。上线需要更新平台及常驻客户端；重新执行客户端安装命令并重启客户端即可，无需更改 MCTS/xGovernor 的源码或服务配置。

部署后先运行一个 SWE-bench Case：选择 `mcts-coordinator` Agent、`pi-mcts` 平台、默认模型及已就绪执行机，设置足够长的 Agent 超时；完成后检查 Case 中的根 Trace 链接、`model.patch` 和平台评测结果。MCTS 自身的最终节点官测是搜索过程的一部分，不能代替平台的 Benchmark 评测。`mcts-coordinator` 是展示和 Trace 检索名称；能力上报、任务的 `platform/agent` 均保持 `pi-mcts`。Agent 超时计时覆盖整个 MCTS 子进程；采集根 Trace 的开始时间是首次 xGovernor 请求，不能用这条 Trace 的耗时代替执行期限。采集器终态的失败或中断映射到已有 `agent-process-exit` failure，详情与 SQL 列表/聚合均据此显示失败。

## 8. 整体验收

Benchmark 自动续调与恢复只继续 `running` 实验，不重启已有终态。后台恢复检查先按最新 Case Run 和评测结果收敛实验状态，再补充调度；全部失败收敛为 `failed`，成功与失败并存为 `partial`，全部评测完成为 `done`。显式重试 Case 时才重新置为 `running`。

### 8.1 检查网络

```bash
# Agent Insight 机器访问 Evaluator
curl -fsS http://<evaluator-ip>:3001/health

# Evaluator 机器访问 Agent Insight
curl -I http://<agent-insight-ip>:3000

# Agent 执行机访问 Agent Insight
curl -I http://<agent-insight-ip>:3000
```

同机部署时，将对应 IP 改为 `127.0.0.1`；Evaluator 容器回访 Agent Insight 仍使用 `host.docker.internal`。

### 8.2 运行实验

在 Agent Insight 页面依次确认：

1. Benchmark 数据集可以选择；
2. Agent 执行客户端在线；
3. 创建一个单 Case 实验；
4. Agent 执行、Submission 上传和 Evaluator 评测均完成；
5. 页面能够查看结果、Evidence 和 Artifact。

再运行一个失败 Case，确认页面能展示失败原因。

## 9. 更新与回滚

更新代码后分别重新执行：

```bash
# Agent Insight 机器
bash scripts/start.sh

# Evaluator 机器
bash scripts/evaluator.sh start \
  --platform-base-url <agent-insight-url>
```

如果更新包含 Agent Runtime 或 Collector，在每台执行机重新运行页面生成的客户端安装命令。

回滚时，Agent Insight、Evaluator 和 Agent 执行客户端应回到相互兼容的版本。

## 10. 安装完成标准

- Agent Insight 页面可访问；
- Evaluator 健康检查通过；
- Benchmark 数据集可以选择；
- Agent 执行客户端在线且能力匹配；
- 成功 Case 和失败 Case 均完成验收；
- 页面能够查看结果、Evidence 和 Artifact。

## 11. 立即停止与镜像清理

以下命令在 Evaluator 机器的仓库目录执行：

```bash
# 查看服务状态
bash scripts/evaluator.sh status

# 查看镜像池管理的镜像
bash scripts/evaluator.sh images list

# 预览可清理的空闲镜像
bash scripts/evaluator.sh images purge --dry-run

# 保持服务运行，清理空闲镜像
bash scripts/evaluator.sh images purge

# 立即停止服务，保留镜像
bash scripts/evaluator.sh stop

# 预览停服后的镜像清理范围
bash scripts/evaluator.sh stop --purge-images --dry-run

# 立即停止服务并清理受管镜像
bash scripts/evaluator.sh stop --purge-images
```

| 参数 | 含义 |
|---|---|
| `--dry-run` | 只预览，不停止服务，不删除镜像 |
| `--purge-images` | 停止服务时同时清理评测服务管理的镜像 |

停止服务不需要传端口参数，自定义端口启动的服务也使用相同命令。
