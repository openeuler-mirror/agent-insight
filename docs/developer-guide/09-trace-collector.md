# 新增第三方Agent框架Trace采集开发方案

## 一、整体架构概览

当前平台的Trace采集采用**OTLP标准协议**作为接入层，内部通过**Adapter模式**实现框架特有的语义解析：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         客户端采集层 (Agent Side)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Hermes插件   │  │ Jiuwen扩展   │  │ Langfuse SDK │  │ 新框架采集器 │ │
│  │ (Python)    │  │ (Python)     │  │ (JS/Py)      │  │ (待开发)     │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                 │                 │                 │        │
└─────────┼─────────────────┼─────────────────┼─────────────────┼─────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         OTLP 协议层 (HTTP/JSON/protobuf)                 │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        服务端摄入层 (Agent Insight)                      │
│                                                                         │
│  ① decode.ts     → OTLP body 解码 (JSON/protobuf)                       │
│  ② normalize.ts  → 归一化到 OtelTraceEvent[]                            │
│  ③ adapter-registry.ts → 按 serviceName/attrs 选择 Adapter              │
│  ④ adapters/*.ts → 框架特化聚合，生成 ExecutionRecord                   │
│  ⑤ data-service.ts → 入库 (Execution/Session)                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、服务端开发工作

### 2.1 新增 Adapter 文件

**位置**：`src/lib/ingest/otel/adapters/<framework-name>.ts`

**接口定义**（见 `src/lib/ingest/otel/adapters/types.ts`）：

```typescript
export interface OtelTraceAdapter {
  readonly id: string;
  matches(events: OtelTraceEvent[]): boolean;
  aggregate(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null;
}
```

**需要实现的核心逻辑**：

| 功能 | 说明 | 参考实现 |
|------|------|----------|
| `matches()` | 判断是否匹配该框架的trace数据 | 通过 `serviceName` 或特定 attribute 识别 |
| `aggregate()` | 将OTLP事件聚合为平台内部的 `ExecutionRecord` | 解析span树、提取关键指标、构建interactions |

**关键数据映射**（参考 `generic.ts`、`hermes.ts`、`langfuse-langgraph.ts`）：

```typescript
// 必须映射的字段
{
  task_id: sessionId,
  query: string,              // 用户输入
  framework: string,          // 框架名称
  model: string,              // 模型名称
  tokens: number,             // 总token数
  latency: number,            // 延迟(ms)
  final_result: string,       // 最终输出
  timestamp: Date,            // 开始时间
  user: string,               // 用户标识
  agent: string,              // Agent名称
  agentName: string,
  llm_call_count: number,     // LLM调用次数
  tool_call_count: number,    // 工具调用次数
  tool_call_error_count: number, // 工具错误次数
  interactions: any[],        // 交互序列（核心）
}
```

**交互序列结构**（`interactions`）：

```typescript
// 用户输入
{ role: 'user', content: string, timestamp: string }

// 助手回复（LLM调用）
{ 
  role: 'assistant', 
  content: string, 
  model: string,
  usage: { input_tokens, output_tokens, total },
  timestamp: string,
  tool_calls?: [{ id, function: { name, arguments }, state, output, timing }]
}

// 子Agent
{ 
  role: 'subagent',
  agent: string,
  subagent_name: string,
  subagent_session_id: string,
  content: string,
  timestamp: string,
}

// 系统提示
{ role: 'system', content: string, timestamp: string }
```

### 2.2 注册 Adapter

**修改文件**：`src/lib/ingest/otel/adapter-registry.ts`

```typescript
import { genericOtelTraceAdapter } from './adapters/generic';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { newFrameworkOtelTraceAdapter } from './adapters/new-framework'; // 新增

const adapters: readonly OtelTraceAdapter[] = [
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  newFrameworkOtelTraceAdapter, // 新增（按优先级排序）
  genericOtelTraceAdapter,
];
```

> **注意**：Adapter按数组顺序匹配，优先匹配更特化的实现。

### 2.3 可选：新增归一化逻辑

**修改文件**：`src/lib/ingest/otel/normalize.ts`

如果新框架的OTLP格式与现有格式差异较大（例如非标准attribute命名），需要在归一化层添加特化处理：

```typescript
import { isNewFrameworkOtlpTraceBody, normalizeNewFrameworkOtlpTraces } from './new-framework';

export function normalizeOtlpTraces(body: any, opts = {}) {
  if (isLangfuseOtlpTraceBody(body)) {
    return normalizeLangfuseOtlpTraces(body, opts);
  }
  if (isNewFrameworkOtlpTraceBody(body)) { // 新增
    return normalizeNewFrameworkOtlpTraces(body, opts);
  }
  return normalizeClaudeOtlpTraces(body, opts);
}
```

### 2.4 可选：新增测试用例

**位置**：`test/otel-trace-aggregator.test.ts`

参考现有测试用例，添加新框架的单元测试：

```typescript
function newFrameworkTraceEvent(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: "2026-06-09T00:00:00.000Z",
    sessionId: "session-a",
    traceId: "trace-a",
    spanId: "span-a",
    name: "span",
    kind: "llm",
    serviceName: "new-framework", // 新框架名称
    user: "alice",
    model: "gpt-test",
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    latencyMs: 100,
    startTimeMs: 1000,
    attributes: {},
    ...overrides,
  }
}

// 测试用例...
```

---

## 三、客户端采集器开发工作

客户端采集器负责从第三方Agent框架中提取Trace数据，并通过OTLP协议上报到平台。根据框架特性，有两种开发模式：

### 3.1 模式一：Hook插件模式（推荐）

**适用场景**：框架提供生命周期钩子（hooks），可以在关键节点（LLM调用前/后、工具调用前/后、会话开始/结束）注入采集逻辑。

**参考实现**：`scripts/hermes_agent_insight_plugin.py`

**核心步骤**：

1. **注册Hook**：监听框架的关键生命周期事件
2. **构建Span**：从hook参数中提取信息，构建标准OTLP span
3. **编码OTLP**：将span序列化为OTLP JSON格式
4. **异步上报**：通过HTTP POST发送到平台的 `/api/ingest/otel/v1/traces` 端点
5. **本地缓存**：实现spool机制，网络异常时本地暂存，恢复后补发

**关键hook类型**：

| Hook | 采集内容 |
|------|----------|
| `pre_llm_call` | 用户输入、模型名称、system prompt |
| `post_llm_call` | LLM输出、token使用量、finish_reason |
| `pre_tool_call` | 工具名称、参数 |
| `post_tool_call` | 工具输出、状态（成功/失败） |
| `subagent_start` | 子Agent名称、目标、父子关系 |
| `subagent_stop` | 子Agent结果、状态 |
| `on_session_end` | 会话结束标记 |

**OTLP Payload格式**：

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        { "key": "service.name", "value": { "stringValue": "new-framework" } },
        { "key": "session.id", "value": { "stringValue": "<session-id>" } }
      ]
    },
    "scopeSpans": [{
      "scope": { "name": "agent-insight-new-framework", "version": "0.1.0" },
      "spans": [{
        "traceId": "<trace-id>",
        "spanId": "<span-id>",
        "parentSpanId": "<parent-span-id>",
        "name": "llm.GPT-4o",
        "kind": 1,
        "startTimeUnixNano": "<timestamp>",
        "endTimeUnixNano": "<timestamp>",
        "attributes": [
          { "key": "openinference.span.kind", "value": { "stringValue": "LLM" } },
          { "key": "input.value", "value": { "stringValue": "<user-input>" } },
          { "key": "output.value", "value": { "stringValue": "<llm-output>" } },
          { "key": "llm.model_name", "value": { "stringValue": "GPT-4o" } },
          { "key": "llm.token_count.prompt", "value": { "intValue": "100" } },
          { "key": "llm.token_count.completion", "value": { "intValue": "50" } }
        ],
        "status": { "code": 1 }
      }]
    }]
  }]
}
```

### 3.2 模式二：Telemetry扩展模式

**适用场景**：框架内置OpenTelemetry支持，可以直接配置OTLP exporter指向平台。

**参考实现**：`scripts/jiuwenswarm_extension/`

**核心步骤**：

1. **读取配置**：从框架配置文件或环境变量读取endpoint、api key等
2. **配置OTEL环境变量**：设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS` 等
3. **初始化观测**：调用框架内置的 `init_observability` 或类似API
4. **拦截配置**：确保exporter协议为HTTP，添加鉴权header

**配置优先级示例**：

```python
# 优先级从高到低
endpoint = (
    os.environ.get("AGENT_INSIGHT_OTLP_ENDPOINT")
    or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    or config.get("endpoint")
)
api_key = os.environ.get("AGENT_INSIGHT_API_KEY")
```

### 3.3 模式三：通用OTLP模式

**适用场景**：框架使用标准OpenTelemetry SDK，可以直接配置指向平台。

**无需开发采集器**，只需提供配置文档：

```bash
# 设置环境变量
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://<agent-insight-host>/api/ingest/otel/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=<your-api-key>
export OTEL_SERVICE_NAME=new-framework
```

---

## 四、采集器安装与分发

### 4.1 安装脚本

**位置**：`scripts/`

参考现有的安装脚本（如 `hermes_agent_insight_plugin.py` 的setup逻辑），实现一键安装：

1. **探测框架安装位置**：找到框架的插件目录或配置目录
2. **下载/复制插件**：将采集器代码部署到框架的插件目录
3. **写入配置**：生成配置文件（endpoint、api key等）
4. **启用插件**：调用框架的插件启用命令

### 4.2 接入引导API

**修改文件**：`src/app/api/ingest/setup/route.ts` 和 `src/app/api/ingest/setup/auto/route.ts`

两个入口必须同步维护：`setup/route.ts` 由“安装指导”页面给出的 `curl .../api/ingest/setup | bash`（Windows 为 PowerShell）触发；`setup/auto/route.ts` 由本地制作并安装的 Agent Insight npm 包在执行 `npx agent-insight install` 时触发。验证新采集器时要分别覆盖两条路径。本地 npm 包只用于验证，不上传 npm 仓库。框架选择列表采用追加式兼容策略：只能在现有条目末尾增加新框架，不得删除、重命名、改值或调整已有框架顺序。

添加新框架的接入引导逻辑：

```typescript
// 返回配置信息供用户复制
return NextResponse.json({
  framework: 'new-framework',
  env: {
    AGENT_INSIGHT_OTLP_ENDPOINT: `${host}/api/ingest/otel/v1/traces`,
    AGENT_INSIGHT_API_KEY: apiKey,
    OTEL_SERVICE_NAME: 'new-framework',
  },
  setupScript: '...', // 一键安装脚本
});
```

---

## 五、开发工作清单总结

| 阶段 | 工作项 | 文件/位置 | 优先级 |
|------|--------|-----------|--------|
| **服务端** | 新增Adapter实现 | `src/lib/ingest/otel/adapters/<framework>.ts` | **必须** |
| **服务端** | 注册Adapter到注册表 | `src/lib/ingest/otel/adapter-registry.ts` | **必须** |
| **服务端** | 新增归一化逻辑（如需要） | `src/lib/ingest/otel/normalize.ts` | 可选 |
| **服务端** | 新增单元测试 | `test/otel-trace-aggregator.test.ts` | **必须** |
| **客户端** | 开发采集器（Hook/Telemetry模式） | `scripts/<framework>_plugin.py` 或 `scripts/<framework>_extension/` | **必须** |
| **客户端** | 实现本地spool缓存 | 采集器内部 | **必须** |
| **安装** | 实现一键安装脚本 | `scripts/` | 推荐 |
| **安装** | 更新接入引导API | `src/app/api/ingest/setup/` | 推荐 |
| **文档** | 更新用户指南 | `docs/user-guide/` | 推荐 |

---

## 六、关键设计决策要点

1. **框架识别策略**：优先通过 `serviceName` 匹配，其次通过特定attribute（如 `agent.insight.framework`）匹配
2. **session归并策略**：选择 `snapshot-replace`（完整覆盖）还是 `monotonic merge`（增量合并），取决于框架的上报频率
3. **子Agent支持**：如果框架支持多Agent协作，需要在Adapter中处理父子session关系
4. **数据完整性**：确保采集器能捕获完整的LLM输出和工具结果，设置合理的内容截断上限
5. **可靠性保障**：客户端必须实现本地缓存和重试机制，避免网络异常导致数据丢失

---

## 七、参考现有实现

| 框架 | Adapter | 采集器 | 特点 |
|------|---------|--------|------|
| Hermes | `adapters/hermes.ts` | `scripts/hermes_agent_insight_plugin.py` | Hook模式，支持subagent |
| Langfuse LangGraph | `adapters/langfuse-langgraph.ts` | Langfuse SDK自带 | 标准OTLP，支持skill追踪 |
| JiuwenSwarm | `otel/jiuwenswarm/` | `scripts/jiuwenswarm_extension/` | Telemetry扩展模式 |
| Qoder CN 产品家族 | `adapters/qoder.ts` | `scripts/qoder_trace_collector.mjs`、Desktop VSIX、JetBrains Plugin、Work setup | 共享 Hook/OTLP 核心，按产品与账号隔离 spool，支持 Quest/Experts/Subagent/Skill/MCP/连接器 |
| Generic | `adapters/generic.ts` | 标准OTLP SDK | 兜底适配，支持OpenInference标准 |

---

## 八、Qoder CN 产品家族已实现链路

普通 setup 与 auto setup 的 Unix/Windows 安装脚本均在原有框架列表末尾追加 `Qoder CN product family`。选中后，从 `setup/route.ts` 的固定白名单下载 `qoder_setup.mjs`、`qoder_trace_collector.mjs`、`qoder_uploader_client.mjs` 和 `qoder_work_setup.mjs`，再分别安装 CLI、Desktop、JetBrains owner 与 Work 采集器；请求任意非白名单组件返回 404。安装完成后，脚本使用临时文件从两个 Qoder 插件下载接口拉取 Desktop VSIX 与 JetBrains ZIP，成功后原子替换到 `~/.agent-insight/packages/qoder/`；插件包不可用或网络失败只产生警告，不回滚已安装的采集运行时。Desktop 接口从源码动态构建；JetBrains 接口使用 `src/lib/ingest/qoder-plugin-release.ts` 中的默认 Release 附件地址，并允许服务端环境变量 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 覆盖。下载时限制协议、超时和最大 50MB，并校验 ZIP、编译后插件 JAR 与 `META-INF/plugin.xml`，失败后依次回退本地缓存和 IntelliJ/Java 源码构建。当前默认值是贡献分支的临时 Release 附件，正式发布后应迁移为 openEuler 官方附件。`test/qoder-setup-routes.test.ts` 固定断言两个入口原有框架名称、值和顺序不变，Qoder 仅作为末尾新增项，同时校验四个组件分发、默认/覆盖 Release 下载、自动下载命令及生成的 Bash/PowerShell 安装脚本语法。界面 marker 插件仍需在对应 IDE 中从下载文件安装。

生成的四种安装脚本（setup/auto × Bash/PowerShell）还会把当前生效的 Release 直链（环境变量覆盖值或源码默认值）嵌入脚本：服务端插件接口失败时先显示直链并自动重试，二次失败后输出平台对应的手动下载命令、目标 ZIP 路径和 `Install Plugin from Disk` 操作步骤；默认地址无需管理员预先配置，部署方需要切换制品来源时再设置环境变量并重启服务。

### Qoder for JetBrains Release 制品维护声明

Qoder for JetBrains 的 Java 源码必须经过 IntelliJ Platform SDK/JDK 编译，并封装为“插件 ZIP → `lib/*.jar` → `META-INF/plugin.xml` 与编译后 class”的标准结构。仓库以 `integrations/qoder-jetbrains/` 和共享 `scripts/qoder_*.mjs` 为源码事实来源，`integrations/qoder-jetbrains/build/` 仅存放本地构建结果且被 `.gitignore` 排除；不得把 VSIX/ZIP 二进制重新提交到 Git 源码目录。

当前默认 Release 下载地址集中定义在 `src/lib/ingest/qoder-plugin-release.ts`，不要在 setup、auto setup 或下载 route 中重复写死。该模块同时保留 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 环境变量覆盖能力。服务端通过 `/api/ingest/setup/qoder-jetbrains-plugin` 对外分发，生成的 Bash/PowerShell 安装脚本会把当前生效地址写入安装流程，客户端最终下载到 `~/.agent-insight/packages/qoder/agent-insight-qoder-jetbrains.zip`。当前默认值指向贡献者仓库 `qoder-cn-collector-test-v0.1.0` Release 的临时附件；PR 合入且 openEuler 发布正式附件后，必须把默认值迁移到官方 Release，个人 Release 不作为长期生产制品源。

Windows 维护者可执行：

```powershell
node integrations/qoder-jetbrains/build-plugin.mjs --ide-home "<JetBrains IDE 安装目录>" --output integrations/qoder-jetbrains/build/distributions/agent-insight-qoder-jetbrains-0.1.9.zip
```

Linux/macOS 维护者可执行：

```bash
JETBRAINS_HOME="<JetBrains IDE 安装目录>" \
  node integrations/qoder-jetbrains/build-plugin.mjs \
  --output integrations/qoder-jetbrains/build/distributions/agent-insight-qoder-jetbrains-0.1.9.zip
```

每次修改 `integrations/qoder-jetbrains/`、`scripts/qoder_trace_collector.mjs`、`scripts/qoder_uploader_client.mjs`、`scripts/qoder_setup.mjs` 或 `scripts/qoder_token_usage_env.mjs` 后，都必须重新构建 ZIP。发布前应确认：外层 ZIP 含 `lib/*.jar`；JAR 含 `META-INF/plugin.xml`、编译后的 class 和当前版本的四个 collector/setup 脚本；插件可通过 **Settings → Plugins → Install Plugin from Disk** 安装并重启；Qoder for JetBrains Trace 能正常上报；最后记录附件 SHA-256，并运行：

```bash
node --import tsx --test test/qoder-setup-routes.test.ts
```

维护流程为：完成源码修改与测试 → 构建新 ZIP → 本地安装冒烟验证 → 上传到受信任的 Release/制品仓 → 若 tag 或文件名变化则更新 `DEFAULT_QODER_JETBRAINS_PACKAGE_URL` → 验证分发接口和一键安装 → 再提交源码。替换同一 Release 的同名附件时也必须重新验证下载接口；在官方地址尚未就绪或需要灰度切换时，通过环境变量覆盖，不要临时改动多个 route。Release 附件必须与当前源码一致，否则 JetBrains 插件启动时可能用内嵌旧脚本覆盖共享 collector，造成平台名称、Token 或 Trace 结构回退。

Qoder CN CLI 与 Qoder CN Desktop 的用户级 Hook 写入 `~/.qoder-cn/settings.json`；项目级配置仍遵循产品约定写入项目内 `.qoder/settings.json` 或 `.qoder/settings.local.json`。JetBrains 保持其已经验收的 `~/.qoder/settings.json` 接入，Qoder Work 使用独立的 `.qoderworkcn`/`.qoderwork` 设置和运行目录。各端均覆盖 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`SubagentStart`、`SubagentStop`、`Stop` 与 `SessionEnd` Hook。Hook 保持异步、stdout 静默且异常退出码为 0，避免影响 Qoder 主流程。Desktop 的 Quest/Experts、并发 Agent 工具以及 JetBrains 会话由 transcript、diagnostics、Experts cache 和 IDE 进程 marker 共同还原。

产品来源与根 Agent 名称是两个独立维度：Desktop 和 JetBrains 的普通根 Agent 统一为 `Qoder`，CLI 为 `Qoder CLI`，Work 为 `Qoder Work`；Quest/专家团模式分别为 `Quest Agent`/`Experts Agent`，用户显式创建的具名 Agent 保留原名。产品来源仍分别记录为 `Qoder CN Desktop`、`Qoder for JetBrains`、`Qoder CN CLI` 和 `Qoder Work`，不得用产品形态名称覆盖 Agent 名称，也不得因根 Agent 同名而丢失产品归属。

数据处理顺序为：Hook JSON 原子落盘 → Stop/SessionEnd 读取 transcript、diagnostics 与适用的本地 Token 数据 → 生成完整 OTLP snapshot → 写入账号隔离 pending 目录 → 立即拉起一次 one-shot uploader 上传 `/api/ingest/otel/v1/traces` → 服务端 Qoder adapter 选择最新 snapshot 并生成 `ExecutionRecord`。该事件触发路径不等待常驻 uploader 的定时扫描；自动化验收使用真实本地 HTTP 接收端，硬性断言 SessionEnd 到 OTLP 请求到达小于 3000ms。Tool 依靠 `tool_use_id` 配对而不是文件顺序；通常使用 Pre/Post Hook 计算耗时，异步 Hook 的采集时间戳重合为零时回退到 transcript 的 `tool_use/tool_result` 时间戳，避免把真实 MCP 等短调用显示为 `0ms`。Qoder CN Desktop 通过 `/skill-name` 触发 Skill 时不产生独立 Skill Tool Hook，采集器读取 transcript 的 `session_meta/slash_command`（`content.type=skill`）合成 Skill Span；Qoder CN CLI 对应读取 `system/informational` 的 `Skill **name** activated.` 记录。两种形式都还原 name、version、triggerMode、params 和 result，并避免与显式 Skill Tool 重复。Task 的 `subagent_type` 与输出中的 child session id 用于还原多层 Subagent 调用树；Qoder CN CLI 的 `agent-result` 使用驼峰字段 `agentId`、`agentType`、`transcriptPath`，采集器以真实 `agentId` 合成子 Agent Span，并保留状态、结果和 transcript 路径，支持多个并发 Agent 的稳定关联。Qoder Work 的 `qw_mcp_call` 会解包为真实 MCP server/tool/arguments；`builtin_*` 服务同时标记为 `connector`，保留连接器名称、工具、参数、结果、错误和耗时。

Token 按 `diagnostics/Hook 精确值 > Desktop/JetBrains 本地 SQLite 精确值 >（显式开启时）可见 transcript 本地估算 > 不可用` 取值。Qoder CN Desktop 在 Windows 的数据库位于 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db`，会话 transcript 位于 `~/.qoder-cn/cache/projects/.../conversation-history/.../*.jsonl`；JetBrains 数据库仍位于 `~/.qoder/shared_client/cache/db/local.db`。采集器以只读和 `query_only` 模式访问 `chat_message`，读取 `id/session_id/request_id/token_info/model_info/gmt_create`；Schema 不兼容、锁等待超过短超时或运行时无 `node:sqlite` 时返回空结果，不影响 Hook。CN Desktop 的无 `type` 会话记录会先从 `{role,message}` 规范化，再按会话 ID 和时间戳与 SQLite 请求逐条关联。`prompt_tokens` 与 `completion_tokens` 写入 `gen_ai.usage.*`，`cached_tokens` 单独写入缓存属性且不重复计入总 Token；来源标记为 `local_sqlite`，不带估算标记。该 Schema 属于 Qoder 内部存储，必须保留探测和回退，不能视为稳定公开 API。

AC35 只比较 Qoder 内置精确计量源，不使用 Credits 换算，也不把带 `estimated=true`/`≈` 的可见文本估算值当作通过依据。误差公式为 `abs(Agent Insight - Qoder) / Qoder`，分别校验 input、output 和 total，三项均须小于 5%。Desktop/JetBrains 以同一 session 的 SQLite `prompt_tokens + completion_tokens` 为 total；`cached_tokens` 是 prompt 的子集，禁止再次相加。CLI/Work 以 `model.response.completed` diagnostics 的 input/output（以及存在时独立的 reasoning）为准。自动化用例将四端原始计量依次经过读取器、OTLP snapshot、normalize 和 Qoder Adapter 后比较；2026-07-24 本机真实样本复核 Desktop 2 条、JetBrains 2 条、CLI 2 条、Work 6 条，12 条精确记录的 input/output/total 误差均为 0%。

估算值只写入 `qoder.token_usage.estimated_*`，并带 `estimated=true`、`source=local_visible_transcript`、`scope=visible_transcript`、`missing_context=true` 和估算器版本。服务端仅把估算总量用于可观测展示，不写入精确 input/output 字段，避免由模型价格表推导出伪造费用。Trace 详情用 `≈` 区分估算值。该估算仅在 `AGENT_INSIGHT_QODER_ESTIMATE_VISIBLE_TOKENS=1` 时启用，只覆盖 transcript 可见内容，不含隐藏 system prompt、Rules、Skill/MCP schema、内部推理与压缩前上下文；真实 Agent 会话中可能严重低估，故默认关闭。CLI/Work 不启用此兜底。

spool 统一放在 `~/.agent-insight/otel_data/qoder/`，下一层按 `cli`、`desktop`、`jetbrains`、`work` 分开，再使用 API Key SHA-256 摘要作为账号目录。安装器识别旧的 `qoder-{product}` 配置并把新数据路由到统一根目录；卸载 purge 同时清理新旧产品目录。CLI/Desktop/JetBrains 的共享运行脚本通过 owner marker 引用计数，但 Hook 配置按产品实际目录管理：CN CLI/Desktop 共享 `~/.qoder-cn/settings.json`，JetBrains 使用 `~/.qoder/settings.json`。卸载一个产品只停止并清理该产品，只有引用同一设置文件的最后一个 owner 卸载时才移除其中的 Hook，全部 owner 卸载后才移除共享运行脚本。卸载会同时读取 `uploader.lock` 与 `upload-run.lock`，优雅停止常驻和 one-shot uploader，短时等待后强制结束仍存活的进程，再清理当前产品 spool；不会删除共享 Host/API Key 或其他框架的配置、运行目录和 spool。Desktop 与 JetBrains 生命周期结束前调用 collector `--flush`，为没有 pending 的活动 session 原子补写 SessionEnd snapshot，并用 `force=true` 绕过 retry 的 `nextAttemptAt` 等待一次上传；并发 uploader 锁会短时等待，失败文件仍留在磁盘，确保停用不丢数据。Work 始终独立卸载，不修改 `.qoder` 配置。自动化验收会启动四个真实 watcher 及一个 one-shot 进程，逐端卸载并验证其停止，再重新安装四端并各自产出 snapshot。

AC27/AC28 把“主流程不等待采集器”作为硬性不变量：CLI、Desktop、JetBrains 与 Work 的全部 Hook（包括 `SessionStart` 和 `UserPromptSubmit`）都必须写入 `async: true`；Desktop 激活时通过零延迟任务调度后台安装，JetBrains 通过 `executeOnPooledThread` 安装，不能在 UI/启动线程等待 Node 安装器或上传器。`test/qoder-performance.test.ts` 还会对四端 `SessionStart` 的同步分派逐一执行 `< 200ms` 硬断言，并使用固定 250ms 首响应的本地 SSE 服务交替采样未采集/启用采集各 7 次，以中位数计算 `(instrumented - baseline) / baseline`，硬断言首 Token 增幅 `< 5%`。该基准只衡量采集器引入的客户端开销，排除公网和模型供应商波动；冷启动成本由 AC27 独立覆盖。2026-07-24 本机结果为四端同步分派 6.81/4.07/4.24/4.22ms，首 Token 中位数 259.66ms → 260.50ms，增幅 0.32%。

AC29 使用 `node scripts/qoder_memory_soak.mjs` 对统一 spool 下当前运行的 uploader 做默认 8 小时采样，每 60 秒记录一次各产品 PID 的 RSS，原始样本和汇总分别写入 `~/.agent-insight/performance/qoder-ac29-*.jsonl` 与 `*.summary.json`。硬性上限为单产品峰值 RSS `< 50MB`；“无内存泄漏”的判据固定为末尾 10% 样本中位数相对开头 10% 增长不超过 5MB，且线性回归斜率不超过 1MB/小时。进程中途退出或重启会直接失败，不能用多个短进程拼成 8 小时通过记录。CLI/Desktop/JetBrains 使用同一 uploader 实现，Work 使用其隔离运行副本；可用 `--products=cli,jetbrains,work` 明确要求对应运行实例存在。

结构稳定性验收会把相同的标准任务执行三次，同时改变 session、request、tool id 和时间戳；比较时保留 span 名称、父子关系、kind、status、属性键、事件类型以及服务端 `ExecutionRecord` 的 LLM/Tool 数量和 interaction 结构，只排除正常变化的 ID、内容值与耗时。三次规范化结构必须完全一致，避免用相同原始 JSON 重放形成假通过。

AC33 综合验收使用一个 Qoder Desktop 标准任务，在同一 session 和同一 traceId 中同时包含根 Agent、普通 Subagent、Quest goal/step、专家 Agent、Skill、普通 Tool 和 LLM 调用。Quest 会话中如果存在该 session 的 Experts cache，采集器以实际专家记录为准补充 Expert 标记，不要求顶层 mode 必须切换为 `experts`，且不会把没有专家输出或通知证据的普通 Subagent 误标为 Expert。测试还会将该 OTLP snapshot 交给服务端 Qoder Adapter，校验 `ExecutionRecord` 同时保留 Quest、Expert、Subagent、Skill、Tool、LLM 结构、Token 汇总以及完整父子关系。

实现与测试入口：

- `scripts/qoder_trace_collector.mjs`：Hook、脱敏、截断、transcript/diagnostics 合并和 OTLP snapshot。
- `scripts/qoder_uploader_client.mjs`：单实例上传、断点保留、失败重试和成功清理。
- `scripts/qoder_memory_soak.mjs`：AC29 八小时 RSS、增长量和增长斜率采样与留证。
- `scripts/qoder_setup.mjs`：CN CLI/Desktop 与 JetBrains 的 user/project/local scope、owner 隔离安装与卸载；用户级 CN Hook 写入 `.qoder-cn`，且只管理名为 `agent-insight-qoder` 的 hooks。
- `scripts/qoder_work_setup.mjs`：Qoder Work 独立安装、卸载和 `qoder-work` spool。
- `integrations/qoder-desktop/`：Qoder CN Desktop VSIX、状态栏、Settings、后台安装和卸载监视。
- `integrations/qoder-jetbrains/`：JetBrains Plugin SDK 插件、状态栏、设置、IDE marker 和动态卸载清理。
- `src/lib/ingest/otel/adapters/qoder.ts`：服务端 Qoder OTLP 聚合。
- `test/qoder-trace-collector.test.ts` / `test/qoder-desktop-extension.test.ts` / `test/qoder-performance.test.ts`：确定性、账号/产品隔离、重试、Skill/MCP/连接器、最新版 snapshot、多层 Subagent、安装卸载、四端启动预算和首 Token 开销验证。
