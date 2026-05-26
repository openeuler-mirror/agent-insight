# 数据集 Case 预提取关键观点方案

- 状态：草稿
- 日期：2026-05-26
- 范围：`AgentEvalDataset` / trajectory 结果评测 / 数据集增改保存链路

## 1. 背景

当前轨迹评测里的“结果评测”会在每次执行时，把命中的数据集 case 的 `expectedOutput` 再交给 LLM 提取一次关键观点（root causes / key points）。

现状链路：

1. `AgentEvalDataset` 把数据项整包存在 `casesJson`。
2. `/api/eval/trajectory/run` 为 trace 匹配到一个 case 后，把 `caseEntry.expectedOutput` 传给结果评测器。
3. `src/lib/engine/evaluation/opencode-task-completion-evaluator.ts` 内部每次都调用 `extractRootCausesFromExpected(...)`，重新做一次 LLM 提取。

这意味着：

- 同一条 case 被重复评测时，会重复消耗模型时延和费用。
- 评测耗时受“关键观点提取”影响，无法随着 case 数量复用。
- 旧的 `Config.rootCauses` 已有“预提取缓存”思路，但新的 `AgentEvalDataset` 路径没有复用这个优化。

## 2. 目标

1. 数据集 case 在“新增 / 编辑并保存”后，就把 `expectedOutput` 对应的关键观点提取出来并持久化。
2. 前端不展示这份字段，只作为评估内部缓存使用。
3. 评测时优先读取缓存，不再对同一 `expectedOutput` 重复提取。
4. 对历史数据、提取失败、模型未配置等情况保留兜底，不让评测链路直接失效。

## 3. 设计结论

推荐方案：**把关键观点缓存直接存在 `AgentEvalDataset.casesJson` 的每条 case 里，不新建 case 明细表。**

原因：

- 现有数据集本来就是“一个 dataset + 一包 cases JSON”的模型，评测匹配后也直接拿整条 case 使用。
- 关键观点是 case 的派生数据，和 `expectedOutput` 强绑定，跟着 case 一起存最自然。
- 不需要改 `AgentEvalDataset` Prisma 表结构，不需要拆分/迁移整套数据集读写接口。
- 后续评测只要把命中的 case 原样向下传递即可，改动面最小。

不建议第一版就拆独立表，除非后续出现以下新需求：

- 需要按关键观点做数据库级筛选/统计；
- 单个数据集 case 数量大到 `casesJson` 更新成本明显不可接受；
- 需要单 case 级别的独立审计、锁、并发编辑能力。

## 4. 数据结构

在 `DatasetCase` 增加隐藏字段，仅用于后端和评测链路，不在前端渲染：

```ts
interface RootCauseItem {
  content: string;
  weight: number;
}

interface DatasetCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
  trajectory: string;
  source?: 'user' | 'skill-gen-draft';

  rootCauses?: RootCauseItem[];
  rootCauseMeta?: {
    status: 'ready' | 'failed' | 'empty';
    expectedOutputHash: string;
    updatedAt: string;
    error?: string;
  };
}
```

说明：

- `rootCauses`：真正给评测器消费的缓存结果。
- `rootCauseMeta.expectedOutputHash`：用于判断缓存是否和当前 `expectedOutput` 对应，避免脏缓存。
- `status='empty'`：`expectedOutput` 为空时的显式状态，避免评测时反复尝试提取。
- `status='failed'`：保存时提取失败，但 case 本身仍允许保存；评测时可走兜底。

## 5. 保存链路改造

改造入口：

- `POST /api/agent-datasets`
- `PATCH /api/agent-datasets`
- `src/server/agent_datasets_storage.ts` 的 case normalize / merge 逻辑

保存策略：

1. **新增 case**
   - 若 `expectedOutput` 为空：写入 `rootCauses=[]`，`status='empty'`。
   - 若 `expectedOutput` 非空：调用提取器，成功后写入 `rootCauses + meta`。

2. **编辑已有 case**
   - 若 `expectedOutput` 未变：保留原 `rootCauses` 和 `rootCauseMeta`，不要重复提取。
   - 若 `expectedOutput` 变化：重新提取并覆盖缓存。
   - 若只改了 `input/tags/evaluationFocus/trajectory`：不触发重提取。

3. **提取失败**
   - 不阻塞数据集保存。
   - 写入 `rootCauses=[]` + `status='failed'` + `error`。
   - API 返回 `warnings`，前端可 toast 提醒“保存成功，但关键观点提取失败，评测时会自动兜底”。

实现要点：

- 由于前端当前保存 case 时只提交显式编辑字段，不会带回隐藏字段，所以后端 `PATCH` 不能直接用新 `cases` 覆盖旧值。
- 需要按 `case.id` 和 `expectedOutput` 做 merge：
  - 未变化的 case 继承旧缓存；
  - 新增/变更的 case 才重算缓存。

## 6. 评测链路改造

改造点：

- `/api/eval/trajectory/run`
- `evaluateTaskCompletionAgainstExpected(...)`
- `evaluateTaskCompletionViaOpencode(...)`
- `opencode-task-completion-evaluator.ts`

目标行为：

1. trace 命中 case 后，把 `rootCauses` 一起带入 `caseEntry`。
2. 结果评测器新增可选入参：

```ts
{
  caseInput: string;
  expectedOutput: string;
  actualOutput: string;
  precomputedRootCauses?: RootCauseItem[];
}
```

3. 评测时优先级：
   - `precomputedRootCauses` 非空：直接使用；
   - `rootCauseMeta.status === 'empty'`：直接按“无关键观点”继续评测；
   - 缓存缺失 / `failed` / 历史数据无字段：退回到现有 `extractRootCausesFromExpected(...)` 实时提取。

4. 在 `rawAnalysisJson` 记录本次关键观点来源：
   - `dataset-cache`
   - `live-extract`
   - `none`

这样既能享受缓存收益，也不会因为历史数据未回填而让评测不可用。

## 7. 历史数据回填

新增一次性脚本，例如：

`scripts/backfill_dataset_case_root_causes.ts`

职责：

1. 扫描所有 `AgentEvalDataset`。
2. 找出满足以下条件的 case：
   - `expectedOutput` 非空；
   - 没有 `rootCauseMeta`；
   - 或 `expectedOutputHash` 与当前内容不一致；
   - 或 `status='failed'` 且用户希望重试。
3. 调用同一套提取器回填缓存。
4. 输出成功/失败统计。

上线策略：

- 新逻辑先带兜底上线。
- 部署后执行一次 backfill。
- 回填未完成前，评测链路仍可实时提取，不影响功能可用性。

## 8. 风险与取舍

### 8.1 为什么不把提取放到评测前异步任务

那样仍然会让“第一次评测”承担提取成本，只是把动作从评测器里挪到了另一个阶段，不能解决核心问题。这里的目标就是把成本前移到 case 生命周期。

### 8.2 为什么不强制保存时提取成功

如果评测模型没配置、临时超时、批量导入很多 case，强制失败会让用户连数据集都存不进去，体验很差。更稳妥的做法是：

- 数据先保存；
- 缓存尽量生成；
- 失败时评测仍可 fallback。

### 8.3 批量导入可能变慢

批量导入几十条 case 时，保存接口会比现在更慢，因为需要为新增/变更 case 提取关键观点。

建议第一版做法：

- 仅对“新增/变更的 case”提取；
- 使用小并发（如 2~3）跑提取，避免瞬时打爆模型服务；
- 后续若批量导入成为瓶颈，再演进为“保存成功 + 后台异步补全缓存”的两段式。

### 8.4 `casesJson` 会变大

这是可接受成本。关键观点通常 0~5 条短文本，相比 `expectedOutput` 和 `trajectory` 体量很小。第一版优先换运行时收益，暂不为此拆表。

## 9. 实施步骤

1. 扩展 `DatasetCase` 类型与 normalize/merge 逻辑，支持隐藏缓存字段。
2. 提炼一个通用的 `extractRootCausesForDatasetCase(...)` 服务，供保存链路和回填脚本复用。
3. 改造 `POST/PATCH /api/agent-datasets`：
   - 对新增/变更 case 提取关键观点；
   - 返回 `warnings`。
4. 改造 trajectory 结果评测链路，优先消费 case 缓存。
5. 保留实时提取 fallback，兼容历史数据。
6. 增加回填脚本，部署后执行一次。
7. 补测试：
   - case 未改 `expectedOutput` 时不重复提取；
   - case 改 `expectedOutput` 时缓存刷新；
   - 评测优先使用缓存；
   - 缓存缺失时 fallback 正常。

## 10. 预期收益

- 同一 case 被重复评测时，不再重复做关键观点提取。
- trajectory/result 评测平均耗时下降，尤其是回归集、多轮 A/B、重复重评场景。
- 模型调用成本下降，且关键观点结果更稳定，不会因每次实时提取的随机性产生轻微漂移。

