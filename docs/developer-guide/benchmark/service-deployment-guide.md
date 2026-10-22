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
```

| 配置 | 含义 |
|---|---|
| `AGENT_INSIGHT_PORT` | Agent Insight 对外端口 |

旧变量 `PORT` 不再支持。

Benchmark 业务配置按进程分开：平台读取项目 `config/benchmark/platform.yaml`，评测读取 `config/benchmark/evaluator.yaml`，执行客户端读取 `config/benchmark/executor.yaml`。各自的 `*.local.yaml` 深度覆盖项目默认文件，未指定字段使用程序默认值；数组整体替换，`null` 恢复默认。配置文件不设 `version` 字段，未知字段和错误类型会明确报错。相对路径按所在配置文件目录解析；Evaluator Python 使用容器内命令名或绝对路径。

本机覆盖文件不提交 Git。默认从安装根下的 `config/benchmark/` 加载，不依赖当前工作目录；`AGENT_INSIGHT_CONFIG_DIR` 可指定直接包含这三个 YAML 文件的其他目录，不会再自动追加子目录。业务环境变量不参与覆盖，残留变量会提示迁移。端口、数据库连接、密钥、运行目录及服务通信地址仍保留环境配置，通信地址现有的热更新机制保持不变。


### 3.3 启动与验证

```bash
cd /srv/agent-insight
bash scripts/start.sh
curl -I http://127.0.0.1:3000
```

单次指定端口：

```bash
bash scripts/start.sh --port 3100
```

| 参数 | 含义 |
|---|---|
| `--port` | 本次启动使用的 Agent Insight 端口 |

## 4. 安装 Benchmark 数据集

### 4.1 当前支持边界

当前提供自动安装流程的数据集是 SWE-bench Verified。

### 4.2 随服务启动自动安装

启动 Agent Insight 时，`config/benchmark/platform.yaml` 的 `benchmarks.swe-bench.dataset.autoImport` 默认 `true`：

```bash
bash scripts/start.sh
```

首次启动会下载、校验并导入 500 条 Case。后续启动先检查当前数据库，已存在完整、可用的数据集时跳过下载和导入。将 `autoImport` 设置为 `false` 可跳过启动自动导入，但不影响已有数据集和管理员手动导入。`AGENT_INSIGHT_BENCHMARK` 不再控制此行为，`scripts/start.sh` 不再接受 `--benchmark` 参数。

准备或导入失败只输出简短警告，继续构建和启动服务；SWE-bench Verified 相关实验暂不可用。终端根据失败原因提示内网或本机来源、文件校验、Python 环境等处理方式，详细输出写入 `~/.agent-insight/logs/swe-bench-bootstrap.log`（配置 `AGENT_INSIGHT_HOME` 时随之调整），每次启动覆盖该日志。当前仍同步等待本次准备结束，再继续启动；数据库初始化或构建失败仍会停止启动。

下次启动会自动重试。也可在修复后从项目根目录单独重试，无需重启已运行的服务：

```bash
npx tsx scripts/benchmark/ensure-swe-bench-dataset.ts
```

独立导入失败时返回非零退出码，便于管理员检查结果。

如需内网或离线来源，在项目 `config/benchmark/platform.local.yaml` 中配置：

```yaml
benchmarks:
  swe-bench:
    dataset:
      source: /srv/datasets/test.parquet
    loader:
      sourceArchive: https://mirror.example.com/swe-bench/source.tar.gz
      python: /srv/python/bin/python
```

数据与归档来源均支持 HTTP(S) 地址或本机文件，`null` 使用官方默认来源。本机与下载文件均校验固定官方 SHA-256，不覆盖校验失败的本机文件。完全离线时，`loader.python` 应指向已安装官方 Loader 的 Python，否则首次创建环境仍需要可用的 pip 软件源。导入完成后原始数据文件可以删除；数据库中没有已安装数据集时才需要重新提供。

旧的数据来源、Python 和路径/URL环境变量不再生效。导入配置错误与下载/导入错误一样只警告，不阻止平台启动。

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
| `--evaluator-env NAME=VALUE` | 传入环境参数；业务配置改用 `config/benchmark/evaluator.local.yaml` |

验证 Evaluator：

```bash
curl -fsS http://127.0.0.1:3001/health
bash scripts/evaluator-doctor.sh --smoke <evaluator-key>
```

健康接口应返回 `healthy`。没有提供 Smoke 的 Benchmark 可以跳过第二条命令。

### 5.3 可选：跨 Benchmark 共享镜像池

镜像池和提前准备默认开启，同一 Docker daemon 上的不同 Benchmark 和用户共享镜像池。策略在评测机项目 `config/benchmark/evaluator.local.yaml` 设置，例如关闭预取：

```yaml
imagePool:
  prefetchEnabled: false
```

关闭整个镜像池时设置 `imagePool.enabled: false`。`maxPulls` 默认 2，开启预取时至少为 2；`reserveRatio` 默认 0.3，`highWatermark` 默认 0.9，`waitSeconds` 默认 600。Mac 同盘共享目录通过 `imagePool.macDiskPath` 配置；磁盘挂载事实仍由脚本自动检测。

修改后重新执行 `bash scripts/evaluator.sh start`，按 5.1/5.2 节补充通信地址与端口参数。启动脚本在 Controller 镜像内校验配置，不要求宿主安装 Node.js；配置无效时不会停止旧服务。校验后的 JSON 快照传给 Controller 和 Benchmark Runtime，禁止用 `--evaluator-env` 覆盖快照。

SWE-bench 镜像来源、架构、非官方许可、代理和镜像仓库在 `benchmarks.swe-bench.images` 配置，Python 在 `benchmarks.swe-bench.python`，Docker SDK 超时和连接池在 `benchmarks.swe-bench.docker`。`verifiedMirrorRepositories: null` 使用内置仓库，`[]` 关闭额外镜像仓库；Epoch 仅允许显式许可的 ARM64 冒烟。

镜像池详细设计见[镜像池设计方案](../../design/benchmark/image-pool.md)。平台通过 `/health` 发现预取状态，无需额外令牌。Evaluator 端口应只允许平台访问。

### 5.4 评测并发与 Case 数量上限

普通实验和 Benchmark 实验的“执行并发”由用户在实验创建向导设置，默认 1；操作方法见[实验使用指南](../../user-guide/evaluation/experiments.md)。以下是平台和 Evaluator 的部署配置：

| 配置 | 设置位置 | 默认值 | 含义 |
|---|---|---:|---|
| `maxConcurrency` | `config/benchmark/evaluator.local.yaml` | 1 | Evaluator 同时运行的 Case 数 |
| `benchmarks.scheduling.maxEvaluationConcurrencyPerUser` | `config/benchmark/platform.local.yaml` | `null`，跟随 Evaluator 总并发 | 单用户跨实验评测并发 |
| `benchmarks.scheduling.maxPendingEvaluations` | `config/benchmark/platform.local.yaml` | 256 | 全平台执行中或待评测 Case 上限 |
| `benchmarks.scheduling.maxPendingEvaluationsPerUser` | `config/benchmark/platform.local.yaml` | 128 | 每用户执行中或待评测 Case 上限 |

显式并发和数量上限须为正整数。比如将 Evaluator 总并发设为 2，在评测机 `config/benchmark/evaluator.local.yaml` 写入：

```yaml
maxConcurrency: 2
```

平台侧未覆盖时保持默认值。修改平台配置后重启平台；修改评测配置后重新运行 Evaluator 启动命令。旧并发/待评测上限环境变量不再生效。

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

源码运行时在 Agent 执行机项目的 `config/benchmark/executor.local.yaml` 配置；curl 安装版统一使用 `~/.agent-insight/config/executor.local.yaml`，自定义根目录时为 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`。安装器自动准备用户配置目录并打印路径，不要求创建配置文件。安装升级只更新运行时内置的 `executor.yaml`，不覆盖用户配置。安装版不读取、迁移或回退到 `client/runtime/config/benchmark/executor.local.yaml` 或更早的 `client/runtime/config/executor.local.yaml`；旧文件保留但不生效，需要的配置请自行写入新路径。配置中的相对路径以新配置文件所在目录为基准。显式设置 `AGENT_INSIGHT_CONFIG_DIR` 时仍从指定目录读取 `executor.yaml` 与 `executor.local.yaml`，不叠加上述用户配置。

```yaml
benchmarks:
  swe-bench:
    gitSource: /srv/swe-git
```

`gitSource` 也可填写 `https://git.example.com`；`null` 使用默认 Gitee → GitHub 来源，不持久缓存。旧 `SWE_BENCH_GIT_SOURCE` 不再生效，发现残留配置会提示迁移。

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

在“客户端安装”页勾选 MCTS，仅填写执行机上的仓库绝对路径。生成命令通过管道右侧的 `AGENT_INSIGHT_MCTS_REPO_DIR` 将路径交给本机安装器，不把路径发到服务端，也不要求填写 xGovernor 地址：

```bash
curl -sSf "https://insight.example.com/api/ingest/setup?key=<your-api-key>&yes=1&frameworks=mcts-xgovernor" | AGENT_INSIGHT_MCTS_REPO_DIR='/opt/MCTS' bash
```

安装顺序为仓库/Python/连接预检 → Trace 采集器安装 → 路径写入 `.env` → 常驻客户端注册和启动。预检或采集器失败会终止流程；MCTS 接入时客户端注册或启动失败也返回非零退出码，不输出 READY。重新执行命令可更新路径、采集配置并重启客户端。安装器不部署 xGovernor、不修改 MCTS 文件。

`services/executor/src/mcts-config.cjs` 统一实现路径解析、Python 检查、连接读取和配置持久化，同时进入客户端 tar 包与 MCTS 采集器 zip 包。读取连接时在独立 Bash 子进程加载 `testcases_union/config.env`，仅提取 URL，丢弃其 stdout/stderr；检查 HTTP(S) URL，再进行 TCP/TLS 连接预检。连接预检不执行付费任务，也不代表模型/E2B 全链路验证。

MCTS 安装器将本次版本的上传模块放入采集器目录内的 `shared/`，运行时优先读取此副本，保留旧版 `../shared/` 的兼容读取。升级不覆盖其他采集器已有的共享模块，避免版本差异阻止重复安装。

仓库路径自动保存到本机 `AGENT_INSIGHT_HOME/.env`，默认 `~/.agent-insight/.env`。自定义部署仍支持 `AGENT_INSIGHT_MCTS_PYTHON` 和 `AGENT_INSIGHT_MCTS_TRACE_LAUNCHER`，默认分别为 `<仓库>/.venv/bin/python` 和 `<Agent Insight home>/collectors/mcts-xgovernor-proxy/run.cjs`。配置优先级为进程环境 → `.env` → 兼容 JSON 字段 `mctsRepoDir` / `mctsPython` / `mctsTraceLauncher` → 默认值。旧 systemd 环境覆盖需由部署者同步维护；客户端只读取这三个 MCTS 项。

MCTS 就绪探测通过配置的 Python 检查版本及 `importlib.util.find_spec("datasets")`，不导入 `datasets` 及其传递依赖。探测上限为 5 秒，超时、无法启动、缺包、异常退出与版本不足分别返回明确原因，避免将执行机临时负载造成的超时误报为依赖未安装。实际 MCTS 运行仍正常导入依赖；运行时导入失败按实际进程错误处理。

这些是执行机本地配置，不进入服务端下发的 Case 任务。缺少 MCTS 脚本、Python、Trace 代理配置或所需 MCTS 版本时，客户端会将 `agent-runtime/pi-mcts/v1` 标为未就绪。`pi-mcts` 不会出现在普通生成 Trace 实验中。

执行器每次从 MCTS `config.env` 读取真实 xGovernor 地址，以 `--upstream` 传给严格模式 Trace 代理。代理将动态地址放入 `AGENT_INSIGHT_MCTS_PROXY_URL`；本次专用 `python` 脚本在 MCTS 加载配置之后，将 `XGOVERNOR_BASE_URL` 恢复为代理地址并 exec 原解释器。手动启动器也为每次运行创建独立 Python 包装目录，退出时清理。固定 URL 不会绕过采集，无需修改 MCTS 配置文件。未配置仓库的历史独立 Trace 安装仍读取 `upstreamUrl` / `AGENT_INSIGHT_MCTS_UPSTREAM_URL`。

每个 Case 的执行命令由客户端固定为 `run_union.sh --mode sweverified --runtime pi --testbench sweverified --instance-id <Case ID> --split test --output-dir <runId>`，并通过严格模式 Trace 代理启动。搜索参数由执行机的 Runtime YAML 和本机默认值覆盖解析，并显式追加到 CLI；新建实验冻结页面参数，不自动选择联调预设。显式 CLI 参数覆盖 MCTS `config.env` 中的对应环境配置。客户端创建本次运行专用的 `python` 启动脚本，直接 `exec` 配置的 Python 解释器，再运行原版 `run_union.sh`。启动脚本保留原解释器路径，使 Python 正确识别虚拟环境及 `datasets`；不要把 venv 解释器符号链接到外部目录后执行。MCTS 只将最终选中节点写入 `testcases_union/output/sweverified/<runId>/artifact.patch`；客户端检查 Patch 后应用到该 Case 的冻结 Git 工作区，再由现有 `git-patch/v1` Collector 生成并上传 `model.patch`。Trace 代理的本地状态按 Case 隔离，客户端从其运行记录取得根 Session ID（`mcts.run.<32 位十六进制>`），作为回调 `traceId`，与平台 `Execution.taskId` 保持一致。OTLP 的 32 位 Trace ID 仅用于传输，不直接用作页面跳转；历史误存 OTLP ID 的 Case 在读取时按同一账户下根 Session ID 的 SHA-256 精确映射，不按时间邻近猜测。停止实验时客户端向进程组发送 SIGINT，给 MCTS 的 `finally` 清理和 Trace 代理上传留出 30 秒，然后强制终止仍未退出的进程。

MCTS 的字段、中文名称、分组、类型、校验范围、默认值、联调预设和 CLI 绑定统一声明在 `services/executor/runtimes/mcts/runtime.yaml`。`pi-mcts` 与 `xiao-mcts` 共用此描述，内部 Runtime 映射仍为 `pi` / `xiaoo`；客户端自动发现仍只注册已有 Pi 目标。前六项为正安全整数，Token 阈值为非负安全整数，`0` 表示关闭熔断。默认值为 `5、3、160、80、160、80、30000000`；空输入按字段的 `required` 校验。

执行机可在 `config/benchmark/executor.local.yaml` 覆盖默认值，curl 安装版使用 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`（默认 `~/.agent-insight/config/executor.local.yaml`）：

```yaml
runtimes:
  mcts:
    defaults:
      maxIters: 3
      tokenFuseLimit: 0
```

优先级为 Runtime YAML 默认值、本机默认值覆盖、本次实验输入。覆盖按 Runtime 和字段合并，字段设为 `null` 恢复 YAML 默认值。未知 Runtime、未知字段或非法取值会明确报错。参数定义修改后重启客户端并刷新页面；客户端会重新上报描述。安装更新保留 `executor.local.yaml`。源码定义位于 `services/executor/runtimes/`，安装到常驻客户端后位于 `$AGENT_INSIGHT_HOME/client/runtime/executor/runtimes/`。

客户端在每个 platform 的 `parameterDefinitions` 上报生效的展示描述和 `definitionDigest`，不包含 CLI 绑定。通用模块为 `packages/agent-runtime/index.cjs`（协议、字段校验）与 `loader.cjs`（YAML 加载、覆盖、摘要、argv）。参数值采用 `agentOptions: { runtimeKey, definitionDigest, values }`；平台和执行端按所选 platform/agent 验证，摘要不一致返回 `AGENT_DEFINITION_CHANGED` 并要求刷新确认。平台创建实验时补齐默认值，将生效参数及 `agentParameterDefinition` 存入原有配置快照；参数值纳入任务摘要，复用和重试时继承，详情按冻结描述展示。旧 `agentOptions.mcts` 不兼容、不迁移，历史旧参数不展示或复用。

平台及常驻客户端需同步升级。安装 bundle、npm 和 standalone 包均包含 `services/executor/runtimes/` 与共享加载器；重新执行页面生成的客户端安装命令即可部署并重启。OpenCode 具有 `services/executor/runtimes/opencode/runtime.yaml` 空参数定义，新增受支持的字段和 argv 绑定后，普通实验、Skill 实验和 Benchmark 页面复用通用参数表单与启动链路。Runtime 的主命令、工作区、Trace 和产物处理仍由代码实现，YAML 不能覆盖保留的系统启动参数。

部署后先运行一个 SWE-bench Case：选择 `mcts-coordinator` Agent、`pi-mcts` 平台、默认模型及已就绪执行机，设置足够长的 Agent 超时；完成后检查 Case 中的根 Trace 链接、`model.patch` 和平台评测结果。MCTS 自身的最终节点官测是搜索过程的一部分，不能代替平台的 Benchmark 评测。`mcts-coordinator` 是展示和 Trace 检索名称；能力上报、任务的 `platform/agent` 均保持 `pi-mcts`。Agent 超时计时覆盖整个 MCTS 子进程；采集根 Trace 的开始时间是首次 xGovernor 请求，不能用这条 Trace 的耗时代替执行期限。采集器终态的失败或中断映射到已有 `agent-process-exit` failure，详情与 SQL 列表/聚合均据此显示失败。

### 7.3 原生 Pi/xiaoO 的 SWE-bench：xGovernor 本地 Docker

新建的 `swe-bench + pi-agent/xiaoo` 任务默认绑定 `xgovernor-local-docker`。这条路径独立于普通实验的原生 CLI 与 Collector 就绪探测；未配置时明确不可用，不回退宿主机执行。OpenCode、MCTS 和非 Benchmark 实验继续走各自原有路径。平台和执行客户端须同步升级并重启。

执行机要求 Linux x64/arm64、可访问的 Docker Linux daemon 和 cgroup v2。平台和 Evaluator 无需安装 xGovernor；安装页选择 Pi/xiaoO 后执行原有 curl 即可，所有客户端安装来源均将 `--frameworks` 传给安装器。先注册并启动客户端，再进行耗时的源码构建，避免 10 分钟安装令牌在编译中失效。

`setup.cjs` 将兼容版本固定为 `d08e67e366b89e622af9383383e251c4f40eb728`；更新此常量需验证适配协议。同版本制品校验通过时跳过下载编译。否则自动准备 Git、C/C++ 构建工具、pkg-config 等依赖，支持 apt/dnf/yum，需 root 或非交互 sudo 权限。Node 不足 22.19 时安装独立 Node 22.19.0 并验证下载校验和；Cargo 缺失或版本不足时安装独立 Rust 1.97.1。工具链放在 `dependencies/xgovernor/toolchain/`，不修改 shell 配置；Cargo 构建并行度限制为 2。需要访问 GitCode、Rust/Cargo、Node 与 npm 下载源。Docker 与 cgroup v2 由宿主机管理员准备，安装器不自动修改内核参数、安装 Docker 或重启。

自动安装锁 `setup.lock` 防止重复准备工具链，管理器的 `update.lock` 保护版本切换。安装失败写入 `setup.json` 并打印原因，客户端仍可在线，但不宣称 Benchmark 已就绪。`setup.json` 只保存所选 Runtime、配置路径和状态，不保存模型凭据。MCTS-only 安装不触发这一流程；即使同机已有 MCTS xGovernor，也不探测或接管它的二进制、服务和仓库。

高级管理员仍可使用以下入口管理客户端专属安装：

```bash
node ~/.agent-insight/client/runtime/xgovernor.cjs status
node ~/.agent-insight/client/runtime/xgovernor.cjs update --version <tag或完整commit>
node ~/.agent-insight/client/runtime/xgovernor.cjs rollback
```

源码安装入口为 `node scripts/xgovernor.cjs`；`AGENT_INSIGHT_HOME` 自定义时相应替换目录。手动 `update` 不传版本仍使用官方 HEAD；正常 curl 自动安装始终使用平台固定版本。不要将这里的安装目录指向 MCTS。`status` 校验制品，不代替实际模型或 Docker Case 验证。

源码和构建产物位于 `$AGENT_INSIGHT_HOME/dependencies/xgovernor/releases/<commit>-<安装标识>/source/`（`AGENT_INSIGHT_HOME` 默认为 `~/.agent-insight`），每个版本另有 `installation.json`。`current.json` 在同一次原子替换中保存当前版本和上一个版本。更新锁防止并发修改；下载、构建、扩展类型检查、新 server 健康/鉴权/会话路由检查全部通过后才切换指针。失败保留原版本；`rollback` 校验并探测上一个版本后切换。SIGINT/SIGTERM 会取消构建并清理临时安装；SIGKILL/掉电可能留下临时目录或 `update.lock`，需确认安装进程已经退出后再清理。

安装检查不调用模型、不创建任务容器，不能替代真实 Pi/xiaoO + Docker Case 验收，也不能保证任意上游协议变化均可自动适配。布局或基础协议不兼容时拒绝切换，需升级本平台适配器。

不配置 server/worker/CLI/扩展路径时，客户端自动发现受管理安装，实际 commit 和制品摘要随现有约 30 秒能力上报刷新，正常联网时不需要重启客户端。每个 Case 将自身实际组件路径及非密钥配置持久化，升级/回退后正在执行的 Case 继续使用原版本；自动清理保留 current、previous 和仍被引用的版本。旧实验冻结的环境摘要与新版不一致时拒绝执行，需重新创建并确认配置。更新 xGovernor 本身不需要重新部署平台或 Evaluator。

客户端启动恢复后及之后每小时执行本地历史清理。`retention.days` 默认为 7，正整数，在每轮清理时重新读取。安装版可编辑 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`：

```yaml
retention:
  days: 7
```

Case 的 `terminalAt` 首次进入终态时写入，重复状态写入不会延长保留期限；仅终态、资源清理成功、全部本地 Artifact 上传确认且完成回调成功（或已取消）的记录可以过期。删除前还需确认对应 lease 已关闭、没有活动上传器或上传锁、Trace checkpoint 已覆盖每个 JSONL 文件全部字节。未完成、损坏或缺少确认的记录继续保留。清理确认后将 `client/xgovernor-runs/<runId>/` 和 `client/benchmark-runs/<runId>/` 移入客户端独立的 `retention-trash/` 再删除，确认记录独立保存，删除中断后下一轮可继续回收；不改平台记录、镜像缓存或其他服务目录。Trace 暂存不再套用通用上传器按日期分区删除的策略，避免未上传或尾行未完整写入的数据丢失。

版本清理仅在客户端 Benchmark 执行空闲且没有安装操作时进行，复用 `update.lock` 排斥更新/回退；current、previous、未关闭 lease 和待恢复记录引用的版本均保留。其余安装版本按 `installation.json.installedAt` 应用同一保留期限，仅删除清单与命名均符合托管规则的目录，不接管 MCTS 的版本。清理失败记录客户端错误并下轮重试；目录符号链接和无法确认的记录跳过。首次升级前缺少 `terminalAt` 或完成回调确认的旧记录不会自动删除。

正常使用无需创建配置文件。高级覆盖可在执行机的 `config/benchmark/executor.local.yaml`（安装版目录同 7.1）配置；下面的显式模型映射只用于兼容手动部署，不是必填步骤：

```yaml
benchmarks:
  swe-bench:
    images:
      source: official
      arch: auto
      allowNonOfficial: false
      proxyPrefix: null
      verifiedMirrorRepositories: null
execution:
  profiles:
    xgovernor-local-docker:
      dockerExecutable: docker
      dockerSocket: /var/run/docker.sock
      traceApiKeyEnv: AGENT_INSIGHT_API_KEY
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 }
      timeouts: { prepareSeconds: 1800, cleanupSeconds: 120 }
      models:
        example/model:
          provider: example
          model: model
          api: openai-completions
          apiBase: https://model.example.com/v1
          apiKeyEnv: BENCHMARK_MODEL_API_KEY
      runtimes:
        pi-agent:
          kind: pi
          namespace: runtime_pi
          agents: [pi-agent]
          defaultModel: example/model
        xiaoo:
          kind: xiaoo
          namespace: xiaoo
          agents: [defaultagent]
          defaultModel: example/model
  bindings:
    - benchmarks: [swe-bench]
      platforms: [pi-agent, xiaoo]
      profile: xgovernor-local-docker
```

默认模型解析在客户端 Agent 适配层完成。实验指定的 model 优先于 Runtime 的 `defaultModel`，再使用 Pi settings 或 xiaoO `[llm]` 默认值。Pi 使用配套 SDK 的 ModelRuntime/ModelRegistry 读取原有 models.json/auth.json；xiaoO 使用原配置的 provider、api_base、api_key_env，允许同 provider 的实验模型覆盖，不跨 provider 借用凭据。xiaoO TOML 解析使用客户端 FI Python 或 Python 3.11+（兼容已有 tomli）。原配置路径和用户目录从安装上下文恢复，在独立登录 shell 子进程中解析环境变量；秘钥只通过私有管道返回，不进入命令参数、Profile、能力上报或 lease。

仅将当前模型的密钥放入 case 进程专用环境变量，模型请求仍由宿主机发出。当前不支持 Pi OAuth/订阅认证及自定义 headers/兼容参数，也不静默降级。显式 `models` 映射作为高级覆盖保留，但只检查当前选中模型的凭据，其他模型不会阻止环境就绪。模型目录不再必须复制到 Profile，默认复用 Agent 上报的 models。Trace 认证从原有 `$AGENT_INSIGHT_HOME/.env` 读取，显式环境变量仍优先，不使用设备凭据替代采集密钥。

手动安装仍可显式配置 `serverExecutable` 和各 Runtime 的 `workerExecutable`，Pi 另需 `executable`、`extensionDirectory`，均使用绝对路径。只要存在这些自定义路径，就完整采用手动安装，不与受管理安装混用；要迁移到受管理安装，先移除这些路径。手动安装按实际制品计算摘要，公开 `sourceRevision` 显示 `unknown`；兼容保留的旧 `sourceRevision` 声明不能证明二进制来源，也无需继续手动维护。

`runtimes` 是完整运行集合；默认受管理 Profile 按安装时选择过滤 Runtime，管理器仍构建配套组件。高级手动 Profile 可显式配置运行集合。同一个 Profile 内启用的 worker 或 Trace 依赖未就绪会报告环境不可用；模型凭据在任务准备阶段单独校验。`workerEnvironment` 可覆盖 Runtime 的 worker 变量名；Pi/xiaoO 默认分别为 `XGOVERNOR_PI_WORKER` / `XGOVERNOR_XIAOO_WORKER`。`settings` 仅由受信本机配置补充 Runtime 扩展，隔离参数由驱动固定。

每个 Case 使用独立 daemon、凭据、状态目录和工具容器。两个监听端口动态分配，启动阶段确认端口占用时最多尝试 3 次；清理按 PID 身份和独立 deployment 标签执行，不使用全局 kill/prune。MCTS 服务及其配置不参与这一生命周期。镜像先解析为本机不可变 image ID，再核对架构、Git HEAD/origin/干净工作树，以及容器实际的无网络、无宿主挂载、非 root 用户、capability、no-new-privileges 和资源限制。预探测不会运行模型或逐个拉取 Case 镜像，显示“就绪”仍可能在实际镜像或模型检查时失败。

执行端和 Evaluator 分别维护自身的 SWE-bench 镜像实现，互不依赖，可独立调整。当前两端默认策略相同：优先使用本地官方别名缓存；没有缓存时，按 SWR 仓库列表 → 配置代理 → 官方仓库顺序拉取，SWR/代理成功后自动恢复官方别名。`verifiedMirrorRepositories: null` 使用内置两个 SWR Verified 仓库，`[]` 关闭镜像站，也可填写自有仓库列表；各仓库按 `<repository>:<instance_id>` 查找 Case。该 SWR 映射只适用于官方 x86_64，ARM64 跳过。

执行机读取 `executor.local.yaml` 的 `benchmarks.swe-bench.images`；评测机读取 `evaluator.local.yaml` 的同名配置，已有评测配置不会自动复制给执行端。执行端支持同样的 `proxyPrefix`、`arch` 和显式 ARM64 非官方 smoke 策略；目标架构必须匹配任务和本机 Docker。私有 SWR 的认证通过执行客户端运行账号、对应 Docker daemon 的现有 Docker 凭据配置准备，不在任务或 YAML 中传入密钥。

执行端记录 `runFacts.execution.imageId` 和 `runFacts.execution.imageResolution`，本次执行使用本机不可变镜像 ID；本地镜像不要求具有 RepoDigests。执行与评测分别选择镜像，不强制两端 digest、image ID 或架构一致。评测端保留原有预热流程。

执行与评测使用独立容器，初始化过程和资源上限各自配置，不保证两端基础镜像内容完全相同。

工具容器网络固定 `none`；模型请求由宿主机控制器发出。CPU/内存/PID 限额约束工具容器，不覆盖宿主机 Agent 控制器。Pi 使用受控桥接扩展并关闭个人资源发现，不自动携带全局 Skill。当前原生后端不接受 MCTS 等 Runtime 的 `agentOptions`。

Trace 使用现有上传端点与 durable spool：Pi 从本次唯一原生 JSONL 导出；xiaoO 通过透明 worker 代理持久化完整 `state` 快照，只接受 `runtime_kind=xiaoo/schema_version=1` 与对应 ChatMessage 格式。摘要 SSE 不作为完整 Trace。业务 Trace ID 固定为 `xgovernor:<runId>`；runtime ID/turn ID 精确归属，SSE 断连不重新提交 Agent。

可选 `traceExporter` 支持新的 Runtime/快照格式：可执行文件 `--describe` 返回 `{ "schemaVersion": "execution-trace/v1", "full": true, "runtimeKinds": ["opencode"] }`；`--export` 从 stdin 接收本次 runId/runtimeId/stateDirectory 等元数据，返回同版本、`full: true`、对应 runId/runtimeId 及完整 canonical `events`。事件必须属于唯一 `xgovernor:<runId>` 根会话并包含模型正文。新的 Runtime 还须补充上游会话参数映射和 Trace 语义验证。

Runner 为准备、Agent、收集与清理持久化阶段期限；心跳不会延长期限。取消和重启优先清理本次 ownership 标识匹配的进程/容器，无法确认清理完成时保留 `cleanup_pending` 并占用资源预算。Patch 与 Trace 在关闭前落盘，上传失败只重传，不重跑 Agent。Case 详情显示冻结 Profile 和实际环境事实。真实部署验收应至少完成一次 Pi、一次 xiaoO 单 Case，并验证取消、重启清理和平台 Evaluator 结果。

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
