---
title: "MCTS 实验用户使用说明书"
description: "使用 Pi + MCTS 接入 Agent Insight，并创建、执行和查看 SWE-bench 实验"
---

# MCTS 实验用户使用说明书

本说明书面向已经准备好 MCTS 和 xGovernor 的使用者，介绍如何在执行机上安装 Agent Insight 接入组件，再通过平台执行 **Pi + MCTS 的 SWE-bench Benchmark 实验**。

文中的平台地址、仓库目录和主机名称均为示例，请换成自己的配置。平台、执行机与 xGovernor 可以位于不同机器。本说明书中的终端命令在 **MCTS 执行机** 上执行。

## 1. 使用流程与前置条件

完整流程如下：

```text
准备 MCTS / xGovernor
        ↓
在执行机运行平台生成的 curl 安装命令
        ↓
配置 MCTS 仓库路径，重启 Agent Insight 客户端
        ↓
在平台选择 Agent、数据集、Case 和执行参数
        ↓
开始实验 → MCTS 搜索并选择最终 Patch
        ↓
上传 model.patch → 平台执行 SWE-bench 评测
        ↓
查看实验结果、Case 详情和链路追踪
```

### 1.1 谁负责准备什么

| 位置 | 需要准备的内容 |
| --- | --- |
| Agent Insight 平台 | 可访问的平台地址、登录账号、已导入的 SWE-bench Benchmark 数据集、可用的 Benchmark 评测服务 |
| MCTS 执行机 | MCTS 仓库、Python 3.11+、该 Python 环境中的 `datasets`、Node.js 22.19.0+、Git、Agent Insight 接入组件 |
| xGovernor 主机 | 已启动的 xGovernor、Pi CLI、桥接扩展、相应 worker、模型凭据、E2B 凭据和可用的 SWE-bench 模板 |

MCTS 原始命令应能够连接 xGovernor 并执行任务；所用 MCTS 版本需要支持 `--output-dir` 和中断清理。执行客户端的系统账户需要能读取 MCTS 仓库及 `testcases_union/config.env`，并能写入 `testcases_union/output/`。

模型和 E2B 凭据由 xGovernor 部署者配置。已有服务的使用者可以复用这些配置。需要准备服务时，请先阅读 [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md#72-接入-pi-mcts-执行器)。

### 1.2 接入前确认三个值

| 配置 | 示例 | 填写规则 |
| --- | --- | --- |
| 平台地址 | `https://insight.example.com` | 执行机能够访问的 Agent Insight 地址，包含实际端口或访问前缀 |
| xGovernor 地址 | `http://127.0.0.1:8787` | 从 MCTS 执行机访问的真实上游地址 |
| MCTS 仓库目录 | `/opt/MCTS` | 该执行机上的绝对路径，每台客户端可不同 |

`127.0.0.1` 表示运行命令的那台机器。xGovernor 位于另一台机器时，填写执行机可达的地址或已建立的转发地址，并由部署者确认端口、token 和工作区权限匹配。

## 2. 在执行机安装 Agent Insight 接入组件

### 2.1 在平台生成 curl 命令

1. 登录 Agent Insight，进入 **配置 → 客户端安装**。
2. 在框架选择区域勾选 **MCTS (xGovernor)**。只接入 MCTS 时，取消其他框架的勾选。
3. 在 **MCTS xGovernor 地址** 中填写第 1.2 节确认的地址。
4. 找到 **Linux** 命令区域，点击 **复制**。命令由当前平台地址、登录账号和选中的组件生成。

> **配图占位｜图 1：生成 MCTS 安装命令。** 截图包含 MCTS 勾选项、xGovernor 地址、Linux curl 命令和复制按钮；遮挡 API Key。

### 2.2 在哪台机器执行

通过 SSH 或本机终端进入 MCTS 执行机，以将来运行客户端的系统账户粘贴并执行整条命令。保留 URL 两端的引号和末尾的 `| bash`。该命令可以在普通目录执行，不要求进入平台源码仓库。

平台生成的命令形如：

```bash
curl -sSf "https://insight.example.com/api/ingest/setup?key=<当前账号的APIKey>&yes=1&frameworks=mcts-xgovernor&mctsUpstream=http%3A%2F%2F127.0.0.1%3A8787" | bash
```

上面仅用于解释结构，实际执行时使用页面复制的完整命令。平台和客户端分机部署时，仍然在客户端机器上执行；安装生成的文件也保存在该客户端机器上。

### 2.3 确认安装结果

当前一键脚本会安装选中的采集器，并尝试安装、注册常驻客户端。两者承担不同职责：

| 组件 | 作用 |
| --- | --- |
| MCTS Trace 采集器 | 通过透明代理采集 xGovernor 的 Runtime、模型、工具和协作关系 |
| Agent Insight 常驻客户端 | 上报执行能力、接收平台 Case、启动 MCTS、提交 Patch 和执行结果 |

正常安装后，当前账户下会有以下文件：

| 文件或目录 | 用途 |
| --- | --- |
| `~/.agent-insight/.env` | 当前客户端的共享环境配置，后续在这里增加 MCTS 仓库路径 |
| `~/.agent-insight/client/` | 常驻客户端文件与注册配置 |
| `~/.agent-insight/collectors/mcts-xgovernor-proxy/` | MCTS 采集器及其上报、上游配置 |
| `~/.local/bin/agent-insight-mcts-run` | 手动执行 MCTS 时使用的采集启动器 |

如果设置了 `AGENT_INSIGHT_HOME`，Agent Insight 配置目录使用该变量指定的位置。`~` 指执行安装命令的系统账户，不是平台登录账号的主目录。

检查安装输出中是否出现“常驻客户端未注册”等提示。仅安装采集器可以产生 Trace，但平台执行实验还需要常驻客户端在线。注册失败时，按错误提示处理网络或账号问题后，重新执行页面生成的安装命令。

安装命令包含平台上报凭据；分享截图或说明书时应遮挡真实 API Key。

## 3. 配置客户端的 MCTS 路径

### 3.1 在 `.env` 中增加仓库路径

在执行机上打开安装生成的配置文件：

```bash
vi ~/.agent-insight/.env
```

保留原有平台地址和账号配置，增加或更新下面这一行；同名变量保留一项即可：

```dotenv
AGENT_INSIGHT_MCTS_REPO_DIR=/opt/MCTS
```

将 `/opt/MCTS` 改成自己的 MCTS 仓库目录。路径属于执行机，不需要与平台服务端目录相同。

常规安装只需新增这个变量。其余两项仅在默认位置不适用时填写：

| 变量 | 什么时候需要填写 | 默认值 |
| --- | --- | --- |
| `AGENT_INSIGHT_MCTS_REPO_DIR` | 必填，用于找到 MCTS 启动脚本和输出目录 | 无 |
| `AGENT_INSIGHT_MCTS_PYTHON` | 使用仓库外的 Python 虚拟环境时 | `<MCTS 仓库>/.venv/bin/python` |
| `AGENT_INSIGHT_MCTS_TRACE_LAUNCHER` | 采集器安装在自定义位置时 | `~/.agent-insight/collectors/mcts-xgovernor-proxy/run.cjs` |

客户端直接使用配置的 Python 解释器，不需要在终端先执行 `source .venv/bin/activate`。可以在执行机检查默认环境是否有依赖：

```bash
/opt/MCTS/.venv/bin/python -c 'import sys, datasets; print(sys.executable); print(datasets.__version__)'
```

如果检查失败，请由部署者在 MCTS 使用的 Python 环境中补齐依赖，再重启客户端。

### 3.2 确认 MCTS 保留代理地址

由 MCTS 部署者检查 `<MCTS 仓库>/testcases_union/config.env` 中的 `XGOVERNOR_BASE_URL`。它应允许采集启动器注入临时代理地址，例如：

```bash
export XGOVERNOR_BASE_URL="${XGOVERNOR_BASE_URL:-http://127.0.0.1:8787}"
```

示例中的默认地址换成自己的 xGovernor 地址。若文件直接将变量赋成固定 URL，会覆盖代理注入值并绕过采集。保留文件里原有的访问 token 和其他运行配置。

这里配置的是 MCTS 的连接方式；第 2 步安装时填写的 xGovernor 地址，是采集器转发请求的真实上游地址。

### 3.3 重启客户端

修改 `.env` 后，按安装器输出的服务管理方式重启客户端。

Linux 系统级服务通常使用：

```bash
sudo systemctl restart agent-insight-client.service
sudo systemctl status agent-insight-client.service --no-pager
sudo journalctl -u agent-insight-client.service -n 30 --no-pager
```

Linux 用户级服务使用：

```bash
systemctl --user restart agent-insight-client.service
systemctl --user status agent-insight-client.service --no-pager
journalctl --user -u agent-insight-client.service -n 30 --no-pager
```

修改 `.env` 本身不需要 `daemon-reload`。如果服务管理器设置了同名环境变量，它会优先于 `.env`；路径未按预期更新时，请部署者检查是否存在旧值。

### 3.4 在平台确认执行机在线

1. 返回 **配置 → 客户端配置**。
2. 找到刚安装的执行机，确认其在线、服务健康。
3. 创建实验时确认该执行机可作为 `pi-mcts` 的运行目标。MCTS 未就绪时，检查仓库路径、Python 依赖、采集器安装和日志中的原因。

实验中展示的 Agent 名称为 **`mcts-coordinator`**，与根链路一致；执行平台为 **`pi-mcts`**，运行时为 Pi。

> **配图占位｜图 2：客户端在线。** 截图包含主机名称、在线状态和实际显示的执行能力；没有能力详情时，可用实验中的可执行主机列表补充。

## 4. 在平台创建 MCTS 实验

进入 **评估与实验 → 实验**，点击 **新建实验**。首次接入可以先选择一条 Case、执行并发设为 `1`，检查整条执行和评测流程。

### 4.1 第一步：实验设计

1. 填写能辨识用途的 **实验名称**，例如“Pi + MCTS SWE-bench 联调”。
2. 在 **待执行 Agent** 中选择 **`mcts-coordinator`**，确认存在可执行主机。
3. 选择已经导入的 **SWE-bench Benchmark 数据集**，例如管理员提供的 SWE-bench Verified 数据集。
4. 实验类型选择 **无变量 · 单组**。
5. 点击 **下一步**。

`mcts-solver-initial`、`mcts-solver-child`、`mcts-author` 等是搜索过程中的子角色。创建完整 MCTS 实验使用 coordinator 对应的执行目标。

> **配图占位｜图 3：实验设计。** 截图包含实验名称、选中的 `mcts-coordinator`、SWE-bench 数据集和单组实验选项。

### 4.2 第二步：Trace 来源与执行参数

SWE-bench Benchmark 实验使用 **生成 Trace**。按下面的顺序填写：

| 页面配置 | 如何填写 |
| --- | --- |
| 运行主机 IP | 选择已经配置好 MCTS 的在线执行机；对应执行平台为 `pi-mcts` |
| 运行模型 | 选择 **平台默认**，模型沿用 xGovernor 的部署配置 |
| 执行并发 | 控制同时执行的 Case 数，首次接入可填写 `1` |
| Agent 超时 | 单位为秒，作用于每个 Case 的 Agent 命令；`900` 秒等于 15 分钟 |
| 数据集 Case | 搜索并勾选要执行的 Case，至少选择一条 |

例如，可搜索 `pallets__flask-5014` 并勾选该 Case；实际使用时选择自己要评测的任务。

Agent 超时需要覆盖 MCTS 的准备、搜索、自身官测和命令退出等阶段。它是执行上限，达到上限会中断进程；设置 15 分钟不保证默认搜索参数能在 15 分钟内完成。

#### MCTS 搜索参数

选择支持参数配置的执行机后，页面会显示 **MCTS 搜索参数**：

| 参数 | 含义 | 默认值 | 联调值 |
| --- | --- | --- | --- |
| 最大迭代次数 | 限制 MCTS 搜索迭代次数 | `5` | `1` |
| 分支数 | 控制搜索的分支扩展 | `3` | `1` |
| Solver 初始最大轮数 | 初始求解阶段的轮数上限 | `160` | `20` |
| Solver 后续最大轮数 | 后续求解阶段的轮数上限 | `80` | `10` |
| Author 初始最大轮数 | Author 初始阶段的轮数上限 | `160` | `20` |
| Author 后续最大轮数 | Author 后续阶段的轮数上限 | `80` | `10` |
| Token 熔断阈值 | 达到阈值时触发 MCTS 的 Token 熔断策略；`0` 关闭熔断 | `30000000` | `0` |

首次验证安装和数据回传时，可点击 **填入联调参数**。正式实验按评测目标设置参数，或点击 **恢复默认**。前六项填写正整数，Token 阈值填写非负整数，所有输入均不能为空。

**执行并发和分支数是两个不同的配置。** 执行并发控制平台同时运行多少个 Case；分支数控制一个 Case 内的 MCTS 搜索。Token 熔断阈值与 Agent 超时也分别生效；关闭 Token 熔断不会关闭执行超时。

页面参数会随实验保存并下发，覆盖执行机上的对应搜索参数。旧客户端未声明参数能力时不会显示这组输入，需要更新客户端后再使用。仅执行“重跑 Case”会沿用已保存的参数；要调整搜索参数或超时，使用 **复用评测配置**进入新建向导，修改后创建新实验。

选好 Case 和参数后，点击 **下一步：预期答案**。

> **配图占位｜图 4A：运行配置与搜索参数。** 截图包含执行机、平台默认模型、并发、Agent 超时、完整七项 MCTS 参数及两个参数按钮。
>
> **配图占位｜图 4B：选择 Case。** 截图包含搜索框、Case ID、勾选状态和下一步按钮；能与图 4A 合并时使用一张。

### 4.3 第三步：预期答案

核对选中的 Case 和平台显示的 **SWE-bench 官方测试契约**，然后点击 **下一步**。

这部分为只读评测契约，不需要手工填写 Gold Patch。Agent 接收公开任务字段；隐藏的测试内容与 Gold Patch 供 Benchmark 评测使用。

### 4.4 第四步：评估器与执行

1. 核对配置摘要中的 Agent、Case 数、运行主机、模型、执行并发、超时和 MCTS 参数。
2. 确认 **SWE-bench Official Harness** 已自动绑定。该评估器随 Benchmark 数据集绑定，不能取消。
3. 按需要增加满足条件的普通评估器；首次验证可以只使用自动绑定的 Benchmark 评估器。
4. 点击 **开始实验**。创建成功后进入实验详情。

> **配图占位｜图 5：开始实验。** 截图包含配置摘要、SWE-bench Official Harness 和开始实验按钮。

## 5. 查看执行进度与结果

### 5.1 实验详情

实验详情显示整体状态、运行配置、MCTS 参数、完成/失败/待执行数量、评估器分解与 Case 明细。Case 会依次经历工作区准备、Agent 执行、提交物上传和 Benchmark 评测。

| 实验状态 | 含义 |
| --- | --- |
| 运行中 | 仍有排队、执行或评测任务 |
| 已完成 | 所有 Case 的评测流程正常完成；具体解题结果查看 Resolved |
| 部分完成 | 成功完成和失败的 Case 并存 |
| 失败 | 全部 Case 失败，进入 Case 详情查看原因 |

SWE-bench 的 **Resolved 为否**表示本次 Patch 未解决任务，不等于评测服务发生故障。实验的“已完成”描述流程状态，Resolved 描述解题结果。

> **配图占位｜图 6：实验详情。** 截图包含实验状态、参数、进度、Case 明细和 Resolved 结果；失败示例须保留对应失败标签。

### 5.2 Case 详情与最终 Patch

在 Case 明细点击 **详情**，查看：

- 本次 Case 的任务输入和官方测试契约。
- **提交物**中的 `model.patch`，可查看或下载。
- SWE-bench 评测结论、评分点和评测证据。
- Agent 执行或评测失败时的错误码与错误说明。
- **前往链路观测**入口。

MCTS 会在多个分支中产生候选 Patch，最终选中一个节点。执行机上的最终文件为：

```text
<MCTS 仓库>/testcases_union/output/sweverified/<runId>/artifact.patch
```

客户端将该 Patch 应用到当前 Case 的工作区，再生成、上传平台提交物 **`model.patch`**。用户不需要手工查找分支 Patch 或上传文件。

“有 Trace”“分支修改了代码”或“MCTS 自身官测通过”，都不能单独代替平台提交和评测结果。确认执行链路跑通时，应同时检查根 Trace、最终 `model.patch` 和平台的 Benchmark 结果。

> **配图占位｜图 7：Case 详情。** 截图包含 `model.patch`、评测结果与证据，以及前往链路观测入口；页面较长可以拆为提交物和评测结果两张。

### 5.3 链路追踪

在 Case 详情点击 **前往链路观测**，打开本次运行的根 Trace。根 Session ID 形如 `mcts.run.<标识>`，根 Agent 为 **`mcts-coordinator`**。

展开根 Agent 和 TASK 节点，查看 `solver-initial`、`solver-child`、`author`、`selector` 等角色的模型调用、工具输入/输出、耗时和协作关系。具体角色与数量取决于本次运行。

Trace 显示失败时，查看顶部失败原因及相关节点；Case 的错误码说明实验为什么失败，Trace 用于查看执行过程中的证据。

> **配图占位｜图 8：MCTS 根链路。** 截图包含根 ID、状态、`mcts-coordinator`、子角色及若干工具调用。后续可补充工具输入/输出的展开图。

## 6. 超时、重试与停止

### 6.1 Agent 执行超时

Case 显示 **Agent 执行超时 / `AGENT_TIMEOUT`** 时，先核对错误中的毫秒值。例如：

```text
超过 900000ms 未结束
```

表示客户端已执行 900 秒的上限。MCTS 在规定时间内未退出，客户端会发送 SIGINT，并给清理和上传留出 30 秒宽限。Case 的整体耗时还可能包含工作区准备及回调等时间，因此不一定刚好等于设置值。

当前链路的计时范围还需区分：

| 时间 | 当前统计范围 |
| --- | --- |
| Agent 超时 | MCTS 启动命令的执行期限 |
| 根 Trace 顶部耗时 | 首次 xGovernor 请求至根采集终态，可能未包含前面的准备时间 |
| 树节点耗时 | 按可见交互计算，可能短于根 Trace 的完整生命周期 |

因此，设置 15 分钟后看到 9 分钟左右的 Trace，并不能据此判断客户端只执行了 9 分钟。核对实验配置、Case 时间和客户端错误；首次请求前的数据集加载等步骤目前没有完整分段计时。

需要更长执行预算时，使用 **复用评测配置**修改超时并创建新实验；首次联调也可以使用较小的 MCTS 搜索参数。增加预算或缩小搜索范围均不保证每条 Case 成功。

> **配图占位｜图 9：超时排查示例。** 可使用此前提供的实验失败与 SIGINT 根链路截图，并明确标注它们为失败示例。

### 6.2 重跑 Case 与重评 Benchmark

| 操作 | 用途 |
| --- | --- |
| 重试 / 重跑 Case | 重新执行该 Case 的 Agent 与评测流程；适用于修复环境、依赖或连接问题后再次执行 |
| Benchmark 重评 | 使用已有有效提交物重新执行 Benchmark 评测；适用于 Patch 已提交而评测阶段失败的情况 |
| 复用评测配置 | 将已有配置带入新建向导，调整超时或搜索参数后创建新实验 |

没有最终 Patch 时，先重跑 Case；单独重评无法补出缺失的 Patch。直接重跑保留实验已保存的超时和搜索参数。

### 6.3 停止实验

通过平台提供的停止入口停止正在运行的实验。客户端向当前运行的 MCTS 进程组发送 SIGINT，MCTS 执行现有清理逻辑，采集器尝试刷新剩余数据；仍未退出的进程会在宽限结束后被强制终止。

停止后保留已收到的过程数据；中断前尚未生成最终 Patch 的 Case 可能没有提交物。

## 7. 常见问题

| 现象 | 检查和处理 |
| --- | --- |
| 找不到 `mcts-coordinator` 或没有可执行主机 | 确认当前账号下客户端在线、已安装 MCTS 采集器、`.env` 仓库路径正确且客户端已重启；查看能力未就绪原因 |
| 客户端配置页没有本机，但链路页面有 Trace | 检查安装输出中的常驻客户端注册结果；Trace 采集器和常驻客户端各有职责 |
| 提示 `Missing datasets package` | 检查实际配置的 MCTS Python 环境；在该环境补齐依赖，不能只在系统 Python 中安装 |
| 页面没有 MCTS 搜索参数 | 确认选中 SWE-bench 数据集和 MCTS 执行目标；更新客户端，使其上报参数能力 |
| MCTS 能运行但没有新 Trace | 检查采集器上报配置、平台网络、账号，并确认 MCTS `config.env` 保留代理注入的地址 |
| Trace 失败上下文有 `SIGINT` | 结合 Case 状态区分超时与用户停止；查看是否在中断前生成最终 Patch |
| 有多个分支 Trace，但没有 `model.patch` | 查看根运行是否退出成功、是否有最终 `artifact.patch`；某个分支的 Patch 不等于最终提交物 |
| 重新执行安装命令后仍使用旧路径 | 检查 `.env` 和服务环境的同名变量，确认当前运行账户及 `AGENT_INSIGHT_HOME`，重启对应客户端 |
| 调整参数后直接重跑仍然超时 | 重跑沿用冻结配置；通过复用评测配置创建新的实验来修改参数或超时 |

## 8. 后续配图清单

目前正文保留文字占位，补图时按下表替换。截图中的平台 API Key、xGovernor token 等凭据需要遮挡。

| 图号 | 页面 | 需要保留的信息 |
| --- | --- | --- |
| 1 | 客户端安装 | MCTS 勾选项、上游地址、Linux curl 命令、复制按钮 |
| 2 | 客户端配置 | 执行机名称、在线状态、可见执行能力 |
| 3 | 实验设计 | coordinator、SWE-bench 数据集、单组实验 |
| 4A / 4B | 生成 Trace | 主机、模型、并发、超时、七项搜索参数、Case 勾选、下一步 |
| 5 | 评估器与执行 | 配置摘要、自动绑定的 Harness、开始实验按钮 |
| 6 | 实验详情 | 状态、配置参数、进度、Case 结果 |
| 7 | Case 详情 | model.patch、评测证据、链路入口 |
| 8 | 链路追踪 | 根 Trace、coordinator、子角色、工具调用 |
| 9 | 超时排查 | 超时 Case 与 SIGINT 失败链路，可使用已提供的截图 |

## 相关指南

- [实验功能说明](./experiments)
- [MCTS xGovernor Trace 接入指南](../observability/mcts-xgovernor)
- [Benchmark 服务安装指南](../../developer-guide/benchmark/service-deployment-guide.md)
