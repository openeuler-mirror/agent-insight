---
title: "Storage core, IAM and safe migrations"
description: "SQLite, PostgreSQL and openGauss control storage, authorized ClickHouse access and legacy exports."
---

# Storage core, IAM and safe migrations

**Product compatibility status (2026-11-14):** The original frontend is restored, with server compatibility for existing Trace contracts. Complete domain migration and regressions remain unfinished. This is isolated validation, not a production cutover.

`services/storage/` is a Python 3.11+ foundation. SQLite, IAM and ClickHouse use the standard library; relational servers use an explicit DB-API connection factory. Next explicitly opts into core Trace ingestion, listing, Span/payload reads while retaining original login and screens. Other domains are not fully switched. Leaving the flag unset preserves the legacy path; offline commands do not switch a running application. See the [isolated setup guide](../../how-to/platform/storage-core.md).

See the [table relationship guide](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序) for all75 table purposes, primary/unique/query keys and overview/relationship diagrams. It distinguishes database foreign keys from logical references across databases. The diagrams and full dictionary are maintained in Chinese.

## Implemented contracts

`001_core.sql` remains byte-for-byte unchanged:21 transactional and13 ClickHouse tables. `002_iam.sql` adds10 IAM tables, 003 adds2 project-directory/binding tables 004 adds2 ingestion/entity-version tables and005 adds4 Trace identity/annotation/tag tables, 006 adds2 diagnosis conversation/message tables and007 adds2 report-run/head tables, 008 adds2 Dataset head/operation tables and009 adds1 generation-job table. Migrations010–012 add8 experiment,2 diagnosis-binding and5 Benchmark tables;013 preserves empty artifacts without new tables and014 adds1 issue-resolution table, for **62 transactional +13 ClickHouse =75**. The complete field/type/constraint/index dictionary is in `design/platform/analytical-transactional-storage/core-table-dictionary.md`.

All three transactional backends share immutable releases/dependencies, draft/alias CAS, frozen RunPlan inputs, task leases/fences/cancellation, artifact verification and atomic result receipt/Outbox writes. ClickHouse supports trusted canonical Span batches, latest-state filtering, single-Span and paginated structure reads, exact-revision payload bundles with chunk/manifest hashes, and bounded analytics. Requests are capped at4MiB; payload bundles at64MiB.

The004 observation materializer rejects changed content at the same source revision, ignores older revisions and replays a frozen plan after partial writes. Durable local acceptance and ordered observation Outbox delivery are implemented. Sharded durable logs, fixed snapshots, complete evaluation materialization and production cutover remain future work.

### Default project reservation

003 adds `projects` and `project_workspaces`. Existing workspace IDs, business rows, IAM bindings and CH keys remain unchanged; each workspace maps to `default`. New workspace creation and the default mapping commit together. A shared default project grants no additional access across users or workspaces.

`AuthorizedStorage(iam, facts)` defaults to `default`; an explicit `project_id='default'` is accepted. Empty/blank/other selectors fail closed. `project_context(credential, workspace_id)` returns an immutable context after workspace authorization. Scopes, list/analytics envelopes and cache fingerprints include the project; individual CH rows keep their existing workspace keys.

New targets apply001–014. Existing001/002/003 prefixes are validated without implicit upgrades. IAM/project contexts require003; current startup requires014 (basic Trace007, Dataset008, generation009, experiments010, DiagnosisRun011, Benchmark013 and issue resolution014) after explicit migration. Project UI, invitations and project-owner administration are future work. The Trace Web path switches only through the explicit mode flag; existing production data is not migrated by this setting.

### IAM and authorization

`IAMStore` provisioning methods (including account/password/group/workspace setup and names containing `for_provisioning`) are trusted administrative ports, not unauthenticated Web endpoints. Principals use stable IDs. Login names undergo NFKC/trim/casefold and then require1..128 ASCII login characters. Passwords require15..1024 characters and use PBKDF2-HMAC-SHA256 with600000 iterations and independent32-byte salts, following the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Sessions and API credentials contain random secrets, stored only as hashes. Sessions last at most24h; API credentials at most365 days and bind one workspace and explicit capabilities. Password changes/account disablement invalidate auth versions. Leaving a group permanently revokes its existing API credentials; rejoining does not revive them. IAM password/API protocols remain available internally; the product keeps its existing login page. Legacy keys are verified through existing authentication before explicit private mapping to current IAM credentials. Matching usernames cannot create identity bindings. Complete identity migration, recovery and distributed rate limits remain future work.

`AuthorizedStorage` validates a credential and derives the scope server-side. Client workspace selection cannot grant access; empty scopes deny. Group owners/admins can read all business resources in their group's workspaces. Members read their own or explicitly shared resources. Deleting owned resources requires the independent delete capability; viewers cannot write. Shared read access does not grant edit rights. Credential secrets and private evaluation gold stay outside ordinary business reads.

Trace/asset/run/snapshot/artifact roots have explicit ownership and sharing records. Spans and payloads inherit Trace authorization. New Trace routes and ownership records commit atomically. Future domain writers must establish ownership in the same business transaction. Metadata lists, single IDs, payloads, bounded downloads and analytics use the same policy. Unapproved artifact namespaces, including private gold, are excluded.

Slow ClickHouse reads happen outside control write transactions and revalidate access before returning. Scope fingerprints include principal/credential restrictions, group policy revisions, membership etags and workspace binding revisions; cache keys must include the current fingerprint and query. Non-active Traces are excluded from normal metadata and payload reads. Analytics applies the authoritative control-plane deletion barrier before CH catches up; scope changes during a query reject the result.

Members currently supply1..1000 authorized Trace roots per selected workspace for analytics; administrators may query a bounded workspace set. The query limit is4096 bound parameters and1000 deletion-barrier roots per workspace; larger scopes fail closed and require a narrower range. Large ACL/deletion dictionaries and streaming artifact ports are future extensions.

### Drivers and concurrency

SQLite uses `BEGIN IMMEDIATE` for writes. PostgreSQL/openGauss currently serialize control writes with a `schema_meta` row lock. Read-only transactions use WAL snapshots or `REPEATABLE READ READ ONLY` without this write lock. Password derivation and CH HTTP run outside write transactions. This verifies correctness, not thousand-client capacity; finer-grained CAS/queue partitioning and load testing remain necessary.

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

## Trace ingestion and bounded HTTP contracts

`ObservationIngest(control,facts)` exposes durable `accept`, fenced `work_once` and current-authorized `batch_status`. A complete packet is validated before locator writes; its private artifact is fsynced before one transaction registers routes, private ACLs, batch and Outbox. Receipt keys are workspace/principal scoped; reused keys with changed packets conflict. Accepted is distinct from indexed; write-only collectors may inspect their own receipts.

| Boundary | Current contract |
|---|---|
| Input | Completed OTLP Spans;4MiB JSON,4096 Spans and64MiB normalized expansion budget |
| Web protocol | JSON/protobuf/gzip through `/api/ingest/otel/v1/traces`; loopback backend receives JSON and API credentials |
| Identity | Default namespace `otlp`; service.name affects display only; cross-service native Trace IDs aggregate; explicit `agent_insight.source_namespace` isolates sources |
| Revision | Span `agent_insight.revision` defaults to1; stale ignored, same-version changed content quarantined; internal revisions allocated separately |
| Queue | Global earliest unsent `observability.otlp.accepted.v1`; active leases/retry delays block later events |
| Payload | At most128 Spans per bulk,4MiB per HTTP request; chunks up to256KiB and bundles up to64MiB; all chunks before manifests |
| Completion | Freeze heads/plan first, then payload→Span→summary; replay exact versions; indexed/sent only after every sink and valid fence |
| Summary | Delta counters, nullable unknown token totals and coverage; done/failed/running/unknown states |
| Pages | Trace default50/max200; Span default/max200; payload default/max4 chunks at the exact revision |

Trusted CH kernel reads still allow1000 structure rows or32 chunks; HTTP/UI impose the smaller limits above. Missing sections return available=false. Trace lists scan at most2000 authorized candidates, bind signed cursors to scope/filters and do not invent a global total.

`python3 -m services.storage.trace_service --config /private/trace-service.json` requires a private regular mode0600 JSON file. Control fields are sqlite(database), or postgresql/opengauss(dsn/schema/artifacts). ClickHouse fields are endpoint/database/user/password, plus cursor_secret_hex, controller_key_file, default_workspace, port and worker_enabled. Initialize/migrate control and CH explicitly beforehand: startup does not create tables or upgrade schemas. The service binds127.0.0.1 with32 concurrent request slots and503 overload rejection.

Set server-only `AGENT_INSIGHT_TRACE_STORAGE=core`, `AGENT_INSIGHT_STORAGE_CORE_URL` and `AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE`; restart Next after changes. The old public flag is a deprecated server alias only. Keep DATABASE_URL on an isolated legacy business database, never core.db. Original frontend login/key behavior is unchanged. The0600 mapping binds a verified legacy key hash/name to a current IAM principal, workspace and read/write/execute/delete delegated credential. Errors do not fall back to legacy Trace reads; unported domains still retain existing paths.

### Existing contracts and005

Four control tables hold immutable legacy IDs, versioned annotation overrides (including explicit nulls), owned tags and Trace/tag links. All use current authorization/deletion barriers. Migrations001–004 remain unchanged. Native OTLP aliases commit with new Trace acceptance; existing routes need explicit backfill.

Compatibility retains existing observe/data, observe/session, tags, execution tags and Trace bundle endpoints. List records/statistics/filter contracts currently enumerate authorized roots, capped at100000; indexed filtering and thousand-collector capacity remain unverified. Ordinary structure loads all lightweight Spans in pages of200, capped at100000/16MiB without payloads. Selection loads one fixed interaction index at its exact payload revision. Full sessions and exports cap at128MiB; native Langfuse views require full nodes/bodies as a distinct compatibility exception.

Bundle v1 imports cap at50MiB/500 executions, preflight the tree, remap IDs/references and return success only after indexing all batches. A receipt can resume the same input. Metadata edits do not rewrite source payloads. Result editing still requires the evaluation handoff and currently reports conflict. Trace backflow, ordinary experiment/result/RunPlan consumers and DiagnosisRun consumers use the new storage protocols below. Infra and non-OTLP external writers still have unported paths; restoring screens does not establish full feature migration.


This is an ordered single-queue/write-lock correctness baseline, not thousand-collector throughput, sharded durable logging or HA certification.

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
