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

Benchmark 执行配置位于执行机的 `config/benchmark/executor.local.yaml`；安装版目录为 `$AGENT_INSIGHT_HOME/client/runtime/config/benchmark/`。安装升级更新默认文件、保留 local 文件；旧 `config/executor.local.yaml` 在新位置没有覆盖文件时迁移，并保留相对 Git 路径的实际位置。也可通过 `AGENT_INSIGHT_CONFIG_DIR` 指定配置目录。

执行机的 Benchmark 专属准备分别见 [SWE-bench](swe-bench-deployment-guide.md#3-执行端准备) 和 [ZSoft](zsoft-deployment-guide.md#3-执行端准备)。MCTS 是 Agent Runtime，接入与连接预检见 [MCTS xGovernor 接入](../../user-guide/observability/mcts-xgovernor.md#用于平台-benchmark-实验)，不按 Benchmark 另建安装流程。

### 7.2 参数配置与客户端更新

支持通用参数协议的 Runtime 由客户端上报默认配置，平台统一提供嵌套 key/value、JSON 导入导出和同 Runtime 参数模板。平台保存并下发完整配置，不改写字段名称或层级；实际 CLI、JSON/YAML 等交付方式由执行端适配。默认配置和本机覆盖不替代实验冻结的显式值。契约与扩展入口见 [Agent Runtime 参数](../04-api-and-contracts.md)。

更新 Runtime 或 Collector 后，在每台执行机重新运行客户端安装页生成的命令；已有注册的执行机也可在新版源码目录运行：

```bash
node scripts/install-ras-client.js
```

安装器保留绑定与 `executor.local.yaml`，复制新版运行时并重启。只更新 checkout 或重启旧服务不会更新安装目录副本。Runtime YAML 定制应在源码或配置仓维护并随安装发布，安装目录中的定义会被升级覆盖。客户端约每 30 秒重新读取并上报定义，修改后等待上报并刷新页面，或重启客户端。

首次启用新协议时先升级平台，再升级执行客户端。历史实验快照保留原值；契约变化时使用匹配客户端或确认原配置后新建实验，不回写历史快照。

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
