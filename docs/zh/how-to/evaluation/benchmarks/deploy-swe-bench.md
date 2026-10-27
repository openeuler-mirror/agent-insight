# SWE-bench 部署指南

本指南与 [ZSoft 部署指南](deploy-zsoft.md) 同级，说明 SWE-bench 的数据、执行工作区、镜像配置和验收。平台、执行客户端和 Evaluator 的安装、互访地址及共享镜像池见 [Benchmark 通用服务部署指南](deploy-services.md)。

## 1. 部署前提

- 完成公共服务安装，三端使用相互兼容的代码与 Catalog。
- 平台具备数据来源和官方 Loader 所需网络，或按下节准备离线文件及 Python 环境。
- 执行机具备所选 Agent Runtime，并能按执行方式获取 Case 镜像或源码仓库。
- 评测机 Docker 可用，能访问配置的 Case 镜像来源及 Runtime 构建依赖。镜像来源与 CPU 架构必须匹配。

## 2. 数据集安装

`config/benchmark/platform.yaml` 的 `benchmarks.swe-bench.dataset.autoImport` 默认 `true`。平台启动时下载、校验并导入 SWE-bench Verified 的 500 条 Case；已有可用数据集时复用数据库，跳过下载和导入：

```bash
bash scripts/start.sh
```

在平台 `config/benchmark/platform.local.yaml` 设置 `benchmarks.swe-bench.dataset.autoImport: false` 可独立关闭启动导入。失败只警告，详细日志在 `~/.agent-insight/logs/swe-bench-bootstrap.log`（随 `AGENT_INSIGHT_HOME` 调整）。无需重启服务即可单独重试：

```bash
npx tsx scripts/benchmark/ensure-dataset.ts --benchmark swe-bench
```

内网或离线来源配置示例：

```yaml
benchmarks:
  swe-bench:
    dataset:
      source: /srv/datasets/test.parquet
    loader:
      sourceArchive: https://mirror.example.com/swe-bench/source.tar.gz
      python: /srv/python/bin/python
```

数据和 Loader 归档来源均支持 HTTP(S) 或本机文件，`null` 使用官方默认来源；本机与下载文件均校验固定官方 SHA-256，不覆盖校验失败的本机文件。完全离线时，将 `sourceArchive` 也改成本机归档，并让 `loader.python` 指向已安装官方 Loader 的解释器，否则首次创建环境仍需 pip 软件源。导入后原始数据文件可以移走；数据库没有可用数据集时才需要重新提供。

旧数据来源、Python 和路径/URL 环境变量不再生效。已安装数据集不会因修改来源自动变化；更新时使用独立数据集，保留已有实验身份与快照。更多导入边界见 [评测数据集指南](../datasets.md)。

## 3. 执行端准备

### 配置 Case 源码来源

以下 `gitSource` 用于 Git 工作区链路。原生 Pi/xiaoO 的 xGovernor 本地 Docker 直接使用 Case 镜像中的 `/testbed`，无需配置 `gitSource`，见下方 [Case 镜像](#原生-pixiaoo-的-case-镜像)。

在 Agent 执行机项目的 `config/benchmark/executor.local.yaml` 配置；curl 安装版使用 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`，默认 `~/.agent-insight/config/executor.local.yaml`。安装升级只更新运行时默认文件，保留用户配置；旧运行时目录的 local 文件不再读取，也不自动迁移。也可由 `AGENT_INSIGHT_CONFIG_DIR` 指定独立配置目录。

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

### 选择 Agent Runtime

普通 Agent 使用接入包声明的 Git 工作区和 `git-patch/v1` 提交契约。使用 MCTS 时，先完成 [MCTS xGovernor 接入](../../observability/mcts-xgovernor.md#用于平台-benchmark-实验)，执行机还需：

- MCTS 仓库中的 `testcases_union/run_union.sh`，支持 `--output-dir`；
- 所配置 Python 环境中的 `datasets`；
- 可读取 MCTS 配置并写入 `testcases_union/output/` 的权限；
- 就绪的 `agent-runtime/pi-mcts/v1`；新客户端还需 `mcts-swe-bench/v1`。旧客户端未声明后者时沿用兼容规则。

xGovernor、Pi/E2B 和 Trace 代理的部署属于 Runtime 接入，不属于 SWE-bench 数据集或 Evaluator 安装。MCTS 最终选中的 Patch 会作为 `model.patch` 上传；自身搜索过程中的官测不能代替平台评测。

### 原生 Pi/xiaoO 的 Case 镜像

客户端安装与更新见 [通用部署指南 7.3](deploy-services.md#73-原生-pixiaoo-的-swe-benchxgovernor-本地-docker)。xGovernor 在实验第二步点击下一步时按所选 Agent/执行方式检查并自动准备，不在链路采集器安装时编译。模型凭据、Docker 权限及系统编译依赖需要人工处理时，页面底部给出说明；修复后再次点击下一步。该主机级准备不提前下载全部 Case 镜像，镜像仍在各 Case 执行准备阶段按需获取。

以下为执行机 `executor.local.yaml` 中的可选覆盖，配置路径同本节前文；不填写时使用默认值：

```yaml
benchmarks:
  swe-bench:
    images:
      source: official
      arch: auto
      allowNonOfficial: false
      proxyPrefix: null
      verifiedMirrorRepositories: null
```

执行端和评测端分别维护镜像实现与配置。当前默认均优先使用本地官方别名缓存，缺失时依次尝试 SWR → 配置代理 → 官方仓库；SWR/代理拉取成功后恢复官方别名。执行端读取 `executor.local.yaml`，评测端读取 `evaluator.local.yaml`，不会自动同步。

| 配置 | 含义 |
|---|---|
| `source` / `arch` | 默认官方来源、自动识别架构；须与执行机及任务匹配 |
| `verifiedMirrorRepositories: null` | 使用内置两个 SWR Verified 仓库，仅适用于官方 x86_64；ARM64 跳过 |
| `verifiedMirrorRepositories: []` | 关闭额外镜像仓库，仍可使用配置代理或官方来源 |
| 自定义镜像仓库列表 | 按 `<repository>:<instance_id>` 查找 Case |
| `proxyPrefix` | 配置镜像代理前缀，默认不使用代理 |
| `allowNonOfficial` | 默认关闭；Epoch 仅用于显式许可的 ARM64 冒烟，不能替代正式结果 |

执行端访问私有 SWR 时，通过客户端运行账号及对应 Docker daemon 的现有认证配置准备，不在任务或 YAML 中填写密钥。执行端使用 Docker 本地缓存；[镜像池与预取](deploy-services.md#53-可选跨-benchmark-共享镜像池) 由 Evaluator 管理。

执行与评测使用独立容器，分别选择镜像，不强制两端 digest、image ID 或架构相同，也不保证环境内容完全一致。执行端直接使用镜像内源码，不 reset/clean；记录本次镜像身份与来源，官方安装提交与 Patch 基线处理见 [工作区、提交与诊断](develop-benchmark.md#工作区提交与诊断)。

## 4. 评测端准备

在评测机 `config/benchmark/evaluator.local.yaml` 配置镜像和 Docker 选项：

```yaml
benchmarks:
  swe-bench:
    python: python3
    images:
      source: official
      arch: auto
      allowNonOfficial: false
      proxyPrefix: null
      verifiedMirrorRepositories: null
    docker:
      requestTimeoutSeconds: 1800
      connectionPoolSize: 16
```

`images` 的字段及拉取顺序同上方 [Case 镜像配置](#原生-pixiaoo-的-case-镜像)，此处独立控制评测端。正式评测前核对所选来源、架构与接入包支持边界。

修改后按通用指南重启 Evaluator。公共镜像池按需拉取、缓存和回收 Case 镜像；预取与容量配置见 [共享镜像池](deploy-services.md#53-可选跨-benchmark-共享镜像池)。首次运行还可能等待 Evaluator Runtime 准备，离线环境应提前准备匹配版本的 Runtime 和 Case 镜像。

## 5. 部署验收

在评测机仓库执行：

```bash
curl -fsS http://127.0.0.1:3001/health
bash scripts/evaluator-doctor.sh --smoke swe-bench
```

使用自定义端口时替换 `3001`。Smoke 会实际执行评测，不调用 Agent，不能替代客户端链路验收。

在平台创建单 Case 实验，确认数据集、执行主机与 Runtime 可选；运行后检查根 Trace、`model.patch`、Evaluator 结果和 Evidence。再用可控的错误提交验证失败原因与资源清理。使用 MCTS 时选择 `mcts-coordinator`、`pi-mcts` 和平台默认模型，并为完整搜索过程设置足够的 Agent 超时。

## 6. 排查与更新

- 数据导入失败：检查 bootstrap 日志、来源校验和 Loader Python 依赖，修复后单独重试。
- 仓库获取失败：检查执行机 `gitSource`、目录权限和远程源访问。
- MCTS 未就绪：核对执行机 Python、`datasets`、启动脚本及 Trace 连接；预检通过仍需实际 Case 验收。
- 评测等待或失败：检查镜像来源、架构、网络、磁盘和 `/health` 中的准备状态。
- 已有 `model.patch`，但评测报 `Evaluator Entrypoint` / `Cannot find module './runtime-image.cjs'`：这是旧 SWE-bench Runtime 镜像漏包，不是 Agent 权限或断网导致。更新代码和生成的 Catalog 后，重新运行原有 `bash scripts/evaluator.sh start` 命令及部署参数；新摘要会触发准备完整依赖的 Runtime。远程预构建镜像部署须先发布同摘要的新制品。随后在 Case 页面点击“Benchmark 重评”，复用已有 Patch；无需重跑 Agent、重新安装客户端或放开网络。
- 更新执行适配时重新安装客户端；更新平台或 Evaluator 按 [更新与回滚](deploy-services.md#9-更新与回滚) 操作，保留历史实验快照。
