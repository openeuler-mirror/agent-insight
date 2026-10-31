---
title: "Runtime configuration"
description: "Runtime root, ports, database, models, and evaluation configuration entry points."
---

This reference covers common platform settings. Clients and the Evaluator are separate processes; the platform `.env` is not automatically applied to them. The installed version's `.env.example` is the complete configuration template. Do not assume historical variables are still supported.

## Files and precedence

The launch environment selects `AGENT_INSIGHT_HOME`, defaulting to the runtime user's `~/.agent-insight`; the platform then reads its `.env`. Set the root through the startup command, systemd, or Docker environment. A root's own `.env` cannot select itself.

For npm CLI startup, port precedence is `--port`, process `AGENT_INSIGHT_PORT`, runtime-root `.env`, then `3000`. SQLite `DATABASE_URL` uses the process value before `.env`, with an empty value selecting the default path. Source `scripts/start.sh` preserves these explicit launch overrides too. Do not generalize this precedence to every setting or independent service.

`.env.example` is a template used to initialize missing runtime settings. Editing it does not update an existing runtime `.env`. Platform changes usually require restart; frontend build settings require rebuilding. Evaluation connection hot reload is described below.

## Core variables

| Variable | Purpose/default | Location and notes |
| --- | --- | --- |
| `AGENT_INSIGHT_HOME` | Runtime root, default `~/.agent-insight` | Launch environment; prefer an absolute path. Contains `.env` and `data/`, not necessarily the checkout |
| `AGENT_INSIGHT_PORT` | Platform HTTP port, default `3000` | Platform settings or process environment; integer `1`–`65535`, overridden by `--port` |
| `DATABASE_URL` | SQLite URL; empty uses root `data/witty_insight.db` | Prefer `file:/absolute/path`; inspect old absolute paths when moving the root |
| `DB_HOST` | Optional OpenGauss host, no default | Set only for that database deployment and check all connection fields |
| `DB_PORT` | OpenGauss port | Set explicitly: platform default is `5432`, initialization-script default is `26000`; match the actual instance |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Template defaults database to `postgres`, user to `omm`, no password default | Store credentials only in actual deployment settings; SQLite copying is not an external-database backup |
| `AGENT_INSIGHT_CONFIG_DIR` | Benchmark configuration directory; empty uses installation `config/benchmark/` | Use an absolute override. This is not the runtime root and does not replace its `.env` |
| `NEXT_PUBLIC_URL_PREFIX` | Frontend URL prefix | Changing it requires rebuilding, not only restarting |

Removed `AGENT_INSIGHT_DATA_DIR` must become `AGENT_INSIGHT_HOME` while retaining the original root path. Removed generic `PORT` must become the platform or Evaluator-specific variable.

## Models and clients

Default models use consecutive `DEFAULT_MODEL_<N>_<FIELD>` groups starting at `1`. Reading later groups stops when a group lacks `NAME`, `PROVIDER`, or `API_KEY`. Explicitly provide `BASE_URL` and `MODEL` rather than assuming every calling path chooses identical provider defaults. Environment-defined models are read-only in the UI; users can add their own through [model registration, Chinese](../../../zh/how-to/platform/settings/model-registry.md).

See [client installation, Chinese](../../../zh/how-to/platform/settings/access-control.md) for addresses and Keys. Each client has its own environment. Do not share one runtime directory across machines or instances; use separate roots, databases, and ports.

## Evaluation service and business settings

| Setting | Scope | Application |
| --- | --- | --- |
| `AGENT_INSIGHT_EVALUATOR_PORT` | Evaluator port or host mapping, default `3001` | Independent deployment setting; container-internal ports depend on its deployment file |
| `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL` | Platform connection to independent Evaluator, empty by default | Startup fallback; local example `http://127.0.0.1:3001` |
| `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP` | Allows non-loopback HTTP, default `true` | Relies on network isolation; `false` requires HTTPS outside loopback |
| `AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL` | Legacy local-executor callback override, empty by default | Otherwise derived from the request; not a substitute for Evaluator URL |
| `data/config/benchmark-evaluator.env` | Those three evaluation connection settings inside the runtime root | Can hot-reload without restarting the platform |
| `platform.yaml` / `platform.local.yaml` | Benchmark defaults and local overrides in the config directory | Source and auto-import settings; see the Benchmark deployment guide |

SWE-bench and ZSoft auto-import can be disabled separately through each `dataset.autoImport`. Legacy source environment variables do not replace current YAML configuration. See [Benchmark service deployment, Chinese](../../../zh/how-to/evaluation/benchmarks/deploy-services.md).

## Operations

- [FAQ, Chinese](../../../zh/how-to/platform/faq.md): paths, permissions, ports, and startup.
- [Backup and restore](../../how-to/platform/backup-and-restore.md): platform, external storage, and client scope.
- [Upgrade and rollback](../../how-to/platform/upgrade-and-rollback.md): schema synchronization and version pairing.

This page does not enumerate every collector, performance, or diagnostic parameter. Consult its feature guide and current template; omission here does not mean deprecation.

[中文权威版本](../../../zh/reference/platform/configuration.md)
