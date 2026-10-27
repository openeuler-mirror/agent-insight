# QwenPaw Trace 采集器：Phase 3 开发计划

版本：v1.0
最后更新：2026-09-06

> 文档类型：Phase3 开发计划（DP）
> 关联项目：agent-insight
> 状态：基于当前 QwenPaw collector 1.0.0 刷新

## 1. 实施顺序

1. 将历史旧采集器命名统一迁移为 `qwenpaw` / `QwenPaw`，内部 Python 模块使用
   `qwenpaw_insight` 避免和真实 QwenPaw 包冲突。
2. 修正 QwenPaw 插件 Hook 继承关系，让 `AgentInsightRootHook` 和
   `AgentInsightCleanupHook` 继承真实 `HookBase`，单元测试环境使用兼容基类。
3. 在 collector 中使用 `ctx.session_id`、`ctx.root_session_id`、`ctx.agent_id` 和
   `ctx.agent_config.name` 建立对话身份、真实 Agent 名和 turn 状态。
4. 建立统一消息提取模块，采集端和服务端都只读取 `user/human` 角色消息，并写入
   `qwenpaw.user_input`。
5. 移除正常链路中的 30 秒时间窗口猜测，孤立 LLM 不再生成新 Trace。
6. 补齐 LLM、MCP、Skill、Cron、标题生成和子 Agent 委派补丁，保持可逆和 fail-open。
7. 在服务端 QwenPaw Adapter 中实现 USER 插入、占位 query 刷新、task tool call 规范化和子
   Agent 树映射。
8. 接入 setup/auto 安装脚本、collector zip 下载路由、安装页选择器和平台标签。
9. 增加历史 QwenPaw USER 回填脚本，默认 dry-run，只有 `--apply` 写库。
10. 补齐设计文档、用户指南、README 和测试，确保仓库不再出现旧名称。

## 2. 实现文件

| 范围 | 文件 |
|-|-|
| Python collector | `scripts/qwenpaw-collector/pyproject.toml`、`scripts/qwenpaw-collector/backend.py`、`scripts/qwenpaw-collector/qwenpaw_insight/*.py` |
| 插件资产 | `scripts/qwenpaw-collector/plugin.json`、`scripts/qwenpaw-collector/qwenpaw_insight/_plugin_assets/*` |
| 安装路由 | `src/app/api/ingest/setup/qwenpaw-collector/{route,archive}.ts` |
| 安装脚本入口 | `src/app/api/ingest/setup/route.ts`、`src/app/api/ingest/setup/auto/route.ts` |
| 安装页 | `src/app/(main)/accessconfig/install/page.tsx` |
| 服务端 Adapter | `src/lib/ingest/otel/adapters/qwenpaw.ts`、`src/lib/ingest/adapters/qwenpaw.ts` |
| 存储与平台 | `src/lib/storage/data-service.ts`、`src/lib/ingest/ras/platform-label.ts` |
| 回填 | `scripts/backfill-qwenpaw-user-traces.ts` |
| 测试 | `test/qwenpaw/*.py`、`test/qwenpaw-setup-env.test.ts`、`test/qwenpaw-otel-adapter.test.ts`、registry/OTel/storage 相关测试 |
| 文档 | `docs/design/qwenpaw-trace-collector/*`、`docs/user-guide/observability/qwenpaw-trace-collector.md` |

## 3. 测试矩阵

| 层 | 场景 |
|-|-|
| Python Hook | 真实 `HookRegistry` 可接受 runtime hook，fallback 测试环境不依赖 QwenPaw 安装 |
| Python 消息提取 | Message、TextBlock、dict、list、Python repr、转义字符、多 TextBlock、无 user 消息 |
| Python collector | Agent、LLM、Tool、Skill、MCP、Cron、子 Agent relation、session end、flush 和 close |
| Python CLI | 安装、卸载、保留 spool、清理日志、插件目录和 `qwenpaw_insight` 包复制 |
| 服务端 Adapter | 无 Agent span、两轮消息、重复 LLM、标题生成、占位 query、Token、错误和最终结果 |
| 子 Agent 树 | 单子 Agent、batch、fork、跨 Agent、三层嵌套、后台延迟完成和 `buildAgentCallTree` |
| 安装路由 | setup/auto 的 Bash/PowerShell 生成、预选框架、collector zip 内容、白名单和 endpoint 契约 |
| 回填 | dry-run、apply、missing spool、无 USER 跳过、重复执行幂等 |
| 命名守卫 | 全仓不能出现旧名称；安装页和脚本不能显示重复的 QwenPaw 名称 |

## 4. 推荐验证命令

```powershell
python -m compileall -q scripts\qwenpaw-collector\qwenpaw_insight
$env:PYTHONPATH='scripts/qwenpaw-collector'; python -m unittest discover -s test/qwenpaw -p 'test_*.py'
node --import tsx --test test/qwenpaw-setup-env.test.ts test/qwenpaw-otel-adapter.test.ts test/framework-adapter-registry.test.ts test/otel-trace-aggregator.test.ts
rg -n -i "<deprecated-qwenpaw-alias>" .
rg --files | rg -i "<deprecated-qwenpaw-alias>"
```

更大范围的安装脚本回归建议单独运行：

```powershell
node --import tsx --test test/codex-central-setup.test.ts test/pi-agent-central-setup.test.ts test/qoder-setup-routes.test.ts test/qwencode-setup-routes.test.ts test/setup-noninteractive-compat.test.ts test/ingest-endpoint-contract.test.ts test/ras-platform-label.test.ts
```

如果本机没有 `pwsh`，或测试环境注入了已有 Agent Insight API Key，setup 脚本语法和直接安装
测试可能出现环境相关失败，需要在报告中单独标注。

## 5. 完成标准

- 安装页只显示 `QwenPaw`，脚本参数和 service name 只使用 `qwenpaw`；
- 仓库源码、测试、文档和文件名中没有旧名称；
- collector zip 包含 `qwenpaw_insight/`，不包含会遮蔽真实 QwenPaw 包的内部 `qwenpaw/`；
- 重新安装 collector 后，真实 QwenPaw 对话能生成 `AGENT -> USER -> LLM/TOOL`；
- 同一 QwenPaw 对话每次提问都会生成独立 Trace；
- 子 Agent 在详情页按树形展开，Trace 列表默认只展示根对话；
- 历史回填只更新可从 spool 恢复真实 USER 的记录，无法恢复的数据保持原状。

## 6. 发布注意事项

1. 升级 collector 版本后，需要让用户重新运行安装指导页生成的 QwenPaw 安装命令。
2. 安装完成后必须重启 QwenPaw，使插件 loader 重新加载 `agent-insight-qwenpaw`。
3. 旧 `session=unknown` 数据无法可靠恢复对话边界和 Agent 名称，不应合并。
4. 如果用户仍看到旧数据，应先确认页面打开的是重新安装后产生的新 Trace，再检查本地 spool
   和服务端 ingest 日志。
5. 不要把内部模块名改成 `qwenpaw`。这个名字属于上游 QwenPaw 包，collector 使用
   `qwenpaw_insight` 是为了避免导入冲突。
