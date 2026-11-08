---
title: "Reliability client and configuration control APIs"
description: "HTTP contracts for installation tokens, device identity, capabilities, configuration snapshots, and control channels."
---

This page covers existing HTTP methods under `/api/reliability/`, plus `/api/agent-ras/config` and `/api/agent-ras/catalog`, at baseline `eabde5b0`. Saving, notification, writing, and RAS loading are separate stages. A successful response does not prove a configuration is effective. See [local installation, Chinese](../../../zh/how-to/reliability/agent-ras/local-install-process.md) and [HTTP APIs and user identity](../platform/http-api.md).

Fault-injection task creation, stopping, reruns, and legacy Worker APIs under `/api/fault-injection/` are outside this page's scope; see [running fault injection, Chinese](../../../zh/how-to/reliability/agent-fault-injection/run-injection.md). RAS event ingestion is also a separate protocol.

## Identity and credentials

| Caller | Credential and boundary |
| --- | --- |
| Platform user | Client lists, installation tokens, and client configuration use `resolveUser`. A nonempty explicit `user` can take precedence over the Key; it is compatibility identity selection, not credential verification. Integrations should send `x-witty-api-key` and avoid an overriding `user` |
| Installer | A one-use `installToken` in the registration body. Default lifetime: 600 seconds; `expiresInSeconds` is clamped to 60–3600 seconds. Used tokens return `409`, expired tokens `410`, and invalid tokens `401` |
| Registered device | `Authorization: Bearer <deviceCredential>`. Device HTTP endpoints optionally accept `x-agent-insight-client-id`; a mismatch returns `403`. The credential is returned only at registration, and its hash is stored. The implementation sets no fixed expiry; revocation or re-registration invalidates the old credential |
| Internal control service | `x-agent-insight-internal` must match `AGENT_INSIGHT_INTERNAL_TOKEN` (default `local` when unset). It protects the three `control-*` bridges, rather than using a user Key or device credential; failures return `403 INTERNAL_ONLY` |

There is no generic `controlToken` request field replacing these identities. A WebSocket handshake requires both the device Bearer credential and `x-agent-insight-client-id`; the optional-header convention of ordinary device HTTP endpoints does not apply to the handshake.

## Platform queries and installation

| Method and path | Input | Successful response and limits |
| --- | --- | --- |
| `GET /api/reliability/clients` | Query `page` defaults to 1; `pageSize` defaults to 20 and is clamped to 1–100; optional `status`, `keyword`, compatibility `user` | `200 { items, page, pageSize, total }`. Merges registered clients and legacy FI Workers, deduplicates, and sorts by descending `lastSeenAt`. Items include `id`, host/IP, `status`, `serviceHealth`, platform capabilities, `legacy`, and `controlChannel`. The current implementation retrieves at most 100 registered clients before merging Workers; `total` describes that merged set, not an unlimited registry count |
| `POST /api/reliability/install-tokens` | Optional JSON `name`, `platform`, `expiresInSeconds`, compatibility `user` | `201 { installToken, expiresAt, user, commands: { unix } }`. The token is exchanged during registration. The setup command's server address comes from the request/forwarded headers |
| `GET /api/reliability/config-schemas/:platform` | `platform`: `opencode/openjiuwen/xiaoo` | `200` built-in Schema with `schemaVersion/platform/configVersion/defaults/sections/editable/source/updatedWithProductVersion`; `editable: false`, `source: builtin`. No user authentication; unknown platforms return `404 PLATFORM_SCHEMA_NOT_FOUND` |
| `GET /api/reliability/fault-modes` | Optional query `platform` | `200 { items, registryVersion }`. Items contain `id/name/description/supportedPlatforms/parameters/submodes` and optional injection-method fields. Unknown platforms produce an empty collection. The route resolves a user without rejecting empty identity; success does not validate a Key |

Lists and tokens return `401` when no user is resolved. The online window defaults to 90 seconds, configurable through `AGENT_INSIGHT_RAS_CLIENT_ONLINE_SEC` with a 30-second minimum. Service health and connectivity are separate fields. `controlChannel: none` does not preclude command reception: clients with fresh heartbeats can still long-poll.

## Device registration, heartbeat, and capabilities

Device paths below use the prefix `/api/reliability/client/v1`.

| Method and path | JSON input | Successful response |
| --- | --- | --- |
| `POST /register` | Required `installToken`; optional `client: { name, hostname, ip, os, arch, agentVersion, supervisor, machineId }`, `capabilities`, `previousClientId` | `201 { clientId, user, deviceCredential, unboundPrevious, reused, control }`. `control` contains `websocketUrl/pollUrl/heartbeatIntervalSeconds/ackTimeoutSeconds` |
| `POST /heartbeat` | Optional `agentVersion`, `status`, `service: { processStartedAt, supervisor, watchdog, restartCount }` | `200 { serverTime, nextHeartbeatSeconds, refreshCapabilities }`. Updates connectivity/health only and carries no commands. The default window suggests a 30-second interval |
| `PUT /capabilities` | Optional `revision`, `partial`, `hostname/reportedIp/os/arch`; capability fields `platforms/actions/components/executionProfiles/faultInjection` | `200 { acceptedRevision, serverTime }`. Replaying the same nonempty revision is a no-op. `partial: true` merges capabilities; otherwise normalized capabilities replace the old value. Concurrent merge conflicts can return `409 CAPABILITIES_UPDATE_CONFLICT` |

All except registration require device credentials. `observedIp` comes from the connection and cannot be overridden in the body. Platform capability entries can contain `id/version/models/agents/actions`, `runExperimentCase`, `runBenchmarkCase`, and parameter definitions. `faultInjection.ready: false` disables that capability without preventing the entire client from coming online.

Re-registration with the same user and `machineId` reuses the record and rotates the credential, revoking the previous one. When `previousClientId` identifies a binding being replaced, the old record is unbound and its credentials are revoked while history is retained. Registration/rebinding and installation-token consumption share one transaction. A consumed token cannot retrieve the original credential through another POST; retain the first response and use the installer flow to recover from a lost response.

## Client configuration and synchronization

The configuration path is `/api/reliability/clients/:clientId/config`, scoped by user, client, and platform. Ownership is checked first; a client belonging to another user also returns `404 CLIENT_NOT_FOUND`. The default platform is `opencode`; supported platforms match the Schema endpoint.

| Method | Input | Successful response and status |
| --- | --- | --- |
| `GET` | Query `platform`, compatibility `user` | `200 { clientId, platform, schemaVersion, builtinConfigVersion, revision, overrideDiff, effectiveConfig, fieldSources, delivery }`. `fieldSources` distinguishes `builtin/client_override` |
| `PUT` | JSON `overrideDiff`; optional finite numeric `expectedRevision`, `sync`, `platform`, compatibility `user`. Query platform takes precedence | Save only: `200 { revision, status: saved, saved: true }`. Notification created: `202` with `revision/status/configRef/configVersion/checksum/deliveryId/commandId`. Saved but client offline: still `200`, with `saved: true`, `status: notify_failed`, and `sync.status: failed` |
| `DELETE` | Optional query `path`, `platform`, `sync=true`, compatibility `user` | Removes overrides to restore built-in values. Without `path`, clears all overrides; a specified path removes that key and its descendants. Returns a new `revision` and save/sync fields using PUT's `200/202` semantics; does not delete the client or historical snapshots |
| `POST /api/reliability/clients/:clientId/config/sync` | Optional JSON `configRef/platform/user`; query platform takes precedence | Reuses the specified snapshot or the latest delivery's snapshot without increasing configuration revision. `202 { deliveryId, commandId, configRef, configVersion, status }`. Missing snapshot `404`, wrong owner `403`, platform mismatch `409`, offline client `503` |

`overrideDiff` is the **complete override set** keyed by dotted field paths, not an automatically merged patch. `{}` clears overrides; omitting a valid object retains the existing set. Schema validation failures return `400 CONFIG_FIELD_INVALID`, with per-field reasons in `details.fields`. A valid `expectedRevision` differing from the current value returns `409 CONFIG_REVISION_CONFLICT` and the current revision.

```json
{
  "expectedRevision": 3,
  "overrideDiff": { "enabled": true },
  "sync": false
}
```

First GET the revision and every override you need to preserve. Repeated PUTs increase revision; this is not a generally idempotent endpoint. `sync: true` freezes an immutable snapshot and notifies the client. Saving while offline is not rolled back and does not queue notification for reconnection. Confirm the client can receive commands, then explicitly request synchronization. After a save without sync, an older delivery is not evidence that this save is effective.

## Snapshot retrieval and RAS load reports

| Method and device path | Request | Response and boundary |
| --- | --- | --- |
| `GET /config-snapshots/:configRef` | Device credential; optional `If-None-Match` | `200 { configRef, clientId, platform, scope, schemaVersion, configVersion, checksum, correlation, expiresAt, config }`. `ETag` is the quoted checksum; an exact match returns `304`. Snapshots default to a seven-day lifetime. Missing `404`, wrong device `403`, expired `410`. Retrieval advances applicable deliveries to `pulling`, including before a cache-hit response |
| `POST /config-loads` | Required `platform/configVersion/status`; optional `scope/checksum/rasProcessId/loadedAt/error` | `200 { ok: true, deliveryStatus }`. `loaded/version_mismatch` retain their meaning; other nonempty status values become `failed`. Missing required fields return `400`. Reporting `loaded` with a version differing from the latest delivery returns `409 CONFIG_VERSION_MISMATCH`. With no delivery, the result is `saved` |

| Delivery status | Meaning |
| --- | --- |
| `saved` | The server saved overrides |
| `sync_notified` | A synchronization delivery exists, possibly awaiting WebSocket or polling; no write confirmation |
| `pulling` | A client retrieved the snapshot; the compatibility RAS pull path also proves only retrieval |
| `written` | A configuration command received client `SUCCEEDED` with explicit `result.state: WRITTEN` |
| `ras_loaded` | RAS reported `loaded` with a matching version through `config-loads` |
| `notify_failed/pull_failed/write_failed/load_failed/version_mismatch` | Stage failure or version mismatch; inspect `delivery.error` and relevant versions |

Observe results through the configuration GET's `delivery`. Saving or receiving a command ACK does not let the server confirm a client write; writing does not automatically prove successful RAS loading.

## Commands and WebSocket bridges

`GET /api/reliability/client/v1/commands/next?waitSeconds=25` uses device authentication. Long polling defaults to 25 seconds, caps at 30 seconds, and checks every 500 ms. The current expression treats `0` as the default 25 seconds too. An available command returns a `200 COMMAND` frame; no command or the request ending returns `204`:

```json
{
  "type": "COMMAND",
  "commandId": "cmd_example",
  "action": "APPLY_CLIENT_CONFIG",
  "createdAt": "2026-11-02T00:00:00.000Z",
  "expiresAt": "2026-11-02T00:00:30.000Z",
  "payload": {
    "platform": "opencode",
    "scope": "client",
    "configRef": "cfg_example",
    "configVersion": "example-version",
    "checksum": "example-checksum"
  }
}
```

These references and values are examples; use the actual delivered frame. The action whitelist is `APPLY_CLIENT_CONFIG/PREPARE_EXPERIMENT_CASE/RUN_EXPERIMENT_CASE/RUN_BENCHMARK_CASE/CANCEL_EXPERIMENT_RUN/REFRESH_CAPABILITIES/PREPARE_EXECUTION_ENVIRONMENT`. Top-level payload fields for `RUN_EXPERIMENT_CASE/RUN_BENCHMARK_CASE/PREPARE_EXECUTION_ENVIRONMENT` forbid `command/shell/args/cwd/executable/script`; other whitelisted actions forbid `url/config/path/downloadUrl/file`. Execution-environment preparation additionally validates the context structure and digest. This is not an arbitrary command execution endpoint.

`POST /api/reliability/client/v1/commands/:commandId/status` uses device credentials. JSON contains `status` and optional `occurredAt/result/error`. Allowed statuses are `RECEIVED/RUNNING/SUCCEEDED/FAILED`; success returns `200 { ok: true }`. Invalid status returns `400`, missing or another device's command `404`, and an expired nonterminal command `410`. Terminal commands are not rewritten by later receipts; configuration deliveries still need the write/load checks above.

The WebSocket upgrade at `/api/reliability/client/v1/control` is handled by `scripts/control-server.js`, not a normal Route Handler. The server sends the same `COMMAND` frame; the client sends `COMMAND_STATUS`, adding `type/commandId` to the HTTP receipt fields. A new connection replaces the previous one for the same clientId. These HTTP endpoints are internal control-service bridges only:

| Internal POST path (under the device prefix) | Body | Successful response |
| --- | --- | --- |
| `/control-auth` | `authorization`, `clientId` | `{ clientId, user }`, after internal authentication and device-credential validation |
| `/control-presence` | Required `clientId`, `connected: true/false` | `{ ok: true }`. Connection establishment refreshes lastSeenAt; disconnect leaves offline detection to the heartbeat window |
| `/control-receipt` | Required `clientId/commandId`, `status`, optional `occurredAt/result/error` | `{ ok: true }`, sharing the device HTTP receipt handler |

Writing to a WebSocket proves only that data was written to the socket; client `RECEIVED` confirms receipt. The ACK window defaults to 5 seconds (`AGENT_INSIGHT_RAS_ACK_TIMEOUT_SEC`, minimum 1 second). Generic command TTL defaults to 30 seconds (`AGENT_INSIGHT_RAS_COMMAND_TTL_SEC`, minimum 5 seconds), with per-task TTL overrides possible. Timeouts produce `DELIVERY_FAILED/EXPIRED`; a network failure is not grounds for endless duplicate synchronization or proof that a process exited.

## User-level RAS capability configuration

These APIs manage a user × platform capability envelope, separate from client configuration revisions and immutable snapshots. Both `GET/PUT /api/agent-ras/config` require a resolved user, reading Key authentication from the request without a body-level explicit-user selector.

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/agent-ras/config` | Required query `platform`; optional `format=yaml/json-export` | Normally `200 { status: ok, envelope }`. Export modes directly return YAML/JSON text rather than the default envelope wrapper |
| `PUT /api/agent-ras/config` | Required query `platform`; optional JSON `syncEnabled/config/platformExtras` | `200 { status: ok, envelope }`. `config` contains `enabled`, `detectors`, and `recovery.notify_user_on_warning`, validated using defaults and catalog Schema. Omitting config retains the old value; a supplied valid object is filled from defaults, not treated as an arbitrary deep patch |
| `GET /api/agent-ras/catalog` | Optional `force=1` refresh | `200 { status: ok, catalog }`; capability domains, detectors, and Schemas come from the RAS catalog. Resolves a user without rejecting empty identity |

Supported platforms are `opencode/openjiuwen/xiaoo`; missing/invalid platforms return `400 invalid_platform`, missing identity `401`, and configuration validation failures `400 validation_error`. The envelope includes `platform/syncEnabled/revision/updatedAt/config/platformExtras`; revision increases only when values change. Automatic synchronization currently supports `opencode/xiaoo`; `openjiuwen` normalizes `syncEnabled` to false. Saving an envelope does not prove a process loaded it.

## Errors and implementation sources

Device, token, and list endpoints generally return `{ error: { code, message, details? } }`. Client configuration uses `{ error, code, revision?, details? }`; agent-ras routes also use `{ error, detail/message }`. Do not impose one parser on all endpoints. Unexpected failures commonly return `500`. Inspect HTTP status and the endpoint before fixing inputs, refreshing revision, reinstalling a device, or investigating delivery. Writes have no generic idempotency-key contract.

Sources at the documented baseline: [registration and identity](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/client-registry.ts), [client configuration service](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/client-config-service.ts), [command bus](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/command-bus.ts), [receipt handling](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/command-receipt.ts), [WebSocket server](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/scripts/control-server.js), and [RAS configuration model](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/ingest/ras/capability-config.ts). This page documents code contracts rather than real-device/network end-to-end acceptance results.

[中文权威版本](../../../zh/reference/reliability/client-control-api.md)
