---
title: "Storage core and legacy export"
description: "Isolated core storage, baseline DDL, and read-only legacy SQLite migration inputs."
---

# Storage core and legacy export

`services/storage/` is the first Python foundation for the storage refactor. It requires Python 3.11+ and uses only the standard library. Existing Next.js/Prisma storage remains the platform default; these commands do not switch the running application.

The baseline defines 21 transactional and 13 ClickHouse core tables, including four supporting tables added during refinement. This does not cover every planned domain. The SQLite repository implements immutable asset releases, dependency sealing, draft/alias CAS, frozen run inputs, leases/fencing/cancellation, verified local result artifacts, and transactional receipts/Outbox. PostgreSQL and openGauss have separate DDL candidates; PostgreSQL has an actual-engine contract test. Their business runtime adapters are not enabled, and openGauss is not certified.

The ClickHouse HTTP adapter writes trusted canonical Span versions, reads latest state and individual Spans, and supports chunked multi-section payload bundles. Each bundle has one manifest revision, published after all chunks, with section and chunk hashes. Requests are capped at 4MiB and payload bundles at 64MiB. The adapter is not an ingestion materializer: conflicting content at the same entity revision must be rejected upstream. Partial multi-request writes require idempotent replay; Kafka ownership, snapshot publication, and automatic Outbox delivery remain future work.

Workspace foreign keys protect data-reference ownership; they do not authenticate callers. Password login, groups, and group-admin authorization remain planned. Web adapters must derive and validate access scopes on the server.

## Commands

Run from the repository root. Every database path is explicit; no command defaults to an existing application database.

```bash
python3 -m services.storage schema --backend sqlite
python3 -m services.storage schema --backend postgresql
python3 -m services.storage schema --backend opengauss
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
```

`schema` prints DDL only. SQLite initialization creates a new file under an existing parent directory, or verifies an existing core version/checksum. It refuses existing Prisma databases. New SQLite targets use WAL/FULL and enforce foreign keys; they remain single-host, single-writer databases.

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

Legacy reads use one read-only transaction, including committed WAL data. Integrity or foreign-key violations block export instead of being repaired. Output directories must not exist; directories use 0700 and files 0600. Exports contain original values, including credentials, and are not sanitized reports. CLI stdout excludes row contents, schema SQL, and column defaults.

Typed JSONL preserves duplicate rows and SQLite value types. The complete manifest binds ordered physical column metadata, schema fingerprint, row counts, and byte/content hashes. The verifier rejects incomplete, corrupt, truncated, extra/missing files and symlinks/path traversal. Hashes prove internal integrity, not signed provenance. Large inventories scan tables and may require temporary sorting space; use a maintenance window or consistent backup. Full transformation/import, change capture, production cutover, and reverse-delta rollback are not implemented by these commands.

## Contracts and tests

`manifest-json/v1` sorts ASCII keys and encodes UTF-8 without Unicode normalization. Floats are rejected; fixed decimals and integers beyond the JavaScript safe range use decimal strings. Revisions/fences/etags are in 1..2^63-1. Published asset content and dependencies are immutable. Run inputs cannot change after draft, and callback Case/evaluator ownership is frozen. Result acceptance is distinct from ClickHouse visibility and final publication.

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
STORAGE_TEST_PG_CONTAINER=your-isolated-postgres-container python3 -m unittest discover -s services/storage/tests -p test_schema.py -v
```

ClickHouse integration tests require an explicit isolated origin:

```bash
STORAGE_TEST_CLICKHOUSE_URL=http://127.0.0.1:your-test-port python3 -m unittest discover -s services/storage/tests -p test_clickhouse_integration.py -v
```

This test creates and drops a randomly named database on the supplied instance; use test instances only. Without the variable, ClickHouse integration tests are explicitly skipped.

The PostgreSQL test uses an isolated container and a temporary schema rolled back after testing; it is explicitly skipped without the environment variable. Tests do not establish openGauss compatibility, HA, thousand-client capacity, or browser acceptance. See the [Chinese reference](../../../zh/reference/platform/storage-core.md) and `design/platform/analytical-transactional-storage/` for the full core dictionary and the 96-model legacy mapping.
