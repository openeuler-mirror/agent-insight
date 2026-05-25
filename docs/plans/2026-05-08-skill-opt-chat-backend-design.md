---
title: Skill 优化 chat 后端接入：复用 playground 链路
date: 2026-05-08
status: approved
---

## 背景与目标

`opt` 分支已上线 skill-opt 前端（列表 + 优化双页 + 多草稿迭代 + 多版本 diff），目前所有数据走 `_mock.ts`，「开始优化」用 `setTimeout(800ms)` 假造一次后端响应。

后端侧已有两套现成的修改范式：
- **playground 链路**：`runGeneralAgent` + opencode runtime，agent 在 cwd 用 edit/write 工具改文件，过程通过 SSE 流式推到前端
- **trace2skill 链路**（`skills/skill-optimizer/scripts/engine/trace2skill/`）：multi-analyst 并行产出结构化 `SkillPatch` → 层级合并 → LLM apply，离线 batch，无 chat 交互

两者各有优劣（详见末尾"附录·路线对比"）。本期采纳**混合方案**：

- **短期（本期）·  chat 主链路走 playground 范式**：用户点「开始优化」走 SSE，agent 在 workspace 用工具改文件。在 system prompt 里把 `checkedIssues` 结构化呈现，并借鉴 trace2skill 的 prevalence 思路提示 agent 合并同源修改。
- **中期（独立 PR）·  trace2skill 接成 batch endpoint**：新加 `/api/skill-opt/auto-optimize`（非 chat，纯进度），前端可加「一键自动优化」按钮调它。本期不开工，但接口位置与命名预留。

本期目标：**把 chat 这条主链路跑通** —— 用户点「开始优化」后，真实 agent 读取现有 skill 内容，按用户勾选的 issues + 文字诉求做修改，把过程（thinking / tool 调用 / 文本）流到前端，结束后把 workspace 里改完的文件作为「草稿」喂回 diff 视图。

**显式不做**（留给后续迭代）：
- 真实 issue 列表生成（继续用 `MOCK_ISSUES`）
- 「采纳草稿 → 写为新版本」的 apply 接口（前端继续 alert）
- 对话历史持久化（playground 用 Prisma `PlaygroundMessage`，我们这版纯内存，刷新即失）
- 用户多轮 follow-up（先支持「点一次按钮跑一次」，多轮在 chat 流水里展示但不影响 workspace）
- trace2skill batch endpoint（中期独立 PR）

## 参考链路：playground

`POST /api/playground/chat` → `streamPlaygroundOpencode()` → `runGeneralAgent()`（opencode 执行）→ `ChatHandlers` 把 opencode 事件翻译成 SSE（`text` / `thinking` / `tool_call` / `tool_result` / `vfs_patch` / `done` / `error`）→ 前端 `handleSendMessage` 解析 SSE 渲染消息块。

我们直接镜像这个结构，差异只在三处：① 系统提示词（skill 优化语义）② workspace 预填（把现有 skill 文件 copy 进 cwd 让 agent 修改）③ 前端把 final VFS 注入 `iterations[]` 而不是渲染下载卡片。

## 新增 / 修改文件清单

| 文件 | 类型 | 作用 |
|---|---|---|
| `src/app/api/skill-opt/chat/route.ts` | 新增 | SSE 路由，镜像 `playground/chat/route.ts` 的 mock+real 双模 |
| `src/lib/skill-opt-bridge.ts` | 新增 | 镜像 `playground-opencode-bridge.ts`，加一步「workspace 预填」 |
| `src/lib/engine/general-agent/skill-opt-prompt.ts` | 新增 | skill 优化 system prompt 构造（独立小文件，便于后续调） |
| `src/app/(main)/skill-opt/[name]/[version]/page.tsx` | 改造 | `startOptimize` 从 setTimeout 改为 fetch SSE，按事件渲染 chat |
| `src/lib/system-agents.ts` | 改 | 注册 `skill-optimizer` 系统 agent（platform=opencode） |

预计改动 ~400 行新增 + ~80 行前端修改。

## 后端设计

### 接口
`POST /api/skill-opt/chat`，请求体：
```ts
{
  user: string;             // 多租户 key（同 playground）
  threadId: string;         // 一次"优化会话"的 id；前端首次请求生成（uuid），后续 follow-up 复用
  skillName: string;        // 如 "pdf-extractor"
  baseVersion: number;      // 用户从哪个版本起优化
  checkedIssues: Array<{    // 勾选的优化点，精简字段
    id: string;
    severity: 'high' | 'medium' | 'low';
    summary: string;
    evidence?: string;
  }>;
  userFeedback: string;     // chat input 拼出来的自由文本（可空）
  modelId?: string;         // 复用 user-settings 里配置的模型
  mock?: boolean;           // 默认 false
}
```

返回：`text/event-stream`，事件协议与 playground 完全一致。

### Bridge 与 playground 的关键差异

**workspace 预填**（playground 没有这一步）：
- `workspaceTag = threadId`，runner 内部 `ensureSessionWorkspace(user, workspaceTag)` 会得到稳定目录
- bridge 在调 `runGeneralAgent` 前判断目录是否「空」（只有可能存在的 `.skill-opt-prompt/` 等隐藏挂载目录）
- 若空：从 `data/storage/skills/<skillId>/v<baseVersion>/` 把 SKILL.md / scripts/ / references/ 复制过去
- 若非空：说明是同 thread 的 follow-up，直接复用现有内容
- skill id 通过 `db.findSkills({ name: skillName })` 拿到

**system prompt**（替换 playground 的 skill-generator 那套）：

借鉴 trace2skill 的 `ERROR_ANALYST_SYSTEM_PROMPT` + prevalence 思路，但改成单 agent 工具式落地：

```
你是 Skill 优化助手。当前工作目录是用户的现有 skill 包，包含：
- SKILL.md（主文件）
- scripts/（可执行脚本，可能为空）
- references/（参考资料，可能为空）

用户希望你基于以下输入对 skill 进行修改：

## 待优化点（用户已勾选，按 severity 排序）
[渲染 checkedIssues：每条带 id · severity · category · summary · evidence]

## 用户附加诉求
[渲染 userFeedback；为空时省略此节]

## 工作原则
1. **先看后改**：用 read 工具查看 SKILL.md 与相关文件，再下手
2. **prevalence 优先**：如果多个 issue 指向同一段文本或同一类问题，合并成一次修改并表达成"通用原则"，而不是为每个 issue 单独打补丁
3. **不要无关改动**：只动直接对应 issue 或用户诉求的内容；保持原有结构和格式
4. **就地编辑**：用 edit / write 工具直接改原文件，不要新建 .draft / .new / *.bak 之类的副本
5. **收尾报告**：用一段话说明 ① 改了哪些文件 ② 解决了哪些 issue id ③ 哪些 issue 没动以及为什么
```

把 issue 结构化注入而不是塞成自由文本，是为了让 agent 在最后报告里能精准回引 issue id —— 前端后续可以用这个映射在 issue 列表上打"已处理"标。

`interactionPolicy: 'auto-allow'`（与 playground 一致）。

**事件协议复用**：直接抄 playground bridge 的 `ChatHandlers` 实现 —— `onText` / `onReasoning`（含 fullText 去重）/ `onTool` / `onFileEdited` / `onAssistantMessage` / `onSession`。skill-opt 不需要「ask user」，所以 `onQuestion` 可以省（或保留兜底，agent 真问就走 auto-skip）。

**watchdog / 超时**：直接复用 playground 的 12s idle + 15min stream cap。

**最终输出**：和 playground 一样在 `done` 前发一次全量 `vfs_patch`；不发 `download` 卡片（这层语义对 skill-opt 没意义，前端忽略即可）。

## 前端改造

### `(main)/skill-opt/[name]/[version]/page.tsx`

新增 state：
```ts
const [threadId] = useState(() => crypto.randomUUID());  // 每次进页面一个 thread
```

`startOptimize` 主体重写：
```ts
// 1. 构造 chat 消息 (user + 一个 placeholder agent 块)
// 2. fetch '/api/skill-opt/chat' (SSE)
// 3. 边解析边追加：
//    - text  → 当前 agent 块 text 累加
//    - thinking → 独立 thinking 块（kind='thinking', id, text, done）
//    - tool_call → push tool 块 (status=running)
//    - tool_result → 找 id 更新 status/summary
//    - vfs_patch → 暂存 latestFiles
//    - done → setOptimizing(false)；用 latestFiles 构造 OptimizationIteration push 进 iterations
//    - error → 给 chat 加红色错误块
```

`ChatMsg` union 扩展一个 `thinking` 分支（playground 已有现成的，可以参考其渲染样式）。

VFS → iteration 转换：把 `/workspace/SKILL.md` 重命名成 `SKILL.md`（去前缀），把内容数组 join 成字符串，套进现有 `OptimizationIteration` 结构。

### `_mock.ts`

不动。`MOCK_ISSUES` 仍然是 issue 列表的来源；`generateNextDraft` 在真链路接通后不再调用，但保留以便 mock 模式回归。

## 验证方案

按 SOP 两步：

**1. `npm run test`**：
- 新增 `test/skill-opt-bridge.test.ts`：mock `runGeneralAgent`，验证 workspace 预填逻辑（已有 vs 全空两种 case）和 system prompt 拼装

**2. `bash scripts/restart_dev.sh` + 浏览器**：
- 路径：列表页 → 选一个 skill → 优化页 → 勾两个 issue + 输入文字 → 点开始优化
- 期望：chat 区域出现 thinking 流 → 几个 tool_call/tool_result → text 总结；右侧 diff 自动展开，能看到 SKILL.md 的修改
- 边界：① 只勾 issue 不输入 ② 只输入不勾 ③ 同一 thread 第二次点击（workspace 复用）④ mock=true（不调 LLM 也能走通）

## 风险点

1. **skill 在 DB 里没文件**：用户在前端选的 skill 可能是 mock 数据里有但 DB 没有的。预填阶段拿不到内容会失败。**应对**：bridge 里 catch 这个 case，往 SSE 推一条 `error` 让前端友好提示，并在 mock 模式下从 `MOCK_SKILLS` 兜底（仅开发期）。
2. **多用户并发同一 skill**：playground 用 threadId 隔离，每个 thread 有独立 workspace。skill-opt 同样，所以两个用户优化同一 skill 不会串。
3. **agent 改坏文件**：iteration 是「快照」，前端有 rollback；agent 在自己 workspace 里改，不动真源 `data/storage/skills/`。安全。

## 落地节奏

1. 新增 system-agent 注册 + prompt 模块
2. 写 `skill-opt-bridge.ts`（先不接前端，单元测试覆盖预填）
3. 加 `route.ts`（mock 模式可独立联调）
4. 改前端 `startOptimize` + chat 渲染
5. 端到端走一遍真链路

每一步可独立 commit，遵循 conventional commits（`feat:` 为主）。

## 附录 · 三条路线对比（决策依据）

| 维度 | A · 纯 playground | B · 纯 trace2skill | **C · 混合（采纳）** |
|---|---|---|---|
| chat 体验 | 好（thinking/tool/text 流） | 差（只有阶段进度） | 好（chat 走 A），自动模式可独立按钮（接 B） |
| 多 issue 融合 | 弱（单 agent 一次跑） | 强（multi-analyst + hierarchical merge + prevalence） | chat 路径靠 prompt 提示；批量路径靠 trace2skill |
| 行级冲突处理 | 没有 | 有（行重叠检测 + LLM 合并算子） | chat 路径不显式处理（agent 自己看着办）；批量路径有 |
| 实现成本 | 低（镜像 playground） | 中（要把 Python pipeline 包成 Node API 或子进程） | 短期低 + 中期可选加 |
| 与 UI 现有交互契合度 | 高（chat 是用户主操作） | 低（用户只能等） | 高 |

C 的本质是不用 chat 范式去硬塞 trace2skill 的合并能力 —— 两种范式各自做最擅长的事，UI 上区分两个入口（"开始优化" = chat 微调；未来"一键自动优化" = trace2skill batch）。
