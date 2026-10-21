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

自动安装能力由接入包的 Dataset Preparer 在 Catalog 中注册。平台启动脚本通过通用入口获取来源、调用 Loader 和 Adapter 入库，不内置各 Benchmark 的下载或解析逻辑。以下使用 SWE-bench Verified 举例；其他接入包的来源配置见对应专项部署指南和 [评测数据集指南](../../user-guide/evaluation/datasets.md)。

### 4.2 随服务启动自动安装

启动 Agent Insight 时，`config/benchmark/platform.yaml` 的 `benchmarks.swe-bench.dataset.autoImport` 和 `benchmarks.zsoft-l1.dataset.autoImport` 均默认 `true`，按顺序独立准备 SWE-bench 与 ZSoft：

```bash
bash scripts/start.sh
```

首次启动会下载、校验并导入 SWE-bench 的 500 条 Case 和 ZSoft 的 30 道正式题。后续启动先检查当前数据库，已有可用数据集时跳过下载和导入。在 `platform.local.yaml` 将对应 Benchmark 的 `dataset.autoImport` 设置为 `false` 可独立跳过启动自动导入，不影响另一 Benchmark、已有数据集和管理员手动导入。`AGENT_INSIGHT_BENCHMARK` 不再控制此行为，`scripts/start.sh` 不再接受 `--benchmark` 参数。

准备或导入失败只输出简短警告，继续准备其他数据集、构建和启动服务；失败的数据集相关实验暂不可用。终端提示来源配置、文件校验、Python 环境等处理方式，详细输出分别写入 `~/.agent-insight/logs/swe-bench-bootstrap.log`、`zsoft-l1-bootstrap.log`（配置 `AGENT_INSIGHT_HOME` 时随之调整），每次尝试覆盖对应日志。当前仍同步等待本次准备结束，再继续启动；数据库初始化或构建失败仍会停止启动。

下次启动会自动重试。也可在修复后从项目根目录单独重试，无需重启已运行的服务：

```bash
npx tsx scripts/benchmark/ensure-swe-bench-dataset.ts
# ZSoft 单独重试
npx tsx scripts/benchmark/ensure-dataset.ts --benchmark zsoft-l1
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

启动时会重新生成 `generated/benchmark-catalog/catalog-lock.json` 和 `evaluators.cjs` 等注册信息。源码与相关配置不变时，生成内容应保持一致；Python `__pycache__/`、`*.pyc`、`*.pyo` 和 `.DS_Store` 不参与摘要，无需清理缓存或手动恢复生成文件。真实源码变更仍会更新摘要与 Runtime 镜像标签。

### 4.3 其他 Benchmark

接入包可注册 `implementation.datasetPreparer` 和 `datasetPreparerExport`，通过 `npx tsx scripts/benchmark/ensure-dataset.ts --benchmark <key>` 单独准备和导入数据；ZSoft 也已接入上述启动自动导入，开关、官方来源与版本配置在 `platform.local.yaml` 的 `benchmarks.zsoft-l1.dataset.autoImport`、`source`、`revision`。评测机的资产根目录与加速模式配置在 `evaluator.local.yaml` 的 `benchmarks.zsoft-l1.assetsDir`、`kernelAccel`。旧 ZSoft 业务环境变量只提示迁移，不再覆盖 YAML；MCTS 自有的 `ZSOFT_TASKS_DIR` 仍在其 `config.env` 管理。未注册准备器的接入包仍可通过 `install-dataset.ts` 导入其 Profile 接受的文件或目录。普通数据集页面导入不能替代 Benchmark 数据集安装。

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

在 Agent 执行机项目的 `config/benchmark/executor.local.yaml` 配置；安装版常驻客户端对应目录为 `$AGENT_INSIGHT_HOME/client/runtime/config/benchmark/`。安装升级会更新默认文件、保留 local 文件；旧目录下的 `config/executor.local.yaml` 会在新目录尚无覆盖文件时迁移，并保留原相对 Git 路径的实际位置。也可由 `AGENT_INSIGHT_CONFIG_DIR` 指定配置目录。

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

`pi-mcts` 支持 SWE-bench 和兼容插件的 ZSoft 实验。按 MCTS README 完成一次性安装：**实际执行 Case 的客户端机器**准备 MCTS、Python 3.11+、Reliability Client 和已启用的 `mcts-xgovernor-proxy` Trace 代理；**xGovernor 主机**准备 Pi CLI、Pi 桥接扩展和 Pi/E2B worker，并确保所选数据集的沙箱环境可用。SWE-bench 额外需要执行机上的 `datasets` 和 `run_union.sh`，ZSoft 使用平台启动桥接，不要求这两项。两者可以分机部署，客户端不探测本地 Pi CLI。默认使用客户端 MCTS 仓库下的 `.venv/bin/python`；虚拟环境放在别处时可通过本机配置指定解释器。客户端不依赖交互终端的 venv 激活状态。MCTS 版本需支持 `--output-dir`，无需修改 MCTS 源码。执行机运行 Reliability Client 的账户必须能读取 MCTS 仓库及 `testcases_union/config.env`，并能在 `testcases_union/output/` 下写入；xGovernor 与 Trace 上报地址必须可达。

在“客户端安装”页勾选 MCTS，仅填写执行机上的仓库绝对路径。生成命令通过管道右侧的 `AGENT_INSIGHT_MCTS_REPO_DIR` 将路径交给本机安装器，不把路径发到服务端，也不要求填写 xGovernor 地址：

```bash
curl -sSf "https://insight.example.com/api/ingest/setup?key=<your-api-key>&yes=1&frameworks=mcts-xgovernor" | AGENT_INSIGHT_MCTS_REPO_DIR='/opt/MCTS' bash
```

安装顺序为仓库/Python/连接预检 → Trace 采集器安装 → 路径写入 `.env` → 常驻客户端注册和启动。预检或采集器失败会终止流程；MCTS 接入时客户端注册或启动失败也返回非零退出码，不输出 READY。重新执行命令可更新路径、采集配置并重启客户端。安装器不部署 xGovernor、不修改 MCTS 文件。

`services/executor/src/mcts-config.cjs` 统一实现路径解析、Python 检查、连接读取和配置持久化，同时进入客户端 tar 包与 MCTS 采集器 zip 包。读取连接时在独立 Bash 子进程加载 `testcases_union/config.env`，仅提取 URL，丢弃其 stdout/stderr；检查 HTTP(S) URL，再进行 TCP/TLS 连接预检。连接预检不执行付费任务，也不代表模型/E2B 全链路验证。

MCTS 安装器将本次版本的上传模块放入采集器目录内的 `shared/`，运行时优先读取此副本，保留旧版 `../shared/` 的兼容读取。升级不覆盖其他采集器已有的共享模块，避免版本差异阻止重复安装。

仓库路径自动保存到本机 `AGENT_INSIGHT_HOME/.env`，默认 `~/.agent-insight/.env`。自定义部署仍支持 `AGENT_INSIGHT_MCTS_PYTHON` 和 `AGENT_INSIGHT_MCTS_TRACE_LAUNCHER`，默认分别为 `<仓库>/.venv/bin/python` 和 `<Agent Insight home>/collectors/mcts-xgovernor-proxy/run.cjs`。配置优先级为进程环境 → `.env` → 兼容 JSON 字段 `mctsRepoDir` / `mctsPython` / `mctsTraceLauncher` → 默认值。旧 systemd 环境覆盖需由部署者同步维护；客户端只读取这三个 MCTS 项。

MCTS 安装器只检查公共仓库文件和 Python 版本。客户端按 Benchmark 分别探测：SWE-bench 检查 `run_union.sh` 及 `importlib.util.find_spec("datasets")`，不导入 `datasets`；ZSoft 检查公共运行前提和专用插件契约，不检查 SWE 依赖。Python 和接口子进程各有 5 秒上限，超时、无法启动、缺包、异常退出与版本不足分别返回原因。`agent-runtime/pi-mcts/v1` 与搜索参数能力在任一 Benchmark 就绪时可用；新客户端额外上报 `mcts-swe-bench/v1`，SWE 目标需该组件就绪，旧客户端未声明该组件时保留原兼容规则。实际运行仍正常导入依赖；运行时导入失败按实际进程错误处理。

这些是执行机本地配置，不进入服务端下发的 Case 任务。公共 Python/Trace 前提不满足，或两个 Benchmark 均不可用时，客户端会将 `agent-runtime/pi-mcts/v1` 标为未就绪；SWE 脚本缺失不会单独阻止 ZSoft。`pi-mcts` 不会出现在普通生成 Trace 实验中。

执行器每次从 MCTS `config.env` 读取真实 xGovernor 地址，以 `--upstream` 传给严格模式 Trace 代理。代理将动态地址放入 `AGENT_INSIGHT_MCTS_PROXY_URL`；本次专用 `python` 脚本在 MCTS 加载配置之后，将 `XGOVERNOR_BASE_URL` 恢复为代理地址并 exec 原解释器。手动启动器也为每次运行创建独立 Python 包装目录，退出时清理。固定 URL 不会绕过采集，无需修改 MCTS 配置文件。未配置仓库的历史独立 Trace 安装仍读取 `upstreamUrl` / `AGENT_INSIGHT_MCTS_UPSTREAM_URL`。

每个 Case 的执行命令由客户端固定为 `run_union.sh --mode sweverified --runtime pi --testbench sweverified --instance-id <Case ID> --split test --output-dir <runId>`，并通过严格模式 Trace 代理启动。搜索参数由执行机的 Runtime YAML 和本机默认值覆盖解析，并显式追加到 CLI；新建实验冻结页面参数，不自动选择联调预设。显式 CLI 参数覆盖 MCTS `config.env` 中的对应环境配置。客户端创建本次运行专用的 `python` 启动脚本，直接 `exec` 配置的 Python 解释器，再运行原版 `run_union.sh`。启动脚本保留原解释器路径，使 Python 正确识别虚拟环境及 `datasets`；不要把 venv 解释器符号链接到外部目录后执行。MCTS 只将最终选中节点写入 `testcases_union/output/sweverified/<runId>/artifact.patch`；客户端检查 Patch 后应用到该 Case 的冻结 Git 工作区，再由现有 `git-patch/v1` Collector 生成并上传 `model.patch`。Trace 代理的本地状态按 Case 隔离，客户端从其运行记录取得根 Session ID（`mcts.run.<32 位十六进制>`），作为回调 `traceId`，与平台 `Execution.taskId` 保持一致。OTLP 的 32 位 Trace ID 仅用于传输，不直接用作页面跳转；历史误存 OTLP ID 的 Case 在读取时按同一账户下根 Session ID 的 SHA-256 精确映射，不按时间邻近猜测。停止实验时客户端向进程组发送 SIGINT，给 MCTS 的 `finally` 清理和 Trace 代理上传留出 30 秒，然后强制终止仍未退出的进程。

MCTS 的默认模板、可选执行 Schema 和预设位于 `services/executor/runtimes/mcts/runtime.yaml`，通过 `delivery: argv`、`binding: { mode: passthrough }` 交付，不声明 flat/nested。上报给平台的通用描述只包含 `configuration: { version: 2, defaults }`。前端统一支持嵌套编辑，七个 MCTS 平铺默认字段仅是初始内容，修改草稿不会改变模板。执行客户端在启动前校验实际参数；不支持的嵌套值不会自动拆分。

执行机可在 `config/benchmark/executor.local.yaml` 覆盖默认值，安装版目录为 `$AGENT_INSIGHT_HOME/client/runtime/config/benchmark/`：

```yaml
runtimes:
  mcts:
    defaults:
      max-iters: 3
      token-fuse-limit: 0
```

没有显式实验配置时，从 YAML 模板及本机覆盖初始化完整值；显式值不补默认字段。MCTS 的 CLI 交付器仅在执行端拒绝对象、数组、null、非法 CLI key 及调度保留 flag。平台保存并下发原值，不按 MCTS 特判。CLI key 保留大小写、下划线和点号，布尔值按 true/false 字面量交付；新增实际支持的参数直接使用同名 key/value。

升级前应核对保留的 `executor.local.yaml`：其中历史 `maxIters` 等别名需由部署者确认并改成 CLI 原名。客户端不自动改写本机覆盖文件，也不会在正常执行时把 camelCase、下划线或点号重新解释成另一个名称或层级。

源码定义位于 `services/executor/runtimes/`，安装后实际读取 `${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}/client/runtime/executor/runtimes/`。新客户端约每 30 秒重新读取并上报定义，改 YAML 后等待上报并刷新页面，或重启客户端加速生效。客户端在每个 platform 的 `parameterDefinitions` 上报描述和 `definitionDigest`，不包含执行绑定。共享模块为 `packages/agent-runtime/index.cjs`（协议、校验）、`parameter-json.cjs`（递归 JSON）与 `loader.cjs`（YAML、覆盖、交付）。任务使用 `agentOptions: { version: 2, runtimeKey, definitionDigest, values }`；平台和执行端按选定 platform/agent 验证，契约不一致返回 `AGENT_DEFINITION_CHANGED`。

默认值和预设变动只更新模板修订，不覆盖正在编辑的草稿。客户端契约摘要覆盖目标、交付方式、业务 Schema 和绑定，不含 flat/nested 声明；平台将摘要视为不透明标识。历史快照不回写，复用确认只将原配置用于新草稿，不更名、不拆层。OpenCode 新版客户端提供默认空对象的通用配置，当前使用 CLI 交付；JSON/YAML 等新入口由客户端按实际接口适配。

平台及客户端首次启用本次能力需同步升级。先部署新平台，再重新执行页面生成的客户端安装命令，安装器复制新运行时并自动重启。已有注册的执行机也可在新版源码目录运行 `node scripts/install-ras-client.js`，保留绑定、复制运行时并重启；只更新 checkout 后重启旧服务不会更新安装目录副本。安装更新保留 `executor.local.yaml`，但覆盖安装目录 Runtime YAML，定制声明应在源码或配置仓维护并随升级部署。Linux 普通用户服务为 `systemctl --user restart agent-insight-client.service`，系统级服务使用 `sudo systemctl restart agent-insight-client.service`；macOS 使用 `launchctl kickstart -k "gui/$(id -u)/ai.agent-insight.client"`。Runtime 的主命令、工作区、Trace 和产物处理仍由代码实现，配置不能覆盖保留启动参数。

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

ZSoft 的专属资产准备与镜像部署步骤见 [ZSoft 部署指南](zsoft-deployment-guide.md)。
