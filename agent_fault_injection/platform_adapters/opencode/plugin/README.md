# OpenCode FI plugins

- **Active entry**: [`agent-fault-injection.ts`](agent-fault-injection.ts) — hooks only; rewrite ops live in [`../lib/rewrite-runtime.ts`](../lib/rewrite-runtime.ts).
- Isolation layout: entry → `config/plugins/`; rewrite-runtime → `config/lib/` (never under `plugins/`).
- Legacy `agent-ras-eval.ts` has been removed; do not reintroduce it.
