# Qoder CN Trace 采集器 AC1–AC37 完整验收与演示手册

本文用于验收 Qoder CN 产品家族 Trace 采集器，覆盖 Qoder CN Desktop、Qoder CN CLI、Qoder for JetBrains、Qoder Work CN 以及共享的上传、卸载、性能和数据正确性能力。

本文把证据分为三类：

- **自动化证据**：验证采集器、Adapter、安装脚本和性能约束的确定性行为。
- **真实客户端演示**：验证 Qoder 产品实际产生的 Hook、Transcript、Diagnostics、SQLite 和工具调用能够被采集。
- **长时间或破坏性验证**：包括 8 小时内存测试、断网恢复和卸载清理，应在隔离测试环境执行。

只有同时满足用例中的“通过条件”并保存相应证据，才应将 AC 标记为通过。不要用单元测试代替真实客户端安装和交互验证，也不要仅凭平台列表出现一条记录就判定全部字段正确。

---

## 1. 安全说明

1. 不要把真实 API Key、Access Token、Cookie 或账号口令写进命令历史、截图、测试提示词或提交到仓库。
2. AC30–AC32 会停止采集进程并清理 Qoder 采集器配置。仅在隔离测试机执行；执行前备份需要保留的数据。
3. AC26 会模拟网络中断。不要在生产服务端执行。
4. 测试只使用本仓库或专用测试目录，不要让 Agent 修改业务项目。
5. 每个真实客户端用例都使用唯一标识，避免与历史 Trace 混淆：

```powershell
$runId = (Get-Date).ToString("yyyyMMdd-HHmmss")
$runId
```

6. 每次验收记录以下环境信息：

```powershell
node --version
git rev-parse HEAD
git status --short
[Environment]::OSVersion.VersionString
```

---

## 2. 环境和变量

### 2.1 必需环境

- Windows 10/11。
- Node.js 20 或更高版本。
- Agent Insight 源码及依赖。
- Qoder CN Desktop。
- Qoder CN CLI。
- 安装了 Qoder 插件的 JetBrains IDE。
- Qoder Work CN。
- 3000 端口可用。

### 2.2 PowerShell 变量

在新的 PowerShell 窗口执行，并把 `$repo` 改为实际仓库路径：

```powershell
$repo = "C:\path\to\agent-insight"
$serverBase = "http://127.0.0.1:3000"
$runId = (Get-Date).ToString("yyyyMMdd-HHmmss")
Set-Location $repo
```

### 2.3 安装依赖并启动服务端

```powershell
npm.cmd install
npx.cmd next dev -H 0.0.0.0 -p 3000
```

看到 `Ready` 后，在另一个 PowerShell 窗口检查服务首页：

```powershell
$response = Invoke-WebRequest "$serverBase/" -UseBasicParsing
$response.StatusCode
```

通过条件：输出 `200`。本项目没有 `/api/health` 路由，不要把该地址作为启动检查。

### 2.4 仅安装 Qoder CN 产品家族采集器

在 Agent Insight 的“安装指导”页面选择 `Qoder CN product family`，复制 Windows 命令执行。也可以安全输入 API Key 后执行：

```powershell
$secureKey = Read-Host "Agent Insight API Key" -AsSecureString
$plainKey = [System.Net.NetworkCredential]::new("", $secureKey).Password
$encodedKey = [Uri]::EscapeDataString($plainKey)
irm "$serverBase/api/ingest/setup?yes=1&frameworks=qoder&key=$encodedKey" | iex
Remove-Variable plainKey, encodedKey
```

安装结果必须包含 CLI、Desktop、JetBrains、Work 四个产品的 `spoolDir`、`accountHash` 和上传进程信息。

CLI 与 Work 的安装流程还应自动注册精确 Token 环境变量：

```powershell
[Environment]::GetEnvironmentVariable("QODERCN_EXPOSE_TOKEN_USAGE", "User")
```

通过条件：输出 `1`。设置变量后必须彻底退出并重新启动已运行的 Qoder CN CLI 和 Qoder Work CN。

### 2.5 插件包下载地址

```text
http://127.0.0.1:3000/api/ingest/setup/qoder-desktop-vsix
http://127.0.0.1:3000/api/ingest/setup/qoder-jetbrains-plugin
```

服务端应分别返回：

- `agent-insight-qoder-desktop-0.1.12.vsix`
- `agent-insight-qoder-jetbrains-0.1.9.zip`

版本号升级时，以响应中的实际文件名为准。

---

## 3. 自动化回归入口

### 3.1 Qoder 专项测试

```powershell
Set-Location $repo
node --import tsx --test `
  test/qoder-trace-collector.test.ts `
  test/qoder-desktop-extension.test.ts `
  test/qoder-performance.test.ts `
  test/qoder-setup-routes.test.ts `
  test/agent-platform.test.ts
```

通过条件：所有测试通过，无 `fail`、`cancelled` 或未处理异常。

### 3.2 Qoder 与其他采集器隔离回归

```powershell
node --import tsx --test `
  test/otel-consumer.test.ts `
  test/qoder-trace-collector.test.ts `
  test/qoder-setup-routes.test.ts `
  test/claude-otel-ingest.test.ts `
  test/otel-trace-normalize.test.ts `
  test/otel-protobuf-decode.test.ts `
  test/otel-trace-aggregator.test.ts `
  test/framework-adapter-registry.test.ts `
  test/openclaw-e2e.test.ts
```

通过条件：所有 Qoder 及非 Qoder 回归测试通过。该结果是“新增 Qoder 采集器没有破坏其他采集器”的必要证据之一。

### 3.3 全量测试

```powershell
npm.cmd test
```

如全量测试存在与本特性无关的基线失败，应保存完整日志，并分别给出：

- 当前分支结果。
- `upstream/master` 或约定基线的结果。
- 两者差异是否由 Qoder 变更引入。

---

## 4. AC 总览

| AC | 验收内容 | 主要证据 |
|---|---|---|
| AC1 | Desktop 通过 VSIX 安装 | 真实安装 + 插件测试 |
| AC2 | CLI 通过配置注入 Hook | 真实 CLI + setup 测试 |
| AC3 | JetBrains 本地/市场安装 | 真实安装 + ZIP 下载测试 |
| AC4 | Work 桌面插件机制安装 | 真实 Work + setup 文件 |
| AC5 | 统一隔离 spool | 目录检查 + 隔离测试 |
| AC6 | Agent/Quest 根 Trace 字段完整 | 真实 Desktop Trace |
| AC7 | Quest 步骤可追溯 | 真实 Quest + collector 测试 |
| AC8 | Subagent 父子关联 | 真实并发子 Agent + 关联测试 |
| AC9 | 专家团协作关联 | 真实专家团 + collector 测试 |
| AC10 | Skill Trace 字段完整 | Desktop/CLI `/trace-probe` |
| AC11 | 文件、搜索、终端、MCP 等 Tool Trace | 真实 Tool 综合任务 |
| AC12 | Tool 名称、类型、参数、耗时、退出码/错误 | Trace 详情 + 导出 |
| AC13 | Tool 正确关联所属 Agent | 调用树 + parentSpanId |
| AC14 | 敏感信息自动脱敏 | 假密钥测试 + 导出 |
| AC15 | 每次 LLM 调用记录模型与供应商 | LLM span 详情 |
| AC16 | LLM Token 与推理延迟 | 精确 usage + Timeline |
| AC17 | 五种国产模型切换 | 五模型对照表 |
| AC18 | 超过 2000 字符截断 | 截断测试 + 导出 |
| AC19 | JetBrains FileEdit Trace | 真实创建、修改、删除 |
| AC20 | JetBrains Terminal Trace | `node --version` |
| AC21 | JetBrains 最终结果 | 唯一完成标识 |
| AC22 | Work 文档/数据分析 Trace | 真实 Work 办公任务 |
| AC23 | Work MCP 与连接器 | `trace-echo` + 浏览器 |
| AC24 | 定时上传且会话结束小于 3 秒 | 自动化 + 毫秒日志 |
| AC25 | 停用前主动 flush | 自动化 + 关闭应用实测 |
| AC26 | 断点续传、去重、指数退避 | 自动化 + 断网实测 |
| AC27 | 启动增加小于 200 ms | 性能测试 |
| AC28 | 首 Token 增加小于 5% | 配对中位数测试 |
| AC29 | 内存小于 50 MB 且 8 小时无泄漏 | soak summary |
| AC30 | 四端卸载后停止采集 | 隔离机卸载测试 |
| AC31 | spool 与配置清理 | `--purge` 检查 |
| AC32 | 不影响其他采集器且可重装 | 隔离回归 + 重装 |
| AC33 | 单次标准任务产出七类 Trace | 标准化 payload 测试 |
| AC34 | 父子关系 100% 正确 | 关联测试 + 调用树 |
| AC35 | Token 误差小于 5% | 四端精确用量对照 |
| AC36 | 同一任务三次结构一致 | 规范化结构测试 |
| AC37 | Adapter 转换 ExecutionRecord | Adapter + consumer 测试 |

---

## 5. 安装与部署：AC1–AC5

### AC1：Qoder CN Desktop 通过 VSIX 安装

步骤：

1. 下载 `/api/ingest/setup/qoder-desktop-vsix`。
2. 打开 Qoder CN Desktop。
3. 进入 Extensions，选择“从 VSIX 安装”。
4. 选择下载的 `.vsix` 并重启 Qoder CN Desktop。
5. 检查扩展列表、状态栏和 Settings。

通过条件：

- 扩展列表显示 `Agent Insight Qoder CN Collector`。
- 状态栏显示 `Agent Insight`。
- Settings 能搜索到 `Agent Insight Qoder`。
- 默认最大内容长度为 2000。

自动化证据：

```powershell
node --import tsx --test test/qoder-desktop-extension.test.ts
```

保存证据：扩展列表、状态栏、Settings 三张截图，以及测试日志。

### AC2：Qoder CN CLI 通过 Hook 加载

安装后检查：

```powershell
Get-Content "$env:USERPROFILE\.qoder-cn\settings.json" -Encoding UTF8
Get-ChildItem "$env:USERPROFILE\.agent-insight\qoder-owners"
```

启动 Qoder CN CLI，执行：

```text
[AC2-<runId>] 请只读取当前项目的 package.json，返回 name 和 version，不修改文件。
```

通过条件：

- `settings.json` 中存在 Agent Insight 管理的 Hook。
- Hook 命令指向 `~/.agent-insight/qoder_trace_collector.mjs`。
- 执行记录的产品来源为 `Qoder CN CLI`，详情页根 Agent 名称为 `Qoder CLI`。
- Trace 内至少包含 USER、LLM 和 Read Tool。

### AC3：Qoder for JetBrains 插件安装

步骤：

1. 下载 `/api/ingest/setup/qoder-jetbrains-plugin`。
2. JetBrains IDE → Settings → Plugins。
3. 点击齿轮 → Install Plugin from Disk。
4. 选择下载的 ZIP，应用并重启 IDE。
5. 检查 Plugins、状态栏和 Agent Insight Settings。

通过条件：

- 插件列表显示 `Agent Insight Qoder Collector`。
- 状态栏出现 Agent Insight 状态组件。
- Settings 中出现 Agent Insight 配置。
- 后续 Trace 的产品来源是 `Qoder for JetBrains`，不能误报为 Desktop；默认根 Agent 名称为 `Qoder`。

### AC4：Qoder Work CN 安装

安装后检查：

```powershell
Get-Content "$env:USERPROFILE\.qoderworkcn\settings.json" -Encoding UTF8
Get-ChildItem "$env:USERPROFILE\.agent-insight\qoder-owners"
```

彻底退出并重新启动 Qoder Work CN，然后执行：

```text
[AC4-<runId>] 对 10、20、30 三个数做只读汇总，返回总和与平均值。
```

通过条件：

- Work 配置中存在 Agent Insight 管理的采集 Hook。
- 平台出现 `Qoder Work` Trace。
- Trace 至少包含 USER、LLM 和最终结果。

如果产品要求在“插件”页面可见，而实际仅写入 Hook，则本项不能只凭 Trace 判定通过，应按导师确认的安装形态补齐或记录偏差。

### AC5：统一 spool 和多账号隔离

```powershell
$qoderSpool = "$env:USERPROFILE\.agent-insight\otel_data\qoder"
Get-ChildItem $qoderSpool -Directory -Recurse |
  Select-Object FullName
```

期望结构：

```text
~/.agent-insight/otel_data/qoder/
├── cli/<accountHash>/
├── desktop/<accountHash>/
├── jetbrains/<accountHash>/
└── work/<accountHash>/
```

多账号验证：

1. 使用测试账号 A 安装并记录 `<accountHash-A>`。
2. 使用测试账号 B 安装并记录 `<accountHash-B>`。
3. 两个账号分别运行一个带唯一标识的只读任务。
4. 检查文件没有写入对方子目录。

通过条件：

- 四个产品都位于统一的 `qoder/` 根目录。
- 不同 API Key 的 hash 子目录不同。
- 同一账号的事件不会跨目录。
- Trace 归属到认证用户，而不是把 hash 当作平台用户。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="account-isolated|authenticated ownership|spool" test/qoder-trace-collector.test.ts
```

---

## 6. Desktop Agent、Quest、Subagent、Expert、Skill：AC6–AC10

### AC6：Agent/Quest 根 Trace 字段

在 Qoder CN Desktop Agent 模式执行：

```text
[AC6-<runId>] 请只读取当前项目的 package.json，返回 name 和 version；不要创建、修改或删除文件，最后输出 AC6-<runId>-done。
```

打开由 `Qoder CN Desktop` 上报的最新 Trace。普通 Agent 模式下根 Agent 名称应为 `Qoder`；Quest/专家团模式分别应为 `Quest Agent`/`Experts Agent`。

通过条件：

- 根 Agent Trace 存在。
- 包含 `sessionId`、完整或截断后的 query、model、totalTokens、latency、result。
- 状态为成功。
- totalTokens 为可用的精确值；如果数据源明确不可用，不得伪装成精确值。

### AC7：Quest 任务规划与步骤

在 Desktop 中切换到 Quest 模式，执行：

```text
[AC7-<runId>] 使用 Quest 模式完成只读分析：
1. 创建任务目标；
2. 至少拆成三个步骤；
3. 读取 package.json 和 README.md；
4. 进行方案或 Spec 对齐；
5. 汇总结果。
禁止修改任何文件。
```

通过条件：

- Trace 中出现 `quest_goal`。
- 至少出现三个 `quest_step`。
- 每一步的名称、顺序、耗时和结果可追溯。
- 步骤属于同一个根 Agent Trace。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="Quest emits a goal" test/qoder-trace-collector.test.ts
```

### AC8：Subagent 创建、并发与父子关系

在 Desktop Agent 模式执行：

```text
[AC8-<runId>] 必须在同一次响应中并行启动两个独立的 Research/Explore 子 Agent：
1. 第一个只读取 package.json 的 name 和 version；
2. 第二个只读取 README.md 的第一个标题。
等待两个子 Agent 都完成后再汇总。禁止修改文件。
```

通过条件：

- 顶部至少显示 `AGENTS 3`、`TASK SPAWNS 2`。
- 两个 TASK 都是根 Agent 的子节点。
- 每个 TASK 下存在独立子 Agent。
- 并发时间线允许重叠，但父子 traceId 不能串线。
- 子 Agent 有描述、状态、结果和可用的 Token 字段。

多层嵌套自动化证据：

```powershell
node --import tsx --test --test-name-pattern="multi-level parent-child|child Agent spans" test/qoder-trace-collector.test.ts
```

### AC9：专家团多 Agent 协作

在 Desktop 选择专家团模式，执行：

```text
[AC9-<runId>] 使用专家团完成只读分析，至少分配两个不同专家：
1. 架构专家分析 package.json 的技术栈；
2. 文档专家分析 README.md 的定位。
记录专家分工，等待全部完成后汇总结论，禁止修改文件。
```

通过条件：

- Trace 中出现至少两个专家 Agent。
- 专家名称、角色、任务描述、状态和输出可辨认。
- 两个专家正确关联到根 Agent。
- 平台显示 Multi-Agent 或等效专家团标记。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="Experts restores" test/qoder-trace-collector.test.ts
```

### AC10：Skill Trace

在 Qoder CN Desktop 或 CLI 的“技能/指令”中创建测试 Skill：

- 名称：`trace-probe`
- 版本：`1.0.0`
- 行为：只读取当前项目 `package.json`，返回 `name`，不修改文件。

然后执行：

```text
/trace-probe
```

通过条件：

- 顶部显示 `SKILL CALLS 1`。
- 调用链中出现 SKILL span。
- 导出的 Trace 包含 `skillName`、version、triggerMode、params、result。
- Skill 内部 Read Tool 正确关联到该 Skill 或所属 Agent。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="Skill Trace span|Skill activation" test/qoder-trace-collector.test.ts
```

---

## 7. Tool 与脱敏：AC11–AC14

### AC11–AC13：Tool 类型、字段和归属

在 Qoder CN Desktop 或 CLI 执行：

```text
[AC11-<runId>] 完成以下只读验证：
1. 列出当前目录；
2. 读取 package.json；
3. 搜索 package.json 中的 name；
4. 在终端运行 node --version；
5. 在终端运行 node -e "process.exit(7)"，这是预期失败；
6. 汇总结果。
不要创建、修改或删除文件。
```

通过条件：

- **AC11**：文件查找、目录读取、文件读取、搜索、终端命令分别产生 Tool Trace。
- **AC12**：Tool Trace 包含 toolName、toolType、输入摘要、执行耗时；成功命令记录退出码 0，预期失败命令记录退出码 7 或错误信息。
- **AC13**：Tool Trace 的 traceId/parentSpanId 正确关联到所属 Agent。
- MCP Tool 应归类为 `mcp`，办公连接器应归类为 `connector`。

查看方式：

1. 打开 Trace 详情。
2. 展开 Tool span。
3. 检查 Overview、Timeline 和导出 Trace。

### AC14：敏感信息自动脱敏

不要用真实密钥测试。自动化用例已经使用假的 Bearer、API Key 和密码样本：

```powershell
node --import tsx --test --test-name-pattern="redaction" test/qoder-trace-collector.test.ts
```

通过条件：

- `authorization`、`api_key`、`access_key`、`secret`、`token`、`password`、`cookie`、`private_key` 等敏感字段被替换。
- `Bearer ...`、`sk-...`、AKID/LTAI 类字符串不会出现在 Trace。
- `input_tokens`、`output_tokens` 等计量字段不会因为字段名含 `token` 而被误删。

保存证据：测试日志和一份仅含假密钥的导出 Trace。

---

## 8. LLM 与 Token：AC15–AC18

### AC15–AC16：LLM 调用字段

使用 AC6 的 Trace，逐个展开 LLM span。

通过条件：

- **AC15**：每次模型调用产生 LLM Trace，并包含 modelName、provider。
- **AC16**：包含 promptTokens、completionTokens、totalTokens、推理延迟。
- 根 Trace 的 Token 汇总与子 LLM span 一致，不重复累加累计值。
- 精确数据与估算数据必须有明确标识，不能把估算值标成精确值。

CLI 与 Work 精确 Token 前置检查：

```powershell
[Environment]::GetEnvironmentVariable("QODERCN_EXPOSE_TOKEN_USAGE", "User")
```

Desktop 与 JetBrains 应优先读取各自的本地精确 SQLite usage；只有显式允许时才使用可见内容估算，并标注为 estimated。

### AC17：五种国产模型切换

在产品模型选择器中依次选择可用的：

1. Qwen
2. GLM
3. DeepSeek
4. Kimi
5. MiniMax

每次执行完全相同的提示词：

```text
[AC17-<model>-<runId>] 只回复当前所选模型的名称，不调用工具。
```

记录表：

| 序号 | 模型家族 | Qoder 显示名 | Trace modelName | provider | 是否一致 |
|---|---|---|---|---|---|
| 1 | Qwen |  |  |  |  |
| 2 | GLM |  |  |  |  |
| 3 | DeepSeek |  |  |  |  |
| 4 | Kimi |  |  |  |  |
| 5 | MiniMax |  |  |  |  |

通过条件：

- 五次 Trace 均能按唯一标识找到。
- `modelName` 随模型切换而变化。
- provider 与实际供应商一致。
- 账号未开放的模型应记录为环境限制，不能用其他模型冒充通过。

### AC18：2000 字符截断

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="truncates long content" test/qoder-trace-collector.test.ts
```

可选真实演示：

1. 准备超过 2200 字符、无敏感信息的重复测试文本。
2. 要求模型原样总结或返回。
3. 导出 Trace，检查 prompt/response 属性。

通过条件：

- 超过配置边界的内容被截断。
- 截断后包含明确的 `[truncated ... chars]` 提示。
- 不影响 Token、耗时、状态等结构化字段。

---

## 9. JetBrains：AC19–AC21

在 JetBrains 打开本仓库，并在 Qoder Agent 中执行：

```text
[AC19-21-<runId>] 完成 JetBrains Trace 验证：
1. 创建 integrations/qoder-jetbrains/build/trace-ac19-<runId>.txt，内容为 before；
2. 将内容修改为 after；
3. 在终端运行 node --version；
4. 删除刚才创建的 trace-ac19-<runId>.txt；
5. 最后输出 qoder-jetbrains-ac19-21-<runId>-done。
不要修改其他文件。
```

通过条件：

- AC19：出现 Write/SearchReplace/DeleteFile 或规范化后的 FileEdit Tool Trace，详情能判定为代码/文件编辑。
- AC20：出现 Bash/Terminal Tool Trace，记录命令、耗时和退出码。
- AC21：根 Agent Trace 的最终结果包含唯一完成标识。
- 产品来源是 `Qoder for JetBrains`，不能误报为 `Qoder CN Desktop`；默认根 Agent 名称为 `Qoder`。
- 临时文件最终不存在，其他文件未变化。

检查：

```powershell
Test-Path "$repo\integrations\qoder-jetbrains\build\trace-ac19-$runId.txt"
git status --short
```

通过条件：第一条输出 `False`，第二条没有本用例产生的改动。

---

## 10. Qoder Work CN：AC22–AC23

### AC22：办公任务 Trace

在 Qoder Work CN 执行：

```text
[AC22-<runId>] 对以下数据做只读分析：
一月 10，二月 20，三月 30。
输出总和、平均值和一个简短结论，不创建文件。
```

通过条件：

- 平台出现 `Qoder Work` Trace。
- 包含用户任务、Skill/Tool/LLM 调用链和最终结果。
- 文档处理或数据分析步骤能在 Timeline 中追溯。

### AC23：MCP 与办公连接器

先在 Qoder Work CN 中安装并启用专用测试 MCP Server，例如 `trace-echo`。测试工具名为 `trace_echo`，参数为 `message`。

执行：

```text
[AC23-MCP-<runId>] 必须调用 trace-echo MCP Server 的 trace_echo 工具，
参数 message 为 qoder-work-mcp-<runId>，返回工具原始结果。
```

然后启用一个无敏感权限的测试连接器，例如浏览器，执行：

```text
[AC23-CONNECTOR-<runId>] 必须使用浏览器连接器打开 https://example.com，
只读取网页标题和一级标题，不登录、不提交表单。
```

通过条件：

- MCP Trace 包含真实的 serverName、toolName、params、latency。
- 失败调用包含 error。
- Work 内部 `qw_mcp_get/qw_mcp_call` 包装器被还原为真实 MCP server/tool。
- 办公工具连接器归类为 `connector`，不能误记为普通 MCP。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="Work unwraps lazy|connector" test/qoder-trace-collector.test.ts
```

---

## 11. 上传与存储：AC24–AC26

### AC24：定时扫描与会话结束后 3 秒内上传

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="AC24" test/qoder-trace-collector.test.ts
```

真实演示：

1. 记下服务端当前时间。
2. 运行带唯一标识的短任务。
3. 会话结束后立即刷新 Agent Insight。
4. 记录服务端收到 Trace 的时间。

通过条件：

- 会话结束触发立即上传。
- 端到端到达 OTLP 接口的耗时小于 3 秒。
- 定时扫描仍能处理未被事件触发的 pending 文件。

平台显示“不到 1 分钟”不能单独证明小于 3 秒；应保存毫秒级日志或自动化测试输出。

### AC25：停用时主动 flush

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="deactivation|flushes before" `
  test/qoder-trace-collector.test.ts `
  test/qoder-desktop-extension.test.ts
```

真实演示：

1. 开始一个短会话。
2. 会话结束后立即关闭对应 Qoder 产品。
3. 检查 pending 目录和平台 Trace。

```powershell
Get-ChildItem "$env:USERPROFILE\.agent-insight\otel_data\qoder" `
  -Recurse -File -Filter *.json |
  Select-Object FullName, LastWriteTime
```

通过条件：

- 插件停用/应用退出前调用强制 flush。
- 已完成会话不丢失。
- 成功确认的 pending 快照被清理。

### AC26：断点续传、去重和指数退避

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="exponential retry" test/qoder-trace-collector.test.ts
```

隔离环境真实演示：

1. 停止 Agent Insight 服务端。
2. 在任一 Qoder 产品完成一个带唯一标识的短任务。
3. 检查 `pending/*.json` 仍存在。
4. 连续触发三次上传失败。
5. 检查同名 `*.retry.json` 中的失败次数和下一次重试时间递增。
6. 重启服务端。
7. 等待或强制触发上传。
8. 平台按唯一标识搜索。

```powershell
Get-ChildItem "$env:USERPROFILE\.agent-insight\otel_data\qoder" `
  -Recurse -File |
  Where-Object { $_.Name -match '\.retry\.json$|\.json$' } |
  Select-Object FullName, LastWriteTime
```

通过条件：

- 失败后 pending 不丢失。
- 连续失败进入指数退避。
- 恢复后成功上传并删除已确认 pending。
- 平台只有一条同 session/snapshot 记录，不重复创建 Execution。

---

## 12. 性能：AC27–AC29

### AC27：启动时间增加小于 200 ms

```powershell
node --import tsx --test --test-name-pattern="AC27" test/qoder-performance.test.ts
```

通过条件：

- 四端 Hook 均为异步。
- 采集器同步分派部分小于 200 ms。
- 保存测试输出中的样本数、基线和增量。

### AC28：首 Token 响应时间增加小于 5%

```powershell
node --import tsx --test --test-name-pattern="AC28" test/qoder-performance.test.ts
```

真实测量建议：

1. 同一机器、同一模型、同一提示词。
2. 未安装采集器运行至少 10 次。
3. 安装采集器后再运行至少 10 次。
4. 分别去掉第一次预热样本。
5. 比较中位数而不是单次结果。

计算：

```text
增加率 = (采集后首 Token 中位数 - 基线中位数) / 基线中位数 × 100%
```

通过条件：增加率小于 5%。

### AC29：常驻内存小于 50 MB，8 小时无泄漏

先做 60 秒冒烟：

```powershell
node scripts/qoder_memory_soak.mjs `
  --duration-seconds=60 `
  --interval-seconds=5 `
  --products=cli,desktop,jetbrains,work
```

再执行正式 8 小时测试：

```powershell
node scripts/qoder_memory_soak.mjs `
  --duration-hours=8 `
  --interval-seconds=60 `
  --products=cli,desktop,jetbrains,work
```

证据默认位于：

```text
~/.agent-insight/performance/qoder-ac29-*.jsonl
~/.agent-insight/performance/qoder-ac29-*.summary.json
```

通过条件：

- 采集器相关常驻 RSS 增加小于 50 MB。
- 8 小时内存增长不超过脚本阈值。
- 内存趋势斜率不显示持续泄漏。
- 期间各产品仍可正常产生和上传 Trace。

“运行了一段时间没有崩溃”不能替代 8 小时数据和 summary。

---

## 13. 卸载、清理与重装：AC30–AC32

> 下面是破坏性测试。仅在隔离测试机执行。

### 13.1 卸载前记录

```powershell
$dist = "$env:USERPROFILE\.agent-insight\qoder-distribution"
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'qoder_uploader_client\.mjs' } |
  Select-Object ProcessId, CommandLine
```

### AC30：四端卸载后停止采集

```powershell
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=cli --owner=cli
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=desktop --owner=desktop
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=jetbrains --owner=jetbrains
node "$dist\qoder_work_setup.mjs" uninstall
```

检查：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'qoder_uploader_client\.mjs' } |
  Select-Object ProcessId, CommandLine
```

通过条件：

- 四端对应上传进程均停止。
- 卸载后再运行新任务不会产生新的 Qoder Trace。

### AC31：清理 spool 和配置

如验收明确要求彻底清理，在隔离测试机使用 `--purge`：

```powershell
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=cli --owner=cli --purge
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=desktop --owner=desktop --purge
node "$dist\qoder_setup.mjs" uninstall --scope=user --product=jetbrains --owner=jetbrains --purge
node "$dist\qoder_work_setup.mjs" uninstall --purge
```

通过条件：

- Agent Insight 管理的 Qoder Hook 被移除。
- Qoder spool、marker、采集脚本和配置被清理。
- 用户原有的非 Agent Insight Hook、Skill、MCP 配置不被删除。

### AC32：不影响其他采集器并可重装

卸载前先记录其他框架的 Hook 和 watcher。卸载后检查 OpenCode、Claude Code、OpenClaw 等文件和进程没有变化。

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="AC30|AC31 and AC32|preserves unrelated hooks|removes only Agent Insight hooks" test/qoder-trace-collector.test.ts
node --import tsx --test test/framework-adapter-registry.test.ts
```

然后重新执行第 2.4 节的一键安装，并运行 AC6 冒烟任务。

通过条件：

- 其他采集器仍正常工作。
- Qoder 四端重新安装成功。
- 重装后能再次采集，且同一 Hook 不重复注入。

---

## 14. 数据正确性：AC33–AC37

### AC33：一次标准化任务产出七类 Trace

自动化标准用例：

```powershell
node --import tsx --test --test-name-pattern="AC33" test/qoder-trace-collector.test.ts
```

通过条件：同一标准化 payload 中完整产出：

1. Agent
2. Subagent
3. Quest
4. Expert
5. Skill
6. Tool
7. LLM

真实产品界面可能不允许在一个会话中同时选择 Quest 和专家团模式。此时应分别保存 AC7、AC8、AC9、AC10、AC11 和 AC15 的真实证据，同时保留 AC33 标准化 payload 测试作为“单次完整结构”的确定性证据，并在验收报告中明确说明产品模式限制。

### AC34：父子关系 100% 正确

```powershell
node --import tsx --test --test-name-pattern="multi-level parent-child|child Agent spans" test/qoder-trace-collector.test.ts
```

再人工检查 AC8/AC9 Trace：

- 每个 child span 的 traceId 与根 Trace 一致。
- parentSpanId 指向正确的 Task/Agent。
- 并发子 Agent 不互换父节点。
- 多级嵌套链能从根节点完整还原。

通过条件：抽取的全部父子边均正确，不允许“多数正确”。

### AC35：Token 与 Qoder 内置精确用量误差小于 5%

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="AC35" test/qoder-trace-collector.test.ts
```

真实对照表：

| 产品 | sessionId | Qoder 精确 input | AI input | Qoder 精确 output | AI output | 总误差 |
|---|---|---:|---:|---:|---:|---:|
| Qoder CN CLI |  |  |  |  |  |  |
| Qoder CN Desktop |  |  |  |  |  |  |
| Qoder for JetBrains |  |  |  |  |  |  |
| Qoder Work |  |  |  |  |  |  |

计算：

```text
误差率 = abs(Agent Insight total - Qoder exact total) / Qoder exact total × 100%
```

通过条件：四端每项小于 5%。

注意：

- Qoder Credits 不是 Token，不能作为 AC35 的分母。
- CLI/Work 应在 `QODERCN_EXPOSE_TOKEN_USAGE=1` 后重启并读取精确 usage。
- Desktop/JetBrains 应使用对应会话的本地精确 SQLite usage。
- 标有 `≈` 或 `estimated` 的数据只能用于可观测性兜底，不能证明 AC35。

### AC36：同一任务重复三次结构一致

自动化证据：

```powershell
node --import tsx --test --test-name-pattern="AC36" test/qoder-trace-collector.test.ts
```

真实演示：新建三个独立会话，分别执行完全相同的提示词：

```text
[AC36-<runId>] 只读取 package.json，返回 name 和 version，不修改文件。
```

比较时忽略：

- traceId、spanId、sessionId
- 时间戳和耗时
- Token 数值
- requestId

必须一致：

- span 类型和层级
- Agent/Tool/LLM 数量
- Tool 顺序
- 字段集合
- 成功/失败状态结构

通过条件：三次规范化后的 Trace 结构一致。

### AC37：Qoder Adapter 正确转换 ExecutionRecord

```powershell
node --import tsx --test --test-name-pattern="Qoder OTLP adapter converts" test/qoder-trace-collector.test.ts
node --import tsx --test --test-name-pattern="credential-authenticated Qoder" test/otel-consumer.test.ts
```

通过条件：

- Qoder OTLP payload 能转换为 ExecutionRecord。
- 根 execution、子 execution、模型、Token、结果、状态和时间字段正确。
- 更新中的同一会话使用最新 snapshot，不重复创建最终记录。
- 认证用户归属正确。
- Agent 管理和链路追踪页面均能查询到该 Execution。

---

## 15. 跨机器验收

采集器和 Agent Insight 服务端位于不同机器时，至少重复以下用例：

- AC2：远程安装 CLI Hook。
- AC5：客户端本地生成隔离 spool。
- AC6：客户端会话上传到远程服务端。
- AC23：MCP/连接器 Trace 上传。
- AC24：远程会话结束上传。
- AC26：远程服务不可用后的恢复。
- AC32：客户端卸载、重装和其他采集器隔离。

完整步骤见：

[qoder-cn-cross-machine-validation.md](qoder-cn-cross-machine-validation.md)

核心通过条件：

- 客户端 `.agent-insight/.env` 中的 Host 是服务端局域网地址，不是客户端 `localhost`。
- 客户端能访问服务端 3000 端口。
- 服务端能看到客户端产生的四端 Trace。
- 插件包从服务端下载接口获取。
- API Key 归属、产品名和账号隔离均正确。

---

## 16. 验收证据目录建议

每次验收创建独立目录，但不要把真实 API Key、用户数据库或含敏感内容的原始日志提交到仓库：

```text
evidence/qoder-cn/<runId>/
├── environment.txt
├── automated-tests.txt
├── ac01-desktop-install.png
├── ac03-jetbrains-install.png
├── ac06-agent-trace.png
├── ac07-quest-trace.png
├── ac08-subagent-trace.png
├── ac09-expert-trace.png
├── ac10-skill-trace.png
├── ac17-model-matrix.md
├── ac23-work-mcp.png
├── ac24-upload-timing.txt
├── ac27-ac28-performance.txt
├── ac29-soak.summary.json
├── ac30-ac32-uninstall-reinstall.txt
└── ac35-token-comparison.md
```

---

## 17. 最终验收报告模板

```markdown
# Qoder CN Trace 采集器验收报告

- 仓库 commit：
- 测试日期：
- 测试人：
- Agent Insight 版本：
- Qoder CN Desktop 版本：
- Qoder CN CLI 版本：
- Qoder for JetBrains 版本：
- Qoder Work CN 版本：
- Node.js 版本：

| AC | 结果（通过/失败/阻塞） | 证据 | 备注 |
|---|---|---|---|
| AC1 |  |  |  |
| AC2 |  |  |  |
| ... |  |  |  |
| AC37 |  |  |  |

## 自动化测试

- Qoder 专项：
- 非 Qoder 隔离回归：
- 全量测试：

## 已知限制

-

## 结论

-
```

最终提交前必须确认：

- AC1–AC37 每一项都有明确结果。
- “阻塞”项写明外部条件和复现步骤，不能直接写成通过。
- 估算 Token 不用于证明 AC35。
- 8 小时 soak 未完成前，AC29 不标记通过。
- 跨机器测试至少包含一个真实客户端和远程服务端。
- Qoder 变更没有删除或改写其他框架的注册项和安装选项。
