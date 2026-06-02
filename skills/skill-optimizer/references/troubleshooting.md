# skill-optimizer 故障排查

本文件用于承载较完整的故障排查与 FAQ。`SKILL.md` 只保留最短可执行闭环与少量高频错误。

### 1) 依赖未安装

现象：`ModuleNotFoundError: No module named 'langchain'` 或类似错误

可能原因：虚拟环境未创建或未激活，依赖未安装到正确的环境中。

处理：
1. 确保在 skill-optimizer 目录下：`cd /path/to/.opencode/skills/skill-optimizer`
2. 使用包装脚本自动处理环境：`./scripts/opt.sh --help`
3. 或手动创建虚拟环境：`uv venv .opt`（只需执行一次）
4. 使用 `uv run` 执行命令：`uv run python scripts/xxx.py`（推荐）
5. 或手动激活环境：`source .opt/bin/activate`（每次运行前执行）


## 2) 找不到 uv
现象：`./scripts/opt.sh` 提示未找到 `uv` 命令。

处理：
- 安装 uv 后重新打开终端再试。

```bash
# Linux/macOS
curl -LsSf https://astral.sh/uv/install.sh | sh

# 或使用 pip
pip install uv
```

## 3) 缺少模型配置 / API Key
现象：运行优化时报错提示需要配置 `.env`，未找到 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`。

处理：
- 首选自动检测：
  - `uv run python scripts/model_config_detector.py`
- 或手动写入 `.env`（在 `skills/skill-optimizer` 根目录）
- 当你无法找到 API Key 时向用户询问

相关入口： scripts/model_config_detector.py


## 4) 模型连通性测试失败
现象：`test_model_connectivity.py` 失败。

处理建议：
- 优先检查 base_url / api_key / model_name 是否匹配。
- 若处于企业代理环境，检查网络与证书策略。

相关入口： scripts/test_model_connectivity.py


## 5) 找不到 SKILL.md

现象：输入路径不正确或不包含 SKILL.md 文件

处理：

- 确认输入路径是包含 SKILL.md 的目录，而不是 SKILL.md 文件本身
- 使用 `path/to/your/skill_dir` 而不是 `path/to/your/skill_dir/SKILL.md`


## 6) dynamic/hybrid 模式无法获取历史日志
现象：dynamic/hybrid 拉取运行记录失败。

处理：
- 确认平台服务可用、必要的 host/user 配置可被读取。
  - 通常，需要 SKILL_INSIGHT_HOST 和 SKILL_INSIGHT_API_KEY
  - 检查环境变量中是否包含相关配置。
  - 检查用户的 ~/.agent-insight/.env 中是否包含相关配置。
- 若暂时无法获取日志，可先使用 static 模式完成结构化优化，再补充 dynamic。

相关入口： scripts/skill_insight_api.py


## 7) skill优化完成后上传失败

可能原因：平台服务不可用或权限问题

处理：
- 检查平台服务状态
- 验证用户权限
- 查看错误日志中的详细信息


## 8) 性能提示

- 静态优化：约 1-3 分钟
- 动态/混合优化：约 3-8 分钟
- 调用方 Agent 建议设置 5-10 分钟超时
- 使用 `--serial` 可禁用并行环境检查
