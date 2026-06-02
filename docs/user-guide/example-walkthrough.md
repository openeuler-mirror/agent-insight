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
| `~/.agent-insight/example/messages` | 你机器的本地目录 | 一份真实的 Linux `messages` 日志，包含 SSH 爆破、认证失败等安全事件。客户端执行 `curl … \| bash` 安装时自动下载放置。 |
| **messages 日志分析（内置示例）** 数据集 | 评测中心 → **数据集** | `ideal_output` 类型，10 条用例，覆盖认证攻击 / SSH 爆破 / 登录异常等场景。 |
| 两条示例 **Trace** | **链路追踪** | 内置 `messages-log-analyzer` Agent 调用 `linux-messages-auth-triage` Skill 对示例日志做的安全分析（一条聚焦 root SSH 爆破、一条做整体安全评估）。进入链路追踪页**默认就能看到**（它们被归到「用户 Agent」视图）。 |

> **Note**
> 这套示例数据完全归你所有：你可以随时编辑或删除。**删除后不会再自动补回**——它只在你注册那一刻注入一次。

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

1. 左侧导航进入 **链路追踪**。默认筛选为「用户 Agent」，你会直接看到两条内置示例 Trace
   （Agent 名 `messages-log-analyzer`，调用 `linux-messages-auth-triage` Skill 对
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

进入 **Skills 生成**，配置生成条件，然后把下面这段**示例需求**完整复制粘贴到需求框并提交。它把
Loghub Linux 数据集里「认证失败 / 暴力破解」相关的事件模板与严重度分级直接喂给生成器，让产出的
Skill 能精确识别并归类这些事件、输出准确结论：

```text
你帮我生成一个skill，该skills实现对linux的messages日志进行提取分析，实现如下实践的分析整理，可以快速诊断如下的认证失败 / 暴力破解等相关问题，输出准确结果：
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

提交后：

- **核对生成结果**：检查 `SKILL.md`、`scripts/`、`references/` 是否符合预期，命名建议为
  `linux-messages-auth-triage`。
- **下载或发布** 该 Skill，使其可被后续评测引用。

> 详见 [Skills 生成](/user-guide/skills/generate)（该页含一个 `linux-auth-triage` 的完整示例走查）。

---

## ③ 评测：用内置数据集验证 Skill 效果

这一步直接复用内置的 **messages 日志分析（内置示例）** 数据集。

1. 进入 **Skill 评测 → 用例分析**。
2. 在 **① 配置** 区：
   - 选择上一步的 Skill `linux-messages-auth-triage`；
   - 数据集选择 **messages 日志分析（内置示例）**；
   - 新建或选择一个评测任务，按需勾选评估器。
3. 在用例列表里勾选若干 case，点击 **▶ 开始评测**。平台会用所选 Skill 真实执行这些用例并自动评测。
4. 在 **② 评测执行 / ③ 分析结果** 区查看每条用例的执行 Trace、通过/失败状态与评分，
   量化 `linux-messages-auth-triage` 在整个数据集上的表现，定位仍然失败或低分的用例。
   想直接对比"有 Skill vs 无 Skill"的差异，可再跑一次 **A/B 测试**（见下方 Tip）。

> **Tip**
> 想做"有 Skill vs 无 Skill"的成对对照，可以用 **A/B 测试**；想验证 Skill 是否在该触发时触发，
> 用 **触发分析**。详见 [用例分析](/user-guide/skills/evaluation/use-case-analysis)、
> [A/B 测试](/user-guide/skills/evaluation/ab-test)、[触发分析](/user-guide/skills/evaluation/trigger-analysis)。

---

## ④ Skill 优化：用评测证据迭代

1. 进入 **Skills 优化**，选择目标 Skill `linux-messages-auth-triage` 与基线版本。
2. 在左侧 **可优化点列表** 审阅来自评测 / 线上的问题（如"漏报某类登录异常""来源 IP 聚合不准"），
   圈定本轮要修的范围。
3. 配置执行参数并**启动优化 Agent**，观察它就地修改 Skill 文件的过程。
4. 在右侧 **diff 面板** 预览多版本改动并评审，满意后产出新版本。
5. 回到 **③ 评测**，对新版本复评，确认问题确实被修掉、且没有引入回退。

> 详见 [Skills 优化](/user-guide/skills/optimize)。

---

## 跑完之后

完成这一圈，你已经体验了 Agent Insight 的主干能力：

- 用 **链路追踪 + 智能诊断** 发现问题；
- 用 **Skills 生成** 把经验固化成可复用的 Skill；
- 用 **评测中心** 量化 Skill 的真实效果；
- 用 **Skills 优化** 基于证据持续迭代。

接下来，把这套闭环换成你自己的 Agent 与数据即可：先在 [5 分钟上手](/user-guide/quickstart)
里接入真实 Agent，再用 [评测中心](/user-guide/evaluation/index) 建立你自己的数据集与评测任务。
