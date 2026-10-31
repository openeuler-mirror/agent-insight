---
title: "Backup and restore"
description: "Cold backups, restoration into a separate directory, and validation boundaries."
---

This guide covers stopped-service backups for self-hosted Agent Insight. The default SQLite deployment can be backed up with its runtime directory. External databases, configuration directories, storage, and independent clients need their own backups. There is no unified `backup` / `restore` CLI command.

## Scope

| Object | Default or discovery | Backup action |
| --- | --- | --- |
| Runtime root | `AGENT_INSIGHT_HOME`, default `~/.agent-insight` | Copy the whole directory with structure and permissions |
| Platform settings | Runtime-root `.env` | Include it; restrict access because it can contain secrets |
| SQLite | `data/witty_insight.db`, unless `DATABASE_URL` overrides it | Stop all writers before copying; copying only a live main database file is insufficient |
| Business files, Trace cache, consumer state | Runtime-root `data/` and related directories | Back up with the database; do not restore checkpoints independently of pending data |
| Benchmark settings | Installation `config/benchmark/` or `AGENT_INSIGHT_CONFIG_DIR` | Separately retain local overrides and original paths |
| External database, mounts, symlink targets | Inspect actual deployment settings | Use consistent database-native backups and back up external directories; the tar example does not include them |
| Collectors, RAS/FI clients, Evaluator | Each host's own configuration/storage | Back up per host; the platform directory does not contain every client state |

Record version, commit/image digest, deployment method, and runtime user. Keep application and data versions together. See [configuration](../../reference/platform/configuration.md).

## Cold backup on macOS / Linux

1. Pause new experiments, evaluations, and writes. Let tasks finish, or cancel them through their existing controls and confirm exit.
2. Stop the platform and every collector, worker, or client writing into the same root. An npm CLI deployment can use `agent-insight stop --port 3000`, replacing the port as needed. Stop Docker/systemd deployments through their original tooling. Stopping the platform alone does not stop all independent processes.
3. Confirm writing has stopped. This example assumes SQLite is inside the root; back up external storage separately.

```bash
# Use the absolute path from the actual deployment.
insight_home="${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
umask 077
# The backup directory must be outside the runtime root.
backup_dir="$(mktemp -d "$HOME/agent-insight-backup.XXXXXX")"
tar -czf "$backup_dir/runtime.tar.gz" -C "$insight_home" .
tar -tzf "$backup_dir/runtime.tar.gz" >/dev/null
printf 'Backup: %s\n' "$backup_dir/runtime.tar.gz"
```

Confirm each command succeeds before continuing. An archive listing proves readability, not recoverability. Retain SQLite auxiliary files that exist in the stopped directory; do not manually remove `-wal`, `-shm`, or consumer checkpoints before backup. Archives can contain model credentials, user information, and Trace content and should not be placed in a public repository.

## Restore into a new directory

Use the application version matching the backup. Preserve the original directory rather than overwriting it. Only extract a trusted backup you created and inspected.

```bash
umask 077
backup_file="/absolute/path/to/runtime.tar.gz"
restored_home="$(mktemp -d "$HOME/agent-insight-restore.XXXXXX")"
tar -tzf "$backup_file" >/dev/null
tar -xzf "$backup_file" -C "$restored_home"
printf 'Restore directory: %s\n' "$restored_home"
```

Before starting, check the restored `.env` and launch environment:

- Change an old absolute `DATABASE_URL` to the restored database, for example `file:/absolute/restore/path/data/witty_insight.db`. Default SQLite settings can remain empty. Also check process-level overrides.
- Restore external databases into a separate instance/database and update connection settings. A runtime-directory archive does not restore them.
- Check configuration paths, mounts, symlinks, ownership, and permissions. Do not start two instances against one root or manually delete lock files to force startup.
- Isolate external collectors, execution clients, and real model calls during the drill so automatic retries or background tasks cannot affect production.

After these checks, an npm CLI deployment can start on another port:

```bash
AGENT_INSIGHT_HOME="$restored_home" agent-insight start --port 3100
```

Source deployments use the matching `scripts/start.sh`; Docker mounts the restored directory at its container runtime root. Verify login, historical Traces, experiments, and attachments before switching service ports, entry points, and client connections. Decide retention of the original data only after validation.

## Validation and limits

At minimum, check startup for database errors, existing-user login, sampled historical Traces/experiments, attachment access, and new data after re-enabling collection. Confirm the intended restored database changes, avoiding an accidental connection to the original database.

These procedures are not a completed production recovery drill. Validate external databases, Windows services, and container mounts for the actual deployment. See [upgrade and rollback](./upgrade-and-rollback.md) for application/data version pairing.

[中文权威版本](../../../zh/how-to/platform/backup-and-restore.md)
