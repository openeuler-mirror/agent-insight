---
title: "故障注入与评测"
description: "安装 FI Worker、创建注入任务、查看采集事实，并通过实验选择评估器评分。"
keywords: ["Agent Insight", "故障注入", "FI Worker", "可靠性评测"]
changefreq: monthly
---

# 故障注入与评测

故障注入（Agent FI）用于在**真实 Agent 宿主**上主动植入故障模式，FI 仅记录注入与采集事实，评分由实验中**显式选择的评估器**完成，不再自动运行独立 FI Judge。编排与展示在平台侧；注入执行在本机 **FI Worker**。

> **Note**
> 侧栏入口在 **AgentRAS 可靠性** 下的「故障注入与评测」（`/agent-ras/fault-injection/tasks`）。  
> 它与「可靠性能力」页（`/agent-ras/fault-modes`）不同：后者管**环内检测/恢复**开关；本页管**主动注入评测任务**。

## 和环内 RAS 的区别

| | 故障注入（本页） | 可靠性能力 / 可靠性观测 |
|--|------------------|-------------------------|
| 目的 | 主动注入故障，验证检测/恢复与 Agent 行为 | 环内实时检测与自动恢复；事后回放异常 |
| 入口 | `/agent-ras/fault-injection/tasks`、`/faults` | `/agent-ras/fault-modes`、`/agent-ras/trace` |
| 执行位置 | 本机 FI Worker + 被测 Agent | Agent 进程内 RAS（inproc） |
| 评判 | 在实验中选择评估器；FI 采集自身不调用 LLM | 环内检测与处置保持原有链路 |

注入实验**不依赖**是否已安装 RAS：FI Worker 只跑本机 FI CLI，不会为评测去启动 RAS。若本机已挂 RAS，宿主侧可自然旁路检测/恢复，那是安装面结果，不是 FI 任务的一部分。

设计关系见 [Insight · RAS · FI](../../../explanation/reliability/agent-fault-injection/modules/ras-fi-insight-relationship.md)。

## 前置条件

1. 可访问 Insight 看板，并已登录（standalone 使用邮箱账号；IDaaS 内部使用 UUID 归属数据，侧边栏可显示人员账号别名）
2. 被测 Agent 的模型连接可用；只有选用 LLM 评估器时，才需要额外配置 Insight 评测模型，FI 采集不依赖它
3. 本机已安装 **OpenCode** 和/或 **xiaoO**（须与 Worker 同机）
4. 当前账号的 **API Key**（设置 / 安装指导中创建；Worker 心跳按用户隔离）
5. 本机有支持 `venv` 的 Python 3.11+；安装器只用它创建 FI 专用虚拟环境，不向系统 Python 安装包

## 最短路径

### 1. 安装本机 FI Worker

打开 `/agent-ras/fault-injection/tasks/new`。若无在线 Worker，页面会给出安装命令；在本机执行（**以页面生成的命令为准**）：

```bash
curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
```

- `$API_KEY` 必须是**当前登录账号**的 API Key。
- setup 会把 Worker **后台常驻**；日志默认 `~/.agent-insight/fault-injection/worker.log`。前台排障可加 `--foreground`。
- FI 引擎安装在 `~/.agent-insight/fault-injection/runtimes/<id>/venv/`；Homebrew/PEP 668 Python 不需要开放全局 pip。
- 无在线 Worker 时，新建任务向导中平台不可选、无法下一步。

最短启用：[FI getting-started](../../../tutorial/reliability/agent-fault-injection/01-getting-started.md)。\
本机 curl 逐步说明（落盘目录、Worker 生命周期、排障）：[FI local-install-process](./local-install-process.md)。\
RAS 侧对应说明：[RAS local-install-process](../agent-ras/local-install-process.md)。

### 2. 新建注入任务

侧栏 **故障注入与评测** → **注入任务** → **新建任务**，三步向导：

1. **平台**（来自在线 Worker 心跳里的 inventory：Worker 启动时跑 `platform inventory --json`，枚举本机真实 agents/models。无 Worker 时 health/platforms 只给安装引导，**不**静默填假目录）
2. **故障模式 + 子模式**
3. **配置**（提示词、超时等）

创建后任务一律 `queued`，由本机 Worker claim 后执行。任务列表支持行级 **停 / 再跑 / 删**。

所有故障统一使用「使用 <Skill 名称> 技能，执行<子模式名称>。」生成执行提示词；未选择子模式时只指定 Skill，用户补充要求追加在后面。所有注入 Skill 都会安装并提供给 Agent，不再使用 `task_prompt` 或隐藏开关。审查 `target.py`、读取 `a.txt`、执行 `report.csv` 流水线等具体任务写在对应 Skill 的执行步骤中，加载后即可执行。

健康客户端执行中的长任务会保留认领，不会仅因领取已超过 5 分钟而重复启动；客户端也会忽略同一 Run 的重复活动领取。

FI 运行只关联本次业务 Agent 的主会话；RAS 内部判定或标题生成会话不会替代业务 Trace。

故障目录新增 `skill-rule-conflict`（CSV 规范化规则冲突）和 `reasoning-no-progress`（真值者双解、汉诺塔约束、路径规划复核三个回环），原 `analysis-paralysis` 保留。`thinking-dead-loop` 三个子模式统一为字符重复死循环、语义重复死循环和逻辑连续崩溃。

旧 `compositional-implicit-intent` 场景和机械 verifier 已移除。检测与恢复效果由所选可靠性评估器结合业务 Trace 和 RAS 事件判定；注入完成不代表故障已恢复。工具参数与 Skill 选择改写只触发第一次匹配调用，内部改写诊断不会作为工具结果暴露给 Agent。

### 3. 看故障目录（可选）

标题右上角 **故障目录** → `/agent-ras/fault-injection/faults`：按子模式拆行；点「注入方式」可看 Skill 说明。  
不要与侧栏「可靠性能力」混淆。

### 4. 查看采集进度与实验评测

实验详情先展示 Agent 执行与 Trace 入库进度，再展示本实验选择的评估器结果。FI 的 `completed` 仅表示带有平台 Session ID 的采集结果已接收，不表示故障发生、恢复成功或评分通过；`faultActivated` 仅记录注入是否激活。FI 采集不生成额外判定，不再因等待 FI Judge 而持有客户端槽位。

业务 Trace 仍由普通采集器独立上传。实验编排按原有业务 Agent、有效回复和结束状态检查 Trace，就绪后才启动所选评估器；终态采集的 Trace 回传宽限期仍为 180 秒。采集完成但 Trace 迟到期间显示等待 Trace，最终缺失仍作为 Trace 生成失败处理。

OpenCode 的 `MessageAbortedError` 与采集产物中的 `fault_intercepted` 只说明生成被中断，不单独证明检测正确或恢复成功。新 FI 流水线只有请求、开始、完成三个注入节点；历史评判数据和标记只读保留。旧 `POST /api/fault-injection/runs/:runId/rejudge` 返回 `410 FI_JUDGE_REMOVED`，不会再发模型请求。

本机产物目录（排障用；权威数据在平台 DB）：

```text
~/.agent-insight/fault-injection/artifacts/<runId>/
```

### 5. 停止任务

- `queued`：立即 stopped  
- `collecting`：置 `stopRequested`，Worker 杀本机进程组  

## 真跑冒烟建议

| 平台 | fault | submode |
|------|-------|---------|
| opencode | `thinking-dead-loop` | `2`（语义重复死循环） |
| xiaoo | `thinking-dead-loop` | `2`（语义重复死循环；核对 `faultActivated`、RAS 事件与业务 Trace，再运行所选评估器） |
| xiaoo | `tool_repeat_dead_loop` | `2`（unknown） |

超时建议 60–180s。本地 CLI 排障也可用（不经 Worker）：

```bash
~/.agent-insight/fault-injection/runtimes/<runtime-id>/venv/bin/python -I \
  -m agent_fault_injection.cli run \
  --platform opencode --agent build \
  --fault thinking-dead-loop --submode 2 \
  --prompt "执行场景2 / case2 / 语义重复死循环" \
  --workspace ~/.agent-insight/fault-injection/workspaces \
  --output-dir ~/.agent-insight/fault-injection/artifacts \
  --timeout-seconds 90
```

禁止把仓库根当作 workspace base。

## 常见注意点

- **看板登录用户 ≡ Worker 配置里的 API Key 对应用户**。用 admin 跑实验时，Worker 也必须用 admin 的 Key 安装/启动；否则可靠性编排会返回 503（无在线 FI Worker），而不是静默跳过注入。
- **注入不会**为「可靠性观测」合成 `RasAnomalyEvent`；`/agent-ras/trace` 以正常轨迹（Execution）+ 真 RAS 上报为准。日常完整链路 ⓪ **不是** FI collect：OpenCode 靠 Insight 观测插件 upload；xiaoO 需 `node scripts/xiaoo-trace-collector/install.js`（`install-ras` 装 hooker 后也会自动调用）。
- 部分运行时注入能力（如工具参数改写）可能**仅部分平台**支持；目录与设计文档会标明差异。
- Worker 换账号 Key 重跑 setup 时会按新凭证重启；同 Key/host 再跑则保持已有进程。
- 本地探测看板请优先 `curl --noproxy '*' http://127.0.0.1:<port>/...`（企业代理下可避免 loopback 被误代理）。

## 下一步

- 环内异常回放： [链路追踪 / 可靠性观测](../../observability/view-traces.md)
- 开发者新增故障模式： [故障模式插件化](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/fault-mode-plugins.md)
- 模块设计入口： [docs/zh/explanation/reliability/agent-fault-injection](../../../explanation/reliability/agent-fault-injection/navigation.md)
