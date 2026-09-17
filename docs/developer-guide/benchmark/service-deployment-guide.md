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
| Agent Insight | Git、Node.js、npm、Python 3、curl，以及项目支持的数据库 |
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

初始化配置和数据目录：

```bash
mkdir -p ~/.agent-insight/data
cp .env.example ~/.agent-insight/.env
chmod 600 ~/.agent-insight/.env
```

使用 SQLite 时，确认 `~/.agent-insight/.env` 中的数据库位置：

```dotenv
DATABASE_URL="file:/home/<deploy-user>/.agent-insight/data/witty_insight.db"
```

启动：

```bash
cd /srv/agent-insight
bash scripts/start.sh
```

验证：

```bash
curl -I http://127.0.0.1:3000
```

预期 Agent Insight 监听 `0.0.0.0:3000`。页面暂时看不到目标 Benchmark 数据集并不一定表示接入包加载失败；数据集需要按第 4 节单独安装。

## 4. 安装 Benchmark 数据集

### 4.1 当前支持边界

**当前已提供完整安装流程的 Benchmark 数据集只有 SWE-bench Verified。**

### 4.2 安装 SWE-bench 官方 Loader

```bash
mkdir -p ~/.agent-insight/vendor

git clone \
  https://github.com/SWE-bench/SWE-bench.git \
  ~/.agent-insight/vendor/SWE-bench

git -C ~/.agent-insight/vendor/SWE-bench fetch --depth 1 origin \
  02e7a74ffd0b707aab73d203fe87bdc7c76afc8e

git -C ~/.agent-insight/vendor/SWE-bench checkout --detach \
  02e7a74ffd0b707aab73d203fe87bdc7c76afc8e

python3 -m venv ~/.agent-insight/vendor/SWE-bench/.venv
~/.agent-insight/vendor/SWE-bench/.venv/bin/pip install \
  ~/.agent-insight/vendor/SWE-bench
```

### 4.3 下载并校验 SWE-bench Verified

将 `/path/to/swe-bench-verified` 替换为 Agent Insight 服务端可读的实际目录：

```bash
mkdir -p /path/to/swe-bench-verified

curl --fail --location --retry 5 \
  'https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/78f471bf655a3137b2e8a75af1501690ec009ec3/data/test-00000-of-00001.parquet?download=true' \
  --output /path/to/swe-bench-verified/test.parquet

printf '%s  %s\n' \
  '030cfd7f2a704c4c0226e7f104c725a3b41230b1d3517f9c915ad7ea5be3fa25' \
  /path/to/swe-bench-verified/test.parquet \
  | sha256sum --check
```

哈希校验必须返回 `OK`。

### 4.4 导入 Agent Insight

```bash
cd /srv/agent-insight

npx tsx scripts/benchmark/install-dataset.ts \
  --benchmark swe-bench \
  --profile verified \
  --source /path/to/swe-bench-verified/test.parquet \
  --name 'SWE-bench Verified'
```

预期返回的 `caseCount` 为 `500`，页面中可以看到平台共享、只读的 `SWE-bench Verified` 数据集。

### 4.5 其他 Benchmark

对于其他 Benchmark，接入包即使已被三端加载，也必须先完成专用 Dataset Profile、Loader 和安装验收，才能在页面中发起正式评测。

当前不应将普通评测数据集的页面导入当作 Benchmark 数据集安装方案。若新 Benchmark 未同时交付数据集安装能力，则本次部署只能完成服务加载，不具备完整实验条件。

## 5. 安装 Evaluator

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
  --benchmark <benchmark-key> \
  --auth-mode none \
  --platform-base-url http://<agent-insight-ip>:3000 \
  --bind-address 0.0.0.0 \
  --port 3001
```

其中：

- `--benchmark` 必须与 `benchmarks/<benchmark-key>` 一致；不要依赖脚本的 SWE-bench 默认值；
- 接入包存在 `evaluator/Dockerfile` 时使用该镜像，否则使用通用 Controller 镜像；
- `--platform-base-url` 必须是 Evaluator 容器可访问的 Agent Insight 地址；
- Benchmark 专用环境变量可通过 `--evaluator-env NAME=VALUE` 传入。

生产环境建议使用 `--auth-mode token --token <shared-token>`，并在 Agent Insight 一侧配置同一 Token。

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

## 6. 配置 Agent Insight 与 Evaluator

在 Agent Insight 机器上执行：

```bash
cd /srv/agent-insight

node scripts/configure-evaluator-target.js \
  --auth-mode none \
  --public-base-url http://<agent-insight-ip>:3000 \
  --evaluator-base-url http://<evaluator-ip>:3001 \
  --allow-insecure-http true
```

- `public-base-url` 是 Evaluator 下载 Artifact 和回调 Agent Insight 的地址；
- `evaluator-base-url` 是 Agent Insight 访问 Evaluator 的地址；
- 配置会写入 `~/.agent-insight/data/config/benchmark-evaluator.env`，并在后续请求中热加载。

若 Evaluator 使用 Token，改用 `--auth-mode token --token-file <0600-token-file>`。两端必须使用同一个 Token。

使用 `none` 模式时，必须通过安全组或防火墙限制 Agent Insight `3000` 和 Evaluator `3001` 的访问范围。

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

若新 Benchmark 增加了新 Runtime 或 Collector，必须先发布包含该能力的执行客户端，再在每台执行机上重新安装。

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
- **Evaluator**：更新到兼容版本，使用原完整参数重新执行 `scripts/start-evaluator.sh`；
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
