# MCTS xGovernor Trace 非侵入式接入

Agent Insight 可以在不修改 MCTS 源码的前提下采集 `/Users/qzh/huawei/openeuler/MCTS` 当前 xGovernor 执行链路。接入由外部启动器完成：启动器在本机回环地址创建透明代理，只给 MCTS 子进程替换 `XGOVERNOR_BASE_URL`，其余命令、工作目录、参数和 xGovernor 协议保持不变。

## 能看到什么

- MCTS coordinator，以及每个真正提交过 turn 的 xGovernor Runtime；
- xGovernor 标准化 turn 的输入、assistant 输出、模型、Token、状态与耗时；
- `tool_activity` 的工具输入、结果摘要和成功/失败状态；
- `checkpoint(A) → load(checkpoint, B) → turn(B)` 证实的 Runtime 父子关系；
- MCTS stdout 中稳定的 startup、choose、node score、final tree 和 official PASS/FAIL 摘要。

Runtime 角色按可验证行为标记为 `solver-initial`、`solver-child`、`author`、`selector`、`memory-helper` 或 `unknown`。采集初期允许暂时显示 `unknown`；后续出现 checkpoint、load、文件读取或 profile 证据后，最终角色会覆盖早期未知状态。始终没有可靠证据时才保留 `unknown`，不会按并发先后猜测。

## 安装

前置条件：Node.js 不低于 22.19.0、Agent Insight 服务可访问、已有当前用户 API Key，xGovernor 已运行。

推荐从 Agent Insight 的“安装指导”页面安装：

1. 只勾选 `MCTS (xGovernor)`；它是独立安装项，不会连带安装 Pi Agent、xiaoO 或 Goal Plus。
2. 填写 MCTS 主机能够访问的 xGovernor 地址，默认是 `http://127.0.0.1:8787`。
3. 在运行 MCTS 的 Linux/macOS 主机执行页面生成的命令。Windows 主机应在 WSL 内安装和运行。

页面生成的命令会使用当前登录账号的 API Key 下载并校验专用安装包，然后创建：

- `~/.agent-insight/collectors/mcts-xgovernor-proxy/`：透明代理运行文件和权限为 `0600` 的配置；
- `~/.local/bin/agent-insight-mcts-run`：包裹原 MCTS 命令的启动器。

安装器不会写入 MCTS 仓库。若 `~/.local/bin` 不在 PATH，可直接使用启动器的完整路径。

在 agent-insight 源码仓库内开发或排查安装器时，也可直接执行：

```bash
AGENT_INSIGHT_API_KEY='<your-api-key>' \
AGENT_INSIGHT_BASE_URL='http://127.0.0.1:3000' \
AGENT_INSIGHT_MCTS_UPSTREAM_URL='http://127.0.0.1:8787' \
node scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs
```

`AGENT_INSIGHT_MCTS_UPSTREAM_URL` 是安装配置的唯一上游环境变量；未设置时使用默认回环地址，不读取旧安装变量。

## 运行 MCTS

把原来的 MCTS 命令原样放在 `--` 后面：

```bash
agent-insight-mcts-run -- \
  bash /Users/qzh/huawei/openeuler/MCTS/run_union.sh \
  --mode sweverified --index 0 --split test
```

临时覆盖 xGovernor 地址：

```bash
agent-insight-mcts-run --upstream http://127.0.0.1:8787 -- <原 MCTS 命令>
```

默认是 fail-open：缺少 API Key 或本地代理启动失败时，启动器提示原因并直接执行原命令。要求观测不可用时拒绝启动，可增加 `--strict`。推理正文默认不采集；明确需要时增加 `--capture-reasoning`。

同一能力也可用环境变量控制：`AGENT_INSIGHT_MCTS_PROXY_ENABLED`、`AGENT_INSIGHT_MCTS_UPSTREAM_URL`、`AGENT_INSIGHT_MCTS_CAPTURE_REASONING`、`AGENT_INSIGHT_MCTS_BYPASS_ON_START_FAILURE` 和 `AGENT_INSIGHT_MCTS_STRICT`。命令行 `--upstream`、`--capture-reasoning`、`--strict` 的优先级更高。

## 数据流与展示

```text
MCTS 子进程
  ├─ stdout ──> 稳定摘要白名单
  └─ xGovernor HTTP/SSE
        └─ 127.0.0.1 透明代理 ──> 原 xGovernor
                 ├─ OTLP Trace ──> Runtime / LLM / Tool
                 └─ Collaboration ──> coordinator / Runtime 父子关系

Agent Insight 链路追踪
  └─ coordinator
       ├─ initial Runtime
       ├─ author / helper Runtime
       └─ checkpoint 派生 Runtime
            └─ LLM / Tool
```

每个 Runtime 使用独立 Trace Session，父子关系通过现有跨 Session binding/event 接口上报。运行期间每 10 秒尝试增量上传，结束时再做一次有界刷新。关系数据和 Trace 可乱序到达；网络失败时本地 spool/outbox 会保留并在后续刷新时重试。

父级的 TASK 行表示一次 Runtime 派生关系，不是另一次 LLM 调用。TASK 的 `session_id` 与子 Runtime 的逻辑 Session ID 精确一致时，子 Agent 会展开在该 TASK 下，并显示子 Trace 的真实耗时；关系尚未定位时显示 `-`，不会把瞬时关系事件误报为 `0ms`。stdout 调度摘要只显示对应的观测/Tool 行，不代表发生了一次模型调用，也不会额外生成 LLM 行。

xGovernor 把工具输入放在 `tool_activity(begin)`、把结果放在 `tool_activity(end)`。透明代理按同一个 activity ID 合并两端，因此 Bash 等工具的 Input 显示实际结构化参数，Output 显示执行结果。若上游未发送 begin，Input 保持空对象并在 Trace 元数据中标记采集缺失；采集到的字段仍经过通用密钥、账号和本地路径脱敏。

## 隐私和边界

- 代理不解析 `exec`、`files/write`、checkpoint delete 等敏感请求正文；`files/read` 只统计调用次数，不保存路径或响应内容。
- checkpoint、Runtime、turn 和 run 标识在本地状态及平台关系中使用稳定摘要，不保存原始 checkpoint ID。
- system prompt 只保留 SHA-256 摘要。推理流默认丢弃。
- stdout 只识别固定格式；未识别行仍原样显示在终端，但不会进入 Agent Insight。
- 观察队列与单 turn 正文都有上限；溢出时继续透传业务流量，保留 terminal 事件，并把 capture fidelity 标为 `degraded`。
- 当前 xGovernor 一次提交只暴露一个标准化 turn；其内部多次 LLM 调用不可从现有协议恢复。
- 并发 MCTS 的 `node_id ↔ runtime_id` 没有稳定协议字段，因此 node score/tree 摘要显示在 coordinator 下，不伪造与 Runtime 的绑定。

本实现不改动 MCTS 文件，但透明代理位于运行时网络路径中。默认启动失败会旁路；运行过程中代理进程异常仍可能导致当前 xGovernor 请求失败，这是剩余风险。

## 排查

启动时 stderr 应出现 `Agent Insight MCTS observer active`。如果平台没有新 Trace：

1. 确认 MCTS 确实通过 xGovernor 发起 `open/load/turns`；
2. 确认 `AGENT_INSIGHT_BASE_URL` 与 API Key 有效；
3. 查看 `~/.agent-insight/otel_data/mcts-xgovernor/<api-key-hash>/` 是否有待上传事件和关系 outbox；
4. 去掉 `--strict` 可验证 MCTS 原命令本身是否正常；
5. 用 `--upstream` 明确指定原 xGovernor 地址，避免安装时配置已过期。
