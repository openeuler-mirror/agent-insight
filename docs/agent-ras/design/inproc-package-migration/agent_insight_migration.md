# 迁入 AgentInsight（M-Insight）清单

> 产品落位目标：**[agent-insight](https://gitcode.com/openeuler/agent-insight)**（仓根 `agent_ras/`）。  
> 对侧设计真源：本目录 phase1～3（[`phase1-requirements-analysis.md`](./phase1-requirements-analysis.md) 等）。

当前落位：

1. 整树位于 **`agent-insight/agent_ras/`**（仓根，非 `packages/`）
2. 生产安装基础包；开发使用 `pip install -e ".[dev]"` 和 `pytest agent_ras/tests/unit_tests`
3. 统一入口 `npx agent-insight install-ras`  
   → 稳定 runtime + `~/.config/opencode/plugins/agent-insight-ras.js`
   → 自动安装只由看板“安装指导”的 OpenCode 接入步骤触发，并绑定服务端 npm 包版本
4. 运行时配置目录：`~/.agent-insight/ras/config.json`（唯一真源）
5. 人机监控 UI：Insight「可靠性观测」列表和完整链路详情；Mock 故障注入页保留并明确标注
6. anomaly/actions 经 `POST /api/ingest/ras/v1/events` **落库**（`RasAnomalyEvent`），idle 后仍可在 Trace 查看
7. 不保留独立 RAS HTTP/WS 服务、静态 UI 或第二套安装入口
8. 平台启动不检查 Agent 主机 RAS；已有客户端邮箱 Key 不被内部 admin Key 覆盖

openjiuwen 用户（迁入后）：

```bash
pip install -e ./agent_ras[openjiuwen]
# 使用 platform_adapter.openjiuwen.factory.build_agent_ras_rail
```

## 边界（迁入时仍成立）

| 做 | 不做 |
|----|------|
| 整树真源在 `agent_ras/`；insight 薄胶水（安装/配置/UI） | 把检测算法改写进 TS / OTLP-only |
| 环内 abort / notice / steer 仍走 Host 插件 + core | 与外部非本仓工作流耦合 |
| 观测旁路可另接 OTLP → insight ingest | 用观测替代环内恢复 |
