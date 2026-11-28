---
title: "Enable an isolated Storage Core Trace workflow"
description: "Explicit initialization, private identity mappings, original screens and isolated Trace validation."
---

# Enable an isolated Storage Core Trace workflow

For network SQLite, independent database containers and source installations, see the [deployment guide](deploy-docker.md).

The [application database INI](../../../../config/deployment/storage.ini) can be edited after both services start. Docker reads it when starting the application. Source installations can select it with `--config config/deployment/storage.ini`. Existing private JSON is supported.

## Single storage runtime

The application always uses Storage Core: choose one transactional backend (SQLite, PostgreSQL, openGauss or MariaDB), with ClickHouse required for analytical facts. The current baseline is transaction migration 021 (80 tables) and ClickHouse 004 (19 tables). An unset mode flag selects Core; explicit non-core values are rejected. DATABASE_URL and DB_HOST no longer select the Web business database. Web does not create or access legacy Session/Execution tables.

Web startup checks the Core origin, private controller file and readiness of both stores. Core startup and /v1/health verify transaction migrations and required ClickHouse tables, columns and SELECT access. This does not replace ingestion and business acceptance tests. Outbox work survives ClickHouse outages without falling back to a relational analytical store. The private Core configuration accepts max_pending_ingest_batches (per workspace, default 256, range 1–10000). New ingestion receives 429/QUEUE_LIMIT when full; retries of accepted receipts remain idempotent.

Control state, authorization, routing, revisions and publication receipts stay transactional. Trace/Span/payloads and analytical facts stay in ClickHouse. Contract-defined artifacts and durable delivery files remain supported. Legacy databases are explicit offline migration inputs only. Startup neither runs legacy Prisma db push nor migrates/deletes existing data. Generating historical Prisma DTO types at build time does not open a database.

Control mutations return committed values, including `updatedAt`, so conditional updates and receipt retries share the persisted version. An authorized record that does not match a filter produces an empty result; unauthorized reads remain denied. Static Skill evaluations and feedback read control records, while dynamic evaluations, Traces and derived issues use their typed Core interfaces. Device authentication uses the request-bound Core transport and rejects an origin change during authentication.

Dashboard and quality-analysis registration reads share the verified Core control scope. Report Traces, trajectory scores and diagnoses come exclusively from Core analytics snapshots; a missing snapshot fails explicitly. Request callbacks retain their identity scope until returned lazy queries finish. Successful Agent deletion retains the existing usage event; rejected or failed deletion is not counted.

Deployment checks cover PostgreSQL, openGauss 7.0.0-RC3 and network SQLite, each paired with ClickHouse. The original UI, server-side Trace pagination and scrolling Span batches of at most 50 are supported.


The following domain sections retain historical migration and acceptance notes. Their older version numbers describe when a feature was introduced; current deployments require transaction 021 and ClickHouse 004. They do not authorize legacy storage or optional-mode fallback. Full product regression remains in progress; focused checks are not complete acceptance.

## Isolated Docker validation

`docker-compose.storage-core.yml` runs the existing Next.js UI, the Python Storage Core, and ClickHouse in a dedicated Compose project. Separate volumes hold Web artifacts, transactional data and ClickHouse facts. Web is published on `127.0.0.1:3000` by default (AGENT_INSIGHT_PORT may override it); Core listens on loopback in the shared network namespace. This setup does not import the default database or switch production traffic.

With a running Docker daemon, run from the repository root:

```bash
export CLICKHOUSE_PASSWORD='a strong password for this isolated deployment'
docker compose -f docker-compose.storage-core.yml up -d --build
docker compose -f docker-compose.storage-core.yml ps
docker compose -f docker-compose.storage-core.yml logs --tail=100 storage-core
```

The first start explicitly initializes SQLite migrations 001–021 and ClickHouse migrations 001–004 in new volumes, then creates a private controller key and service configuration. Subsequent starts verify the existing schema and configuration without replacing data. Keep the same password for restarts; back up and use the explicit migration workflow for an upgrade or credential change. Create an isolated account through the existing `/login`, submit a test Trace through `/api/ingest/otel/v1/traces`, then check `/trace` or `/api/observe/data` and the corresponding ClickHouse facts. The legacy collector compatibility endpoint returns an acceptance result; batch receipts apply when calling Storage Core `/v1/ingest/otlp` directly. `docker compose -f docker-compose.storage-core.yml down` stops the deployment while retaining volumes; do not add `-v` when keeping acceptance data.

This Compose setup uses SQLite as its transactional backend. PostgreSQL/openGauss, full legacy migration, production capacity, and high availability need separate validation. The manual setup procedure follows.

**Product compatibility status (2026-11-14):** Login, navigation and visible markup retain the pre-refactor layout. Server compatibility now adapts existing Trace contracts to core storage. Diagnosis chat/self-Traces and Trace reports use the protocol below; Dataset versions/Trace backflow/generation use the steps below; experiment/evaluation results and DiagnosisRun consumers are integrated incrementally, with remaining Workbench/Benchmark branches documented in implementation status; this is isolated validation, not a production cutover.

The mode flag is server-only. Existing credentials must be verified and explicitly mapped to current IAM principals/workspaces. Missing mappings, revoked access and core failures fail closed without legacy Trace fallback. The runtime has no legacy single-database fallback; full business regression is still required. See the [reference](../../reference/platform/storage-core.md) and implementation status for coverage.

## Generate a large synthetic Trace

With the local standalone-login deployment running, execute:

```bash
python3 scripts/simulate-large-trace.py \
  --username 'your-test-user@example.com' \
  --web-url http://127.0.0.1:3000 \
  --core-url http://127.0.0.1:4319 \
  --state-file /absolute/path/to/private/large-trace.json
```

The script authenticates through Web and writes OTLP directly to Storage Core, waiting for each ClickHouse batch to become `indexed`. Defaults are 21,001 spans (one root and 21,000 LLM children), 500 spans per batch, and 1,024 ASCII output characters per LLM span. Outputs and token counts are synthetic; no model is called. Adjust `--spans`, `--batch-size`, and `--output-chars` within the existing 4 MiB / 4096 span request limits. Repeated outputs compress well and do not represent real model compression ratios.

Background error clustering skips repeated full LLM input history, avoiding quadratic copying for large traces. Outputs and error classification are retained; detail callers keep the default history behavior.

Reuse the same arguments and state file to resume; a new state file creates a new Trace. The state contains IDs, timestamps and progress, never credentials. Completion verifies span count and ownership and prints the original Trace page URL. Batch timing includes HTTP, transactions, indexing and polling, not just ClickHouse query latency. This prepares database test data and does not measure the Web collector compatibility layer. Test data remains available for inspection. The local 21,001-Span fixture was verified with the earlier batch size across 43 pages of at most 500 Spans with no duplicate IDs; original-layout scrolling was also checked. Endpoint success alone does not establish full product acceptance.

## Use external MariaDB

Provision a dedicated MariaDB 11.4+ database with `utf8mb4` and `utf8mb4_unicode_ci` for a fresh installation. Use `config/storage.mariadb.example.json` with the exact database name in the DSN and a reachable ClickHouse instance. Keep the connection file private and use verified TLS. The database administrator grants DML to the runtime account and table, index and trigger privileges to the migration account. Run `bash scripts/install.sh --check` and `bash scripts/install.sh --storage-only` before starting the application. Follow the [migration procedure](../../reference/platform/storage-core.md) for upgrades.

With binary logging enabled, use a DBA-approved `ROW` or `MIXED` format for migration and runtime connections. Preflight rejects `STATEMENT` with `READ COMMITTED`. When `log_bin_trust_function_creators=OFF`, a DBA account with `SUPER` runs installs or upgrades that create triggers. Keep the runtime account limited to `SELECT`, `INSERT`, `UPDATE`, and `DELETE`. The installer checks these requirements before writing its migration marker and preserves the server's binary logging and SQL mode settings.

## Initialize and provision explicit targets

Use Python3.11+, a running ClickHouse instance and dedicated absolute paths, database names and ports. These examples use SQLite; PostgreSQL, openGauss and MariaDB are alternative control backends. Existing Prisma databases cannot be initialized or upgraded as core databases.

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

New targets apply001–021, currently schema_version21. Existing known prefixes are validated without an implicit upgrade. Upgrade an existing core target explicitly after backup:

```bash
python3 -m services.storage migrate-sqlite \
  --database /absolute/path/to/isolated-core/core.db \
  --backup /absolute/path/to/isolated-core/new-before-upgrade.db
```

The backup must be a new sibling file. Relational initialization/migration requires private DSN files and external backup evidence; see the reference. Startup does not create schemas or ClickHouse databases.

Provision a new ClickHouse database with `ClickHouseStore.initialize_new_database()`, then apply `initialize_analytics_schema()`, `initialize_infra_schema()` and `initialize_semantic_usage_schema()`. In the trusted setup process, use `IAMStore.create_principal`, `set_password` and `bind_workspace` after creating the workspace. Passwords require15..1024 characters; prompt interactively rather than placing secrets in command arguments. Issue a workspace-bound write-only API credential through a temporary login session, save it in a private collector file, and revoke that setup session. The Chinese procedure includes the complete Python sequence, including creation of a separate random0600 controller-key file without printing it.

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

Next needs its own isolated runtime home and Prisma shell database. **Do not point DATABASE_URL at core.db**: startup and other application areas may still initialize the legacy shell database. `develop_start.sh` clears only `.next/dev` in the current checkout and preserves the production build in the same directory.

```bash
AGENT_INSIGHT_HOME=/absolute/path/to/isolated-web \
AGENT_INSIGHT_PORT=4320 \
AGENT_INSIGHT_BIND_HOST=127.0.0.1 \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=/absolute/path/to/isolated-core/identity-mapping.json \
AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=/absolute/path/to/isolated-core/controller-key \
bash scripts/develop_start.sh
```

Check port availability and checkout ownership first. `AGENT_INSIGHT_BIND_HOST=127.0.0.1` limits the development server to local connections; without it the script retains its existing all-interface binding. Restart Next after server configuration changes. The old public flag remains a deprecated server-side alias; frontend code does not branch on storage mode. The bridge accepts an explicit loopback origin only. Next and the storage process must share a reachable network namespace.

Keep the original `/login` and existing keys. Set `AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE` to an absolute private regular0600 JSON file containing `version:1`, the exact `core_origin`, and `bindings`. Each binding has `legacy_api_key_sha256`, `legacy_username`, `principal_id`, `workspace_id` and a private delegated `credential`. Verify the legacy account/key before provisioning; do not infer membership from matching names or payload.user. Issue the delegated API credential with read/write/execute/delete capabilities through the trusted setup session. The write-only collector key cannot serve UI reads. The Chinese guide contains a placeholder mapping example. Never commit this credential file.

## Ingest and inspect bounded pages

Collectors use workspace-bound `api_` credentials, not browser sessions. Send to `/api/ingest/otel/v1/traces` with Bearer authentication and optional `X-Workspace-Id` and `Idempotency-Key`. Load credentials securely from private files; do not put tokens in URLs or logged command arguments.

The Web entry accepts OTLP JSON/protobuf and gzip; decoded JSON is limited to4MiB/4096 completed Spans and64MiB of normalized expanded content. The loopback service receives JSON only. Default `source_namespace` is `otlp`: service.name affects display, so cross-service Spans with the same native Trace ID remain together. Explicit resource `agent_insight.source_namespace` separates integrations. Span `agent_insight.revision` defaults to1; changed content at the same source revision fails rather than overwriting history.

Successful OTLP responses remain an empty JSON object or protobuf body. `X-Storage-Batch-Id` and `X-Storage-State` identify the durable receipt. Accepted means the private packet was fsynced and the control transaction committed. Poll `/v1/batches/<id>?workspace_id=default`; write-only collectors can inspect their own receipts. Only indexed means all sinks completed.

The original `/trace` retains existing DTOs, filters, tags and detail controls. Trace records are requested by page. Opening a detail requests at most 50 lightweight Spans; scrolling near the end appends the next batch. The loading indicator shows only “Loading…”. It does not read ordinary OTLP payloads during structure loading. Selecting a Span loads its fixed interaction index and exact payload revision, using at most4 chunks per section page.

Trace bundles retain v1 format and execution trees. Imports accept at most50MiB/500 executions, validate the entire tree first, remap colliding IDs and nested references, and return success only after all batches are indexed. Reuse an Idempotency-Key only to resume the same import. Export/full-session responses are capped at128MiB. Existing Langfuse views consume full nodes directly, so that compatibility path restores full bodies and is excluded from ordinary OTLP lazy-loading claims.

Observation batches preserve workspace/Trace order; retries do not block independent Traces. Each batch allows five executions. A terminal predecessor failure marks dependent batches DEPENDENCY_FAILED; recover them in order after the predecessor indexes successfully. Dataset and Experiment delivery policies are unchanged. Payload writes batch at most128 Spans and4MiB per HTTP request, persisting chunks before manifests, then Span rows and Trace summaries. Retry reuses frozen versions. Thousand-collector mixed load, sharded logs, HA and browser acceptance require their own evidence; consult the current implementation status. Stop only the services started for this environment and preserve the databases, artifacts and private configuration.

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

Version one is limited to preserving existing features, UI, workflows, statistics and data. Large Traces now load in batches of at most 50 Spans; watermarked snapshots and thousand-collector capacity remain unverified.


Validate Skill and Agent dynamic reads through the original `/skills` and `/agents` pages: list statistics, version trends and full execution output, including empty results, zero values and historical executions without Sessions. Keep existing static configuration and registrations; dynamic statistics use authorized core storage. A legacy login mapped to a different canonical IAM username must still discover only its own Agents. Skill runs/logs, Agent deletion and asset/configuration writes are outside this slice, these historical slice results do not constitute full acceptance; the current runtime refuses legacy control database access.


## Acceptance after019 control integration

Explicitly upgrade the isolated target to019, then use the original login and screens. The request wrapper transports the current existing API key for control APIs; a body/query username alone is not authentication. SDK, collector and device credentials keep their respective protocols. Missing configuration or authorization fails explicitly without reading the old transactional database as a fallback. Standalone, organization and IDaaS login and masked-settings restoration retain their original rules without new login UI.

Skill versions/files, configuration, clients, Workbench/optimization/generator sessions and debug results now use the control repository. Consolidated acceptance must cover list/detail/file/save, installation/heartbeat/command ACK/configuration and deployment receipts, session SSE/candidate/retest/publish, and Agent deletion with Trace/diagnosis source lifecycle. Four TSX files only add transport imports, with dynamic runtime headers; visible layout, wording, interactions and existing features remain unchanged. Focused checks and types are not full acceptance.

Keep the original database and files. Import historical records explicitly under their real owner. HISTORY_FENCE_VERSION=1 permits inert historical records while preserving running/pending values; old tasks, installation tokens and device credentials never regain execution or authentication rights. Unresolved owners, missing files and source/target conflicts still block import. Do not disguise them as deleted or completed. Production remains unchanged.


### No extra background mapping for native users

Create the native User and configure its personal model in the original screens. Background work restores the durable User and its actual current API credential after restart without a handwritten identity file. Migrated wi credentials still use the existing private mapping; malformed or ambiguous mappings are never guessed or silently replaced. Keep the existing private core controller file configured; no browser key-disclosure workaround is required.

The uploader still needs write only. Background analysis separately checks the same owner's current execute capability. Readonly, revoked or expired credentials and administrators merely viewing another user's Trace cannot use that user's model. Validate this workflow in isolated state; the original UI and production data remain unchanged.


## Isolated020 acceptance and explicit legacy import

The current isolated target uses transactional schema021 and CH004. Keep new-database initialization separate from backed-up upgrades of existing targets. Never run Prisma db push against the original business database. Use the original login and pages; default-project ownership adds no project-selection UI.

Export a consistent legacy SQLite copy with export-legacy, then use the separate plan-legacy-import, apply-legacy-import and verify-legacy-import commands. Specify the private export directory, stable source ID, owner bindings and isolated target config explicitly; apply/verify also require current actor credentials and a migration ID. The original plan-legacy remains strict read-only inventory and has no apply operation.

Resolve owner, file and source/target conflicts first. Retry apply using the same receipt to recover pending work, then wait for actual CH indexing before verify. Durable acceptance with pending facts is not completed migration. A subsequent apply should replay without new imports. Check unchanged source bytes/content, readable original history states and zero execution commands. The47-row rehearsal covers those fixtures only and does not replace customer-wide preflight. No production cutover is performed.

### On-demand Trace loading

`/trace` retains its original table, statistics, filters and pagination controls. The default timestamp-sorted list uses ClickHouse LIMIT/OFFSET and enriches only the selected page; complex filters still use the existing compatibility query. Statistics load separately.

Core detail returns up to 50 Span structures on opening and appends up to 50 per batch when scrolling to the loaded end. When the tree is too short to scroll, choose **Show more calls**. The original tree and detail panel remain. While a request is pending, only “Loading…” is shown; the indicator disappears afterwards, without loaded/total counts. Node metrics describe loaded spans. Signed cursors bind permissions, Trace and revision. A changed revision requires refresh (409). Payload reads select Span ID directly. Small legacy-format Traces retain their original server-side conversion and are returned in batches.

Earlier validation at 500 spans per batch covered 21,001 spans in 43 pages without duplicates or omissions, plus Chrome scrolling to 1,500 spans in the original tree. Global search, full analysis and very large complex legacy sources still require further validation.

## Configure external databases and install

Users provision and operate their databases before installing the application. Installation/start/stop manages Core and Web only. SQLite is a file, not a server. Storage always pairs one transactional backend with required ClickHouse.

Copy `config/storage.postgresql.example.json` or `config/storage.sqlite.example.json` to `config/storage.local.json`, set mode 0600, and replace every `YOUR_*` placeholder. Run `bash scripts/install.sh --check` for read-only validation, then `bash scripts/install.sh` to initialize new application tables and start production Core/Web. Use `--storage-only` for initialization without starting applications, and `--config FILE` for an isolated instance. `deploy_server.sh --apply` is a compatibility alias.

Required SQLite field: `control.database`. Required PostgreSQL/openGauss fields: `control.dsn`, `control.schema` (isolated, not public/system), `control.artifacts`. Both require `control.backend` and ClickHouse `endpoint`, `database`, `user`, `password`. An empty password must be explicit. ClickHouse timeout defaults to 15 seconds (1–60); PG connect_timeout defaults to 10 (1–60). Optional runtime home/corePort/webPort default to `~/.agent-insight`/4319/3000. Relative filesystem paths resolve against the project root; `~/` expands to the current user's home. SQLite artifacts are adjacent to its database.

Create the PG and ClickHouse databases and accounts first. Initialization needs schema/table CREATE privileges and application data read/write privileges; normal runtime does not need CREATE. The PG example uses verify-full TLS with an explicit CA path; percent-encode special characters in credentials. Use sslmode=disable only for deliberately isolated local tests. HTTPS ClickHouse uses system trust or SSL_CERT_FILE. Container localhost refers to the container, not its host. Use the externally mapped port when Core runs natively. Minimum gates: PostgreSQL 16 and ClickHouse 26.8, followed by actual schema checks. openGauss remains supported but not real-service tested in this change.

Python 3.11+ is required; the pinned relational driver needs 3.11–3.13. Set AGENT_INSIGHT_STORAGE_PYTHON to an existing compatible environment when needed. The installer never changes system Python. Missing or unknown fields and placeholders fail before connections. --check does not create runtime directories or databases and requires installed Python dependencies. Private config is excluded from Git, npm, Docker and standalone bundles. Credentials are not printed.

Use start.sh for production, develop_start.sh for development, status.sh for status, stop.sh for Core/Web shutdown. Database services stay running. Repeat installation preserves records and secrets. Partial first-time initialization resumes from an identity-bound intent; legacy/unknown/outdated stores require explicit backed-up migration. Existing formerly managed ClickHouse data and processes are preserved and must be managed separately. See the [complete Chinese field guide](../../../zh/how-to/platform/storage-core.md#配置数据库并一键安装).

## Optional independent database containers

With Docker running and Compose installed, execute `bash scripts/start_postgresql.sh`, then `bash scripts/start_clickhouse.sh`, then `bash scripts/install.sh`. Database scripts create a private project storage.local.json with random passwords only if absent; existing config is never overwritten. Defaults: PostgreSQL 16 at loopback 15432, ClickHouse 26.8 at loopback 18123, application home ~/.agent-insight-postgresql, Core/Web 4319/3000. Named volumes persist across restarts. Lost configuration with existing volumes blocks password regeneration. Existing remote databases should skip these scripts.

Use each database script with --stop to stop only its service while retaining volumes. stop.sh stops Core/Web only. All commands accept --config FILE. The application runs natively in this workflow; the older full-container Compose fixture still uses SQLite/ClickHouse.

## Trace list connection and query reuse

PostgreSQL Storage Core uses a process-wide connection pool by default. Requests borrow a connection and return it after each transaction. Browser logout does not close shared connections or revoke API keys used by other clients. Reads retain `REPEATABLE READ READ ONLY`; broken connections are discarded and replaced on demand. SQLite, openGauss, and ClickHouse HTTP transport retain their existing connection behavior.

Ordinary Trace lists enrich only the current database page in batches. Ordinary statistics and framework/source/Agent options use database aggregation. Outcome overrides, historical sources, advanced filters, and fields without equivalent SQL semantics explicitly fall back to compatibility reads, which may still scan records. Root Span attributes are read when execution metadata is needed; child Spans are not loaded in full. Detail pages continue to return at most 50 structural Spans per batch.

Set `control.connection_pool.enabled=false` or `trace_list_optimization.enabled=false` in the existing Core configuration and restart to disable either optimization independently. No data reload is needed. The default pool limit is 16 connections per runtime, with an idle retention baseline of 2; account for all instances when budgeting database connections.


<a id="recover-ingest"></a>
## Recover a failed ingestion batch

Fix the underlying sink/artifact failure first and inspect the batch receipt. Automatic execution is limited to five attempts; ordinary duplicate uploads never reopen failed batches. Run the local operator command with the existing private Core configuration and a private (0600, non-symlink) file containing a currently valid write credential:

```bash
python3 -m services.storage recover-ingest \
  --config /private/core.json \
  --credential-file /private/ingest-token.txt \
  --workspace example-workspace \
  --batch example-batch \
  --request-key example-recovery-1
```

The actor must have current write access to the workspace and every affected Trace. Recovery records the previous failure, starts a new five-attempt cycle and reuses the packet/frozen plan. The same recovery key replays idempotently; another key cannot reset an active batch. Existing transaction coordination and monotonic worker tokens prevent an old worker from completing the new cycle.

Recover `DEPENDENCY_FAILED` successors in order after predecessors become indexed. Deleted/deleting Traces and historical batches with an already prepared successor are rejected. Invalid input remains invalid; recovery neither edits packets nor bypasses validation. Recovery uses the existing pending-queue capacity. Check final batch status: a successful command means scheduled, not indexed.

Apply transaction migration 021 for SQLite, PostgreSQL or openGauss; ClickHouse remains 004. Stop writes and back up the transactional database and artifacts before explicit migration. Older programs reject 021. Rollback requires stopping the service, restoring paired backups and accounting for subsequent data; do not merely downgrade binaries or reset attempt counters. See the [capacity and receipt reference](../../reference/platform/storage-core.md#core-request-capacity-and-ingest-retries-021).
