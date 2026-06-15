# 设计记录（Design records）

每条都来自一次 spike（`/spike`），由 `/spike-wrap` 固化。**agent 文档是源真相**；human 摘要是给人读的短版。

| Topic | Title | Status | Date | Gist | Agent doc | Human doc |
|-------|-------|--------|------|------|-----------|-----------|
| jiuwenswarm-tracing | 把 agent-insight 接入 openJiuwen / JiuwenSwarm（OTEL seam） | validated | 2026-06-13 | 复用 jiuwen 自带 OTEL 接住 span→转富 JSON→/api/ingest/upload，零改 jiuwen；单/team/Task 三形态成树；顺带修复 jiuwen 流式 span 不收尾 | [design.md](agents/jiuwenswarm-tracing/design.md) | [index.html](humans/jiuwenswarm-tracing/index.html) |
