# 定向查因流程

诊断追问入口会提供包含 `query` 与归一化 `turns` 的输入 JSON。当前 Agent 必须先运行：

```bash
python3 .agent-debug-diagnosis/scripts/detector_runner.py run-all \
  --mode targeted \
  --input .agent-insight/follow-up-diagnosis-input.json \
  --output .agent-insight/targeted-detectors.json
```

runner 从输入 JSON 的 `query` 读取用户问题，通过 `detectors/*/detector.json` 匹配症状关键词，并且只执行命中的诊断器。`runs` 为空时自动回到普通追问，不声称完成了专项诊断；有 `findings` 时进入定向查因，不运行 AgentDebug 五模块。

回答时：

- 优先解释专项结果与用户所问症状之间的关系。
- 当前 Agent 可以基于 trace 样本补充 `summary`、`mechanism`、`faultChain` 和修复建议，不启动独立富化模型。
- 将 `facts`、`details` 中的计数、区间、比例及 `anchors` 视为不可改写的确定性事实。
- 结合已有 AgentDebug 报告与 trace 补充因果解释；证据不足时明确说明。
- 只允许运行匹配到的 Skill-local 诊断器，不运行 AgentDebug 五模块。
