# Agent Insight 文档结构地图

> 本文档说明整个 `docs/` 目录的设计意图与浏览顺序。
> 设计参考：Langfuse 文档结构（按 Products 切，每个产品内部统一为 Overview → Get Started → Concepts → Features → SDK → Troubleshooting）。

---

## 顶层目录

```
docs/
├── index.mdx                     # Overview — 落地页 + 路标
├── demo.mdx                      # 在线 Demo
├── ask-ai.mdx                    # AI 问答入口
│
├── get-started/                  # ★ 横向跨产品的快速起步
│   ├── start-tracing.mdx
│   ├── setup-evaluation.mdx
│   ├── manage-skills.mdx
│   └── run-ab-test.mdx
│
├── observability/                # 产品 1：运行观测
├── evaluation/                   # 产品 2：评测中心
├── skills/                       # 产品 3：Skills（★ 核心差异化）
├── platform/                     # 产品 4：平台基础（Agent 管理、模型注册…）
├── metrics/                      # 产品 5：指标与仪表盘
├── api-and-data-platform/        # 产品 6：API & 数据导出
├── administration/               # 产品 7：管理后台
├── security-and-guardrails/      # 安全与防护
│
├── self-hosting/                 # 抽出独立子站（侧边栏外链）
├── integrations/                 # 抽出独立子站（侧边栏外链）
├── guides/                       # Cookbook（Jupyter Notebook 实战）
├── architecture/                 # 给资深用户和贡献者
└── more/                         # Glossary / Roadmap / FAQ / Changelog
```

---

## 每个 Products 模块的统一结构

```
{product}/
├── overview.mdx          # 是什么 + 能力一览 + 与其他模块的关系 + FAQ
├── get-started.mdx       # 5-10 分钟跑通
├── data-model.mdx        # 核心概念与数据模型（必读）
├── troubleshooting.mdx   # 常见问题排查
└── features/             # 每个具体能力一页（独立可链接）
    ├── feature-a.mdx
    ├── feature-b.mdx
    └── ...
```

这种统一结构有三个好处：
1. **认知一致** — 用户在不同产品间复用同一心智
2. **可深可浅** — 想快速试用看 Overview + Get Started 就够，想深入看 Features
3. **方便外链** — 每个 Feature 独立 URL，可在 Issue / Discord 中精确引用

---

## Skills 模块（核心差异化）

Skills 是 Agent Insight 区别于 Langfuse / LangSmith 的核心模块，结构上提升到与 Observability、Evaluation 平级，并按生命周期细分四个子目录：

```
skills/
├── overview.mdx          # 总览 + 完整生命周期图
├── get-started.mdx
├── data-model.mdx        # Skill / SkillVersion / Experiment
├── lifecycle.mdx         # 生命周期闭环图
│
├── management/           # 子能力 1：管理（注册、版本、Schema、上下线）
├── generation/           # 子能力 2：生成（AI 辅助产出）
├── analysis/             # 子能力 3：分析（★ 三步法 A/B 测试）
│   ├── overview.mdx
│   ├── ab-testing.mdx
│   ├── step1-config.mdx       # 对应截图三步法第一步
│   ├── step2-execution.mdx    # 对应截图三步法第二步
│   └── step3-decision.mdx     # 对应截图三步法第三步
└── optimization/         # 子能力 4：优化（自动迭代）
```

**重点**：A/B 测试的三步法（Config → Execution → Decision）在文档中按三页独立呈现，与产品 UI 严格对应。

---

## Platform 模块（对应截图左侧"概览/Agent 管理/配置"）

截图左侧导航的几个能力被归到 Platform 模块：

| 截图导航项 | 文档位置 |
|---|---|
| 概览 | `platform/workspace-dashboard.mdx` |
| Agent 管理 | `platform/agent-management.mdx` |
| 模型注册 | `platform/model-registry.mdx` |
| 联网搜索 | `platform/web-search.mdx` |
| 安装指导 | `platform/installation-guide.mdx` |

---

## 抽离的独立子站

以下三个内容量大的区域，**抽出独立侧边栏**，避免主侧边栏被淹没：

| 子站 | 内容 |
|---|---|
| `self-hosting/` | Docker / K8s / 各云厂商 / 配置 / 升级 / 备份 / 监控 |
| `integrations/` | 50+ 框架与生态集成 |
| `guides/` | Cookbook（Jupyter Notebook 实战） |

---

## 浏览顺序推荐

### 新用户（5 分钟）
1. `index.mdx`
2. `get-started/start-tracing.mdx`
3. 选一个感兴趣的 Product Overview 深入

### 试用者（30 分钟）
1. 三个 Product Get Started：`observability/get-started.mdx` → `evaluation/get-started.mdx` → `skills/get-started.mdx`
2. `skills/analysis/ab-testing.mdx` 完整三步法
3. `guides/skill-ab-testing.mdx` 实战 Notebook

### 采纳者（1-2 天）
1. 全部 Product Overview + Data Model
2. `self-hosting/` 完整一遍
3. `architecture/` 与 ADR
4. `security-and-guardrails/`

### 贡献者
1. `architecture/`
2. `architecture/adr/`
3. `CONTRIBUTING.md`

---

## 文档协作规范

### 命名约定
- 文件名小写连字符：`feature-name.mdx`
- 路径：`{product}/features/{feature-name}.mdx`
- 顶层目录使用名词，避免动词

### Front Matter
每个 .mdx 文件都包含：
```yaml
---
title: 中文标题
description: 一句话描述（≤ 80 字）
sidebar: 父级模块（用于侧边栏分组）
---
```

### 写作要点
1. **不要 README 化** — 每页都该是独立可分享的 URL，而不是文档站的章节段落
2. **每页第一段必须能回答"这页讲什么"** — 用户从搜索引擎进来要 5 秒内判断要不要继续读
3. **Feature 页统一三段式**：是什么 / 怎么用 / 最佳实践
4. **Concept 页统一四段式**：定义 / 字段 / 与其他概念关系 / 代码示例
5. **代码示例必须可复制运行** — Python / TS 用 Tabs 切换

### LLM 友好
- 每页提供 `.md` 后缀的纯 Markdown 端点（构建时自动生成）
- 仓库根目录提供 `llms.txt` 索引
- 提供 `docs-mcp` server，让 Cursor / Claude 能查文档

---

## 与 Langfuse 的关键差异

| 维度 | Langfuse | Agent Insight |
|---|---|---|
| 一级产品数量 | 3（Obs / Prompt / Eval） | 4（Obs / Eval / **Skills** / Platform） |
| Skills 概念 | 内嵌在 Prompt Management | **一等公民独立产品** |
| A/B 测试 | Experiments 一个功能 | **三步法独立工作流** |
| 智能诊断 | 无 | **独立 Feature** |
| 质量监控 | Alert 内嵌 Metrics | **主动监控独立 Feature** |

这些差异都已在目录结构中体现。
