---
title: "实验"
description: "创建和运行实验、选择 Trace 来源并查看实验与 Case 结果"
---

# 实验

实验用于把待评测 Agent、Case 和评估器组织成一次可追踪的质量验证。实验创建后立即开始执行，结果按实验汇总，并可继续下钻到单条 Case 的评估证据。

## 实验列表

进入 **评估与实验 → 实验**，可以查看当前账号下的实验记录。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_list.png" alt="实验列表，展示实验名称、待评测 Agent、类型、Case 数、评估器数、综合分、状态和创建时间" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

列表字段说明：

| 字段 | 含义 |
| --- | --- |
| **实验** | 实验名称；点击所在行进入实验详情 |
| **待评测 Agent** | 本次实验绑定的 Agent |
| **实验类型** | 当前为单组实验或 LLM 对比实验 |
| **Case** | 纳入实验的 Case 数量 |
| **评估器** | 本次实验使用的评估器数量 |
| **综合分** | 实验全部评测结束后，显示全部有效评估结果的平均分；运行中或没有有效分数时显示 `—` |
| **状态** | 运行中、已完成、部分完成或失败；至少一项成功且至少一项失败时显示“部分完成”，监听实验还会显示监听状态 |
| **创建** | 实验创建时间 |

列表支持每页 20、50 或 100 条，并可使用上一页、下一页翻页。点击右上角 **新建实验** 进入四步向导。

列表中的 **同配置实验** 会直接按原实验的冻结配置创建并运行新实验；**复用评测配置** 会把配置带入新实验向导，供你核对和调整。两个入口的新实验名称都默认使用“Agent 评测 + 当前日期时间”，不会把复用方式追加到名称中。历史默认格式的实验名称若带有“同配置”或“复用评测配置”后缀，列表和详情标题会按该实验的创建时间展示标准名称；原始记录不改动。配置可在实验详情中查看。

创建后可在列表名称旁或实验详情右上角点击铅笔图标修改名称。名称须为 1～120 个字符，运行中和已完成的实验都可以修改；保存后列表、详情及趋势中的名称会更新，不改变实验配置和评测结果。带历史复用后缀的实验也可直接保存当前显示名称，或改成自定义名称。

## 四步创建实验

新建实验按照 **实验设计 → Trace 来源 → 预期答案 → 评估器与执行** 四步推进。步骤条会保存当前填写摘要，返回上一步不会清空已经完成的配置。

### 第一步：实验设计

在实验设计中配置：

- **实验名称**：本次验证的业务名称。
- **待执行 Agent**：候选项来自已有历史 Trace 的 Agent 与在线客户端可执行 Agent 的并集。
- **评测数据集**：可选；生成 Trace 时必须选择。
- **实验类型**：全局入口支持 **无变量 · 单组** 和 **LLM 对比**。

单组实验适合基线评测、问题复盘和回归验证。LLM 对比会按相同任务输入，从目标 Agent 已有 Trace 中自动配对 A、B 两个模型取值；只有两侧都有有效分数的 Case 才进入可比统计。

### 第二步：选择 Trace 来源

单组实验支持两种来源。

#### 选择已有 Trace

**选择 Trace** 直接评估目标 Agent 已经产生的执行记录，不会重新运行 Agent。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_trace_existing.png" alt="新建实验第二步，选择已有 Trace，包含监听模式、搜索、时间和标签筛选以及 Trace 列表" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

可用操作包括：

- 按 Trace ID 或任务输入模糊搜索。
- 按时间范围和用户标签筛选。
- 查看 Trace ID、任务输入、耗时、Token 和执行时间；执行过程异常请在诊断分析中查看。
- 分页浏览并跨页选择 Trace。
- 使用 **选择全部** 批量圈选当前筛选范围。
- 开启 **监听模式**，让该 Agent 后续新上报的 Trace 自动加入本实验评测。

监听模式允许不选择历史 Trace 直接创建实验。由于未来 Trace 没有逐条预期输出、数据集输入快照和 Tool/Skill 目录，依赖这些上下文的评估器在第 4 步不可选择。

#### 生成新 Trace

**生成 Trace** 使用数据集 Case 重新运行 Agent，再对新产生的 Trace 执行评估。

选择 Benchmark Case 时，列表上方会集中展示已选项；该区域默认最多显示 3 条，更多已选项可在区域内滚动查看，也可逐条取消选择或整体收起。

每个 Case 的 Agent 执行上限默认是 10 分钟，可在实验向导中配置为 30～3600 秒；达到上限仍未结束时，本次 Trace 生成按超时失败处理。该上限只约束 Agent 运行，不改变后续评估器各自的超时与重试规则。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_trace_generate.png" alt="新建实验第二步，选择生成 Trace，包含运行主机 IP、provider/model 和数据集 Case" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

生成前需要满足：

- 第 1 步已经选择包含 Case 的数据集。
- 目标 Agent 存在在线、可执行且支持回传 Trace ID 的客户端。
- 已选择运行主机 IP 和该主机上报的可用模型。
- 至少勾选一个数据集 Case。

Pi Agent 可以通过在线客户端执行普通生成 Trace 实验和 Benchmark 实验。先按[Pi 接入说明](../settings/access-control.md#流程四接入-pi-agent)安装并注册现有 Trace Collector，更新并重启 Reliability Client，再选择平台 `pi-agent`、根 Agent `pi-agent` 和运行主机。仅安装 `pi` CLI 不会开放实验能力；客户端还会检查 CLI 版本与参数、Collector 注册、启用状态、上传配置和 spool 可写性。Pi 实验能力独立于故障注入，不需要 Pi FI 组件，也不将 SubAgent profile 作为可启动目标。

Pi 模型配置仍读取运行用户的 `~/.pi/agent/settings.json`（默认 provider/model）、`models.json`（自定义模型）、`auth.json`（模型凭据）以及 provider 环境变量；设置 `PI_CODING_AGENT_DIR` 时使用该目录。模型列表由 `pi --no-approve --list-models` 发现，完整展示 Pi 在实验运行环境下列出的候选模型，标识为完整 `provider/model`；不增加白名单、不验证模型密钥有效性、余额或模型权限，也不逐个发起模型调用。发现失败时仍可选“平台默认”。

模型发现和实际执行共用同一启动方式：launchd/systemd 托管时按用户配置的 shell 加载登录交互环境，兼容 macOS/Linux 的 bash、zsh 等受支持 shell，不固定读取 `.zshrc`，不另外保存模型密钥。bash 由登录配置决定是否加载 `.bashrc`，zsh 按自身规则读取启动文件。仅在某个终端临时 export 的变量不会自动进入后台服务。CLI/模型探测按文件指纹缓存，Pi 配置修改触发下次能力刷新；修改 shell 环境或安装客户端后请重启客户端并刷新页面。

各平台共用的“运行模型”选择器支持按供应商、模型名称和完整 ID 搜索，采用大小写不敏感的字面包含匹配：输入内容必须连续出现在名称或 ID 中，例如 `deep` 会命中 DeepSeek，但不会命中字母分散在不同位置的模型。每个模型在列表中只显示一行友好名称，完整 ID 仍参与搜索、作为悬停提示并原样提交；相同 ID 会自动去重。搜索只筛选候选项，不改变已选模型；清空搜索恢复完整列表，方向键切换、Enter 选择、Esc 关闭，无匹配时显示提示。模型列表为空时仍保留“平台默认”；列表中的候选模型不代表平台保证调用成功，实际模型错误在实验执行时报告。

Pi 模型目录在后台异步发现，最多等待 20 秒，期间客户端继续发送心跳。成功列表缓存 5 分钟；探测失败会保留同一配置下上次成功的列表，并在 30 秒后的能力刷新中重试。初次启动尚未发现模型时可能暂时只有“平台默认”，能力上报后刷新页面即可。如果持续只有默认项，检查客户端日志中的 `Pi model catalog`：`ok models=0` 表示 Pi 自身列出的目录为空，`failed=TIMEOUT` 则表示探测超时，不能据此判断没有模型。

Pi 每次执行使用全新 Session，通过 stdin 接收 Case 文本；临时模型错误允许 Pi 自行重试，最终错误、无输出、超时或缺失完成事件会明确失败。实验绑定的是 Collector 的 `<session>__task0`，不是 Pi 原始 Session ID 或 OTLP span 哈希。进程退出不代表 Trace 已入库，平台仍等待既有 Collector 上传；本地 self-check 不验证远端网络和平台密钥有效性。Collector 未就绪时修复安装/配置后再运行，Trace 入库超时时检查上传端点、密钥及 spool。

实验使用 `--no-approve`，忽略 Case 仓库中的 `.pi` 项目资源与项目 Skill，保留全局 Collector/Skill。需要评测的 Skill 请安装到受控的全局位置；不要依赖 Case 中的 `.pi/extensions` 或项目模型覆盖。此选项只是项目信任策略，不是工具执行沙箱。

xiaoo 可以通过在线客户端执行普通生成 Trace 实验和 Benchmark 实验。先使用现有 curl 安装流程完成客户端与 xiaoo Trace Collector 安装；更新客户端后重启服务，在 Agent 列表选择 `xiaoo · xiaoo · 可执行 N 台`，再选择对应运行主机。界面将 Collector 上报的 `xiaoo` Trace 身份与 CLI 原生 `defaultagent` 执行 ID 合并展示，实际执行仍使用 `defaultagent`。历史 Trace 中的 `xiaoo` 名称本身不表示该机器已具备实验执行能力。平台与运行主机可以分开部署，继续使用客户端安装时配置的平台地址。

客户端要求 xiaoo CLI 支持 JSON 输出、Agent 和标题参数；模型 `provider/model` 会拆为 xiaoo 的 provider 和 model 参数。执行错误、模型鉴权失败、无输出和超时会回写为明确失败，原有 Trace Collector 继续负责上传轨迹。若 CLI 返回 HTTP 401，请修复运行主机上的模型鉴权配置后重跑 Case。

xiaoo 执行过工具但最后没有文字回复时，不应被判为“无输出”。客户端会在正常退出后结合本次会话的 Collector 活动记录判断；真正无活动、明确执行错误、超时或 Benchmark 必需 Patch 为空仍然失败。升级此修复需同时更新客户端与 xiaoo Collector，并重启客户端服务；此前误判失败的 Case 需重新运行，不会自动恢复。

xiaoo 实验复用运行主机上同一系统用户已有的配置和密钥。由 launchd/systemd 托管时，客户端通过用户的登录交互 shell（如 zsh/bash）启动 xiaoo，读取已配置在 shell 启动文件中的环境变量；xiaoo 继续自行读取原生密钥存储及 provider 默认变量。无需再次录入 API Key，也无需额外创建模型环境文件。请确保终端 TUI 与客户端使用同一用户；只在某个未保存的终端会话内设置的变量无法由新 shell 恢复。配置中的 TOML 行尾注释可以保留。升级后需重新安装/更新客户端及 FI 组件，再重新创建实验，旧实验冻结的错误模型标识不会自动更新。

模型按完整的 `provider/model` 标识执行；页面在模型名旁展示 provider，避免同名模型混淆。开始实验后，系统等待新 Trace 完整入库，再运行评估器。

xiaoo 实验成功但没有链路跟踪时，需区分模型鉴权和 Trace 上传鉴权：Collector 使用的是平台安装密钥，不是模型 API Key。Collector 优先读取当前安装的 `ras/config.json` 上传配置，只有该文件不存在时才兼容旧 FI 配置；显式环境覆盖必须同时提供平台密钥与地址，不能拼接不同来源的配置。可先执行 `node scripts/install-ras.js --check`，检查会校验 xiaoo Collector 运行文件、Hook 插件与 `config.toml` 挂载。更新后可在源码目录执行 `node scripts/xiaoo-trace-collector/install.js` 仅更新 xiaoo Collector，再退出并重新打开 xiaoo，让新的 Hook 命令生效。无需重配模型或修改其他 Agent。

实验 CLI 与 TUI 的无会话 ID 事件按 xiaoo 进程隔离；同一进程同时有多个活动会话时，缺失会话 ID 的事件会跳过并记录提示，不会猜测归属。旧版全局会话缓存不再使用，已串线的历史缓冲不会自动重放或修复，验证请新建实验。

正常退出 xiaoo 后，Collector 会随最终上传携带明确的 Trace 完成标记，平台据此写入会话结束时间并显示“已完成”。若旧版本上传的 Trace 已有完整回复却长期显示“执行中”，更新 Collector 后的新 Trace 会恢复；旧记录需按实际退出时间一次性校正，不会自动猜测。

#### Benchmark 实验

选择受控导入的 Benchmark 数据集后仍使用同一套四步向导，但必须生成新 Trace，不能选择已有 Trace 或开启监听。系统会按接入包声明自动绑定对应 Evaluator，并显示其名称、判分用途、运行方式和主指标；还可追加不依赖参考答案的普通评估器。

Benchmark 的 Case 列、参考契约标题、主指标和评估器文案均来自接入包 Presentation。Case 详情完整展示本次运行的所有提交物与评测证据：配置命中的文件使用友好名称和顺序，未命中的新文件仍按原名显示；文本、JSON、Diff、图片和 PDF 可直接查看，其余格式可下载。提交物上传后，执行器终态尚未送达时标记“提交物已生成，等待执行器确认…”，之后显示“Benchmark 评测中…”，不再继续显示“正在生成 Trace”。归一化评分点直接按 `label/value/total/format` 展示，不从证据内容推断业务指标。重试 Case 会重新执行完整 Agent 与评测链路；单独重评 Benchmark Evaluator 时复用该 Case 最新有效提交物。Agent 执行和 Evaluator 使用各自冻结的超时。需要部署独立 Evaluator Controller 时，参见[跑通第一次评测](./quickstart#swe-bench-等容器-benchmark-的评测服务)。

Benchmark 实验的 Case 列表按实际执行阶段显示进度：尚未轮到的 Case 显示“等待开始”，下发和 Agent 执行分别显示对应状态；执行器准备 Git 工作区时显示“正在准备 Git 工作区…”，其他工作区类型使用通用的“正在准备执行环境…”。这些状态不表示所有 Case 同时运行，也不代表 Git 拉取百分比。

### 第三步：预期答案

第 3 步用于确认每条 Case 的预期输出、数据集输入快照和评估上下文。

#### 选择已有 Trace：从数据集导入匹配

选择已有 Trace 时，点击 **从数据集导入匹配**，可以从已有数据集中选择匹配来源。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_reference_import_select.png" alt="已有 Trace 实验从数据集导入匹配，选择一个数据集作为参考答案来源" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

系统使用 Trace 的任务输入与数据集 Case 的 `input` 进行匹配：只要任务输入确定性包含数据集 `input`，就会导入对应的预期输出、数据集输入快照和 Tool/Skill 目录；多条输入同时命中时，优先选择更长、更具体的一条。已经手工标注的 Case 会被跳过，不会被导入操作覆盖。

导入后，页面顶部会统计预期输出、数据集输入快照和 Tool/Skill 目录的覆盖数量；Case 中会显示导入的预期输出及 **已标注** 状态。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_reference_import_result.png" alt="已有 Trace 与数据集匹配完成，Case 已导入参考答案并显示标注状态" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

这一条路径还可以：

- 手工填写预期输出。
- 将已经整理的预期输出和能力目录存为新数据集。

#### 生成 Trace：检查已有数据集

生成 Trace 时，数据集已经在前面的步骤选定。第 3 步不再执行输入匹配，而是展示创建实验时冻结的数据集快照，供你检查每条 Case 的任务输入、预期答案和覆盖情况。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_reference_dataset_snapshot.png" alt="生成 Trace 实验检查已选数据集快照和预期答案覆盖情况" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

这里显示的是本次实验的数据快照，不是可回写的原数据集；在实验中调整预期输出，不会修改评测数据集页面中的原始内容。

两条路径的区别是：

| Trace 来源 | 数据集的作用 | 第 3 步操作 |
| --- | --- | --- |
| 选择已有 Trace | 数据集可选，用于给已选 Trace 补充预期输出、数据集输入快照和 Tool/Skill 目录 | 选择数据集并按任务输入匹配，也可手工标注或存为数据集 |
| 生成 Trace | 数据集必选，用于提供待运行的 Case | 检查已选数据集的冻结快照和预期答案覆盖情况 |

> **Note**
> 预期输出和数据集输入都不是所有评估器的必需项。缺少相应上下文的 Case 仍可执行，但依赖它们的评估器会被禁用或不记分。

### 第四步：评估器与执行

最后一步展示本次实验的冻结摘要，并选择评估器。全局实验可以选择预置评估器和自建评估器。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_evaluator_select.png" alt="新建实验第四步，查看实验摘要并选择评估器" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

摘要区用于最终核对实验名称、Agent、数据集、Trace 来源、预期答案覆盖率以及运行主机和模型。下方每张评估器卡片会标明评估方式、评估对象和数据依赖；勾选框可用时可以多选，条件不满足的评估器不可选择。

评估器会按自身要求检查全部已选 Case：

- 引用 `{{reference_output}}` 时，全部 Case 都需要预期输出。
- 引用 `{{dataset_input}}` 时，全部 Case 都需要匹配到数据集输入快照。
- 工具类评估器需要完整的 `available_tools` / `available_skills` 目录。
- 可靠性专用评估器只适用于可靠性数据集。
- 监听模式下，依赖逐条上下文的评估器不可用。

至少选择一个可用评估器后，点击 **开始实验**。服务端确认已进入执行流程后才会跳转详情；如果启动尚未被接受，临时记录会回滚并保留向导内容，便于修正后重试。

## 查看实验详情

实验详情用于查看整个实验的运行状态和聚合结果。
点击实验详情内容区域左上方的 **返回实验列表**，可以回到实验记录列表。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_detail.png" alt="已完成实验详情，包含状态、综合均分、评估器分解、Case 明细和实验级评论" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

页面主要区域包括：

### 状态与进度

顶部显示实验状态、待评测 Agent、Case 数、评估器数、创建时间和完成/失败/待执行数量。生成 Trace 的实验还会单独显示 Trace 已生成、生成中和失败数量。

运行中的实验会自动刷新，不需要手工刷新页面。

### 整体表现

**综合均分**在全部 Case 的已选评估器都结束、实验状态变为已完成或部分完成后才显示。全部评估成功时为“已完成”，成功与失败并存时为“部分完成”，全部失败时为“失败”。最终分数只统计状态成功且有数值分数的结果：

- 评估失败不按 0 分计算，但会使实验进入“部分完成”或“失败”状态。
- 无分结果不进入分母。
- 保存人工修正后，聚合分使用人工分，机器原分仍保留展示。

### 评估器分解

每个评估器分别展示均分和计入数量。由此可以判断综合分下降来自哪个评分维度，而不是只查看一个总分。

### 同评测基线趋势

已完成、非监听的普通单组实验和 Benchmark 实验会展示最多 50 次同基线趋势。普通实验使用综合得分，Benchmark 使用接入包声明的主指标及聚合名称。

普通实验只比较数据集、Case 集与 Case 契约、Trace 来源和评估器配置都相同的记录；Benchmark 只比较 Benchmark、数据集内容版本、Case 集、Evaluator 和协议都相同的记录。Agent、模型和执行客户端可以不同。横轴按实验时间从旧到新排列，默认窗口展示最近 10 次；历史超过 10 次时可从下拉框选择最多显示最近 10、20 或 50 次，再通过底部时间窗口缩放或平移。悬停、聚焦或点击节点时，底部摘要会跟随显示该点的日期、指标、Agent、模型及相较前一次的变化；节点浮层中的“查看实验详情”和底部历史实验入口都会进入该点对应的实验。仅有当前一次时显示空状态。A/B 实验暂不展示该趋势。

### Case 明细

Case 表格并排展示输入、参考输出、实际输出、综合分、结果得分和轨迹得分。单个 Case 的结果得分会等待全部已选结果评估器结束，轨迹得分会等待全部已选轨迹评估器结束，综合分则等待该 Case 的全部已选评估器结束；未选择的结果或轨迹评估项不需要等待，对应列显示 `—`。评估失败或无分结果在全部评估结束后不进入相应分数的分母。点击 **详情** 进入单条 Trace 评测详情。

Case 行的 **重试** 由 Trace 来源决定：

- 选择已有 Trace 的实验保留当前 Trace，只重试失败评估。
- 生成 Trace 的实验会重新执行 Agent、绑定新 Trace，再运行该 Case 的全部评估器。

点击 **新增 Case** 可以从当前实验绑定 Agent 的 Trace 中追加样本，并立即使用实验既定评估器运行。若评估器依赖预期输出，可在追加时补充标注；若依赖数据集输入，新增 Case 也需要完成数据集匹配。

### 实验级评论

评论用于记录本次实验整体结论和协作意见，不影响评分。

## 查看单条 Case 详情

Trace 评测详情把输入、输出和评分依据放在同一页，适合核查一次具体判断。

<p align="center">
  <img src="../../images/agent/evaluation/eval_experiment_case_detail.png" alt="Trace 评测详情，展示任务输入、参考答案、实际输出、结果评测总分、评分点证据、人工修正和评论" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

### 输入与输出

页面顶部并排展示：

- **任务输入**：Agent 接收到的真实输入。
- **参考答案**：数据集导入或人工填写的期望结果。
- **实际输出**：本次 Trace 的最终输出。

点击 **前往链路观测** 可以查看完整执行 Trace。

### 结果评测与轨迹评测

评估器按 **结果评测** 和 **轨迹评测** 分类展示。类目标题显示类目均分与实际计入的评估器数量。

每张评估器卡片首先展示一句话结论和总分；展开后可以查看：

- 评分点名称和单项得分。
- 证据、相关步骤与改进建议。
- 未达标评分点数量。
- 单个评估器结果的重评入口。
- 人工修正和修正理由。
- 该评估结果的评论。

评估失败时显示错误原因并提供重评，不会把失败结果按 0 分纳入均分。

### 人工修正与评论

人工修正必须填写理由。保存后，实验、类目、评估器和 Case 的聚合分都会使用人工分重新计算。

评论分为三种范围：

- 实验级评论：记录整次实验的意见。
- Case 级评论：记录当前样本的整体意见。
- 评估结果级评论：针对某一个评估器判断提出意见。

评论不会改变分数。

## 典型使用方式

### 复盘线上问题

选择已有 Trace，复用真实输入、输出和执行轨迹。按需导入预期输出与数据集上下文后运行评估，适合确认问题究竟来自结果还是过程。

### 固定题库回归

选择数据集并使用生成 Trace。保持 Agent、数据集和评估器不变，在版本调整后重新创建实验，用于比较回归结果。

### 持续监听

在选择 Trace 模式中开启监听，只使用不依赖逐条参考上下文的评估器。后续新 Trace 会自动进入同一实验，适合持续观察稳定性。

## 停止并删除

实验列表和 Case 列表中，已结束的实验或 Case 显示“删除”，进行中的显示“停止并删除”。确认后，条目从默认列表移除；进行中的任务会请求终止正在执行的 Agent 和评测，排队、重试和自动追加不再启动。删除一个 Case 不会停止其他 Case。

远端主机离线或执行退出尚未确认时，页面显示“停止待确认”，平台会继续重试。若提示客户端不支持停止指令，需要在执行机更新并重启客户端；平台会在重启后重试确认。列表隐藏不等于执行器已经退出，也不会回滚 Agent 已产生的外部操作。

这是逻辑删除：源数据集、Skill 版本、共享 Trace、日志和缓存镜像保留。被删除的 Case 不计入本实验成绩；删除最后一个 Case 后，实验也会自动删除，页面返回实验列表。只评测已有 Trace 时，不会终止产生该 Trace 的原业务进程。

长期不用 Benchmark 评测服务时，可在评测机停止服务并清理受管镜像，见[部署指南](../../developer-guide/benchmark/service-deployment-guide.md#11-立即停止与镜像清理)。这与删除平台实验是两个独立操作。

## 后续阅读

- 准备和维护 Case：[评测数据集](./datasets)
- 查看评估器前置条件：[评估器](./evaluators)
- 返回总览：[评估与实验](./index)
