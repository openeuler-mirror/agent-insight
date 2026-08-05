# 运行时故障注入：工具结果篡改 / 提示词修改 / 拦截改写

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../agent_fault_injection/) 负责注入与采集。 独立 FastAPI/Vite 不纳入产品路径。见 [server-client-split.md](server-client-split.md) · [ras-fi-insight-relationship.md](ras-fi-insight-relationship.md)。


> 非侵入：不修改 OpenCode / xiaoO 源码，仅经官方插件 / Hooker 改写数据面。  
> 关联：[架构总览](architecture.md) · [xiaoo 适配](xiaoo-platform-adaptation.md) · [业界调研](agent-semantic-fault-injection-survey.md)

## 0. 三维模型

| 轴 | 含义 | 本仓落点 |
|----|------|----------|
| **注入方式** | 怎么注入 | catalog `injection_methods`（下表） |
| **故障类型** | 注入什么语义故障 | `skills/*` 目录 |
| **变异模式** | Semantic vs Structure | runtime op 实现策略（P0 均为 Structure） |

## 1. 注入方式（对外六类）

| key | 中文 | 状态 |
|-----|------|------|
| `skill_inject` | Skill 注入 | 已落地 |
| `file_tamper` | 文件篡改 | 已落地 |
| `prompt_modify` | 提示词修改 | **已落地**（MAS-FIRE Prompt Modification） |
| `tool_result_tamper` | 工具结果篡改 | 已落地 |
| `intercept_rewrite` | 拦截改写 | **已落地 P0**（MAS-FIRE Interception + AutoInject） |
| `route_manipulate` | 路由操纵（预留） | **不实现** |

## 2. 平台挂点

| 注入点 | OpenCode | xiaoO |
|--------|----------|-------|
| System / Prompt | `experimental.chat.system.transform` | `*.Chat.system.transform`（或 `--system` 回退） |
| Messages | `experimental.chat.messages.transform` | `*.Llm.complete.pre` |
| Assistant 文本 | `experimental.text.complete` / `chat.message` | `*.Llm.complete.post` |
| Tool 结果 | `tool.execute.after` | `*.Tool.*.post` |

## 3. 配方与示例

`injection.runtime` 由 Adapter 注入 `AGENT_RAS_INJECTION_RUNTIME`。

| method | 示例故障 | 主要 op |
|--------|----------|---------|
| `tool_result_tamper` | `tool-result-corruption` | `tool_result.replace_text` |
| `prompt_modify` | `prompt-system-override` | `system.append` |
| `intercept_rewrite` | `interception-history-inject` | `messages.inject` |
| `intercept_rewrite` | `interception-assistant-corruption` | `assistant.replace_text` |

配置：`configs/*prompt*`、`configs/*interception*`、`configs/tool-result-corruption*`。

## 4. 边界

- **工具结果篡改**：真实 tool 执行后的 output  
- **拦截改写 messages**：下一次 LLM 请求中的历史/伪造消息  
- **提示词修改**：system/user 文本面（与 Skill 装载剧本不同）

## 5. 证据与 Judge

- **不再**由注入工具 / 插件强制写 `runtime-*.before/after.txt` 自证快照  
- 平台事件：`fault.injection.applied`（kind=`tool_result`|`prompt`|`messages`|`assistant`）可记入 `events.jsonl`  
- Judge：**以轨迹、终答、终态 workspace 为主**；`runtime_injection` / `structural_injection` 仅在有遗留快照或事件时可选出现，缺省不当作必要条件

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-08-05 | 边界重划：injection_tools 仅能力；不写自证快照；Judge 看轨迹/终答 |
| 2026-08-04 | 意译六 key（skill_inject / …）；无旧版兼容；落地 prompt + intercept；route 预留 |
| 2026-08-04 | 改名六类；落地 prompt + interception P0；routing 预留 |
| 2026-08-04 | 初版 L3 runtime FI |
