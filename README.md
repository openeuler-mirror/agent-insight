# Agent Insight · Frontend/backend refactor

[中文说明](README.zh.md) · [Design](design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md) · [Developer rules](docs/en/how-to/platform/refactor-module-boundaries.md)

This branch establishes the platform layout and TypeScript contracts. Build new features in `apps/`, `packages/core/` and `extensions/`. Unit and system tests belong in `test/UT/` and `test/ST/`. The [previous project](legacy/) is preserved with its original paths for migration and reference.

The application and deployment entry points will be filled in as features move. To validate the current contracts, run `tsc -p tsconfig.contracts.json` with TypeScript 5.9.3.
