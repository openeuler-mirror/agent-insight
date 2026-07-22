# AgentDebug 统一诊断 Skill 与可插拔专项诊断器设计方案

> 状态：方案对齐稿
> 日期：2026-07-21
> 范围：AgentDebug 一键诊断、现有诊断追问、定向查因、专项诊断器扩展
> 核心目标：将三种诊断路径统一到一个大 Skill 内，并让新增、修改、下线专项诊断器只涉及 Skill 内部资产，不再修改服务端专项代码或前端专项组件。

## 一、已对齐的产品定义

系统只保留一个统一诊断 Skill，继续使用现有名称 `agent-debug-diagnosis`。该 Skill 内部支持三条路线：

1. **一键诊断**：运行现有 AgentDebug 五模块完整流程，同时运行全部适用的专项诊断器；专项结果经过通用富化后交回 AgentDebug 做最终语义查重和关联。
2. **普通追问**：沿用现有诊断追问流程，读取已有报告、Trace 和历史对话后回答，不运行五模块，也不运行专项诊断器。
3. **定向查因**：在普通追问基础上识别用户描述的故障现象，调用 Skill 内匹配的专项诊断器；不运行 AgentDebug 五模块，再由现有追问 Agent 基于专项结果回答。

“全面诊断”不是第四条路线，全面诊断就是一键诊断。

专项诊断器的故障知识、触发条件、判断规则、脚本和示例全部放在统一 Skill 内。服务端不包含循环、工具错误、忽略输入等具体故障场景逻辑。

## 二、核心原则

### 2.1 一个 Skill，三条路线

```text
agent-debug-diagnosis
│
├─ 一键诊断
│  ├─ AgentDebug 五模块完整诊断
│  ├─ 全部适用的专项诊断器
│  ├─ 通用富化
│  └─ AgentDebug 最终查重、关联和报告输出
│
├─ 普通追问
│  └─ 现有 Prompt + 已有报告 + Trace + 历史对话
│
└─ 定向查因
   ├─ 识别故障现象
   ├─ 选择匹配的专项诊断器
   ├─ 运行专项诊断器
   ├─ 通用富化
   └─ 现有追问 Agent 组织回答
```

### 2.2 专项能力归 Skill，平台保持通用

平台只提供通用能力：

- 挂载并运行统一诊断 Skill；
- 提供 Trace、执行信息、已有报告和历史对话；
- 执行 Skill 内公共脚本与专项脚本；
- 接收统一格式的专项 finding；
- 对专项 finding 做通用富化和基础校验；
- 保存一键诊断报告或返回诊断追问回答。

平台不负责：

- 判断当前应该调用循环诊断器还是工具错误诊断器；
- 保存某个诊断器的专属 Prompt；
- 为每个模型型诊断器编写一个服务端包装文件；
- 为每个新诊断器增加报告字段或前端组件。

### 2.3 专项诊断器负责发现事实，通用富化器负责表达

专项诊断器输出确定性或有明确证据约束的事实，例如：

```text
故障类型：循环 / 无进展
发生区间：节点 #8～#15
主导动作：read_file(path=/a.md)
重复次数：6
无进展比例：82%
证据节点：#8、#11、#15
```

通用富化器只负责生成：

- 一句话结论；
- 故障机制；
- 故障链；
- 修复建议。

通用富化器不得修改：

- 故障类型；
- 原始事实和统计值；
- 严重程度；
- 证据节点；
- 诊断器版本；
- 置信度。

### 2.4 不增加独立结果编排层

一键诊断中不新增一个独立的“结果编排 Agent”。

专项诊断器完成检测并经过通用富化后，结果交回同一个 AgentDebug 会话，但不让 AgentDebug 重新生成整份报告。整个过程分为两个阶段：

1. AgentDebug 独立完成五模块诊断并冻结 `coreFindings`，此时看不到专项结果；
2. AgentDebug 只比较冻结结论与专项结果，返回结构化的合并或独立决策。

最终报告由通用确定性代码应用这些决策，完成：

- 语义查重；
- 结果关联；
- 专项证据合并；
- 独立诊断结果保留。

### 2.5 重复结果直接并入 AgentDebug 卡片

当专项 finding 与 AgentDebug finding 语义重复时：

- 以 AgentDebug finding 为最终结果；
- 将专项诊断器提供的事实、区间、证据和建议并入 AgentDebug finding；
- 删除重复的专项顶层 finding；
- 前端不显示专项来源；
- 合并后的 AgentDebug 卡片不保留“由某专项诊断器支持”之类的用户可见信息。

当结果相关但不重复时，AgentDebug 可以将它们组织进同一故障链，或保留为相互关联的两个 finding。

当专项结果是 AgentDebug 未覆盖的独立发现时，保留为通用专项 finding。

## 三、三条路线的完整功能流程

### 3.1 一键诊断

一键诊断由用户点击现有按钮显式触发，不需要做意图识别。

```text
用户点击一键诊断
  ↓
统一 Skill 进入 one_click 路线
  ↓
运行公共 Trace 提取、静态分析和证据查询脚本
  ↓
AgentDebug 独立运行五模块并冻结 core findings
  ↓
扫描并执行 Skill 内全部适用的专项诊断器
  ↓
通用富化器整理专项 finding
  ↓
同一 AgentDebug 会话比较冻结结论与专项 finding
  ↓
AgentDebug 只返回 merge / independent 及关联决策
  ↓
通用代码无损应用决策并输出最终报告
```

一键诊断检查范围：

- Memory；
- Reflection；
- Planning；
- Action；
- System；
- 全部适用于当前 Trace 的专项诊断器。

### 3.2 普通追问

普通追问保持当前行为：

```text
用户输入问题
  ↓
统一 Skill 判断为普通追问
  ↓
读取已有 AgentDebug 报告
  ↓
读取 Trace 资料包和历史对话
  ↓
沿用现有诊断追问 Prompt 回答
```

普通追问包括：

- 解释现有结论；
- 查询某个证据节点；
- 询问影响范围；
- 询问修复方式；
- 展开上一轮回答。

普通追问不运行：

- AgentDebug 五模块；
- 专项诊断器；
- 通用富化器。

### 3.3 定向查因

当用户描述了一个新的、明确的故障现象时，统一 Skill 进入定向查因路线。

```text
用户描述故障现象
  ↓
统一 Skill 判断为定向查因
  ↓
将描述映射为一个或多个症状标签
  ↓
在 Skill 内选择匹配的专项诊断器
  ↓
运行专项诊断器
  ↓
通用富化器整理专项 finding
  ↓
把专项结果加入现有追问上下文
  ↓
现有追问 Agent 输出最终回答
```

定向查因不运行 AgentDebug 五模块。

普通追问与定向查因的区别：

| 用户输入 | 路线 | 是否运行专项诊断器 | 是否运行五模块 |
| --- | --- | --- | --- |
| “为什么你认为规划有问题？” | 普通追问 | 否 | 否 |
| “节点 #12 有什么证据？” | 普通追问 | 否 | 否 |
| “这个问题应该怎么修？” | 普通追问 | 否 | 否 |
| “Agent 一直重复读取同一个文件，帮我查一下” | 定向查因 | 是 | 否 |
| “工具连续失败以后为什么还不换方案？” | 定向查因 | 是 | 否 |

定向查因结果服务于当前诊断对话，不覆盖一键诊断主报告。后续普通追问可以继续基于该结果回答。

## 四、统一 Skill 的建议组织结构

统一 Skill 继续使用：

```text
skills/agent-debug-diagnosis/
```

目标结构：

```text
skills/agent-debug-diagnosis/
├─ SKILL.md
│  └─ 三路选择、公共流程、资源导航、统一约束
│
├─ references/
│  ├─ 01-input-and-extraction.md
│  ├─ 02-error-taxonomy.md
│  ├─ 03-phase-analysis.md
│  ├─ 04-output-schema.md
│  ├─ workflow-one-click.md
│  ├─ workflow-follow-up.md
│  ├─ workflow-targeted-diagnosis.md
│  └─ taxonomy.json
│
├─ scripts/
│  ├─ agentdebug_common.py
│  ├─ agentdebug_static.py
│  ├─ agentdebug_inspect.py
│  ├─ agentdebug_validate.py
│  ├─ detector_runner.py
│  └─ detector_validate.py
│
└─ detectors/
   ├─ trajectory/
   │  ├─ detector.json
   │  ├─ instructions.md
   │  ├─ detect.py
   │  └─ fixtures/
   │
   ├─ tool-error-burst/
   │  ├─ detector.json
   │  ├─ instructions.md
   │  ├─ detect.py
   │  └─ fixtures/
   │
   └─ <future-detector>/
```

组织原则：

- `SKILL.md` 只保留三条路线和公共规则，避免随着诊断器增加不断膨胀；
- 三条路线的详细步骤放入三个 workflow reference；
- 五模块 taxonomy 和输出协议继续放在 references；
- 公共、可复用、需要确定性的处理放在 scripts；
- 每个专项诊断器放在独立目录中；
- 只有一个顶层 `SKILL.md`，专项诊断器不是可独立触发的新 Skill；
- 大 Skill 根据 detector manifest 按需读取某个诊断器的 instructions 和执行脚本。

## 五、专项诊断器包的标准

### 5.1 detector.json

每个诊断器必须有一份机器可读清单，至少描述：

```json
{
  "name": "trajectory",
  "version": "0.1",
  "enabled": true,
  "kind": "rule",
  "description": "检测跨多个 turn 的循环、重复和无进展区间",
  "symptoms": ["loop", "slow", "incomplete"],
  "modes": ["one_click", "targeted_diagnosis"],
  "entry": "detect.py",
  "instructions": "instructions.md",
  "outputVersion": 1
}
```

字段含义：

- `name`：稳定唯一名称；
- `version`：诊断行为变化时升级；
- `enabled`：是否参与选择；
- `kind`：规则型或语义型；
- `description`：诊断的故障场景；
- `symptoms`：定向查因可以匹配的症状；
- `modes`：允许在哪些路线运行；
- `entry`：可选脚本入口；
- `instructions`：专项诊断规程；
- `outputVersion`：输出协议版本。

`detector_runner.py` 扫描 `detectors/*/detector.json`，完成列举、匹配和执行。这样无需服务端注册表，新增诊断器也不需要修改统一 Skill 的主流程。

### 5.2 instructions.md

专项说明包含：

- 故障定义；
- 适用和不适用场景；
- 需要检查的 Trace 信号；
- 判定标准；
- 正例和反例；
- 误报规避规则；
- 专项输出要求。

规则型诊断器主要依赖脚本，instructions 用于解释和约束富化。

语义型诊断器主要依赖 instructions，必要时调用公共查询脚本取得小块证据。

### 5.3 detect.py 或其他专项脚本

能确定性判断的诊断场景必须优先使用脚本，例如：

- 重复调用次数；
- 连续失败次数；
- 同一参数重复；
- 长时间无新动作；
- 明确的错误码序列。

脚本只输出结构化事实，不负责生成长篇自然语言。

### 5.4 fixtures

每个诊断器至少提供：

- 明确应命中的正例；
- 明确不应命中的反例；
- 阈值边界样例；
- 容易误报的相似场景；
- 多框架 Trace 样例，如实际需要覆盖 OpenCode、Claude Code、Hermes。

## 六、统一专项 finding 协议

所有专项诊断器输出同一种 finding，公共部分至少包括：

```text
id
kind
severity
summary
facts
mechanism
faultChain
anchors
correctionGuidance
confidence
details
```

其中：

- `facts` 是诊断器确认的结构化事实；
- `anchors` 必须指向真实 Trace 节点；
- `details` 保存标准字段无法表达的专项数据；
- `summary`、`mechanism`、`faultChain`、`correctionGuidance` 可以被通用富化器改写；
- 其他确定性字段不能被富化器修改。

专项输出必须经过公共校验：

- 必填字段完整；
- 严重度和置信度合法；
- anchorId、traceStepIndex 能在当前 Trace 中找到；
- details 可序列化且大小受限；
- 输出版本受支持。

## 七、当前循环诊断器的真实现状

### 7.1 现在存放在哪里

当前循环 / 无进展诊断器不在 `skills/agent-debug-diagnosis/` 内，而是服务端专属 TypeScript 代码：

- [`src/lib/engine/agent-debug/trajectory-detector.ts`](../src/lib/engine/agent-debug/trajectory-detector.ts)：确定性检测算法；
- [`src/lib/engine/agent-debug/trajectory-enricher.ts`](../src/lib/engine/agent-debug/trajectory-enricher.ts)：循环诊断专属 LLM 富化；
- [`src/lib/engine/agent-debug/types.ts`](../src/lib/engine/agent-debug/types.ts)：专属 `AgentDebugTrajectoryFinding` 类型；
- [`src/components/observe/AgentDebugCard.tsx`](../src/components/observe/AgentDebugCard.tsx)：专属 `TrajectoryFindingRow` 前端展示。

当前算法直接扫描平台已经归一化的 `DebugTurn[]`，使用工具名、参数指纹或文本指纹识别重复动作，并通过连续区间内的重复占比判断无进展循环。

### 7.2 现在怎么调用

当前调用链位于 [`src/lib/engine/agent-debug/runner.ts`](../src/lib/engine/agent-debug/runner.ts)：

```text
buildDebugTurns(interactions)
  ↓
detectTrajectoryFindings(turns)
  ↓
运行 AgentDebug Skill 五模块诊断
  ↓
enrichTrajectoryFindings(trajectoryFindings)
  ↓
写入 report.trajectoryFindings
  ↓
AgentDebugCard 使用 TrajectoryFindingRow 单独展示
```

它与 AgentDebug Skill 的关系是并列的：

- AgentDebug Skill 不负责选择或调用循环诊断器；
- 循环诊断结果不会返回给 AgentDebug 做查重；
- 服务端直接把五模块 findings 和 trajectoryFindings 拼进同一报告；
- 前端分别渲染，因此可能与 AgentDebug 结果重复。

## 八、循环诊断器迁移方案

循环诊断器作为新体系中的第一个标准专项诊断器迁移。

### 8.1 建立 trajectory 诊断器包

新增：

```text
skills/agent-debug-diagnosis/detectors/trajectory/
├─ detector.json
├─ instructions.md
├─ detect.py
└─ fixtures/
```

迁移内容：

- 将当前 `trajectory-detector.ts` 的重复签名、密集区间、阈值、锚点选择算法迁入 `detect.py`；
- 将当前文件头和诊断原则整理到 `instructions.md`；
- 在 `detector.json` 声明 `loop`、`slow`、`incomplete` 等症状；
- 将当前 detector 测试样例迁成诊断器 fixtures；
- 输出统一专项 finding，不再输出专属 `AgentDebugTrajectoryFinding`。

### 8.2 用公共 runner 调用

一键诊断时：

```text
detector_runner.py list --mode one_click
detector_runner.py run trajectory --input <agent-debug-input>
```

定向查因时：

```text
detector_runner.py match --symptoms loop,incomplete
detector_runner.py run trajectory --input <agent-debug-input>
```

具体命令名称可以在实现阶段调整，但功能边界保持不变：选择和调用发生在统一 Skill 内，不发生在服务端 TS 注册表中。

### 8.3 交给通用富化器

删除循环专属的富化 Prompt。trajectory 与其他诊断器一样，把结构化事实和代表性证据交给通用富化器。

通用富化器根据统一字段生成机制、故障链和建议，不再出现 `enrichTrajectoryFindings()` 这类专项函数。

### 8.4 返回 AgentDebug 查重

在一键诊断中，富化后的 trajectory finding 交回 AgentDebug。

AgentDebug 根据语义和证据决定：

- 与现有 finding 重复：并入 AgentDebug 卡片，不保留专项来源，不展示独立循环卡片；
- 与现有 finding 相关：进入同一故障链或保留相关 finding；
- 属于独立跨区间故障：保留为通用专项 finding。

### 8.5 移除旧专属链路

完成等价验证后：

- 删除 `trajectory-detector.ts`；
- 删除 `trajectory-enricher.ts`；
- runner 移除 `detectTrajectoryFindings` 和 `enrichTrajectoryFindings` 的专属调用；
- 新报告不再使用专属 `trajectoryFindings` 作为真源；
- 前端移除 `TrajectoryFindingRow` 专属分支，改用通用 finding 展示；
- 旧报告的 `trajectoryFindings` 仅保留读取兼容，不参与新报告生成。

### 8.6 迁移验收

必须满足：

- 相同 Trace 下，新旧循环算法命中区间一致；
- 重复次数、无进展比例、锚点和严重度一致；
- 原有正例继续命中；
- 原有反例继续不命中；
- 一键诊断能运行 trajectory；
- 定向查因能通过“卡住、重复、不终止”等描述选中 trajectory；
- 普通追问不运行 trajectory；
- 重复结果成功并入 AgentDebug 卡片；
- 独立循环结果可以通过通用卡片展示；
- 服务端和前端不再保留 trajectory 专属业务代码。

## 九、以后新增专项诊断器的流程

### 9.1 定义故障场景

先写清楚：

- 用户会如何描述这个问题；
- Trace 上有什么可核验信号；
- 什么情况下应命中；
- 什么情况下不应命中；
- 是否能用确定性脚本判断；
- 与现有五模块 errorType 或专项诊断器是否重叠。

### 9.2 创建诊断器包

复制标准模板，创建：

```text
detectors/<name>/
├─ detector.json
├─ instructions.md
├─ detect.py        # 规则型需要，纯语义型可选
└─ fixtures/
```

新增诊断器不创建新的顶层 Skill，也不修改服务端 detector 注册表。

### 9.3 填写触发与适用范围

在 `detector.json` 中定义：

- 唯一名称和版本；
- 是否启用；
- 症状标签；
- 支持一键诊断、定向查因或两者；
- 所需 Trace 信号；
- 脚本和说明文件入口。

### 9.4 编写检测能力

优先顺序：

1. 能通过结构化数据确定的，编写规则脚本；
2. 需要语义判断的，编写专项 instructions，并使用公共查询脚本取证；
3. 同时需要两者的，由脚本先定位候选区间，再由语义判断确认。

无论哪种形态，都必须输出统一专项 finding。

### 9.5 补齐测试样例

必须包含：

- 路由应命中的用户描述；
- 路由不应命中的普通追问；
- 检测正例；
- 检测反例；
- 阈值边界；
- 与已有诊断器重叠的场景；
- 与 AgentDebug finding 重复、相关和独立的三类场景。

### 9.6 运行 Skill 内校验

检查：

- manifest 完整；
- 名称和版本不冲突；
- symptoms 合法；
- 脚本能运行；
- finding 符合统一协议；
- anchors 可以回到真实 Trace；
- 正反例结果符合预期。

### 9.7 验证三条路线

新增诊断器必须验证：

- 一键诊断：适用时能够自动运行；
- 普通追问：不会误触发；
- 定向查因：典型现象能够正确选中；
- AgentDebug 查重：重复结果正确并入；
- 前端：独立结果无需新增组件即可展示。

### 9.8 发布和下线

发布：

- 新增或修改诊断器只改统一 Skill 内目录；
- 行为变化升级 detector version；
- 随产品版本发布 Skill 资产；
- 不修改服务端专项代码和前端专项组件。

临时下线：

- 将 manifest 的 `enabled` 设为 false。

删除：

- 从 Skill 内删除诊断器目录；
- 历史报告仍由通用 finding 或旧报告兼容逻辑读取。

## 十、原“服务端 TS 注册表和模型包装”方案的处理

### 10.1 不再建设服务端专项诊断器注册表

原设计中的：

```text
src/lib/engine/agent-debug/detectors/index.ts
DIAGNOSIS_DETECTORS = [trajectoryDetector, ...]
```

不再作为目标方案。

原因：

- 每增加诊断器仍需修改服务端代码；
- 诊断器的触发、规则和执行入口会分散在 Skill 与服务端；
- 无法实现“专项代码只存在于 Skill 内”；
- 一键诊断和定向查因容易形成两套选择逻辑。

服务端可以保留通用的 Skill 执行和 finding 校验能力，但不能保存具体诊断器列表。

### 10.2 不再为每个模型诊断器编写 TS 包装

原设计中的：

```text
detectors/<name>.ts
  → 挂载专项 skill
  → runGeneralAgent
  → 解析专项 JSON
```

不再采用。

新的语义型专项诊断器直接作为统一 Skill 内的诊断器包存在：

- manifest 定义触发和入口；
- instructions 保存诊断知识；
- 公共 runner 负责发现和调用；
- 公共 validator 负责校验输出；
- 服务端通用富化器负责表达整理。

### 10.3 已存在的 trajectory TS 作为迁移期遗留

当前两个 TS 文件在迁移完成前继续工作，用于行为对照和回归验证。

迁移完成后删除，不形成“Skill 内一份、服务端一份”的双实现。

### 10.4 保留哪些服务端通用能力

服务端仍可保留或新增：

- 统一 Skill 的加载和挂载；
- 输入文件和 Trace bundle 准备；
- 通用富化器；
- 通用 finding 解析与证据校验；
- 报告版本兼容；
- 一键诊断持久化；
- 诊断追问 SSE 和消息保存。

这些能力都不包含具体故障场景名称或某个 detector 的专属分支。

## 十一、一键诊断最终结果规则

AgentDebug 在第二阶段接收：

- 第一阶段冻结的五模块 `coreFindings`；
- 全部经过通用富化的专项 findings。

然后逐条判断，但只返回决策，不重新生成 findings。第一阶段的 `coreFindings` 是冻结输入，后续确定性代码不能删除其中任何一条。

### 11.1 重复

判定为重复必须同时满足：

- 故障对象相同；
- 故障机制相同；
- 主要证据节点或区间相同；
- 修复方向相同。

处理：

- AgentDebug 返回目标 core finding 和可选的严重程度、影响和置信度提升建议；
- 通用代码把专项 `facts`、`details`、区间、次数、比例和 `anchors` 从原始 detector finding 原样复制到目标 finding 的 `supplementalEvidence`；
- 不再保留重复的顶层专项 finding；
- 前端只展示合并后的普通诊断卡片，不展示专项来源。

### 11.2 相关但不重复

两个问题属于同一故障链、一个问题触发或放大另一个问题，不代表它们重复。只要故障机制或修复方向不同，就保留为两个 finding，并通过 `relatedFindingId` 记录关联。例如“工具报错导致循环”仍应保留工具报错和循环两个问题。

### 11.3 独立

独立结果继续保留为通用 `detectorFindings`，使用统一卡片展示，不需要诊断器专属前端组件或来源标签。

### 11.4 无损与失败降级约束

AgentDebug 只能返回合并、独立和关联决策，不能：

- 改写专项诊断器的确定性统计；
- 编造不存在的证据节点；
- 因为文案相似就合并两个不同故障；
- 删除冻结的 core finding；
- 删除没有重复且对用户有价值的独立结果。

若 Agent 返回无效目标、遗漏某条专项结果或第二阶段调用失败，通用代码一律按独立 finding 保留，保证结果不会被吞掉。原始专项结果和合并决策保存在诊断工作区审计文件中，不进入用户可见报告。

## 十二、前端功能变化

### 12.1 一键诊断页面

保留现有 AgentDebug 卡片作为主要结果形态。

- 重复专项结果已经并入 AgentDebug 卡片，不单独展示；
- 相关结果由 AgentDebug 组织进故障链或相关 finding；
- 独立专项结果使用通用专项卡片；
- 不显示重复结果的专项来源；
- 新增诊断器不增加前端代码。

### 12.2 诊断追问

保留当前输入框、消息历史、Trace 节点引用和流式回答。

- 普通追问体验不变；
- 定向查因仍在同一输入框触发；
- 定向结果由追问 Agent 直接组织为回答；
- 定向查因不修改一键诊断主报告。

### 12.3 通用专项卡片

通用卡片只负责独立专项 finding，展示统一字段：

- 结论；
- 严重程度；
- 故障机制；
- 故障链；
- 证据节点；
- 修复建议；
- 可选通用详情。

不能要求前端识别 `trajectory`、`tool-error-burst` 等具体 kind 后再写专属组件，否则会破坏快速插拔目标。

## 十三、实施阶段

### 阶段一：统一 Skill 外壳，行为不变

- 扩展现有 `agent-debug-diagnosis/SKILL.md`；
- 增加一键诊断、普通追问、定向查因三条路线；
- 将详细流程拆入 references；
- 一键和普通追问先继续走当前行为；
- 建立统一输入和输出约束。

### 阶段二：专项诊断器包规范和公共 runner

- 定义 detector manifest；
- 定义统一 finding；
- 增加 detector runner 和 validator；
- 增加诊断器模板；
- 验证诊断器可以只靠 Skill 内资产发现和执行。

### 阶段三：迁移 trajectory

- 将算法和测试迁入 Skill；
- 并行运行新旧实现做结果对照；
- 接入通用富化器；
- 接入一键诊断和定向查因；
- 达到等价后删除旧 TS 专属链路。

### 阶段四：AgentDebug 最终查重和关联

- 将富化后的专项 findings 返回 AgentDebug；
- 增加重复、相关、独立判断；
- 重复结果并入 AgentDebug 卡片且不保留专项来源；
- 增加查重和关联的输出校验。

### 阶段五：改造现有诊断追问

- 让现有追问入口使用统一 Skill；
- 普通追问沿用当前 Prompt；
- 增加定向查因识别；
- 定向查因选择 Skill 内专项诊断器；
- 不运行五模块；
- 后续追问复用定向结果。

### 阶段六：通用前端和兼容迁移

- 新报告使用统一 findings；
- 独立专项结果使用通用卡片；
- 移除 trajectory 专属前端分支；
- 兼容读取旧 `trajectoryFindings`；
- 更新用户指南和开发者指南。

## 十四、整体验收标准

### 14.1 架构边界

- 新增专项诊断器不修改服务端专项代码；
- 新增专项诊断器不修改前端组件；
- 服务端不存在具体诊断器注册表；
- 服务端不存在每个模型诊断器的专属包装文件；
- 诊断器代码、规则、知识和测试都在统一 Skill 内。

### 14.2 三条路线

- 一键诊断运行五模块和全部适用专项诊断器；
- 普通追问不运行五模块和专项诊断器；
- 定向查因只运行匹配的专项诊断器，不运行五模块；
- 全面诊断继续通过现有一键诊断入口完成。

### 14.3 结果处理

- 专项 finding 全部经过统一协议和证据校验；
- 通用富化器不修改确定性事实；
- 重复结果并入 AgentDebug 卡片；
- 重复结果不展示专项来源；
- 相关结果建立合理关系；
- 独立结果不被误删。

### 14.4 插拔验证

以新增“工具错误风暴”诊断器为验收样例：

- 只新增 Skill 内诊断器目录；
- 一键诊断自动运行；
- “同一个工具连续报错”能够在定向查因中选中；
- 普通追问不会误触发；
- 与 AgentDebug 重复时正确并入；
- 独立时通用卡片可展示；
- disabled 后立即不再参与选择；
- 全程不增加服务端和前端专项分支。

## 十五、明确不做的事情

本期不做：

- 面向用户开放自定义诊断器；
- 第三方诊断器市场；
- 服务端 TS 诊断器插件注册表；
- 每个模型诊断器一个服务端包装；
- 每个诊断器一个独立 Skill；
- 每个诊断器一个前端卡片组件；
- 独立的结果编排 Agent；
- 定向查因时运行 AgentDebug 五模块；
- 将定向查因结果覆盖一键诊断主报告。

## 十六、最终方案摘要

最终形态是一个统一的 `agent-debug-diagnosis` Skill：

- 主 `SKILL.md` 负责三路选择和公共约束；
- references 保存三条流程、taxonomy 和输出协议；
- scripts 保存公共 Trace 分析、诊断器运行和校验能力；
- detectors 保存可插拔专项诊断器；
- 一键诊断运行五模块和全部适用专项诊断器；
- 普通追问保持当前行为；
- 定向查因只运行匹配专项诊断器；
- 服务端只提供通用富化、校验、存储和流式能力；
- 一键诊断由 AgentDebug 自己完成专项结果的最终查重和关联；
- 重复结果并入 AgentDebug 卡片，不保留专项来源；
- 独立专项结果通过通用卡片展示；
- trajectory 作为第一个标准专项诊断器，从服务端 TS 专属实现迁入 Skill；
- 后续新增诊断器只需增加或修改 Skill 内诊断器包。
