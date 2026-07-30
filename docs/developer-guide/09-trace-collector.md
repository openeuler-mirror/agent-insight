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
| Generic | `adapters/generic.ts` | 标准OTLP SDK | 兜底适配，支持OpenInference标准 |
