---
title: "内置示例端到端走查"
description: "用注册即得的内置 messages 日志示例，跑通 智能诊断 → Skill 生成 → 评测 → 优化 的完整闭环。"
---

# 内置示例端到端走查

新用户**首次登录注册时**，平台会自动为你注入一套开箱即用的示例数据，让你不需要先接入任何真实
Agent，就能把核心能力完整体验一遍：**智能诊断 → Skill 生成 → 评测 → 优化**。

本页带你用这套内置示例跑通整条闭环。每一步都链接到对应功能的详细说明，想深入时点进去即可。

> **Note**
> 本页默认你已经能访问看板（如 `http://localhost:3000`），并且已经用邮箱登录过一次
> （登录即注册，内置示例就是在那一刻注入的）。

---

## 你已经拥有的内置示例

注册后无需任何额外操作，你已经具备：

| 资产 | 在哪看 | 说明 |
| --- | --- | --- |
| **messages 日志分析（内置示例）** 数据集 | 评估与实验 → **评测数据集** | `ideal_output` 类型，10 条用例，覆盖认证攻击 / SSH 爆破 / 登录异常等场景。 |
| **linux-messages-auth-triage-demo** Skill | **Skills** 列表 | 内置示例 Skill：离线分析用户提供的 messages 日志，识别认证失败、暴力破解、用户枚举和登录异常（含 references / scripts）。名字带 `-demo`，避免和你之后自己生成的 Skill 撞名。 |
| 三条示例 **Trace** | **链路追踪** | 内置 `messages-log-analyzer` Agent 调用 `linux-messages-auth-triage-demo` Skill 对示例日志做的安全分析（两条成功样例，以及一条因日志路径错误而失败的诊断样例）。进入链路追踪页**默认就能看到**（它们被归到「用户 Agent」视图）。 |
| `~/.agent-insight/example/messages` | 你机器的本地目录 | 一份真实的 Linux `messages` 日志（SSH 爆破、认证失败等）。**注意：它不是注册时就有的**，而是你执行**客户端安装命令**后才落到本地——见下方说明。 |

> **Note**
> 上面前三项（数据集 / Skill / 三条 Trace）在你**注册那一刻**就注入到看板里了，打开即见。
>
> 而 `~/.agent-insight/example/messages` 这个**本地日志文件**，需要你先安装客户端才会出现：
> 在看板 **安装指导** 页复制客户端安装命令（形如 `curl -sSf "http://<看板地址>/api/ingest/setup" | bash`，README「安装客户端」一节也有），在你的机器上执行一次即可。它在建好接入环境的同时，会把这份示例日志下载到 `~/.agent-insight/example/messages`。**想用内置数据集真正跑评测（③）时才需要它**；只是查看已生成的三条 Trace（①）则不需要。
>
> 这套示例数据完全归你所有：可随时编辑或删除。**删除后不会再自动补回**——它只在你注册那一刻注入一次。

---

## 全流程一览

```
链路追踪 (看到 Skill 驱动的示例 Trace)
      │
      ▼
① 智能诊断 ── 读懂 Skill 是怎么分析日志的、结论质量如何
      │
      ▼
② Skill 生成 ── 了解"messages 认证攻击三连诊断"如何沉淀成 linux-messages-auth-triage
      │
      ▼
③ 评测（用例分析） ── 用内置数据集量化 Skill 的真实效果
      │
      ▼
④ Skill 优化 ── 用评测暴露的问题迭代 Skill，再回到 ③ 复评
```

---

## ① 智能诊断：读懂示例 Trace

1. 左侧导航进入 **链路追踪**。默认筛选为「用户 Agent」，你会直接看到三条内置示例 Trace
   （Agent 名 `messages-log-analyzer`，调用内置的 `linux-messages-auth-triage-demo` Skill 对
   `~/.agent-insight/example/messages` 做的安全分析）。
2. 点开任意一条，进入 **智能诊断** 视图。重点看：
   - **执行摘要区**：这次分析用了哪个模型、耗时、token，以及调用了哪个 Skill。
   - **执行链路 / 节点列表**：Agent 在 Skill 指引下实际做了哪些步骤（读日志、按来源 IP 聚合、
     定位 root 爆破、给出处置建议等）。
   - **智能诊断结果区**：平台对这条 Trace 的归因与质量评估——既能看到 Skill 把分析做对的地方，
     也能发现仍可改进的点（如某类登录异常漏报、IP 聚合不够准）。
3. 记下这些可改进点——它们正是后面 **评测 → 优化** 要量化和迭代的目标。

> 详见 [智能诊断](/user-guide/observability/diagnosis) 与 [查看链路](/user-guide/observability/view-traces)。

---

## ② Skill 生成：把诊断经验沉淀成 Skill

进入 **持续优化 → Skill**，新建工作台会话并点击 **生成一个 Skill**。在左侧输入区选择模型和场景，然后把下面这段**示例需求**完整复制粘贴并发送。它把
Loghub Linux 数据集里「认证失败 / 暴力破解」相关的事件模板与严重度分级直接喂给生成器，让产出的
Skill 能精确识别并归类这些事件、输出准确结论：

```text
你帮我生成一个 skill，该 skill 用于对离线 Linux messages 日志文件进行提取分析。
必须注意：这里的日志分析是离线分析，不是在目标 Linux 系统上进行实时排查。用户已经将 Linux 主机中的 /var/log/messages 或相关 messages 日志文件拉取到本机后，再提供给 skill 进行分析。
该 skill 只能基于用户提供的离线日志文件或日志文本内容进行分析，不得假设当前运行环境就是被分析的 Linux 主机，不得登录目标 Linux 主机，不得执行依赖目标系统状态的命令，也不得擅自读取当前机器上的系统日志。
该 skill 必须严格按照 skill 中定义的 step 顺序执行分析流程，不允许跳过 step，不允许自行简化流程，不允许在未完成前置 step 的情况下直接给出结论。每一步都必须基于前一步的结果继续分析，最终结论必须来自日志原文中的可验证证据。
如果日志中不存在相关事件，则明确说明未发现对应事件，不允许编造分析结果，不允许基于经验进行无证据推断。所有风险判断、攻击判断和诊断结论都必须能够在日志内容中找到对应依据。
该 skill 需要实现如下实践的分析整理，可以快速诊断如下的认证失败 / 暴力破解等相关问题，输出准确结果：
## Loghub Linux 数据集：认证失败 / 暴力破解相关事件清单
| EventId | EventTemplate | 含义解释 |
|---|---|---|
| **E13** | Authentication failed from <*> (<*>): Permission denied in replay cache code | Kerberos 重放缓存拒绝认证。Kerberos 为防重放攻击会缓存最近的票据，若收到重复请求会拒绝 |
| **E14** | Authentication failed from <*> (<*>): Software caused connection abort | 认证过程中客户端中断连接，常见于爆破脚本超时或网络异常 |
| **E15** | authentication failure; logname= uid=0 euid=0 tty=:0 ruser= rhost= | 本地图形界面（tty=:0 即 X server）认证失败，通常是本地用户输错密码 |
| **E16** | authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=<*> | SSH 认证失败（未指定用户名），攻击者在盲试密码 |
| **E17** | authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=<*>  user=guest | SSH 认证失败，明确针对 **guest** 账户 |
| **E18** | authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=<*>  user=root | SSH 认证失败，明确针对 **root** 账户——爆破首要目标 |
| **E19** | authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=<*>  user=test | SSH 认证失败，明确针对 **test** 账户 |
| **E27** | check pass; user unknown | PAM 检查发现**用户名不存在**，但仍走完密码检查流程（防用户名枚举） |
| **E31** | Couldn't authenticate user | 通用认证失败消息，未指明具体原因 |
| **E61** | Kerberos authentication failed | Kerberos 协议层认证失败，说明主机接入了 Kerberos/AD 域 |
| **E29** | connection from <*> (<*>) at <*>:<*>:<*> | 远程连接接入事件（FTP/SSH），记录来源 IP/主机名/时间 |
| **E9** | ANONYMOUS FTP LOGIN FROM <*>,  (anonymous) | FTP 匿名登录成功，记录来源 IP |
| **E101** | session closed for user <*> | 用户会话关闭（注销） |
| **E102** | session opened for user <*> by (uid=<*>) | 用户会话开启（成功登录） |
| **E103** | session opened for user <*> by LOGIN(uid=<*>) | 由 LOGIN 程序（本地登录）打开的会话 |
| **E91** | ROOT LOGIN ON tty2 | root 用户通过物理控制台 tty2 登录——高敏感事件 |
| **E112** | User unknown timed out after <*> seconds at <*>:<*>:<*> <*> | 不存在的用户登录尝试超时 |
| **E116** | warning: can't get client address: Connection reset by peer | 无法获取客户端地址，连接被对端重置 |
## 按严重程度分类速查
| 严重度 | EventId | 说明 |
|---|---|---|
| 🔴 高（直接失败证据） | E13, E14, E15, E16, E17, E18, E19, E27, E31, E61 | 任何一条都表示有人尝试登录被拒 |
| 🟡 中（攻击上下文） | E9, E29, E101, E102, E103 | 连接和会话事件，配合🔴看才有意义 |
| 🟢 低（敏感操作） | E91, E112, E116 | 单独不构成攻击，但需审计关注 |
```

生成完成后：

- 在右侧 **Skill 详情**检查 `SKILL.md`、`scripts/`、`references/` 是否符合预期，命名建议为
  `linux-messages-auth-triage`（不带 `-demo`，这样它和内置的 `linux-messages-auth-triage-demo`
  示例 Skill 并存、互不覆盖）。
- 打开 **Skill 评估**运行静态质量评估；高风险问题修复并通过门禁后，发布该 Skill，使其可用于后续实验。

> **Tip**：如果你只想先把流程跑通、不想现在生成，也可以**跳过这一步**——内置的
> `linux-messages-auth-triage-demo` 已经是一个可用的成品 Skill，直接拿它进入 ③ 评测即可。

> 详见 [Skill 生成](/user-guide/skills/generate)。

---

## ③ 评测：用内置数据集验证 Skill 效果

这一步直接复用内置的 **messages 日志分析（内置示例）** 数据集。

1. 在 Skill 工作台顶部选择你上一步发布的 `linux-messages-auth-triage`，或内置的 `linux-messages-auth-triage-demo` 及目标版本。
2. 打开 **Skill 实验**，点击 **新建用例实验**。
3. 在统一四步向导中选择 Agent、**messages 日志分析（内置示例）**数据集、运行主机/模型、Case 和评估器，然后开始实验。
4. 在用例分析结果页查看任务结果分、轨迹质量、冻结配置和每条 Case 的执行结果，
   量化 `linux-messages-auth-triage` 在整个数据集上的表现，定位仍然失败或低分的用例。
   想直接对比"有 Skill vs 无 Skill"的差异，可再跑一次 **A/B 测试**（见下方 Tip）。

> **Tip**
> 想做"有 Skill vs 无 Skill"的成对对照，可以用 **A/B 测试**；想验证 Skill 是否在该触发时触发，
> 用 **触发分析**。详见 [用例分析](/user-guide/skills/evaluation/use-case-analysis)、
> [A/B 测试](/user-guide/skills/evaluation/ab-test)、[触发分析](/user-guide/skills/evaluation/trigger-analysis)。

---

## ④ Skill 优化：用评测证据迭代

1. 在 Skill 工作台顶部选择目标 Skill `linux-messages-auth-triage` 与基线版本。
2. 从 **Skill 评估**的高风险问题点击 **AI 修复问题**，或在左侧点击 **Skill 优化**并补充实验发现。
3. 观察 Copilot 归并优化依据、生成候选版本并执行静态质量校验。
4. 打开右侧 **优化记录**，检查优化摘要、质量校验和逐文件 diff。
5. 发布门禁通过的候选，再回到 **Skill 实验**使用相同数据集和评估器复测。

> 详见 [Skill 优化](/user-guide/skills/optimize)。

---

## 跑完之后

完成这一圈，你已经体验了 Agent Insight 的主干能力：

- 用 **链路追踪 + 智能诊断** 发现问题；
- 用 **Skill 生成**把经验固化成可复用的 Skill；
- 用 **评估与实验** 量化 Skill 的真实效果；
- 用 **Skill 优化**基于证据持续迭代。

接下来，把这套闭环换成你自己的 Agent 与数据即可：先在 [5 分钟上手](/user-guide/quickstart)
里接入真实 Agent，再用 [评估与实验](/user-guide/evaluation/index) 建立你自己的数据集与评测任务。
