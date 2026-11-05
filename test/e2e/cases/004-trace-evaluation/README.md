# 004 已有 Trace 无数据集闭环

## 实际例子

原生 Skill 先生成 Trace，再用该 Trace 做无参考评测和诊断，定向优化后重跑。

## 资源

fixtures/trace_root_ssh.py；trace-only-contract.mjs 生成最小 Skill。 专用资源使用虚构或已审查的测试内容；密钥仅从外部文件注入，运行产物不写入本目录。

## 操作与断言

详细可执行步骤见同目录 `scenario.mjs`；每个 `stage` 给出预期并保存实际结果。无新增数据集；原生 Skill 绑定、核心步骤覆盖、诊断锚点、候选及旧版保留。

## 独立执行与复现

```bash
node test/e2e/run.mjs --case 004 --mode real --key-file /absolute/path/to/deepseek-key.txt
```

使用新 runId；读取报告中首个失败阶段、版本与受限日志。公共前置来自 shared，不依赖先运行其他场景。Mock 适配尚未完成时明确阻塞；006 真实入口暂停。历史通过不能抵扣本轮失败。
