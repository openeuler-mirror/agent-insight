# Phase3：FI 服务端/客户端分离 — 开发计划

> 依据：[phase2-requirements-design.md](./phase2-requirements-design.md)  
> 日期：2026-08-05  
> **状态：✅ 已完成**（M1–M4；2026-08-05 浏览器 E2E 通过）

## 里程碑

| 序 | 内容 | 验收 |
|----|------|------|
| M1 | Prisma Worker + Run 租约字段；store 聚合/`queued`；workspace 逻辑标记 | schema push；单测 |
| M2 | tasks/rerun/stop 去 spawn；dry-run 服务端 stub；worker heartbeat/claim/commands/collect-result；platforms/health 读 inventory | API 单测或手工 curl |
| M3 | `scripts/fi-worker.js` + `install-fault-injection` 写 config/`--start`；`/api/fault-injection/setup` | `--check`；Worker claim 一轮 |
| M4 | 文档状态 + `npm run test` | 测试绿 |

## 非目标（本迭代）

- systemd user unit（文档 keep-alive 即可）
- artifacts 整包上传到服务端文件存储
- WebSocket

## 存储对齐（Insight）

- 权威数据：Prisma（`Session` / `FaultInjection*` / `RasAnomalyEvent`）经 collect-result ingest
- 本机运行目录：`~/.agent-insight/fault-injection/`（与 `ras/` 并列，非 `data/` 库目录）
