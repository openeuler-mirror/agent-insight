---
title: "Storage core, IAM and safe migrations"
description: "SQLite, PostgreSQL and openGauss control storage, authorized ClickHouse access and legacy exports."
---

# Storage core, IAM and safe migrations

`services/storage/` is a Python 3.11+ foundation. SQLite, IAM and ClickHouse use the standard library; relational servers use an explicit DB-API connection factory. Next explicitly opts into core Trace ingestion, listing, Span/payload reads and separate password login. Other domains are not fully switched. Leaving the flag unset preserves the legacy path; offline commands do not switch a running application. See the [isolated setup guide](../../how-to/platform/storage-core.md).

See the [table relationship guide](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序) for all48 table purposes, primary/unique/query keys and eight overview/relationship diagrams. It distinguishes database foreign keys from logical references across databases. The diagrams and full dictionary are maintained in Chinese.

## Implemented contracts

`001_core.sql` remains byte-for-byte unchanged:21 transactional and13 ClickHouse tables. `002_iam.sql` adds10 IAM tables, 003 adds2 project-directory/binding tables and004 adds2 ingestion/entity-version tables, for **35 transactional +13 ClickHouse =48**. The complete field/type/constraint/index dictionary is in `design/platform/analytical-transactional-storage/core-table-dictionary.md`.

All three transactional backends share immutable releases/dependencies, draft/alias CAS, frozen RunPlan inputs, task leases/fences/cancellation, artifact verification and atomic result receipt/Outbox writes. ClickHouse supports trusted canonical Span batches, latest-state filtering, single-Span and paginated structure reads, exact-revision payload bundles with chunk/manifest hashes, and bounded analytics. Requests are capped at4MiB; payload bundles at64MiB.

The004 observation materializer rejects changed content at the same source revision, ignores older revisions and replays a frozen plan after partial writes. Durable local acceptance and ordered observation Outbox delivery are implemented. Sharded durable logs, fixed snapshots, complete evaluation materialization and production cutover remain future work.

### Default project reservation

003 adds `projects` and `project_workspaces`. Existing workspace IDs, business rows, IAM bindings and CH keys remain unchanged; each workspace maps to `default`. New workspace creation and the default mapping commit together. A shared default project grants no additional access across users or workspaces.

`AuthorizedStorage(iam, facts)` defaults to `default`; an explicit `project_id='default'` is accepted. Empty/blank/other selectors fail closed. `project_context(credential, workspace_id)` returns an immutable context after workspace authorization. Scopes, list/analytics envelopes and cache fingerprints include the project; individual CH rows keep their existing workspace keys.

New targets apply001–004. Existing001/002/003 prefixes are validated without implicit upgrades. IAM/project contexts require003; the Trace HTTP service requires current004 after an explicit migration. Project UI, invitations and project-owner administration are future work. The Trace Web path switches only through the explicit mode flag; existing production data is not migrated by this setting.

### IAM and authorization

`IAMStore` provisioning methods (including account/password/group/workspace setup and names containing `for_provisioning`) are trusted administrative ports, not unauthenticated Web endpoints. Principals use stable IDs. Login names undergo NFKC/trim/casefold and then require1..128 ASCII login characters. Passwords require15..1024 characters and use PBKDF2-HMAC-SHA256 with600000 iterations and independent32-byte salts, following the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Sessions and API credentials contain random secrets, stored only as hashes. Sessions last at most24h; API credentials at most365 days and bind one workspace and explicit capabilities. Password changes/account disablement invalidate auth versions. Leaving a group permanently revokes its existing API credentials; rejoining does not revive them. Core now has password login, a separate HttpOnly/SameSite=Strict cookie, same-origin checks for login/logout and a single-instance login rate limit. Account recovery, external identity binding and distributed rate limits remain future work. Legacy username registration/keys do not authenticate core.

`AuthorizedStorage` validates a credential and derives the scope server-side. Client workspace selection cannot grant access; empty scopes deny. Group owners/admins can read all business resources in their group's workspaces. Members read their own or explicitly shared resources; viewers cannot write. Shared read access does not grant edit rights. Credential secrets and private evaluation gold stay outside ordinary business reads.

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
python3 -m services.storage schema --backend postgresql --version 4
python3 -m services.storage schema --backend opengauss --version 4
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/core.db
python3 -m services.storage migrate-sqlite --database /absolute/path/to/core.db --backup /absolute/path/to/new-backup.db
```

`schema` only prints DDL. New targets apply001–004; existing known001/002/003 prefixes are validated without implicit upgrades. IAM/project contexts require003 and the Trace HTTP service requires current004, both through explicit migration. Unknown versions, history gaps and checksum drift fail closed. Existing Prisma databases are not altered in place.

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

`python3 -m services.storage.trace_service --config /private/trace-service.json` requires a private regular mode0600 JSON file. Control fields are sqlite(database), or postgresql/opengauss(dsn/schema/artifacts). ClickHouse fields are endpoint/database/user/password, plus cursor_secret_hex, default_workspace, port and worker_enabled. Initialize/migrate control and CH explicitly beforehand: startup does not create tables or upgrade schemas. The service binds127.0.0.1 with32 concurrent request slots and503 overload rejection.

Set `NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE=core` and server-side `AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319`; rebuild/restart after changing the public flag. Keep DATABASE_URL on a separate legacy shell database, never core.db. Core sessions use separate cookies and never expose tokens to browser JS. Unset mode retains legacy selection; enabled-mode errors do not fall back to the old store. See the [setup guide](../../how-to/platform/storage-core.md) for complete provisioning and private configuration.

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

## Verification boundaries

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

`STORAGE_TEST_PG_CONTAINER` enables psql DDL tests; `STORAGE_PG_DSN` enables PG control contracts; `STORAGE_TEST_PG_CONFIG` and `STORAGE_TEST_OPENGAUSS_CONFIG` point to private JSON files containing `dsn`; `STORAGE_TEST_CLICKHOUSE_URL` selects a test CH instance. `STORAGE_OBSERVATIONS_PG_CONFIG` enables ingestion contracts with a private PG JSON connection file (dsn or kwargs). Native openGauss requires the matching Linux/Python driver environment. Missing variables explicitly skip the corresponding tests.

Tests create/drop random schemas/databases and must target isolated instances. They cover safe migration/rollback, current IAM authorization, real transactions and10,000-Span workflows, not HA, production migration, thousand-client capacity or browser acceptance. Latest counts and engine evidence are in `design/platform/analytical-transactional-storage/implementation-status.md`; the [Chinese reference](../../../zh/reference/platform/storage-core.md) is authoritative.
