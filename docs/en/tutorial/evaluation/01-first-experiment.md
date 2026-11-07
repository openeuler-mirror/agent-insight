---
title: "Run your first evaluation"
description: "Evaluate one existing Trace or run a Benchmark Case."
keywords: ["Agent Insight", "evaluation", "Trace scoring", "Benchmark"]
changefreq: "monthly"
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

### Diagnose a Case and review a Skill change

The Case detail shows the task, expected output, actual output, and evaluation results together on one page. Select diagnosis evidence directly on completed evaluation cards. Partially met and unmet results are selected by default, while pending, running, or failed evaluations cannot be selected. The diagnosis action bar appears after all evaluation sections and immediately before the Case comments; it summarizes the selection and links the measured execution Trace automatically.

The diagnosis action automatically prepares input whenever the selected evaluation results change. **Start diagnosis** remains disabled while the input is being prepared. Task content, outputs, and evaluation evidence stay in the Case sections above instead of being repeated in the action area; a failed preparation can be retried from its error message. Starting again creates a new diagnosis even for identical inputs. Choose an entry in **Diagnosis history** to view a previous result. Changing the selection, adjusting a score, or rerunning an evaluator automatically prepares a fresh input. Each diagnosis retains its original inputs and links back to the Case.

Select final findings that can be addressed in an invoked Skill. Inspect the Skill version and baseline files. An unknown version requires explicit verification. A completed Trace-only report can also be frozen from its findings view. It carries no historical experiment scores. No recorded Skill invocation means there is no direct optimization target.

Create the plan, review the proposed edits in the workbench, then confirm to generate a candidate. Inspect the diff and run the candidate against the source experiment configuration before publishing. An unavailable source, changed dataset or missing baseline prevents a comparable retest.

Trace-only reports can produce a reviewable candidate, but cannot pass this source-experiment publishing gate. Human-corrected baseline scores require review instead of automatic machine-score comparison. A change to source evidence during a retest invalidates that retest.

After confirming the evaluation evidence, diagnosis opens in `/fault?runId=…`, alongside the execution trace, frozen inputs, module progress and final report. History links reopen the same run; legacy `/diagnosis-runs/:runId` links redirect here. The optimization card shows the target Skill and read-only execution version first, followed by a compact multi-select dropdown whose options contain only the key finding. Inspect the execution snapshot, then create the plan directly without a second confirmation checkbox. The Skill execution version is read-only; no default or alternative version is selected. Missing execution versions or content hashes prevent plan creation.

“No key findings” does not prove the execution is problem-free. Report read, parsing, and validation failures show a failure reason and allow a retry. Historical report repairs are reviewed separately.
