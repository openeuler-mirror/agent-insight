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

### 共享模块升级契约

Pi Agent、Codex、Goal Plus 的 ZIP 分发均包含 `shared/install-modules.cjs`。
安装器在写入框架文件、配置和 hooks 前预检全部共享依赖：内容相同则复用，不存在则安装；
已有 `installation.json` 时，允许升级与凭据一致且 `sharedAbi` 兼容的文件；没有凭据的旧安装仅允许升级摘要列入白名单的文件。名单覆盖根目录环境变量迁移前的
`trace-transport.cjs`、`1447495e` 发布版本中的原版上传模块和 `install-modules.cjs`，
以及 `544df1cb` 中尚未生成升级凭据的原版安装器（SHA-256 `52e47d6e…fec39a08`）。支持同时升级上传模块与升级器自身，迁移成功后生成共享文件指纹及 ABI 凭据；重复安装复用凭据，避免已经安装过采集器的机器被版本差异阻塞。
升级保留权限为 `0600` 的随机命名 `.bak`，使用同目录临时文件加 rename 替换。
未知内容或符号链接报错，不能把“不同文件”直接当作可覆盖的旧版本。
后续共享模块变更须核验并登记兼容旧版摘要、更新三个分发包及升级回归测试，不能仅测试全新安装。

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

MCTS 使用独立的 `mcts-xgovernor` 安装 profile，不是 Goal Plus 的宿主依赖：profile 解析不能自动加入 Pi Agent 或 xiaoO。安装页只要求 MCTS 仓库路径，通过 `AGENT_INSIGHT_MCTS_REPO_DIR` 传给安装脚本；连接地址由执行机读取仓库配置。普通 setup 与 auto setup 的 Unix 脚本都必须下载 `/api/ingest/setup/mcts-xgovernor` 并输出透明启动器用法。专用 route 分发固定白名单的确定性 ZIP，bootstrap 校验 SHA-256 后才执行安装器。原生 PowerShell 不安装该代理，而是明确要求在 WSL 中执行 Linux 安装命令。

MCTS ZIP 使用 `runtimePackageRoot()` 定位平台源码，优先读取启动器提供的 `AGENT_INSIGHT_PACKAGE_ROOT`，不能固定使用 standalone 进程的 cwd。Next 的 `outputFileTracingIncludes` 同时为安装脚本和 ZIP 路由包含采集器、共享传输模块及 `services/executor/src/mcts-config.cjs`，使独立 standalone 部署也能生成完整安装包。升级这类文件后须重新构建并重启平台服务。

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
| Qwen Code | `adapters/qwencode.ts` | `scripts/qwencode-collector/` + Qwen Code 原生 OTLP | 原生 Telemetry 模式，支持 Agent/Subagent/LLM/Tool/Skill/MCP/Plan，按账号隔离 spool |
| Qoder CN 产品家族 | `adapters/qoder.ts` | `scripts/qoder_trace_collector.mjs`、Desktop VSIX、JetBrains Plugin、Work setup | 共享 Hook/OTLP 核心，按产品与账号隔离 spool，支持 Quest/Experts/Subagent/Skill/MCP/连接器 |
| Generic | `adapters/generic.ts` | 标准OTLP SDK | 兜底适配，支持OpenInference标准 |
| xiaoO | `adapters/generic.ts`（`service.name=xiaoo`） | [`scripts/xiaoo-trace-collector/`](../../scripts/xiaoo-trace-collector/) | Hooker plugin；session buffer → OTLP；**不**经 RAS；安装 `node scripts/xiaoo-trace-collector/install.js`；RAS bundle 必须携带该目录，`install-ras` 安装后会校验 5 个运行文件指纹、`plugin.json` 语义与 `config.toml` 挂载，缺失时不得静默成功 |
| MCTS xGovernor | `adapters/mcts-xgovernor.ts` | `scripts/agent-trace-collectors/mcts-xgovernor-proxy/` | 独立安装 profile；透明 HTTP/SSE 代理；只覆盖被包裹 MCTS 子进程的 `XGOVERNOR_BASE_URL`；通过 OTLP 与 Collaboration API 上报 |

---

## 八、Qwen Code 原生 OTLP 已实现链路

Qwen Code 通过自身 Telemetry 配置把 traces 与 logs 直接发送到 `/api/ingest/otel/v1/traces` 和 `/api/ingest/otel/v1/logs`。普通 setup 与 auto setup 的 Bash/PowerShell 安装脚本均只追加 `qwencode` 选项，不调整既有框架顺序；安装器在 `~/.qwen/.env` 中管理 Qwen Code 的 OTLP 环境变量，卸载时只移除 Agent Insight 管理的字段，不修改其他采集器配置。

服务端 `src/lib/ingest/otel/adapters/qwencode.ts` 在专用 adapter 内完成事件识别、会话命名空间隔离、父子 Agent 还原以及 LLM/Tool/Skill/MCP/Plan 语义映射，再生成 `ExecutionRecord`。Qwen 日志中的 `skill_launch` 会转换为 Skill 事件；同一次调用同时存在摘要日志和完整 Tool span 时保留完整 span，避免重复计数。内容进入 spool 或服务端事件前执行敏感信息脱敏和 2000 字符截断。

采集器辅助模块位于 `scripts/qwencode-collector/`：安装和迁移脚本负责启用原生 OTLP，storage/uploader 提供 API Key 摘要账号隔离、失败重试、上传归档、watcher 心跳和 SessionEnd 立即 flush。服务端注册点包括通用 framework adapter、OTLP adapter registry、logs/traces ingest 路由和 Agent platform。对应回归测试为 `test/qwencode-*.test.*`，并由 `test/ingest-endpoint-contract.test.ts` 和 `test/setup-noninteractive-compat.test.ts` 固定端点与双平台安装契约。

---

## 九、Qoder CN 产品家族已实现链路

普通 setup 与 auto setup 的 Unix/Windows 安装脚本均在原有框架列表末尾追加 `Qoder CN product family`。选中后，从 `setup/route.ts` 的固定白名单下载 `qoder_setup.mjs`、`qoder_trace_collector.mjs`、`qoder_uploader_client.mjs` 和 `qoder_work_setup.mjs`，再分别安装 CLI、Desktop、JetBrains 与 Work 采集器；请求任意非白名单组件返回 404。安装完成后，脚本使用临时文件从两个 Qoder 插件下载接口拉取 Desktop VSIX 与 JetBrains ZIP，成功后原子替换到 `~/.agent-insight/packages/qoder/`；插件包不可用或网络失败只产生警告，不回滚已安装的采集运行时。Desktop 接口从源码动态构建；JetBrains 接口使用 `src/lib/ingest/qoder-plugin-release.ts` 中的默认 Release 附件地址，并允许服务端环境变量 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 覆盖。下载时限制协议、超时和最大 50MB，并校验 ZIP、编译后插件 JAR 与 `META-INF/plugin.xml`，失败后依次回退本地缓存和 IntelliJ/Java 源码构建。当前默认值是贡献分支的临时 Release 附件，正式发布后应迁移为 openEuler 官方附件。`test/qoder-setup-routes.test.ts` 固定断言两个入口原有框架名称、值和顺序不变，Qoder 仅作为末尾新增项，同时校验四个组件分发、默认/覆盖 Release 下载、自动下载命令及生成的 Bash/PowerShell 安装脚本语法。界面 marker 插件仍需在对应 IDE 中从下载文件安装。

生成的四种安装脚本（setup/auto × Bash/PowerShell）只从平台插件接口下载，不再通过 Release 直链绕过服务端校验。缓存、远端附件和本地构建产物均须通过检查；包含旧 Desktop 卸载 watcher 或 JetBrains 卸载脚本的包会被拒绝。只有下载成功才显示从磁盘安装的指引；失败时提示部署方更新或构建当前插件后重新下载，不得继续安装本机残留的旧包。服务端没有合格制品且无法本地构建时，下载接口返回 503。

### Qoder for JetBrains Release 制品维护声明

Qoder for JetBrains 的 Java 源码必须经过 IntelliJ Platform SDK/JDK 编译，并封装为“插件 ZIP → `lib/*.jar` → `META-INF/plugin.xml` 与编译后 class”的标准结构。仓库以 `integrations/qoder-jetbrains/` 和共享 `scripts/qoder_*.mjs` 为源码事实来源，`integrations/qoder-jetbrains/build/` 仅存放本地构建结果且被 `.gitignore` 排除；不得把 VSIX/ZIP 二进制重新提交到 Git 源码目录。

当前默认 Release 下载地址集中定义在 `src/lib/ingest/qoder-plugin-release.ts`，不要在 setup、auto setup 或下载 route 中重复写死。该模块同时保留 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 环境变量覆盖能力。此地址仅供服务端获取并校验制品，客户端通过 `/api/ingest/setup/qoder-jetbrains-plugin` 下载到 `~/.agent-insight/packages/qoder/agent-insight-qoder-jetbrains.zip`。当前默认值指向贡献者仓库 `qoder-cn-collector-test-v0.1.0` Release 的临时附件；部署方必须提供与当前源码一致的包或可用的本地构建环境，旧附件可能因包含已移除的卸载组件而被拒绝。PR 合入且 openEuler 发布正式附件后，必须把默认值迁移到官方 Release，个人 Release 不作为长期生产制品源。

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

spool 统一放在 `~/.agent-insight/otel_data/qoder/`，下一层按 `cli`、`desktop`、`jetbrains`、`work` 分开，再使用 API Key SHA-256 摘要作为账号目录。安装器识别旧的 `qoder-{product}` 配置并把新数据路由到统一根目录。CLI/Desktop/JetBrains 的 Hook 配置按产品实际目录管理：CN CLI/Desktop 共享 `~/.qoder-cn/settings.json`，JetBrains 使用 `~/.qoder/settings.json`。Desktop 与 JetBrains 生命周期结束前调用 collector `--flush`，为没有 pending 的活动 session 原子补写 SessionEnd snapshot，并用 `force=true` 绕过 retry 的 `nextAttemptAt` 等待一次上传；并发 uploader 锁会短时等待，失败文件仍留在磁盘。当前版本不提供自动卸载、配置回退或 spool 清理入口，既有 Trace 与采集数据不因本次功能移除而删除。

AC27/AC28 把“主流程不等待采集器”作为硬性不变量：CLI、Desktop、JetBrains 与 Work 的全部 Hook（包括 `SessionStart` 和 `UserPromptSubmit`）都必须写入 `async: true`；Desktop 激活时通过零延迟任务调度后台安装，JetBrains 通过 `executeOnPooledThread` 安装，不能在 UI/启动线程等待 Node 安装器或上传器。`test/qoder-performance.test.ts` 还会对四端 `SessionStart` 的同步分派逐一执行 `< 200ms` 硬断言，并使用固定 250ms 首响应的本地 SSE 服务交替采样未采集/启用采集各 7 次，以中位数计算 `(instrumented - baseline) / baseline`，硬断言首 Token 增幅 `< 5%`。该基准只衡量采集器引入的客户端开销，排除公网和模型供应商波动；冷启动成本由 AC27 独立覆盖。2026-07-24 本机结果为四端同步分派 6.81/4.07/4.24/4.22ms，首 Token 中位数 259.66ms → 260.50ms，增幅 0.32%。

AC29 使用 `node scripts/qoder_memory_soak.mjs` 对统一 spool 下当前运行的 uploader 做默认 8 小时采样，每 60 秒记录一次各产品 PID 的 RSS，原始样本和汇总分别写入 `~/.agent-insight/performance/qoder-ac29-*.jsonl` 与 `*.summary.json`。硬性上限为单产品峰值 RSS `< 50MB`；“无内存泄漏”的判据固定为末尾 10% 样本中位数相对开头 10% 增长不超过 5MB，且线性回归斜率不超过 1MB/小时。进程中途退出或重启会直接失败，不能用多个短进程拼成 8 小时通过记录。CLI/Desktop/JetBrains 使用同一 uploader 实现，Work 使用其隔离运行副本；可用 `--products=cli,jetbrains,work` 明确要求对应运行实例存在。

结构稳定性验收会把相同的标准任务执行三次，同时改变 session、request、tool id 和时间戳；比较时保留 span 名称、父子关系、kind、status、属性键、事件类型以及服务端 `ExecutionRecord` 的 LLM/Tool 数量和 interaction 结构，只排除正常变化的 ID、内容值与耗时。三次规范化结构必须完全一致，避免用相同原始 JSON 重放形成假通过。

AC33 综合验收使用一个 Qoder Desktop 标准任务，在同一 session 和同一 traceId 中同时包含根 Agent、普通 Subagent、Quest goal/step、专家 Agent、Skill、普通 Tool 和 LLM 调用。Quest 会话中如果存在该 session 的 Experts cache，采集器以实际专家记录为准补充 Expert 标记，不要求顶层 mode 必须切换为 `experts`，且不会把没有专家输出或通知证据的普通 Subagent 误标为 Expert。测试还会将该 OTLP snapshot 交给服务端 Qoder Adapter，校验 `ExecutionRecord` 同时保留 Quest、Expert、Subagent、Skill、Tool、LLM 结构、Token 汇总以及完整父子关系。

模型响应关联字段沿以下路径保留，不改变现有 trace/span ID：

| Qoder 来源 | OTLP / 平台字段 | 含义 |
|---|---|---|
| Hook `session_id` | `qoder.session.id` / `ExecutionRecord.task_id` | 会话，定位整条 Trace |
| transcript `message.id` | `qoder.llm.message_id` / LLM interaction `messageID` | 原生消息标识；已验证的 CLI 路径另写 `inference_response_id`，Desktop / JetBrains 不将本地消息标识解释为推理响应 ID |
| diagnostics `request_id` | `qoder.llm.request_id` | Qoder 请求标识，沿用旧的来源及兜底规则，不当作模型响应 ID |

流式 transcript 分片按所属 Agent 和 `message.id` 合并。diagnostics 优先通过 transcript 的 `requestTokenAnchor.requestId` 或 `message.usage.request_id` 精确配对；只有不含原生请求 ID 的旧消息才允许按时间回退，禁止把显式属于另一个请求的消息配给当前调用。缺少 `message.id` 时不生成 `qoder.llm.message_id` / `messageID`，也不以 record UUID、SQLite 消息 ID、请求 ID 或 span ID 冒充。

普通子 Agent 的 transcript 从 `SubagentStop.agent_transcript_path`、`PostToolUse.tool_response.transcriptPath` 或根/子 transcript 的 `toolUseResult.transcriptPath` 发现；最后一种来源允许已完成 Agent 的异步 Hook 晚于根 Stop 落盘。只读取当前会话 `subagents` 目录内、记录 `sessionId` 与 `agentId` 匹配的文件，并对重复引用去重。子 LLM 使用对应 Agent span 作为父级，`qoder.subagent.session_id` 保留子 Agent ID；已验证 CLI 路径的 `inference_session_id` 保留模型请求实际发送的根 `session-id`，二者不可混用。

`isApiErrorMessage: true` 或 `message.model: "<synthetic>"` 表示本地合成错误消息：保留错误内容与 LLM 事件，设置 `qoder.llm.synthetic` / `inference_response_unavailable`，不导出 `messageID` / `inference_response_id`。服务端也屏蔽带 synthetic 标记或 `<synthetic>` 模型的旧采集数据。已用 Qoder CN CLI 1.1.70 的本地模拟网关验证两个子 Agent 并发、503 后成功及三次 503 耗尽，经过真实 uploader、OTLP handler、consumer、SQLite 和最终 LLM 节点核对。失败 HTTP 尝试的响应头 ID 未出现在 transcript 中，因此仍不能逐次关联失败尝试；根任务结束后继续运行的后台子 Agent 不在本次实测范围。

对已确认原样保留响应 ID 的自定义模型端点，网关可记录 `(session-id, response.id)`，与平台 `(task_id, interaction.messageID)` 关联。要求每次响应 ID 唯一、同一次流式响应各分片 ID 一致；无响应的失败尝试和重试级关联还需独立请求标识。此字段保留不证明任意 Qoder 产品、模型协议或上游服务均满足这些约束。

Trace 详情的整体入口与 LLM 详情（含时间线弹窗）共用 `InferenceAnalysisButton`，由 `src/lib/trace/inference-analysis.ts` 组织关联信息。优先使用统一 `inference_call_ids`，整体入口还包含 `inference_unassigned_calls`；缺少统一字段的历史数据仍展示 `inference_response_id` / `inference_request_id` 与 OpenCode `inference_attempts`。旧 Qoder `messageID` 仅在本 Trace 来源可确认且非合成错误时回退，不能按根 framework 解释其他协作 Trace 的消息 ID。外部分析页固定为 `/model-performance?GlobalTrackNO=<call_id>`，一次只传一个统一 ID。整体弹窗列出所有调用的独立链接；单 LLM 仅在完整开始时间可确定唯一最新请求时提供默认入口，历史响应/请求标识仅展示，不拼入该参数。

实现与测试入口：

- `scripts/qoder_trace_collector.mjs`：Hook、脱敏、截断、transcript/diagnostics 合并和 OTLP snapshot。
- `scripts/qoder_uploader_client.mjs`：单实例上传、断点保留、失败重试和成功清理。
- `scripts/qoder_memory_soak.mjs`：AC29 八小时 RSS、增长量和增长斜率采样与留证。
- `scripts/qoder_setup.mjs`：CN CLI/Desktop 与 JetBrains 的 user/project/local scope 安装；用户级 CN Hook 写入 `.qoder-cn`，且只管理名为 `agent-insight-qoder` 的 hooks。
- `scripts/qoder_work_setup.mjs`：Qoder Work 独立安装和 `qoder-work` spool。
- `integrations/qoder-desktop/`：Qoder CN Desktop VSIX、状态栏、Settings 和后台安装。
- `integrations/qoder-jetbrains/`：JetBrains Plugin SDK 插件、状态栏、设置和 IDE marker。
- `src/lib/ingest/otel/adapters/qoder.ts`：服务端 Qoder OTLP 聚合。
- `test/qoder-trace-collector.test.ts` / `test/qoder-desktop-extension.test.ts` / `test/qoder-performance.test.ts`：确定性、账号/产品隔离、重试、Skill/MCP/连接器、最新版 snapshot、多层 Subagent、安装、四端启动预算和首 Token 开销验证。

## 十、OpenCode 模型请求关联

**OpenCode 1.x：** `scripts/opencode_plugin_otel.ts` 的 `chat.headers` 使用插件 SDK 查询当前会话消息，仅在 session、用户 parentID、agent、provider、model 均匹配且唯一的未结束 assistant 存在时绑定。查询限时 1 秒，缺失、歧义或查询失败只记录 `llm.correlation.unbound`，不阻止模型调用，也不按时间或最近消息猜测归属。`input.message.id` 是用户消息 ID，不能直接作 LLM 调用 ID。

| 模型请求头 | 最终 LLM interaction 字段 | 语义 |
|---|---|---|
| `x-agent-insight-request-id` | `inference_request_id` | 根据当前 session 与 assistant message ID 生成的稳定逻辑调用标识，processor 重试复用 |
| `x-agent-insight-session-id` | `inference_session_id` | 实际发起请求的会话；子 Agent 不替换成根 `task_id` |
| `x-agent-insight-message-id` | `messageID` | assistant 消息 ID |
| `x-agent-insight-attempt-id` | `inference_attempts[].attempt_id` | 每次实际 fetch 独立生成，SDK 内部重试也各自记录 |

插件在进程中为现有 `globalThis.fetch` 安装一次 Proxy，仅处理已登记且 session、message、request 三个 ID 都匹配的请求；最多保留最近 4096 个逻辑调用的登记。重复插件实例共享同一代理，每次 fetch 只生成一个 attempt ID。代理保留 fetch 属性、请求正文、signal、响应和异常，无关联请求直接使用原参数调用原 fetch。不会写入 provider 的 `options.fetch`，避免覆盖 OpenCode 在配置阶段之后加载的 OAuth 鉴权或协议处理逻辑。

逻辑调用以 `llm.request` 写入 spool；HTTP 尝试以 `llm.attempt` 写入开始记录及收到的状态码或异常类型。HTTP 200 不是流式响应完整结束的证明。绕过全局 fetch 的特殊传输、覆盖代理且不调用原 fetch 的插件，以及登记被淘汰后的请求，只保留逻辑关联，不能据此声称已采集完整 attempt。

`scripts/opencode_uploader_client.js` 按 `(sessionID, assistant messageID)` 关联原始事件，按 attempt ID 合并开始/结果和重复记录；冲突的逻辑请求 ID 不附到节点。`mergeGraph` 保留子会话身份，原有上传处理器、Session JSON 存储及 `buildAgentCallTree` 原样保留新增字段。历史记录没有关联信息时保持缺失，不填造 ID。

回归入口为 `test/opencode-inference-correlation.test.ts`。已使用 OpenCode 1.18.29 与自定义 OpenAI-compatible Chat Completions SSE 网关验证同会话连续两次调用、两个子 Agent 并发、503 自动重试；实际 uploader → HTTP → 上传处理器 → SQLite 读回 → 最终 LLM 节点及重复上报均保留一致标识。原生 LLM runtime、其他 provider 特殊传输和后续插件覆写 headers/fetch 的组合不在本次实测范围。

### OpenCode 2.x 原生插件

安装脚本读取 `opencode --version`：1.x 使用默认工厂产物，2.x 下载 `/api/setup/opencode?apiVersion=2` 的 `{ id, setup }` 定义。同一源文件分别生成两个产物，不能把 1.x 的默认函数直接装入 2.x。升级或降级主版本后重新执行客户端安装命令并重启 OpenCode。2.x 跳过仅适配 1.x 的 TUI 扩展安装；RAS 和 TUI 功能不属于本次 2.x 数据链路验收范围。

2.x 使用官方 `context` / `model.request` / `http.request` / `http.response` 与原生 session 事件，不修改 OpenCode 二进制。系统提示词、用户消息、文本/推理增量、工具结果、父子会话、tokens 和结束/失败状态转换为已有 spool 记录。原生 `subagent` 工具保留实际子会话 ID，映射为既有工具聚合入口。

2.0.32 的 `session.step.started` 在 HTTP 请求发出之后才公布 `assistantMessageID`。因此 `model.request` 先生成 transport request UUID，`http.request` 验证 session、agent、model、kind 和该 UUID，并为每次 HTTP 请求生成 attempt UUID。网关仍在出站前生成统一 `X-Agent-Insight-Call-Id`，包括非 2xx 请求。原生 step 到达时，只将当前会话**唯一**待绑定的 primary 请求与该消息绑定；多个候选、模型不一致、缺失事件均不按时间或队列顺序猜测。标题、压缩等辅助调用保留 Trace 级关联，不冒充 primary LLM。

采集器记录 canonical `inference_request_id = oc_<hash(sessionID, assistantMessageID)>`，每次 `inference_attempts` 同时保留 `transport_request_id`、`attempt_id` 与 `call_id`。uploader 用 `(sessionID, transport_request_id, attempt_id)` 的唯一原生绑定证明回填网关 journal；显式错误 message ID 不会被迟到证明覆盖。重试的多个调用 ID 归入同一个原生 LLM 节点；空响应也保留显式 LLM 类型和原生错误摘要。1.x 只有 session.error 时，用错误响应中的统一 call ID 精确回填对应节点的错误，不按会话最近消息猜测。无证明的请求保留为 `inference_unassigned_calls`。

V2 的 `http.request` 只为已显式登记的受管地址确保本机转发进程可用，不再解析真实上游、注册新路由或改写新 URL。Provider transform 仅将受管地址设为 HTTP；未接管 Provider 的地址和传输方式保持用户配置。调用身份、失败重试与迟到 step 的关联方式不变。新增 Provider 必须执行下述显式命令。

回归入口另包括 `test/opencode-v2-adapter.test.ts` 和 `test/opencode-plugin-distribution.test.ts`。真实 ARM64 CLI 数据链路验证覆盖 1.18.29、2.0.32 读取旧配置和 2.0.32 原生 `providers` 配置：多次调用、并发子 Agent、失败重试、切换模型、新 Provider 首请求，以及 uploader HTTP → 上传处理器 → SQLite → 最终 Trace/LLM 和重复上报。真实客户端协议验收为 OpenAI-compatible Chat Completions SSE；Responses、Anthropic 和 Windows 不等于已完成真实客户端验收。

## 十一、统一推理转发入口

面向推理服务提供方的字段、重试语义和适配要求见 [推理服务模型调用 ID 接入说明](inference-service-integration.md)。

`scripts/inference_gateway.mjs` 是独立本地 Node.js HTTP 转发进程。Agent 的自定义模型 Base URL 指向配置的 `basePath`，入口将后缀拼接到固定 `upstreamBaseUrl`。一条路由对应一种原生协议：OpenAI 的 `/chat/completions`、`/responses`，或 Anthropic 的 `/messages`；另支持 `/models` GET。不同协议不互相转换，不修改模型名或提示词。CLI 只监听 loopback；中央网关和跨机器关联记录同步尚未实现。

对每次模型 POST，入口生成 UUID v4，覆盖并发送 `X-Agent-Insight-Call-Id`，同值通过响应头返回。推理服务只需要将此头绑定到收到的推理记录；整条链路用 ID 集合查询，单 LLM 用其 ID 集合查询。客户端重试分别生成 ID，入口本身不重试。不把 HTTP 200 当作模型流完整结束，journal 独立记录 `completed` / `cancelled` / `stream_error` / `transport_error` / `timeout`。没有到达推理服务的请求不会存在远端推理记录。

转发保留正文、SSE、状态码、认证与协议头，去除 hop-by-hop 头和 Agent 特定关联头；推理服务只接收统一关联头。上游来自显式配置或本机受管配置状态，禁止请求方指定任意 URL，不跟随重定向且移除 Location。默认透传模型认证，`apiKeyEnv` 可指定上游密钥环境变量名。关联记录不保存请求正文、模型输出或认证字段。

网关与采集器必须使用同一 `AGENT_INSIGHT_HOME` 和采集账号。网关账号优先级为显式参数、进程 `AGENT_INSIGHT_API_KEY`、本地 `config`、本地 `.env`、anonymous。记录目录为 `inference-gateway/<account-hash>/<agent>/<session-hash>/<call-id>.json`，先原子保存开始记录再请求上游，随后原子更新结果；目录权限 700、文件 600。journal 是本地关联依据，至少保留到采集与上传结束，当前不自动清理。

- Qoder collector 按当前 turn 范围读取本地记录，用原生 `session-id` 与成功 JSON/SSE 中的 response ID 唯一匹配 LLM。重复响应 ID、多节点歧义、没有响应 ID 的失败请求均不猜测归属。未匹配尝试通过根 Span 的 `agent_insight.inference.unassigned_calls` 进入 system 元数据，整体入口可查询，具体原生 LLM 不冒领。合成错误消息仍无推理响应 ID。
- OpenCode 插件从响应头保留 `call_id`；uploader 另从 journal 按 session/message/request/attempt 精确回填，覆盖响应头前取消。没有合法消息锚点时保留 Trace 级未归属记录。账号级 revision 与内容签名保证迟到的关联字段可以重新上报已经结束的 Trace。子会话保留实际 session，重试 ID 集合归入同一逻辑 LLM。
- 统一节点字段为 `inference_call_ids: string[]`，原生 request/response/attempt 字段不改义。前端优先使用统一 ID，因此不要求推理服务理解不同 Agent 的身份结构。

`AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 配置推理分析站点 origin（HTTP(S) 协议、主机、端口）。RootLayout 在 `connection()` 后读取运行时配置，通过客户端 Context 供统一按钮使用；因此页面按请求动态渲染，无需重新构建。Docker entrypoint 保留容器环境中显式设置的值，其优先级高于运行目录 `.env`；显式空值关闭跳转，未设置时仍读取 `.env`。客户 Compose 修改此项后执行 `docker compose up -d` 使容器采用新环境；仅执行 `restart` 不会应用 Compose 环境变更。只接受无凭据、路径、查询和片段的 origin；未配置/无效时不生成外链。链接在新标签页打开，ID 用 URLSearchParams 编码，不发送平台鉴权信息。

回归入口：`test/inference-gateway.test.ts`、`test/opencode-inference-correlation.test.ts`、`test/inference-analysis.test.ts`。真实 CLI 验收须比较推理服务实际收到的头、网关 journal、采集上传、SQLite 读回及最终节点；单测支持某协议不等于该协议在真实 Agent 上已验收。

### curl 安装与显式模型配置

Unix setup 选择 `qoder` / `opencode` 时，从现有 `?component=` 白名单下载三个 inference 组件及 `model-proxy.sh`，语法检查后原子发布 `inference-runtime` 并调用 `prepare`。新安装只准备工具，不扫描或改写模型配置，不启用代理进程。采集 Hook、插件和采集环境配置仍按原安装流程更新。无新增 API 或数据库表；PowerShell 未分发模型代理工具。

用户在 Agent 项目目录单独执行：

```bash
sh ~/.agent-insight/model-proxy.sh opencode
```

安装器用 `sh -n` 校验 Shell 入口，保存已验证 Node 的绝对路径到版本目录的 `node-path`，并发布稳定入口 `$AGENT_INSIGHT_HOME/model-proxy.sh`。Shell 保留调用者工作目录，转调现有 `configure`；默认 Agent 为 OpenCode，允许透传 Qoder 配置参数。优先检测安装时 Node，失效时从 PATH 查找，均要求 20+；没有兼容运行时则在配置修改前退出，不安装系统依赖。CLI 同步更新持久化的 Node 路径，避免旧路径失效后无法重新启动网关。自定义目录用安装器打印的实际路径。

最后一个参数支持 `opencode`、`qoder`、`opencode,qoder`。`install` / `sync` 是兼容别名，但安装器与运行时不调用它们。`configure` 在本机文件锁内：启动并健康检查 loopback 转发进程 → 扫描所选 Agent 的全局、项目和指定文件 → 校验所有 JSON/JSONC → 写备份 → 发布路由 → 比较原文并原子改写地址。旧端口不可用时明确失败，不切换到其他端口。新增 Provider、用户改回上游、环境变量上游变更只在再次显式执行时处理。后台进程没有配置轮询。

`inference_config.mjs` 按 JSON 字符串位置修改，保留格式、注释、认证和模型内容。字段为 Qoder `providers.<id>.baseUrl`、OpenCode 1.x `provider.<id>.options.baseURL`、2.x `providers.<id>.settings.baseURL`。通过文件真实路径、字段路径及已登记 managed URL 精确识别受管地址，不根据 `/managed/` 外观猜测；来源不明的受管地址拒绝作为上游，避免代理环路。上游路由按文件、字段、协议和解析后的上游地址生成；历史路由保留供已有会话使用。

备份在 `inference-proxy/backups/<sha256(realpath)>/`：`original.jsonc` 为首次命令前完整原件且不覆盖；`latest.jsonc` 是本次完整配置中仅将已登记地址还原后的副本，新增、修改和删除均同步保留。精确保留地址原字符串及环境表达式。备份目录 0700、文件 0600，路径通过结果的 `backups` 和终端输出告知用户；备份含密钥，绝不上传。路由状态只保存必要的地址、字段和备份路径，不保存整份配置或模型密钥。任何备份写入失败时不发布新路由或改用户文件；多文件改写中途并发冲突不覆盖用户修改，也不回滚已经完成的文件，重试可继续。

命令的 `coverage` 仅统计当前持久配置中成功识别的受管字段，不计历史路由或旧运行时快照；`configured` 不代表真实模型请求已验收。Qoder GUI 仍返回 `adapter_unavailable`。

OpenCode 1.x `config` 和 2.x `http.request` 只唤起已登记地址所需的转发进程，不改用户文件、最终合并配置或未登记 URL。配置和路由不再在插件中自动发现；未受管 Provider 保持直连。1.x 的异常保护继续避免已配置代理故障时静默绕过。2.x 仅对受管 Provider 强制 HTTP，不再全局改变其他 Provider 的 WebSocket 行为。

新安装不包装 Qoder CLI、不改厂商启动入口。显式命令读取 Qoder `--config-dir`、`QODERCN_CONFIG_DIR`、`--cwd`、`--setting-sources`、`--settings <文件>`；内联 settings 不自动接管。新增 Provider 后需要重跑命令并重启会话，客户端机器重启后也需重新启动转发进程。新版持久状态写入 `explicitEnabled`，同时将旧 `enabled` 固定为 `false`，阻止已缓存旧模块的 Agent 进程继续自动接管。升级旧安装时，`prepare` 替换旧轮询进程，只更新内容哈希仍匹配的旧启动包装器为不改配置的参数透传版本；旧包装器先保存到 `legacy-launchers`，用户改过的包装器报错并保留。已登记路由继续工作，升级不新接管地址。

采集安装前仍提醒用户自行备份 Hook / 插件配置；模型配置备份由显式命令负责。不提供自动卸载或整份配置恢复入口。回归入口为 `test/inference-config.test.ts`、`test/inference-proxy.test.ts`、`test/inference-proxy-setup.test.ts`、`test/opencode-inference-correlation.test.ts`、`test/opencode-v2-adapter.test.ts`。测试区分真实 Bash/Node 与模拟推理数据链路、真实 Agent 验收。

### Qoder GUI 模型存储与接入边界

普通安装与 auto 安装共用 `INFERENCE_PROXY_UNIX_SETUP_BLOCK`。当前不再分发客户端自动卸载组件，也不生成卸载/恢复脚本；Desktop 卸载监视和 JetBrains 动态卸载清理已移除。安装提醒用户自行备份，采集与模型转发能力按下面的产品边界判断。

2026-10-16 核查官方 CN 发行包：Desktop 1.33.0 的模型列表是用户数据目录 `User/globalStorage/state.vscdb` 中的 `aicoding.customModels`，凭证使用 SecretStorage；IDEA 2026.1014.79711813 使用 IDE 配置目录 `options/qodercn_setting.xml` 的 `byokModelConfigs`，敏感值使用 PasswordSafe；Work 0.9.18 使用用户数据目录 `data/agents.db` 的 `byok_custom_models`，`url` 与 `encrypted_parameters` 分离。它们均不是 CLI `providers` 配置。

进一步在 macOS ARM64 执行原包函数：Desktop 的 `addModel` 可保存 `baseUrl`，但主请求 `ChatSessionService.resolvePromptModelMeta` 与子请求 `CustomModelService.resolveModelConfig` 均重新构造参数，不传递 `baseUrl` / `url` / 额外 parameters，只保留 `parameters.api_key`。因此不能通过修改该数据库实现已确认的模型地址接管。

JetBrains 核心 2026.1014.79696485 的字节码显示：`ChatTaskUtil.resolveCustomModel` 与 `EnterpriseModelService.buildCustomModelParam` 构造 `CustomModelParam` 时第 10 个形参 `url` 都为 null；普通 BYOK 的 extraFields 仅进入 parameters。内嵌 2026.1014.1 ARM64 运行时的 `start --help` 可执行，但 `--endpoint` 是产品后端入口，不能等同模型 Base URL。原生 IDE 后端静态路径还包含 `/api/v2/byok/config`、`/api/v2/byok/check`、登录及内部 Agent 协议，未验证兼容通用推理服务。这里分别是原函数隔离执行、字节码/反汇编检查和帮助命令运行，不是 GUI 到模型服务的实际请求验收。

Desktop / JetBrains 的 ACP 消息/请求标识与推理侧响应 ID 的等价关系尚未证明。collector 不将这两个产品的本地消息 ID 与网关 journal 猜测匹配；服务端保留 `messageID`，置 `inference_response_unavailable`，不导出推理响应/会话 ID 或接受旧采集器误填的统一调用关联。相应回归在 `test/qoder-gui-inference-boundary.test.ts`。后续适配须同时证明地址接管、实际出站身份和采集节点身份，才能解除此限制。

JetBrains 本地 Token 数据库优先读取已存在的 `~/.qoder-cn/shared_client/cache/db/local.db`，否则保留 `~/.qoder/shared_client/cache/db/local.db` 回退；`AGENT_INSIGHT_QODER_TOKEN_DB` 显式配置仍优先。读取只查询指定 session 的 assistant 记录。仅有 SQLite 用量而无 transcript 时，LLM 节点保留该行的本地 `messageId`，但不将它提升为推理响应 ID。Qoder adapter 将真实 LLM Span 标记为 `trace_kind=llm`，调用树在正文缺失时仍保留节点，以“未采集到模型输出”作摘要；空占位消息和 `trace_synthetic` 记录不据此生成模型节点。该路径已用 PyCharm 2026.2.3 / Qoder CN 2026.1014.79711813 的真实会话数据复测；数据重放不等于 Hook 自动触发或模型网关接管验收。

Work 的 `resolveByokCustomModelPayload` 返回 `url`，后续模型解析传给 SDK，但尚未完成该产品的客户端请求身份与网关验收。这些属于版本相关内部实现，不能扩大为整个 Qoder 产品家族的已验证代理能力。部署与客户端安装步骤见[客户部署指南](../user-guide/customer-image-deployment.md)。

历史卸载阶段曾在隔离 HOME 与本地 HTTP 模拟服务上验证恢复直连、用户修改保留、组件移除和进程停止；这些历史结果不代表当前版本仍提供卸载/恢复能力，对应旧验收项已撤出当前要求。GUI 未启动，不将源代码/函数验证等同于真实 Desktop、IDEA、Work 的端到端请求验收。
