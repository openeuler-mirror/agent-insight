<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/logo-horizontal-dark.svg" />
    <img src="public/brand/logo-horizontal-light.svg" alt="Agent Insight" width="400" />
  </picture>
</p>

<p align="center">
  <strong>让每一个 Agent 都可被观测、可被评估、可自我进化。</strong>
  <br/>
  <em>面向 Agent 全生命周期的开源工程平台 — 观测 · 评测 · Skills 优化 一体化</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-43853d.svg" alt="Node" /></a>
  <a href="https://gitcode.com/openeuler/agent-insight"><img src="https://img.shields.io/badge/repo-gitcode-1f7ae0.svg" alt="Repo" /></a>
  <a href="mailto:intelligence@openeuler.org"><img src="https://img.shields.io/badge/contact-intelligence%40openeuler.org-orange.svg" alt="Contact" /></a>
</p>

---

## 📖 什么是 Agent Insight？

随着 Agent 在各行业的落地，开发者面临三大痛点：Agent 运行过程如同黑盒，难以定位问题根因；Skill 质量参差不齐，缺少体系化的评测与迭代手段；Agent 经验无法沉淀复用，每次优化都从零开始。

**Agent Insight** 正是为解决这些问题而生 —— 它是一个**框架无关**的统一AgentOps平台，让运行在 OpenCode、Claude Code、Hermes、Openclaw 等任意框架上的 Agent 都能被持续观测、系统评测和自主优化。

> 与同类产品不同的是，Agent Insight 把 **Skills（Agent 能力）** 作为一等公民，提供从生成、A/B 测试到优化的完整闭环。

---

## ✨ 核心能力

- 🔭 **Agent 观测与自进化** · 围绕 *运行数据采集 → 链路跟踪 → 评测分析 → 经验沉淀 → 辅助决策* 构建 Agent 全生命周期的数据飞轮，支撑故障定位与质量监控，并将运行数据沉淀为迭代优化的原料，持续驱动优化。
- 🛠️ **Skill 开发与自进化** · 围绕 *Skill 生成 → 调试 → 观测 → 评估 → 优化* 构建全生命周期能力闭环，将 Skill 打造为可持续进化的工程资产。
- 🆎 **智能 A/B 测评** · Config → Execution → Decision 三步法结构化工作流，支持一键执行、自动对比与智能决策，让能力升级有据可依、省心高效。
- 🧠 **智能诊断** · 基于链路与失败模式自动定位异常调用与根因。
- 🔌 **框架无关** · 基于 OpenTelemetry 等业界标准协议，通过原生插件或 OTLP 上报无缝兼容 OpenCode、Claude Code、Hermes、JiuwenSwarm 等多种 Agent 运行时与平台。
- 🏠 **完全自托管** · 一键安装，全栈本地化部署，数据完全自主可控，无外部依赖。

---

## 🏗️ 架构

<p align="center">
  <img src="docs/images/architecture.png" alt="Agent-Insight 架构图" />
</p>

---

## 🔌 支持平台

Agent Insight 框架无关，已接入以下 Agent 运行时/框架，更多平台持续接入中：

| Agent 框架    | 采集方式    |
|:----------- |:------- |
| OpenCode    | 原生插件    |
| Claude Code | OTLP 上报 |
| Hermes      | 原生插件    |
| JiuwenSwarm | OTLP 上报 |
| Langgraph | OTLP 上报 |

## 🚀 快速开始

### 1. 安装服务端

**830 转测版本的服务端对外仅通过 Linux Docker 镜像交付。** 按交付清单确认镜像包、固定标签、CPU 架构、源码提交和 SHA-256。

安装顺序：

1. 校验离线镜像包，只有校验通过才执行 `docker load`。
2. 核对镜像架构、源码提交和运行用户 uid/gid。
3. 准备宿主机 `/opt/agent-insight`，以 `750` 权限挂载到容器 `/data/agent-insight`。
4. 启动容器，检查配置、数据库、日志和页面访问。

完整命令及安装产物、配置检查、备份升级说明见 [830 平台安装说明](docs/user-guide/quickstart.md)。宿主机无需安装服务端 Node.js、npm 或源码。

默认配置为 `/opt/agent-insight/.env`，SQLite 数据库为 `/opt/agent-insight/data/witty_insight.db`，日志通过 `docker logs agent-insight` 查看。不要在本交付方式中设置 `DB_HOST`。

浏览器打开 `http://<服务器地址>:3000/trace`，使用个人邮箱登录。

### 2. Linux 客户端接入

在已安装并运行 AcTrail、且官方 `otel-http` 插件可用的 Linux 主机上执行：

1. 登录平台，进入 **配置 → 安装指导**。
2. 确认当前账号和平台地址，复制页面生成的 **Linux curl** 命令。
3. 在 AcTrail 所在 Linux 终端执行命令，配置上报插件。
4. 在 AcTrail 中执行一次 Agent 任务，返回 **运行观测 → 链路追踪**，确认数据和详情。

命令形态如下，实际地址和 API Key 以页面生成值为准：

```bash
curl -sSf "http://<平台地址>:3000/api/ingest/setup?key=<当前账号API_KEY>&yes=1&frameworks=actrail" | bash
```

---

## 🧭 上手演练 — Skill 生成 → 评测 → 优化

完整体验在 Agent-Insight 看板中完成 **Skill 生成 → 评测 → 优化** 的闭环流程。

> 💡 **零配置体验**：新用户首次登录注册后，平台会自动注入一套内置示例（`messages 日志分析` 数据集 + `linux-messages-auth-triage-demo` Skill + 三条示例 Trace；客户端安装后还会生成本地示例日志 `~/.agent-insight/example/messages`），无需接入真实 Agent 即可照着 [内置示例端到端走查](docs/user-guide/example-walkthrough.md) 跑通「智能诊断 → Skill 生成 → 评测 → 优化」全流程。

### 注册模型

1. 进入 **模型注册**，单击 **注册首个模型**。
   
   <p align="center"><img src="docs/images/model-view.png" alt="注册模型" /></p>

2. 选择模型供应商。
   
   <p align="center"><img src="docs/images/model-provider.png" alt="选择模型供应商" /></p>

3. 配置 API 密钥，单击 **测试连接并保存**。
   
   <p align="center"><img src="docs/images/model-configkey.png" alt="配置 API Key" /></p>

### 生成 Skill

1. 进入 **Skills 生成**，提交需求描述，例如：
   
   > 创建一个 Skill，当用户请求查看系统信息时，自动执行 shell 脚本收集当前系统的关键信息（操作系统、CPU、内存、磁盘、网络等），以 Markdown 报告呈现给用户。
   
   <p align="center"><img src="docs/images/skill-gen.png" alt="生成 Skill" /></p>

2. 单击 **保存并发布**。

### 分析 Skill

1. 进入 **Skills 评测**，单击 **静态合规**。
   
   <p align="center"><img src="docs/images/skill-analyse.png" alt="分析 Skill" /></p>

2. 单击 **重新扫描**，查看分析结果。
   
   <p align="center"><img src="docs/images/skill-analyse-static.png" alt="静态合规分析" /></p>

### 优化 Skill

1. 进入 **Skills 优化**，选择 Skill 并单击 **优化**。
   
   <p align="center"><img src="docs/images/skill-optimization.png" alt="优化 Skill" /></p>

2. 选择可优化项并单击 **开始优化**，或直接输入优化需求后单击 **发送**。
   
   <p align="center"><img src="docs/images/skill-optimization-result.png" alt="优化结果" /></p>

3. 优化完成后，单击 **发布为 v1**，系统将自动保存为新版本。

---

## 📚 文档

详细使用指南见 [`docs/user-guide`](docs/user-guide/) 目录。新用户推荐从 [内置示例端到端走查](docs/user-guide/example-walkthrough.md) 开始 —— 用注册即得的内置示例零配置跑通完整闭环。

## 🤝 如何贡献

我们诚挚欢迎新贡献者加入项目，也会为新加入者提供全面的指导与帮助。

贡献代码前，请先签署 [CLA](https://clasign.osinfra.cn/sign/6983225bdcbb19710248ccf0)，再参考 [代码贡献指引](https://www.openeuler.org/zh/community/contribution/detail#_4-2-代码类贡献) 提交代码。

如有任何疑问、建议或讨论需求，欢迎通过以下方式联系我们：

- 提交 [Issue](https://atomgit.com/openeuler/agent-insight/issues)
- 发送邮件至 <intelligence@openeuler.org>

---

## 📝 License

本项目采用 [MIT](LICENSE) 开源协议。
