# 触发评价集（RecallTestSet）数据集版本化

> 2026-05-20 · 召回分析页

## 背景

`/skill-eval/trigger/<skillName>` 页目前每个 (user, skillName) 只持有**一份**触发评价集
（`SkillTriggerEvalSet` 的 `@@unique([user, skillName])`），AI 起草、用户编辑、手填都是在
**同一行**上原地改。问题：

- AI 重新起草会覆盖既有内容（即便保留 user-edited 条目，依然让人不敢点）。
- 想拿一份外部整理好的数据集进来评测，没有入口。
- 历次评测无法追溯到「当时的数据集长什么样」——`SkillTriggerEvalRun.triggerSetId` 虽然存了
  id，但那一行内容会被后续编辑覆盖，实际等于没存。

## 目标

1. 数据集支持多版本：AI 起草和上传都是**新建一个版本**，不动旧的。
2. 用户可手动编辑「当前版本」（在 UI 上表现为 latest）。
3. 评测时可选择用哪一个数据集版本。
4. 历次评测的结果与那一次用的数据集版本一一对应。
5. UI 上：历史评测面板保留（沿用现在 PR 里加的），再加一个「历史数据集」面板列出版本。

## 设计

### Schema

`SkillTriggerEvalSet` 的语义从「一行 = 一份评价集」变成「一行 = 评价集的一个版本」：

```prisma
model SkillTriggerEvalSet {
  id                   String   @id @default(cuid())
  user                 String
  skillName            String
  /// 同 (user, skillName) 下的版本号；递增，最大值即「latest / 当前」
  version              Int      @default(1)
  /// 该版本是怎么来的：'llm-draft' | 'user-upload' | 'manual'（手填/编辑迁移而来）
  versionSource        String   @default("manual")
  /// 可选备注：上传时落文件名，AI 起草时落模型名等
  versionNote          String?
  description          String   @default("")
  itemsJson            String   @default("[]")
  draftedFromSkillHash String?
  status               String   @default("ready")
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([user, skillName, version])
  @@index([user, skillName])
}
```

`SkillTriggerEvalRun.triggerSetId` 不变——它本来就是 `SkillTriggerEvalSet.id`，
新模型下 id 是版本级粒度，所以 run 天然绑死到某个版本。

**迁移**：本项目用 `prisma db push`（无 migrations 目录）；现有行加 `version=1`、
`versionSource='manual'`。SQLite `ALTER` 加默认值列是无损的。

### 存储层（`src/server/skill_trigger_eval_storage.ts`）

| 函数 | 行为 |
|------|------|
| `findLatestTriggerEvalSet(user, skillName)` | 返回 `(user, skillName)` 下 `version desc` 第一条 |
| `findTriggerEvalSetById(id)` | 按 id 取（用于运行/编辑指定版本） |
| `listTriggerEvalSetVersions(user, skillName)` | 全部版本，desc 排序，给「历史数据集」面板 |
| `createTriggerEvalSetVersion({ user, skillName, items, source, note?, description?, draftedFromSkillHash? })` | 取 `max(version)+1` 新建一行 |
| `replaceTriggerEvalItemsById(id, items)` | 按 id 原地改 items —— 仅用于「编辑当前版本」 |

`upsertTriggerEvalSet` 保留作为「不存在则建 v1」的兜底。

### API

| Endpoint | 改动 |
|----------|------|
| `GET /api/skill-eval/trigger/<skillName>?user=&versionId=?` | 默认返回 latest set + versions 列表；`versionId` 指定时返回那个版本 |
| `POST /api/skill-eval/trigger/<skillName>` | body 新增 `versionId`（默认 latest）；只允许在 latest 上保存；非 latest 返回 409 |
| `POST /api/skill-eval/trigger/<skillName>/draft` | 不再 upsert 覆盖，改为 `createTriggerEvalSetVersion(source='llm-draft')` |
| `POST /api/skill-eval/trigger/<skillName>/upload` *(新)* | body `{ user, items, note? }`；items 走 `normalizeItems`；调 `createTriggerEvalSetVersion(source='user-upload')` |
| `POST /api/skill-eval/trigger/<skillName>/run` | body 新增 `triggerSetId`（默认 latest）；run 记录的 `triggerSetId` 落该值 |
| `GET /api/skill-eval/trigger/<skillName>/runs` | 不变；调用方可继续按 skillVersion 过滤 |

### UI（`src/app/(main)/skill-eval/trigger/[skillName]/page.tsx`）

新增/调整：

1. **页面顶部 reload** 同时拉 versions 列表，state 加 `versions`、`selectedSetId`。
   `set` 由 `selectedSetId || versions[0].id` 推导。
2. **数据集版本面板** `RecallDatasetVersionsPanel`：默认折叠，列每个版本的 `时间 · v号 ·
   source · note · 条数 · 正/反`。点击任意行切换 selectedSetId；latest 高亮 `latest`。
3. **「上传数据集」按钮**：触发隐藏的 `<input type="file" accept=".json">`；解析为 items
   数组（`{query, shouldTrigger}` 必填），POST 到 `/upload`，reload。
4. **AI 重新起草**：confirm 文案改成「确认新建 AI 起草版本？将基于当前 SKILL.md 生成新的
   数据集版本，旧版本会保留为历史」。
5. **保存按钮**：viewing 非 latest 时 disable + tooltip「只能编辑最新版本」。
   编辑器的 textarea 也按 latest? 来切只读。
6. **RunDialog**：加一个「数据集版本」下拉，默认 latest；body 加 `triggerSetId`。
7. **我新加的「历史数据集」面板改名为「历史评测」**（component 文件内常量替换），数据
   不变，定位变成「历次跑过的评测结果」。

## 不在本期范围

- 上传时支持 CSV / Excel——先 JSON。
- 从历史版本「克隆为新版本」——目前用户可在 latest 上手编，不必从老版 fork。
- 版本删除 / 重命名 —— 简单起见暂不开放。

## 验证

- `npm run test`（trigger 相关的单测，若有）。
- `bash scripts/restart_dev.sh` 后浏览器走一遍：
  - 老 skill：首次加载 → 看到 v1（versionSource=manual），可编辑保存。
  - 点 AI 起草 → 产出 v2，列表里两条。
  - 上传一个 JSON 文件 → 产出 v3。
  - 切到 v1，编辑被禁用。
  - 跑评测，下拉里选 v2，跑完看「历史评测」里多一条。
