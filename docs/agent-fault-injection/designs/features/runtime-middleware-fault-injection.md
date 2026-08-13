# 运行时故障注入：工具结果篡改 / 提示词修改 / 拦截改写

> 非侵入：不修改 OpenCode / xiaoO 源码，仅经官方插件 / Hooker 改写数据面。

## 0. 三维模型

| 轴 | 含义 | 本仓落点 |
|----|------|----------|
| **注入方式** | 怎么注入 | catalog `injection_methods`（下表） |
| **故障类型** | 注入什么语义故障 | `skills/*` 目录 |
| **变异模式** | Semantic vs Structure | runtime op 实现策略（P0 均为 Structure） |

## 1. 注入方式（对外五类）

| key | 中文 | 状态 |
|-----|------|------|
| `skill_inject` | Skill 注入 | 已落地 |
| `file_tamper` | 文件篡改 | 已落地 |
| `prompt_modify` | 提示词修改 | **已落地**（MAS-FIRE Prompt Modification） |
| `tool_result_tamper` | 工具结果篡改 | 已落地 |
| `intercept_rewrite` | 拦截改写 | **已落地 P0**（MAS-FIRE Interception + AutoInject） |

## 2. 平台挂点

| 注入点 | OpenCode | xiaoO |
|--------|----------|-------|
| System / Prompt | `experimental.chat.system.transform` | `*.Chat.system.transform`（或 `--system` 回退） |
| Messages | `experimental.chat.messages.transform` | `*.Llm.complete.pre` |
| Assistant 文本 | `experimental.text.complete` / `chat.message` | `*.Llm.complete.post` |
| Assistant tool call 参数 | provider `fetch` 拦截（JSON/SSE） | **未对称落地**（OpenCode 优先） |
| Tool 结果 | `tool.execute.after` | `*.Tool.*.post` |

## 3. 配方与示例

`injection.runtime` 由 Adapter 注入 `AGENT_FI_INJECTION_RUNTIME`。

| method | 示例故障 | 主要 op |
|--------|----------|---------|
| `tool_result_tamper` | `tool-observation-delta`（业务）；smoke `tool-result-token` | `tool_result.replace_text` |
| `prompt_modify` | `planning-logic-error`@4；smoke `prompt-system-token` | `system.append` |
| `intercept_rewrite` | `memory-noise-interference`@4；smoke `history-inject-token` | `messages.inject` |
| `intercept_rewrite` | `intermediate-conclusion-drift`；smoke `assistant-corruption-token` | `assistant.replace_text` |
| `intercept_rewrite` | `skill-selection-conflict` / `tool-argument-error` | `assistant.tool_call.replace_argument` |

配置示例由 Insight FI 任务表单 / 实验 YAML 提供（不再维护包内 `configs/*` 示例目录）。

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
| 2026-08-10 | 吸纳独立仓业务语义故障；新增 `assistant.tool_call.replace_argument`；TOKEN 探针下沉 smoke |
| 2026-08-10 | `injectionEvidence` 从 collect 协议移除；对外注入方式统一为五类（`route_manipulate` 已废） |
| 2026-08-05 | 边界重划：injection 仅能力；不写自证快照；Judge 看轨迹/终答 |
| 2026-08-06 | `injectionEvidence` 产品字段废弃（曾固定 `{}`）；本机 Judge / evaluation.py 删除；包目录归位 pipeline + catalog/injection |
| 2026-08-04 | 意译五 key（skill_inject / …）；无旧版兼容；落地 prompt + intercept；第六类 route 预留后废弃 |
| 2026-08-04 | 初版 L3 runtime FI |
