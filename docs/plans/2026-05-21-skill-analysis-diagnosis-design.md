---
title: Skill 分析一句话诊断设计
date: 2026-05-21
status: approved
---

## 背景

当前 [Skill 分析页](/Users/mintuyang/Documents/code/witty-skill-insight-gyc/src/app/(main)/skill-eval/page.tsx) 的 Hero 区“一句话诊断”仍是前端写死的 if/else 文案，无法稳定反映 A/B、用例分析、召回分析、静态合规 4 个维度的实时结果，也无法在一键测试结束后自动生成新的问题/建议。

本次目标是在**不新增持久化表**的前提下，为 Skill 分析页新增一个服务端诊断 API：

- 前端继续沿用现有 4 维摘要数据加载逻辑
- 前端把 4 维结构化快照提交给服务端
- 服务端使用**当前 active 评测模型**生成 `problem` / `suggestion`
- LLM 失败时服务端返回规则兜底诊断
- 一键测试按钮要等“评测完成 + 诊断刷新完成”后才能重新点击

## 非目标

- 不新增数据库表保存诊断历史
- 不改 4 维评分口径与健康分公式
- 不引入页面级模型选择器
- 不在前端暴露 LLM 原始错误作为主结论文案

## 方案总览

### 1. 新增共享类型与 fallback 规则

新增 `src/lib/skill-analysis/diagnosis.ts`：

- `SkillDiagnosisSnapshot`
- `SkillDiagnosisResult`
- `buildFallbackDiagnosis(snapshot)`
- `buildDiagnosisPrompt(snapshot)`

核心约束：

- 优先级：`A/B 显著劣化 > 覆盖不足/未配置 > 已完成维度中的最低分`
- fallback 必须可独立产出 `problem` / `suggestion`
- 前后端都复用同一份 fallback 逻辑，避免“双轨文案”

### 2. 新增服务端 API

新增：

`POST /api/skills/by-name/:name/analysis-diagnosis`

请求体：

```ts
{
  user: string;
  snapshot: SkillDiagnosisSnapshot;
}
```

返回：

```ts
{
  diagnosis: {
    problem: string;
    suggestion: string;
    mode: 'llm' | 'fallback';
    modelLabel?: string | null;
    errorMessage?: string | null;
  }
}
```

服务端逻辑：

1. 校验 `user` 与 `snapshot`
2. `getActiveConfig(user)` 取当前 active 模型
3. 若有 active 模型，则调用 OpenAI-compatible `chat.completions.create`
4. 若无 active 模型、响应解析失败、或模型调用失败，则回退 `buildFallbackDiagnosis`
5. 返回 200；只有请求体非法时返回 4xx

## 前端接线

### 1. 页面数据仍由当前 Skill 分析页汇总

保留现有：

- `reloadTraces()`
- `reloadStaticSummary()`
- `reloadRecallSummary()`
- `reloadGraySummary()`

只在 Overview 内新增一个“诊断快照构造器”，把 4 维摘要映射成 `SkillDiagnosisSnapshot`。

### 2. 一键测试状态机

新增本地 phase：

- `idle`
- `starting`
- `running`
- `refreshing`
- `diagnosing`

按钮禁用条件：

- `phase !== 'idle'`
- 或现有 A/B / Trace 后台运行中

流程：

1. 用户点击一键测试
2. 启动选中的维度
3. 对后台任务维度（A/B、用例分析）轮询直到终态或超时
4. 刷新 4 维摘要
5. 调服务端诊断 API
6. 更新 Hero 文案
7. 恢复按钮可点

### 3. 诊断展示

- `mode='llm'`：显示“由当前评测模型生成”
- `mode='fallback'`：显示“基础诊断”
- 若本次一键测试触发了 fallback，则用 toast 弱提示：
  “AI 诊断暂时不可用，已回退为基础诊断”

Hero 主区始终展示可执行结论，不直接把模型错误文案暴露给用户。

## 未测维度处理

每个维度都显式区分：

- `unconfigured`
- `pending`
- `running`
- `done`
- `failed`

诊断口径：

- 未配置/未出结果时，优先输出“覆盖不足/数据不足”
- 不能因为某个高分维度存在，就误判整体健康
- 缺维度时建议优先补齐可运行维度，再决定是否进入 Skill 优化

## 风险与取舍

### 为什么不让服务端自己重新查四维数据

本页现有 4 维摘要已经在前端可用；若后端再次重复拉取：

- 会增加实现复杂度
- 会引入与前端不同步的第二份聚合逻辑
- 会让“一键测试后刷新诊断”的链路更长

因此本期采用“前端汇总快照，服务端只做 LLM + fallback”的更轻实现。

### 为什么 fallback 也放到共享层

因为：

- 服务端 LLM 失败时要兜底
- 前端调用诊断接口失败时也要兜底

如果前后端各写一份规则，后续很容易漂移。

## 验证点

- 无 active model 时，Hero 仍能稳定展示基础诊断
- 选中 Recall + Static 一键测试后，完成即更新诊断并解锁按钮
- 选中 A/B 或 用例分析时，必须等后台任务完成或超时后再解锁
- 存在未配置维度时，诊断优先强调“覆盖不足”
- A/B 若显著回退，诊断优先输出“不建议上线”
