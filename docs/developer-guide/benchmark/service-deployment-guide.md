# Benchmark 整体服务安装指南

本指南用于部署一个**已完成开发和验证**的 Benchmark 接入包。文档不说明 Adapter 和 Evaluator 的开发方法，只说明 Agent Insight、Agent 执行端和 Evaluator 的安装、配置与验收。

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

三端必须使用互相兼容的代码版本。目标代码中应已包含：

```text
benchmarks/<benchmark-key>/benchmark.yaml
benchmarks/<benchmark-key>/adapter/
benchmarks/<benchmark-key>/evaluator/
benchmarks/<benchmark-key>/schemas/
generated/benchmark-catalog/
```

发布前应已执行并提交 Catalog 生成结果：

```bash
npm run benchmark:catalog
```

不要在生产机器上手工修改 `benchmark.yaml` 或 `generated/benchmark-catalog/`。

### 2.2 运行环境

| 机器 | 必需环境 |
| --- | --- |
| Agent Insight | Git、Node.js、npm、Python 3（含 `venv`）、curl、tar，以及项目支持的数据库 |
| Agent 执行端 | Linux 或 macOS、Git、接入包声明的 Agent Runtime/Collector |
| Evaluator | Linux 或 macOS、Git、Docker、Bash，以及 Benchmark 自身要求的磁盘和内存 |

若 Benchmark 需要镜像、模型、数据目录或凭据，应在其接入包的发布说明中单独列出，不能直接照搬 SWE-bench 的环境要求。

### 2.3 网络

| 访问方向 | 用途 |
| --- | --- |
| Agent 执行端 → Agent Insight `3000` | 领取任务，上传 Trace、Submission 和执行结果 |
| Agent Insight → Evaluator `3001` | 下发 EvaluationJob |
| Evaluator → Agent Insight `3000` | 下载 Artifact，回传进度、Evidence 和结果 |

URL 必须使用对端机器真实可访问的地址，不能在分机部署时填写 `127.0.0.1`。

### 2.4 地址选择：同机与分机

Evaluator 由 Docker 容器运行，因此“Agent Insight 和 Evaluator 在同一台机器”时仍涉及容器到宿主机的通信。以下三个地址含义不同：

- `http://localhost:3000` 或 `http://127.0.0.1:3000`：供浏览器或宿主机进程访问 Agent Insight；在 Evaluator 容器内使用时只会指向容器自身，不能访问宿主机上的 Agent Insight。
- `http://host.docker.internal:3000`：Docker 提供给容器的宿主机入口。macOS/Windows 由 Docker Desktop 提供；本项目的 `start-evaluator.sh` 会在 Linux 上增加 `host-gateway` 映射。它只表示 Evaluator 所在的那台宿主机，不是公网域名，也不适用于分机部署。
- `http://<agent-insight-ip>:3000` 或 Agent Insight 的 HTTPS 域名：供另一台机器上的 Evaluator 访问 Agent Insight。该地址必须能从 Evaluator 容器内实际访问，不能只保证 Evaluator 宿主机可访问。

推荐配置如下：

| 部署方式 | Evaluator `platform-base-url` | Agent Insight `evaluator-base-url` | Evaluator 监听地址 |
| --- | --- | --- | --- |
| Agent Insight 与 Evaluator 同机 | `http://host.docker.internal:3000` | `http://127.0.0.1:3001` | `127.0.0.1` |
| Agent Insight 与 Evaluator 分机 | `http(s)://<agent-insight-address>:3000` | `http(s)://<evaluator-address>:3001` | `0.0.0.0` 或 Evaluator 内网地址 |

同机部署时，浏览器仍然访问 `http://localhost:3000`；`host.docker.internal` 只作为 Evaluator 启动时的 `--platform-base-url`，不要求用户在浏览器中打开，也不再写入 Agent Insight 配置。

## 3. 安装 Agent Insight

在 Agent Insight 机器上获取包含目标 Benchmark 的发布版本：

```bash
git clone \
  --branch <branch-or-tag> \
  --single-branch \
  <repository-url> \
  /srv/agent-insight

cd /srv/agent-insight
npm ci
```

默认运行根目录是 `$HOME/.agent-insight`。首次执行 `scripts/start.sh` 会自动创建该目录，并从 `.env.example` 生成权限受控的 `~/.agent-insight/.env`；也可以提前初始化：

```bash
mkdir -p ~/.agent-insight/data
cp .env.example ~/.agent-insight/.env
chmod 600 ~/.agent-insight/.env
```

默认 SQLite 数据库是 `~/.agent-insight/data/witty_insight.db`，无需显式配置。自定义长期数据库时，在 `~/.agent-insight/.env` 中设置：

```dotenv
DATABASE_URL="file:/home/<deploy-user>/.agent-insight/data/witty_insight.db"
```

临时测试不同数据库、不修改配置文件时，可只覆盖单次命令：

```bash
DATABASE_URL="file:/tmp/agent-insight-test.db" bash scripts/start.sh
```

配置优先级是“当前启动命令的环境变量 > `~/.agent-insight/.env` > 默认值”。如需将整个运行根目录迁到其他位置，应在启动进程、Docker 或 systemd 环境中设置 `AGENT_INSIGHT_HOME`；该变量决定 `.env` 文件本身的位置，因此不能依赖目标 `.env` 修改自己的位置。

平台与评测服务的对外端口分别配置，写入各自机器的 `$AGENT_INSIGHT_HOME/.env`（同机部署可共用一份）：

```dotenv
AGENT_INSIGHT_PORT=3000
AGENT_INSIGHT_EVALUATOR_PORT=3001
```

两者端口优先级均为 `--port > 当前进程同名环境变量 > $AGENT_INSIGHT_HOME/.env > 默认值`；环境变量显式留空时使用默认端口。旧 `PORT` 不再兼容：启动入口发现非空旧值会提示改名并退出，不会退回旧值。npm 命令的 start/stop/status/restart 也使用 `AGENT_INSIGHT_PORT`，不再读取工作目录下的 `.env`。Next.js 子进程仍由启动器内部传入 `PORT`，这是框架运行参数，不是用户配置入口。

```bash
bash scripts/start.sh --port 3100
bash scripts/start-evaluator.sh --port 3101 --platform-base-url http://<agent-insight-ip>:3100
```

评测容器内部固定监听 `8080`，只改变宿主机映射端口；不要通过 `--evaluator-env EVALUATOR_PORT=...` 覆盖，脚本会拒绝。更改评测对外端口后，还须更新平台登记的评测服务 URL（第 6 节）；更改平台端口时，同步评测服务的 `--platform-base-url`。

源码 `start.sh`、开发启动入口和 npm 启动入口均支持 `DATABASE_URL` 单次覆盖。`AGENT_INSIGHT_BENCHMARK` 自动准备目前由 `scripts/start.sh` 执行，不代表 npm / Docker 入口也会自动导入。Docker 默认运行根是 `/data/agent-insight`。

npm 安装阶段的 `postinstall` 同样遵守上述数据库优先级。使用自定义运行根或数据库时，安装和启动应传入相同配置。

如果要持续使用 SWE-bench Verified，在 `~/.agent-insight/.env` 中设置：

```dotenv
AGENT_INSIGHT_BENCHMARK=swe-bench
```

之后使用统一启动命令：

```bash
cd /srv/agent-insight
bash scripts/start.sh
```

`bash scripts/start.sh --benchmark swe-bench` 仍可作为单次覆盖；Benchmark 选择优先级是“命令行 > 当前进程环境 > `~/.agent-insight/.env` > 不自动准备”。

首次执行会自动下载并校验固定版本的 SWE-bench 官方源码和 Verified Parquet，在 `~/.agent-insight/vendor/SWE-bench/.venv` 创建隔离 Python 环境，将 500 条 Case 导入为平台共享只读数据集，然后继续构建和启动服务。后续执行会先查询数据库；数据集已经处于 `ready` 状态时直接跳过下载、环境安装和导入，因此本地缓存被清理也不影响服务重启。

不需要自动准备 Benchmark 时，将 `AGENT_INSIGHT_BENCHMARK` 留空，然后按原方式启动：

```bash
bash scripts/start.sh
```

验证：

```bash
curl -I http://127.0.0.1:3000
```

预期 Agent Insight 监听 `0.0.0.0:3000`。启用 `swe-bench` 后，启动成功即表示 SWE-bench Verified 已经存在或完成导入；页面中应能看到对应数据集。

## 4. 安装 Benchmark 数据集

### 4.1 当前支持边界

**当前已提供完整安装流程的 Benchmark 数据集只有 SWE-bench Verified。**

### 4.2 随服务启动自动安装

```bash
cd /srv/agent-insight
bash scripts/start.sh
```

脚本执行以下幂等流程：

1. 查询数据库中是否已有 `ready` 状态的 `swe-bench/verified` 平台共享数据集；
2. 仅在缺失时下载固定 commit 的 SWE-bench 官方源码并校验 SHA-256；
3. 创建受管 Python 虚拟环境并安装官方 Loader；
4. 下载固定 revision 的 SWE-bench Verified Parquet 并校验 SHA-256；
5. 校验数据集包含 500 个唯一 Case 后导入，再继续启动服务。

受管文件默认写入：

```text
~/.agent-insight/vendor/SWE-bench/
~/.agent-insight/data/imports/swe-bench-verified/test.parquet
```

下载、哈希校验、Loader 安装或导入失败时，启动会明确报错并停止，不会留下一个缺少已请求 Benchmark 数据集的运行中服务。自动流程不会替换数据库中已经导入的数据集，也不会静默升级历史实验使用的数据版本。

网络无法访问 Hugging Face 或 GitHub 时，可在 `~/.agent-insight/.env` 配置内网文件地址：

```dotenv
SWE_BENCH_DATASET_SOURCE=http://intranet.example/swe-bench/test.parquet
SWE_BENCH_SOURCE_ARCHIVE_SOURCE=http://intranet.example/swe-bench/source.tar.gz
```

两个来源也支持本机文件：

```dotenv
SWE_BENCH_DATASET_SOURCE="/srv/datasets/test.parquet"
SWE_BENCH_SOURCE_ARCHIVE_SOURCE="/srv/datasets/source.tar.gz"
```

来源支持 HTTP/HTTPS 下载直链或文件路径，路径位于 Agent Insight 主机上，推荐使用绝对路径；支持 `~/`、`$HOME/` 和 `${HOME}/` 前缀。两项留空时使用固定版本的官方 Hugging Face / GitHub 地址。先检查数据库是否已安装；未安装时，本机来源直接校验并使用，远程来源先复用已校验缓存再下载。源码在已有可用 Python 环境或受管源码缓存时无需重复准备。

统一来源只改变文件位置，本机与下载文件都必须通过代码内固定 SHA-256。本机文件缺失或校验失败立即报错，不自动联网或覆盖本机文件；下载失败或校验失败不会覆盖已有缓存。Python 依赖首次安装仍需要 pip 软件源，或通过 `SWE_BENCH_PYTHON` 复用已有环境。

旧配置兼容规则：新变量未设置时，数据集回退 `SWE_BENCH_DATASET_PATH`、`SWE_BENCH_DATASET_URL`；源码回退 `SWE_BENCH_SOURCE_ARCHIVE_URL`。新变量一旦设置（包括空值），不再读取对应旧变量；从旧配置迁移时将原路径或 URL 填入对应的新变量即可。启动命令可临时覆盖同名 `.env` 配置。

当前自动准备只支持正式 key `swe-bench`。不接受 `swe` 等别名；传入未支持的 key 会在修改数据库或启动服务前失败。

### 4.3 其他 Benchmark

对于其他 Benchmark，接入包即使已被三端加载，也必须先完成专用 Dataset Profile、Loader 和安装验收，才能在页面中发起正式评测。

当前不应将普通评测数据集的页面导入当作 Benchmark 数据集安装方案。若新 Benchmark 未同时交付数据集安装能力，则本次部署只能完成服务加载，不具备完整实验条件。

## 5. 安装 Evaluator

### 5.1 Agent Insight 与 Evaluator 分机部署

在 Evaluator 机器上获取与 Agent Insight 兼容的代码版本：

```bash
git clone \
  --branch <branch-or-tag> \
  --single-branch \
  <repository-url> \
  /srv/agent-insight

cd /srv/agent-insight
```

在受控内网中，可使用无 Token 方式：

```bash
bash scripts/start-evaluator.sh \
  --platform-base-url http://<agent-insight-ip>:3000
```

其中：

- 启动脚本始终构建通用 Controller，不接受 Benchmark 选择或预热参数；
- 默认发布到宿主机 `0.0.0.0:3001`，可通过 `--bind-address` 调整地址，使用 `AGENT_INSIGHT_EVALUATOR_PORT` 或 `--port` 调整对外端口；
- 不提供应用层鉴权，依赖白名单、安全组或防火墙限制双向访问；
- Benchmark Runtime 由任务中的 `benchmark.key + evaluator.key` 通过 Catalog 选择，首次任务按需准备并缓存；
- `--platform-base-url` 必须是 Evaluator 容器可访问的 Agent Insight 地址；
- Benchmark 专用环境变量可通过 `--evaluator-env NAME=VALUE` 传入。

### 5.2 Agent Insight 与 Evaluator 本机部署

如果 Agent Insight 的 `3000` 和 Evaluator 的 `3001` 都运行在当前机器，Evaluator 仍在 Docker 容器内，启动命令应使用 Docker 的宿主机入口：

```bash
cd /srv/agent-insight

bash scripts/start-evaluator.sh \
  --platform-base-url http://host.docker.internal:3000
```

这里不能把 `--platform-base-url` 写成 `http://127.0.0.1:3000`，因为该地址在容器内代表 Evaluator 容器自身。默认的 `--bind-address 0.0.0.0` 不影响本机通过 `127.0.0.1:3001` 调用，但也会监听其他网卡；只允许本机访问时应显式传入 `--bind-address 127.0.0.1`。

服务不会校验 Bearer Token；必须通过白名单、安全组或防火墙限制 Agent Insight `3000` 与 Evaluator `3001` 的访问范围。

验证：

```bash
curl -fsS http://127.0.0.1:3001/health
```

预期 `status` 为 `healthy`，且 `evaluators` 中目标 `benchmarkKey/evaluatorKey` 的 `ready` 为 `true`。

若接入包提供部署 Smoke，继续执行：

```bash
bash scripts/evaluator-doctor.sh --smoke <evaluator-key>
```

`evaluator-key` 来自 `benchmark.yaml` 的 `evaluation.evaluatorKey`，它不一定与 `benchmark-key` 相同。

启动、停止与清理共用的管理容器执行 Controller 镜像内的 `/app/services/evaluator/src/manage.cjs`，不挂载宿主源码目录，避免 Docker Desktop 对 `Documents` 等目录的访问权限影响管理操作。执行前用不挂载 Docker Socket 或数据卷的只读容器检查管理模块可加载；旧镜像缺少工具时明确失败，不执行停止或清理。可先用当前代码重新运行原启动命令，启动脚本使用新构建镜像管理旧实例（会中断旧评测）。Socket 和评测数据命名卷仍按原规则挂载。

### 5.3 可选：跨 Benchmark 共享镜像池

镜像池默认开启，正常运行 `start-evaluator.sh` 无需传启用开关或空间字节数。同一 Docker daemon 上接入的 Benchmark 共用空间预算、拉取去重和 LRU 回收；不改变评测并发，不清理 Build Cache、Volume、Controller 或 Runtime 制品。已有但未由池登记拥有的镜像只复用，不自动删除。

支持本机 Linux Docker 的传统 image store，以及本机 macOS + Docker Desktop 的传统/containerd image store。远程 daemon、Colima、OrbStack 和 Linux containerd 独立数据盘仍不支持。每个 daemon 只部署一个池管理 Controller，保留同一个 `/data` 命名卷，不能用多个数据卷各建一份池。

Linux 把 `DockerRootDir` 只读挂载到 `/host-docker`。Mac 同时只读挂载 Docker VM 数据目录和宿主空探测目录；containerd 模式额外验证 `/var/lib/desktop-containerd/daemon/io.containerd.content.v1.content`。不支持的目录布局直接拒绝开启，不回退读取 Controller 根分区。Mac 使用镜像内已有 Python 的 `statvfs.f_frsize` 计算容量，避免 VirtioFS 的 I/O 块大小放大读数；不增加宿主 Python 依赖或后台代理。

脚本读取 Docker Desktop 的 `settings-store.json`（旧版本为 `settings.json`）中的 `DataFolder` / `dataFolder`，未设置时使用默认 `~/Library/Containers/com.docker.docker/Data/vms/0/data`，确认其中存在 `Docker.raw`。默认创建评测管理目录下的 `space-probe` 空目录，并用宿主文件系统设备号校验它与 `Docker.raw` 同盘。若磁盘映像已移到外置盘，通过 `--evaluator-env 'IMAGE_POOL_MAC_DISK_PATH=/Volumes/example/empty-probe'` 指定该盘上已存在的空共享目录。仅用于读空间，不改变磁盘映像位置；不挂载或读取 `Docker.raw` 内容。共享权限不足、同盘校验失败、未知布局或空间检测失败均拒绝开启。移动 Docker 磁盘映像后必须重新运行启动命令进行校验。

停止旧 Controller、替换已保存配置之前，会用新镜像执行无网络、只读的磁盘预检。失败保留旧服务；预检只查询 Docker，不拉取或删除镜像。实际启动仍校验同 daemon 的唯一镜像池管理者。

以下均为可选覆盖，通过 `--evaluator-env` 传入。已移除 `IMAGE_POOL_ESTIMATE_BYTES` 和 `IMAGE_POOL_TEMPORARY_BYTES`，旧值不再读取，可从部署配置中删除。安全预留自动按比例计算，不再另设固定临时空间下限。

| Controller 配置 | 含义 / 默认值 |
|---|---|
| `IMAGE_POOL_ENABLED` | `true`；设为 `false` 显式关闭 |
| `IMAGE_POOL_RESERVE_RATIO` | `0.3` |
| `IMAGE_POOL_HIGH_WATERMARK` | `0.9` |
| `IMAGE_POOL_MAX_PULLS` | `2`；预取最多占 1 个槽位 |
| `IMAGE_POOL_WAIT_SECONDS` | `600`；还受任务总期限限制 |
| `IMAGE_POOL_MAC_DISK_PATH` | Mac 可选：与 Docker.raw 同文件系统的空共享目录；由启动脚本消费 |
| `IMAGE_POOL_PREFETCH_ENABLED` | `false`；接通双端准备消息后设为 `true` |
| `IMAGE_POOL_PREPARE_TOKEN` | 启用预取时必填，与平台的密钥一致 |

```text
当前可用空间 = Linux：Docker 数据盘可用空间
             Mac：min(Docker VM 各数据盘可用空间, Docker.raw 所在 Mac 文件系统可用空间)
可管理空间 = 当前可用空间 + 本池镜像占用估计
安全预留   = 可管理空间 × 30%
池容量     = max(0, 可管理空间 - 安全预留)
高水位     = 池容量 × 90%
准入条件   = 可用空间 >= 安全预留 + 在途拉取预留 + 本次新增估值
```

拉取估值由服务内部完成：本地已有镜像不发起远程估算；接入包已提供有效 `estimatedBytes` 时复用，否则用 `docker manifest inspect --verbose` 查询对应 Linux 架构的压缩层大小。所有候选源共用 2 秒查询预算，超时终止元数据查询子进程，不额外重试。成功时按压缩层总大小 × 4 估算（内部下限 256 MiB）；失败、超时、架构不匹配或未知格式时回退到内部 8 GiB 估值。成功结果缓存 15 分钟，回退结果缓存 1 分钟，最多 256 项；同一需求合并查询。这里只读镜像清单、不下载层，不放宽 TLS 校验、不要求新凭据；CLI 版本或仓库鉴权不支持查询时安全回退。上述系数和回退值是内部估算规则，不是镜像池容量，也不是空间充足保证。

没有低水位，也没有“先清一半、再全部清空”的批量策略。缺空间时按 LRU 逐个回收，每删一个读取实际空闲空间，够用即停。在用和容器引用镜像不能回收；近期准备镜像优先保留，但实际使用请求可回收尚未使用的预取镜像。后台保持每 30 秒检查，不增加拉取期间的高频检查；达到高水位则复查近期需求，不为水位本身批量删除。占用统计最多每 60 秒刷新，按 image ID 去重：传统存储使用 Docker 独占层估计，统计缺失时保留逻辑大小估值；containerd 标记 `containerd-logical-estimate`，不声称是物理独占空间。删除成功不等于空间立即回收，仍以实际空闲空间决定是否准入。

没有可安全回收的镜像且容量仍不足，当前请求返回不可自动重试的 `IMAGE_POOL_SPACE_LOW`；Docker 明确报告 `ENOSPC`、磁盘满或磁盘配额不足时也映射为此错误，不再换源拉取。当前 Case 经原失败回调结束，后续 Case 由现有平台流程推进，并各自重新检查空间；等待拉取槽位仍服从已有期限。Docker 连接中断等结果不确定的情况仍保留在途预算并阻止新拉取，不把停止等待视为下载结束。安全预留不是文件系统配额，未知镜像解压或外部写入仍可能突破估值；磁盘彻底耗尽时日志/状态持久化也可能失败，不保证下一 Case 一定能运行。

`/health.imagePool.storage` 返回最近一次采样的 `mode`、`freeBytes`、`measuredAt`；Mac 额外返回 `vmFreeBytes` 和 `hostFreeBytes`。采样失败记录 `error`，后续请求重新检测，不沿用历史可用空间放行。此字段不是每次健康请求同步刷新，不能把健康接口返回成功单独视为容量充足。

预取还需在 Agent Insight 进程环境设置相同的 `BENCHMARK_IMAGE_POOL_PREPARE_TOKEN` 并重启平台；该密钥不放在地址热加载文件，也不传给实例 Runtime。准备消息复用 `POST /api/v1/evaluations` 的 `operation: prepare-images`，仅该操作新增专用密钥校验；原评测/回调通道仍依赖网络隔离，不因此具备全通道鉴权。

```text
平台：更新当前/下一 Case 窗口 → Agent 执行 → 提交评测 → 下一 Case
池：        准备当前镜像 ─────→ 获取时登记保护 → 容器清理后释放
                     准备下一镜像 ─────────────────→ 等待使用
```

实验结束清空窗口，平台现有 watchdog 清理已取消实验的窗口；消息失败或平台重启时，窗口最多保留 30 分钟。过期只撤销软保护，不影响正在使用的镜像。无窗口或发送失败不阻断实验，按需拉取仍独立工作。

`[benchmark/image-pool]` 日志记录实际获取等待 `waitMs`、拉取/删除 `elapsedMs`、水位与跳过回收原因。结果 `runtimeFacts.imagePoolWaitMs` 保存该次镜像准备的实际阻塞时间，可按实验累计；验收重点是整轮等待时间和总耗时，不只看命中率。

重启先清理带任务标识的残留 Runtime/Case 容器，再释放使用者；清理失败继续保护。Docker 连接中断或遗留操作未确认结束时保留预算/隔离状态，暂停新拉取，已有安全镜像仍可用，`/health.imagePool.recoveryRequired` 和日志提示人工对账。运维须停止 Controller，确认旧拉取/删除已结束（无法确认时安排维护窗口重启 daemon），备份 `/data/image-pool/state.json`，然后仅解除已核实结束的 `operations` 条目或 `deleting` 标识；不要删除整个归属状态文件。

部署后先用小规模实验验证真实回收行为。需要关闭时重新部署并显式传 `--evaluator-env IMAGE_POOL_ENABLED=false`，保留数据卷；此后恢复原镜像解析路径，不再自动回收。省略开关会开启镜像池；不支持的存储布局会在预检阶段报错，需显式关闭后才按旧路径启动。

## 6. 配置 Agent Insight 与 Evaluator 的互访地址

### 6.1 分机部署

在 Agent Insight 机器上执行：

```bash
cd /srv/agent-insight

node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://<evaluator-ip>:3001
```

- `evaluator-base-url` 是 Agent Insight 访问 Evaluator 的地址；
- Agent Insight 的公开回调地址从实验启动请求的 `Host` / `X-Forwarded-*` 自动推导，Evaluator 的实际访问地址由其 `--platform-base-url` 覆盖；
- 配置会写入 `~/.agent-insight/data/config/benchmark-evaluator.env`，并在后续请求中热加载。

### 6.2 本机部署

Agent Insight 与 Evaluator 同机时执行：

```bash
cd /srv/agent-insight

node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://127.0.0.1:3001
```

- `evaluator-base-url` 由宿主机上的 Agent Insight 使用，因此同机时使用 `127.0.0.1`；
- Evaluator 容器访问 Agent Insight 的 `host.docker.internal:3000` 只在评测机的 `--platform-base-url` 中配置；
- `allow-insecure-http` 默认是 `true`，适用于已通过白名单、安全组或防火墙隔离的 HTTP 网络；需要强制非回环 Evaluator 使用 HTTPS 时显式设为 `false`。

两端没有应用层鉴权配置，必须通过安全组或防火墙限制 Agent Insight `3000` 和 Evaluator `3001` 的访问范围。

## 7. 安装 Agent 执行客户端

在 Agent Insight 页面进入 **配置 → 客户端安装**，选择 Benchmark 要求的 Agent Runtime，然后在每一台执行机上执行页面生成的完整安装命令。

Linux/macOS 命令形如：

```bash
curl -sSf "http://<agent-insight-ip>:3000/api/ingest/setup?key=<generated-api-key>&yes=1&frameworks=<agent-runtime>" | bash
```

以页面生成的命令为准，不要手工构造 API Key。

安装后应确认：

- 执行端在平台中显示为在线；
- 它上报了 Benchmark Manifest 要求的 Workspace、Agent Runtime 和 Artifact Collector 能力；
- 它能访问 Agent Insight 中配置的仓库与必要资源。

常驻客户端会把每轮能力探测结果先同步到本地 Benchmark 执行器，再上报 Agent Insight。运行期间新增、恢复或失效的 Agent Runtime 会在下一轮刷新后自动生效；已开始的任务继续使用创建执行计划时取得的 Runtime，新任务使用刷新后的能力集合。

若新 Benchmark 增加了新 Runtime 或 Collector，必须先发布包含该能力的执行客户端，再在每台执行机上重新安装。

### 7.1 配置 SWE-bench Case 源码来源（可选）

在**运行 Agent 的客户端机器**上，使用安装客户端的账号编辑 `~/.agent-insight/.env`；root 账号对应 `/root/.agent-insight/.env`。自定义了 `AGENT_INSIGHT_HOME` 时，配置文件为该目录下的 `.env`。不要只配在平台或评测服务机器上。

```bash
mkdir -p "${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
vi "${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}/.env"
```

添加或修改这一行，下面示例启用本地缓存（目录需对客户端账号可写）：

```ini
SWE_BENCH_GIT_SOURCE=/srv/swe-git
```

| 配置值 | 行为 |
|---|---|
| 留空或不配置 | Gitee → GitHub，不保留本地缓存 |
| 本地目录，如 `/srv/swe-git` | 本地缓存 → Gitee → GitHub，缺失源码下载后自动缓存 |
| Git 根地址，如 `https://git.example.com` | 指定来源 → Gitee → GitHub，不保留本地缓存 |

Git 根地址按 `根地址/owner/repo.git` 访问，例如 `https://git.example.com/pallets/flask.git`，不是压缩包下载地址。本地目录不需要手动创建每个仓库，也不会提前下载全部 500 个 Case。

旧客户端需先重新执行页面提供的安装命令升级。升级后修改 `.env` 对下一次任务生效；若启动客户端时设置了同名环境变量，则以该变量为准（包括空值），修改它后需重启客户端。

此项只影响 SWE-bench Case 仓库源码；与 `SWE_BENCH_SOURCE_ARCHIVE_SOURCE`（SWE-bench 工具源码归档）、数据集和 SWR 容器镜像配置无关。

## 8. 整体验收

先完成三向连通性检查：

```bash
# Agent Insight 机器
curl -fsS http://<evaluator-ip>:3001/health

# Evaluator 机器
curl -I http://<agent-insight-ip>:3000

# Agent 执行机
curl -I http://<agent-insight-ip>:3000
```

然后在 Agent Insight 页面中验证：

1. Benchmark 数据集已出现，数量和公开字段正确，且为共享只读；
2. 至少一个具备所需能力的 Agent 执行端在线；
3. 选择一个 Smoke Case 创建实验；
4. Agent 执行状态、Trace 终态和 Submission 回传完整；
5. Evaluator 完成 Harness，回传 Evidence 和 Raw Result；
6. 实验在全部 Case 达到终态后结算，页面显示正确的结论、主指标、评分点和文件。

还应至少验证一个异常场景：缺失 Submission、Submission 无效、Evaluator 超时或 Harness 失败。业务未通过与基础设施故障必须显示为不同结果。

## 9. 更新与回滚

- **Agent Insight**：更新到目标代码版本，重新执行 `bash scripts/start.sh`；
- **Evaluator**：更新到兼容版本，按当前互访地址重新执行 `bash scripts/start-evaluator.sh --platform-base-url <Agent-Insight-address>`；
- **Agent 执行端**：如果变更涉及 Runtime 或 Collector，在每台执行机上重跑客户端安装命令；
- **数据集**：更新代码或重建服务不会自动删除已安装数据集。

回滚时三端应同时回到相互兼容的代码版本。若新版本已写入不可向后兼容的数据库结构或结果数据，必须按该版本的发布说明处理，不得仅回滚代码。

## 10. 安装完成标准

只有以下条件全部满足，才视为 Benchmark 服务安装完成：

- Agent Insight、Agent 执行端和 Evaluator 均使用兼容版本；
- Evaluator Health/Doctor 通过，目标 Evaluator 为 Ready；
- Benchmark 数据集已安装且可被实验选择；
- 执行端能力与 Manifest 匹配；
- 成功 Case 和至少一个异常 Case 完成端到端验收；
- Submission、Evidence、指标、状态和页面展示符合该 Benchmark 契约。

## 11. 立即停止与镜像清理

在评测机的仓库目录执行：

```bash
bash scripts/stop-evaluator.sh --purge-images --dry-run
bash scripts/stop-evaluator.sh
bash scripts/stop-evaluator.sh --purge-images
```

三条命令分别为预览、立即停止且保留镜像、立即停止并清理受管镜像。不必先执行第二条才能执行第三条；已停止的服务也能离线清理。脚本只使用当前主机的 Unix Docker socket，不自动连接其他机器。指定了 `AGENT_INSIGHT_EVALUATOR_HOME` 的部署，停止时必须使用同一配置目录。

停止和清理按容器实例及资源登记定位，不按端口杀进程，因此自定义端口启动后仍使用上述命令，不需要 `--port`。即使随后修改了端口配置，仍可停止原实例。目前同一 Docker daemon 为单实例，换端口不会另建第二套评测服务或镜像池。

停止先持久化停止意图，禁止接单/恢复并关闭 Controller 自动重启，给予最多 2 秒容器退出窗口，再强制移除本实例 Runtime/Case 容器；不等待长实验自然完成。保留数据卷、配置、日志与 Artifact。取消记录持久化后，下次启动不会自动恢复这些旧任务；服务恢复后重试向平台报告 `SERVICE_STOPPED`。服务离线期间平台状态可能暂未收敛，需要终止远端 Agent 时仍应在平台停止并删除对应实验。

`--purge-images` 逐个非强制删除登记拥有的 Case、Runtime、Controller 镜像引用，Controller 在离线工具退出后删除。未登记的历史镜像、其他容器引用、身份已变化或拉取/构建尚未确认的镜像会跳过并报告。不会运行全局 `docker system prune`、清理 Build Cache、删除 volume 或强删共享镜像。共享 layer 不保证随引用删除释放空间。

返回码 `0` 表示操作完成，`2` 表示有未确认/跳过项，`1` 表示配置、归属或执行错误。报告中的空间数值取自数据卷文件系统，且不包括工具退出后删除 Controller 所释放的空间。部分失败后可重复执行；不要用清空登记数据的方式绕过安全检查。

升级部署前备份平台数据库，通过既有启动流程同步 Prisma schema（新增逻辑删除字段、取消记录和本地执行记录），更新平台、评测机及所有常驻执行客户端。旧客户端不识别取消指令，平台会保留待确认状态。此次代码验证使用临时数据库与模拟 Docker，正式部署仍需一轮真实取消、离线重连、停服和清理冒烟。
