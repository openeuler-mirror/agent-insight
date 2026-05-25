---
title: Skill 优化对话历史持久化
date: 2026-05-09
status: approved
---

## 决策（用户 review 后确认）

1. **不复用 PlaygroundSession**：新建独立表 ✅
2. **Iteration 必须持久化**：用户期望点开历史记录能看到「每次可优化点是什么、做了哪些改进」、能用 diff viewer 对比任意草稿 → 加 `SkillOptIteration` 表 ✅
3. **UI 弹窗 + 简单列表**：mirror playground 的历史弹窗（不是抽屉/侧栏），不做筛选/搜索，每条记录用 `{skillName} v{base} → {tipLabel}` 形态展示（tipLabel = "草稿 #N" 或 "v{N+1}" 已发布）✅

## 背景与目标

`opt-be` 分支上一版做完了 skill-opt 的 chat 主链路（已合入 upstream）。chat / iteration / files 全部活在 React state 里，**刷新即失**。本期目标：复用 playground 的"历史对话"模式做 skill-opt 的会话持久化。

非目标（后续 PR）：
- iteration（草稿）的多版本独立持久化（看下文「Iteration 怎么办」）
- 跨 skill 全局搜索 / 标签 / 归档
- 协作（多人共享）

## 与 playground 的对应关系

playground 的实现已经摸清楚（详见上一轮 Explore 报告），核心就 4 件事：

| 维度 | playground | skill-opt 套用 |
|---|---|---|
| 表 | `PlaygroundSession` + `PlaygroundMessage` | 新建 `SkillOptSession` + `SkillOptMessage` |
| 列表 / 创建 / 详情 / 改名 / 删除 API | `/api/playground/sessions[/:id]` | 镜像到 `/api/skill-opt/sessions[/:id]` |
| chat 时落库 | route.ts 里 `createBlockMirror` + `JSON.stringify(getBlocks())` 入 `PlaygroundMessage.blocks`；最终 VFS 入 `PlaygroundSession.files` | 现有 `/api/skill-opt/chat/route.ts` 加同款 mirror + 落库 |
| 前端切 session | `hydrateMessages(rawMessages)` 解出 `blocks[]` 还原 thinking/tool/download UI | 完全复用 `hydrateMessages` 的解析逻辑（block 协议两边对齐） |

## 数据模型（Prisma 新增两张表）

```prisma
model SkillOptSession {
  id                  String   @id @default(cuid())
  user                String
  /// 业务上下文：哪个 skill 哪个 base version 起的优化（用户切 skill 时不会串）
  skillName           String
  baseVersion         Int
  /// "新对话"默认值；首条 user 消息后自动截 30 字
  title               String   @default("新对话")
  /// 最后一次 vfs_patch 的全量文件（playground 同款）
  files               String   @default("{}")
  /// opencode 后端 session id（多轮上下文复用）
  opencodeSessionId   String?
  /// trace 归属
  agentName           String?
  agentTraceSkill     String?
  messages            SkillOptMessage[]
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([user, skillName, baseVersion, updatedAt])
}

model SkillOptMessage {
  id          String   @id @default(cuid())
  sessionId   String
  role        String   // 'user' | 'agent'
  content     String   // markdown 兜底（legacy / 简单展示）
  /// JSON Block[]: thinking / text / tool / error 顺序数组
  blocks      String   @default("[]")
  createdAt   DateTime @default(now())

  session     SkillOptSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId, createdAt])
}
```

★ 设计说明：
- **不复用 PlaygroundSession** —— 表里加 `sessionType` 鉴别符表面上能省一张表，代价是：① playground/skill-opt 的迁移、查询、索引互相耦合 ② 字段语义对不上（playground 没有 skillName/baseVersion，skill-opt 不需要 scenario）。两张独立表是干净选择。
- `(user, skillName, baseVersion, updatedAt)` 索引覆盖列表页的最常用查询："给我看 user X 在 skill Y v1 上的最近会话"。
- `blocks` 直接复用 playground 的 Block JSON 协议——`hydrateMessages` 解析逻辑通用，不需要为 skill-opt 写新版本。

## API 路由（5 个，全部镜像 playground）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/skill-opt/sessions` | GET | 按 user + skillName + baseVersion 列出会话（updatedAt 倒序，含 messages 嵌套） |
| `/api/skill-opt/sessions` | POST | 新建（body 带 skillName / baseVersion / 可选 title / 可选 initial messages） |
| `/api/skill-opt/sessions/[id]` | GET | 单会话详情（含全部 messages） |
| `/api/skill-opt/sessions/[id]` | PATCH | 改 title / files |
| `/api/skill-opt/sessions/[id]` | DELETE | 级联删 messages |

**`/api/skill-opt/chat/route.ts` 改造**：
- 接受 `threadId` = 会话 id（不再随机 uuid）
- 进来先保存 user message
- 如果 `title` 还是默认值「新对话」，按首条 user 消息截 30 字自动改名
- 流结束时保存 agent message + `JSON.stringify(blocks)` + 最终 files —— 完全沿用 playground 的 `createBlockMirror`，可以直接 `import` 而不是复刻

## Iteration 怎么办

**采纳 B · 持久化 iteration** —— 加第三张表 `SkillOptIteration`，每次 agent turn 结束时把 files 快照 + 修改总结存进去：

```prisma
model SkillOptIteration {
  id            String   @id @default(cuid())
  sessionId     String
  /// session 内的草稿编号（递增；UI 显示成 "草稿 #1" "草稿 #2"）
  draftNumber   Int
  /// agent 产出的「## 修改总结」markdown 主体（用于优化报告）
  summary       String
  /// 全量文件快照 JSON（{ relPath: content }）
  files         String
  /// 这次草稿基于哪一批勾选的 issue（id 列表 JSON），UI 上"做了哪些改进"用
  resolvedIssueIds String @default("[]")
  createdAt     DateTime @default(now())

  session SkillOptSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, draftNumber])
  @@index([sessionId, createdAt])
}
```

reload 后右栏 diff viewer 完整复用：base ↔ 任意草稿对比、优化报告（`summary`）正常展示、点 issue 列表上的"已优化"标记也能基于 `resolvedIssueIds` 重建。

## 复用清单

| 项 | 复用方式 |
|---|---|
| `createBlockMirror` | `import` from `@/app/api/playground/chat/route.ts`（如果是 module-private 就提取到 `@/lib/chat/block-mirror.ts`） |
| `hydrateMessages` | 同上，提取到 `@/lib/chat/hydrate-messages.ts` |
| Block / Message 类型 | 已经在 `@/components/chat/chat-blocks.tsx`（上次 PR 抽出来过），ChatTurn 增强一下 |
| Session UI 组件 | playground 的"历史"列表是 inline 的，提取成 `<ChatHistoryPanel>` 给两边用——本 PR 只搬 skill-opt 这一份；playground 重构留下次去重 PR |

## 前端 UX

skill-opt 优化页（`/skill-opt/[name]/[version]`）顶部加「历史」按钮（沿用 playground icon），点开**模态弹窗**（不是抽屉，与 playground 一致）。

弹窗内容（不做筛选 / 搜索）：

```
┌─ 优化记录 ─────────────────────────────── ✕ ┐
│  [+ 新对话]                                  │
│                                              │
│  ✏️ pdf-extractor v1 → 草稿 #3   14:32  🗑   │
│  ✏️ pdf-extractor v1 → v2 已发布  13:10  🗑   │
│  ✏️ pdf-extractor v1 → 草稿 #1   12:01  🗑   │
└──────────────────────────────────────────────┘
```

每行的 tipLabel 计算：
- 没有 iteration：「新对话」
- 有 iteration 未发布：`草稿 #${draftNumber}`（取最新一份）
- 已发布（未来扩展）：`v${baseVersion + 1} 已发布`（本期不做发布逻辑，先按草稿展示）

只在当前 (skillName, baseVersion) 范围内列。切到别的 skill 进同一弹窗看到的就是另一组。

切 session 流程：
1. 关弹窗
2. fetch `/api/skill-opt/sessions/[id]`（含 messages + iterations）
3. hydrate messages 还原 chat（复用 `hydrateMessages`）
4. setIterations(session.iterations.map(parseIteration))
5. setFiles(JSON.parse(session.files))
6. 默认选中最新 iteration 在 diff viewer 里展示

URL: 不带 sessionId（playground 同款）。reload 后取列表里第一条恢复。

每次 agent turn 跑完时：除了已经在做的 push iteration 到本地 state，还要 **POST 一份 snapshot 到后端** 持久化（`POST /api/skill-opt/sessions/[id]/iterations`）。

## 落地节奏

1. Prisma migration（加 3 张表：Session / Message / Iteration）
2. 抽 `block-mirror.ts` / `hydrate-messages.ts` 共享模块（playground 当前用得到的也顺手解开）
3. 5 个 sessions API + `POST /sessions/[id]/iterations` (共 6 个)
4. `chat/route.ts` 接持久化（落库 + 自动改名 + opencodeSessionId）
5. 前端：历史按钮 + 模态弹窗 + switchSession + persistIteration on turn end
6. 验证两步（`bash scripts/restart_dev.sh` 浏览器点 + `npm run test`）

## 风险点

- **opencode 多轮上下文丢失**：reload 后 `opencodeSessionId` 从 DB 读回，agent 能延续之前的对话。但 opencode server 自身可能因为重启清掉那个 session id —— bridge 已经有"复用失败重试"逻辑（playground 同款），不破。
- **跨 skill 串话**：每个 session 的 (skillName, baseVersion) 锁死，列表查询带 where 过滤，不会出现 A skill 的对话出现在 B skill 列表里。
- **草稿 lost 的用户预期**：要明确告知。考虑在 chat empty 状态加一行小字："切换历史会话会清掉本页未发布的草稿"。
