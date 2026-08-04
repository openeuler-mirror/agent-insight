# OpenCode adapter — INSTALL

## Capability

See [docs/agent-ras/designs/modules/platform-adapter.md](../../../docs/agent-ras/designs/modules/platform-adapter.md) and [docs/agent-ras/designs/architecture.md](../../../docs/agent-ras/designs/architecture.md).

- **Has**: `message.part.updated` / tool hooks → `ras_embed`/`core`（L1/L2）；恢复经 L3 [`host_control.js`](./host_control.js)：
  - `abort_stream` → `session.abort`（兼容 SDK **v2** `{ sessionID }` 与 **v1** `{ path: { id } }`，按序尝试）+ 可选 `session.interrupt` API + 双次 `tui.executeCommand(session.interrupt)`；限频重试与升级告警
  - `emit_notice` → `tui.showToast({ message, variant, title?, duration? })`（扁平字段）→ fallback `tui.publish` / `noReply` prompt；**正文原样来自 core**，禁止展示 anomaly.summary
  - `push_steering` → idle 后 `session.prompt({ sessionID, parts })`（正文原样，含 `<system-reminder>`）；若 abort 已先到 idle，则立即注入（避免竞态丢恢复）
  - abort 升级文案 → hello 下发的 `host_messages.platform_abort_unconfirmed_user_notice`
- **Does not have**: chunk suppress、同构 StreamBus、deep mid-stream abort

> SDK 注意：插件注入的 client 可能是 v1 或 v2。**只传一种 abort 参数会 500 / falsy，流继续跑完**。`tui.executeCommand("session.interrupt")` 还要求 TUI focus，且需连按两次才 `session.abort`，不能当唯一停流手段。

分层：检测在同进程 `ras_embed`/`core`；**OpenCode API 只出现在本目录 Host**，由 common `applyActions` 调度。

## Install（一条命令）

在 Agent Insight 仓库根目录执行：

```bash
node scripts/install-ras.js
```

npm 安装使用：

```bash
npx agent-insight install-ras
```

安装器会依次完成：

1. 检查 Python 3.10+、pip 和共享 libpython；
2. 把运行时复制到 `~/.agent-insight/ras/runtime/<fingerprint>/`，仅安装基础 Python 包；
3. 写入 `~/.config/opencode/plugins/agent-insight-ras.js`；
4. 幂等合并 `ras-judge` 和插件注册；
5. 保留用户阈值并更新 `~/.agent-insight/ras/config.json` 的 inproc 路径与 Insight 鉴权。

设置 `AGENT_INSIGHT_RAS=0` 可跳过自动安装。原生 Windows 暂不支持 inproc，请在
WSL 中执行；安装器会明确返回 `unsupported`，不影响 Agent Insight 看板运行。

### 同进程（inproc）测试

当前只保留 inproc 路径。安装器会生成配置；如需手工测试，可检查并调整：

```bash
mkdir -p ~/.agent-insight/ras
cp config/agent_ras.inproc.example.json ~/.agent-insight/ras/config.json
# 按本机改 libpython / python_home / repo_root
opencode    # 可直接启动；桥接层会 RTLD_GLOBAL 加载 libpython，无需 LD_PRELOAD
./scripts/smoke_inproc.sh
```

说明见 [`config/README.md`](../../config/README.md)。

安装器会幂等合并 `~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["./plugins/agent-insight-ras.js"]
}
```

## 配置改哪里

主配置文件：`~/.agent-insight/ras/config.json` → `agent_ras`：

```json
{
  "agent_ras": {
    "enabled": true,
    "service": {
      "transport": "inproc",
      "python": "/home/iceory/miniconda3/bin/python3",
      "libpython": "/home/iceory/miniconda3/lib/libpython3.13.so",
      "python_home": "/home/iceory/miniconda3",
      "repo_root": "/home/iceory/.agent-insight/ras/runtime/<version>",
      "python_packages": "/home/iceory/.agent-insight/ras/runtime/<version>/.python-packages"
    },
    "llm_thinking_loop": {
      "detection_start_chars": 30000,
      "window_max_chars": 2000,
      "loop_repeat_threshold": 5,
      "similar_clause_sim_threshold": 0.95,
      "semantic_content_enabled": true
    }
  }
}
```

改完后**新开一轮对话**（或重启 OpenCode）才会 `hello` 带上新阈值。联调 L1/L2 可把 `detection_start_chars` 临时改成 `200`～`500`。

### L3 语义判定（仅 inproc）

1. `transport: inproc`；`semantic_content_enabled` **默认 true**（显式 `false` 才关 L3）
2. 安装脚本已写入 `agent.ras-judge`（或手动合并 [`ras_judge_agent.json`](./ras_judge_agent.json)）
3. 观察 `observe` → `skill_requests` → 独立 Judge session → `skill_result` → abort/notice/steer  
   （Judge **后台单飞**，不阻塞主会话流式输出；同 request 只下发一次）
> OpenCode **1.18+** 流式正文走 `message.part.delta`；仅订阅 `part.updated` 会在整段结束才检测，无法及时 `abort`。当前插件两者都听。

## Verify（Insight 同进程 / inproc）

推荐安装入口（agent-insight 仓）：

```bash
npx agent-insight install-ras
npx agent-insight install-ras --check
```

1. 确认 `~/.agent-insight/ras/config.json` 中 `agent_ras.service.transport` 为 `"inproc"`，且 `agent_ras.insight.events_url` 指向 Insight（默认 `http://127.0.0.1:3000/api/ingest/ras-events`）；设置 `AGENT_INSIGHT_API_KEY` 或写入 `insight.api_key`
2. 重启 OpenCode 加载插件；人机查看入口是 Agent Insight 的「可靠性观测」以及对应链路详情。
3. 诱导 thinking loop（降低 `detection_start_chars`）后断言：
   - TUI 出现 toast（标题 `Agent RAS`，正文如「检测到思考循环异常…」）；**不应**再出现红色 `[insight-ras] USER_NOTICE`（那是 TUI 全失败时的兜底日志）
   - Insight Trace 对应 session 出现环内标识；ingest 失败不影响环内 abort/notice（fail-open）
   - 流停止或出现「请手动停止」升级文案；idle 后注入 steering（正文来自 core，无 `[Agent RAS]` 前缀）
4. 插件 ensure 失败时对话仍可用（fail-open）

## Agent Insight 边界

`agent_ras/` 是 Agent Insight 包内的 RAS 真源。看板服务进程不运行 RAS；插件和
Python runtime 安装在 OpenCode 实际运行的主机，检测核在 OpenCode 进程内执行，仅将
可靠性事件旁路上报到 Agent Insight。
