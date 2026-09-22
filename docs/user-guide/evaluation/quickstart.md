---
title: "跑通第一次评测"
description: "使用已有 Trace 或 Benchmark 数据集完成第一次实验"
---

# 跑通第一次评测

本指南使用最短路径完成一次评测：选择一条已有 Trace，配置一个评估器，启动实验并检查单条 Case 的评分依据。

> **Note**
> 第一次实验不要求先创建数据集。先确认实验能稳定运行并产出可解释结果，再把高价值样本沉淀为数据集。

## 前置条件

- 已有至少一个上报过 Trace 的 Agent。
- 已在模型注册和默认模型配置中设置可用评测模型。
- 当前账号可以访问目标 Agent 的 Trace。

### SWE-bench 等容器 Benchmark 的评测服务

需要官方 Harness 的 Benchmark 还要求独立 Evaluator Controller。评测机只需安装 Git、Docker 和 Bash，支持 Linux 与 macOS；macOS 需先启动 Docker Desktop。部署者 checkout 平台指定的固定 release 后，在仓库中运行：

```bash
bash scripts/start-evaluator.sh \
  --platform-base-url https://agent-insight.example.com
```

默认监听宿主机 `0.0.0.0:3001`；本机仍可通过 `127.0.0.1:3001` 访问，同时其他机器也可能通过评测机 IP 访问，生产环境应配合防火墙或显式使用 `--bind-address 127.0.0.1` 收窄范围。Linux 账号无 Docker daemon 权限时可显式使用 `sudo bash`；macOS 不使用 `sudo`。脚本始终只构建通用 Controller，不再选择 Benchmark，也不会在部署时安装全部 Harness。具体 Harness、SDK 和镜像配置属于 `benchmarks/<key>` 接入包；首个对应任务到达后，Controller 根据 Catalog 自动准备 Runtime 镜像并缓存，后续任务直接复用。实例需要额外环境变量时，可重复传入 `--evaluator-env NAME=VALUE`。SWE-bench 如需保持官方仓库路径的通用镜像代理，可使用 `--evaluator-env SWE_BENCH_IMAGE_PROXY_PREFIX=<registry-prefix>`。Verified x86-64 默认先使用项目公开的两个 SWR 仓库，无需增加启动参数；如需替换为其他固定仓库，可使用逗号分隔的 `SWE_BENCH_VERIFIED_MIRROR_REPOS`：

```bash
bash scripts/start-evaluator.sh \
  --platform-base-url https://agent-insight.example.com \
  --evaluator-env SWE_BENCH_VERIFIED_MIRROR_REPOS=registry.example.com/team/verified-a,registry.example.com/team/verified-b
```

评测器仅在 Docker daemon 为 x86-64 且镜像源为 `official` 时依次尝试这些仓库的 `<repository>:<instance_id>`，命中后冻结实际 registry digest；全部未命中时继续尝试旧代理（若配置），最后回退 Docker Hub 官方镜像。可显式传入 `--evaluator-env SWE_BENCH_VERIFIED_MIRROR_REPOS=` 禁用默认 SWR。ARM64 不读取该镜像列表，仍走原有 ARM64 官方镜像或显式 Epoch smoke 配置。默认启动不拉取 Runtime 或 Case 镜像；真实任务或显式 Smoke 才按需准备：

```bash
bash scripts/evaluator-doctor.sh
bash scripts/evaluator-doctor.sh --smoke swe-bench
```

平台只要求 `/health` 中目标 Evaluator 显示 `ready=true` 即可下发评测。ARM64 环境会自动选择对应架构的 Case 镜像，并按与 x86_64 相同的结果契约完成判定。

在 Agent Insight 主服务所在机器上更新通信目标：

```bash
node scripts/configure-evaluator-target.js \
  --evaluator-base-url https://evaluator-01.example.com
```

配置写入 `~/.agent-insight/data/config/benchmark-evaluator.env`，下一次 Benchmark 操作自动热加载，不需要重启 `scripts/start.sh` 启动的 Agent Insight。评测服务通过 REST 回传结果，由 Agent Insight API 写入平台数据库和 Artifact Store；评测机不需要平台数据库凭证或独立业务数据库。

Agent Insight 与 Evaluator 不提供应用层鉴权，也不会在任务下发、Artifact 下载、进度、证据或完成回调中发送或校验 Authorization。部署网络必须通过白名单、安全组或防火墙限制服务互访：

```bash
# 评测机
bash scripts/start-evaluator.sh \
  --platform-base-url http://10.0.0.10:3000

# Agent Insight 主服务机器
node scripts/configure-evaluator-target.js \
  --evaluator-base-url http://evaluator-01.example.com:3001
```

脚本不会自动配置网络边界；不得把 3001 或回调入口直接暴露给非目标机器。`--platform-base-url` 是 Evaluator 容器实际访问 Agent Insight 的地址；三台机器分离时填写 Agent Insight 的内网 IP 或可达 HTTP(S) 地址。省略该参数时仍沿用任务中的平台地址，兼容既有隧道部署。

执行客户端不需要增加任何配置。用户仍只运行 Agent Insight 页面提供的安装 `curl`；安装程序会把该命令所属的 Agent Insight 地址写入客户端配置，后续的 `model.patch` 上传、进度和完成回调统一复用这个地址。注册多个执行客户端时，每个客户端都使用各自安装时记录的平台地址，彼此不影响。

开发阶段如果 Agent Insight 和执行器在同一台机器、Evaluator 在远端，并且远端只能通过隧道或公开地址回调，可使用：

```bash
node scripts/configure-evaluator-target.js \
  --executor-callback-base-url http://127.0.0.1:3000 \
  --evaluator-base-url http://evaluator-dev.example.test:3001
```

Agent Insight 会从发起实验请求的 `Host` / `X-Forwarded-*` 自动推导公开回调地址并冻结到实验绑定，不再要求维护 `--public-base-url`。`--executor-callback-base-url` 只保留给旧版执行客户端和已经冻结的任务。升级后的执行客户端会校验下发回调的协议及精确 Run 路径，但真正发起 Artifact、进度和完成请求时使用安装 `curl` 已记录的平台地址。Evaluator 的实际回调目标由评测机启动参数 `--platform-base-url` 决定。

Agent Insight 与执行客户端在同一台机器时，安装 `curl` 使用 `http://127.0.0.1:3000` 即可；跨机器时，安装 `curl` 必须使用执行客户端能够访问的 Agent Insight 地址。配置更新不会改写已经开始的旧任务，旧客户端或旧任务仍可继续使用冻结的执行器回调覆盖地址。

执行客户端会把 Artifact 上传和完成回调作为独立的持久化投递队列处理：网络失败时按指数退避重试，单次回调最多等待 30 秒，并且重试期间不占用 Agent 执行槽，后续 Case 仍可执行。Git 工作区的 shallow fetch 单次最多等待 120 秒，只对白名单内的 DNS、连接中断、超时、curl 传输和部分 5xx 等瞬时网络错误进行最多 3 次尝试；每次重试都重建临时仓库，第三次仅对该命令使用 HTTP/1.1，不修改宿主 Git 配置。仓库不存在、revision 不存在、鉴权、证书或磁盘错误不会重试。

平台每 30 秒检查一次运行中的 Benchmark。Agent 执行侧：Git 工作区准备阶段最多允许连续 7 分钟无进度；Agent 阶段超过任务上限再加 90 秒宽限期；收集、上传、清理阶段连续 5 分钟没有新进度时回收。评测侧：等待下发、下发结果不确定、证据收集/上传/清理和结果归一化连续 5 分钟无进度时回收；官方 Harness 超过评测任务上限再加 90 秒时回收。回收会把 Case 明确置为失败并通过持久化续跑继续结算实验，服务重启后也会恢复，不会让页面永久停在“正在生成 Trace”或“运行中”。

评测服务只有收到结构完整、字段匹配的终态 ACK 才清除本地待回调任务；空响应、非 JSON 或字段不一致的 HTTP 2xx 仍会保留并重试。SWE-bench 正式结果还会对照冻结的实例、测试名单和 `report.json` 内容复核；常见明确错误码包括 `EVALUATION_TIMEOUT`、`SWE_HARNESS_RESULT_INVALID`、`RAW_RESULT_SCHEMA_INVALID`、`SWE_FORMAL_RESULT_INELIGIBLE`、`SWE_EVIDENCE_CONTRACT_INVALID` 和 `RESULT_MAPPING_FAILED`。

### 首次运行 Benchmark 的额外前置条件

除了启动 Evaluator Controller，还需要完成以下准备：

1. 管理员按[评测数据集](./datasets.md#管理员导入-benchmark-数据集)导入 Benchmark 数据；导入后所有用户看到同一份只读公共数据集。
2. 在 Agent 主机安装常驻客户端，并确认实验向导中的目标主机显示支持当前 Benchmark；客户端必须上报 `RUN_BENCHMARK_CASE`、Git Workspace、Agent Runtime 和 Artifact Collector 能力。
3. 新建实验时选择 Benchmark 数据集和要运行的 Case，Trace 来源保持“生成 Trace”；Official Harness 会自动绑定且不能取消。
4. 当前同一实验按 Case 串行执行。ARM64 适合链路 Smoke，正式 SWE-bench 成绩仍以 Linux x86_64 官方镜像为准。

## 步骤一：新建实验

1. 进入 **评估与实验 → 实验**。
2. 点击右上角 **新建实验**。
3. 输入实验名称。
4. 选择待评测 Agent。
5. 数据集保持 **不选择数据集**。
6. 实验类型保持 **无变量 · 单组**。
7. 点击 **下一步：Trace 来源**。

## 步骤二：选择已有 Trace

1. 保持 **选择 Trace** 模式。
2. 使用搜索、时间范围或用户标签缩小列表。
3. 勾选一条输入和输出都便于核对的 Trace。
4. 点击 **下一步：预期答案**。

首次运行不建议开启监听模式。监听模式更适合已经验证过评估器配置、希望持续评测后续新 Trace 的场景。

## 步骤三：处理预期输出

预期输出不是所有评估器的必需项：

- 如果准备使用不依赖预期输出或数据集输入的评估器，可以直接进入下一步。
- 如果准备使用任务完成度、结果准确性或引用 `{{reference_output}}` 的自建评估器，应为当前 Case 填写预期输出。
- 已有匹配数据集时，可使用 **从数据集导入匹配** 回填预期输出、数据集输入快照和 Tool/Skill 目录。

引用 `{{dataset_input}}` 的自建评估器要求实际任务输入确定性包含数据集 Case 输入；多条同时命中时使用最长、最具体的一条，未匹配的 Case 不参与该评估器计分。

## 步骤四：选择评估器并开始

1. 选择至少一个未被置灰的评估器。
2. 首次实验建议只选一个评估器，便于判断输出是否符合预期。
3. 点击 **开始实验**。

系统在服务端接受执行后跳转实验详情。实验没有需要用户再次确认的“开始执行”阶段。

## 步骤五：阅读实验详情

实验运行期间页面会自动刷新。首先检查：

- 状态是否从运行中进入已完成或失败。
- Case、评估器和进度数量是否符合本次配置。
- 综合均分是否有值。
- 评估器分解中的计入数量和失败数量是否合理。

然后在 Case 明细中点击 **详情**。

## 步骤六：核对评分依据

在 **Trace 评测详情** 中依次核对：

1. 任务输入、预期输出与实际输出是否属于同一次 Case。
2. 评估器的一句话结论是否与总分一致。
3. 未达标评分点是否给出可定位的证据。
4. 建议是否能指向具体输出或执行步骤。

如果机器评分明显不合理，可以填写理由后保存人工修正；评论只用于协作记录，不改变分数。

若失败发生在 Benchmark 官方评测阶段，应优先展开 Case 详情查看错误码：`SWE_FORMAL_RESULT_INELIGIBLE` 表示环境仅适合 Smoke；`SWE_EVIDENCE_CONTRACT_INVALID` 表示报告/证据与冻结任务不一致；`EVALUATION_TIMEOUT` 表示 Harness 已超时并被终止。这些错误不会被误计为业务不通过或 0 分。

## 下一步

- 系统了解实验流程：[实验](./experiments)
- 把代表性样本沉淀为数据集：[评测数据集](./datasets)
- 查看和创建评分标准：[评估器](./evaluators)
