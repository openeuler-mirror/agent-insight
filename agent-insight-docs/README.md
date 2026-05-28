<p align="center">
  <img src="./docs/assets/banner.png" alt="Agent Insight" width="800" />
</p>

<h1 align="center">Agent Insight</h1>

<p align="center">
  <strong>面向 Agent 全生命周期的开源工程平台 — 观测、评测、Skills 优化一体化</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/your-org/agent-insight" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/github/v/release/your-org/agent-insight" alt="Release" /></a>
  <a href="#"><img src="https://img.shields.io/pypi/v/agent-insight" alt="PyPI" /></a>
  <a href="#"><img src="https://img.shields.io/npm/v/@agent-insight/sdk" alt="npm" /></a>
  <a href="#"><img src="https://img.shields.io/github/stars/your-org/agent-insight?style=social" alt="Stars" /></a>
  <br/>
  <a href="https://docs.agent-insight.dev">Docs</a> ·
  <a href="https://demo.agent-insight.dev">Live Demo</a> ·
  <a href="#">Discord</a> ·
  <a href="#">Twitter</a>
</p>

---

## 📖 What is Agent Insight?

Agent Insight 是一个开源的 Agent 全生命周期工程平台。它把 **运行观测（Observability）**、**评测中心（Evaluation）** 和 **Skills 能力管理（Skills Lifecycle）** 整合到同一工作台。

> 与 Langfuse / LangSmith 不同，Agent Insight 把 **Skills**（Agent 能力）作为一等公民，提供从生成、A/B 测试到优化的完整闭环。

<p align="center">
  <img src="./docs/assets/screenshot-overview.png" alt="Agent Insight Dashboard" width="900" />
</p>

---

## ✨ Key Features

- 🔭 **运行观测** · 链路追踪、智能诊断、质量监控 — 完整可视化 Agent 执行轨迹
- 🧪 **评测中心** · 数据集 + 评估器 + 批量执行，支持自动评测与人工标注
- 🛠️ **Skills 全生命周期** · 一站式管理 / 生成 / A/B 分析 / 优化
- 🆎 **三步法 A/B 测试** · Config → Execution → Decision 结构化工作流
- 🧠 **智能诊断** · 自动发现失败模式与异常调用
- 🔌 **50+ 框架集成** · LangChain、LangGraph、LlamaIndex、OpenAI Agents SDK、AutoGen、CrewAI
- 🌐 **多语言 SDK** · Python、TypeScript 双语原生支持
- 🏠 **完全自托管** · Docker Compose / Kubernetes 一键部署，数据完全自主
- 📡 **OpenTelemetry 兼容** · 不绑死生态

---

## 🚀 Quickstart

```bash
# 1. 启动 Agent Insight
git clone https://github.com/your-org/agent-insight.git
cd agent-insight
docker compose up -d

# 2. 安装 SDK
pip install agent-insight
```

```python
# 3. 接入你的 Agent
from agent_insight import AgentInsight, observe

AgentInsight.init(api_key="ai_xxx", host="http://localhost:3000")

@observe()
def my_agent(query: str) -> str:
    # 你的 Agent 逻辑
    return answer
```

打开 [http://localhost:3000](http://localhost:3000) 查看第一条 Trace。

完整指引：[Quickstart](./docs/get-started/start-tracing.mdx)

---

## 📚 Documentation

完整文档：<https://docs.agent-insight.dev>

| 模块 | 内容 |
|---|---|
| [Observability](./docs/observability/overview.mdx) | 运行观测：链路追踪、智能诊断、质量监控 |
| [Evaluation](./docs/evaluation/overview.mdx) | 评测中心：数据集、评估器、批量执行 |
| [Skills](./docs/skills/overview.mdx) | **★ Skills 全生命周期**：管理 / 生成 / 分析 / 优化 |
| [Platform](./docs/platform/overview.mdx) | 平台基础：Agent 管理、模型注册、配置 |
| [Self-Hosting](./docs/self-hosting/overview.mdx) | 部署、配置、扩展、备份 |
| [Integrations](./docs/integrations/overview.mdx) | 50+ 框架与生态集成 |
| [Guides & Cookbook](./docs/guides/overview.mdx) | 实战案例（Jupyter Notebook） |

---

## 🔌 Integrations

**Agent 框架**：LangChain · LangGraph · LlamaIndex · OpenAI Agents SDK · AutoGen · CrewAI · Pydantic AI · Dify · Coze

**LLM 提供商**：OpenAI · Anthropic · Google · DeepSeek · Qwen · LiteLLM · Ollama

**可观测性生态**：OpenTelemetry · Grafana · Prometheus · Datadog

**开发工具**：Cursor · VS Code · Claude Code

---

## 📊 Comparison

| 能力 | Agent Insight | Langfuse | LangSmith | AgentOps |
|---|:-:|:-:|:-:|:-:|
| 开源 | ✅ | ✅ | ❌ | ✅ |
| 自托管 | ✅ | ✅ | 企业版 | 企业版 |
| 链路追踪 | ✅ | ✅ | ✅ | ✅ |
| 评测中心 | ✅ | ✅ | ✅ | 部分 |
| Prompt 管理 | ✅ | ✅ | ✅ | ❌ |
| **Skills 生命周期** | ✅ | ❌ | ❌ | ❌ |
| **智能诊断** | ✅ | ❌ | 部分 | ❌ |
| **三步法 A/B 工作流** | ✅ | 部分 | 部分 | ❌ |
| OpenTelemetry 兼容 | ✅ | ✅ | ✅ | ✅ |

详细对比：[Comparison](./docs/index.mdx#comparison)

---

## 🤝 Contributing

我们欢迎所有形式的贡献：

- [贡献指南](./CONTRIBUTING.md)
- [行为准则](./CODE_OF_CONDUCT.md)
- [Good First Issues](https://github.com/your-org/agent-insight/labels/good%20first%20issue)
- [Discord 社区](#)

---

## 📝 License

[Apache License 2.0](./LICENSE)

---

## ⭐ Star History

<a href="https://star-history.com/#your-org/agent-insight&Date">
  <img src="https://api.star-history.com/svg?repos=your-org/agent-insight&type=Date" alt="Star History" />
</a>
