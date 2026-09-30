# Agent Insight RAS — pi 平台扩展安装

pi 通过 `~/.pi/agent/extensions/` 下的 TypeScript 扩展（jiti 免编译加载）接入 Agent
RAS。推荐使用安装器一键安装：

```bash
node scripts/install-ras.js --platforms pi
```

安装器会完成：Python runtime 复制与 pip 依赖安装、config.json 写入（含探测到的
libpython 路径）、pi 扩展文件落盘、扩展目录 `npm install`（koffi）。

## 手动安装

1. 复制 `platform_adapter/pi/` 下全部文件到 `~/.pi/agent/extensions/agent-insight-ras/`
   子目录（保持 `bridge/` 子目录结构），并把 `platform_adapter/common/host_actions.js`
   复制为该子目录内 `host_actions.js`；入口源文件 `extension.ts` 改名为 `index.ts`：

   ```
   ~/.pi/agent/extensions/
   └── agent-insight-ras/               # 子目录布局（pi 只加载其中的 index.ts）
       ├── index.ts                     # 入口（源文件 extension.ts 改名）
       ├── host_control.ts
       ├── ras_client.ts
       ├── config_sync.ts
       ├── runtime_root.ts
       ├── host_actions.js
       ├── package.json
       ├── node_modules/                # npm install 产物（koffi）
       └── bridge/
           └── koffi_bridge.ts
   ```

   ⚠️ 不能平铺在 `extensions/` 顶层：pi 会把顶层每个 `*.ts`/`*.js` 都当作扩展
   入口加载（子目录仅识别 `index.ts` 且不再递归），支持文件会被误报
   "does not export a valid factory function"。

2. 改写 `runtime_root.ts` 中的 `RAS_RUNTIME_ROOT` 为安装指纹 runtime 目录的绝对
   路径（跨目录模块解析：扩展目录与 runtime 目录分离，D-002）。
3. 在 `~/.pi/agent/extensions/agent-insight-ras/` 执行 `npm install`（安装 koffi）。
   npm 失败时扩展仍会加载，但 inproc 桥不可用（fail-open，观测静默关闭）。
4. 确认 `~/.agent-insight/ras/config.json` 的 `agent_ras.service.libpython` 指向
   探测到的 libpython（安装器自动写入；缺失时设置环境变量 `RAS_LIBPYTHON`）。

## 日志与观测

| 手段 | 开启方式 | 看什么 |
|-|-|-|
| 宿主侧生命周期日志 | 启动 pi 时 `RAS_DEBUG=1` | stderr 上 `[insight-ras]` 前缀日志：hello/observe 失败、session_start/shutdown、动作投递异常（不含载荷内容） |
| wire 全量日志 | 默认开启；`RAS_DEBUG_WIRE=0` 关闭 | `~/.agent-insight/ras/log/pi-wire.jsonl`：每次 inproc 调用的 `{ts, pid, op, sessionId, request, result}` 原样 JSONL（observe 载荷 = 模型字节流快照；result 含返回的 actions/anomaly）。`tail -f` + `jq` 实时观测 |
| Insight 上报 | config.json `insight` 节（events_url / api_key，安装器写入） | anomaly/action_result 经 HTTP POST 到 `<events_url>`（`/api/ingest/ras-events`），落 Insight SQLite `RasAnomalyEvent` 表；Insight 未启动时 fail-open（不重试堆积） |

隐私说明：wire 日志默认开启（`RAS_DEBUG_WIRE=0` 可关闭），且包含完整对话文本，仅本机排障用；`RAS_DEBUG=1` 关闭时 RAS 不持久化任何会话内容。

## 运行时行为

- 会话键：`pi:<sessionId>`；Insight 侧 taskId 为去掉 `pi:` 前缀的 sessionId。
- 流式文本/思考增量经字符节流采样（32 字符起步、热区 100/40、早期 80），以
  snapshot 模式送 core；工具调用在 `tool_execution_end` 后整体上报。
- abort 观察窗内观测照常（D-003）。
- 通知类动作依赖 `ctx.ui`：`print`/`json` 无 UI 模式下降级为日志 no-op。
- 纠偏（steering）走 `pi.sendUserMessage`：idle 直发触发新 turn，流式中
  `deliverAs: "steer"` 排队。
- pi 无 L3 技能判定能力位（`platform_capabilities.pi.supports_host_skill_judge =
  False`），core 不会下发技能判定请求。

## 验证

```bash
node scripts/install-ras.js --check   # 含 pi 块检查
pi                                    # 任意会话触发观测；RAS_DEBUG=1 pi 可看日志
```
