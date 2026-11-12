---
title: "Enable an isolated Storage Core Trace workflow"
description: "Explicit initialization, private identity mappings, original screens and isolated Trace validation."
---

# Enable an isolated Storage Core Trace workflow

**Product compatibility status (2026-11-12):** Login, navigation and frontend sources retain the pre-refactor version. Server compatibility now adapts existing Trace contracts to core storage. Evaluation backflow, diagnosis and other domains remain incomplete; this is isolated validation, not a production cutover.

The mode flag is server-only. Existing credentials must be verified and explicitly mapped to current IAM principals/workspaces. Missing mappings, revoked access and core failures fail closed without legacy Trace fallback. Other domains still have legacy paths. See the [reference](../../reference/platform/storage-core.md) and implementation status for coverage.

## Initialize and provision explicit targets

Use Python3.11+, a running ClickHouse instance and dedicated absolute paths, database names and ports. These examples use SQLite; PostgreSQL/openGauss are alternative control backends. Existing Prisma databases cannot be initialized or upgraded as core databases.

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

New targets apply001–005, currently schema_version5. Existing known prefixes are validated without an implicit upgrade. Upgrade an existing core target explicitly after backup:

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
AGENT_INSIGHT_TRACE_STORAGE=core \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=/absolute/path/to/isolated-core/identity-mapping.json \
bash scripts/develop_start.sh
```

Check port availability and checkout ownership first. Restart Next after server configuration changes. The old public flag remains a deprecated server-side alias; frontend code does not branch on storage mode. The bridge accepts an explicit loopback origin only. Next and the storage process must share a reachable network namespace.

Keep the original `/login` and existing keys. Set `AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE` to an absolute private regular0600 JSON file containing `version:1`, the exact `core_origin`, and `bindings`. Each binding has `legacy_api_key_sha256`, `legacy_username`, `principal_id`, `workspace_id` and a private delegated `credential`. Verify the legacy account/key before provisioning; do not infer membership from matching names or payload.user. Issue the delegated API credential with read/write/delete capabilities through the trusted setup session. The write-only collector key cannot serve UI reads. The Chinese guide contains a placeholder mapping example. Never commit this credential file.

## Ingest and inspect bounded pages

Collectors use workspace-bound `api_` credentials, not browser sessions. Send to `/api/ingest/otel/v1/traces` with Bearer authentication and optional `X-Workspace-Id` and `Idempotency-Key`. Load credentials securely from private files; do not put tokens in URLs or logged command arguments.

The Web entry accepts OTLP JSON/protobuf and gzip; decoded JSON is limited to4MiB/4096 completed Spans and64MiB of normalized expanded content. The loopback service receives JSON only. Default `source_namespace` is `otlp`: service.name affects display, so cross-service Spans with the same native Trace ID remain together. Explicit resource `agent_insight.source_namespace` separates integrations. Span `agent_insight.revision` defaults to1; changed content at the same source revision fails rather than overwriting history.

Successful OTLP responses remain an empty JSON object or protobuf body. `X-Storage-Batch-Id` and `X-Storage-State` identify the durable receipt. Accepted means the private packet was fsynced and the control transaction committed. Poll `/v1/batches/<id>?workspace_id=default`; write-only collectors can inspect their own receipts. Only indexed means all sinks completed.

The original `/trace` retains existing DTOs, filters, tags and detail controls. The compatibility layer reads all lightweight structure in pages of200, capped at100000 Spans/16MiB. It does not read ordinary OTLP payloads during structure loading. Selecting a Span loads its fixed interaction index and exact payload revision, using at most4 chunks per section page. Do not describe this as clicking before reading any structure.

Trace bundles retain v1 format and execution trees. Imports accept at most50MiB/500 executions, validate the entire tree first, remap colliding IDs and nested references, and return success only after all batches are indexed. Reuse an Idempotency-Key only to resume the same import. Export/full-session responses are capped at128MiB. Existing Langfuse views consume full nodes directly, so that compatibility path restores full bodies and is excluded from ordinary OTLP lazy-loading claims.

The global earliest-event queue is a correctness baseline: an early retry blocks later events. Payload writes batch at most128 Spans and4MiB per HTTP request, persisting chunks before manifests, then Span rows and Trace summaries. Retry reuses frozen versions. Thousand-collector mixed load, sharded logs, HA and browser acceptance require their own evidence; consult the current implementation status. Stop only the services started for this environment and preserve the databases, artifacts and private configuration.
