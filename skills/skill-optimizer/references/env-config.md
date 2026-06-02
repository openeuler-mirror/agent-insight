# 环境变量配置

## LLM 配置（必需）

| 变量名 | 必选 | 说明 |
| :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API 密钥（或配置 `OPENAI_API_KEY`） |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com/` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |

推荐使用 `uv run python scripts/model_config_detector.py` 自动检测并写入。

## Agent Insight 平台（仅 dynamic/hybrid 模式需要）

优化器自动从 `~/.agent-insight/.env` 读取 `SKILL_INSIGHT_HOST` 和 `SKILL_INSIGHT_API_KEY`，无需在本技能下重复配置。静态模式不检查此配置。

## 监控与反馈（可选）

| 变量名 | 说明 |
| :--- | :--- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse 公钥，记录优化 Trace |
| `LANGFUSE_SECRET_KEY` | Langfuse 私钥 |
| `HUMAN_FEEDBACK_FILE` | 默认人工反馈文件路径 |

## 路径与策略（可选）

| 变量名 | 说明 |
| :--- | :--- |
| `OPT_SKILLS_DIR` | 待优化 Skill 默认目录 |
| `OPT_OUTPUT_DIR` | 优化结果默认输出目录 |
| `OPTIMIZATION_MAX_WORKERS` | 并行优化最大工作线程数 |
