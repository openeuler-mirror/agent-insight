---
title: "Upgrade and rollback"
description: "Upgrade by deployment method while keeping application and data versions together."
---

An upgrade changes application version, database schema, and runtime state together. Agent Insight installation and startup can synchronize the database schema. Replacing the binary with an older version does not guarantee compatibility with upgraded data. There is no unified `upgrade` / `rollback` CLI command.

## Before upgrading

1. Record the current package version, source commit or image digest, runtime root, database, external configuration directories, and client versions.
2. Choose an explicit target release and read its changes and configuration-migration requirements. Retain the current package, runnable source build, or image.
3. Pause new work and writes, stop the platform and related writers, and [back up](./backup-and-restore.md) before installing. npm `postinstall` can also synchronize the schema.
4. Prefer testing the target version against a backup copy, using a separate runtime root, database, and port and isolating real clients and model calls.

Existing `.env` files are not automatically filled with every new template setting. Compare with the target version's template, preserving local secrets and real addresses instead of overwriting the file. See [runtime configuration](../../reference/platform/configuration.md).

## Update using the original deployment method

| Method | Update | Retain |
| --- | --- | --- |
| npm | After stopping and backing up, install the explicit version in the original installation scope. For global installations, use `npm install -g agent-insight@<target-version>` with the original runtime user and root | Previous version/package, runtime root, external configuration, and database backup |
| Source | Check out the target commit in a separate deployment directory, follow that version's dependency/build instructions, validate, then switch the startup directory. Continue using `bash scripts/start.sh` for production startup | Previous commit and runnable build, plus runtime data; do not overwrite an uncommitted development checkout |
| Docker | Change the deployment to an explicit image tag or digest. Stop the old container, then start the new one with the expected persistent mounts | Previous image digest, deployment configuration, and volume backup; do not run two containers against one runtime root |

Replace angle-bracket placeholders before executing. Avoid changing deployment method or database type as part of the same upgrade. See the [repository README](https://gitcode.com/openeuler/agent-insight/blob/master/README.md) for source builds and [Docker image publishing, Chinese](../../../zh/how-to/platform/release-docker-image.md) for image materials.

## First startup and acceptance

Start through the original deployment entry point and inspect configuration, database synchronization, and background-task logs. If synchronization warns about data loss, stop and review the schema difference. `prisma db push --accept-data-loss` is not a routine upgrade step.

Before restoring external writes, verify:

- Login, historical Traces, experiments, and attachments remain accessible.
- Model/client settings remain present, and runtime/database paths are correct.
- A controlled client can send one Trace through receipt, consumption, and UI display.
- If evaluation or reliability features are used, one existing small case works with the independent Evaluator and RAS/FI clients. Upgrade clients individually when the release requires it.

A successful installation, reachable port, or health response alone does not prove data or workflow compatibility.

## Rollback

1. Stop the new version and related writers. Preserve upgraded data separately, noting which Traces and experiments were created after the upgrade.
2. Restore the old application version or image.
3. Restore its pre-upgrade backup into a new runtime root or independent database. Follow [restore steps](./backup-and-restore.md), including absolute-path checks, before starting the old version.
4. Verify login, historical data, and a core case, then switch the service entry point and clients back.

When the schema changed, default to the old version's matching pre-upgrade backup. A binary downgrade does not automatically downgrade the database. Post-backup data will not appear automatically; retain it separately for possible export/migration instead of mixing database files.

Compatibility across arbitrary versions is not guaranteed. Retain logs, versions, and configuration differences for troubleshooting, and remove secrets or sensitive business data before sharing them.

[中文权威版本](../../../zh/how-to/platform/upgrade-and-rollback.md)
