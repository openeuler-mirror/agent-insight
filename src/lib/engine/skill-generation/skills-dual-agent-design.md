# 双 Agent Skills 自动生成与评测系统设计文档

> 基于 LangGraph.js + DeepAgents.js 的 Skills 生成–评测一体化框架

---

## 文档说明

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 技术栈 | TypeScript / Node.js + LangGraph.js + deepagents (npm) |
| 协作模式 | Supervisor 调度（主 Agent 统一编排生成与评测两个子 Agent） |
| 评测维度 | 全维度（结构合规 + 触发率 + 端到端任务执行 + 改进建议） |
| 阅读对象 | 第一部分（设计文档）面向架构师；第二部分（实现说明）面向工程师 |

---

# 第一部分：设计文档

## 1. 背景与目标

### 1.1 背景

Anthropic 推出的 Skills 机制（`SKILL.md` + 配套脚本/资源）正在成为 Claude 生态中扩展 Agent 能力的标准方式。一个高质量的 Skill 不仅要在结构上合规（YAML frontmatter、行数控制、文件组织），还要在 description 上精确触发，并在真实任务上交付可用的输出。

`skill-creator` 这套官方资源已经定义了完整的 Skills 生产方法论：草稿 → 测试 → 评审 → 改进 → 循环。但这套流程目前仍以"人 + Claude 对话"为主，缺少一个独立运行、可程序化调度的框架。

### 1.2 目标

构建一个**双 Agent 自动化系统**：

- **Generator Agent**：加载 `skill-creator` 作为方法论资源，根据用户需求自动产出符合规范的 Skill 包；
- **Evaluator Agent**：对 Generator 产出的 Skill 进行多维度评测，给出量化指标与改进建议；
- **Supervisor**：统一调度两个 Agent，承载用户意图、决定迭代策略、汇总最终交付物。

### 1.3 非目标

- 不重新实现 `skill-creator` 的所有脚本（如 `run_loop.py`、`generate_review.py`），而是**在合适的节点调用它们**或用 TS 重新封装其核心逻辑；
- 不做面向终端用户的 GUI（评审仍可复用 skill-creator 的 HTML viewer）；
- 不替代 LangSmith 做长期的可观测性平台（但保留接入点）。

---

## 2. 核心概念与术语

| 术语 | 含义 |
|---|---|
| **Skill** | 一个目录，至少包含 `SKILL.md`（带 YAML frontmatter）的合规产物 |
| **Generator Agent** | 负责"写"Skill 的 deep agent，加载 skill-creator 作为指南 |
| **Evaluator Agent** | 负责"评"Skill 的 deep agent，输出 `EvalReport` |
| **Supervisor** | LangGraph 顶层 StateGraph，编排两个 Agent，并管理迭代 |
| **Trial（试运行）** | 在 Evaluator 中启动一个临时 deep agent，加载被测 Skill 并跑测试 prompt 的过程 |
| **Iteration（迭代）** | 一轮"生成→评测→反馈→再生成"的完整循环 |
| **Skill Spec** | 用户对 Skill 的初始描述（意图、触发场景、期望输出、测试案例） |

---

## 3. 总体架构

### 3.1 架构图

```
                           ┌──────────────────────────────────┐
                           │            User Input            │
                           │   (Skill Spec / Improve Skill)   │
                           └────────────────┬─────────────────┘
                                            │
                                            ▼
                    ┌──────────────────────────────────────────────┐
                    │        Supervisor (LangGraph StateGraph)     │
                    │  ┌────────────────────────────────────────┐  │
                    │  │ State: { spec, skillPath, evalReport,  │  │
                    │  │          iteration, history, status }  │  │
                    │  └────────────────────────────────────────┘  │
                    │                                              │
                    │     plan ─► generate ─► evaluate ─► decide   │
                    │                  ▲                    │      │
                    │                  └────────────────────┘      │
                    │                  (when iterate again)        │
                    └──────────┬───────────────────┬───────────────┘
                               │                   │
                  invokes      │                   │   invokes
                               ▼                   ▼
            ┌──────────────────────────┐ ┌──────────────────────────┐
            │   Generator Agent        │ │   Evaluator Agent        │
            │   (createDeepAgent)      │ │   (createDeepAgent)      │
            │                          │ │                          │
            │ ◇ skill-creator loaded   │ │ ◇ Trial Sandbox tool     │
            │   as a "skill" reference │ │ ◇ Schema linter tool     │
            │ ◇ FilesystemBackend      │ │ ◇ Trigger eval tool      │
            │   (writes SKILL.md,      │ │ ◇ E2E task runner        │
            │    scripts/, refs/,      │ │ ◇ Report writer          │
            │    assets/)              │ │                          │
            └──────────┬───────────────┘ └──────────┬───────────────┘
                       │                            │
                       ▼                            ▼
            ┌──────────────────────────┐ ┌──────────────────────────┐
            │   Skill Workspace        │ │   Eval Workspace         │
            │   <root>/skills/<name>/  │ │   <root>/evals/<name>/   │
            │     SKILL.md             │ │     iteration-N/         │
            │     scripts/             │ │       trial-runs/        │
            │     references/          │ │       grading.json       │
            │     evals/evals.json     │ │       benchmark.json     │
            └──────────────────────────┘ └──────────────────────────┘
```

### 3.2 拓扑选择说明（为什么是 Supervisor）

LangGraph.js 中常见的多 Agent 拓扑有三种：流水线、Supervisor、Swarm。本系统选择 Supervisor，原因如下：

1. **状态需要全局可见**。迭代轮次、历史评测、当前最优版本等信息必须在多次调用之间持久化，Supervisor 持有的 `StateGraph` 天然具备这种能力。
2. **决策点集中**。"是否需要再迭代一轮"、"是否进行 description 优化"、"是否触发盲对比" 这些决策放在 Supervisor 比放在子 Agent 更清晰，避免子 Agent 越权。
3. **便于人类介入**。Supervisor 可以在评测之后插入 LangGraph 的 `interrupt`，等待人类点头后再决定下一步，这与 skill-creator 中"读取 feedback.json"的步骤天然对应。

### 3.3 与 skill-creator 的关系

skill-creator 在本系统中扮演**双重身份**：

- **作为知识库**被 Generator Agent 加载（其 `SKILL.md` 进入 Generator 的系统提示，`references/`、`agents/` 按需读取）；
- **作为脚本工具**被 Evaluator 调用（如 `aggregate_benchmark.py`、`run_loop.py`、`improve_description.py`），系统通过 `child_process` 在合适的节点调用它们，避免重复造轮子。

---

## 4. State 设计

Supervisor 的 `StateGraph` 采用 LangGraph 的 reducer 风格状态。完整 State 定义如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `spec` | `SkillSpec` | 用户原始意图（不变） |
| `skillPath` | `string` | 当前 Skill 目录的绝对路径 |
| `iteration` | `number` | 当前是第几轮迭代，从 0 开始 |
| `maxIterations` | `number` | 最大迭代次数（默认 3） |
| `generatorMessages` | `BaseMessage[]` | Generator Agent 的对话历史（含 reducer：append） |
| `evaluatorMessages` | `BaseMessage[]` | Evaluator Agent 的对话历史 |
| `evalReport` | `EvalReport \| null` | 最近一次评测报告 |
| `history` | `IterationRecord[]` | 历次迭代汇总（含分数、变更摘要） |
| `status` | `'planning' \| 'generating' \| 'evaluating' \| 'iterating' \| 'done' \| 'failed'` | 状态机当前状态 |
| `decision` | `'iterate' \| 'accept' \| 'abort'` | 上一次决策结果 |
| `userFeedback` | `string \| null` | 可选：人类介入后给出的反馈 |

`SkillSpec` 与 `EvalReport` 的具体形态见第二部分。

---

## 5. Supervisor 工作流

### 5.1 节点定义

| 节点 | 职责 | 输出到 State |
|---|---|---|
| `plan` | 解析 spec、生成 SkillSpec 完整字段（含测试 prompt 草稿）、初始化工作区 | `spec`, `skillPath`, `status='planning'` |
| `generate` | 调用 Generator Agent 产出/修改 Skill 文件 | `generatorMessages`, `status='generating'` |
| `evaluate` | 调用 Evaluator Agent，对当前 Skill 进行全维度评测 | `evalReport`, `evaluatorMessages`, `status='evaluating'` |
| `decide` | 基于 `evalReport` 和 `iteration` 决定下一步 | `decision`, `history`（追加） |
| `humanReview`（可选） | LangGraph `interrupt`，等待人类输入 | `userFeedback` |
| `finalize` | 打包 Skill、生成最终报告、清理临时文件 | `status='done'` |

### 5.2 状态转移

```
plan
  └─► generate
        └─► evaluate
              └─► decide
                    ├─[iterate]─► generate         (回到生成节点)
                    ├─[accept]──► finalize
                    └─[abort]───► finalize (status=failed)
```

### 5.3 决策规则（decide 节点）

`decide` 是流程的"大脑"，规则按优先级如下：

1. **硬性结构问题**：若 `evalReport.structure.passed === false`（YAML 缺字段、行数超限等致命问题），强制 `iterate`，除非已达 `maxIterations`，则 `abort`。
2. **触发率门槛**：若 `evalReport.trigger.passRate < 0.7`，且未达迭代上限，则 `iterate`，并在反馈中重点标记 description 问题。
3. **端到端任务通过率**：若 `evalReport.e2e.passRate < 0.8`，按上述同样规则迭代。
4. **达到合格线**：所有维度都达标 → `accept`。
5. **资源耗尽**：达到 `maxIterations` → `accept`（接受当前最佳版本）或 `abort`（视用户配置）。

---

## 6. Generator Agent 设计

### 6.1 职责

将 `SkillSpec` 落地为合规、可用的 Skill 目录结构。

### 6.2 关键设计决策

#### 6.2.1 让 skill-creator 进入系统提示

Generator Agent 的 system prompt **包含** `skill-creator/SKILL.md` 的核心内容（前 200 行最关键，特别是"Skill Writing Guide"和"Anatomy of a Skill"两节），这样 Agent 在写 Skill 时持续受到方法论指导。

> 注意：skill-creator 完整 SKILL.md 较长（约 480 行），全文塞入会增加每次调用成本。建议提取核心章节作为常驻提示，把"Description Optimization"、"Blind comparison"等高级内容放进 `references/`，由 Agent 按需读取。

#### 6.2.2 Backend 选择

使用 deepagents 的 `LocalShellBackend`（带 `rootDir`），以便：

- 真实地写入 `SKILL.md`、`scripts/*.py`、`references/*.md`；
- 可执行 shell（运行 lint、调用 skill-creator 自带脚本）；
- 路径权限收敛在工作区目录下。

#### 6.2.3 工具配置

除 deepagents 内置的 `write_todos`、`ls`、`read_file`、`write_file`、`edit_file`、`task` 外，额外注入：

| 工具名 | 作用 |
|---|---|
| `lookup_skill_creator_section` | 按章节名读取 skill-creator 的对应内容（避免 Agent 自己反复 `read_file`） |
| `validate_skill_structure` | 调用 quick lint，立即反馈结构错误（与 Evaluator 用同一份实现） |
| `package_skill` | 包装 `python -m scripts.package_skill <path>`，把 Skill 打成 `.skill` 文件 |

#### 6.2.4 子 Agent 模式（可选增强）

如果 SkillSpec 比较复杂（如同时涉及多个领域子目录），可以为 Generator 配置 subagents：

- `frontmatter-writer`：专门写 YAML frontmatter，针对 description 触发性单独优化；
- `script-author`：专门写 `scripts/` 下的 Python/Node 脚本；
- `eval-prompt-author`：根据 SkillSpec 生成 `evals/evals.json`。

> 这部分非必需。MVP 阶段可先用单 Agent，效果不足再拆分。

### 6.3 输入/输出契约

**输入**：

```ts
{
  spec: SkillSpec,
  skillPath: string,                // 写入目录
  previousReport?: EvalReport,      // 迭代时携带上轮评测
  userFeedback?: string             // 人类反馈
}
```

**输出**（写到磁盘 + 返回结构化摘要）：

```ts
{
  skillPath: string,
  filesCreated: string[],
  filesModified: string[],
  summary: string,                  // 本轮做了什么改动
  selfAssessment: {                 // Agent 自评
    confidenceLevel: 'low' | 'medium' | 'high',
    knownLimitations: string[]
  }
}
```

---

## 7. Evaluator Agent 设计

### 7.1 评测维度（全维度策略）

| 维度 | 检查项 | 指标 |
|---|---|---|
| **D1 结构合规** | YAML frontmatter 字段齐全；`name`、`description` 必填；行数 ≤ 推荐上限；目录结构合理；引用文件存在 | `passed: boolean`, `issues: string[]` |
| **D2 触发率** | 用 LLM 模拟"是否会调用此 Skill"的判断，针对一组 should-trigger / should-not-trigger 查询打分 | `passRate: 0..1`, `falsePositiveRate`, `falseNegativeRate` |
| **D3 端到端任务执行** | 真实启动一个加载该 Skill 的 trial agent，执行 `evals/evals.json` 中的 prompt，对输出执行断言 | `passRate: 0..1`, 每个 eval 的 `passed/expectations` |
| **D4 改进建议** | 综合上述三项，由 Evaluator 用 LLM 生成下一轮的具体修改建议 | `recommendations: string[]`（每条带优先级） |

> 关于 D3：复用 skill-creator 已有的"with-skill 试运行 + grader"思路。Evaluator 调用 `task` 工具 spawn 一个临时 deep agent，把被测 Skill 加载到该子 Agent 的系统提示里运行，再由 grader subagent 评分。

### 7.2 关键设计决策

#### 7.2.1 评测脚本：复用 vs 自研

| 任务 | 选择 | 理由 |
|---|---|---|
| 结构 lint | 自研（TS） | 简单、无需 Python 进程开销 |
| 触发率评测 | 复用 + 改写 | skill-creator 的 `run_loop.py`/`improve_description.py` 提供了 60/40 训练-保留切分的标准做法，Evaluator 可在 description-only 优化时调用，但日常评测用 TS 实现轻量版即可 |
| 端到端 trial | 自研 | 必须用 deepagents.js 在 Node 进程内 spawn 子 agent，否则跨语言 |
| 报告聚合 | 自研 | 输出 JSON 给 Supervisor，便于 decide 节点消费 |

#### 7.2.2 Trial Agent 的隔离

每次端到端评测会 spawn 一个**全新**的 deep agent，配置如下：

- 系统提示 = 默认 + 当前被测 SKILL.md 全文；
- `LocalShellBackend` 指向独立的临时目录（`evals/<name>/iteration-N/eval-K/sandbox/`）；
- 不携带前次对话；
- 设置超时（默认 90s）和 token 上限。

这一隔离非常重要：避免 trial agent 受到 Evaluator 自身上下文污染，模拟真实的用户首次触发场景。

#### 7.2.3 LLM-as-Judge 与脚本断言并用

`evals/evals.json` 中支持两类 expectations：

- **可程序化检查**（如"包含字符串 X"、"文件 Y 存在"、"JSON 中 Z 字段为整数"）：写成断言脚本，自动跑；
- **需人为/语义判断**（如"格式专业"、"风格自然"）：交给 LLM judge（grader subagent）。

Evaluator 优先调用脚本断言，只在必要时启动 LLM judge，节省成本。

### 7.3 EvalReport 结构

```ts
type EvalReport = {
  skillName: string;
  iteration: number;
  timestamp: string;
  
  structure: {
    passed: boolean;
    issues: Array<{ severity: 'error' | 'warning'; message: string; path?: string }>;
  };
  
  trigger: {
    passRate: number;            // 总通过率
    falsePositiveRate: number;
    falseNegativeRate: number;
    failedQueries: Array<{ query: string; expected: boolean; actual: boolean }>;
  };
  
  e2e: {
    passRate: number;
    perEval: Array<{
      evalId: number;
      prompt: string;
      passed: boolean;
      expectations: Array<{ text: string; passed: boolean; evidence: string }>;
      durationMs: number;
      tokens: number;
    }>;
  };
  
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    target: 'frontmatter' | 'body' | 'scripts' | 'references' | 'evals';
    suggestion: string;
  }>;
  
  overall: {
    score: number;               // 综合分（0..1），用于决策
    verdict: 'pass' | 'iterate' | 'fail';
  };
};
```

---

## 8. 文件与目录约定

```
<workspace-root>/
├── skills/
│   └── <skill-name>/                # Generator 的产物
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       ├── assets/
│       └── evals/
│           └── evals.json
├── evals/
│   └── <skill-name>/                # Evaluator 的产物
│       ├── iteration-0/
│       │   ├── trial-runs/
│       │   │   ├── eval-0/
│       │   │   │   ├── transcript.json
│       │   │   │   ├── outputs/
│       │   │   │   └── grading.json
│       │   │   └── eval-1/...
│       │   ├── trigger-eval.json
│       │   ├── benchmark.json
│       │   └── report.json          # 即 EvalReport
│       ├── iteration-1/...
│       └── final/                   # 收敛后的版本快照
└── runtime/
    ├── checkpoints/                 # LangGraph checkpointer
    └── logs/
```

---

## 9. 失败模式与防御

| 风险 | 缓解 |
|---|---|
| Generator 写出无限大的 SKILL.md | `validate_skill_structure` 工具即时检查行数，超限拒绝写入并要求精简 |
| Evaluator trial agent 死循环 | 单次 trial 设硬超时 + token 上限；超时记为失败 |
| 评测结果震荡（触发率每次跑不一样） | 触发率每条 query 跑 3 次取均值，与 skill-creator `run_loop.py` 一致 |
| Description 优化导致正反例反转 | 60% train / 40% test 切分，按 test 分挑选，借鉴 skill-creator 做法 |
| 任意代码执行风险（trial agent 跑用户脚本） | `LocalShellBackend` + 独立 rootDir + 命令白名单（生产环境进一步用沙箱后端如 Modal/Daytona） |
| 模型差异导致触发率失真 | trial 与触发评测都使用与生产一致的模型 ID，写在配置里 |

---

## 10. 可观测性与调试

- 全流程接入 LangSmith：`createDeepAgent` 返回的是 LangGraph 图，自动可被 LangSmith trace。
- Supervisor 的 `decide` 节点把决策依据完整 log 到 State 的 `history`，便于回放。
- 每次迭代生成一份 `report.json`，并由 Supervisor 在 `finalize` 阶段聚合成 `final-report.md`，供人类阅读。
- 复用 skill-creator 的 `eval-viewer/generate_review.py`：在 `evaluate` 节点后调用，生成 HTML 报告供人类评审。

---

## 11. 阶段性里程碑

| 阶段 | 范围 | 验收 |
|---|---|---|
| **M1：单 Agent + 结构评测** | Generator + Evaluator 的 D1 维度 + Supervisor 流水线 | 给一个 SkillSpec，能产出结构合规的 Skill 目录 |
| **M2：触发率评测** | 加 D2（trigger eval） | 跑通 20 条触发查询，能返回 passRate |
| **M3：端到端评测** | 加 D3（trial agent） | 能 spawn 子 agent 执行 evals 并断言 |
| **M4：循环迭代** | decide 节点 + history + 多轮迭代 | 在 M3 基础上能自动迭代 ≥2 轮并收敛 |
| **M5：增强能力** | description 优化、人类介入、HTML 报告 | 接入 skill-creator 脚本，跑通完整 demo |

---

# 第二部分：实现说明参考

## 12. 工程结构

```
skills-dual-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      # CLI 入口
│   ├── types.ts                      # SkillSpec / EvalReport / IterationRecord
│   ├── supervisor/
│   │   ├── graph.ts                  # StateGraph 装配
│   │   ├── nodes/
│   │   │   ├── plan.ts
│   │   │   ├── generate.ts
│   │   │   ├── evaluate.ts
│   │   │   ├── decide.ts
│   │   │   └── finalize.ts
│   │   └── state.ts                  # State 定义 + reducers
│   ├── generator/
│   │   ├── createGeneratorAgent.ts   # 工厂函数
│   │   ├── prompts.ts                # 含 skill-creator 浓缩版
│   │   └── tools/
│   │       ├── lookupSkillCreator.ts
│   │       ├── validateStructure.ts
│   │       └── packageSkill.ts
│   ├── evaluator/
│   │   ├── createEvaluatorAgent.ts
│   │   ├── runners/
│   │   │   ├── structureLinter.ts    # D1
│   │   │   ├── triggerEval.ts        # D2
│   │   │   ├── e2eRunner.ts          # D3
│   │   │   └── recommender.ts        # D4
│   │   └── trial/
│   │       └── spawnTrialAgent.ts    # 启动加载被测 skill 的临时 agent
│   ├── shared/
│   │   ├── skillCreatorAdapter.ts    # 调用 skill-creator 脚本
│   │   ├── workspace.ts              # 路径管理
│   │   └── logging.ts
│   └── config.ts
├── tests/
│   └── ...
└── README.md
```

## 13. 关键依赖

| 包 | 用途 |
|---|---|
| `deepagents` | 创建 Generator/Evaluator/Trial agent |
| `@langchain/langgraph` | Supervisor 的 StateGraph |
| `@langchain/anthropic` | 默认 Claude 模型适配（也可换 OpenAI） |
| `langchain` | tool 定义、消息类型 |
| `zod` | tool 输入 schema |
| `gray-matter` | 解析 SKILL.md 的 YAML frontmatter |
| `execa` | 调用 Python 脚本（如 `aggregate_benchmark.py`） |

## 14. 关键代码骨架

### 14.1 State 定义

```ts
// src/supervisor/state.ts
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { SkillSpec, EvalReport, IterationRecord } from "../types.js";

export const SupervisorState = Annotation.Root({
  spec: Annotation<SkillSpec>(),
  skillPath: Annotation<string>(),
  iteration: Annotation<number>({ default: () => 0, reducer: (_, n) => n }),
  maxIterations: Annotation<number>({ default: () => 3, reducer: (_, n) => n }),
  generatorMessages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  evaluatorMessages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  evalReport: Annotation<EvalReport | null>({ default: () => null, reducer: (_, r) => r }),
  history: Annotation<IterationRecord[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  status: Annotation<string>({ default: () => "planning", reducer: (_, s) => s }),
  decision: Annotation<"iterate" | "accept" | "abort" | null>({
    default: () => null,
    reducer: (_, d) => d,
  }),
  userFeedback: Annotation<string | null>({ default: () => null, reducer: (_, f) => f }),
});

export type SupervisorStateType = typeof SupervisorState.State;
```

### 14.2 Generator Agent 工厂

```ts
// src/generator/createGeneratorAgent.ts
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { GENERATOR_SYSTEM_PROMPT } from "./prompts.js";
import { lookupSkillCreatorTool } from "./tools/lookupSkillCreator.js";
import { validateStructureTool } from "./tools/validateStructure.js";
import { packageSkillTool } from "./tools/packageSkill.js";

export function createGeneratorAgent(opts: {
  workspaceRoot: string;
  modelId?: string;
}) {
  const model = new ChatAnthropic({
    model: opts.modelId ?? "claude-sonnet-4-5-20250929",
    temperature: 0,
  });

  return createDeepAgent({
    model,
    systemPrompt: GENERATOR_SYSTEM_PROMPT,
    tools: [lookupSkillCreatorTool, validateStructureTool, packageSkillTool],
    backend: () =>
      new LocalShellBackend({
        rootDir: opts.workspaceRoot,
        inheritEnv: false,
      }),
  });
}
```

### 14.3 Evaluator Agent 与 Trial 隔离

```ts
// src/evaluator/trial/spawnTrialAgent.ts
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 为单个 eval prompt 启动一个隔离的 trial agent，
 * 它在系统提示里加载被测 SKILL.md 全文。
 */
export async function runTrial(args: {
  skillPath: string;
  evalPrompt: string;
  sandboxDir: string;
  modelId: string;
  timeoutMs?: number;
}) {
  const skillBody = readFileSync(join(args.skillPath, "SKILL.md"), "utf-8");

  const trialAgent = createDeepAgent({
    model: args.modelId,
    systemPrompt: [
      "You are a helpful assistant.",
      "The following skill is loaded and you should consult it when relevant:",
      "---",
      skillBody,
      "---",
    ].join("\n"),
    backend: () => new LocalShellBackend({ rootDir: args.sandboxDir }),
  });

  const startedAt = Date.now();
  const result = await Promise.race([
    trialAgent.invoke({
      messages: [{ role: "user", content: args.evalPrompt }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("trial-timeout")), args.timeoutMs ?? 90_000)
    ),
  ]);

  return {
    transcript: result,
    durationMs: Date.now() - startedAt,
  };
}
```

### 14.4 Supervisor 装配

```ts
// src/supervisor/graph.ts
import { StateGraph, END } from "@langchain/langgraph";
import { SupervisorState } from "./state.js";
import { planNode } from "./nodes/plan.js";
import { generateNode } from "./nodes/generate.js";
import { evaluateNode } from "./nodes/evaluate.js";
import { decideNode } from "./nodes/decide.js";
import { finalizeNode } from "./nodes/finalize.js";

export function buildSupervisor() {
  const graph = new StateGraph(SupervisorState)
    .addNode("plan", planNode)
    .addNode("generate", generateNode)
    .addNode("evaluate", evaluateNode)
    .addNode("decide", decideNode)
    .addNode("finalize", finalizeNode)
    .addEdge("__start__", "plan")
    .addEdge("plan", "generate")
    .addEdge("generate", "evaluate")
    .addEdge("evaluate", "decide")
    .addConditionalEdges("decide", (state) => {
      if (state.decision === "iterate") return "generate";
      return "finalize";
    })
    .addEdge("finalize", END);

  return graph.compile();
}
```

### 14.5 decide 节点决策骨架

```ts
// src/supervisor/nodes/decide.ts
import type { SupervisorStateType } from "../state.js";

export async function decideNode(state: SupervisorStateType) {
  const r = state.evalReport!;
  const reachedLimit = state.iteration + 1 >= state.maxIterations;

  let decision: "iterate" | "accept" | "abort" = "accept";
  const reasons: string[] = [];

  if (!r.structure.passed) {
    reasons.push("structure failed");
    decision = reachedLimit ? "abort" : "iterate";
  } else if (r.trigger.passRate < 0.7) {
    reasons.push(`trigger passRate ${r.trigger.passRate} < 0.7`);
    decision = reachedLimit ? "accept" : "iterate";
  } else if (r.e2e.passRate < 0.8) {
    reasons.push(`e2e passRate ${r.e2e.passRate} < 0.8`);
    decision = reachedLimit ? "accept" : "iterate";
  } else {
    reasons.push("all metrics meet thresholds");
  }

  return {
    decision,
    iteration: state.iteration + 1,
    history: [
      {
        iteration: state.iteration,
        score: r.overall.score,
        decision,
        reasons,
        reportPath: `evals/${r.skillName}/iteration-${state.iteration}/report.json`,
      },
    ],
    status: decision === "iterate" ? "iterating" : "done",
  };
}
```

### 14.6 evaluate 节点（聚合四个维度）

```ts
// src/supervisor/nodes/evaluate.ts
import { runStructureLint } from "../../evaluator/runners/structureLinter.js";
import { runTriggerEval } from "../../evaluator/runners/triggerEval.js";
import { runE2EEval } from "../../evaluator/runners/e2eRunner.js";
import { generateRecommendations } from "../../evaluator/runners/recommender.js";
import type { SupervisorStateType } from "../state.js";

export async function evaluateNode(state: SupervisorStateType) {
  const structure = await runStructureLint(state.skillPath);
  const trigger = await runTriggerEval(state.skillPath, state.spec);
  const e2e = await runE2EEval(state.skillPath, state.spec, state.iteration);
  const recommendations = await generateRecommendations({
    structure,
    trigger,
    e2e,
    spec: state.spec,
  });

  const score =
    (structure.passed ? 0.3 : 0) +
    0.3 * trigger.passRate +
    0.4 * e2e.passRate;

  return {
    evalReport: {
      skillName: state.spec.name,
      iteration: state.iteration,
      timestamp: new Date().toISOString(),
      structure,
      trigger,
      e2e,
      recommendations,
      overall: {
        score,
        verdict: score >= 0.85 ? "pass" : score >= 0.6 ? "iterate" : "fail",
      },
    },
    status: "evaluating",
  };
}
```

## 15. 与 skill-creator 脚本的集成点

| 节点/场景 | 调用的 skill-creator 资源 | 调用方式 |
|---|---|---|
| Generator system prompt | `skill-creator/SKILL.md`（核心章节） + `references/schemas.md` | 启动时读入字符串 |
| Generator 按需查阅 | `agents/grader.md`、`agents/comparator.md` | 通过 `lookup_skill_creator_section` 工具 |
| Evaluator 触发率优化 | `scripts/improve_description.py`、`scripts/run_loop.py` | 通过 `execa` 调 Python |
| Evaluator 报告聚合 | `scripts/aggregate_benchmark.py` | 通过 `execa` 调 Python |
| Finalize 阶段打包 | `scripts/package_skill.py` | 通过 `execa` 调 Python |
| 人工评审阶段 | `eval-viewer/generate_review.py` | 通过 `execa` 调 Python，输出 HTML |

> 实现建议：所有对 Python 脚本的调用统一封装在 `src/shared/skillCreatorAdapter.ts`，方便未来替换为纯 TS 实现。

## 16. CLI 入口示例

```ts
// src/index.ts
import { buildSupervisor } from "./supervisor/graph.js";
import { loadSpecFromFile } from "./shared/workspace.js";

async function main() {
  const specPath = process.argv[2];
  const spec = await loadSpecFromFile(specPath);

  const app = buildSupervisor();

  const finalState = await app.invoke({
    spec,
    skillPath: `./workspace/skills/${spec.name}`,
    maxIterations: 3,
  });

  console.log("DONE", {
    status: finalState.status,
    iterations: finalState.iteration,
    score: finalState.evalReport?.overall.score,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## 17. 测试建议

1. **单元测试**：`structureLinter`、`triggerEval` 中的非 LLM 部分（YAML 解析、断言执行）必须有单测。
2. **集成测试**：固化一个最小 SkillSpec（如"把输入字符串反转"），跑全流程，断言至少 1 轮迭代后达标。
3. **金标对比**：选 2 个 skill-creator 自带 example skills，让系统重新生成一遍，与原版作 diff，作为 regression baseline。
4. **回归集**：每加一个 prompt 模式或评测维度，把对应的 SkillSpec 沉淀到 `tests/fixtures/`。

---

## 18. 后续可扩展方向

- **沙箱后端升级**：`LocalShellBackend` → Modal / Daytona / Deno sandbox，提升任意代码执行的安全性。
- **A/B 盲对比**：对接 skill-creator `comparator.md` 的方法论，让 Evaluator 在两个 Skill 候选间做盲选。
- **多模型评测**：触发率与端到端评测分别用 Claude / GPT / 开源模型跑，看 description 是否对各家都鲁棒。
- **持久记忆**：Supervisor 接入 LangGraph `Store`，把"哪些 description 写法在历史上更易触发"沉淀为长期知识。
- **MCP 化**：把整个系统封装成 MCP Server，方便 Claude Code、Claude.ai 直接调用。

---

## 附录 A：术语速查

| 术语 | 一句话解释 |
|---|---|
| Deep Agent | 一种带规划工具、文件系统、子 agent 能力的 Agent harness，本质是 LangGraph 图 |
| Supervisor | 多 Agent 系统中负责调度的顶层 Agent，本系统中由 LangGraph StateGraph 实现 |
| LocalShellBackend | deepagents 的一种后端，把 Agent 的文件操作映射到本地真实文件系统并支持 shell |
| Trial Agent | 评测时临时 spawn 的、加载被测 Skill 的 agent，用于跑端到端任务 |
| Trigger eval | 测试 Skill description 是否能被 Claude 在合适的 query 下选中调用 |

## 附录 B：参考资料

- LangGraph.js 官方文档：<https://reference.langchain.com/javascript/>
- DeepAgents.js GitHub：<https://github.com/langchain-ai/deepagentsjs>
- Skill Creator（本系统加载的方法论资源）：`/mnt/skills/examples/skill-creator/SKILL.md`
- Skill JSON Schemas：`/mnt/skills/examples/skill-creator/references/schemas.md`
