---
title: "Run your first evaluation"
description: "Evaluate one existing Trace or run a Benchmark Case."
---

There are two initial paths: score an existing Trace with one evaluator, or select a Benchmark dataset/Case, execute it through an Agent, and run its official judging workflow. UI names below include Chinese labels where useful.

## Prerequisites

- A working model under **Settings → Model registration (配置 → 模型注册)**.
- An installed Agent client that has reported at least one Trace.
- Access to the chosen Agent and Trace from the current account.

Container Benchmarks such as SWE-bench additionally require an administrator to deploy the independent Evaluator and install the dataset. See [Benchmark service deployment, Chinese](../../../zh/how-to/evaluation/benchmarks/deploy-services.md). Users should confirm the dataset is selectable, the execution client is online, and its official evaluator is selected automatically.

The execution-machine administrator controls SWE-bench Case repository sources. Ordinary users need not configure them; local caches or alternative Git services are covered by the [SWE-bench deployment guide, Chinese](../../../zh/how-to/evaluation/benchmarks/deploy-swe-bench.md#配置-case-源码来源).

For a first Benchmark run, open **Evaluation → Experiments (评估与实验 → 实验)**, create an experiment, select a Benchmark dataset and one Case, choose **Generate Trace (生成 Trace)**, select an online compatible Agent executor, confirm the bound evaluator, and start. Begin with one Case. SWE-bench on ARM64 is suitable for workflow checks; formal results use the official Linux x86_64 image environment.

## Step 1: Create an ordinary experiment

1. Open **Evaluation → Experiments (评估与实验 → 实验)**.
2. Choose **New experiment (新建实验)**.
3. Enter a name and select the Agent.
4. Leave the dataset unselected.
5. Choose the no-variable single-group type (**无变量 · 单组**).
6. Continue to Trace source (**下一步：Trace 来源**).

## Step 2: Select an existing Trace

Choose **Select Trace (选择 Trace)**. Narrow the list by search, time, or user tags, then choose one record whose input and output are easy to verify. Continue to expected output (**下一步：预期答案**).

Avoid watch mode for the first run. Watch mode continuously evaluates later Traces and is better introduced after a controlled example works.

## Step 3: Provide reference output when needed

If the evaluator does not require reference output, continue. Otherwise supply the expected answer. With an existing matching dataset, use **Import matches from dataset (从数据集导入匹配)**.

## Step 4: Select an evaluator and start

Select at least one available evaluator; use just one for this initial run. Default **Evaluation runtime settings (评估运行设置)** are sufficient initially. Adjust evaluation timeout and retry count only when required; the detailed flow remains in the [experiment guide, Chinese](../../../zh/how-to/evaluation/experiments.md#第四步评估器与执行).

Choose **Start experiment (开始实验)**. After acceptance, the UI opens the experiment detail page.

## Step 5: Read experiment details

The page refreshes during execution. Check the experiment reaches completion or failure, Case/evaluator counts match expectations, aggregate scores appear where applicable, and evaluated/failed counts make sense. Open **Details (详情)** on a Case for its result.

## Step 6: Verify evidence

Check that input, reference output, and actual output belong to the same Case; the verdict agrees with the score; failed criteria cite identifiable evidence; and suggestions refer to concrete output or execution steps.

If a machine judgment is clearly wrong, save a human correction with a reason. Comments record collaboration and do not change scores. See [evaluator output](../../reference/evaluation/evaluator-output.md) for effective-score and re-evaluation behavior.

When Benchmark evaluation fails, inspect the Case's failure stage and error before asking the administrator to investigate service or image issues.

## Next steps

- [Experiment HTTP API](../../reference/evaluation/experiments-api.md) and [Benchmark protocol](../../reference/evaluation/benchmark-protocol.md).
- [Experiment operations, Chinese](../../../zh/how-to/evaluation/experiments.md).
- [Evaluation datasets, Chinese](../../../zh/how-to/evaluation/datasets.md).
- [Evaluators, Chinese](../../../zh/how-to/evaluation/evaluators.md).

[中文权威版本](../../../zh/tutorial/evaluation/01-first-experiment.md)
