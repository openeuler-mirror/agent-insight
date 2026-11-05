# 006 故障检测恢复

## 实际例子

用 thinking-dead-loop Skill 触发重复输出，核验检测、成功原生中断回执，再做恢复探测。

## 资源

引用 agent_fault_injection/fault_inject/skills/thinking-dead-loop/SKILL.md 产品原始资源。 专用资源使用虚构或已审查的测试内容；密钥仅从外部文件注入，运行产物不写入本目录。

## 操作与断言

详细可执行步骤见同目录 `scenario.mjs`；每个 `stage` 给出预期并保存实际结果。故障、检测、回执、同客户端恢复缺一不可；当前真实执行按用户要求暂停。

## 独立执行与复现

```bash
node test/e2e/run.mjs --case 006 --mode real --key-file /absolute/path/to/deepseek-key.txt
```

使用新 runId；读取报告中首个失败阶段、版本与受限日志。公共前置来自 shared，不依赖先运行其他场景。Mock 适配尚未完成时明确阻塞；006 真实入口暂停。历史通过不能抵扣本轮失败。
