# Agent Insight 名词解释手册

> **唯一事实来源**。面向产品用户的术语定义同步给前端 `Term` 组件使用。
>
> - **产品侧**：浏览本文档了解全产品术语含义。
> - **前端侧**：所有 `<Term id="..." />` 调用从这里取 ID；运行时索引落在 [`src/lib/glossary.ts`](../src/lib/glossary.ts)，**新增/修改条目必须同时改两个文件**。
> - **设计规范**：术语提示组件契约见 [`docs/design/components.md` §E.14](./design/components.md)，挂载场景见 [`docs/design/patterns.md` §L.7](./design/patterns.md)。
>
> ID 命名规则：kebab-case，语义优先于直译，全文件唯一。

---

## 0. 开发者：怎么添加一个新术语

1. 在本文档对应章节加一行：`| <id> | <名词> | <一句话解释> |`。
2. 同步更新 [`src/lib/glossary.ts`](../src/lib/glossary.ts)：
   ```ts
   '<id>': {
     name: '<名词>',
     tag: 'metric' | 'trace' | 'tool' | 'skill' | 'fault' | 'eval',
     body: '<一句话解释>',
     formula: '<可选公式>',
   }
   ```
3. 在页面使用：`<Term id="<id>" />`，或 `<Term id="<id>" render="compact" />` 只显示 i 角标。
4. 不在词典里的临时术语用 `<TermPopover term="..." body="..." />` 直接传内容。

**tag 分类**（决定 popover 顶部小标签配色，见 [`components.md` §E.14.4](./design/components.md)）：

| tag | 用于 | 视觉 |
| --- | --- | --- |
| `metric` | 指标、计数、配置项 | 灰底灰字 |
| `trace` | 链路、Span、执行结构 | 灰底灰字 |
| `tool` | 工具、模型、外部能力 | 灰底灰字 |
| `skill` | Skill 相关概念 | 紫底紫字（全产品仅 AI/Skill 可用紫色） |
| `fault` | 故障、错误、异常 | 红底红字 |
| `eval` | 评测、评估、数据集 | 绿底绿字 |

---

## 1. 概览（Overview）

| ID | 名词 | 解释 |
| --- | --- | --- |
| `agent` | Agent | 接入到本平台的智能体实例，对应一个真实运行的对外服务进程。 |
| `user-agent` | 用户 Agent | 通过客户端接入本平台的 Agent 实例，由用户/团队自行注册和维护。 |
| `system-agent` | 系统 Agent | 平台内置的 Agent，用于支撑平台自身功能（如智能诊断）。 |
| `unregistered-agent` | 未注册 Agent | 已上报过数据、但尚未在"Agent 管理"中正式登记的 Agent。 |
| `agent-ownership` | Agent 归属 | 标识 Agent 的来源，取值为：用户 Agent、系统 Agent、未注册 Agent。 |
| `main-agent` | 主 Agent | 直接接收用户请求的入口 Agent，执行过程中可派生子 Agent。 |
| `platform` | 平台 | Agent 运行所基于的底层框架/Runtime（如 `opencode`）。一个 Agent 只能属于一个平台。 |
| `p95-latency` | P95 时延 | 所有请求按耗时排序后第 95 百分位的耗时，反映长尾体验。 |
| `agent-status` | Agent 状态 | `运行中` / `异常` / `空闲` 三态，由心跳与最近一次执行结果共同判定。 |

---

## 2. Agent 管理

| ID | 名词 | 解释 |
| --- | --- | --- |
| `connected-agent` | 接入 Agent | 已通过 SDK 或配置完成对接、可向平台上报 Trace 的 Agent。 |
| `agent-type` | Agent 类型 | 区分 `主 Agent`（入口）与 `子 Agent`（由主 Agent 派生执行子任务）。 |
| `custom` | Custom | Agent 的来源类型，表示自定义实现，与"模板"或"预置"相对。 |
| `trace-link` | 链路跟踪 | 跳转到该 Agent 最近若干次执行的全链路 Trace 视图。 |
| `smart-diagnosis` | 智能诊断 | 对该 Agent 最近一次失败/异常调用进行 AI 归因分析。 |

---

## 3. 运行观测 · 链路追踪

| ID | 名词 | 解释 |
| --- | --- | --- |
| `trace` | Trace | 一次完整任务执行从入口到结束的全部调用记录，由若干 Span 组成。 |
| `span` | Span | Trace 中的单个执行片段，可代表一次 LLM 调用、工具调用或子 Agent 派生。 |
| `tool-error-rate` | 工具错误率 | 工具调用失败次数占总工具调用次数的比例。 |
| `main-agent-only` | 仅主 Agent | 筛选项，只展示由主 Agent 发起的根 Trace，过滤子 Agent 派生记录。 |
| `multi-agent` | Multi-Agent | 标签，表示该 Trace 中存在多个 Agent 协同（含主-子派生）。 |
| `task-spawns` | TASK SPAWNS | 一次 Trace 中派生子任务/子 Agent 的次数。 |
| `tool-calls` | TOOL CALLS | 一次 Trace 中工具调用的次数。 |
| `skill-calls` | SKILL CALLS | 一次 Trace 中命中并调用 Skill 的次数。 |
| `llm-turns` | LLM TURNS | 一次 Trace 中与底层模型的对话轮次。 |
| `tokens` | Tokens | 模型消耗的 Token 总量，分 `INPUT` / `OUTPUT` / `CACHE READ`。 |
| `cache-read` | CACHE READ | 命中提示词缓存而被复用的 Token 数，计费远低于普通 Input。 |
| `depth` | depth | 当前节点在 Trace 树中的层级深度，0 为根节点。 |
| `fault-diagnosis` | 故障诊断 | 对当前 Trace 触发 AI 归因分析，跳转到智能诊断页面。 |

---

## 4. 运行观测 · 智能诊断

| ID | 名词 | 解释 |
| --- | --- | --- |
| `execution-session` | Execution Session | 一次完整的执行会话，对应一次 Trace。 |
| `insight-ai` | Insight AI / FAULT-DIAGNOSIS-AGENT | 平台内置的诊断 Agent，读取 Trace 上下文并产出归因结论。 |
| `fault-item` | 故障条目 | 诊断 Agent 在一次执行中识别出的独立问题，可并存多个。 |
| `fault-raw-error` | 原始错误类故障 | 系统/工具直接抛出的硬错误，如 `Timeout`、`5xx`、`权限拒绝`。 |
| `fault-effect-divergence` | 效果偏差类故障 | 未抛错但产出与预期不符的软故障，如答非所问、关键信息遗漏。 |
| `fault-mark` | 故障标记 | 故障的机读类型，如 `TIMEOUT`、`RATE_LIMIT`、`OUTPUT_MISMATCH`。 |
| `chain-status` | 链路状态 | 当前 Trace 的最终状态，如 `CHAIN_ERROR · L13` 表示第 13 个节点处出错。 |
| `node-summary` | 节点摘要 | 故障所在 Span 的简短描述（如"LLM Provider"）。 |
| `match-evidence` | 匹配依据 | 诊断 Agent 得出结论时引用的证据来源（节点 ID、字段、上下文）。 |
| `cite-node` | 引用节点 | 追问 Agent 时可通过 `@` 引用具体 Span，让诊断聚焦在该节点上。 |

---

## 5. 评测中心 · 评测数据集

| ID | 名词 | 解释 |
| --- | --- | --- |
| `dataset` | 评测集（Dataset） | 一组带标准答案的测试样本，用于离线评估 Agent 或 Skill 的质量。 |
| `dataset-input` | input | 评测样本的输入字段，对应用户提问或上游入参。 |
| `reference-output` | reference_output | 评测样本的标准答案（Ground Truth），用于和 Agent 实际输出做对照。 |
| `pending-sync` | 待同步 | 数据集已修改但尚未推送到执行端。 |
| `latest-pass-rate` | 最新通过率 | 该评测集最近一次执行时的通过样本占比。 |

---

## 6. 评测中心 · 评估器

| ID | 名词 | 解释 |
| --- | --- | --- |
| `evaluator` | 评估器（Evaluator） | 给实际输出打分的判定器，可以是规则、脚本或 LLM。 |
| `evaluator-custom` | 自建评估器 | 用户自定义的评估器，需自行配置评分逻辑。 |
| `evaluator-preset` | 预置评估器 | 平台内置、开箱即用的评估器（如"Agent 任务完成度"）。 |
| `llm-judge` | LLM Judge | 由大模型担任的评估器，按设定的标尺对输出评分。 |
| `score-range` | 评分 0–1 | 单项打分取值范围，1 为满分，0 为完全未达预期。 |
| `eval-dimension` | 评估维度标签 | 评估器关注的维度，如 `结果` / `任务完成` / `内容质量` / `Agent 通用评测`，一个评估器可同时打多个维度。 |

---

## 7. 评测中心 · 评测执行

| ID | 名词 | 解释 |
| --- | --- | --- |
| `eval-batch` | 评测批次 | 一次完整评测任务的执行实例，包含若干 Trace 样本。 |
| `eval-agent` | 执行 Agent | 本次评测中被测试的 Agent。 |
| `auto-observe` | 自动观测 | 开启后该批次评测结果将纳入 Skill 综合健康分。 |
| `result-eval` | 结果评测 | 仅对最终输出与 Ground Truth 做对比的评测维度。 |
| `trajectory-eval` | 轨迹评测 | 对中间步骤（如调用顺序、是否调用某工具）做评测的维度。 |
| `custom-eval` | 自定义评测 | 用户自定义评估器对该次执行的额外评分通道。 |
| `eval-conclusion` | 综合评测结论 | 多维度评分加权后的最终结论与建议。 |

---

## 8. Skills 能力 · Skill 管理

| ID | 名词 | 解释 |
| --- | --- | --- |
| `skill` | Skill | 可被 Agent 加载并按需调用的能力包，由一份 `SKILL.md` 主文档加若干脚本/参考资料组成。 |
| `skill-activated-unused` | 已激活待引用 | Skill 已激活但暂无 Agent 引用，处于"上架但闲置"状态。 |
| `skill-progress` | 流程进度 | Skill 在"生成 → 分析 → 优化"三段生命周期中的位置（如 `2/3` 表示已完成前两步）。 |
| `skill-to-optimize` | 待优化 | 已分析出问题、等待进入"优化"环节的 Skill 数。 |
| `skill-version` | 版本（v0、v1…） | Skill 的不可变快照，当前激活的版本会被 Agent 实际加载。 |
| `skill-lifecycle` | SKILL 生命周期 | 三阶段流水：①生成（产出 SKILL.md 与脚本）→ ②分析（评估质量）→ ③优化（按分析结果迭代）。 |
| `expected-chain` | 预期执行链路 | Skill 被调用时按 SKILL.md 解析出的步骤序列，用于"声明 vs 实际"的对照。 |

---

## 9. Skills 能力 · Skill 生成

| ID | 名词 | 解释 |
| --- | --- | --- |
| `skill-generation` | Skill 生成 | 通过对话与模型协作，自动产出 SKILL.md 与配套 scripts/references 目录。 |
| `skill-md` | 主文档（SKILL.md） | Skill 的入口说明书，包含触发条件、核心指令、参数约束等，模型据此决定何时及如何调用。 |
| `skill-scripts` | scripts/ | Skill 附带的可执行脚本目录，运行时由 Agent 调用。 |
| `skill-references` | references/ | Skill 的参考资料目录，作为模型上下文，本身不可执行。 |
| `scenario-template` | 场景模板 | 生成时的目标场景类型，影响 SKILL.md 的结构与措辞。 |
| `risk-zones` | 安全区 / 交互区 / 禁止区 | Skill 内部约定的操作风险分层：可自动执行 / 需用户确认 / 绝不执行。 |
| `web-search` | 联网搜索 | 生成过程中是否允许模型实时检索外部资料。 |

---

## 10. Skills 能力 · Skill 分析

### 10.1 分析主页

| ID | 名词 | 解释 |
| --- | --- | --- |
| `health-score` | 综合健康分 · 置信加权 | Skill 当前总分。各维度按权重加权，未跑完的维度不计入分母，故称"置信加权"。 |
| `eval-coverage` | 评估覆盖度 | 4 个评估维度中已完成评测的占比（如 `0/4 维 · 0%`）。 |
| `one-line-diagnosis` | 一句话诊断 | 系统对当前评测状态总结出的结论与建议。 |
| `basic-diagnosis` | 基础诊断 | 仅依据当前已有数据的浅层诊断，覆盖度低时也能给出。 |
| `smart-run` | SMART RUN | 一键跑齐缺失维度的批量执行入口，自动调度未跑的评测项。 |
| `pending-dimensions` | 待跑维度 | 状态为"未配置"或"待分析"、尚未产出分数的评估维度。 |
| `four-dim-eval` | 4 维评估能力 | 当前对 Skill 的四个评估视角：A/B 测试、用例分析、触发分析、静态合规。 |
| `dim-status` | 待分析 / 待扫描 / 未配置 | 维度状态：数据已就绪等待跑分 / 等待静态扫描 / 尚未配置数据集或参数。 |
| `weight-excluded` | 不计入总分（-40%） | 某维度未完成时，其权重从分母中剔除，标注中给出被剔除的权重大小。 |

### 10.2 A/B 测试维度

| ID | 名词 | 解释 |
| --- | --- | --- |
| `ab-test` | A/B 测试 | 同一份输入分别在"开启 Skill"与"不开启 Skill"两个 Agent 版本下执行，对比效果差异。 |
| `control-version` | 对照版本（A） | 不挂载该 Skill 的基线 Agent。 |
| `experiment-version` | 实验版本（B） | 挂载了该 Skill 的 Agent。 |
| `repeat-rounds` | 重复轮次 | 同一样本重复执行的次数，用于计算方差、消除随机性。 |
| `auto-eval` | 自动评测 | 跑完后自动调用评估器返回准确率与"Skill 是否生效"的判断。 |
| `log-skill-trigger` | 记录 Skill 触发详情 | 保留每条样本下 Skill 的命中/未命中明细，便于事后定位。 |
| `eval-source` | 从数据集发起 / 从执行链路发起 | 输入来源：复用既有评测集，或直接选取线上 Trace 作为输入。 |

### 10.3 用例分析维度

| ID | 名词 | 解释 |
| --- | --- | --- |
| `case-analysis` | 用例分析 | 基于已评测 Trace 的"结果 + 轨迹"双维度回看，定位 Skill 在真实流量中的得失。 |
| `result-analysis` | 结果分析 | 仅看最终答案是否达成用户目标。 |
| `trajectory-analysis` | 轨迹分析 | 看中间过程是否按 SKILL.md 期望的步骤进行。 |
| `case-set` | 用例集 | 当前 Skill 版本关联的 Trace 集合，可勾选送入"触发分析"。 |
| `high-divergence` | 高偏离 | 实际输出与参考答案差异较大的样本筛选标签。 |

### 10.4 触发分析维度

| ID | 名词 | 解释 |
| --- | --- | --- |
| `trigger-analysis` | 触发分析 | 评估 Skill 路由是否准确——哪些 query 应命中本 Skill、哪些不应。 |
| `trigger-eval-set` | 触发评价集 | 专用于触发分析的数据集，每条样本带有"是否应触发"的标注。 |
| `trigger-hit-rate` | 触发集命中率 | "应触发且确实触发"的样本占比，越高越好。 |
| `false-trigger-rate` | 误触发率 | "不应触发却触发"的样本占比，越低越好。 |
| `edge-case` | 边界用例 | 处在触发/不触发边界、最容易判错的样本。 |
| `ai-draft` | AI 起草 | 让模型基于现有 Skill 描述自动生成一份触发评价集草稿。 |
| `opencode-live` | opencode-live | 当前触发分析所使用的线上路由通道名称。 |

### 10.5 静态合规维度

| ID | 名词 | 解释 |
| --- | --- | --- |
| `static-compliance` | 静态合规分析 | 基于规则的 SKILL.md 文本扫描，不需要实际执行 Skill。 |
| `purpose-fit` | 目的适配性 | Skill 是否有清晰的单一目的，便于 LLM 准确识别调用时机。 |
| `structure-norm` | 结构规范性 | SKILL.md 的元数据规范、内容组织和信息密度。 |
| `instruction-fit` | 指令适配性 | 指令自由度与任务风险等级、确定性是否匹配。 |
| `content-consistency` | 内容一致性 | 术语和表达风格是否前后一致，是否依赖隐含的时效性假设。 |
| `ops-reliability` | 运维可靠性 | 安全边界、灾难恢复路径与可观测性。 |
| `script-quality` | 脚本及参考文档质量 | 配套脚本与参考资料的独立性、健壮性与自愈能力。 |

---

## 11. Skills 能力 · Skill 优化

| ID | 名词 | 解释 |
| --- | --- | --- |
| `skill-optimization` | Skill 优化 | 基于分析结果，对 SKILL.md 与配套脚本/参考资料进行版本迭代。 |
| `current-version` | 当前版本（v0 当前） | 正在被引用的激活版本，作为优化的基线。 |

---

## 12. 配置

| ID | 名词 | 解释 |
| --- | --- | --- |
| `model-registry` | 模型注册 | 录入外部模型（如 DeepSeek、OpenAI 等）的密钥与 endpoint，供 Agent / 评估器调用。 |
| `web-search` | 联网搜索 | 平台级开关（与 §9 同 ID 共用一条解释），控制 Agent / Skill 是否可在执行过程中调用外部搜索。 |
| `install-guide` | 安装指导 | 现有 Agent 接入本平台的 SDK 与配置文档入口。 |

---

## 附：常见缩写

| 缩写 | 全称 / 含义 |
| --- | --- |
| LLM | Large Language Model，大语言模型。 |
| Trace / Span | 链路追踪术语：一次完整执行 / 其中一个片段。 |
| P95 | 95 分位延迟，性能指标。 |
| GT | Ground Truth，标准答案。 |
| MCP | Model Context Protocol，模型与外部工具/服务的通信协议。 |
