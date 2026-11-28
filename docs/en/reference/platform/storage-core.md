---
title: "Storage core, IAM and safe migrations"
description: "SQLite, PostgreSQL, openGauss and MariaDB control storage, authorized ClickHouse access and legacy exports."
---

# Storage core, IAM and safe migrations

## Single storage runtime

The application always uses Storage Core: choose one transactional backend (SQLite, PostgreSQL, openGauss or MariaDB), with ClickHouse required for analytical facts. The current baseline is transaction migration 021 (80 tables) and ClickHouse 004 (19 tables). An unset mode flag selects Core; explicit non-core values are rejected. DATABASE_URL and DB_HOST no longer select the Web business database. Web does not create or access legacy Session/Execution tables.

Web startup checks the Core origin, private controller file and readiness of both stores. Core startup and /v1/health verify transaction migrations and required ClickHouse tables, columns and SELECT access. This does not replace ingestion and business acceptance tests. Outbox work survives ClickHouse outages without falling back to a relational analytical store. The private Core configuration accepts max_pending_ingest_batches (per workspace, default 256, range 1–10000). New ingestion receives 429/QUEUE_LIMIT when full; retries of accepted receipts remain idempotent.

Control state, authorization, routing, revisions and publication receipts stay transactional. Trace/Span/payloads and analytical facts stay in ClickHouse. Contract-defined artifacts and durable delivery files remain supported. Legacy databases are explicit offline migration inputs only. Startup neither runs legacy Prisma db push nor migrates/deletes existing data. Generating historical Prisma DTO types at build time does not open a database.

Control mutations return committed values, including `updatedAt`, so conditional updates and receipt retries share the persisted version. An authorized record that does not match a filter produces an empty result; unauthorized reads remain denied. Static Skill evaluations and feedback read control records, while dynamic evaluations, Traces and derived issues use their typed Core interfaces. Device authentication uses the request-bound Core transport and rejects an origin change during authentication.

Dashboard and quality-analysis registration reads share the verified Core control scope. Report Traces, trajectory scores and diagnoses come exclusively from Core analytics snapshots; a missing snapshot fails explicitly. Request callbacks retain their identity scope until returned lazy queries finish. Successful Agent deletion retains the existing usage event; rejected or failed deletion is not counted.

This implementation run validates SQLite + ClickHouse only. PostgreSQL/openGauss remain supported but are not exercised against real servers in this run. The original UI, server-side Trace pagination and scrolling Span batches of at most 50 are supported.


The following domain sections retain historical migration and acceptance notes. Their older version numbers describe when a feature was introduced; current deployments require transaction 021 and ClickHouse 004. They do not authorize legacy storage or optional-mode fallback. Full product regression remains in progress; focused checks are not complete acceptance.

**Product compatibility status (2026-11-14):** The original frontend is restored, with server compatibility for existing Trace contracts. Complete domain migration and regressions remain unfinished. This is isolated validation, not a production cutover.

`services/storage/` is a Python 3.11+ foundation. SQLite, IAM and ClickHouse use the standard library; relational servers use an explicit DB-API connection factory. Next always uses Core while retaining the original login and screens; offline commands do not switch a running application. See the [isolated setup guide](../../how-to/platform/storage-core.md).

See the [table relationship guide](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序) for all96 table purposes, primary/unique/query keys and overview/relationship diagrams. It distinguishes database foreign keys from logical references across databases. The diagrams and full dictionary are maintained in Chinese.

## Implemented contracts

`001_core.sql` remains byte-for-byte unchanged:21 transactional and13 ClickHouse tables. `002_iam.sql` adds10 IAM tables, 003 adds2 project-directory/binding tables 004 adds2 ingestion/entity-version tables and005 adds4 Trace identity/annotation/tag tables, 006 adds2 diagnosis conversation/message tables and007 adds2 report-run/head tables, 008 adds2 Dataset head/operation tables and009 adds1 generation-job table. Migrations010–012 add8 experiment,2 diagnosis-binding and5 Benchmark tables;013 preserves empty artifacts without new tables and014 adds1 issue-resolution table. Migration015 adds3 analytics indexes,016 adds1 first-preparation receipt table,017 adds3 Thread control tables, andCH002 adds2 analytics fact tables, for **69 transactional +15 ClickHouse =84**. The complete field/type/constraint/index dictionary is in `design/platform/analytical-transactional-storage/core-table-dictionary.md`.

All three transactional backends share immutable releases/dependencies, draft/alias CAS, frozen RunPlan inputs, task leases/fences/cancellation, artifact verification and atomic result receipt/Outbox writes. ClickHouse supports trusted canonical Span batches, latest-state filtering, single-Span and paginated structure reads, exact-revision payload bundles with chunk/manifest hashes, and bounded analytics. Requests are capped at4MiB; payload bundles at64MiB.

The004 observation materializer rejects changed content at the same source revision, ignores older revisions and replays a frozen plan after partial writes. Durable local acceptance and ordered observation Outbox delivery are implemented. Sharded durable logs, fixed snapshots, complete evaluation materialization and production cutover remain future work.

### Default project reservation

003 adds `projects` and `project_workspaces`. Existing workspace IDs, business rows, IAM bindings and CH keys remain unchanged; each workspace maps to `default`. New workspace creation and the default mapping commit together. A shared default project grants no additional access across users or workspaces.

`AuthorizedStorage(iam, facts)` defaults to `default`; an explicit `project_id='default'` is accepted. Empty/blank/other selectors fail closed. `project_context(credential, workspace_id)` returns an immutable context after workspace authorization. Scopes, list/analytics envelopes and cache fingerprints include the project; individual CH rows keep their existing workspace keys.

New targets apply001–021. Existing001/002/003 prefixes are validated without implicit upgrades. IAM/project contexts require003; current startup requires020 (basic Trace007, Dataset008, generation009, experiments010, DiagnosisRun011, Benchmark013, issue resolution014, analytics015, private preparation016 and collector graphs017) after explicit migration. Project UI, invitations and project-owner administration are future work. The Web runtime always uses Core; existing production data is not migrated by this setting.

### IAM and authorization

`IAMStore` provisioning methods (including account/password/group/workspace setup and names containing `for_provisioning`) are trusted administrative ports, not unauthenticated Web endpoints. Principals use stable IDs. Login names undergo NFKC/trim/casefold and then require1..128 ASCII login characters. Passwords require15..1024 characters and use PBKDF2-HMAC-SHA256 with600000 iterations and independent32-byte salts, following the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Sessions and API credentials contain random secrets, stored only as hashes. Sessions last at most24h; API credentials at most365 days and bind one workspace and explicit capabilities. Password changes/account disablement invalidate auth versions. Leaving a group permanently revokes its existing API credentials; rejoining does not revive them. IAM password/API protocols remain available internally; the product keeps its existing login page. Legacy keys are verified through existing authentication before explicit private mapping to current IAM credentials. Matching usernames cannot create identity bindings. Complete identity migration, recovery and distributed rate limits remain future work.

`AuthorizedStorage` validates a credential and derives the scope server-side. Client workspace selection cannot grant access; empty scopes deny. Group owners/admins can read all business resources in their group's workspaces. Members read their own or explicitly shared resources. Deleting owned resources requires the independent delete capability; viewers cannot write. Shared read access does not grant edit rights. Credential secrets and private evaluation gold stay outside ordinary business reads.

Trace/asset/run/snapshot/artifact roots have explicit ownership and sharing records. Spans and payloads inherit Trace authorization. New Trace routes and ownership records commit atomically. Future domain writers must establish ownership in the same business transaction. Metadata lists, single IDs, payloads, bounded downloads and analytics use the same policy. Unapproved artifact namespaces, including private gold, are excluded.

Slow ClickHouse reads happen outside control write transactions and revalidate access before returning. Scope fingerprints include principal/credential restrictions, group policy revisions, membership etags and workspace binding revisions; cache keys must include the current fingerprint and query. Non-active Traces are excluded from normal metadata and payload reads. Analytics applies the authoritative control-plane deletion barrier before CH catches up; scope changes during a query reject the result.

Members currently supply1..1000 authorized Trace roots per selected workspace for analytics; administrators may query a bounded workspace set. The query limit is4096 bound parameters and1000 deletion-barrier roots per workspace; larger scopes fail closed and require a narrower range. Large ACL/deletion dictionaries and streaming artifact ports are future extensions.

### Drivers and concurrency

SQLite uses `BEGIN IMMEDIATE`. PostgreSQL and openGauss business writers take a compatible `ROW SHARE` schema guard. Migrations acquire `EXCLUSIVE` before verifying backup evidence. The same connection holds transaction-scoped resource locks, including for identities that do not yet exist. Independent datasets can commit concurrently. Competing saves recheck the revision and operation receipt. Ordinary experiments coordinate on experiment ID. Benchmark checks admission within the workspace. Queue claims, bulk operations and historical import can still wait within their respective domains. Relational read-only transactions use `REPEATABLE READ READ ONLY`.

Declare write keys with `control.transaction((domain, workspace, resource_id))` before reading mutable state. Supply multiple keys together so the adapter acquires them in a consistent order. Writers share the ancestor keys, allowing a whole-workspace replacement to exclude concurrent changes to members of that domain. If an identity needs a lookup, resolve its stable identifier, acquire it with `control.lock_keys` on the same connection, then read the current revision, authorization or lease again. Read-only lists and details use `read_transaction()`. Cross-store projections replay stable events and versions.

The pinned optional PostgreSQL test driver is in `services/storage/requirements-relational.txt`. openGauss requires a driver/libpq matching the deployment version: protocol compatibility does not imply authentication compatibility. Actual tests cover PostgreSQL15.19 and openGauss7.0.0 in PG compatibility mode. Native openGauss SHA256 authentication was tested with the official Linux ARM64 Python bundle; the ordinary macOS psycopg2-binary wheel failed that handshake. An isolated MD5 fixture was only supplementary, not a production recommendation. Inject the validated driver through `OpenGaussControlStore(connection_factory, schema=..., artifact_directory=...)`; `from_dsn` imports the environment's psycopg2.

## Initialization and migrations

Every target is explicit; no command defaults to an existing application database. Replace these paths with isolated targets and create parent directories first.

```bash
python3 -m services.storage schema --backend sqlite
python3 -m services.storage schema --backend postgresql --version 5
python3 -m services.storage schema --backend opengauss --version 5
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/core.db
python3 -m services.storage migrate-sqlite --database /absolute/path/to/core.db --backup /absolute/path/to/new-backup.db
```

`schema` only prints DDL. New targets apply001–014; existing known001/002/003 prefixes are validated without implicit upgrades. IAM/project contexts require003 and basic Trace HTTP requires007, Dataset008 and generation009, all through explicit migration. Unknown versions, history gaps and checksum drift fail closed. Existing Prisma databases are not altered in place.

SQLite migration creates a new private sibling backup, verifies integrity/FKs/hash, then acquires the writer lock and compares source/backup content again. An intervening write causes refusal; the backup remains. Pending DDL and markers commit or roll back together. Backups are never overwritten and old data is not removed. New SQLite targets use WAL/FULL and must not be shared across hosts over NFS.

Relational commands are `init-relational`, `migration-plan`, `source-evidence` and `migrate-relational`. They require `--backend postgresql|opengauss --dsn-file /private/connection.txt --schema isolated_schema --artifacts /private/artifacts`. DSN files must be private regular files; keep secrets out of command arguments. Migrations additionally require `--backup-manifest` containing the dump hash, source identity/history/content evidence and operator/write-barrier attestations after a real external backup and restore exercise. `source_evidence()` produces the consistent source evidence; migration compares it under the write barrier. The tool does not automatically prove an external dump is restorable: an empty file or a boolean flag is not a substitute for a backup.

For MariaDB, use `--backend mariadb --dsn-file /private/mariadb.dsn --artifacts /private/artifacts`. The DSN path specifies the existing dedicated database. Use its database name in the backup manifest's `schema` field. MariaDB DDL commits implicitly, so a persisted migration marker fences application traffic until every migration completes. If an upgrade fails, restore the verified backup before retrying. The application inherits the server's SQL mode. Verify the full configured mode in the migration and runtime sessions and run a business write/read check on the target release.

See the [MariaDB installation guide](../../how-to/platform/storage-core.md#use-external-mariadb) for trigger privileges and binary logging requirements. Migration 021 backfills delivery records and Trace associations for existing ingestion batches and retains the batches and their outbox events.

## Trace ingestion and bounded HTTP contracts

`ObservationIngest(control,facts)` exposes durable `accept`, fenced `work_once` and current-authorized `batch_status`. A complete packet is validated before locator writes; its private artifact is fsynced before one transaction registers routes, private ACLs, batch and Outbox. Receipt keys are workspace/principal scoped; reused keys with changed packets conflict. Accepted is distinct from indexed; write-only collectors may inspect their own receipts.

| Boundary | Current contract |
|---|---|
| Input | Completed OTLP Spans;4MiB JSON,4096 Spans and64MiB normalized expansion budget |
| Web protocol | JSON/protobuf/gzip through `/api/ingest/otel/v1/traces`; loopback backend receives JSON and API credentials |
| Identity | Default namespace `otlp`; service.name affects display only; cross-service native Trace IDs aggregate; explicit `agent_insight.source_namespace` isolates sources |
| Revision | Span `agent_insight.revision` defaults to1; stale ignored, same-version changed content quarantined; internal revisions allocated separately |
| Queue | Claim the earliest eligible batch after checking its Trace predecessors. Independent Traces can progress during another batch’s lease or retry delay. |
| Payload | At most128 Spans per bulk,4MiB per HTTP request; chunks up to256KiB and bundles up to64MiB; all chunks before manifests |
| Completion | Freeze heads/plan first, then payload→Span→summary; replay exact versions; indexed/sent only after every sink and valid fence |
| Summary | Delta counters, nullable unknown token totals and coverage; done/failed/running/unknown states |
| Pages | Trace default50/max200; Span default/max200; payload default/max4 chunks at the exact revision |

Trusted CH kernel reads still allow1000 structure rows or32 chunks; HTTP/UI impose the smaller limits above. Missing sections return available=false. Trace lists scan at most2000 authorized candidates, bind signed cursors to scope/filters and do not invent a global total.

`python3 -m services.storage.trace_service --config /private/trace-service.json` requires a private regular mode0600 JSON file. Control fields are sqlite(database), or postgresql/opengauss(dsn/schema/artifacts), or mariadb(dsn/artifacts). ClickHouse fields are endpoint/database/user/password, plus cursor_secret_hex, controller_key_file, default_workspace, port and worker_enabled. Initialize/migrate control and CH explicitly beforehand: startup does not create tables or upgrade schemas. The service binds127.0.0.1 with32 concurrent request slots and503 overload rejection.

Set server-only `AGENT_INSIGHT_TRACE_STORAGE=core`, `AGENT_INSIGHT_STORAGE_CORE_URL` and `AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE`; restart Next after changes. The old public flag is a deprecated server alias only. DATABASE_URL is not used for Web runtime storage; configure the transactional backend in the private Core configuration. Original frontend login/key behavior is unchanged. The0600 mapping binds a verified legacy key hash/name to a current IAM principal, workspace and read/write/execute/delete delegated credential. Errors do not fall back to legacy Trace reads; the runtime does not retain a legacy single-database path.

### Existing contracts and005

Four control tables hold immutable legacy IDs, versioned annotation overrides (including explicit nulls), owned tags and Trace/tag links. All use current authorization/deletion barriers. Migrations001–004 remain unchanged. Native OTLP aliases commit with new Trace acceptance; existing routes need explicit backfill.

Compatibility retains existing observe/data, observe/session, tags, execution tags and Trace bundle endpoints. List records/statistics/filter contracts are preserved. Exact taskId, executionId or nonempty taskIds requests first resolve legacy aliases/internal IDs under current IAM, intersect their selections and materialize only those Traces, retaining source/current Outcome/authorization/deletion postflight checks. Missing or unauthorized selections return an empty set while invalid filter parameters still fail; global skills/values/tags facets retain their original scope. Ordinary lists still enumerate authorized roots, capped at100000; general indexed filtering and thousand-collector capacity remain unverified. The detail view requests up to 50 lightweight Spans per page and appends subsequent pages on scrolling. Ordinary OTLP structure requests omit payload bodies. The legacy compatibility path reconstructs the original structure before returning each page. Full-session compatibility APIs retain their independent budgets. Selection loads one fixed interaction index at its exact payload revision. Full sessions and exports cap at128MiB; legacy Langfuse nodes retain their bodies within each returned page.

Bundle v1 imports cap at50MiB/500 executions, preflight the tree, remap IDs/references and return success only after indexing all batches. A receipt can resume the same input. Metadata edits do not rewrite source payloads. Result editing still requires the evaluation handoff and currently reports conflict. Trace backflow, ordinary experiment/result/RunPlan consumers and DiagnosisRun consumers use the new storage protocols below. Infra and non-OTLP external writers still have unported paths; restoring screens does not establish full feature migration.


Capacity at a thousand concurrent clients requires a workload test with representative packet sizes, Trace distribution and read traffic.

## Legacy migration inputs

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

A single read-only SQLite snapshot includes committed WAL data. Integrity/FK failures block export without repair. Outputs contain original values, including secrets; directories use0700 and files0600, and existing destinations are refused. CLI summaries omit original rows, schema SQL and defaults.

Typed JSONL preserves physical columns, duplicate rows and SQLite types. Manifests bind counts, byte hashes and content roots. Incomplete, truncated, altered, extra/missing files, symlinks and traversal fail verification. Hashes prove internal consistency, not signed provenance. Large exports scan tables; use a maintenance window or consistent backup.

Legacy users map to stable principals; no default passwords are generated. Groups/roles/resource ownership require explicit mappings rather than usernames or email domains. Unbound workspaces and unmapped resources remain closed to ordinary members. The Trace-specific `import_legacy_traces` now converts verified Session/Execution allowlisted fields using explicit user→credential/workspace bindings. Dry-run is the default; unsupported fields and quarantine are reported, and partial/uncertain sends replay the same source/export/receipt keys. It does not migrate credentials, infer group membership, complete all96 models, capture online changes or perform production cutover.


### Read-only semantic planning (no import)

`migration-plan` checks core DDL upgrades. Use the separate command for legacy data:

```bash
python3 -m services.storage plan-legacy \
  --database /absolute/path/to/isolated-legacy.db \
  --source-id stable-source-name \
  --bindings-file /private/owner-bindings.json
```

Only explicit SQLite `--database` input is supported; export-directory and destination inputs are not implemented. The owner mapping file must be a bounded (1MiB), regular non-symlink mode0600 file such as `{"legacy-alice":{"principal_id":"principal-a","workspace_id":"workspace-a"}}`. Credentials are rejected; matching names never merge accounts automatically. Mappings declare target IDs and do not validate their existence or live authorization against a destination.

The versioned catalog covers 96 models and 1250 physical columns, including Prisma aliases. Reports contain structure, counts, disposition and hashes, not row values. Checks cover unknown/missing columns, type/key/FK drift, actual and explicitly cataloged logical references, ownership ambiguity and normalized IAM login collisions. `sourceExecutionId` is a framework-native identity, checked for composite-key ambiguity rather than treated as an Execution foreign key. JSON remains private pending transformation; nested business references are not comprehensively checked.

Defaults are 100000 rows, 64MiB raw row bytes, 8MiB per row, 512 tables, 256 columns per table, 256 issue details, 15 seconds and a SQLite VM-step budget. CLI overrides are `--max-rows/--max-bytes/--max-issues/--max-seconds` (time capped at120s). Raw-byte limits are not RSS limits; checks at SQL/loop boundaries do not preempt every individual hash operation. An expired final analysis is incomplete. An incomplete snapshot does not infer semantic orphans from unscanned parents and has no complete content fingerprint. Data is captured in one read-only transaction including committed WAL.

Every result remains `planning-only`, `blocked` and `full_migration_ready=false`: no target connection, copying or apply. Exit0 means the diagnostic command ran, never migration readiness. Limited Trace candidates are not complete row conversions. Fingerprints use `legacy-plan-typed-row-multiset/v1` and are not interchangeable with export hashes. Source identity stays stable; content/catalog/mapping hashes bind this plan. Existing inspect/export/verify behavior is unchanged, including rejection of FK violations. See the [implementation design](../../../../design/platform/analytical-transactional-storage/phase7-consumers-and-legacy-migration.md) for dependencies.

## Verification boundaries

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

`STORAGE_TEST_PG_CONTAINER` enables psql DDL tests; `STORAGE_PG_DSN` enables PG control contracts; `STORAGE_TEST_PG_CONFIG` and `STORAGE_TEST_OPENGAUSS_CONFIG` point to private JSON files containing `dsn`; `STORAGE_TEST_CLICKHOUSE_URL` selects a test CH instance. `STORAGE_OBSERVATIONS_PG_CONFIG` enables ingestion contracts with a private PG JSON connection file (dsn or kwargs). Native openGauss requires the matching Linux/Python driver environment. Missing variables explicitly skip the corresponding tests.

Tests create/drop random schemas/databases and must target isolated instances. They cover safe migration/rollback, current IAM authorization, real transactions and10,000-Span workflows, not HA, production migration, thousand-client capacity or browser acceptance. Latest counts and engine evidence are in `design/platform/analytical-transactional-storage/implementation-status.md`; the [Chinese reference](../../../zh/reference/platform/storage-core.md) is authoritative.

### Complete Trace evidence for evaluation and diagnosis

The private `/v1/compat/observe/evidence` endpoint and server-only `readTraceEvidence` capture current scope, aliases/owner, route incarnation, annotation and complete Span/Trace head vectors. They verify CH sets/revisions and payload hashes, then revalidate boundaries. Prepared heads do not imply CH readiness. Concurrent changes return409, lag/missing/corrupt evidence503, and16MiB/100000-Span limits413. Reads never truncate or fall back to empty legacy trajectories; invalid UTF-8 is rejected.

The existing core trace-drafts route keeps its DTO, normalization and warnings. Drafts can be saved through the integrated backflow to versioned Datasets. Experiment execution, DiagnosisRun, retest and result consumers use the typed protocols below; diagnosis SSE/Trace reports use their separate protocol. Manifests exclude credentials/absolute paths. Next retains existing JS Number semantics; exact large integers should be supplied as strings. Diagnosis must retain its own execution Trace recorder when migrated.


### Diagnosis conversations, Agent traces and reports

Migrations006/007 append conversations/messages and diagnostic report runs/heads. Original pages, login and SSE events stay unchanged. The existing Next/OpenCode runner continues to execute the Agent. Verified caller identity selects model configuration; request `user`/`executionBrief` cannot select another account or its credentials.

Text is checkpointed before SSE delivery. `done` requires both the terminal chat transaction and all self-Trace batches to be indexed. The core validates the receipt against actual actor/workspace/provider task/parent Trace/conversation/request and batch identities. Repeated provider snapshots preserve stable message/tool identities and revisions; successful, failed and interrupted runs retain full provider messages and tools. Failed delivery retries the same durable plan. Short ambiguous HTTP failures retry identical bodies without running another model.

A conversation has one fenced lease. Revocation, deletion, expiry or stale fences reject updates and abort execution. Limits: user1MiB, assistant8MiB, history16MiB/10000 messages, pending stream64 entries/16MiB. Exact revision/fence/sequence values use decimal strings. `sessionId:null` creates a new upstream conversation. Known upstream IDs can be continued by the original actor; group admins may read authorized history and start their own conversation, but cannot reuse another user's OpenCode session or credentials.

AgentDebug and SkillsAnalysis retain the existing generators, with frozen complete TraceEvidence, durable progress, immutable report artifacts and fenced publication. Force/delete prevents stale jobs from replacing the current report. Reads recheck live Trace authorization and never fall back to an old Prisma report. Evaluation DiagnosisRun/experiment/retest workflows use the consumer protocols below. Legacy history import, production cutover and thousand-client capacity certification remain separate work.

Existing Skill deployment routes use typed DiagnosisRun and TraceEvidence to bind the actor-owned source, client and unique opaque Skill origin without legacy dynamic Trace reads. Source checks run before and after precheck and before WSS dispatch. Durable command enqueue is the pollable authorization boundary: a failed post-enqueue pre-dispatch check marks delivery failed and rejects artifact claims, while in-flight or already claimed commands cannot be atomically recalled across databases. Isolated simulated-device acceptance covers the real storage, command and receipt chain, not installation on a real client.

The existing API transport now attaches its existing Key to same-origin diagnosis requests. Login/logout/account switching and all page sources remain unchanged; no additional cookies or browser sessions are introduced.

Structure reads retain tool skeletons and the existing Task/Skill linkage allowlist; bodies remain deferred. Compact metadata is limited to2KiB per tool (or per tool array without carriers); oversized structure returns413 while complete source payloads remain available. Replaying the same source revision does not rewrite old projections. Older Task/Skill linkage projections require an explicit rebuild; full reads preserve the original source.


### Dataset versions, Trace backflow and generation (008/009)

Existing Dataset CRUD, backflow and generation routes now use core storage. Visible JSX and wording are retained; components capture the ETag when an edit draft opens and pass it as If-Match. Consumers not wrapped in a trusted core Dataset context, including remaining experiment/evaluation workflows, fail with503 instead of reading legacy tables.

`dataset_compat_heads` holds current release/revision and lifecycle; actor/workspace/operation-bound `dataset_operation_receipts` preserves exact retry responses. Cases and extension fields use immutable releases and hash artifacts, preserving Unicode keys, finite decimals and false. Execution inputs are separated from private gold/trajectory; current gold permission is required for authoring readback. Private root-cause caches do not advance releases.

- Reads return ETags; missing mutation baselines return428 and stale baselines409. Historical ETags cannot overwrite the current head. `?view=versions` returns summaries, `?version=1` a historical body, `?view=case&caseId=...` one full case, and `?view=items` previews. Draft baselines are never replaced by a global latest-version cache.
- Writes seal private releases. Exact operation retries preserve the original result. Backflow captures and rechecks source access/hashes, retries bounded append conflicts and deduplicates; duplicate-only requests create no version. Soft deletion fences old workers.
- Lists allow2000 Datasets, history1000 releases and64MiB aggregate responses.600-character previews do not truncate source artifacts. Generic artifact endpoints do not expose Dataset gold/cache namespaces.
- Release and Outbox publication are atomic. The worker writes `dataset_samples` before `dataset_release_members` with frozen retry versions. Durable acceptance and confirmed CH indexing are distinct states.

`dataset_generation_jobs` binds the real actor, frozen source/config/progress artifacts,30-second leases, epoch fences and terminal receipts. The worker reuses the original normalizer, production sampler and content processor. It verifies complete Span bodies in Python (64MiB budget) and sends generation-specific events (16MiB) without giant tool bodies to JS. JS answer features are bounded at64MiB and final cases at32MiB; excess is an error. Catalogs allow10000 authorized Traces. Next runs at most2 active jobs and20 queued entries per process; these are correctness bounds, not a throughput claim.

Recovery requires a live request by the original actor and an expired lease, then increases the epoch; bearer credentials are not persisted. Source-page access is rechecked after artifact I/O, and completion atomically publishes the release, job result and receipt. The builtin FI catalog remains a read-only dynamic view; RunPlans must freeze its effective content. Ordinary experiment/result/RunPlan consumers and controlled Benchmark import use the protocols below. Legacy Dataset semantic import and production cutover remain incomplete.


### Experiment, result and RunPlan consumers (010–014)

The physical schema now contains62 transactional and13 ClickHouse tables. Experiments use typed domain operations, frozen asset/model inputs, fenced workers, immutable machine receipts, receipt-bound human reviews and comments. The original DTOs, scoring algorithms and visible markup remain. Targeted `read_view` and independent `baseline_view` avoid loading unrelated histories. Exact operation/submission lookup precedes latest-resource reads; an uncertain completion never resends the Agent command or invents a failed score.

The private controller key file is an absolute, non-symlink regular0600 file with64 lowercase hexadecimal characters. Attestations bind purpose, principal, workspace and the exact wire-body hash. Never expose the key in browsers, RunPlans or logs. Model connection v2 fingerprints include effective custom headers without storing their values; headerless v1 hashes are compatible only with an identical connection and no current custom headers. Source ACL/lifecycle is rechecked on read, execution, replay and publication. Private Judge/diagnosis Traces remain private even to group administrators.

The projector checkpoints confirmed facts, metrics and selection on the fenced Outbox event. While execution or other results are incomplete, publication remains pending with bounded 1–60 second backoff; recovery skips confirmed fact writes. Reviews across Cases can confirm their individual indexes before the shared publication, avoiding mutual waiting. Historical events already marked sent without publication members require an explicit controlled backfill.

Dedicated Benchmark Case retries CAS the prior execution job and selected machine result, create a new execution identity and RunPlan with an incremented attempt, and reuse the frozen parent model, releases and configuration. Imported submissions cannot rerun an Agent. Durable preparation intents recover independently for the original actor. Only preparation without a sealed external request may acquire a higher fence after lease expiry; unknown dispatch retains the same external attempt. Agents and external Harnesses with unconfirmed cleanup retain their budget until an exact cleanup receipt.

Benchmark capabilities bind the job, attempt, fence, epoch and expiration; execution callbacks also bind the authenticated device to the signed body. Internal private work and normalization require controller proofs. Migration013 preserves012 checksums and permits empty evidence. Migration014 stores append-only issue-resolution annotations without changing machine evidence. See implementation status for remaining consumer and acceptance coverage; these are not production or thousand-client capacity claims.


### Workbench, A/B and candidate-verification consumers

Existing Workbench, trigger analysis, grayscale A/B and retest pages and fields are preserved. Experiments, Cases, selected machine results and RunPlans use core storage. Skill/model configuration, WorkbenchTask, GrayscaleTask, OptimizationRecord and static quality evaluation remain separate control domains; this does not mean all legacy tables have migrated. Each request uses the verified actor/workspace, including authorization of Experiment IDs stored in Tasks.

Execution, baseline verification and candidate retests read the Dataset release sealed by the experiment. Later edits do not replace its inputs or expected outputs, and frozen reads do not overwrite the editable cache. An explicit new round of an independent grayscale task seals the current Dataset version; same-config clones retain their source version. Global cancellation applies to the RunPlan it cancelled, while logical Case-deletion tombstones remain active across plans.

The original version-comparison and version-detail APIs use the verified actor and core Trace/tag data plus currently selected machine results. Human score zero, coverage, root filtering and question drilldown keep their existing rules. Version analysis includes only that actor's tags, Traces and experiment results, including for administrators; a supplied `user` cannot expand access. Private canonical Trace identity joins native/legacy aliases without reading old Execution, Tag or result tables, and stays out of the public DTO. Deleted or revoked sources no longer contribute Traces or scores.

Creation persists a signed prepared Task intent, obtains the exact typed core receipt, then marks the Task ready with CAS. Recovery replays the original frozen input. Session/optimization links recover through their own CAS. Cached Task scores are derived from the current Case, actual execution identity and selected machine receipt; a new execution or pending rescore does not retain stale scores.

Client and local Agent execution persist their real target/attempt before dispatch. Scoring requires an indexed business Trace. The existing local Agent runner is retained; cancellation waits for actual process-group cleanup. Unknown local targets after restart or on another instance remain pending. Lost completion responses trigger exact receipt lookup/replay rather than another Agent execution.

Candidate verification retains the original selection and scoring algorithms. Its proof is signed for the actor/workspace and source/candidate hashes using `workbench-verification/v1`. Archiving temporary verification experiments changes visibility references in the optimization record; both global and Workbench lists hide them while valid evidence remains reusable. Actual deletion or revoked source access invalidates evidence. Static evaluation migration, production imports, cross-instance local recovery and capacity require separate verification.

### Experiment issues and FI collection

The original optimization-points and plan routes use verified core scope. Dynamic/trigger issues are immutable derivatives of selected machine receipts; static issues and feedback remain in their existing control domain. Ordinary experiment points keep their attribution, severity and deduplication rules. Input-only evaluations return null execution/Trace references. Static detail reads require an explicit static, no-execution record and the original Skill/owner visibility; other failures never fall back to old dynamic tables.

The latest settled trigger result for the same Skill version determines the current issue view, including a successful result with no issues. This is a read-only supersession frontier, not a fabricated resolution annotation. History retains actual resolution fields. FI callbacks only record collection facts; the actual core attempt worker binds a Case after reading independent business Trace evidence, without updating historical legacy Cases.

Late receipts for commands created before the switch still complete their original control-command records. In core mode they never backfill legacy ExperimentTraceAttempt rows, including commands without a core marker. Legacy mode retains its original binding rule.

### Trace flow matching and attribution

The existing `analyze-match` GET/POST DTOs and UI remain unchanged. Core mode freezes authorized TraceEvidence, Skill content/version, ParsedFlow and model selection into an internal `trace-flow-analysis` Experiment/RunPlan, with separate match and optional attribution receipts. Ordinary experiment/Workbench lists and totals exclude these containers. The original matching, extraction, attribution, quality-dimension priority and scoring algorithms remain. Static Skill/ParsedFlow stay in the configuration domain; no legacy dynamic Trace, match or evaluation shadow rows are written.

Exact retries reuse frozen assets and real receipts. A model intent is checkpointed before dispatch; an observed response requires its indexed recording. Recovery reuses observed responses, while unknown intents remain pending without automatic model retries or repeated attempts. Optional attribution can remain pending while a completed match is returned only after fresh source and selection checks. Attribution must reference the exact match receipt. Later Trace growth does not change historical inputs; GET retains its interaction-count update indicator. Source deletion, revoked access or invalid Skill scope prevents reads/recovery. Mock HTTP acceptance demonstrates the actual storage/recording path, not model quality or production capacity.

In core mode, the existing `POST /api/experiments/:id/run` starts Benchmark through its typed domain and retains `202 {status, runId, alreadyRunning?}`. Case retries retain `202 {kind:"benchmark", status, runId}`; background promises are never included in the public response.


### Authorized analytics (015 / CH002)

The transactional schema now has 65 tables; ClickHouse has 15. Apply 015 and explicitly initialize CH002; historicalSQL stays unchanged. `readCoreAnalytics` supplies narrow, IAM-authorized projections to existing Dashboard/Fleet/Task/Quality handlers without layout changes. Private preparation/publication requires a real actor and `trace-analytics/v1` controller proof. Readiness uses 503 + `ANALYTICS_INDEXING` + Retry-After; existing apiFetch retries only that GET response for at most 15 seconds and stops on logout/account switch/cancellation.

Publication binds the prepared source revision, route/owner/aliases/annotation and exact projection hash. Final validation covers current result selections, unresolved issues, diagnostic heads, source/asset authorization and RAS receipt versions. Ready reads never load full Trace/Span payloads or RunPlans. Background parsing uses verified durable source artifacts; ordinary TraceEvidence retains its existing CH payload verification.

Limits: 128MiB /100000 Spans per preparation,2MiB per compact projection,100000 candidate Traces. Page-size adaptation, coalesced work and permanent-budget failure handling are bounded. Continuously changing source heads may remain pending until a stable preparation boundary is available. Incremental/watermarked materialization and1000-collector mixed-load capacity remain unverified. Arbitrary per-Span optional cache/reasoning attributes are not invented as Trace totals. Version one targets parity with existing features; large-Trace capacity work, watermarks and incremental materialization belong to version two. Legacy bulk migration remains planning-only.


V1 consumer follow-up: Skill list/version usage, success rate, P95 and trends, plus Agent management statistics and discovery, now read authorized core storage. Static Skills, versions, static evaluations and RegisteredAgent remain in their existing control store. Full output is read only for displayed executions; valid executions without a Session remain visible without fabricating a trajectory.

The internal evidence endpoint accepts `view=execution` and returns `agent-insight.trace-execution`: the original Execution, source manifest and a separate content hash, without a Session. Default full Evidence still requires a real Session. The existing analytics endpoint exposes the read-only `agent_metadata` action, bounded to 200 Trace/boundary references, returning verified identity and only the small fields needed for registration. Root identity is never inferred from descendants. The mapped legacy configuration owner and the canonical IAM username remain distinct; shared traces do not become the caller's own registrations. No new tables or migrations are introduced; migration 015 and parser1 are unchanged.

### Run records, reliability and answer evaluation

Skill runs/logs keep their existing filters, pagination, status and evaluation snapshots. They select authorized executions and hydrate the original Execution, including valid records without a Session. Known primary Skill versions remain immutable; actual invocation versions stay separate and unknown versions are not filled from the latest definition.

RAS reads use `ras_read`/`validate_ras_read`, verified receipts and exact ClickHouse content hashes. Events received before a Trace remain readable in their real owner scope. Owner/task matching, current authorization and private Judge isolation apply. RAS lists retain descending order; Trace reliability details retain the oldest 200 events in ascending order. Final reads recheck both Execution evidence and event selection. Limits are 10000 returned events, 100000 receipts for type filtering, one shared 60-second deadline and a 3MiB read token. FI Trace Session/RAS reads also use core storage while FI control records, model precedence and separate FI/RAS markers retain their existing meaning. These limits do not establish capacity targets.

Rejudge, Final Result edits and cancellation use a hidden `trace-outcome` Experiment/RunPlan. Edits and durable scheduling commit together; existing lease/fence rules reject late results. Even cancellation without an active task stores an exact operation receipt. Frozen model/source inputs and observed-response recovery are retained; unknown delivery stays pending. Only dedicated Outcome results override answer fields, preserving real zero versus unknown null. Trace lists, Skill records and statistics read the same current selection and validate its signed boundary without loading complete RunPlans or Sessions for statistics.

Query edits start no model task. The transaction stores the new query, the original algorithm's routing scalars/snapshots, an answer reset and cancellation; a later successful generation supersedes the reset. A routing scalar can remain null when no Skill was invoked while its snapshot rate is zero. Real credentials authorize writes; request user fields cannot grant access, and only the Trace owner can rejudge, edit its answer or cancel. There are no new tables, migrations or layout changes. Other control domains and full historical import remain on the outstanding migration list.


### Batch Trace case analysis

The original `debug/batch-tasks` Trace evaluate, single-case retry-evaluate, abort and progress reads use typed Experiments, frozen RunPlans and workers. The verified compatibility owner scopes the static Batch shell; source Traces must belong to the same principal and Skill versions are explicit. Successful starts require durable Experiment/Case bindings and queued work. The original flat states and rounded mean of numeric completed scores remain unchanged, including zero as a completed evaluation. Cancellation preserves finished sibling results; retry replaces only the selected Case. New Traces can be evaluated after cancellation.

An `idempotency-key` identifies one Trace evaluation intent. The client retains at most 32 request hashes, operation keys and timestamps, keeps the same key after network or response-body loss, and clears it only after receiving a complete JSON acknowledgement with `ok: true`. A later deliberate operation receives a new key. Recovery looks up the persisted start receipt and activates existing work without issuing another model request. Start and completion timestamps come from the current work/attempt metadata; internal `coreWork` is excluded from public Experiment DTOs.

BatchEvalTask and Skill/version control records remain in their original static store. The Dataset execution/evaluation path is described below; complete legacy semantic import remains unfinished.

The existing private Experiment RPC also checks fixed Batch operation capabilities through `batch_scope`: reads require read, create/configuration updates/abort require read+write, and execution/evaluation/retry require read+write+execute. Matching identity or workspace role does not replace credential capabilities. A bound task is hidden only after an owner-authorized lifecycle check proves its backing was deleted; unknown, unported and foreign bindings remain explicit failures.


### Primary Skills and historical evaluation fields in ordinary Traces

The original Trace/Case list restores `skill/skill_version`, `root_skill/rootSkill`, both invocation aliases, historical answer/Skill scores, reasons, failures, Skill issues, routing correctness and captured optional token metrics from verified source metadata. The root Execution's own Skill takes priority, followed by an explicit ExecutionSkill primary and then its own real reference. Unknown versions stay null; version0 is valid and no current Skill definition fills a historical version. The current dedicated Outcome overlays source history, then a query reset clears the answer. Generic Experiment scores never become answer scores.

The existing private analytics RPC adds the read-only `execution_metadata` action for1..200 authorized Trace/boundary pairs, with source-version and IAM checks before and after reading. The complete response envelope is bounded to8MiB; actual artifact-file bytes read across all pages of one compatibility-list request share a128MiB budget. Excess returns413 without partial success. Only whitelisted fields are returned, without Session/query/output or full Trace/RunPlan assembly; original failure/Skill-issue business details remain. Immutable carrier artifacts may contain Session bytes that must be decoded, and Span metadata is enumerated. Parser1 does not assert completeness of these missing historical fields, so this is not a zero-body-read cache. No schema, migration, parser version or frontend change is introduced.

Skill filters distinguish explicitly captured empty relations from uncaptured relations: empty relations match no relation Skill, while missing relations may fall back to the real primary Execution reference. Facets fall back only when the entire visible relation set has no Skill. Explicit invocation references in the current Outcome drive the list, facets and version filters together. Missing source collections do not erase captured compact collections. Private Judge traces remain excluded by the authorized list SQL.


Performance boundary: with 32 visible Traces in the isolated fixture, original list requests took about 4.1–4.9 seconds after this task's full gates finished. Concurrent full Node/Python/native-database gates caused requests to hit the original 15-second limit and return 502; the unchanged page error handling displayed an empty list. Request timeouts and source-consistency checks were not relaxed. Functional integration is separate from mixed-load capacity acceptance, which remains unmeasured.

### Dataset Batch execution and evaluation

The original Dataset Batch start/retry-execute/retry-evaluate/abort actions and flat progress now use Experiment RunPlans, existing local execution and the trusted Trace recorder. The original UI and response shapes remain. Batch shells and Skill definitions still use the existing static control authority; dynamic execution/scoring does not write legacy Execution/Session rows. Trusted recording maps an explicit skill_version to the Trace skillVersion, preserving version 0. Missing/null values stay unknown; existing recorded history is not rewritten.

A new logical start in the same Task may select new Cases or current Dataset releases. Each selected Dataset cut is sealed for that run; unselected Cases and old plans remain. A row retry uses its current execution slot’s original execute plan, not the latest global Dataset/model/evaluator configuration. Prepared intent and all selected execute work are durable before success; read-only validation of fixed versions and every selected Case precedes a Task CAS reservation, definition updates and transactional Case-batch upsert. A definitive failure may release only its exact new empty reservation before the Case batch commits; uncertain delivery and other intents remain protected. Exact receipts recover lost responses or control acknowledgements. Read-only GET never activates work.

With automatic evaluation disabled, successful execution remains `executed`; unstarted evaluator placeholders are `skipped`, without scoring work. Evaluation-only retries retain the original Trace and measured runtime. Zero remains a valid score and null remains unknown. Per-Case frozen evaluator selections preserve completed siblings after later configuration changes.

The private `source_execution_run_id` selection is validated against the current Case execution slot, owner, source permissions and immutable plan; derived plans record `parent_execution_run_id`. Existing controller proofs attest this selection and runtime checkpoints. Auto-evaluation uses the parent execution’s sealed input/gold/context plus the real ready Trace/output, while retaining current user edits in Case storage. Private `coreExecution` metadata is derived from the current work/attempt and excluded from default public Experiment DTOs; immutable plans are cached per run within one snapshot read.

Cancellation fences work before verifying process exit. Same-instance observed Trace completions replay the exact waiting_trace checkpoint with its original runtime timestamps before recovering the completion receipt, without another Agent call. The bounded local recovery registry evicts settled entries only; unresolved receipts remain and a full registry rejects new work before claiming or model execution. After a hard restart, unknown old-process cleanup stays pending/503; lease expiry is not exit proof. An exact operation POST may resume queued, unstarted work. Client start/retry-execute intents use bounded hashes/UUIDs; only a strict `ok:true` abort acknowledgement retires pending intents for that authenticated Task, leaving other Tasks/accounts intact.

The implementation-status page records final real HTTP/runtime/UI, full-suite and engine evidence. This adds no schema, migration, analytics parser or UI layout; static control migration and complete legacy semantic import remain separate work.


### V1 original Trigger evaluation runtime (isolated acceptance complete)

Original Trigger endpoints check actual IAM capabilities before reading static configuration. The trusted legacy account identifies static ownership and the original DTO owner; request user fields never authorize access. Each Run creates a private Experiment with one aggregate evaluate work item before acknowledging success. Exact operation receipts recover lost responses. An active run for the same actor, Skill and version returns the original 409 with its Run; different versions remain independent. Internal heads are excluded from ordinary Experiment list/statistics reads. latestOnly selects completed runs only.

The RunPlan freezes the test-set version/items, target Skill version and full bytes, competitors at start, tested history, model descriptor and parameters. Execution preserves the original multi-query sampling, timeout retries, routing rules, zero semantics and description-only Skill materialization. Each physical sample persists intent first. Actual Session messages must be recorded and fully indexed before Session deletion and the observed checkpoint. Runtime closure requires confirmed physical exit. Decision latency excludes recording/deletion waits; recovery preserves completion order without resampling. Unknown delivery or a hard restart without exit proof remains pending/503; an explicitly unsent failure becomes failed only after confirmed cleanup. Reads recheck current sample Trace authorization and provenance. GET never starts model work.

Cancellation persists its fence before exact-attempt cleanup. Original success=true acknowledgements, DTOs and UI remain. The client clears only the pending start identified by the trusted operation digest, preserving other versions. Missing model credentials do not become empty or placeholder authentication.

A–E, including drafting/deletion, have passed independent review and isolated acceptance, with no production switch. Explicit legacy history migration remains separate. Static Skills/versions, UserSettings and TriggerSets retain their existing authority. Final HTTP, native local-Mock, original UI and three-database evidence is recorded in the [implementation status](../../../../design/platform/analytical-transactional-storage/implementation-status.md).

The private Trigger start RPC serializes the original HTTP idempotency key/request unchanged across transport retries. The client clears a pending operation only after success=true with a complete Run matching the requested Skill/version/test set, or a valid versioned Set. An ID alone, incomplete DTO, malformed JSON or lost response retains the intent. Cancellation also matches the exact Run ID. Default generic list and ID-selected read_view hide internal Trigger heads; authorized dedicated Trigger history/detail reads remain available.


### Original Trigger aggregate issues and resolution

Each original Trigger Run produces at most one aggregate issue using the original summary, evidence and suggestedFix builder, including the tested version description and frozen other-version history. The dedupKey remains trigger:<skillName>, generator remains trigger-evaluator@1.0, and runId is the public Trigger history ID. ruleId, dimension and reasoning remain null. All-pass without competition creates no issue; all-pass with a competing Skill still creates one low-severity issue.

Machine completion, the new issue and automatic resolution of previous typed trigger issues commit in one transaction. Formal idempotency receipts and migration-014 annotations preserve resolvedAt, resolvedRunId and includeResolved history. Failed, cancelled or late results cannot clear old issues. Derived list/detail/frontier and manual resolution recheck current authorization and provenance of actual sample Traces. Original optimization endpoints retain legitimate legacy static/feedback reads. Legacy dynamic Trigger history requires explicit semantic migration, with no ordinary fallback or read-time fabrication. AI drafting and deletion are described in the E review slice below; production has not switched.


### Original Trigger AI drafting and set deletion

Drafting retains the original direct model call and prompt: it requests 18 examples, while the original parser accepts any valid nonempty output, including two items. A new version never merges existing user-edited items. A stable placeholder and independent typed work exist before acknowledgement, with frozen Skill bytes/version and model descriptor. Actual direct JudgeTrace indexing precedes the observed response/failure checkpoint. Unknown submission or a five-minute-old placeholder never causes blind resubmission; replay does not call the model again. Original success/conflict/version DTOs remain.

Completion uses exact owner/version/status/time/original-byte CAS. Repeated completion confirms the same ready/failed value; conflicting user edits survive. Typed results and static projection are separately idempotent, with no cross-store atomicity claim. Authorized POST can recover confirmation; GET is read-only.

Set DELETE preserves original behavior: it deletes set versions while retaining existing Run/Evaluation/SkillIssue history. In-flight Runs continue using their sealed set. Only draft work whose placeholder is missing is precisely fenced and confirmed stopped. Late activation checks the placeholder again, and completion only updates an existing row, preventing deleted-placeholder resurrection. New drafts retain earlier ready set versions; explicit DELETE removes all set versions. The original UI remains, with no schema/purpose/parser changes or production switch.


A transient Trigger history head-version change uses the narrowly whitelisted TRIGGER_READ_CHANGED code and an exact retry marker. Only the corresponding GET /trigger/:name/runs 409 is retried, at most three times within the existing 15-second budget, with current credential/account checks and Abort support. Exhaustion or other read errors enter the original UI error handler and retain displayed history rather than interpreting an error DTO as an empty list. Ordinary conflicts, authorization/deletion/provenance errors are not retried. Mutation conflicts and other routes remain unchanged.


Draft ready confirmation compares Item structure, avoiding false 409 responses when Python sorts JSON object keys. Object key order and optional undefined fields absent from the wire do not affect confirmation; array order, actual values and null remain significant, and user edits still conflict. Existing SQL CAS conditions and JSON storage format are unchanged.


### Public collector identity preflight

`resolveCoreCollectorIdentity` verifies actual API credentials or registered OpenCode device credentials and returns a frozen server-only identity. Body user/authenticatedUser/clientId claims grant no permission. Private mappings distinguish the legacy owner from the IAM login. A verified device owner must map to exactly one current principal/workspace; all matching mapping credentials are authenticated, while revoked unrelated owners do not block this request. At most 16 distinct mapping credentials per owner are accepted. A direct core API without a verified legacy alias retains its IAM username.

`POST /v1/compat/collector-source?workspace_id=…` keeps its scope action limited to a maximum 4096-byte `{action:"scope", operation:"snapshot"|"complete"}` request. It requires an API credential whose current capability and workspace role both permit write, and returns the corresponding principal/workspace/operation authorization. It writes no source, Trace or receipt and accepts no work/diagnosis context. An `/auth/me` workspace role alone cannot establish an API write capability.

When both API and device credentials are valid, principal/workspace must match. Legacy aliases may differ: the actual API token remains in use and the verified device mapping supplies the legacy static owner. A 401 invalid API may fall back to a valid device; an authenticated API denied with 403 cannot borrow another credential's permission. A valid API may accept an invalid device without binding its claimed clientId. Missing, ambiguous or unavailable mappings for an authenticated device fail closed. Upstream unavailability is not rewritten as an invalid credential. Proxy callers must explicitly select `authorizationKind:"provider"` to exclude provider Authorization from user authentication, using x-witty-api-key separately for collector identity.

The identity is branded: object copies are not trusted, and tokens remain in private closures rather than identity JSON. Private callers of `withCoreCollectorIdentity(identity, (actor, options) => …)` must use the second argument's origin-pinned `options.fetcher` for subsequent RPCs. The receiver must still check IAM inside its actual write transaction; preflight is not a durable grant. `revalidate()` and the private callback entry recheck original credentials, device revocation, mappings and current write permission before acceptance. Principal/workspace/alias/client-binding changes are rejected. Every actual request boundary also pins the core origin to prevent sending an old credential to a newly configured instance. This slice does not change the original upload, completion, proxy or logs handlers. Public upload idempotency/indexed ACK integration and preserved legacy spool identity/migration remain in the [implementation plan](../../../../design/platform/analytical-transactional-storage/phase7-consumers-and-legacy-migration.md).


### Public source snapshots (private foundation; original upload routes inactive)

The private collector-source endpoint now supports `reserve`, `commit`, `complete`, `status`, and `reject_preparation`. These actions require the actual API write capability and a `collector-source/v1` controller proof bound to exact request bytes, principal and workspace. The existing scope action keeps its 4096-byte contract. Ordinary OTLP cannot claim the reserved `collector.source.v1` namespace. No table or general OTLP deletion flag was added; public route wiring is described below; the original UI remains unchanged.

Reservations retain original input, selected timestamps, the source revision and separate task/canonical execution aliases. A new upload ID for an existing task does not replace its first execution identity. Changed input under one key conflicts; a new current device credential cannot replace the first sealed provenance. A trusted request for the same owner/source can resume a prior durable intent, without authorizing old unauthenticated spool bytes. Commit accepts the original portable `{execution, session}` with revision CAS, immutable source packets and outbox receipts. Raw commit replay is checked before current completion normalization; old retries do not overwrite newer data. Explicit zero values, nullable frameworks, full messages and extension fields are retained. First real framework binding is separate from the internal analytical fallback.

Completion before messages records only the route, private ACL, aliases and a frozen timestamp, with no invented CH interaction, LLM or tool. The bucket is selected once and reused across dates. Existing Session completion must reach actual indexed batches. Original missing-interactions versus empty-interactions behavior, including completion creating a missing empty Session/default clock, remains part of the later public adapter work.

Receipts distinguish reserved/accepted/prepared/indexed/failed. A private HTTP 200 does not constitute the original upload ACK: future public handlers must wait for every actual batch to be indexed. Shrink uses higher-revision source-specific tombstones while retaining heads and artifacts. Current Evidence, generation, RAS and compatibility reads exclude only retirements validated against the private ledger, exact head hash and immutable deleted source. The full head vector remains a fence. Stable entity IDs and current item order are separate; missing/duplicate indices fail closed. Langfuse secondary interactions, primary nodes and portable exports retain validated original capsule data and manual overrides, instead of reconstructing original values from compact summaries.

A Session with no end time remains running even if all current messages completed. Completion changes the lifecycle after indexing. Shrink rebuilds current metrics, time bounds and metadata providers, removing retired errors/models/skills. Metadata and actual tool carriers do not become extra primary interactions. Current multi-packet reads return 503 until all batches are indexed; changed committed boundaries return 409. A merely reserved next intent keeps the previous indexed view available; generic OTLP streaming rules are unchanged.

Preparation rejection is reserved-only, requires the original input hash and either `INVALID_SOURCE_INPUT` or `SOURCE_BUDGET_EXCEEDED`, retains raw input and fences late commit. Configuration/model availability, authorization, network and CH failures are not terminal input rejection. Replaying an old rejection cannot clear a newer intent. Limits are 16 MiB input/snapshot, 64 MiB private plan, 256 entities per packet, 100000 retained entities and 4096 receipts per source. They are correctness bounds, not capacity certification. Original normalization, child/thread derivation, source-bound asynchronous analysis and public ACK integration still follow the migration plan; no production cutover occurred.

A published Source with a non-null head requires an actual matching CH summary. Status/agent/search may legitimately exclude it: omitted known Source IDs receive one bounded presence query without those filters, with workspace, namespace, native ID, bucket and revision validation and a subsequent source-boundary check. A genuinely missing summary returns503 rather than accepted/empty success. Presence-only rows do not enter the filtered result. Headless completion and uncommitted intents may still have no summary.

Private Session reads currently include normalized Span transport fields and do not claim original public Session DTO equivalence. Portable export retains the complete original snapshot. Public activation must reuse the original Node payload-version and structure-interaction projection and verify original fields, caching and UI.


### Shared public collector preparation

Original upload quick Skill/version selection and legacy save now share deterministic preparation: adapter normalization, monotonic merge/allowed shrink, query protection, explicit label/version rewrite, version zero, OpenCode metrics and the original Langfuse tree. Legacy entry points retain their original persistence and analysis side effects. This extraction adds no new-store route branch and changes no UI.

`captureCoreCollectorPreparation` requires a branded server identity and current authorization. It captures only related Skills/required versions, selected routing/outcome configurations, their actually needed static ParsedFlows, related registered Agents, the selected Skill score and auto-evaluation flag. Model configuration is reduced through the existing non-secret `freezeModelSelection`; API keys, Authorization/custom authentication header values and complete UserSettings do not enter the plan. ParsedFlows are not scanned across every Skill/version.

`prepareCoreCollectorSnapshot` computes root/Session, nested child and per-Agent Skill plans, Thread/events and named post-hooks using that capture and original source state. Computation reads no database/current configuration, calls no model and chooses no new clock. Default Execution/Session time uses the sealed received_at_ms; explicit timestamps retain their original value. Binding checks cover task/canonical execution, operation/input hash/base revision, original request and a digest of timestamps/provenance/prior snapshot. Changed input, state or default time cannot reuse an old preparation. The binding grants no authorization.

Thread-only input retains a real Thread plan without creating an Execution or fake Span. Rejected smaller snapshots still retain Thread writes that originally precede the shrink guard. Pure completion preparation preserves an existing Session or plans the original empty Session, label opencode and first default startTime; it invents no Execution. Uncorrelated Codex pending units remain pending rather than becoming root tasks.

Migration016 now durably seals the first capture/plan and independent Session;017 adds private child graphs and Thread/event/member effects. The public Session pipeline, durable analysis and typed Flow producer are connected as described below, with no fallback to old dynamic writes. The original UI is unchanged. New slices receive fast focused checks; complete acceptance is consolidated after remaining integration.

Shared Session preparation keeps legacy storage and validated canonical representations distinct. Unrelated malformed interaction/graph JSON is not parsed, cleaned or overwritten during normal metadata/message updates. Only an actual incoming Langfuse nodes array enables the original guarded old-graph decoding/merge. Core supplies validated arrays directly; preparation is not an implicit legacy-data migration. Framework capability follows field-presence semantics: omitted inherits prior state, explicit null/empty uses Generic rather than a logical-or fallback.

Capture reads a lightweight owner name/id/activeVersion directory, preserves original JavaScript case matching/first selection, then reads only selected-ID version numbers and required version bodies. It avoids the legacy findSkill whole-owner body read. Exact-name routing version fallback uses separate targeted metadata. Thread eligibility uses the original raw-stage framework/identity conditions. An incoming natural Thread selects its trusted lookup ID or stable new ID rather than unconditionally inheriting the prior ID; projection.threadId must resolve that incoming natural key. Pre-shrink-guard Thread plans remain, while a rejected Root snapshot/association and its missing post-reconcile remain unchanged. Pending-parent handling stops earlier and creates no Thread.


### 016 private collector preparation

`collector_preparation_receipts` seals the first Node input string, source context, capture and complete plan. The existing Source ledger and ingest_batches remain the only ingest/indexing authority. Private `collector-source/v1` proofs bind the actual write-capable API actor, workspace and exact body; group administrators cannot collect on behalf of another owner. Retries return the first sealed choices. Original Session serialization is recovered only from the applied plan bound to the current source revision; older A/unprepared writes are explicitly `legacy_canonical`.

Completion without an Execution stores Session metadata without a fake Execution or CH Span. Later snapshots receive trusted previous_session and retain the first clock. Manual annotations remain authoritative. C1a applies only root Sources and empty Sessions: child/Thread/retirement graphs stay pending, while ThreadOnly preparation creates no Trace locator. The private receipt keeps `public_ready:false` until consolidated acceptance; this does not authorize production cutover. Migration016 is explicit and preserves historical A receipts; this is not a production cutover.

When begin adopts an older A reserved operation, including a resumed pending intent or an existing preparation receipt, the preparation guard is persisted in the same transaction. Legacy commit/complete cannot bypass the sealed plan; failure rolls back both the new receipt and guard. Already committed historical operations retain their source state and replay compatibility, with their representation still marked `legacy_canonical`.


### 017 private collector graphs and original Threads

017 adds `collector_trace_threads`, `collector_trace_thread_events` and `collector_trace_thread_executions`, retaining original natural identity, nullable clocks, omitted-field updates and source-turn reconciliation without making sourceExecutionId unique. It adds no CH table or graph ledger. ThreadOnly uses existing snapshot write authority and inbox idempotency, creating no Trace/Execution/Span. The original public layer must still reject uncorrelated Codex pending units before preparation.

The typed private `capture_graph_context` captures selected child state, original Session representation and Skill origins. `seal_capture` atomically validates and reserves actual child/retirement intents through the existing A pending mechanism; failure rolls back capture and reservations. Ordinary child input cannot adopt a parent graph's derived operation and retries after that graph completes. One sealed plan commits root/children, Threads/events/members, retirements and existing Outbox together. Each source retains its own batch references; an immutable descriptor binds the complete vector while actual worker receipts remain indexing truth. Historical indexed ACKs never replay effects or roll back later independent updates.

Derived retirement is limited to that root's actual derived set and retains aliases, locators, Sessions, artifacts and history. Attested tombstones hide the Execution/list entry; ordinary missing facts still fail. Each child seals its own Session string, preserves its first Session start when no source clock exists and retains Execution fields the original upsert does not write. Original pure Skill/origin selection rules supply Source projections and bounded existing Span attributes without new Skill relationship tables.

The private receipt keeps `public_ready:false`. Public API core branches are wired; original screens and production data remain unchanged. This slice is implemented pending consolidated full regression, real-engine/CH, migration and original-UI acceptance after remaining consumers are connected.

### Public collection wiring (implemented; consolidated acceptance pending)

In core mode the existing upload, OpenCode completion, proxy start/chat/end, OTLP logs/traces and Claude context routes now share verified collector sources. Public OTLP preserves the original decoder, framework partitioning, normalization, aggregators and Jiuwen trace/session stitching, so a client's OTLP and snapshot feeds retain canonical task identity. The dedicated native core endpoint remains separate. Existing ACK flags, ThreadOnly, pending Codex and OpenCode progress/deletion guards remain in place; ordinary noncollector core Traces retain their established read compatibility.

The Session route runs the original Node transformation/view pipeline against source Sessions and017 Threads. Read-capability `GET /v1/compat/observe/session-source`, `session-relations` and `session-sources` enforce current Trace IAM, including authorized group-admin visibility and Sessions without an Execution. Exact Skill/origin relations come from attested source state. Lazy query extraction requires the actual owner plus execute, and publication checks source/annotation/deletion fences.

Analysis and proxy-end jobs reuse the existing Outbox, immutable first preparation and model intent/observed checkpoints. Model execution requires an explicitly configured branded owner background actor with current execute; write-only credentials can receive and prepare without exposing secrets in capture/ACK. Model authentication is sent only when configured. Local OpenClaw and skill-generation CLI capture require an explicit trusted default actor. SkillGenerator's OpenCode bridge retains same-owner authenticated uploads in a separate owner spool and cannot inherit another owner's global key.

Authenticated log packets are durably retained before original aggregation. Consumption acknowledgement requires the actual indexed receipt vector for every output and retirement; explicit original discard reasons are recorded, while pending/retry remains unacknowledged. Core startup does not launch the old unproven spool consumer or global backlog uploader. Existing spools/cursors remain untouched pending explicit mapping/migration. Full-suite, native three-engine, original UI, real-client and preservation rehearsals remain part of consolidated acceptance; production is unchanged.

## Infra compatibility adapter (018; pending consolidated acceptance)

Infra overview, source management/details and Trace association components use apiFetch with the current login credential on every request, preserving API paths, request bodies and abort signals. CSV/Markdown downloads also use authenticated requests and retain the server filename and response bytes. The browser buffers the complete Blob and releases its temporary URL after download; credentials never enter download URLs. Presentation and interactions stay unchanged.

018 adds infra_sources and session_infra_links in the transactional store. Apply schema/clickhouse/003_infra.sql explicitly (or ClickHouseStore.initialize_infra_schema) for infra_metric_samples: 71 control tables and 16 CH tables. Startup does not implicitly alter an existing CH target. Use the existing explicit backup/migration workflow; default data is not migrated here. Source CRUD, pull/push collection, overview/history/export/testing and automatic/manual Trace-tree correlation retain the existing API/DTO/UI and normalization/diagnosis math.

Sources are scoped to workspace and actual owner; group administrators may read group sources, while mutation requires the actual owner and current credential capability. Credentials live in private artifacts and are read only through infra/v1-attested server RPCs. Browser responses retain only header names and hasAuth. Omitted credentials remain unchanged; null/empty explicitly clears them. Deletion hides historical samples while retaining physical history and manual links. Re-registration creates a new source identity.

The core poller uses explicitly mapped owner actors with read/write capability. Keyless metrics require an explicit DEFAULT_INGEST_USER and a unique private identity mapping. Missing or unauthorized identity retains the original best-effort accepted/attachedTo:null response without writes; this ACK is not durable/indexed proof. Accepted samples use the existing inbox/outbox/artifact/lease flow and stable per-operation sample IDs; independent receptions are not deduplicated by time/content.

Correlation obtains actual endpoint metadata within the current authorized Trace boundary, including previously published v1 analytics without endpoint. Existing publications/parser versions are unchanged, and virtual children do not inherit a guessed root endpoint. Consolidated full-suite, native database, real CH, UI and migration acceptance remain outstanding.


RAS deletion retains historical facts and uses an owner/task deletion barrier to reject late resurrection; linked Traces require current delete permission. FI uses the three fixed019 control kinds and private domain actions. Claims, stops and collection bind the actual owner, worker and current lease; business Sessions come from the independent collector. The retired standalone rejudge endpoint continues to return410; evaluation uses the existing experiment evaluators.

FI claims add an optional claimToken which updated business clients echo during collection. Existing fields and UI stay unchanged. Legacy clients can complete their first current lease without a token; ambiguous callbacks after reclaim return409. Independent Sessions are counted from their original representation and hidden by the Trace deletion barrier even without an Execution. The RAS-only deletion barrier also rejects a first late collector reservation. Full tests, three-backend and ClickHouse checks, browser validation and migration rehearsals remain consolidated after integration.

### 019 Original controls and the shared repository

019 adds `platform_control_records`: the target is72 transactional and16 CH tables. The fixed40 domain DTOs retain488 scalar fields, null/default rules, original unique groups and parent relations in the [field dictionary](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md). Skill versions reuse immutable releases and stable external-version aliases, including version0 and editing an old version. Private artifacts retain file bytes and modes; selected authorized versions materialize real directories isolated by core origin/workspace/principal. Metadata lists and counts do not preload all bodies or model secrets.

`db` and fixed control-kind `prismaRaw` methods obtain the actual request context on every call; global instances never cache an actor/token. Legacy username and normalized IAM principalUsername remain distinct. User parameters only filter or validate an established scope. Record CAS and revisions of actually read kinds preserve transactions without unrelated heartbeat conflicts. Only fixed kind/id/parent/metadata selectors and bounded mutations cross the controller protocol, never arbitrary Prisma predicates or SQL. Separate ordinary, write-prior and collector-preparation purposes retain actual server capability checks. Write-only collectors may freeze relevant static dependencies and the original nonsecret model summary without acquiring execute permission.

Settings and SDK keys remain private to their owner; administrator Trace visibility does not expand secret access. Ordinary User reads only echo the supplied credential. Existing standalone login keeps its trusted local entry; organization/IDaaS must verify the actual identity first. New subjects receive a personal workspace, existing subjects/keys/permissions remain intact, and names or first-user order never imply administrator status. Installation tokens are consumed once. Device hash, owner/client binding and revocation are checked for each private call. Cross-owner handoff requires the old device credential and atomically revokes old credentials; without that proof the new owner can register an independent client while old data is retained. Devices never receive an owner API key.

Workbench/optimization/generator sessions, messages/blocks/VFS, candidates, original task shells and debug results use these controls. Dynamic Experiments/evaluations/diagnosis retain their typed stores. Agent deletion also submits existing Trace deletion barriers; artifacts are retained. Original new-user examples use typed Datasets and the existing Trace bundle import. URLs, DTOs and visible UI remain unchanged; four TSX files only import the request wrapper and the runtime provider also supplies dynamic request headers. SSE, AbortSignal and FormData retain their original transport semantics.

Bounds are20000 records per fixed-kind read,128MiB payloads and2000 mutations per batch. Exceeding them fails explicitly without truncation; they are correctness bounds, not capacity certification. Consolidated validation now includes backend full-suite results, native PG/openGauss scoped checks, real CH domain operations and selected original UI workflows. The implementation status records exact coverage and source snapshots; production cutover is not performed. Migration retains historical task statuses and timestamps. Inert receipt markers exclude historical controls from automatic execution, device/install authentication and Infra polling; FI, Experiment and Benchmark execution enforce the same fence. Diagnosis/report and semantic-import runtime guards are integrated. HISTORY_FENCE_VERSION=1 permits explicit inert-history imports; older versions, unresolved owners, missing files and source/target conflicts remain blocked. Production cutover is not authorized.

## Goal Plus, collaboration and usage compatibility (020; consolidated acceptance pending)

Existing Goal Plus snapshot, source/goal/run, relinking and completeness routes, and collaboration event/binding/graph/Trace projection retain their API, DTO and UI. A closed catalog describes eight Goal Plus and four collaboration projections. Original Node algorithms run against authorized projections; the service does not accept arbitrary SQL or Prisma filters. Mutable metadata/relationships use the transactional store; immutable snapshots/events use CH. Execution links resolve actual new-store Trace aliases and current IAM without legacy placeholder rows. Group administrators may explicitly read group data, while mutation requires the actual owner. Source fingerprints, event bodies and established bindings cannot be replaced by different content.

020 adds five control tables. Explicitly apply schema/clickhouse/004_semantic_usage.sql or ClickHouseStore.initialize_semantic_usage_schema; totals through020 are77 transactional and19 CH tables. Startup does not automatically alter an existing CH target. Facts are visible only when their hash matches the current transactional directory; rollback orphans, missing facts and changed content cannot be treated as accepted data.

Usage retains its existing bounded queue,202 accepted/dropped and retry behavior. Each event carries its verified private ingress scope; mixed owners are persisted separately, and body.user never authorizes a write. Permanent event-ID receipts prevent within-batch, replay and post-retention double counting. Raw retention removes only raw facts, preserving receipts and daily totals. Administrative statistics use current group scope; ordinary members cannot access the management APIs. Disabled telemetry preserves its existing response without requiring storage work.

An explicit historical manifest must map actual owners and load parents before children while retaining IDs, JSON and dates. Historical raw events and original daily totals are imported separately; raw import does not increment daily totals or start models/tasks. Full suites, native engines, real CH, original UI and migration rehearsals remain consolidated acceptance work. Production/default data has not been switched.


### Native User background recovery

A newly created native User no longer requires a handwritten identity file for automatic analysis. The existing private bootstrap controller enumerates or precisely revalidates durable User/API credentials: artifact hash, record/legacy username/lookup hash, actual active principal/workspace/owner, current capabilities, expiry, revocation and history markers all remain authoritative. It never issues a replacement key or trusts an arbitrary stored token or migrated legacy key. Only the existing bootstrap controller purpose with the fixed platform-background producer can request this data; ordinary SDK/API/session credentials cannot enumerate it.

Explicit private legacy mappings remain supported and retain the distinction between the legacy username and normalized IAM principalUsername. Node brands each validated source and origin, revalidates that source for use and restores after process restart without remembering the first user. Copied actor objects are rejected. Snapshot/hooks still require write. Automatic models still require the same real owner's current execute capability, the existing model_scope and per-job checks. A write-only uploader cannot promote itself; readonly, revoked, expired or foreign-owner credentials are not execution authority. Administrator Trace visibility does not expose another owner's model configuration. Session GET lazy execution first requires the requester's own owner/can_execute scope.

The original upload generator-tag fallback uses a private projection under the branded collector: current owner plus one explicit opencodeSessionId, returning only agentName/agentTraceSkill/user. It exposes no Session body or unbounded listing. No DDL, frontend, cookie or model-protocol change is involved. Evidence is limited to isolated SQLite, in-memory facts and a loopback Mock model; complete suite, real engines/CH and browser acceptance remain consolidated work.

## Offline semantic legacy import (v1)

The separate `plan-legacy-import`, `apply-legacy-import` and `verify-legacy-import` commands operate on a verified private raw export. The original strict read-only legacy plan remains unchanged in authority. Fixed adapters cover 96 catalog model names; catalog coverage does not certify every legacy row or production cutover. No new DDL is introduced: row checkpoints, permanent inbox receipts, private artifacts and real domain tables are reused.

All commands require an explicit export directory, stable source ID, owner bindings and isolated target config. Apply/verify additionally require current actor credentials and a migration ID. There is no default database discovery or service launch. Explicit row bindings resolve null or ambiguous owners; no ownership guessing, password recovery or old key activation occurs. Entity identity derives from source ID, physical table and typed primary key; content hashes identify versions. Each domain write, raw private row, checkpoint and successful receipt commits atomically. Unindexed ClickHouse facts remain pending. Exact retries are idempotent; changed source content, target drift, collisions or missing evidence fail without overwriting user data.

Trace, assets, experiments, evaluations, diagnosis, infrastructure, Goal/Collaboration, usage and fixed controls use their actual domain storage and read contracts. Session bytes, Node JSON semantics, original IDs/dates and relationships are preserved; a Session never fabricates an Execution. Skill/attachment imports require real private bytes and matching hashes. Explicit file/directory manifests never interpret an old path as body content. Missing files and ambiguous message ordering block import. Raw usage never recounts imported daily totals.

Historical credentials, commands, jobs, leases and pending/running operations are inert and preserve their original status. They cannot authenticate, start workers/models, poll infrastructure or claim work. HISTORY_FENCE_VERSION=1 permits explicit planned inert-history imports; versions below1 still block those rows. Runtime marker guards remain independent of this version. Old generation jobs use a fixed private history directory and remain outside the runnable queue. Internal history flags are stripped before public DTOs, preserving the original UI.

An explicit retest from a completed historical diagnosis requires a verified import receipt, original snapshot bytes and unchanged migrated Trace, source results, Dataset/evaluator and Skill byte baselines under current IAM. Current evidence is reconstructed and compared with the old snapshot. Missing or changed proof returns Conflict. A successful retest freezes current real model/assets and creates a new experiment/RunPlan with historical origin; it never revives an old lease or claims old model provenance. Development checks use fresh temporary SQLite and memory facts. Native three-backend, real ClickHouse, browser and complete migration rehearsals are deferred to consolidated integration validation. Production cutover readiness remains false.


Nested control requests inherit the current pinned transport options only when none are explicitly supplied. Each request still verifies its actual credential, workspace and capabilities. Background owner resolution preserves 401/503 from matching sources without using failures from unrelated owners. The private directory failure_owners projection contains source labels and status codes, never invalid keys. Trace draft authentication failures return the existing public 401/403 response before evidence is read.

Device FI reads use a separate fixed TASK/RUN/WORKER owner projection while preserving current dc verification, clientId binding and historical inert guards. This does not expand generic device reads. Benchmark cancel_control is restricted to the frozen client target of a pending cancellation. Every operation verifies actual ownership, current delete capability, request hash, the exact bound commandId, live device binding and historical markers. It only looks up, creates or marks sent that CANCEL_EXPERIMENT_RUN command, preserving TTL, retries and late callback fencing without granting generic read/write to a delete-only credential.

Before sign-in, `GET /api/eval/config/status?check_login=true` (and the compatible `check_org=true` probe) returns only the login mode and organization sign-in redirect URL without user credentials. Reading an evaluation configuration still requires the authenticated control scope.


Permanent history markers prevent resuming old execution while retaining original pending/running/enabled values. Ordinary Experiment cancellations remain readable with their original pending state and targets. Runtime scans exclude historical Experiments, cancellation_route rejects them before any command is created, and the Node reconciler returns historical_inert records without invoking producers. Existing CAS and execute checks remain in place. New live cancellations retain their command/device polling flow.

Historical InfraSource configuration remains readable and explicitly editable. ensure for the same endpoint still returns the marked historical Source; changing enabled does not clear its marker or resume polling. Both pollable and accept_sample reject historical Sources before side effects, including new sample artifacts, receipts and outbox events. Resuming collection requires an explicit new live Source identity; there is no implicit promotion. The dedicated offline historical sample importer bypasses the live acceptance path. HISTORY_FENCE_VERSION=1 permits explicit import of these inert historical records; runtime guards still check markers independently. Import plans must resolve owner, artifact and provenance issues, and production_cutover_ready remains false. No historical lease or credential is revived.


The collector.source.v1 adapter does not synthesize service.name for missing, null or empty agentName. Its list DTO omits agent and agentName as the original readRecords did. Explicit names, including collector and unknown, remain intact. This omission applies only to the collector namespace; native OTLP service.name, agent.name precedence and existing unknown-value behavior are unchanged. Execution export null/absence semantics are preserved. Captured prepared plans and operation receipts replay their original content without rewriting existing rows. An explicit new snapshot follows the existing source revision/hash protocol; unchanged entities remain stable and replaying an old receipt cannot roll back current data.


The original /api/settings and /api/settings/test aliases also carry the current credential through apiFetch; authorization still uses the actual actor and current owner/capability. Original Skill catalog, Workbench and generation-session ZIP downloads use authenticated Blob transport, preserving bytes and preferring the server Content-Disposition filename. Credentials never enter links and query user values do not authorize access. JSX/styles remain unchanged; complete-Blob buffering has the same boundary as Infra export.

### Complete reads during analysis updates

Original Trace list, Session, evidence and reliability reads retain complete-snapshot validation. A committed collector snapshot awaiting indexing is identified privately as `503/TRACE_INDEXING`; a source or analysis revision changing during a read under the same proven identity is `409/TRACE_READ_CHANGED`. Only these two GET failures restart the complete authorization and read operation. Old snapshots, partial bodies and empty fallback results are not successful responses. Each read pins the service origin, actual principal/workspace and cancellation signal. Rebinding, deletion, revoked access, missing stable facts, corruption and ordinary availability failures retain their existing errors.

Each GET is limited to 32 read attempts (including the initial attempt) and a 15-second window for waiting and starting another attempt, starting at the first proven transition failure and never renewed by later failures. List and filter data GET RPCs use the existing evidence-read I/O budget of 65 seconds. Write and other endpoint budgets remain unchanged; the retry window is not a hard 15-second request deadline. Writes and model calls that have begun are never replayed. Session parsing caches include source identity, source revision and annotation revision. Private session-source responses may include `identity_hash`, and signed RAS read tokens may carry that identity digest. Revision retries require unchanged identity proof. Older services without the digest, older RAS tokens and identity changes retain Conflict responses. Public DTOs, the original UI and transactional schemas remain unchanged.

## Trace query configuration

`control.connection_pool` applies only to the PostgreSQL runtime, not automatically to CLI or explicit connection factories. Defaults: `enabled=true`, `min_idle=2`, `max_size=16`, `acquire_timeout_seconds=2`, `connect_timeout_seconds=3`, `idle_timeout_seconds=300`, `max_lifetime_seconds=1800`, `health_check_idle_seconds=30`. Idle eviction is checked on acquisition; active expired connections close upon return. The idle baseline does not pre-create connections. Nested acquisition fails immediately when exhausted; ordinary acquisition waits within a bound. Transactions already started are never replayed automatically.

Top-level `trace_list_optimization.enabled` defaults to `true` and is forwarded by project startup. Disabling it restores compatibility queries. Optimized paths cover ordinary timestamp pagination, summary filters, tag/user ID selections, statistics, and framework/source/Agent options. Historical sources, page outcome overrides, and complex filters fall back; statistics with nonempty `legacy_execution_metrics` also fall back to preserve overrides. Average latency retains all matching records in its denominator; tool error rates combine counts before rounding.

The in-process `connection_pool.snapshot()` exposes total/active/idle/creating and cumulative counters. Standard Python INFO logging reports database paths and compatibility fallback reasons without credentials or content. Database scans may still cover all candidate summaries.


## Core request capacity and ingest retries (021)

The top-level `max_concurrent_requests` field in project storage configuration and generated private Core JSON defaults to `64`, accepts integers from `1` to `256`, and takes effect after restarting Core. The socket backlog uses the same value. This caps active connections/requests, not logged-in users, and does not resize database pools or alter write locking. Overload returns `503`, `code=CORE_BUSY`, `Retry-After: 1` and `X-Storage-Retry: core-busy`. Core and primary compatibility Web forwarding preserve the marker. `apiFetch` retries marked GETs at most three times with approximately 1/2/4 second waits plus jitter, within a 15-second retry budget. Cancellation or identity changes stop retries; mutations are not replayed. This is not a claim of doubled throughput or thousand-user capacity.

`GET /v1/health` includes `http.capacity`, `active`, `peak`, `rejected`, `completed`, `duration_ms_total` and `duration_ms_max`. These process counters reset on restart. Active includes the health request itself; health can also be rejected under overload. Duration covers slot acquisition through request reading, processing and response delivery, excluding backlog waiting.

Observation batches allow five executions (initial plus four retries), with 2/4/8/16 second backoff. Overall duration also includes execution, I/O timeouts and expired-lease waiting; it is not a fixed 30 seconds. Claimed executions count even if the worker crashes. Dataset and Experiment delivery policies are unchanged.

Batches preserve order per workspace/Trace, including every Trace in a mixed batch. Independent Traces bypass delayed or leased batches but still share the current execution time of the single worker and database resources. Terminal predecessors fail dependent batches with `DEPENDENCY_FAILED`; exhausted execution budgets use `RETRY_EXHAUSTED`. Existing permanent source/artifact failures remain terminal. Original packets and frozen plans are retained. Duplicate uploads return the existing receipt without resetting attempts.

The existing batch status API adds `attempts` (current recovery cycle), `total_attempts`, `max_attempts`, `recovery_generation`, `next_attempt_at_ms`, `last_error_code`, `last_error_message` and `last_error_at_ms`. Errors contain safe categories only. The next-attempt timestamp is eligibility time, not a completion promise; Trace dependencies can delay it further. See [failed batch recovery](../../how-to/platform/storage-core.md#recover-ingest).

Migration 021 recognizes historical failed batches without frozen plans that the old worker had already skipped: for each Trace with a later prepared version, it removes only that historical dependency barrier. The failed receipt remains, and recovery cannot overwrite its successor. New failures do not receive this exception.
