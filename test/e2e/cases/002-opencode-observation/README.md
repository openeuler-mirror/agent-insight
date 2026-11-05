# 002 OpenCode 上报与观测

## 实际例子

OpenCode 读取日志总行数和第一行，经真实采集链路上报后在 Trace 与 Agent 页面核验。

## 资源

直接引用 public/example/messages；代码校验文件 SHA-256，期望 2000 行。 专用资源使用虚构或已审查的测试内容；密钥仅从外部文件注入，运行产物不写入本目录。

## 操作与断言

详细可执行步骤见同目录 `scenario.mjs`；每个 `stage` 给出预期并保存实际结果。本轮原生会话、实际工具内容、唯一 Trace、页面刷新和回跳全部一致。

## 独立执行与复现

```bash
node test/e2e/run.mjs --case 002 --mode real --key-file /absolute/path/to/deepseek-key.txt
```

使用新 runId；读取报告中首个失败阶段、版本与受限日志。公共前置来自 shared，不依赖先运行其他场景。Mock 适配尚未完成时明确阻塞；006 真实入口暂停。历史通过不能抵扣本轮失败。

## PR Mock

`node test/e2e/run.mjs --case 002 --mode mock` 使用同一场景驱动，仅将模型地址换为本机协议服务。夹具要求实际终端工具输出后才给最终回答；随后由原有断言核验原生会话、Trace 和页面。无需模型密钥，报告明确标记 mock。
