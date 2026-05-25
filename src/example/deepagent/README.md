# deepagentsjs 示例（仓库根目录依赖）

参考 [`langchain-ai/deepagentsjs`](https://github.com/langchain-ai/deepagentsjs/tree/main/examples) 官方仓库，覆盖默认用法、Skills、SubAgents，以及 **持久化对话 + 人工审批（HITL）**。

## 文件清单

| 文件 | 场景 | 关键 API |
|---|---|---|
| `01-basic-agent.ts` | 最简 | `createDeepAgent({ model })` + 流式 |
| `02-skills-agent.ts` | Skills | `createDeepAgent({ skills, checkpointer })` |
| `03-subagent-agent.ts` | SubAgents | `createDeepAgent({ subagents })` |
| `04-memory-hitl-agent.ts` | 记忆 + 审批 | `checkpointer: MemorySaver`、`interruptOn`、`thread_id` |

## 安装与运行

在**仓库根目录**安装依赖（本目录不再单独维护 `package.json`）：

```bash
cd /path/to/witty-skill-insight
pnpm install

# 配置模型（可复制示例后再编辑）
cp src/example/deepagent/.env.example .env
# 或把变量写入仓库根目录已有 .env
```

运行示例：

```bash
pnpm deepagent:ex1   # 默认 agent + 流式
pnpm deepagent:ex2   # skills
pnpm deepagent:ex3   # subagents（无 TAVILY_API_KEY 时会走离线占位数据）
pnpm deepagent:ex4   # MemorySaver + interruptOn（write_file 需审批，脚本内自动批准）
```

所有示例均通过 `shared.ts` 中的 **`streamDeepAgentUntilDone`**：使用 **`agent.stream`**，`streamMode: ["messages","values"]`，异步迭代并以 **token 流式** 打印模型输出。

---

## 设计要点摘要

### 示例 1

`createDeepAgent({ model: createDeepSeekModel() })` 可获得默认的规划 / 文件系统 / task 等能力；模型来自 `.env`（默认 `deepseek-chat`）。

### 示例 2（Skills）

一个 skill = 目录 + `SKILL.md`（YAML frontmatter）。示例会把远端与内联 skill 写入虚拟文件系统，并演示 `skills: ["/skills/"]`。可选 `MemorySaver` + `thread_id` 做会话维度隔离。

### 示例 3（SubAgents）

主代理通过 `task` 派生子代理；子代理上下文隔离。

### 示例 4（README 进阶：持久化 + 人工审批）

- **持久化对话**：`checkpointer: new MemorySaver()`，并在每次 `stream`/`invoke` 的 config 里固定 **`configurable.thread_id`**，多轮请求共享同一 checkpoint。
- **人工审批**：`interruptOn` 声明哪些工具在执行前进入 HITL；命中后状态中会出现 `__interrupt__`，需用 **`Command({ resume })`** 传入 `HITLResponse` 继续执行。本示例对 `write_file` 配置审批，并在代码里 **自动 `approve`** 以便一键跑通；真实产品中应替换为真人确认 UI。

---

## 其它方向（未单独示例）

- **持久化文件**：`FilesystemBackend({ rootDir: "..." })`，文件落盘。
- **沙箱执行**：继承 `BaseSandbox`，真正执行 shell。
