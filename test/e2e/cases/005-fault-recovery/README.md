# 005 故障注入/检测拦截/恢复验证（原006）

## 实际例子

用 thinking-dead-loop Skill 触发重复输出，核验检测、成功原生中断回执，再做恢复探测。

## 资源

引用 agent_fault_injection/fault_inject/skills/thinking-dead-loop/SKILL.md 产品原始资源。 专用资源使用虚构或已审查的测试内容；密钥仅从外部文件注入，运行产物不写入本目录。

## 操作与断言

详细可执行步骤见同目录 `scenario.mjs`；每个 `stage` 给出预期并保存实际结果。故障、检测、回执、同客户端恢复缺一不可。FI 任务 completed 与生成执行 interrupted 分别验收：同会话原生 MessageAbortedError 必须在 manifest 中记录为 termination_reason=fault_intercepted、agent_execution_status=interrupted，保留原退出码；这不能代替 RAS action_result 或恢复证据。

## 独立执行与复现

```bash
node test/e2e/run.mjs --case 005 --mode real --key-file /absolute/path/to/deepseek-key.txt
```

使用新 runId；读取报告中首个失败阶段、版本与受限日志。公共前置来自 shared，不依赖先运行其他场景。Mock 已提供模型协议夹具；其余客户端、页面、故障、回执和恢复断言均实际执行。使用 --mode mock 可独立复现，不传真实模型密钥。历史通过不能抵扣本轮失败。

## !554修复的复验边界（改号前006历史记录）

最新上游e191afe4的中断成功回执可能先于实际abort发送。用例仍要求随后在同一原生session观察到MessageAbortedError、FI分类fault_intercepted/interrupted，并由同一客户端完成正常恢复任务；收到前置ok=true回执本身不能算处置成功。当时仅按原006单例Mock复验；当前005已在默认PR/daily配置内。

前置回执phase=terminating与异常事件异步入库，不能要求其服务端ts按客户端执行顺序排列。若没有原始客户端检测时间，用例要求异常与回执具有完全一致的message_id/part_id/channel、持久化原生文本和随后MessageAbortedError，且事件落在60秒关联窗口内；任何abort失败回执、缺原生终止、跨会话/跨锚点均失败。有原始客户端检测时间时仍按原时间严格检查顺序。初次!554复验仅因回执比异常早1ms入库误报，失败及只读证据重放均保留，完整复验使用新runId。

!554最新单例Mock结果：fi554-006-mock-20261106-b全部必要阶段通过，含同客户端恢复及持久化；15次本地模型请求、0外部请求。UT4664项，4639通过、0失败、25跳过，完整无中断。当前仍只完成Mock模式，未宣称此次真实模型验证通过，本段保留当时结果，不代表改号后重新执行。
