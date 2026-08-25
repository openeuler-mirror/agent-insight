# agent-insight-copaw

CoPaw（QwenPaw）AgentInsight Trace 采集器：把 Agent 调用链、子 Agent、Skill、Tool、
LLM、MCP、Channel、Cron 八类 Trace 通过 OTLP 上报到 AgentInsight 看板。

## 安装（AC1）

```bash
pip install agent-insight-copaw
```

## 一行注册（AC2）

```python
import copaw
copaw.setup(host="http://localhost:3000", api_key="wi_xxx")
```

或作为 QwenPaw 插件安装（重启后自动加载）：

```bash
agent-insight-copaw install --host http://localhost:3000 --api-key <key>
```

`install` 会把 `plugin.json + backend.py + copaw/` 复制到 QwenPaw 的
plugins 目录，并写入 `config.json`。安装后自动创建 spool 目录（AC3）：

```
~/.agent-insight/otel_data/copaw/
```

多账号场景下，不同 API Key 的数据写入隔离子目录（AC4）：

```
~/.agent-insight/otel_data/copaw/<api-key-hash-8>/
```

## 卸载（AC27-AC30）

```bash
agent-insight-copaw uninstall          # 移除插件 + spool + 配置
pip uninstall agent-insight-copaw
```

Run `agent-insight-copaw uninstall` before `pip uninstall`: pip only removes
files it installed in site-packages and cannot run a package cleanup hook for
the user-owned plugin, spool, or configuration directories.

`uninstall` 只清理本插件自己的目录（插件目录、`~/.agent-insight/otel_data/copaw`、
插件 `config.json`），不影响其他框架采集器。重新 `pip install` 后可正常采集。

## 配置优先级

环境变量 > 插件 `config.json` > `~/.agent-insight/.env` > 默认值

- `AGENT_INSIGHT_OTLP_ENDPOINT`：OTLP traces 端点
- `AGENT_INSIGHT_API_KEY`：AgentInsight API Key
- `AGENT_INSIGHT_HOST`：AgentInsight 服务端地址
- `OTEL_SERVICE_NAME`：默认 `qwenpaw`（服务端 CoPaw Adapter 靠它匹配）

## 模块说明

- `otlp.py`：OTLP JSON span 构建与内容截断（默认 2000 字符，AC16）
- `sanitize.py`：敏感信息脱敏（API Key / token / 密码，AC12）
- `exporter.py`：spool 文件 + 后台线程异步上传 + 定时扫描（AC20）
  + 指数退避重试（AC23）+ `.sent` 标记防重复上传（AC22）+ 进程退出 flush（AC21）
- `collector.py`：会话/span 注册表与全部采集 API（agent/llm/tool/skill/mcp/cron）
- `hooks.py`：QwenPaw 运行时生命周期 Hook（agent 根 span、channel、错误）
- `middleware.py`：AgentScope 工具中间件（tool span、exit code、错误）
- `patches.py`：LLM / MCP / 子 Agent / Skill / Cron 运行时补丁（可逆）

## 测试

```bash
PYTHONPATH=scripts/copaw-collector python -m unittest discover -s test/copaw -v
```
