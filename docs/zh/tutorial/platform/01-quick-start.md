---
title: "5 分钟上手"
description: "登录看板、注册模型、创建 Agent、完成接入，并在 UI 中看到第一条链路。"
keywords: ["Agent Insight", "智能体接入", "部署配置", "链路追踪"]
changefreq: monthly
---


<a id="5-分钟上手"></a>
本指南带你用最短路径跑通 Agent Insight 的第一条完整闭环：完成基础配置、接入一个 Agent，并在平台里看到真实链路。

登录后可直接点击左侧 **快速开始**。页面按 **快速接入、运行观测、评估与实验、诊断分析、持续优化** 五个阶段汇总当前可用入口；下面的步骤是“快速接入”阶段的完整操作说明。

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
- 按所选框架安装指南准备对应运行时

---

<a id="可选：用-docker-部署服务端"></a>
<a id="可选用-docker-部署服务端"></a>
<a id="用法一：在线拉取-docker-hub-镜像"></a>
<a id="用法一在线拉取-docker-hub-镜像"></a>
<a id="用法二：离线导入-`-tar`-镜像"></a>
<a id="用法二离线导入-tar-镜像"></a>
<a id="用法三：挂载源码运行，代码更新后重启即可生效"></a>
<a id="用法三挂载源码运行代码更新后重启即可生效"></a>

## 可选：部署服务端

尚未部署看板时，先按 [Docker 部署指南](../../how-to/platform/deploy-docker.md)完成部署，再继续本教程。已有服务的用户直接使用管理员提供的地址。

## 推荐路径

对于大多数用户，建议按下面顺序操作：

1. 登录看板并进入当前 Workspace

2. 在 **模型注册** 中先配置模型
3. 在 **运行观测 → Agent 概览** 中创建一个 Agent
4. 在 **配置 → 客户端安装** 中完成接入
5. 触发一次真实执行
6. 在 **链路追踪** 中确认第一条 Trace

> **Tip**
> 如果需要在代码中接入，请先查[Trace HTTP 接入](../../reference/observability/trace-ingestion.md)和对应框架指南，确认使用的协议及身份。

> **Agent RAS 前置条件**
>
> Linux、WSL 或 macOS 上需要 Python 3.10+、pip 和共享 libpython。OpenCode 1.x 安装指导
> 默认安装 RAS，可设置 `AGENT_INSIGHT_RAS=0` 跳过。原生 Windows 暂不启用 inproc，
> 请在 WSL 中运行 OpenCode 和安装命令。

---

## 步骤一：登录并确认 Workspace

1. 打开你的 Agent Insight 看板地址。

   <p align="center">
     <img src="../../../images/home.png" alt="Agent Insight 看板首页" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

2. 根据部署模式完成登录，进入默认 Workspace。
   - 默认 `LOGIN_MODE=standalone`：在登录页输入邮箱。
   - `LOGIN_MODE=idaas_oauth`：点击“统一身份登录”，在 IDaaS 完成认证；平台使用 IDaaS 返回的唯一 UUID 作为本地账号和数据归属；人员接口返回账号别名时，侧边栏优先显示该别名，否则显示 UUID；用户可从侧边栏退出当前网页账号，再次登录仍进入统一身份授权。
   - 历史 `ORGANIZATION_MODE=true`：继续使用原组织网关和 Cookie 登录，不等同于 IDaaS OAuth 登录。

   使用 `scripts/develop_start.sh` 启动时，IDaaS OAuth 模式只检查状态接口确认服务就绪，不会创建 `admin` Key；已有客户端 Key 保持不变，没有 Key 时在首次登录后从安装指导获取。

   OpenCode 上报使用的 API Key 必须属于当前登录账号，否则普通链路与可靠性链路都会因
   用户归属不同而不可见。本地 keyless 开发模式如设置
   `AGENT_INSIGHT_DEFAULT_INGEST_USER`，其值也应与实际 `User.username` 一致：
   standalone 模式使用邮箱，IDaaS 模式使用 UUID，不要填写无对应登录账号的 `admin` 别名。
3. 确认左侧导航中可以看到以下模块：
   - **快速开始**
   - **运行观测**
   - **Agent 概览**
   - **评估与实验**
   - **诊断分析**
   - **持续优化**
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
     <img src="../../../images/llm.png" alt="Agent Insight 模型注册页面" style="width: 100%; max-width: 1040px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

完成后，你的 Workspace 就具备了后续执行生成、诊断、评测等能力所需的模型依赖。

> **Warning**
> 如果模型连接失败，先不要继续后续步骤。很多分析、评测和 Skill 流程都依赖模型可用。

---

## 步骤三：注册 Agent

进入侧边栏 **运行观测 → Agent 概览**：

1. 点击注册 Agent
2. 输入 Agent 名称
3. 根据页面提示填写信息
4. 保存后进入 Agent 详情页

   <p align="center">
     <img src="../../../images/agent_signup.png" alt="Agent 注册弹窗" style="width: 100%; max-width: 920px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

注册agent是把客户端实际使用的 Agent 注册到平台。只有注册后的 Agent，平台才会展示它的执行数据。
Agent 名称要和客户端中的实际名称一致，例如 `opencode` 默认的agent是 `plan` 和 `build`。

---

## 步骤四：通过客户端安装完成接入

进入 **配置 → 客户端安装**，按页面提示完成接入。

通常你会完成这些动作：

1. 选择要接入的 Agent 框架
2. 复制页面生成的 **Linux curl** 命令

   <p align="center">
     <img src="../../../images/install_guide.png" alt="客户端安装页面" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

3. 在 Agent 所在 Linux 主机的 Bash / Zsh 终端执行该命令
4. 核对脚本配置结果；命令已包含当前账号 API Key，无需再次手工输入

   下面以 `opencode` 作为客户端为例：

   <p align="center">
     <img src="../../../images/install_client.png" alt="以 opencode 为例的客户端安装输出" style="width: 100%; max-width: 920px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

安装命令会自动写入当前平台地址和 API Key，比手动配置更直接。
框架和版本差异、共享模块升级与 OpenCode 1.x/2.x 迁移说明见[客户端兼容性参考](../../reference/observability/client-compatibility.md)。遇到能力未上报或 Trace 入库超时，按该参考和对应框架指南排查。


---

## 步骤五：验证生成的 Trace

完成安装或配置后，按下面两步验证是否已生成 Trace。

1. 在 `opencode` 中发送一次真实请求，例如执行一个简单任务，让 Agent 实际运行起来。

   下面以 `opencode` 为例：

   <p align="center">
     <img src="../../../images/opencode_example.png" alt="opencode 请求示例" style="width: 100%; max-width: 1040px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

2. 回到平台，进入 **运行观测 → 链路追踪**，确认是否出现新的 Trace。

   <p align="center">
     <img src="../../../images/example_trace.png" alt="链路追踪中的 Trace 示例" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
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
> 4. 客户端使用的 API Key / 配置是否属于当前登录账号
>
> 仍无法解决时，可继续参考 [常见问题](../../how-to/platform/faq.md)。

## 继续阅读

- 想先看产品整体结构 → [Agent Insight](../../explanation/platform/product-overview.md)
- 想补齐基础配置 → [模型注册](../../how-to/platform/settings/model-registry.md) / [客户端安装](../../how-to/platform/settings/access-control.md)
- 想理解平台核心名词 → [核心概念](../../explanation/platform/core-concepts.md)
- 想继续排查和分析线上执行 → [运行观测](../../explanation/observability/overview.md)
- 想建立第一套离线评测 → [评估与实验](../../explanation/evaluation/overview.md)
- 想沉淀可复用能力 → [Skill 工作台](../../explanation/optimization/skills/workbench-overview.md)

[English](../../../en/tutorial/platform/01-quick-start.md)
