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

## 📖 什么是 Agent-Insight？

随着 Agent 在各行业的落地，开发者面临三大痛点：Agent 运行过程如同黑盒，难以定位问题根因；Skill 质量参差不齐，缺少体系化的评测与迭代手段；Agent 经验无法沉淀复用，每次优化都从零开始。

**Agent-Insight** 正是为解决这些问题而生 —— 它是一个**框架无关**的 Agent Insight 工程底座，让运行在 OpenCode、Claude Code、LangChain、OpenClaw 等任意框架上的 Agent 都能被持续观测、系统评测和自主优化。

> 与同类产品不同的是，Agent-Insight 把 **Skills（Agent 能力）** 作为一等公民，提供从生成、A/B 测试到优化的完整闭环。

---

## ✨ 核心能力

- 🔭 **Agent 观测与自进化** · 围绕 *运行数据采集 → 链路跟踪 → 评测分析 → 经验沉淀 → 辅助决策* 构建 Agent 全生命周期的数据飞轮，支撑故障定位与质量监控，并将运行数据沉淀为迭代优化的原料，持续驱动优化。
- 🛠️ **Skill 开发与自进化** · 围绕 *Skill 生成 → 调试 → 观测 → 评估 → 优化* 构建全生命周期能力闭环，将 Skill 打造为可持续进化的工程资产。
- 🆎 **智能 A/B 测评** · Config → Execution → Decision 三步法结构化工作流，支持一键执行、自动对比与智能决策，让能力升级有据可依、省心高效。
- 🧠 **智能诊断** · 基于链路与失败模式自动定位异常调用与根因。
- 🔌 **框架无关** · 基于 OpenTelemetry 等业界标准协议，通过原生插件或日志旁路无缝兼容 OpenCode、Hermes、OpenClaw 等多种 Agent 运行时与平台。
- 🏠 **完全自托管** · 一键安装，全栈本地化部署，数据完全自主可控，无外部依赖。

---

## 🏗️ 架构

<p align="center">
  <img src="docs/images/architecture.png" alt="Agent-Insight 架构图" />
</p>

## 🚀 快速开始

### 1. 安装服务端

**环境要求**

- Node.js >= 20.0.0
- 3000 端口未被占用

**一键安装**

```bash
npx agent-insight install
```

**源码安装**

```bash
git clone https://gitcode.com/openeuler/agent-insight.git
cd agent-insight
npm install

# 开发模式
bash scripts/develop_start.sh

# 生产模式
bash scripts/start.sh

# 配置数据上报路径
curl -sSf "http://<IP>:<PORT>/api/setup?key=<API_KEY>" | bash
```

**启动服务**

```bash
cd agent-insight

# 开发模式
bash scripts/develop_start.sh

# 生产模式
bash scripts/start.sh
```

**访问看板**

浏览器打开 `http://localhost:3000`，使用任意邮箱登录即可，例如 `demo@163.com`。

<p align="center">
  <img src="docs/images/login.png" alt="登录" />
</p>

### 2. 安装客户端

以下以 Linux 系统 + OpenCode 运行时为例：

1. 在看板的 **安装指导** 页面复制客户端安装命令。
   <p align="center"><img src="docs/images/guide.png" alt="安装指导" /></p>

2. 在 Agent 所在服务器执行安装命令：

   ```bash
   curl -sSf "http://172.29.209.207:3000/api/ingest/setup?key=<API_KEY>" | bash
   ```

3. 选择 Agent 运行时。
   <p align="center"><img src="docs/images/guide-framework.png" alt="选择运行时" /></p>

4. 执行安装成功后提示的 Usage 命令，例如：

   ```bash
   opencode run 'hello'
   ```

5. 在看板的 **链路追踪** 页面确认链路数据已生成，即表示客户端安装成功。
   <p align="center"><img src="docs/images/trace.png" alt="链路追踪" /></p>

---

## 🧭 上手演练 — Skill 生成 → 评测 → 优化

完整体验在 Agent-Insight 看板中完成 **Skill 生成 → 评测 → 优化** 的闭环流程。

> 💡 **零配置体验**：新用户首次登录注册后，平台会自动注入一套内置示例（`messages 日志分析` 数据集 + 两条示例 Trace + 本地示例日志 `~/.agent-insight/example/messages`），无需接入真实 Agent 即可照着 [内置示例端到端走查](docs/user-guide/example-walkthrough.md) 跑通「智能诊断 → Skill 生成 → 评测 → 优化」全流程。

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
