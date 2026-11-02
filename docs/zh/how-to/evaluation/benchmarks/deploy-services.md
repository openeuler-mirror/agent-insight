---
title: "Benchmark 通用服务部署指南"
description: "介绍 Agent Insight、Agent 执行客户端和 Evaluator 的公共服务部署、互访配置与验收步骤，并提供各 Benchmark 的专属部署入口。"
keywords: ["Agent Insight", "Benchmark", "Evaluator", "服务部署", "环境验收"]
changefreq: monthly
---

<a id="benchmark-通用服务部署指南"></a>
本指南部署 Agent Insight、执行客户端和 Evaluator 的公共服务。完成公共安装后，按所选 Benchmark 阅读同级的 [SWE-bench 部署指南](./deploy-swe-bench.md) 或 [ZSoft 部署指南](./deploy-zsoft.md)，完成数据、执行环境和评测资产配置。架构与实现细节见 [`design/evaluation/benchmark/`](https://gitcode.com/openeuler/agent-insight/blob/master/design/evaluation/benchmark/README.md)。

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

接入包开发和 Catalog 生成由发布者完成，参见 [Benchmark 接入开发规范](./develop-benchmark.md)。部署者使用包含匹配 Catalog 的代码版本。

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
| SWE-bench | [数据集安装](./deploy-swe-bench.md#2-数据集安装) |
| ZSoft | [数据集安装](./deploy-zsoft.md#2-数据集安装) |

未注册准备器的接入包可通过 `install-dataset.ts` 导入其 Profile 接受的文件或目录，参见 [接入开发规范](./develop-benchmark.md)。普通数据集页面导入不能替代 Benchmark 数据集安装。

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
| `--evaluator-env NAME=VALUE` | 可重复传入；已知业务变量转换为本次启动的配置覆盖，其他变量传入 Controller/Runtime |

原有并发命令可直接使用，无需创建 YAML 文件：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url http://host.docker.internal:3000 \
  --evaluator-env EVALUATOR_MAX_CONCURRENCY=4
```

优先级为显式 `--evaluator-env` > `evaluator.local.yaml` > `evaluator.yaml` > 默认值；同一变量重复传入时最后一个生效，仅影响本次启动，不改写 YAML。业务覆盖在合并后统一校验，非法值在替换旧服务前报错。日志打印最终并发、镜像池和预取配置；`/health.maxConcurrency` 应为 4。普通进程环境里的旧变量仍不隐式覆盖 YAML，端口继续使用 `--port`，配置快照和镜像池内部磁盘参数禁止直接覆盖。

SWE-bench 同样支持 `SWE_BENCH_PYTHON`、`SWE_BENCH_IMAGE_SOURCE`、`SWE_BENCH_IMAGE_ARCH`、`SWE_BENCH_ALLOW_NON_OFFICIAL`、`SWE_BENCH_IMAGE_PROXY_PREFIX`、`SWE_BENCH_VERIFIED_MIRROR_REPOS`、`SWEBENCH_DOCKER_TIMEOUT` 和 `SWEBENCH_DOCKER_POOL_SIZE` 的显式覆盖。镜像仓库列表接受逗号分隔或 JSON 字符串数组，空字符串关闭额外仓库，`null` 恢复内置仓库；未知 SWE-bench/镜像池配置变量明确报错，不再忽略。

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

也支持显式传入 `--evaluator-env IMAGE_POOL_ENABLED=false`、`IMAGE_POOL_PREFETCH_ENABLED=false`，以及 `IMAGE_POOL_RESERVE_RATIO`、`IMAGE_POOL_HIGH_WATERMARK`、`IMAGE_POOL_MAX_PULLS`、`IMAGE_POOL_WAIT_SECONDS`、`IMAGE_POOL_MAC_DISK_PATH`。布尔值接受 `true/false/1/0`，路径相对所选配置目录解析。参数通过 stdin 交给容器内校验器，不出现在辅助 Docker 命令参数中；日志只打印固定配置摘要，不输出非业务 Runtime 凭据。

镜像池详细设计见[镜像池设计方案](https://gitcode.com/openeuler/agent-insight/blob/master/design/evaluation/benchmark/image-pool.md)。平台通过 `/health` 发现预取状态，无需额外令牌。Evaluator 端口应只允许平台访问。

### 5.4 评测并发与 Case 数量上限

普通实验和 Benchmark 实验的“执行并发”由用户在实验创建向导设置，默认 1；操作方法见[实验使用指南](../experiments.md)。以下是平台和 Evaluator 的部署配置：

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

平台侧未覆盖时保持默认值。修改平台配置后重启平台；修改评测配置后重新运行 Evaluator 启动命令。旧进程环境中的并发/待评测上限变量不再隐式覆盖 YAML；评测并发可用显式 `--evaluator-env EVALUATOR_MAX_CONCURRENCY=4` 覆盖。

启动后验证：

```bash
curl -fsS http://127.0.0.1:3001/health
```

确认返回的 `maxConcurrency` 为 2；使用其他端口时替换 `3001`。Case 数量上限的统计方式及调度行为见 [Benchmark 执行与评测调度](../../../explanation/platform/data-control-flow.md#实验并发与资源调度)。

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

执行机的 Benchmark 专属准备分别见 [SWE-bench](./deploy-swe-bench.md#3-执行端准备) 和 [ZSoft](./deploy-zsoft.md#3-执行端准备)。MCTS 是 Agent Runtime，接入与连接预检见 [MCTS xGovernor 接入](../../observability/mcts-xgovernor.md#用于平台-benchmark-实验)，不按 Benchmark 另建安装流程。

配置加载器也会被平台的 Next.js 服务导入。安装版专用的 `agent-insight-home.cjs` 通过 Node `createRequire` 在运行时加载，避免 Turbopack 将安装路径当作源码依赖解析；源码运行时不加载该安装目录模块。

### 7.2 参数配置与客户端更新

支持通用参数协议的 Runtime 由客户端上报默认配置，平台统一提供嵌套 key/value、JSON 导入导出和同 Runtime 参数模板。平台保存并下发完整配置，不改写字段名称或层级；实际 CLI、JSON/YAML 等交付方式由执行端适配。默认配置和本机覆盖不替代实验冻结的显式值。契约与扩展入口见 [Agent Runtime 参数](../../../reference/platform/api-and-contracts.md)。

更新 Runtime 或 Collector 后，在每台执行机重新运行客户端安装页生成的命令；已有注册的执行机也可在新版源码目录运行：

```bash
node scripts/install-ras-client.js
```

安装器保留绑定与 `executor.local.yaml`，复制新版运行时并重启。只更新 checkout 或重启旧服务不会更新安装目录副本。Runtime YAML 定制应在源码或配置仓维护并随安装发布，安装目录中的定义会被升级覆盖。客户端约每 30 秒重新读取并上报定义，修改后等待上报并刷新页面，或重启客户端。

首次启用新协议时先升级平台，再升级执行客户端。历史实验快照保留原值；契约变化时使用匹配客户端或确认原配置后新建实验，不回写历史快照。

### 7.3 原生 Pi/xiaoO 的 SWE-bench：xGovernor 本地 Docker

`swe-bench + pi-agent/xiaoo` 默认使用 `xgovernor-local-docker`，环境未就绪时不会回退宿主机执行。平台和 Evaluator 无需安装 xGovernor；MCTS 使用自己的独立服务。

**准备与安装**

执行机需为 Linux x64/arm64，Docker 可用且使用 cgroup v2，并具备原生 Agent 的模型配置。Git、C/C++、make、pkg-config、OpenSSL 开发库、curl、tar、xz 和 Python/TOML 读取能力由管理员提前准备；实验环境检查不会隐式执行系统包管理器或提权。执行机还需能访问 GitCode、Rust/Cargo、Node 与 npm 下载源；不足的 Node/Rust 工具链安装到独立依赖目录。

1. 在平台 **配置 → 客户端安装** 选择 Pi/xiaoO，执行页面生成的一条 curl 命令（见第 7 节）。
2. 安装仅接入链路采集和基础客户端，不因选择 Pi/xiaoO 就编译 xGovernor。确认客户端在线后创建单 Case 实验。
3. 在实验第二步选择主机、模型及 Case，点击下一步后检查环境；缺少受管理组件时自动编译 xGovernor、配套组件和 xiaoO 凭据桥接，通过复查后自动进入第三步。首次编译期间底部提示可能需要几分钟。需要配置模型凭据或系统依赖时，按底部说明在执行机处理，再次点击下一步。
4. 开始实验后检查 Trace、`model.patch` 和官方评测结果。准备复用原生 Agent 模型配置，无需另配 xGovernor Key；已有有效安装不会重复编译。

安装状态可在执行机查看；自定义 `AGENT_INSIGHT_HOME` 时相应替换路径：

```bash
node ~/.agent-insight/client/runtime/xgovernor.cjs status
```

**默认行为**

| 项目 | 默认值或行为 |
|---|---|
| 模型与凭据 | 沿用实验选择及原生 Agent 配置，每个 Case 准备时读取；无需另配 xGovernor Key |
| 隔离 | 每 Case 独立服务和工具容器，监听端口动态分配；工具容器断网，模型请求由宿主机控制器发出 |
| 工具容器资源 | 2 CPU、4 GiB 内存、512 PID |
| 本地记录 | 默认保留 7 天，只清理已结束且上传、资源清理均已确认的记录；镜像另行管理 |
| Case 镜像 | 使用镜像内源码；来源和架构配置见 [SWE-bench 镜像配置](./deploy-swe-bench.md#原生-pixiaoo-的-case-镜像) |

**可选配置**

curl 安装版编辑 `~/.agent-insight/config/executor.local.yaml`；源码运行编辑仓库 `config/benchmark/executor.local.yaml`。自定义配置目录规则见 7.1。以下为默认值，按需覆盖即可：

```yaml
retention:
  days: 7
execution:
  profiles:
    xgovernor-local-docker:
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 }
```

**更新与排障**

更新平台后，重新执行安装页生成的 curl 命令，等待安装完成及客户端重新上报能力。匹配版本会复用；缺少组件、旧布局或目录曾被移动时自动重建。执行环境摘要变化后需新建实验并重新选择环境，历史记录不会自动重跑。

| 现象 | 处理 |
|---|---|
| Docker / cgroup v2 未就绪 | 管理员修复宿主机，再重跑安装命令 |
| 构建失败或凭据桥接缺失 | 查看安装输出及 `status`，修复构建依赖、下载网络或权限后重跑 curl |
| 模型配置或凭据解析失败 | 按 Case 中的具体原因检查原生 Agent 配置、凭据库及运行账号 |
| 已有 Patch，但评测失败 | 按 [SWE-bench 排查与更新](./deploy-swe-bench.md#6-排查与更新) 检查 Evaluator |

手动版本更新、回退及安装实现见 [受管理安装与版本](./develop-benchmark.md#受管理安装与版本)；完整 Profile 配置见 [原生执行高级配置](./develop-benchmark.md#原生执行高级配置)。

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

# 查看镜像池与受管 Runtime 镜像的清理预览
bash scripts/evaluator.sh images list

# 预览可清理的空闲 Case 镜像与旧 Runtime
bash scripts/evaluator.sh images purge --dry-run

# 保持服务运行，清理空闲 Case 镜像与旧 Runtime
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

`start` 在新 Controller 通过 Doctor 后自动清理旧 Runtime；正常启动只显示 Doctor 和清理数量摘要，不逐项打印镜像 ID、摘要和 JSON。失败仍显示具体原因；Runtime 清理失败只打印警告，不停止已启动的服务。手动执行 `bash scripts/evaluator-doctor.sh`、`images list/purge` 保留完整诊断结果。在线 `images list/purge` 使用运行中 Controller 内的 Catalog 和配置，不使用宿主工作区的 Catalog；旧版 Controller 需先执行 `start` 升级。关闭 Case 镜像池时，Runtime 清理仍可使用。

Runtime 清理只处理同一 Docker daemon、同一数据卷中已登记且身份确认的 Runtime。始终保留当前 Catalog 所需引用及相同 Image ID、被任何容器（包括已停止容器）引用的镜像、未确认操作、被改写的引用及存在额外标签/其他仓库 digest 的镜像。删除不使用强制模式，不停止任务，也不执行全局 prune。输出的 `runtimes` 包含候选、删除、保留原因和失败项；`--dry-run` 不删除镜像或归属记录。预装/手工构建且未登记的历史 Runtime、Case 资产镜像及构建缓存不在 Runtime 清理范围内。

完成公共服务安装后，分别按 [SWE-bench 部署指南](./deploy-swe-bench.md) 或 [ZSoft 部署指南](./deploy-zsoft.md) 验收所选 Benchmark。
