---
title: "5 分钟上手"
description: "登录看板、注册模型、创建 Agent、完成接入，并在 UI 中看到第一条链路。"
---

# 5 分钟上手

本指南带你用最短路径跑通 Agent Insight 的第一条完整闭环：完成基础配置、接入一个 Agent，并在平台里看到真实链路。

完成后你会得到：

- 一个已登记的 Agent
- 一份可用的模型配置
- 一条真实上报并可查看详情的 Trace

> **Note**
> 本页更贴近当前项目的真实使用流程，默认你已经部署好了 Agent Insight 服务端，
> 并可以访问看板地址，例如 `http://localhost:3000` 或你的自托管域名。

## 前置条件

- 你可以访问 Agent Insight 看板
- 你拥有一个可用的模型 API Key，例如 OpenAI、DeepSeek 或其他兼容供应商
- 你有一个准备接入的 Agent 运行环境
- 如果要走代码集成路径，准备好 Python 3.9+ 或 Node.js 18+

---

## 可选：用 Docker 部署服务端

如果你还没有部署看板，可以直接用仓库根目录的 `Dockerfile` 构建镜像。镜像默认从 npm 拉取 `agent-insight@latest`，不会把源码复制进镜像：

```bash
docker build --pull --no-cache -t agent-insight:npm-latest .
docker run -d --name agent-insight -p 3000:3000 -v agent-insight-data:/data/agent-insight agent-insight:npm-latest
curl -i http://localhost:3000/
```

这条命令会把容器内的 `/data/agent-insight` 挂到 Docker volume `agent-insight-data`。SQLite 数据库、Skill 附件、评测运行时文件都会写入该目录下的 `data/`，容器重启或重建后仍可复用。

需要固定某个 npm 版本时：

```bash
docker build --pull --build-arg AGENT_INSIGHT_VERSION=0.2.2-beta -t agent-insight:0.2.2-beta .
```

如果你只是想在服务器上快速验证本地改动，不想每次都先发布 npm 包，可以改走“`npm pack` + 上传 `.tgz` + Docker 缓存构建”的测试流程，见 [Docker 测试构建](./docker-testing)。

容器只负责运行 Agent Insight 服务端。OpenCode、Claude Code、OpenClaw、LangChain 等框架的接入命令仍应在对应 Agent 实际运行的机器或容器里执行。当前仓库里的这份 `Dockerfile` 走 **SQLite 优先** 路线，不内置 OpenGauss 运行时依赖。

如果你要使用 `opencode-live` 触发分析、轨迹评测等会由服务端**本机拉起 opencode** 的能力，请确保当前 `Dockerfile` 构建出的镜像完整保留 npm 依赖，并让容器能够访问模型提供商网络；这些评测不会复用外部宿主机上另开的 opencode 进程。

---

## 推荐路径

对于大多数用户，建议按下面顺序操作：

1. 登录看板并进入当前 Workspace

2. 在 **模型注册** 中先配置模型
3. 在 **Agent 管理** 中创建一个 Agent
4. 在 **安装指导** 中完成接入
5. 触发一次真实执行
6. 在 **链路追踪** 中确认第一条 Trace

> **Tip**
> 如果你是开发者，且希望直接在代码里手工埋点，可以直接查看文末的
> “可选：通过 SDK 直接接入” 一节。

---

## 步骤一：登录并确认 Workspace

1. 打开你的 Agent Insight 看板地址。

   <p align="center">
     <img src="../images/home.png" alt="Agent Insight 看板首页" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

2. 完成登录，进入默认 Workspace。
3. 确认左侧导航中可以看到以下模块：
   - **Agent 管理**
   - **运行观测**
   - **评测中心**
   - **Skills 能力**
   - **配置**

> **Tip**
> 如果你同时维护开发、预发和生产环境，建议为不同环境分别创建独立 Agent，
> 后续看 Trace 和做评测时会更清晰。

---

## 步骤二：注册第一个模型

进入侧边栏 **配置 → 模型注册**，完成一个可用模型的配置：

1. 点击 **注册首个模型** 或新增模型
2. 选择模型供应商
3. 填入 API Key 与必要的 Endpoint
4. 点击 **测试连接并保存**

   <p align="center">
     <img src="../images/llm.png" alt="Agent Insight 模型注册页面" style="width: 100%; max-width: 1040px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

完成后，你的 Workspace 就具备了后续执行生成、诊断、评测等能力所需的模型依赖。

> **Warning**
> 如果模型连接失败，先不要继续后续步骤。很多分析、评测和 Skill 流程都依赖模型可用。

---

## 步骤三：注册 Agent

进入侧边栏 **Agent Workspace → Agent 管理**：

1. 点击注册 Agent
2. 输入 Agent 名称
3. 根据页面提示填写信息
4. 保存后进入 Agent 详情页

   <p align="center">
     <img src="../images/agent_signup.png" alt="Agent 注册弹窗" style="width: 100%; max-width: 920px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

注册agent是把客户端实际使用的 Agent 注册到平台。只有注册后的 Agent，平台才会展示它的执行数据。
Agent 名称要和客户端中的实际名称一致，例如 `opencode` 默认的agent是 `plan` 和 `build`。

---

## 步骤四：按安装指导完成接入

进入 **配置 → 安装指导**，按页面提示完成接入。

通常你会完成这些动作：

1. 选择当前环境对应的安装方式，例如 **Linux / macOS** 或 **Windows (PowerShell)**
2. 复制页面生成的安装命令

   <p align="center">
     <img src="../images/install_guide.png" alt="安装指导页面" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

3. 在 Agent 所在机器上执行该命令
4. 使用右侧显示的 API Key 和接入信息完成配置

   下面以 `opencode` 作为客户端为例：

   <p align="center">
     <img src="../images/install_client.png" alt="以 opencode 为例的客户端安装输出" style="width: 100%; max-width: 920px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

安装命令会自动写入当前平台地址和 API Key，比手动配置更直接。


---

## 步骤五：验证生成的 Trace

完成安装或配置后，按下面两步验证是否已生成 Trace。

1. 在 `opencode` 中发送一次真实请求，例如执行一个简单任务，让 Agent 实际运行起来。

   下面以 `opencode` 为例：

   <p align="center">
     <img src="../images/opencode_example.png" alt="opencode 请求示例" style="width: 100%; max-width: 1040px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

2. 回到平台，进入 **运行观测 → 链路追踪**，确认是否出现新的 Trace。

   <p align="center">
     <img src="../images/example_trace.png" alt="链路追踪中的 Trace 示例" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

验证时优先确认这些信息：

- 列表里出现新的 Trace 记录
- 能看到执行状态、耗时、Token 等基本指标
- 点进详情后，可以看到 Trace 树和各个 Span
- 如果流程中使用了工具或子 Agent，也能看到对应节点

第一次验证时，不需要追求数据很完整，先确认“**有数据、能展开、能看懂主要步骤**”即可。

确认生成 Trace 后，你就已经完成了平台配置、Agent 注册和接入验证。

> **Warning**
> 如果 30 秒后仍然看不到数据，按下面顺序排查：
>
> 1. 先查看客户端日志文件 `~/.agent-insight/logs/opencode_uploader.log`
> 2. 确认客户端到服务端的网络是否通顺
> 3. 是否选中了正确的 Workspace
> 4. Agent 使用的 API Key / 配置是否来自当前 Agent
>
> 仍无法解决时，可继续参考 [常见问题](./faq)。

## 继续阅读

- 想先看产品整体结构 → [Agent Insight](./home)
- 想补齐基础配置 → [模型注册](./settings/model-registry) / [安装指导](./settings/access-control)
- 想理解平台核心名词 → [核心概念](./concepts)
- 想继续排查和分析线上执行 → [运行观测](./observability/index)
- 想建立第一套离线评测 → [评测中心](./evaluation/index)
- 想沉淀可复用能力 → [Skills 能力](./skills/index)
