# Skill 优化页接真实 API + 清理遗留 mock 数据

- 状态：草稿
- 日期：2026-05-22
- 分支：feat/skill-opt-ux-2026-05-22
- 范围：`/skill-opt/[name]/[version]` 优化对话页 + `_mock.ts` 死代码清理

## 1. 背景

`/skill-opt` 预览页（一段跳）已在本会话改造完毕：左列 / 中列 / 右列均接真 API。剩下的 mock 集中在二段跳——优化对话页 `[name]/[version]/page.tsx`，以及共用的 `_mock.ts`。

预览页改完后，跨文件搜索 `_mock` 的所有 7 个数据导出：

```
MOCK_SKILLS / MOCK_ISSUES / MOCK_CATEGORIES        — 无任何文件引用（死代码）
getSkillByName / getSkillContent / generateNextDraft — 无任何文件引用（死代码）
getSkillFiles                                       — 仅对话页 3 处引用
buildIterationReport                                — _FileDiff 引用（真工具函数，行 diff）
OptIssue / OptimizationIteration / SkillSummary     — 3 个 type，是真接口形状
```

也就是说，**真正还在跑的 mock 调用只剩 `getSkillFiles` 1 个**。它的 3 个调用点同源——都是「base version 的全量文件快照」，只是在不同时机被消费。

## 2. 为什么"还没换掉"

历史上 mock 是「整页用假数据撑起来」的脚手架，过去几个 PR 渐进替换：
- 左列 skill 列表 → 接 `/api/skills`
- issues → 接 `/api/skills/by-name/[name]/optimization-points`
- iteration / draft → 接 SSE `/api/skill-opt/chat` + session 持久化
- changeLog / 版本元数据 → 接 `/api/skills/[id]/versions`

但 **base version 的"文件内容"** 一直没接，因为：
1. 没有现成的「列出 + 读取一个 skill version 全部文件」API
2. agent 需要的是**同步、全量的 `Record<path, content>`** 才能作为 `baselineFiles` 一把塞给后端 `/api/skill-opt/chat`，懒加载模式直接套不上
3. 作者埋了注释 _"接通真 storage 后 baselineFiles 字段可省掉"_，期望后端自己读 storage 而不是前端送

现在 storage 已经稳定（预览页已经用到 `/api/skills/[id]/versions/[v]` 的 `content` + `files` 字段），可以把这个 TODO 收掉。

## 3. 目标

1. 移除对话页对 `getSkillFiles` 的 3 处 mock 调用，改成从真实接口拉一次 baseline 后在组件内共享
2. 移除 `_mock.ts` 的全部假数据（保留 3 个 type + 1 个真工具函数）；按内容把文件改名为 `types.ts` + 把 `buildIterationReport` 挪进 `_FileDiff.tsx`（它只被那里用）
3. 不引入新 API、不引入新数据模型；仅复用 `/api/skills/[id]/versions/[v]`（含 `content` + `files`）与 `/api/skills/[id]/versions/[v]/files/[...path]`

## 4. 关键决策

### 4.1 base 文件拉「全量」还是「按需」

base files 的 3 个消费点对内容要求不同：

| 消费点 | 需要全量? | 备注 |
|---|---|---|
| `baselineFiles` (发后端 agent) | **是** | agent 需要看到完整 SKILL package 才能改 |
| `fallbackFiles` (draft 兜底) | **是** | 用作整份 iteration 的 files snapshot |
| `FileDiff baseFiles` | **是** | diff 要全文比对 |

3 处都吃全量。所以 baseline 必须**前端一次性预取整份**，不能套预览页那种 lazy 模式。

实现：组件挂载时 `useEffect` → 调 `GET /api/skills/[id]/versions/[v]` 拿 `content` + `files` 路径列表 → 对每个非 SKILL.md 路径并发调 `GET /files/[...path]` 拿内容 → 组装成 `Record<path, content>` 放进 state。

典型 skill 文件数 < 10，每个 < 100KB，并发拉一次的开销可控。

**风险**：这是页面加载的关键路径，必须挡在「开始优化」按钮之前；如果还没拉完用户就点了，要 disable 按钮或弹 toast。

### 4.2 二进制文件怎么算

`/files/[...path]` 对非文本会返回 `{ isText: false }`，content 字段缺失。baseline 里如果有图片/二进制：
- 发给 agent：agent 也读不了二进制，给一个 placeholder 字符串如 `(binary file, 12kB)` 即可
- FileDiff：diff 显示「二进制文件，无法比对」
- draft fallback：照搬 placeholder

简单起见，**baseline 里只收 isText=true 的文件**，二进制路径在 paths 列表里有、内容用 placeholder 占位。

### 4.3 `_mock.ts` 重组

```
当前：              重组后：
_mock.ts            types.ts            ← 只留 SkillSummary / OptIssue / OptimizationIteration
  (一堆假数据)        + SkillVersion
  (类型导出)         _FileDiff.tsx       ← 把 buildIterationReport / fileLineDelta 内联进来
  (工具函数)         （删除 _mock.ts）
```

`buildIterationReport` 只被 `_FileDiff` 用，搬进去最自然。`fileLineDelta` 是 `buildIterationReport` 的实现细节，跟着搬。

3 个 type 抽到 `types.ts` 是因为预览页 + 对话页 + _FileDiff 三处都引（且 import 一个叫 `_mock` 的文件拿类型，语义上别扭）。

## 5. 详细改动

### 5.1 新增 `src/app/(main)/skill-opt/types.ts`

把 `_mock.ts` 里的 `SkillSummary` / `SkillVersion` / `OptIssue` / `OptimizationIteration` 4 个 interface 原样搬过来。

### 5.2 改 `src/app/(main)/skill-opt/_FileDiff.tsx`

- 从 `./_mock` 改成 `./types` 引类型
- 把 `buildIterationReport` 和 `fileLineDelta` 两个函数从 `_mock.ts` 复制进来（私有化）

### 5.3 改 `src/app/(main)/skill-opt/page.tsx`

- 把 `import type { SkillSummary } from './_mock'` 改成 `from './types'`

### 5.4 改 `src/app/(main)/skill-opt/[name]/[version]/page.tsx`（核心）

新增状态：
```ts
const [baselineFiles, setBaselineFiles] = useState<Record<string, string> | null>(null);
const [baselineLoading, setBaselineLoading] = useState(true);
const [baselineError, setBaselineError] = useState<string | null>(null);
```

新增 useEffect（在拿到 `skill.id` 和 `baseVersion` 后触发）：
```ts
useEffect(() => {
  if (!skill?.id) return;
  let aborted = false;
  setBaselineLoading(true);
  (async () => {
    const detail = await apiFetch(`/api/skills/${skill.id}/versions/${baseVersion}${userQuery}`).then(r => r.json());
    const paths: string[] = JSON.parse(detail.files || '["SKILL.md"]');
    const others = paths.filter(p => p.toUpperCase() !== 'SKILL.MD');
    const results = await Promise.all(others.map(async p => {
      const encoded = p.split('/').map(encodeURIComponent).join('/');
      const r = await apiFetch(`/api/skills/${skill.id}/versions/${baseVersion}/files/${encoded}${userQuery}`);
      if (!r.ok) return [p, ''] as const;
      const j = await r.json();
      return [p, j.isText === false ? `(binary file, ${j.size} bytes)` : (j.content || '')] as const;
    }));
    if (aborted) return;
    const map: Record<string, string> = { 'SKILL.md': detail.content || '' };
    for (const [p, c] of results) map[p] = c;
    setBaselineFiles(map);
  })().catch(e => !aborted && setBaselineError(String(e)))
    .finally(() => !aborted && setBaselineLoading(false));
  return () => { aborted = true; };
}, [skill?.id, baseVersion, userQuery]);
```

替换 3 处 `getSkillFiles(skill.name, baseVersion)`：

| 行号 | 原 | 改 |
|---|---|---|
| 449 | `: getSkillFiles(skill.name, baseVersion)` | `: (baselineFiles ?? {})` |
| 642 | `: getSkillFiles(skill.name, baseVersion)` | `: (baselineFiles ?? {})` |
| 987 | `baseFiles={getSkillFiles(skill.name, baseVersion)}` | `baseFiles={baselineFiles ?? {}}` |

UI 挡住「开始优化」按钮（line 估计在 `startOptimize` 调用前的按钮 disable 逻辑里加 `baselineLoading || !baselineFiles`），并在头部条加个加载/错误小提示。

移除 import：
```ts
import { getSkillFiles, type OptIssue, type OptimizationIteration, type SkillSummary } from '../../_mock';
// →
import type { OptIssue, OptimizationIteration, SkillSummary } from '../../types';
```

### 5.5 删 `src/app/(main)/skill-opt/_mock.ts`

类型已搬到 `types.ts`，工具函数已搬进 `_FileDiff.tsx`，剩下都是死代码。

## 6. 风险

- **并发拉文件失败**：单文件 404 / 500 不应整页崩溃。处理方式：单文件失败用空串占位 + console.warn；整体 versionDetail 失败时阻塞「开始优化」按钮并显示错误条。
- **大 skill 加载慢**：典型 skill < 10 文件，但极端情况可能 30+。加载期间「开始优化」按钮 disabled，用户看到「正在准备基线（X/Y）」更友好。第一版可以只显示「加载中」，按 P95 优化。
- **「开始优化」按钮误触**：必须在 `baselineFiles` 为 null 时 disable，否则会发空 baseline 给 agent，导致 agent 改不动文件。
- **回归 FileDiff**：旧 mock 数据下，diff 一直拿 mock 文件作 base；改后变成真 base。如果 skill 的实际 base 文件在 storage 里残缺（比如老 skill 没有 references/），diff 会显示「这些是删除」。这是符合预期的，但要在 verify 阶段确认一个老 skill 走过流程不会爆。

## 7. 验证

- 浏览器人工（按 SOP）：
  - golden：选 svg-flamegraph-analysis → 等 baseline 加载完 → 「开始优化」 → 看一份 draft 是否带完整文件 → 打开 FileDiff 看 base 是否是真 SKILL.md
  - 边界 1：baseline 还没加载完时「开始优化」是 disabled 的
  - 边界 2：选一个只有 SKILL.md 的 skill（如 chart-gen v0）→ 流程跑通
  - 边界 3：切 skill / 切版本，baseline state 正确重拉
- 单元测试：`npm run test`，预期所有原有测试继续通过（mock 数据移除不应影响 prompt 序列化等下游测试）。
- TS 类型：`npx tsc --noEmit` 0 errors。

## 8. 不在本次范围

- 不动 `/api/skill-opt/chat` 后端：依然吃前端送的 `baselineFiles`，只是从前端「假的」变成「从 storage 真拉」。后端进一步从前端解耦（自己读 storage）是后续话题。
- 不动 SSE 协议、draft 持久化、iteration 序列化。
- 预览页（一段跳）本会话已改，不再触碰。
- 不重命名「草稿 #N」「优化」等业务文案。

## 9. 工作量预估

- 净改动：估计 +60 / -130 行
- 涉及文件：4 个（types.ts 新建 / _FileDiff.tsx / page.tsx / [name]/[version]/page.tsx）+ 1 个删除（_mock.ts）
- 一次提交即可（不需要拆 PR）
