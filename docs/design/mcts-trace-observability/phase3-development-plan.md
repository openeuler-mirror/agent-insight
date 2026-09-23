# MCTS 执行 Trace 非侵入式接入：开发计划

## 1. 实施边界

- 只修改 Agent Insight 仓库。
- 不修改、安装文件到或运行时代码注入 MCTS 仓库。
- 不新增 Prisma model 和 API route。
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

## 3. 计划文件

| 文件 | 计划变更 |
|-|-|
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/core.cjs` | ledger、SSE、角色、Trace 与关系构建 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/gateway.cjs` | HTTP/SSE 透明代理 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs` | CLI 启动器、bypass、信号和输出透传 |
| `scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs` | 安装到用户目录并生成可执行入口 |
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
- 自动化测试通过；浏览器验证若未获授权则明确标记未执行。
