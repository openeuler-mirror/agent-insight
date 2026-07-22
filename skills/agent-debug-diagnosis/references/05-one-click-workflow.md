# 一键诊断流程

一键诊断按顺序执行两个阶段，两个阶段都由同一个 AgentDebug Agent 完成。

## 阶段一：冻结主诊断

先运行现有 AgentDebug 五模块流程。该阶段不能看到专项诊断结果，只根据 trace、静态检测和 AgentDebug 规程生成 `findings`。

机制或修复方向不同的问题必须保留为不同 finding；存在触发或上下游关系时使用 `issueRefs` 和故障链关联，不能为了压缩卡片数量而合并。阶段一返回的 `findings` 是冻结的 core findings。

## 阶段二：专项结果查重与关联

服务端通用运行时执行并富化适用的专项诊断器，然后把冻结的 core findings 与专项结果返回给同一个 AgentDebug Agent。该阶段只按 `references/08-detector-reconciliation.md` 输出合并决策，不重新运行五模块，不重新生成完整报告。

通用代码应用决策：

- 重复结果合入目标 core finding，原始计数、区间、比例和锚点无损保留；合并后的用户卡片不展示专项来源。
- 只有因果关系但机制或修复方向不同的结果保持独立，可建立关联。
- 未返回有效决策或目标 finding 不存在时，专项结果默认独立保留，不能静默消失。
- 任何 core finding 都不能因为专项诊断介入而被删除。

这里不增加新的结果编排 Agent；第二阶段是现有 AgentDebug Agent 的后续判断，结果由确定性通用代码应用。
