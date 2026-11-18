---
title: "Enable an isolated Storage Core Trace workflow"
description: "Explicit initialization, private identity mappings, original screens and isolated Trace validation."
---

# Enable an isolated Storage Core Trace workflow

**Product compatibility status (2026-11-14):** Login, navigation and visible markup retain the pre-refactor layout. Server compatibility now adapts existing Trace contracts to core storage. Diagnosis chat/self-Traces and Trace reports use the protocol below; Dataset versions/Trace backflow/generation use the steps below; experiment/evaluation results and DiagnosisRun consumers are integrated incrementally, with remaining Workbench/Benchmark branches documented in implementation status; this is isolated validation, not a production cutover.

The mode flag is server-only. Existing credentials must be verified and explicitly mapped to current IAM principals/workspaces. Missing mappings, revoked access and core failures fail closed without legacy Trace fallback. Other domains still have legacy paths. See the [reference](../../reference/platform/storage-core.md) and implementation status for coverage.

## Initialize and provision explicit targets

Use Python3.11+, a running ClickHouse instance and dedicated absolute paths, database names and ports. These examples use SQLite; PostgreSQL/openGauss are alternative control backends. Existing Prisma databases cannot be initialized or upgraded as core databases.

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

New targets apply001–019, currently schema_version19. Existing known prefixes are validated without an implicit upgrade. Upgrade an existing core target explicitly after backup:

```bash
python3 -m services.storage migrate-sqlite \
  --database /absolute/path/to/isolated-core/core.db \
  --backup /absolute/path/to/isolated-core/new-before-upgrade.db
```

The backup must be a new sibling file. Relational initialization/migration requires private DSN files and external backup evidence; see the reference. Startup does not create schemas or ClickHouse databases.

Provision a new ClickHouse database with `ClickHouseStore.initialize_new_database()`. In the trusted setup process, use `IAMStore.create_principal`, `set_password` and `bind_workspace` after creating the workspace. Passwords require15..1024 characters; prompt interactively rather than placing secrets in command arguments. Issue a workspace-bound write-only API credential through a temporary login session, save it in a private collector file, and revoke that setup session. The Chinese procedure includes the complete Python sequence, including creation of a separate random0600 controller-key file without printing it.

Create a private regular `trace-service.json` file, mode0600 and not a symlink. Its exact SQLite configuration is:

```json
{
  "control": {"backend": "sqlite", "database": "/absolute/path/to/isolated-core/core.db"},
  "clickhouse": {"endpoint": "http://127.0.0.1:8123", "database": "agent_insight_core_isolated", "user": "default", "password": ""},
  "cursor_secret_hex": "REPLACE_WITH_64_RANDOM_HEX_CHARACTERS",
  "controller_key_file": "/absolute/path/to/isolated-core/controller-key",
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
AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=/absolute/path/to/isolated-core/controller-key \
bash scripts/develop_start.sh
```

Check port availability and checkout ownership first. Restart Next after server configuration changes. The old public flag remains a deprecated server-side alias; frontend code does not branch on storage mode. The bridge accepts an explicit loopback origin only. Next and the storage process must share a reachable network namespace.

Keep the original `/login` and existing keys. Set `AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE` to an absolute private regular0600 JSON file containing `version:1`, the exact `core_origin`, and `bindings`. Each binding has `legacy_api_key_sha256`, `legacy_username`, `principal_id`, `workspace_id` and a private delegated `credential`. Verify the legacy account/key before provisioning; do not infer membership from matching names or payload.user. Issue the delegated API credential with read/write/execute/delete capabilities through the trusted setup session. The write-only collector key cannot serve UI reads. The Chinese guide contains a placeholder mapping example. Never commit this credential file.

## Ingest and inspect bounded pages

Collectors use workspace-bound `api_` credentials, not browser sessions. Send to `/api/ingest/otel/v1/traces` with Bearer authentication and optional `X-Workspace-Id` and `Idempotency-Key`. Load credentials securely from private files; do not put tokens in URLs or logged command arguments.

The Web entry accepts OTLP JSON/protobuf and gzip; decoded JSON is limited to4MiB/4096 completed Spans and64MiB of normalized expanded content. The loopback service receives JSON only. Default `source_namespace` is `otlp`: service.name affects display, so cross-service Spans with the same native Trace ID remain together. Explicit resource `agent_insight.source_namespace` separates integrations. Span `agent_insight.revision` defaults to1; changed content at the same source revision fails rather than overwriting history.

Successful OTLP responses remain an empty JSON object or protobuf body. `X-Storage-Batch-Id` and `X-Storage-State` identify the durable receipt. Accepted means the private packet was fsynced and the control transaction committed. Poll `/v1/batches/<id>?workspace_id=default`; write-only collectors can inspect their own receipts. Only indexed means all sinks completed.

The original `/trace` retains existing DTOs, filters, tags and detail controls. The compatibility layer reads all lightweight structure in pages of200, capped at100000 Spans/16MiB. It does not read ordinary OTLP payloads during structure loading. Selecting a Span loads its fixed interaction index and exact payload revision, using at most4 chunks per section page. Do not describe this as clicking before reading any structure.

Trace bundles retain v1 format and execution trees. Imports accept at most50MiB/500 executions, validate the entire tree first, remap colliding IDs and nested references, and return success only after all batches are indexed. Reuse an Idempotency-Key only to resume the same import. Export/full-session responses are capped at128MiB. Existing Langfuse views consume full nodes directly, so that compatibility path restores full bodies and is excluded from ordinary OTLP lazy-loading claims.

The global earliest-event queue is a correctness baseline: an early retry blocks later events. Payload writes batch at most128 Spans and4MiB per HTTP request, persisting chunks before manifests, then Span rows and Trace summaries. Retry reuses frozen versions. Thousand-collector mixed load, sharded logs, HA and browser acceptance require their own evidence; consult the current implementation status. Stop only the services started for this environment and preserve the databases, artifacts and private configuration.

## Isolation prerequisites for the application suite

Storage tests and `npm run test` are separate gates. Use dedicated HOME, AGENT_INSIGHT_HOME and SQLite targets, clearing inherited DB_* and core-mode settings. Never run against daily business data. Database tests use `createIsolatedDatabase` before importing Prisma and disconnect/restore afterwards. The isolation helper removes relational settings and pins an empty DB_HOST so dotenv cannot select a remote database.

The complete environment needs a supported Node LTS, existing Python with PyYAML/pydantic2, PowerShell7 and the compiled Trae extension. Select verified installed tools through per-process PATH, PYTHON, AGENT_INSIGHT_FI_PYTHON and AGENT_INSIGHT_RAS_PYTHON. PowerShell parsing uses a temporary HOME. Do not change global configuration or install unapproved dependencies. Building the extension JS with existing esbuild is not VSIX packaging or IDE acceptance.

Initialize legacy Prisma fixtures only in a new isolated SQLite file with `prisma db push --skip-generate`, never core.db. HTTP cleanup must close connections even after failures. Report missing prerequisites, missing schema and scheduling races separately; do not hide them with skips or unbounded waits. Consult implementation status for final counts and platform coverage.


## Verify diagnosis in isolation

Back up and explicitly upgrade the isolated core target to009. Keep the existing login and private identity mapping; use read/write for follow-up chat, execute for reports and delete for existing deletion operations, subject to Trace ownership and group roles. Do not use a write-only collector key for the UI.

Open an authorized Trace in the original fault page, start a follow-up and reload its history. Check the `fault-diagnosis-agent` self-Trace using the original provider session ID and inspect actual tool results. Restart the isolated core service and verify the persisted messages. Explicit null creates a new upstream session; cross-actor continuation currently returns409, while an authorized group admin can read history and start their own conversation.

Run/reload AgentDebug and SkillsAnalysis through their original endpoints; force/delete must fence old jobs and live revocation/deletion must stop access. State whether validation used a fixture Agent or a real model. Fixture runs verify storage/HTTP/SSE and UI recovery, not real-model diagnosis quality. Legacy conversations/reports are retained without automatic import.

Use the original login flow. Diagnosis uses the same existing Key and retains existing logout/account-switching behavior.


## Verify Dataset contracts (008/009)

Initialize new targets through009. For an existing isolated core target, stop writers, retain the artifact directory and upgrade explicitly to9 with a fresh backup path. Do not use Prisma db push or point initialization at the original business database.

Use the original sidebar Dataset page to create a Dataset, add/edit a case and add a field, then refresh. Backflow the same Trace twice to verify deduplication; save two stale edit drafts to verify409 without losing the first change. There are no new visible version controls; use the reference queries for historical summaries.

Ingest real OTLP first, select an authorized Agent/time window in the existing Trace-generation form, and check progress, publication, cancellation and deletion receipts. Restart the isolated Next/helper processes and view progress as the original live actor: recovery waits for an existing lease to expire, then increases the epoch. Cancellation of a published job conflicts; deletion needs its independent capability. Remaining experiment/Benchmark consumers are outside this acceptance slice.


## Isolated experiment validation (010–014)

Stop target writers, retain a control backup and the complete artifact directory, explicitly migrate to014, then restart. Pending migrations prevent service startup. Preserve historical SQL checksums. Configure the same private controller key file for Next and the helper; do not reuse a login key. Keep the existing UI and test create, run, result detail, human score0, comments and reevaluation. Inspect immutable receipts, separate CH publication, source revocation, stale fences, unresolved cleanup and exact retries, and verify that legacy Experiment/Case/Result tables received no shadow records. Check implementation status for remaining Workbench/Benchmark branches and exact acceptance coverage.


## Read-only planning before legacy migration

Run `plan-legacy --database /absolute/path/to/isolated-legacy.db --source-id stable-source` against an existing consistent isolated copy. See the [storage reference](../../reference/platform/storage-core.md#read-only-semantic-planning-no-import) for explicit owner mappings, budgets, status and privacy. Reports do not replace raw backups/exports; copying only the main file of an active WAL database is unsafe. Only SQLite sources are supported, export-directory input is not implemented, and every plan remains blocked with no apply. This phase does not stop production writers, migrate credentials or switch connection strings.

## Issue resolution callbacks and observed pricing models

In core mode, existing issue GET and post-optimization resolve PATCH requests carry the current login Key. Derived issues use typed immutable resolution annotations; static/feedback issues remain in their existing control domain. Mixed requests preflight before separate commits, support retries and are not cross-store atomic transactions. Missing threadId retains a public null association without changing machine evidence. Explicit operation replay restores the core receipt; ordinary new requests count new resolutions. Mixed HTTP counts combine the core operation count and this request's static updates, without a whole-response exact replay guarantee.

Pricing GET obtains observed models from the caller's IAM-authorized Trace scope. Group admins do not gain other workspaces through the legacy deployment-admin name. Built-in/custom prices, currency, sorting and UI are retained; pricing PUT configuration control is not migrated here. Existing account switching/logout uses the current Key with no new login or layout. Dashboard/Fleet/Quality and OTLP logs/metrics/spool remain separately tracked dependencies; this model-list slice does not complete them.


For analytics consumers, explicitly migrate the isolated control store to 015 and initialize CH002. Existing pages and success payloads remain unchanged. Verify real IAM isolation, native Agent platform filtering, selected zero scores, current unresolved issues/reports and genuine RAS events. Write-only API keys may submit RAS events; reading statistics requires read permission. Initial indexing has a dedicated retry marker. Never treat503 as an empty dataset or claim 1000-collector capacity from endpoint tests.

Version one is limited to preserving existing features, UI, workflows, statistics and data. Large-Trace capacity work and watermarked snapshots are deferred to version two.


Validate Skill and Agent dynamic reads through the original `/skills` and `/agents` pages: list statistics, version trends and full execution output, including empty results, zero values and historical executions without Sessions. Keep existing static configuration and registrations; dynamic statistics use authorized core storage. A legacy login mapped to a different canonical IAM username must still discover only its own Agents. Skill runs/logs, Agent deletion and asset/configuration writes are outside this slice, so the legacy control database remains required.


## Acceptance after019 control integration

Explicitly upgrade the isolated target to019, then use the original login and screens. The request wrapper transports the current existing API key for control APIs; a body/query username alone is not authentication. SDK, collector and device credentials keep their respective protocols. Missing configuration or authorization fails explicitly without reading the old transactional database as a fallback. Standalone, organization and IDaaS login and masked-settings restoration retain their original rules without new login UI.

Skill versions/files, configuration, clients, Workbench/optimization/generator sessions and debug results now use the control repository. Consolidated acceptance must cover list/detail/file/save, installation/heartbeat/command ACK/configuration and deployment receipts, session SSE/candidate/retest/publish, and Agent deletion with Trace/diagnosis source lifecycle. Four TSX files only add transport imports, with dynamic runtime headers; visible layout, wording, interactions and existing features remain unchanged. Focused checks and types are not full acceptance.

Keep the original database and files. Import historical terminal/static records explicitly under their real owner. Active tasks, unconsumed installation tokens and usable device credentials cannot be activated silently; report and block them until an explicit inert-migration contract exists. Do not disguise them as deleted or completed. Production remains unchanged.


### No extra background mapping for native users

Create the native User and configure its personal model in the original screens. Background work restores the durable User and its actual current API credential after restart without a handwritten identity file. Migrated wi credentials still use the existing private mapping; malformed or ambiguous mappings are never guessed or silently replaced. Keep the existing private core controller file configured; no browser key-disclosure workaround is required.

The uploader still needs write only. Background analysis separately checks the same owner's current execute capability. Readonly, revoked or expired credentials and administrators merely viewing another user's Trace cannot use that user's model. Validate this workflow in isolated state; the original UI and production data remain unchanged.
