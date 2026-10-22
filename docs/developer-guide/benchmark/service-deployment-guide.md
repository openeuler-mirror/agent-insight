# Benchmark 通用服务部署指南

本指南部署 Agent Insight、执行客户端和 Evaluator 的公共服务。完成公共安装后，按所选 Benchmark 阅读同级的 [SWE-bench 部署指南](swe-bench-deployment-guide.md) 或 [ZSoft 部署指南](zsoft-deployment-guide.md)，完成数据、执行环境和评测资产配置。架构与实现细节见 [`docs/design/benchmark/`](../../design/benchmark/README.md)。

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

接入包开发和 Catalog 生成由发布者完成，参见 [Benchmark 接入开发规范](benchmark-integration-development-guide.md)。部署者使用包含匹配 Catalog 的代码版本。

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

自动安装能力由接入包的 Dataset Preparer 在 Catalog 中注册，平台不内置各 Benchmark 的下载和解析逻辑。启动脚本按已支持的 Benchmark 顺序独立检查并导入；对应 `dataset.autoImport` 为 `false` 时跳过启动导入，不影响已有数据集或管理员手动安装。

准备或导入失败只警告，继续其他数据准备、构建和启动；本次准备本身仍同步等待。日志写入 `<AGENT_INSIGHT_HOME>/logs/<benchmark-key>-bootstrap.log`，默认 home 为 `~/.agent-insight`，每次尝试覆盖对应日志。修复后下次启动会重试，也可从项目根目录单独执行：

```bash
npx tsx scripts/benchmark/ensure-dataset.ts --benchmark <benchmark-key>
```

独立导入失败返回非零退出码；数据库初始化或构建失败仍会停止平台启动。已安装数据集不会因修改来源配置自动更新。具体来源、固定版本、离线依赖和刷新步骤分别见：

| Benchmark | 部署说明 |
|---|---|
| SWE-bench | [数据集安装](swe-bench-deployment-guide.md#2-数据集安装) |
| ZSoft | [数据集安装](zsoft-deployment-guide.md#2-数据集安装) |

未注册准备器的接入包可通过 `install-dataset.ts` 导入其 Profile 接受的文件或目录，参见 [接入开发规范](benchmark-integration-development-guide.md)。普通数据集页面导入不能替代 Benchmark 数据集安装。

启动时重新生成 Catalog。源码与配置不变时，生成内容应保持一致；Python 缓存和 `.DS_Store` 不参与摘要，无需手动恢复生成文件。真实源码变更会更新摘要与 Runtime 镜像标签。

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

确认返回的 `maxConcurrency` 为 2；使用其他端口时替换 `3001`。Case 数量上限的统计方式及调度行为见 [Benchmark 执行与评测调度](../05-data-and-control-flow.md#实验并发与资源调度)。

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

### 7.1 执行机配置与 Runtime 接入

源码运行时在 Agent 执行机项目的 `config/benchmark/executor.local.yaml` 配置；curl 安装版统一使用 `~/.agent-insight/config/executor.local.yaml`，自定义根目录时为 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`。安装器自动准备用户配置目录并打印路径，不要求创建配置文件。安装升级只更新运行时内置的 `executor.yaml`，不覆盖用户配置。安装版不读取、迁移或回退到 `client/runtime/config/benchmark/executor.local.yaml` 或更早的 `client/runtime/config/executor.local.yaml`；旧文件保留但不生效，需要的配置请自行写入新路径。配置中的相对路径以新配置文件所在目录为基准。显式设置 `AGENT_INSIGHT_CONFIG_DIR` 时仍从指定目录读取 `executor.yaml` 与 `executor.local.yaml`，不叠加上述用户配置。

执行机的 Benchmark 专属准备分别见 [SWE-bench](swe-bench-deployment-guide.md#3-执行端准备) 和 [ZSoft](zsoft-deployment-guide.md#3-执行端准备)。MCTS 是 Agent Runtime，接入与连接预检见 [MCTS xGovernor 接入](../../user-guide/observability/mcts-xgovernor.md#用于平台-benchmark-实验)，不按 Benchmark 另建安装流程。

### 7.2 参数配置与客户端更新

支持通用参数协议的 Runtime 由客户端上报默认配置，平台统一提供嵌套 key/value、JSON 导入导出和同 Runtime 参数模板。平台保存并下发完整配置，不改写字段名称或层级；实际 CLI、JSON/YAML 等交付方式由执行端适配。默认配置和本机覆盖不替代实验冻结的显式值。契约与扩展入口见 [Agent Runtime 参数](../04-api-and-contracts.md)。

更新 Runtime 或 Collector 后，在每台执行机重新运行客户端安装页生成的命令；已有注册的执行机也可在新版源码目录运行：

```bash
node scripts/install-ras-client.js
```

安装器保留绑定与 `executor.local.yaml`，复制新版运行时并重启。只更新 checkout 或重启旧服务不会更新安装目录副本。Runtime YAML 定制应在源码或配置仓维护并随安装发布，安装目录中的定义会被升级覆盖。客户端约每 30 秒重新读取并上报定义，修改后等待上报并刷新页面，或重启客户端。

首次启用新协议时先升级平台，再升级执行客户端。历史实验快照保留原值；契约变化时使用匹配客户端或确认原配置后新建实验，不回写历史快照。

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

源码下载和检出可使用临时目录；编译与 npm 依赖安装必须在最终版本目录内完成，成功后只切换 `current.json`，不移动已编译目录。xGovernor Pi 探测把构建时扩展绝对路径写入二进制，编译后搬动目录会使探测找不到 `probe.ts`。`installation.json.build` 保存 `layoutVersion: 1` 与规范化的 `sourceDirectory`，安装校验同时核对当前路径。缺少此标记的旧安装或被搬动的安装不能进入就绪状态，也不能通过 rollback 激活。重新执行新版平台生成的 curl 安装命令，会重建同一固定源码版本，无需手工删除旧安装；失败只清理本次未激活目录，原 current 与旧版本目录保留。

安装检查不调用模型、不创建任务容器，不能替代真实 Pi/xiaoO + Docker Case 验收，也不能保证任意上游协议变化均可自动适配。布局或基础协议不兼容时拒绝切换，需升级本平台适配器。

升级此修复时，先更新并启动平台，再在客户端安装页选择 Pi/xiaoO 并执行新生成的 curl 命令，等待重建完成。可用 `node ~/.agent-insight/client/runtime/xgovernor.cjs status` 检查 `build.layoutVersion` 和路径。重建会刷新制品与执行环境摘要，应新建或复用实验并重新确认执行环境，再运行一个 Case；旧任务冻结的摘要不会自动改写。

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

仅将当前模型的密钥放入 case 进程专用环境变量，模型请求仍由宿主机发出。Pi 通过配套 SDK 的纯内置目录（`modelsPath: null`、离线模式）比对有效模型的 `compat` 与 headers：内置配置由 xGovernor Pi 桥接保留，只有实际不同的自定义项才拒绝，并返回字段名而非值。Pi 模型的 `reasoning/input/contextWindow/maxTokens` 映射到 `llm.capabilities.reasoning/input/context_window/max_tokens`，输出限制不得超过上下文。xiaoO `[llm].max_tokens` 映射到 `llm.capabilities.max_tokens`，`reasoning_effort` 按当前原生枚举规范为 `off/high/max`（含 `none/disabled/xhigh/maximum` 别名），随每轮请求发送；解析结果保存在本次句柄，后续配置变化不会改写已准备 Case 的设置。两个 KV cache 开关不配置或为 false 可执行，true 因当前契约不支持而报出字段名。Pi OAuth/订阅及无法保留的自定义 headers/兼容项仍不支持，不静默降级。显式 `models` 映射作为高级覆盖保留，但只检查当前选中模型的凭据，其他模型不会阻止环境就绪。模型目录不再必须复制到 Profile，默认复用 Agent 上报的 models。Trace 认证从原有 `$AGENT_INSIGHT_HOME/.env` 读取，显式环境变量仍优先，不使用设备凭据替代采集密钥。

手动安装仍可显式配置 `serverExecutable` 和各 Runtime 的 `workerExecutable`，Pi 另需 `executable`、`extensionDirectory`，均使用绝对路径。只要存在这些自定义路径，就完整采用手动安装，不与受管理安装混用；要迁移到受管理安装，先移除这些路径。手动安装按实际制品计算摘要，公开 `sourceRevision` 显示 `unknown`；兼容保留的旧 `sourceRevision` 声明不能证明二进制来源，也无需继续手动维护。

`runtimes` 是完整运行集合；默认受管理 Profile 按安装时选择过滤 Runtime，管理器仍构建配套组件。高级手动 Profile 可显式配置运行集合。同一个 Profile 内启用的 worker 或 Trace 依赖未就绪会报告环境不可用；模型凭据在任务准备阶段单独校验。`workerEnvironment` 可覆盖 Runtime 的 worker 变量名；Pi/xiaoO 默认分别为 `XGOVERNOR_PI_WORKER` / `XGOVERNOR_XIAOO_WORKER`。`settings` 仅由受信本机配置补充 Runtime 扩展，隔离参数由驱动固定。

每个 Case 使用独立 daemon、凭据、状态目录和工具容器。两个监听端口动态分配，启动阶段确认端口占用时最多尝试 3 次；清理按 PID 身份和独立 deployment 标签执行，不使用全局 kill/prune。MCTS 服务及其配置不参与这一生命周期。镜像先解析为本机不可变 image ID，再核对架构，以及容器实际的无网络、无宿主挂载、非 root 用户、capability、no-new-privileges 和资源限制。SWE-bench 直接使用镜像中的 `/testbed`，验证 Git HEAD、数据集基线 commit 存在且为 HEAD 的祖先，以及初始工作树干净；不检查 origin，不执行 reset/clean，保留官方镜像构建时的安装提交。预探测不会运行模型或逐个拉取 Case 镜像，显示“就绪”仍可能在实际镜像或模型检查时失败。

执行句柄分别持久化 `datasetRevision`（任务原有 base_commit）和 `baseCommit`（镜像初始 HEAD / Patch 基线），不改写任务版本。收集器相对持久化的镜像基线汇总 Agent 已提交、暂存和未暂存的修改，包含新增、删除文件，排除提交物自身，并禁用外部 diff/textconv。成功运行事实中的 `execution.workspace` 保存 `datasetRevision` 与 `patchBaseCommit`。两端仍独立选择镜像，Patch 由现有 Evaluator 应用和评测。

xGovernor HTTP 拒绝通过有界读取提取原因（最多 16 KiB、最多等待 1 秒），按固定词表转换为可展示的 Pi 探测、模型认证、网络或能力配置错误，已知请求字段错误仅保留字段名。响应中的 headers、密钥、URL、本地路径和任意 details 不传回平台；未知、过大、无法解析或读取失败的响应保留 HTTP 状态码。Case 失败提示以“执行环境请求被拒绝”展示安全原因，不重试已被拒绝的会话创建。历史仅存状态码的失败记录不会自动补齐。

HTTP 200 但沙箱命令退出非零或超时，按 `SANDBOX_COMMAND_FAILED` 回传安全消息；操作名来自固定列表，stderr 只取前 16 KiB 匹配固定原因，不回显原文、stdout 或命令参数。`runFacts.sandboxDiagnostic` 和本次私有目录的 `diagnostic.json` 保存阶段、操作、退出码、超时标记及原因；收集阶段失败仍保留已有 Trace/模型事实。未知原因明确标为未识别，不再提示用户查看不存在的诊断。

仅更新本次工作区与 Patch 修复时，更新平台并重跑安装页生成的 Pi/xiaoO curl 命令，以更新客户端 JS bundle；已通过布局校验的同版本 xGovernor 继续复用，不需要重新编译 Rust、重拉 Case 镜像或修改 cgroup。等待客户端重新上线后重跑失败 Case。只有安装器报告旧布局需要重建或环境摘要发生变化时，才需要重建依赖或重新确认实验执行环境。

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

完成公共服务安装后，分别按 [SWE-bench 部署指南](swe-bench-deployment-guide.md) 或 [ZSoft 部署指南](zsoft-deployment-guide.md) 验收所选 Benchmark。
