# AgentDebug 智能诊断：工作原理、能力边界，与「检测不到死循环」的根因分析

> 适用版本：`agent-debug-diagnosis-skill@0.1`（`AGENT_DEBUG_GENERATOR`，见 `src/lib/engine/agent-debug/runner.ts:27`）
> 撰写日期：2026-06-26
> 关联案例：jiuwenswarm 设计评审（design-review）阶段因上下文 offload 形成的 livelock 长跑十几小时，AgentDebug 将其误报为「pre-flight 低效探索」。

---

## TL;DR

- **AgentDebug 是一个「逐 step 认知错误检测 + 单点根因定位」的诊断流水线**：把每个 agent turn 拆成 Memory / Reflection / Planning / Action（+ System 外部证据）五个维度，先用确定性 Python 脚本做规则检测，再让一个「智能诊断 agent」补语义判断，最后聚合出一组关键发现（findings）和一个根因（rootCause）。
- **它擅长诊断"某一步认知出错"类问题**：记忆幻觉、假成功声明、过早完成、违反约束、参数错误、危险命令、认证失败、上下文溢出……词表里约 35 个 error type，全部是**单步认知错误**或**单步/会话级系统错误**。
- **它在设计上看不见"死循环"**，因为死循环不是"某一步错了"，而是"**整条轨迹跨很多 step 不收敛**"——一个时序/轨迹级属性。三个结构性原因：①词表里没有 loop/不终止类；②唯一的重复信号是 5 步窗口的 `redundant_call`，且本案例的循环被 offload 压缩伪装成"内容各异"而不算重复；③输出模型强制收敛成单个 criticalStep，无法表达"循环"。结果是把一个无限循环降级报成"若干次低效冗余调用"。

---

## 一、AgentDebug 现在是怎么诊断的

### 1.1 理论模型：四认知模块 + System

AgentDebug 沿用 "AgentDebug v0.4" 的认知归因思路：一个 Agent 之所以做错，可以归到它某一步的**认知模块**出了问题。每个被分析的 step 拆成五个维度：

| 维度 | 含义 | 判什么 |
| --- | --- | --- |
| **Memory** | 对历史/上下文的回忆与依赖 | 幻觉、漏召回、过度简化、引用过期文件、遗忘用户约束 |
| **Reflection** | 对上一步结果/当前进度的评价 | 误读工具结果、假成功、漏掉测试失败、过早完成 |
| **Planning** | 对下一步的计划/工具意图 | 违反约束、不可能动作、低效计划、计划与动作不一致 |
| **Action** | 真实工具调用（事实，不是判断） | 路径/参数/命令/格式错误、危险命令、冗余调用 |
| **System** | 外部环境证据（不属认知模块，但参与归因） | 认证失败、上下文溢出、环境/工具执行错误、步数限制 |

其中 Memory / Reflection / Planning 允许"留白"（没判到不算错），Action / System 必须从真实证据确定性提取。详见 `skills/agent-debug-diagnosis/references/01-input-and-extraction.md`。

### 1.2 端到端流程（工程视角）

触发入口是 `POST /api/observe/executions/[executionId]/agent-debug`（`src/app/api/observe/executions/[executionId]/agent-debug/route.ts`）。整条链路：

```text
1. 计算 interactionsHash（按 trace interactions 内容哈希）
   └─ 命中同 hash 的 done 报告 → 直接返回缓存（不重算）
2. 后台起一个 opencode agent 任务：runAgentDebugDiagnosis()
   （src/lib/engine/agent-debug/runner.ts）
3. runner:
   a. buildDebugTurns(interactions) → 归一化的 turns
   b. 写 .agent-insight/agent-debug-input.json
      = { execution, turns, traceBundle 路径 }
   c. 挂载 skill，拼 system prompt + query，spawn「智能诊断 agent」
4. 智能诊断 agent（跑 agent-debug-diagnosis skill）:
   a. 必须先跑 scripts/agentdebug_static.py  → agent-debug-static.json
   b. 读静态结果，补 Phase 1 语义判断 + Phase 2 根因归因
   c. 写 agent-debug-final.json
   d. 跑 scripts/agentdebug_validate.py 校验
   e. 返回最终 JSON
5. runner 归一化报告（stepRecords/phase1Grid/issues/findings/rootCause）并落库
```

关键点：**真正的检测逻辑全在 skill 里**（拆分规则、词表、Phase1/2、校验都归 skill 管，后端只负责挂载、喂输入、存报告，见 `SKILL.md:23`）。智能诊断 agent 本身**不直接逐条扫原始 trace**，而是**以静态脚本的输出（issue 列表 + 计数）为主事实源**再补语义。

> 缓存机制：报告以 `interactionsHash` 为 key（`route.ts:69-74`）。如果 trace 后续变化但旧报告还在、或哈希对不上，UI 会标注"可能是旧诊断结果"。这一点在后面 §2.4 会再提。

### 1.3 三个 Phase

完整定义见 `references/03-phase-analysis.md`。

- **Phase 0 — 系统风险预检（triage）**：先扫一遍有没有连续认证失败、上下文溢出、基础工具系统性不可用、任务很早被取消等"系统性风险"。注意：Phase 0 只是**提示**，命中也不跳过后续认知诊断。
- **Phase 1 — 逐 step 模块级检测**：对**每一个** stepRecord，分别判 Memory/Reflection/Planning/Action/System 有没有错。确定性部分由 `agentdebug_static.py` 跑（输出 `phase1Grid` + `issues`），LLM 只补脚本静态判不了的语义问题。**原则上要求对全部 step 分析、不做候选窗口裁剪**（`SKILL.md:78`、`references/03-phase-analysis.md:38`）。
- **Phase 2 — 根因归因**：把 Phase 1 的原子 issue 聚合成一组 `findings`。判定原则（`references/03-phase-analysis.md:122-128`）：
  - **"找最早的、修复后最可能改善轨迹质量的错误"作为某条 finding 的 `root`**；
  - **"找因不找果"**，后续级联错误作为同一 finding 的 `downstream`，不重复提升；
  - 每条 finding **恰好一个 `root`**；`rootCause` 字段是 `findings[0]` 的历史兼容投影。

### 1.4 分析单元：stepRecord ≠ trace 节点

一个 `stepRecord` = 一个归一化的 assistant/subagent/opencode 可见 turn，**不是**左侧执行链路里的每个 atomic node（`references/01-input-and-extraction.md:17`）。一个可见 turn 可能内含多个工具节点。所以 AgentDebug 眼里的"步数"比左侧 trace 节点数粗。

### 1.5 检测机制：它怎么"知道"某个模块有问题——先抽取，再判错

每个 turn 的诊断分两步：

**第一步 · 抽取（确定性脚本）——判"这一 turn 有没有触及该模块"。** Memory / Reflection / Planning 三个认知模块靠**关键词正则**命中 turn 文本（`scripts/agentdebug_static.py:29-31`）：

| 模块 | 触发词表（命中即认为该 turn 有此模块活动） |
| --- | --- |
| Memory | `之前 / 刚才 / 上一步 / 已经 / 根据…输出\|结果 / previously / already` |
| Reflection | `失败 / 错误 / 通过 / 成功 / 没有找到 / failed / success / passed` |
| Planning | `接下来 / 下一步 / 我会 / 然后 / 计划 / 需要 / let me / next / I will` |

命中 → 抽出那几句（`source=implicit`，置信 0.72）；不命中 → 留白。Action 从真实 tool call 确定性提取（`raw_tool`，0.95）；System 从事实信号提取（`status=error`、shell 输出命中 `FAILURE_RE`、单步耗时 >60s → `step_timeout`）。

**第二步 · 判错——"有内容"≠"有错"，分两条路：**

- **Action / System**：脚本里的**硬规则**直接判 errorType + severity（`redundant_call`、`tool_execution_error`、`no_explicit_plan`、`auth_failure`、`context_overflow`……），确定性、高置信。
- **Memory / Reflection / Planning**：脚本判不了"内容对不对"（需与 prior facts / 上一步结果 / 任务约束比对），交给 **LLM 智能诊断 agent**：它拿抽出的模块文本 + 该 step 上下文，**把错误词表当 checklist 逐条比对**（这条记忆引用的东西真出现过吗？这条反思在工具失败时却声称成功了吗？），命中即标 errorType，置信 0.5–0.75。

> **对循环的影响**：判错永远是"**就这一 turn 论这一 turn**"。它从不做跨 turn 比对——"这条反思 / 计划跟前面 N 条是不是同一个、是否在原地打转"不在判断逻辑里。这是它对循环视而不见的认知层根因（与 §2.1–2.3 互为表里）。

### 1.6 它能诊断出什么（完整错误词表）

词表见 `references/02-error-taxonomy.md`，共五类约 35 个 error type（节选）：

| 类别 | 代表 error type | 严重度 |
| --- | --- | --- |
| Memory | `hallucination`、`memory_retrieval_failure`、`over_simplification`、`hallucinated_file_content`、`forgot_user_constraint` | 多为 high |
| Reflection | `progress_misjudge`、`outcome_misinterpretation`、`false_success_claim`、`missed_test_failure`、`premature_completion`、`ignored_warning` | 多为 high |
| Planning | `constraint_ignorance`、`impossible_action`、`inefficient_plan`、`wrong_file_target`、`no_explicit_plan`、`plan_action_mismatch`、`unsafe_destructive_action` | 中-高 |
| Action | `invalid_action`、`parameter_error`、`nonexistent_path`、`wrong_diff_anchor`、`dangerous_command`、**`redundant_call`**、`tool_misuse` | 多为中，`redundant_call` 为 low |
| System | `step_limit`、`tool_execution_error`、`llm_limit`、`environment_error`、`context_overflow`、`user_aborted`、`auth_failure`、`step_timeout` | 中-高 |

**一句话概括它的能力边界**：它能精准定位"**哪一步的哪个认知模块犯了哪类错**"，并把级联症状串成因果链。这对"单点失败"类问题（拿错文件、误判工具结果、违反约束、装危险命令、认证挂了）非常有效。

---

## 二、为什么诊断不出"循环"问题

### 2.0 案例背景

被诊断的 trace 是一次 jiuwenswarm `aet-engineering-team-swarm` 运行：design-reviewer 子 Agent 需要读完整的《功能设计说明书》才能出评审结论，但框架（openjiuwen `MessageSummaryOffloader`）把超过阈值的大 tool 结果**压成摘要并 offload 到磁盘**；reviewer 拿到摘要后判定"内容被截断、我要全文" → 重新读文件 → 又被 offload → leader 催促 → 再重读……如此空转十几小时，step-4 始终不 `update_task` 完成，下游永久 blocked。

我们对这条 trace 跑 AgentDebug，结果是：

> `rootCause: planning/inefficient_plan`，位于左侧节点 #68 ——「团队领导在 pre-flight 阶段缺乏显式探索计划，约 27 步低效探索后才进入 AET 流水线」。

**完全没提到后段那个真正的死循环。** 下面拆解为什么。

### 2.1 根因一：词表里根本没有"循环 / 不终止"这一类

对整个 skill 的 references 全文检索 `loop / cycle / repeat / 死循环 / 卡住 / 不终止`，**只命中一条**——Action 类的 `redundant_call`。也就是说：

- 词表的 35 个 error type 全是**单步认知错误**（某一步记忆/反思/计划/动作错）或**单步/会话级系统错误**（撞步数限、单步超时、上下文溢出……）。
- **没有任何一个标签**用来表达"Agent 在无限重复、任务永不终止"。

System 里虽有 `step_limit`（撞步数硬限）和 `step_timeout`（单步超时），但 livelock 是**软性空转**：每一步都"正常"完成、没撞任何硬限，只是整体不收敛——这两个标签都不会触发。

**结论：即使 AgentDebug 完美覆盖全 trace，它的词表里也没有一个格子能装下"死循环"。** 它只能把循环里的每一步分别判成某种单步小问题。

### 2.2 根因二：唯一的重复信号是局部的，而且这个循环被 offload 伪装掉了

最接近"循环检测"的是 `redundant_call`，定义是（`references/02-error-taxonomy.md:56`、`scripts/agentdebug_static.py:325`）：

> **"短窗口内（五步窗口）同样工具、同样参数，反复调用三次及以上"**，严重度 **low**。

它对本案例的循环双重失效：

1. **窗口太小、周期太长**：设计评审的循环周期跨几十步，中间夹着 leader 催促、reasoning、子任务消息。"5 步窗口内同一工具≥3 次"根本覆盖不到这种长周期宏观重复。
2. **重复被压缩伪装成"内容各异"**：循环里反复发生的是"读设计文档 → 被 offloader 压缩"。而 offloader 每次产出的是一条 `{"compression_strategy": "...", "summary": "..."}`，**内容各不相同**（摘要措辞每次都不一样）。于是连"同样工具同样参数"都不成立——`redundant_call` 不会把它们识别为重复。

**结论：制造循环的 offload 机制，恰好也把循环的"重复特征"抹掉了**；唯一的重复检测器对它视而不见。

### 2.3 根因三：single-root + earliest-error 的输出模型，表达不了"循环"

Phase 2 的归因模型是"**一个 root + 级联 downstream**"，并且明确**优先取最早的错误**作为 root（`references/03-phase-analysis.md:124`）。这套模型回答的是"**哪一步决策错了**"，而不是"**整条轨迹为什么不收敛**"。

于是发生了两件事：

1. 循环里成百上千步的小问题，被**聚合成计数**喂给诊断 agent。这次它看到的就是"55 个冗余调用、29 个工具错、13 个无计划"这种**统计量**。
2. 按"取最早错误"原则，它挑了 trace **最前面**那个显眼的问题——pre-flight 的 27 步探索——定为 root（节点 #68）。后段真正的循环则被平均进了"55 个冗余调用"这个数字里，**既没被识别为循环，定位还落在了错误的位置**。

**结论：把"无限循环"这样一个分布式、时序性的现象，硬塞进"单个 criticalStep + 因果链"的模子里，必然丢失"循环"本身——只剩下一堆被打散的低严重度 issue。**

### 2.4 叠加因素：覆盖范围与缓存时效

`SKILL.md:78` 明确**禁止候选窗口、要求对全部 step 检测**——所以盲区不是抽样砍出来的，是上面 §2.1–2.3 的结构性问题。但实践中还有两个放大器：

- **实际只分析了早段**：这次静态输出报的 stepCount 只有约 44，而全 trace 有约 470 个节点；真正的循环在轨迹后段，可能压根没进入被分析的输入。
- **缓存按 `interactionsHash` 命中**（`route.ts:69-74`）：如果诊断是在 trace 早期快照上跑出来后被缓存、之后没按完整 trace 重算，UI 上会看到"哈希不一致、可能是旧诊断结果"的提示——也就是说看到的根因可能来自一个**还没出现循环的早期版本**。

这两条是次要因素，但叠在结构盲区上，等于双保险地看不到循环。它们也和另一个已知问题同源：**诊断质量的上限受限于摄入数据的完整度**（参见 jiuwen trace 因内存 spool + 整条覆盖在长跑中丢失前半段数据的问题）。

### 2.5 现在喂给 AgentDebug 的数据：一份被层层截断的 digest

即使不算摄入侧丢数据（如 jiuwen 内存 spool 在长跑中丢失前半段），**AgentDebug 自己在构造输入时就把 trace 截断 / 摘要了好几层**。它实际拿到三份东西：

1. **`agent-debug-input.json`**（静态脚本读这个）：`{ execution{id,taskId,framework,query}, turns: 全部 turn, traceBundle 路径 }`（`runner.ts:289`）。turn **条数不截**（无数量上限），但每个 turn 字段已被 `buildDebugTurns` 截短。
2. **LLM prompt**（`buildAgentQuery`，智能诊断 agent 真正"读"的）：执行记录摘要（≤8000 字符）+ **「归一化 Step 摘要」= `compactJson(全部 turn.map(turnToPromptRecord), 40000)`**（`runner.ts:261`）+ 指向资料包的指针。
3. **Trace 资料包**：完整 trace 以 manifest/index/nodes/artifacts 落盘，但 prompt 明确叫 agent"证据不足时再点读 nodes"，不要整包读（`runner.ts:254`）。

截断层级（全部 AgentDebug 自己做的）：

| 位置 | 截断 |
| --- | --- |
| `turnToPromptRecord`（`runner.ts:321-328`） | inputContext→1000、text→1800、reasoningText→1800、每个 tool args→1200、output→1200 字符 |
| 「归一化 Step 摘要」整体（`runner.ts:261`） | 全部 turn 压到 **40000 字符**；约 470 turn 的 trace ≈ 每 turn 仅剩 ~85 字符 |
| 静态脚本侧 | action output→900、system 信号→600、environmentResponse→1600 |

谁看到什么：

- **静态脚本**：拿到全部 turn（数量全），但每个 turn 字段被截短——能逐 turn 走完全程，看不全单 turn 内容。
- **LLM 主推理**：只是一份 40k 的 digest；长 trace 大部分内容进不了上下文，且**体量大又重复的内容（offload 摘要、重读的文档）最先被截掉**。
- **完整原文**：只在磁盘资料包里，按需点读，不进主推理。

这对查循环是致命的：循环的特征就是"同一段大内容反复出现很多遍"，而 digest 恰好把"反复出现的大段内容"压成几行——LLM 根本看不到"它重复了 37 遍"。**注意：这套截断对"单步认知诊断"是合理取舍（省 token、看局部够用），它只是和"需要全局重复模式"的循环检测天然冲突。**

### 2.6 本质：逐-step 认知诊断 vs 轨迹级时序属性

一句话收口：

> **死循环是一个轨迹级（temporal）属性**——"在 N 步范围内，Agent 反复回到同一状态、且没有净进展走向终止"。检测它需要：跨很多步看、有"状态/进展"的概念来判断"是否原地踏步"。
>
> 而 **AgentDebug 的整套架构是"逐 step 认知错误检测 + 单点根因定位"**：每一步孤立判错，再定位一个最早的关键步。这套范式和"轨迹是否收敛"是**正交**的。所以它不是"没分析到"循环，而是**它的视角里没有"循环"这个维度**。

---

## 三、改造方向与采纳的方案

### 3.1 四个原始改造方向（保留）

最初分析给出四条改造方向：

1. **新增轨迹级 loop / non-termination 检测器**（独立于逐-step 词表）：对动作/状态做指纹，检测"长周期重复 + 无净进展"。信号示例：同一文件 / 同一 step-id 反复读取；input token 单调上涨但 step-id / 任务状态不前进；连续 N 步任务完成数无变化；同一 offload 主题反复出现。命中后给一个 `non_termination` / `livelock` 类（high）。
2. **升级 `redundant_call`**：跨长窗口 + **语义等价**（不要求 params 完全相同，对工具 + 目标归一），超阈值时升级严重度并标 non-termination，而不是永远 low。
3. **输出模型允许 trajectory / systemic finding**：不强制把一切压成单个 criticalStep；允许一条 finding 描述"整条轨迹级别的循环"。
4. **保证喂进去的 trace 完整、未压缩 / 未截断**。

### 3.2 一个纠正：第 4 点被误读了——"完整性"只对 LLM 昂贵

死循环的**信号**藏在**结构化元数据**里（同一 `tool+args` 反复出现、`step-id` / 任务状态不前进、`inputTokens` 单调涨、时间戳大间隔），**不在被截断的大段正文里**。所以：

> **"完整 trace"只在喂给 LLM 时才昂贵；一个确定性检测器直接读原始 interactions，token 成本约等于零。**

于是第 4 点不是"把全 trace 灌进模型上下文"，而是"让检测器看到完整的元数据骨架"——这部分本就基本完整、且不过 LLM。第 4 点的成本担忧因此消失。

### 3.3 采纳的方案：独立的「轨迹诊断器」，结果并入 AgentDebug 窗口

> **✅ 已采纳。** 不改 AgentDebug 的逐-step 逻辑；新增一个独立的确定性「轨迹诊断器」（trajectory diagnoser），与 AgentDebug 并行运行，产出 `kind=trajectory` 的 finding，并入同一份报告 / 同一个 UI 窗口。这是干净落地第 1+3 点的方式，并天然规避第 4 点成本（第 2 点被第 1 点吸收）。

理由：

- **别扭曲 AgentDebug 的单点模型**——硬把循环塞进"模块 + criticalStep"正是 §2.3 的误诊根因。
- **关注点分离**：AgentDebug 管"单步认知错误"，轨迹诊断器管"跨区间的循环 / 无进展 / 震荡 / 成本失控"。
- **侵入性小**：不动静态脚本逐 turn 逻辑、不动 skill prompt，只加一个并行 pass + 一个新 finding 类型 + 一个 UI 卡片。
- **确定性代码可直接读原始未截断 interactions，零 LLM 成本**。

架构：

```text
原始 interactions（完整、未截断）
   ├─ AgentDebug 现有链路（逐 turn 认知诊断，5 模块）──┐
   │                                                   ├─► findings[]（同一份报告 / 同一个窗口）
   └─ 轨迹诊断器（新增，确定性）                        │
        1) 确定性检测：定位循环 span + 周期数 + 无进展度量
        2)（可选）小 LLM 只读该 span 的代表性节点，写"故障机制 / 故障链"叙事
        3) 产出一条 kind=trajectory 的 finding ────────┘
```

省钱点：LLM 只在检测器已定位 span 之后、只读那几个代表性节点（按需取未截断原文）写叙事，不喂全 trace。

### 3.4 展示形式：5 模块装不下循环，共享"证据锚点"，形态是"故障机制 / 故障链"

不套 5 模块网格（循环不是"某模块在第 N 步错了"），但共享"锚定真实 trace 节点的证据"。两种 finding 同处一个 `findings[]`，UI 按 `kind` 渲染不同卡片：

| | 认知 finding（现有） | 轨迹 finding（新增） |
| --- | --- | --- |
| 定位 | 单个 criticalStep + 模块 + 线性 cascadingChain | span(fromNode→toNode) + cycleCount + 无进展度量 |
| 表现 | 5 模块网格 | 故障机制详解 + 故障链 + 代表性证据节点 |
| 共享 | summary、evidence（节点锚点）、correctionGuidance、confidence | 同左 |

### 3.5 落地步骤

1. 新增确定性检测模块（读原始 interactions，零 LLM 成本）→ 输出循环 / 无进展 span + 周期数 + 无进展度量。
2.（可选）小 LLM 仅就该 span 写故障机制 / 故障链叙事。
3. 以 `kind=trajectory` 并入现有报告 `findings[]`。
4. UI 加一种轨迹卡片（证据 + 故障机制 + 故障链），认知 finding 渲染不变。
5. 全程不碰逐 turn 链路、不碰 40k digest、不做"全 trace 喂模型"。

---

## 附录：关键文件索引

| 作用 | 路径 |
| --- | --- |
| 触发入口（API route） | `src/app/api/observe/executions/[executionId]/agent-debug/route.ts` |
| 流水线编排（runner） | `src/lib/engine/agent-debug/runner.ts` |
| turn 构造与字段截断 | `src/lib/engine/agent-debug/trace-adapter.ts` |
| prompt digest 与字段截断 | `src/lib/engine/agent-debug/runner.ts:261, 321-328` |
| 模块抽取关键词正则 | `skills/agent-debug-diagnosis/scripts/agentdebug_static.py:29-44` |
| Skill 说明与硬规则 | `skills/agent-debug-diagnosis/SKILL.md` |
| 输入协议与四模块拆分 | `skills/agent-debug-diagnosis/references/01-input-and-extraction.md` |
| 错误词表（35 个 error type） | `skills/agent-debug-diagnosis/references/02-error-taxonomy.md` |
| Phase 0/1/2 流程 | `skills/agent-debug-diagnosis/references/03-phase-analysis.md` |
| 输出 schema | `skills/agent-debug-diagnosis/references/04-output-schema.md` |
| 确定性静态检测脚本 | `skills/agent-debug-diagnosis/scripts/agentdebug_static.py` |
| 报告校验脚本 | `skills/agent-debug-diagnosis/scripts/agentdebug_validate.py` |
| `redundant_call` 检测实现 | `skills/agent-debug-diagnosis/scripts/agentdebug_static.py:325` |
