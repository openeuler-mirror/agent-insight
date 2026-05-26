我来帮你查一下 Langfuse 和 LangSmith 在 agent 评测方面的功能设计，特别是"评测任务"这个概念。现在我对 Langfuse 的设计已经比较清楚了。再查一下 LangSmith 的对应概念。信息已经足够了。下面给你梳理一下两个平台在"评测任务/可重复评测"这件事上的设计。

---

## 核心结论：两边都有"任务"概念，但叫法不一样

你问的"评测任务（一个评测集可以跑多次评测）"——这正是这两个平台的核心抽象。它们的命名差异如下：

| 概念 | Langfuse | LangSmith |
|---|---|---|
| 测试用例集合 | **Dataset** | **Dataset** |
| 单条用例 | Dataset Item | Example |
| **一次评测运行** | **Experiment / Dataset Run** | **Experiment** |
| 评测函数 | Evaluator | Evaluator |

也就是说，"评测任务"在它们术语里叫 **Experiment（实验/运行）**。一个 Dataset 可以反复跑出无数个 Experiment，这是设计的核心场景，不是边角功能。

## Langfuse 的模型

Langfuse 的官方数据模型把这件事说得很清楚：DatasetRuns（即 Experiment runs）是通过用 LLM 应用循环遍历一个 Dataset 的全部或部分 DatasetItems 而创建的。

典型的用法是这样：

```python
dataset = langfuse.get_dataset('qa-dataset_langgraph-agent')
result = dataset.run_experiment(
    name="run_gpt-4o",
    description="My first run",
    task=my_task,
    metadata={"model": "gpt-4o"}
)
```

每次调用 `run_experiment` 就产生一次新的 run，name 用来区分。你可以用不同的 agent 配置（模型、prompt、工具是否启用、单 agent 还是多 agent）重复这个过程，然后在 Langfuse 里并排对比。

评测函数分两种粒度，这一点对 agent 评测特别有用：Evaluator 接收 input、output、expected output 和 metadata，返回成为 Score 的 Evaluation 对象；run evaluator 则评估整个实验结果并计算聚合指标。前者是单条样本的打分，后者是整批跑完后的汇总指标。

UI 上还有一个 跨实验对比视图，跟踪给定 dataset 上所有实验的高层指标（平均分、成本、延迟），让你一眼看出哪些实验是改进、哪些是回退，可以选两次 run 设为 baseline 和 candidate 做对比。

## LangSmith 的模型

LangSmith 的抽象几乎一模一样：LangSmith 把结果记录为一个 Experiment，本质上就是一组 run（每个 example 一条）加上 evaluator 给的反馈分数。

它对"同一评测集重复跑"的支持更显式——`evaluate()` 函数有个 `num_repetitions` 参数：num_repetitions 是评测运行的次数，dataset 里的每个 item 会被运行和评测这么多次，默认为 1。这是专门为了应对 LLM 不确定性的：多次跑同一个实验是有用的，因为 LLM 输出不是确定性的，重复之间可能有差异。

跨实验对比的官方说法是：通常会在一个 dataset 上跑多个实验来测试不同的应用配置（例如不同的 prompt 或 LLM），LangSmith 会展示与该 dataset 关联的所有实验，并支持对比多个实验。

## 设计上的几个值得注意的点

**1. Dataset 和 Experiment 是 1 : N 关系**，这是两家都明确的：一个评测集是稳定的"基准"，Experiment 是你每次跑出来的"成绩单"。改 prompt、换模型、调工具配置都跑一次，结果挂在同一个 dataset 下做对比。

**2. Agent 评测通常需要三层评估**，不只是看最终答案。Langfuse 文档把这个讲得很清楚——final response、trajectory（轨迹是否正确）、单步质量，可以用不同的 evaluator 分别打分挂到同一次 experiment 上。

**3. 跑同样配置多次**也是一等公民，LangSmith 直接给了 `num_repetitions`，Langfuse 则靠你多调几次 `run_experiment` 用不同 name 区分。这件事对 agent 尤其重要，因为 agent 涉及多步决策，方差会被放大。

**4. Offline vs Online** 两边都区分。你问的"评测任务"属于 offline——拿固定 dataset 跑。Online 是直接在生产 trace 上挂 evaluator 持续打分，没有 dataset 概念。

## 如果你在自己设计评测系统

可以参考的最小数据模型大致是这样：

- `Dataset`（评测集）→ 包含若干 `DatasetItem`（用例，含 input 和 expected output）
- `Experiment / Run`（一次评测任务）→ 引用一个 Dataset，带配置元数据（模型、prompt 版本、commit hash 等）
- `RunItem`（单次运行单条样本的结果）→ 引用一个 Experiment 和一个 DatasetItem，保存实际 output 和 trace
- `Score`（打分）→ 挂在 RunItem 上（单条粒度）或 Experiment 上（聚合粒度）

这个结构能直接支持"同一评测集跑多次"、"跨次对比"、"重复 N 次看方差"、"单条/聚合多粒度打分"这几个核心需求。Langfuse 和 LangSmith 基本就是这个骨架，差别只在命名和 UI 表现。