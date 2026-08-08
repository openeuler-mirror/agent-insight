# TRAE Collector 架构说明

> Trae IDE 采集器的内部架构、数据流与关键设计决策。面向维护 `scripts/trae-collector/` 的开发者。

## 概述

TRAE Collector 是一个 **VS Code Extension**，安装在 Trae IDE 中以采集 Agent 运行数据并上报到 Agent Insight 平台。它通过 TRAE IDE 内置的 **Hook 系统** 监听生命周期事件，将事件序列化为 JSONL 格式写入本地 spool 目录，再由内置的 `UploadEngine` 按 checkpoint 增量上传到平台。

```
┌─────────────────────────────────────────────┐
│              Trae IDE                     │
│  ┌──────────────────────────────────────┐   │
│  │   Agent Insight VS Code Extension    │   │
│  │                                      │   │
│  │  ┌──────────┐    ┌────────────────┐  │   │
│  │  │  Hook    │    │  UploadEngine  │  │   │
│  │  │  Scripts │───▶│                │──┼───┼──▶ /api/ingest/upload
│  │  │ (JSONL)  │    │  (spool→POST)  │  │   │
│  │  └──────────┘    └────────────────┘  │   │
│  │        │                              │   │
│  │        ▼                              │   │
│  │  ┌──────────────────┐                │   │
│  │  │  ~/.agent-insight │                │   │
│  │  │  /trae-spool/     │                │   │
│  │  └──────────────────┘                │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## 目录结构

```
scripts/trae-collector/
├── src/
│   ├── extension.ts              # VS Code 扩展入口（激活/停用/配置/定时器）
│   └── uploader/
│       ├── spool.ts              # Spool 文件读取器（扫描 + 解析 JSONL）
│       └── upload-engine.ts      # 上传引擎（checkpoint + 重试 + 截断）
├── hooks/
│   ├── lib/
│   │   ├── common.sh             # Linux/macOS 共享库（JSON 事件构造）
│   │   ├── redact.sh             # Linux/macOS 敏感信息脱敏
│   │   └── redact_command.py     # 命令行参数脱敏
│   ├── scripts/                  # Linux/macOS Hook 脚本
│   │   ├── session-start.sh      # 会话开始
│   │   ├── pre-tool-use.sh       # 工具调用前
│   │   ├── post-tool-use.sh      # 工具调用后
│   │   ├── prompt-submit.sh      # 用户提交提示词
│   │   ├── stop.sh               # 会话结束
│   │   ├── subagent-detect.sh    # 子 Agent 检测
│   │   ├── notification.sh       # 系统通知
│   │   └── debug-view.sh         # 调试视图
│   └── ps1/                      # Windows PowerShell Hook 脚本（镜像结构）
│       ├── lib/
│       │   ├── common.ps1
│       │   └── redact.ps1
│       └── scripts/              # 同名 .ps1 Hook 脚本
├── install.sh / uninstall.sh     # Linux/macOS 安装/卸载
├── setup.sh / setup.ps1          # 配置脚本
├── scripts/build.js              # esbuild 打包 → .vsix
└── package.json                  # VS Code Extension manifest
```

## 核心组件

### extension.ts — 扩展入口

**职责**：
- 激活时注册 VS Code 命令（`agentInsight.debugView`、`agentInsight.showOutput` 等）
- 初始化 `UploadEngine` 并启动定时上传
- 管理状态栏图标（连接状态指示）
- 监控 Hook 环境（spool 目录、配置变更）
- 心跳上报（可选，周期性向平台报告在线状态）

**配置读取**：
配置优先从 VS Code 的 `agentInsight.trae.*` 设置项读取；若 Host / API Key 为空，则回退到 `~/.agent-insight/.env` 文件。这使得通过平台安装指导页面的安装命令就能自动填入连接信息。

### spool.ts — Spool 读取器

**职责**：
- 扫描 `~/.agent-insight/trae-spool/` 目录下的 JSONL 文件
- 解析每行 JSON 为 `SpoolEvent`（事件类型、时间戳、payload）
- 按文件名和行偏移维护消费进度

**Spool 事件格式**：
```json
{"type":"session-start","ts":"2026-07-28T10:00:00Z","payload":{"sessionId":"...","cwd":"..."}}
{"type":"pre-tool-use","ts":"2026-07-28T10:00:05Z","payload":{"tool":"read_file","input":{...}}}
{"type":"post-tool-use","ts":"2026-07-28T10:00:06Z","payload":{"tool":"read_file","output":"...","durationMs":1234}}
{"type":"prompt-submit","ts":"2026-07-28T10:01:00Z","payload":{"prompt":"hello"}}
{"type":"stop","ts":"2026-07-28T10:02:00Z","payload":{"sessionId":"..."}}
```

### upload-engine.ts — 上传引擎

**职责**：
- 按 `checkpoint` 增量消费 spool 事件（基于文件名 + 行偏移）
- 将事件聚合成 session 维度的上传 payload
- 通过 `POST /api/ingest/upload` 上报（带 `x-witty-api-key` 鉴权）
- 指数退避重试（base 10s, max 300s）
- 内容截断（超过 `maxContentLength` 的字段自动截断，默认 2000 字符）

**Checkpoint 机制**：
每个 JSONL 文件的消费进度存储在 `~/.agent-insight/trae_uploader_checkpoint.json` 中，格式：
```json
{
  "session_abc123.jsonl": { "offset": 10240, "ts": 1722153600000 }
}
```
上传成功后才推进 checkpoint；若文件被截断或重建，检测到偏移超出 EOF 后会从 0 重新开始。

### Hook 脚本 — 事件采集层

**设计原则**：
- **零侵入**：Hook 脚本由 TRAE IDE 在生命周期节点自动调用，无需修改 IDE 源码
- **快速返回**：脚本只做 JSON 序列化 + 文件追加，不阻塞 IDE 主流程
- **跨平台**：Linux/macOS 使用 Bash 脚本；Windows 使用 PowerShell 脚本；功能完全镜像

**事件流转**：
```
TRAE IDE Lifecycle
       │
       ▼
Hook Script (Bash / PowerShell)
       │
       ├── 构造 JSON 事件
       ├── 调用 redact.sh/ps1 脱敏
       └── 追加到 spool JSONL 文件
              │
              ▼
       UploadEngine (定时轮询)
              │
              ├── SpoolReader 扫描新行
              ├── 内容截断
              ├── POST → /api/ingest/upload
              └── 推进 checkpoint
```

## 数据流摘要

```
TRAE IDE Hook Event
  → Hook 脚本 (session-start / pre-tool-use / ...)
    → JSON 序列化 + 脱敏
      → 追加 ~/.agent-insight/trae-spool/<session-id>.jsonl
        → UploadEngine 轮询扫描
          → 读取新行（checkpoint + 增量）
            → 内容截断
              → POST /api/ingest/upload (x-witty-api-key 鉴权)
                → 服务端 FrameworkAdapter (trae.ts)
                  → extractSkills (interaction-utils.ts)
                    → saveExecutionRecord (data-service.ts)
                      → Execution 记录落库
```

## 服务端对接

TRAE Collector 上报到 `/api/ingest/upload`，服务端通过 `traeAdapter` ([`src/lib/ingest/adapters/trae.ts`](../../src/lib/ingest/adapters/trae.ts:1)) 处理：

- **Framework ID**: `trae`，别名 `trae-cn`、`trae-ide`、`trae-ai`
- **Skills 提取**: `extractSkillsWithVersionsFromTraeSession`（定义在 [`src/lib/shared/interaction-utils.ts`](../../src/lib/shared/interaction-utils.ts:1)），从 TRAE 特有的 interaction 格式中识别 tool call 并提取 Skill 名称与版本
- **Subagent Tree**: 支持子 Agent 调用树
- **Session Merge**: 使用 `snapshot-replace` 策略（每次上传全量替换 session 数据）

## 测试

测试文件位于 `test/` 目录下：

| 测试文件 | 覆盖内容 |
|----------|----------|
| `trae-adapter.test.ts` | FrameworkAdapter 注册与 skill 提取 |
| `trae-hooks.test.ts` | Hook 脚本事件生成与脱敏 |
| `trae-spool.test.ts` | Spool 读取、checkpoint 推进、断点续传 |
| `trae-extensions-json.test.ts` | VS Code Extension manifest 完整性 |
| `trae-acceptance.test.ts` | 端到端集成测试 |
| `trae-real-data.test.ts` | 真实 TRAE 数据回放测试 |
| `fixtures/trae-collector-fixtures.ts` | 测试数据集 |

运行测试：
```bash
npm run test -- --test-name-pattern="trae"
```

## 构建与发布

```bash
cd scripts/trae-collector
npm install
npm run build        # esbuild 打包 → .vsix
```

生成的 `.vsix` 文件通过 `/api/ingest/setup/trae` 路由分发给用户。该路由优先返回 `.vsix` 二进制文件；若文件不存在则返回 JSON 格式的安装指引。

## 关键设计决策

| 决策 | 理由 |
|------|------|
| Hook 脚本写 JSONL + 异步上传 | 避免阻塞 IDE 主流程；网络故障不影响 IDE 使用 |
| Spool checkpoint 基于文件偏移 | 简单可靠；即使进程重启也不丢失进度 |
| 双平台 Hook（Bash + PowerShell） | 覆盖 TRAE IDE 支持的 Linux/macOS/Windows 三大平台 |
| 内容截断 2000 字符 | 防止单次上传 payload 过大；工具输出通常不需要全文 |
| 敏感信息在客户端脱敏 | 减少敏感数据到达服务端的概率；脱敏规则按需扩展 |
| `snapshot-replace` session 合并策略 | TRAE 每次上传携带完整 session 快照，服务端直接替换 |
