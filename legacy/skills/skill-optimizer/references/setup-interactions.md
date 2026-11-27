# Setup 异常交互模板

本文档定义了 Setup 阶段各异常场景下 Agent 应如何与用户交互。

## uv 未安装

检测到 `uv: command not found` 时：

```
Question: "Skill Optimizer 需要 'uv' 作为 Python 环境管理器，但当前系统未安装。是否现在安装？"
Options: "是，执行安装命令", "否，取消操作"
```

用户同意后执行：
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## 模型配置自动检测失败

`model_config_detector.py` 未找到有效 Key 时：

```
Question: "未找到有效的模型配置 (API Key)。请选择如何提供配置？"
Options: "方式1（推荐）：提供 DeepSeek API Key", "方式2：提供通用 LLM API Key", "取消操作"
```

用户提供后写入 `skill-optimizer/.env`（**必须**在 skill-optimizer 首层目录）：
```bash
echo "DEEPSEEK_API_KEY=sk-xxxx" >> .env
echo "DEEPSEEK_BASE_URL=https://api.deepseek.com/" >> .env
echo "DEEPSEEK_MODEL=deepseek-chat" >> .env
```

## 模型连通性测试失败

`test_model_connectivity.py` 未通过时，**必须停止优化**并交互：

```
Question: "模型连通性测试未通过，请重新配置以确保后续流程顺利进行："
Options: "获取 DeepSeek 的 api_key", "获取符合 OpenAI 规范的 LLM 的 base_url、api_key、model_name", "取消"
```

用户提供信息后更新 `.env`，然后**再次执行连通性测试**。只有测试通过后才可进入优化流程。

## 模型配置检测优先级

自动检测按以下顺序尝试：
1. **Claude Code**：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`
2. **OpenCode**：`node scripts/opencode-model-detector.cjs`
3. **Cursor/Windsurf**：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`

检测成功后配置自动写入 `skill-optimizer/.env`。
