# MCTS 执行 Trace 非侵入式接入：开发计划

## 1. 实施边界

- 只修改 Agent Insight 仓库。
- 不修改、安装文件到或运行时代码注入 MCTS 仓库。
- 不新增 Prisma model 和摄入 API；新增仅用于分发 collector 制品的 setup API。
- 复用 OTLP traces、Collaboration binding/event、通用 Trace 投影和共享 durable transport。

## 2. 开发阶段

### Phase A：可测试采集核心

1. 新增 MCTS proxy collector 目录和纯函数核心。
2. 实现 run/runtime/checkpoint ledger、稳定 ID、角色分类与 stdout 白名单解析。
3. 将 xGovernor turn/SSE/control 事件转换为 canonical Trace events。
4. 复用共享 Trace writer/uploader 与 Collaboration outbox。

### Phase B：透明网关与启动器

1. 实现 HTTP/HTTPS upstream 透明转发和 SSE chunk 透传。
2. 只对白名单 endpoint 复制有界观察正文；敏感 endpoint 不保存正文。
3. 实现原命令 spawn、`XGOVERNOR_BASE_URL` 子进程覆盖、stdout/stderr tee、信号和退出码透传。
4. 实现启动失败 bypass、状态诊断和进程结束有界 flush。

### Phase C：Agent Insight 摄入

1. 新增 `mcts-xgovernor` OTLP adapter。
2. 注册 adapter 和 reporting channels。
3. 保留 synthetic `task`、capture fidelity、role evidence、Token 和 terminal 状态。
4. 验证 checkpoint 血缘经 Collaboration resolver 定位为 confirmed。

### Phase D：验证与文档

1. 覆盖 ledger、角色分类、stdout、安全、HTTP/SSE 透明性、bypass、outbox、adapter 和关系投影测试。
2. 运行 `npm run test`。
3. 更新用户观测指南和开发者数据流/跨 Session 指南。
4. 询问用户是否启动 dev server，执行浏览器 golden path 与边界用例。

### Phase E：统一安装接入

1. 在安装页增加独立 `MCTS (xGovernor)` 选项，不自动安装 Pi Agent 或 xiaoO。
2. 新增带确定性 SHA-256 的 collector bundle 与安装分发 API，使目标机不依赖源码仓库。
3. 统一 `AGENT_INSIGHT_MCTS_UPSTREAM_URL` 配置优先级，默认 upstream 为 `http://127.0.0.1:8787`。
4. 通用安装脚本负责传入当前账号 API Key、安装 collector、展示 `agent-insight-mcts-run` 使用方式和安装状态。
5. 覆盖选项解析、bundle、分发脚本、安装页展示、账号配置和“不自动添加 runtime collector”的测试。

## 3. 计划文件

| 文件 | 计划变更 |
|-|-|
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/core.cjs` | ledger、SSE、角色、Trace 与关系构建 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/gateway.cjs` | HTTP/SSE 透明代理 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs` | CLI 启动器、bypass、信号和输出透传 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs` | 安装到用户目录并生成可执行入口 |
| `src/app/api/ingest/setup/mcts-xgovernor/**` | collector bundle、校验资产和安装器分发 |
| `src/lib/ingest/setup/install-profile.ts` | 独立安装选项，不声明 Pi/xiaoO 依赖 |
| `src/app/(main)/accessconfig/install/page.tsx` | 安装选择、upstream 配置和命令生成 |
| `src/app/api/ingest/setup/route.ts` | Linux 一键安装 MCTS collector 与结果提示 |
| `src/app/api/ingest/setup/auto/route.ts` | 自动安装入口保持相同的 MCTS 行为 |
| `src/lib/ingest/otel/adapters/mcts-xgovernor.ts` | 专用 OTLP adapter |
| `src/lib/ingest/otel/adapter-registry.ts` | adapter 注册 |
| `src/lib/ingest/adapters/mcts-xgovernor.ts` | framework 展示名称与快照合并契约 |
| `src/lib/ingest/adapters/registry.ts` | framework adapter 注册 |
| `src/lib/ingest/framework-reporting-channels.ts` | 上报通道声明 |
| `test/mcts-xgovernor-proxy.test.ts` | collector/gateway 测试 |
| `test/mcts-xgovernor-adapter.test.ts` | adapter 测试 |
| `docs/user-guide/observability/mcts-xgovernor.md` | 安装、使用、限制和排障 |
| `docs/developer-guide/05-data-and-control-flow.md` | 非侵入式数据流 |
| `docs/developer-guide/13-cross-session-collaboration.md` | checkpoint 血缘关系契约 |
| `docs/developer-guide/INDEX.md` | 文档索引与 working-tree overlay |

## 4. 完成标准

- MCTS 工作区运行前后无 collector 产生的文件变更。
- mock xGovernor 直连与代理的请求/响应/SSE bytes 一致。
- checkpoint owner/load/turn 生成稳定父子 Runtime Trace。
- 无 turn 的临时 checkout 不生成 Agent。
- stdout 未匹配正文不会进入 spool。
- OTLP 与关系重放幂等，Trace 晚到后可解析。
- 安装页单选 MCTS 时只安装 `mcts-xgovernor`，不隐式安装 Pi/xiaoO；安装产物可在无源码 checkout 的目标机生成启动器。
- 自动化测试通过；浏览器验证若未获授权则明确标记未执行。
