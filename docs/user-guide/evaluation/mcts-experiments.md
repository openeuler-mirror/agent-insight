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

首次联调可选择一条 Case、并发设为 `1`，通过 **导入 JSON** 使用下面的示例，再点击 **保存为模板**。后续从同 Runtime 的参数模板中选择；正式实验使用默认搜索参数或按需调整。参数区统一使用模板入口，不再提供专用联调按钮。

参数区提供通用树形编辑和 JSON 编辑，MCTS 默认内容是根级 CLI 参数。Key 使用 CLI 原 long 选项名，仅省略统一 `--` 前缀，保留大小写、下划线和点号，点号不表示层级。通用编辑器也支持新增对象、数组和 null，实际能否执行由客户端入口检查。点击 **导入 JSON** 粘贴或上传完整对象，预览差异后整体替换；也可导出、查看最终配置或保存个人模板。模板按同一 Runtime 筛选，同名保存为新版本，已有实验保留原快照。快速联调配置示例：

```json
{
  "max-iters": 1,
  "branching": 1,
  "max-turns-init": 20,
  "max-turns-step": 10,
  "max-turns-author": 20,
  "max-turns-author-step": 10,
  "token-fuse-limit": 0
}
```

新增 MCTS 已支持的 CLI 业务参数后，在平台增加同名 key/value 即可；例如执行端增加 `--new-option`，平台使用 `"new-option": "value"`，无需修改平台代码或增加逐字段 YAML 映射。参数必须由 MCTS 本身支持，平台不猜测类型、开关或结构。`mode/runtime/testbench/instance-id/split/output-dir` 等由平台根据目标和 Case 自动生成，不能被用户参数覆盖。

默认配置和可选执行校验位于 `services/executor/runtimes/mcts/runtime.yaml`；交付使用 `delivery: argv`、`binding: { mode: passthrough }`，无需 flat/nested 声明。客户端只向平台上报默认配置作为初始模板，业务 Schema 与交付绑定留在执行端。安装后文件位于 `${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}/client/runtime/executor/runtimes/mcts/runtime.yaml`。本机 `config/benchmark/executor.local.yaml` 的 `runtimes.mcts.defaults` 可覆盖模板；平台“恢复默认”仅重新复制当前上报值到本次草稿，不修改该文件。

新版客户端约每 30 秒重读并上报 YAML，修改后等待上报或重启，再刷新页面。首次升级执行代码，需重新运行页面生成的客户端安装命令；已有注册也可在新版源码目录运行 `node scripts/install-ras-client.js`，复制新运行时并自动重启。只更新源码 checkout 后重启旧服务不会更新安装目录副本。重新安装会覆盖安装目录 Runtime YAML，定制定义应在源码或配置仓维护；`executor.local.yaml` 会保留。

如果本机 `executor.local.yaml` 中仍有 `maxIters` 等历史别名，升级时需手工核对并改为对应 CLI 原名，例如 `max-iters`。平台不会自动修改执行机的覆盖文件，也不会将旧别名当作新的参数名重写。

已有实验的完整值和描述快照原样保留。通用编辑器允许在 MCTS 默认模板上新增对象、数组及 null，保存和下发完整草稿；当前 MCTS CLI 不能消费的配置由执行客户端在启动前报错。默认值不是编辑或提交的结构约束，删除字段不会被补回。客户端契约变化时，复用确认保留原 Key 和层级，不做 camelCase 别名转换。详细操作见 [实验运行参数](experiments.md)。

- **Agent 单次执行上限**按每个 Case 计时：`900` 秒为 15 分钟，`1800` 秒为 30 分钟。达到上限会中断执行。
- **执行并发**控制同时运行的 Case 数；**分支数**控制一个 Case 内的搜索。
- **Token 熔断阈值**为 `0` 时关闭 Token 熔断，执行超时仍然生效。

![生成 Trace 页面：选择 pi-mcts 主机、默认模型、并发和超时，设置七项 MCTS 搜索参数并勾选 Case](../../images/agent/evaluation/mcts/experiment-trace-config.png)

*图 5：旧版平铺参数区示意，使用默认搜索参数、1800 秒上限和三条 Case。新版参数区提供树形/JSON 编辑，Case 选择与下一步流程相同。*

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

ZSoft 的提交物为 **`poc`**。“评测证据”保留官方原始 `evaluation.json`、`record.json`、评测及清理日志，以及 `judge-evidence/`、`public-feedback/` 内的全部输出文件。文件夹可点击展开，文件可查看、下载；点击 **完整官方输出** 下载保留目录结构的 ZIP。空日志也保留，失败时仍可查看已经生成的输出。旧实验不会自动补齐完整报告，需点击 **Benchmark 重评**。

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
| `MCTS_LLM_INSUFFICIENT_BALANCE` | 模型服务明确返回余额或付费额度不足，检查所用账户或渠道后重跑 Case |
| `MCTS_LLM_OUTPUT_TRUNCATED` | 输出达到 token 上限，写文件工具可能未执行；缩短单次输出或分段写入，并核对有效输出限额 |
| 环境修复后重新执行 | 点击 **重试 / 重跑 Case**，沿用原实验参数 |
| 已有 Patch，评测阶段失败 | 点击 **Benchmark 重评**，使用已有提交物重新评测 |
| 需要中止执行 | 使用平台停止入口；中断时尚未生成 Patch 的 Case 可能没有提交物 |

不同 Case 可以同时提交 **Benchmark 重评**，复用已有提交物，不重新执行 MCTS。首次评测和重评共用评测服务的并发容量；例如服务配置 `EVALUATOR_MAX_CONCURRENCY=4` 时，合计最多同时执行 4 个评测，其余自动排队。若管理员配置了单用户并发配额，还需遵守该配额。同一 Case 在重评完成前不能重复提交。重评会自动触发镜像准备，镜像尚未就绪时显示等待并自动重试。

**Trace 耗时与执行上限的计时范围不同。** Trace 可能未包含首次 xGovernor 请求前的准备时间；Case 总耗时还包含工作区准备和中断清理。判断是否超时，以 Case 的错误说明和配置上限为准。

客户端会优先显示已观察到的模型余额不足、输出截断等错误，不再只保留最后的文件缺失或 404；多个原因可以同时展示，并保留根 Trace 关联。这里不增加任务重试或更改模型配置。需更新客户端和 MCTS 采集器（重新执行页面生成的安装命令）；已有失败记录不会自动改写。若外部 xGovernor 将底层模型错误吞掉并报成空的成功轮次，平台只能展示实际收到的证据，不能由 404 推断余额不足，也不会读取外部 Pi 原始会话或修改 MCTS/xGovernor。

## ZSoft 实验

ZSoft 数据集使用普通 Agent 或兼容 ZSoft 的 `pi-mcts` 自动生成 PoC。自动生成使用执行机上已有的原生 ZSoft 任务目录，无需额外导出或导入公开资料包；内核题与 userspace 共用该目录，内核题提交 C 源码。准备步骤见 [ZSoft 部署指南](../../developer-guide/benchmark/zsoft-deployment-guide.md#zsoft-任务目录与执行器)。

执行客户端管理员在该机器的 MCTS 仓库 `testcases_union/config.env` 配置 `ZSOFT_TASKS_DIR` 绝对路径，目录内应有 `<task-id>/task.json` 和 `public/`。平台按所选 Case 自动下发 `task-id`，实验向导不再配置任务目录；每台执行客户端使用自己的 MCTS 配置。普通 Agent 按任务说明将 Python、C 或 binary 单文件写入 `submission/poc`；MCTS 会自动导出所选 PoC 并交给客户端上传。执行客户端需上报 `zsoft-tasks-workspace/v3`，MCTS 还需 `mcts-zsoft-export/v1`，缺失时该目标不可用。

MCTS 优先使用题目的 `public/repo-vul/`。没有该目录时，执行机需保留官方 `<task-id>/private/source-manifest.json` 和任务目录上一级的 `source-locks/`；客户端仅提取源码定位所需字段，沙箱下载固定版本，有 SHA-256 时先校验。原始私有文件、参考答案和判题资料不会上传，任务包在上传前另行核对公开文件集合与内容。缺少来源或来源非法会提前报 `ZSOFT_SOURCE_MISSING` / `ZSOFT_SOURCE_INVALID`。本次不增加源码缓存，首次下载耗时计入执行预算，仍需沙箱能访问源码地址。修复此类问题后应重跑 Case，而不是只重评；升级时重新执行客户端安装页面的安装命令，确保执行机运行时也已更新。

正式成绩由平台的 ZSoft L1 Official Judge 给出，MCTS 搜索反馈和有 Trace 均不代表正式通过。在 Case 详情查看 `poc` 和评测报告；提交物上传成功后可独立重评。数据集从官方目录自动导入，旧 P2 JSON/JSONL 不再支持，需重新导入官方数据。自动生成需配置执行客户端的原生任务目录。

ZSoft 就绪检查通过静态解析检查插件函数签名、模式注册、CLI 参数和五个角色提示词，不加载插件或启动沙箱。桥接运行前再次核对源码摘要，预检后源码变化会拒绝执行。Python 题提交源码，C 题提交 C 源码，binary 题提交编译后的原始字节；生成提示按题目类型适配，保留公开题目和 README。C/binary 不使用插件内置的 Python preflight，需要按公开契约验证候选。

管理员可批量准备 userspace 与内核题的环境，并发布至公有 SWR。内核题的 runner 镜像进入 SWR，两版内核与模块随完整资产镜像自动安装到评测机共享卷；无需用户额外导入公开包。评测服务启动后按接入包固定摘要自动下载、校验并安装完整资产，重启复用，无需手动安装或设置 ZSoft 专用变量；题目镜像按需下载、缓存。平台评测 Runtime 缺失时先尝试拉取，拉取失败后自动构建，无需手动预构建。首次评测可能需要等待资产安装、Runtime 构建和题目镜像下载，后续实验复用缓存；离线部署仍需提前准备匹配版本的 Runtime 和评测资产。环境准备见 [镜像部署说明](../../developer-guide/benchmark/zsoft-deployment-guide.md#zsoft-镜像准备与公有-swr-部署)。

当前代码已覆盖 userspace 与内核题的接入流程，内核题在隔离的 runner 中通过 QEMU 运行，默认使用 TCG，支持评测管理员配置 KVM。内核环境尚未实际构建，真实 MCTS/E2B 与 ZSoft Judge 留待统一联调，合成回归通过不代表实题验收完成。

## 相关指南

- [实验功能说明](./experiments)
- [MCTS xGovernor Trace 接入指南](../observability/mcts-xgovernor)
- [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md)
