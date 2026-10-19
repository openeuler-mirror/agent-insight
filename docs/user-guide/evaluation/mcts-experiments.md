---
title: "MCTS 实验用户使用说明书"
description: "使用 Pi + MCTS 接入 Agent Insight，并创建、执行和查看 SWE-bench 实验"
---

# MCTS 实验用户使用说明书

适用于已部署 MCTS 和 xGovernor 的使用者。**所有终端命令在 MCTS 执行机上执行**；文中及截图中的地址、目录和主机均为示例，请使用自己的配置。

## 1. 接入前准备

- MCTS 原始命令能够正常运行，支持输出目录隔离和中断清理。
- 执行机已安装 Git、Node.js 22.19.0+，MCTS 使用 Python 3.11+。SWE-bench 还要求该环境安装 `datasets` 并提供 `run_union.sh`；ZSoft 不依赖这两项。
- 平台已导入 SWE-bench Benchmark 数据集，Benchmark 评测服务可用。

确认 MCTS 的 `testcases_union/config.env` 已配置可访问的 xGovernor，安装器会沿用这份配置。模型和 E2B 凭据由 xGovernor 部署者配置，详见 [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md#72-接入-pi-mcts-执行器)。

## 2. 一次命令完成接入

1. 进入 **配置 → 客户端安装**，勾选 **MCTS (xGovernor)**；只接入 MCTS 时取消其他框架。
2. 填写执行机上的 **MCTS 仓库绝对路径**，例如 `/opt/MCTS`，复制 Linux 命令。
3. 在 MCTS 执行机上，以运行客户端的系统账户执行完整命令。

```bash
curl -sSf "https://insight.example.com/api/ingest/setup?key=<当前账号的APIKey>&yes=1&frameworks=mcts-xgovernor" | AGENT_INSIGHT_MCTS_REPO_DIR='/opt/MCTS' bash
```

以页面生成的命令为准。安装器检查仓库、Python 版本和 xGovernor 连接；客户端再分别探测 SWE-bench 与 ZSoft 能力，安装采集器，将路径保存到 `~/.agent-insight/.env`，最后注册并启动客户端。**无需再编辑配置或手动重启**；检查失败时先处理提示，再重新执行同一命令。

安装器复用 MCTS 的连接和凭据配置，不改动 MCTS 仓库。默认使用 `<仓库>/.venv/bin/python`；仓库外的解释器可由部署者预设 `AGENT_INSIGHT_MCTS_PYTHON`。正常安装不需要设置 `mctsTraceLauncher`。

## 3. 确认客户端在线

进入 **配置 → 客户端配置**，确认执行机在线、服务健康，并显示 `pi-mcts`。

![客户端配置页面：执行机在线、服务健康，平台列表包含 pi-mcts](../../images/agent/evaluation/mcts/client-online.png)

*图 2：客户端在线。截图当前打开的是 `opencode` 页签，检查 MCTS 时点击 `pi-mcts`。*

## 4. 创建并执行实验

进入 **评估与实验 → 实验**，点击 **新建实验**。

![实验列表页面：右上角新建实验按钮，以及已有实验的状态和操作](../../images/agent/evaluation/mcts/experiment-list.png)

*图 3：新建实验入口。*

### 4.1 实验设计

填写实验名称，选择 **`mcts-coordinator`**、**SWE-bench Benchmark 数据集**和 **无变量 · 单组**，点击 **下一步**。

![实验设计页面：选择 mcts-coordinator、SWE-bench Verified 和无变量单组实验](../../images/agent/evaluation/mcts/experiment-design.png)

*图 4：实验设计。*

### 4.2 Trace 来源与执行参数

选择 **生成 Trace**，运行主机选择配置好的 **`pi-mcts`** 执行机，模型选择 **平台默认**（沿用 xGovernor 配置），勾选要执行的 Case。

首次联调可选择一条 Case、并发设为 `1`，点击 **填入联调参数**；正式实验使用默认搜索参数或按需调整。

- **Agent 单次执行上限**按每个 Case 计时：`900` 秒为 15 分钟，`1800` 秒为 30 分钟。达到上限会中断执行。
- **执行并发**控制同时运行的 Case 数；**分支数**控制一个 Case 内的搜索。
- **Token 熔断阈值**为 `0` 时关闭 Token 熔断，执行超时仍然生效。

![生成 Trace 页面：选择 pi-mcts 主机、默认模型、并发和超时，设置七项 MCTS 搜索参数并勾选 Case](../../images/agent/evaluation/mcts/experiment-trace-config.png)

*图 5：截图使用默认搜索参数、1800 秒上限和三条 Case。选好后向下滚动，点击“下一步：预期答案”。*

### 4.3 预期答案

确认选中的 Case 和只读测试契约，点击 **下一步：评估器与执行**。无需填写 Gold Patch；隐藏测试与 Gold Patch 不会发送给 Agent。

![预期答案页面：确认 SWE-bench 官方测试契约及选中 Case 的仓库和基线版本](../../images/agent/evaluation/mcts/experiment-contract.png)

*图 6：确认评测契约。*

### 4.4 评估器与执行

核对配置摘要，确认 **SWE-bench Official Harness** 已自动绑定。首次联调可只保留该评估器，向下滚动后点击 **开始实验**。

![评估器与执行页面：核对 MCTS 运行配置摘要，确认自动绑定 SWE-bench Official Harness](../../images/agent/evaluation/mcts/experiment-evaluators.png)

*图 7：核对配置并开始实验，按钮位于页面底部。*

## 5. 查看结果与链路

### 5.1 实验结果

打开实验详情查看进度和 Case 结果。**已完成**表示评测流程完成，是否解决任务以 **Resolved** 为准；执行失败时点击 Case 的 **详情**查看错误。

![实验详情页面：综合分、Harness 结果、同评测基线趋势和 Case 明细中的 model.patch 与 Resolved 结果](../../images/agent/evaluation/mcts/experiment-result.png)

*图 8：单条 Case 通过评测的结果示例。*

### 5.2 最终 Patch 与评测证据

在 Case 明细点击 **详情**，查看或下载 **`model.patch`**、评测报告和日志。MCTS 从多个分支中选择最终 Patch，客户端自动上传，无需手工提交。

![Benchmark Case 详情：顶部前往链路观测入口、model.patch、评测结果和证据](../../images/agent/evaluation/mcts/case-result.png)

*图 9：提交物、评测证据与右上角链路入口。*

### 5.3 链路追踪

点击 Case 详情顶部的 **前往链路观测**。根 Agent 为 **`mcts-coordinator`**，展开 TASK 和子角色可查看模型、工具调用及耗时。

![MCTS 链路追踪：已完成的根链路、mcts-coordinator、子角色和工具调用](../../images/agent/evaluation/mcts/execution-trace.png)

*图 10：MCTS 执行链路。*

有 Trace 不代表已完成提交；确认实验成功时还需检查最终 `model.patch` 和平台评测结果。

## 6. 失败处理与重新执行

| 操作或问题 | 处理方式 |
| --- | --- |
| 找不到 MCTS 执行主机 | 检查客户端在线状态、`.env` 仓库路径和重启结果 |
| `Missing datasets package` | 在 MCTS 实际使用的 Python 环境中安装 `datasets` |
| 没有 MCTS 搜索参数 | 确认选中 SWE-bench 数据集和 MCTS 主机，并更新客户端 |
| `AGENT_TIMEOUT` | 通过 **复用评测配置**增加执行上限，或减小搜索参数后创建新实验 |
| 环境修复后重新执行 | 点击 **重试 / 重跑 Case**，沿用原实验参数 |
| 已有 Patch，评测阶段失败 | 点击 **Benchmark 重评**，使用已有提交物重新评测 |
| 需要中止执行 | 使用平台停止入口；中断时尚未生成 Patch 的 Case 可能没有提交物 |

**Trace 耗时与执行上限的计时范围不同。** Trace 可能未包含首次 xGovernor 请求前的准备时间；Case 总耗时还包含工作区准备和中断清理。判断是否超时，以 Case 的错误说明和配置上限为准。

## ZSoft 实验

ZSoft 数据集使用普通 Agent 或兼容 ZSoft 的 `pi-mcts` 自动生成 PoC。自动生成使用执行机上已有的原生 ZSoft 任务目录，无需额外导出或导入公开资料包；内核题与 userspace 共用该目录，内核题提交 C 源码。准备步骤见 [ZSoft 部署指南](../../developer-guide/benchmark/zsoft-deployment-guide.md#zsoft-任务目录与执行器)。

执行客户端管理员在该机器的 MCTS 仓库 `testcases_union/config.env` 配置 `ZSOFT_TASKS_DIR` 绝对路径，目录内应有 `<task-id>/task.json` 和 `public/`。平台按所选 Case 自动下发 `task-id`，实验向导不再配置任务目录；每台执行客户端使用自己的 MCTS 配置。普通 Agent 按任务说明将 Python、C 或 binary 单文件写入 `submission/poc`；MCTS 会自动导出所选 PoC 并交给客户端上传。执行客户端需上报 `zsoft-tasks-workspace/v3`，MCTS 还需 `mcts-zsoft-export/v1`，缺失时该目标不可用。

正式成绩由平台的 ZSoft L1 Official Judge 给出，MCTS 搜索反馈和有 Trace 均不代表正式通过。在 Case 详情查看 `poc` 和评测报告；提交物上传成功后可独立重评。数据集从官方目录自动导入，旧 P2 JSON/JSONL 不再支持，需重新导入官方数据。自动生成需配置执行客户端的原生任务目录。

ZSoft 就绪检查通过静态解析检查插件函数签名、模式注册、CLI 参数和五个角色提示词，不加载插件或启动沙箱。桥接运行前再次核对源码摘要，预检后源码变化会拒绝执行。Python 题提交源码，C 题提交 C 源码，binary 题提交编译后的原始字节；生成提示按题目类型适配，保留公开题目和 README。C/binary 不使用插件内置的 Python preflight，需要按公开契约验证候选。

管理员可批量准备 userspace 与内核题的环境，并发布至公有 SWR。内核题的 runner 镜像进入 SWR，两版内核与模块随冻结评测资产部署在评测机；无需用户额外导入公开包。评测服务按固定版本下载、缓存题目镜像；平台评测 Runtime 缺失时先尝试拉取，拉取失败后自动构建，无需手动预构建。首次评测可能需要等待 Runtime 构建和题目镜像下载，后续实验复用缓存；离线部署仍需提前准备匹配版本的 Runtime 和评测资产。环境准备见 [镜像部署说明](../../developer-guide/benchmark/zsoft-deployment-guide.md#zsoft-镜像准备与公有-swr-部署)。

当前代码已覆盖 userspace 与内核题的接入流程，内核题在隔离的 runner 中通过 QEMU 运行，默认使用 TCG，支持评测管理员配置 KVM。内核环境尚未实际构建，真实 MCTS/E2B 与 ZSoft Judge 留待统一联调，合成回归通过不代表实题验收完成。

## 相关指南

- [实验功能说明](./experiments)
- [MCTS xGovernor Trace 接入指南](../observability/mcts-xgovernor)
- [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md)
