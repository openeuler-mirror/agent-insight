---
title: "Enable an isolated Storage Core Trace workflow"
description: "Explicit initialization, private service configuration, password login, OTLP ingestion and paginated reads."
---

# Enable an isolated Storage Core Trace workflow

The opt-in core mode handles Trace ingestion, lists, Span structure and payloads. It uses separate IAM password accounts, transactional storage and ClickHouse. Leaving the flag unset preserves the existing path. Once enabled, missing configuration, authorization failures and backend errors fail explicitly. See the [reference](../../reference/platform/storage-core.md) and the authoritative [Chinese procedure](../../../zh/how-to/platform/storage-core.md) for the complete one-time provisioning script.

## Initialize and provision explicit targets

Use Python3.11+, a running ClickHouse instance and dedicated absolute paths, database names and ports. These examples use SQLite; PostgreSQL/openGauss are alternative control backends. Existing Prisma databases cannot be initialized or upgraded as core databases.

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

New targets apply001–004, currently schema_version4. Existing known prefixes are validated without an implicit upgrade. Upgrade an existing core target explicitly after backup:

```bash
python3 -m services.storage migrate-sqlite \
  --database /absolute/path/to/isolated-core/core.db \
  --backup /absolute/path/to/isolated-core/new-before-upgrade.db
```

The backup must be a new sibling file. Relational initialization/migration requires private DSN files and external backup evidence; see the reference. Startup does not create schemas or ClickHouse databases.

Provision a new ClickHouse database with `ClickHouseStore.initialize_new_database()`. In the trusted setup process, use `IAMStore.create_principal`, `set_password` and `bind_workspace` after creating the workspace. Passwords require15..1024 characters; prompt interactively rather than placing secrets in command arguments. Issue a workspace-bound write-only API credential through a temporary login session, save it in a private collector file, and revoke that setup session. The Chinese procedure includes the complete Python sequence.

Create a private regular `trace-service.json` file, mode0600 and not a symlink. Its exact SQLite configuration is:

```json
{
  "control": {"backend": "sqlite", "database": "/absolute/path/to/isolated-core/core.db"},
  "clickhouse": {"endpoint": "http://127.0.0.1:8123", "database": "agent_insight_core_isolated", "user": "default", "password": ""},
  "cursor_secret_hex": "REPLACE_WITH_64_RANDOM_HEX_CHARACTERS",
  "default_workspace": "default",
  "port": 4319,
  "worker_enabled": true
}
```

Generate the cursor secret with `secrets.token_hex(32)` in the private provisioning process; the placeholder is not runnable. Supply the actual CH credentials only in the private file. Back up `core.db.artifacts/` together with control data. For PostgreSQL/openGauss, the control object instead contains `backend`, `dsn`, `schema` and `artifacts`; use a driver compatible with the target authentication, not an unverified PG wheel.

## Start the loopback service and Web bridge

```bash
python3 -m services.storage.trace_service --config /absolute/path/to/isolated-core/trace-service.json
```

The service binds127.0.0.1 only. `/v1/health` reports the control schema and worker state; it does not prove an actual CH ingestion succeeded. `worker_enabled=false` can pause materialization for isolated recovery tests while durable acceptance continues.

Next needs its own isolated runtime home and Prisma shell database. **Do not point DATABASE_URL at core.db**: startup and other application areas may still initialize the legacy shell database.

```bash
AGENT_INSIGHT_HOME=/absolute/path/to/isolated-web \
DATABASE_URL=file:/absolute/path/to/isolated-web/data/legacy-shell.db \
AGENT_INSIGHT_PORT=4320 \
NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE=core \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
bash scripts/develop_start.sh
```

Check port availability and the checkout's `.next` ownership first. The same variables may be stored in this isolated runtime home's `.env`. The public mode flag requires rebuilding/restarting the frontend when changed. The server-side bridge origin must be explicit loopback HTTP(S), without a path, query or URL credentials. Next and the Python service must share a reachable loopback network namespace.

Open `/login` and use the provisioned IAM username/password. Core uses a separate HttpOnly, SameSite=Strict session cookie, scoped by backend origin; HTTPS adds Secure and login/logout validate same-origin requests. Session secrets stay out of browser JS. Existing username registration, legacy keys and localStorage identities do not authenticate core. Unsetting the mode flag and rebuilding selects the old path without copying data between stores.

## Ingest and inspect bounded pages

Collectors use workspace-bound `api_` credentials, not browser sessions. Send to `/api/ingest/otel/v1/traces` with Bearer authentication and optional `X-Workspace-Id` and `Idempotency-Key`. Load credentials securely from private files; do not put tokens in URLs or logged command arguments.

The Web entry accepts OTLP JSON/protobuf and gzip; decoded JSON is limited to4MiB/4096 completed Spans and64MiB of normalized expanded content. The loopback service receives JSON only. Default `source_namespace` is `otlp`: service.name affects display, so cross-service Spans with the same native Trace ID remain together. Explicit resource `agent_insight.source_namespace` separates integrations. Span `agent_insight.revision` defaults to1; changed content at the same source revision fails rather than overwriting history.

Successful OTLP responses remain an empty JSON object or protobuf body. `X-Storage-Batch-Id` and `X-Storage-State` identify the durable receipt. Accepted means the private packet was fsynced and the control transaction committed. Poll `/v1/batches/<id>?workspace_id=default`, or the corresponding Next `observe/session?action=batch` endpoint; write-only collectors can inspect their own receipts. Only indexed means all sinks completed.

`/trace` lists50 Traces per page, loads at most200 Span rows per structure page, and reads at most4 payload chunks per page, up to256KiB each. Payload reads use the selected Span's exact payload_revision. Missing sections report available=false. The UI does not fetch all10,000 Spans or an entire Trace JSON before showing one Span.

The global earliest-event queue is a correctness baseline: an early retry blocks later events. Payload writes batch at most128 Spans and4MiB per HTTP request, persisting chunks before manifests, then Span rows and Trace summaries. Retry reuses frozen versions. Thousand-collector mixed load, sharded logs, HA and browser acceptance require their own evidence; consult the current implementation status. Stop only the services started for this environment and preserve the databases, artifacts and private configuration.
