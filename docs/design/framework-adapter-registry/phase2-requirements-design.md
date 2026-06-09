# Framework 适配器注册表 — 需求设计
版本：v0.2
最后更新：2026-06-04

> 文档类型：Phase2 需求设计 ｜ 关联 Phase1：[phase1-requirements-analysis.md](phase1-requirements-analysis.md)
> base_commit：c47829a（master_0530）｜ 变更类型：重构（行为保持）

---

## 导读（工程师先看这段）

**这份文档定了什么** —— 注册表长什么样(接口),以及现有那些散落代码具体怎么搬进来(§4 搬迁表)。

**Review 时重点看两处**
- **§4 搬迁映射** = 改动清单。每一行是「哪段旧代码 → 搬到哪 → 怎么搬」。这是你 code review 时逐行对的表。
- **§5 不变量** = 红线。四条硬约束,违反任意一条这个 PR 就不能合。

**这套设计为什么不会改坏行为**(一句话):adapter 里不写新逻辑,只是**把现有函数原样挂上去**(`extractSkills: 现有函数`),再加 golden 测试两头对。所以「等价」不是靠人肉 review,是靠引用相等 + 测试机器证。

**术语**:`dispatcher` = `data-service.ts:476` 那个按框架挑 skill 抽取函数的调度函数;`归一化` = 把框架原始数据转成内部统一形状;簇/D-0x/AC-0x 见 phase1 导读的速查表。

---

## §1 设计概要

一句话:把散落的「按框架走分支」收进**一个查表注册表**。三件事(框架名解析、skill 抽取、claude 归一化)都走同一个入口 `getAdapter(framework)`。

铁律两条:
- **适配器是纯函数,不碰数据库/网络**——它只做「转换」。
- **入库还是 `saveExecutionRecord` 一个出口管**——适配器不负责写库。

## §2 接口契约（已定型）

### 2.1 核心类型

```ts
// src/lib/ingest/adapters/types.ts
// InvokedSkill 从 interaction-utils(叶子模块)导入,不从 data-service 导入,以免把 DB 依赖拖进适配层。
import type { InvokedSkill } from '@/lib/shared/interaction-utils'; // { name: string; version: number | null }

/** 归一化后的单条交互。本轮不重定义结构,沿用 normalizeInteractions 产物。
 *  命名只是把"事实上的内部形状"显式化,字段一律不动(避免触簇 F 的 role 语义)。 */
export type CanonicalInteraction = any;

export interface FrameworkDescriptor {
  id: string;                 // 标准框架名(D-01):'opencode' | 'claude' | 'openclaw' | 'hermes'
  aliases?: string[];         // 会被解析成 id 的别名。claude 收 ['claudecode']
  label: string;              // UI 展示名
  onboard: 'plugin' | 'env' | 'watcher';  // 接入方式(插件/环境变量/watcher),供安装脚本用
  platform?: string;          // 簇 G 的另一条轴,本轮只声明不接线
}
```

### 2.2 FrameworkAdapter（最小面，只含 A+C）

```ts
export interface FrameworkAdapter {
  readonly descriptor: FrameworkDescriptor;

  /** 簇 C:claude 才有的「入库前归一化」。claude → 挂 normalizeClaudeCodeInteractionsForStorage;
   *  其余框架不实现 = 不做额外处理。 */
  normalizeForStorage?(interactions: CanonicalInteraction[]): CanonicalInteraction[];

  /** 簇 A:抽 skill。入参是已经过全局 normalizeInteractions 的数据。
   *  没实现 = 这个框架没有 skill 概念 ⇒ dispatcher 返回 null(D-02)。 */
  extractSkills?(normalized: CanonicalInteraction[]): InvokedSkill[];

  // ── 留给下一轮(簇 B/D)的扩展点,本轮不实现 ──
  // capabilities?: { subagentTree?: boolean; lifecycleCli?: boolean };
  // deriveExecutionFields?(interactions): Partial<ExecutionRecord>;
}
```

### 2.3 注册表对外的三个函数

```ts
// src/lib/ingest/adapters/registry.ts
/** 唯一查表入口。永不抛错:不认识的框架返回兜底 adapter(啥都不做)。 */
export function getAdapter(framework: string | null | undefined): FrameworkAdapter;

/** 框架名标准化(簇 I)。'claudecode' / 'claude' → 'claude';不认识的原样返回。 */
export function resolveFrameworkId(framework: string | null | undefined): string;

/** 框架清单的唯一出处,给安装脚本 / 框架选择器 / Dashboard 筛选项用(簇 H)。 */
export function listFrameworks(): FrameworkDescriptor[];
```

## §3 文件结构

```
src/lib/ingest/adapters/
├── types.ts          # 上面的契约
├── registry.ts       # getAdapter / resolveFrameworkId / listFrameworks + 兜底 adapter
├── opencode.ts       # descriptor + extractSkills(挂现有函数)
├── claude.ts         # descriptor(id='claude', aliases=['claudecode']) + extractSkills + normalizeForStorage
├── openclaw.ts       # descriptor + extractSkills
└── hermes.ts         # 只占个位(extractSkills 由 hermes 那条线接),本轮仅登记进框架清单
```

> **和 hermes 那条线的交界**:hermes 线会新建一个 `src/lib/ingest/frameworks.ts` 框架常量。两边别各搞一套——谁先落地,另一方合并进它,最终只留一个 `listFrameworks()` 出处。两条线在这里要对齐一次。

## §4 搬迁映射（= 改动清单，逐行对照）

> 每行:旧代码在哪 → 搬到哪 → 怎么搬。**「保留原 export」= 老函数不删,adapter 只是挂它的引用,原调用方暂时不受影响。**

| 旧代码（现状） | 搬到 | 怎么搬 |
|-|-|-|
| `interaction-utils.ts::extractSkillsWithVersionsFromOpencodeSession` | `opencode.ts` 的 `extractSkills` | 保留原 export,adapter 挂它的引用,**函数体一字不动** |
| `…FromClaudeSession` | `claude.ts` | 同上 |
| `…FromOpenClawSession` | `openclaw.ts` | 同上 |
| `interaction-content.ts::normalizeClaudeCodeInteractionsForStorage` | `claude.ts` 的 `normalizeForStorage` | 保留原 export,adapter 挂它;原 5 个调用点分轮迁,本轮先迁 1 个 |
| [data-service.ts:476 dispatcher](../../src/lib/storage/data-service.ts) | —— | 函数体换成 `getAdapter(fw).extractSkills?.(n) ?? null`,缩成 3 行 |
| [upload/route.ts:167](../../src/app/api/ingest/upload/route.ts) + :292 | —— | 两段重复 if/else 删掉,改调 dispatcher |
| [rejudge/route.ts:61](../../src/app/api/eval/rejudge/route.ts) | —— | 改调 dispatcher,**顺手补回漏掉的 openclaw**(AC-02) |
| [proxy/end/route.ts:82](../../src/app/api/ingest/proxy/[taskId]/end/route.ts) / :138 / :311 | —— | **删掉它自己抄的那份函数体**,改调 dispatcher |
| data-service claude 归一化 :1556/:1566/:1575 | —— | 换成 `getAdapter(fw).normalizeForStorage?.(x) ?? x`,本轮**只切这一处**(D-03) |

## §5 不变量（红线，违反就不能合）

1. **不认识的框架不出事** —— `getAdapter()` 返回兜底 adapter;没 `extractSkills` ⇒ dispatcher 返回 `null`;没 `normalizeForStorage` ⇒ 数据原样过。严格等于今天。
2. **行为逐字节等价** —— 三框架的抽取/归一化是「搬函数」不是「重写」,函数体不动。golden 测试两头对。
3. **不碰数据库** —— 不改表、不改存量 `framework` 值。库里的 `claudecode` 一律走 `resolveFrameworkId` 翻译,**严禁新增任何 `framework === 'claude'` 的裸比对去判存量数据**(会漏掉 `claudecode`)。
4. **不碰冻结区** —— 簇 F(`role==='opencode'`)、G(platform 接线)、B(saveExecutionRecord 派生/门,hermes 线除外)、D、E,git diff 应为空。

## §6 数据模型

无 schema 变更。无新增/修改字段。无迁移脚本。

## §7 风险与兜底

| 风险 | 影响 | 怎么防 |
|-|-|-|
| 搬迁时不小心改了逻辑,行为变了 | 中 | 先写 golden 测试钉死现状,再搬,diff 必须为空(AC-01);adapter 用引用相等证明是「挂现有函数」 |
| 标准名定成 `claude`,但库里是 `claudecode`,某处裸比对漏了数据 | 中 | 红线 §5.3 + 验收时 grep 核查:没有新增的裸 `=== 'claude'` 判存量 |
| 和 hermes 线各搞一套框架清单 | 低 | §3 已约定合并成单一 `listFrameworks()`,两线对齐一次 |
