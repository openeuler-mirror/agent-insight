---
title: "Agent runtime reference"
description: "Detection scope, status and capability semantics, HTTP API, and execution-entry constraints for platform built-in Agent runtimes."
keywords: ["Agent Insight", "Agent runtime", "runtime detection", "RUNTIME_SELECTION_UNAVAILABLE", "API reference"]
changefreq: "monthly"
---

Operating steps are in the [Agent runtime how-to guide, Chinese](../../../zh/how-to/platform/settings/agent-runtime.md).

## Detection scope

Detection covers only the deployment environment reachable by the **platform server process**. It checks `PATH` and the following overrides:

| Runtime | Environment variable | Additional candidate |
| --- | --- | --- |
| OpenCode | `OPENCODE_BIN` | `<package-root>/node_modules/.bin/opencode` |
| Pi | `AGENT_INSIGHT_PI_EXECUTABLE`, `PI_EXECUTABLE` | None |

The probe is always `<executable> --version` with fixed arguments and a 3-second timeout. Detection does not call models, install packages, or upgrade dependencies. Results are cached in-process for 30 seconds.

- On Windows, `PATH` lookup expands `PATHEXT` (including npm `.cmd` shims). `.cmd` / `.bat` files cannot be spawned directly, so they are run through `cmd.exe /d /s /c`; the command line remains a fixed literal and never interpolates caller input.
- On other platforms the executable is started directly with `shell: false`.

## Status

| Status | Selectable | Meaning |
| --- | --- | --- |
| `available` | Yes | Adapter delivered and version compatible |
| `not-installed` | No | No executable found in the deployment environment |
| `probe-failed` | No | Version probe failed, timed out, or returned unparsable output |
| `incompatible-version` | No | Version is below the minimum requirement |
| `adapter-missing` | No | Version compatible, but the platform has no execution adapter |

Minimum versions: Pi `0.82.1`, OpenCode `1.0.0`.

## Capabilities

Capabilities are declared by the adapter, not inferred from CLI flags. When no adapter exists, every capability is false.

| Capability | Meaning |
| --- | --- |
| `tool-policy` | Can apply tool disablement, read-only, and allowlist policies |
| `session-resume` | Can resume the native session across turns |
| `cancel` | Supports server-confirmed cancellation |
| `timeout` | Supports task-level timeout and abnormal-exit reclamation |
| `skill-loading` | Can load Skills deployed with the platform |
| `trace-attribution` | Execution facts can be attributed to the platform Trace |

## Personal default

The selection is stored in `UserSettings.settingsJson.agentRuntimeId`; no database migration is required.

- Not saved: the first selectable runtime in catalog order is used, with `source = platform-default`.
- Saved and available: `source = user`.
- Saved but unavailable: `status = unavailable`, `effectiveId = null`, with no fallback.
- Saved value unknown: `status = unavailable` and diagnostic `RUNTIME_SELECTION_INVALID`.

The default affects new tasks and new sessions only. Historical Executions, Sessions, and in-flight tasks keep their original binding.

## HTTP API

Both endpoints resolve the request identity first: when the request carries a resolvable credential identity (`x-witty-api-key` or `apiKey`), `user` must match it, otherwise the request returns `403`; deployments without credential identities keep using the `user` parameter.

### `GET /api/agent-runtime`

Query parameters: `user` (identity resolution, see [HTTP APIs and user identity](./http-api.md)) and `refresh=1` (force re-detection).

```json
{
  "checkedAt": "2026-11-09T00:00:00.000Z",
  "runtimes": [
    {
      "id": "opencode",
      "label": "OpenCode",
      "adapter": { "id": "opencode-general-agent", "label": "OpenCode general Agent", "capabilities": { "...": true } },
      "executable": { "path": "/opt/opencode/bin/opencode", "source": "environment" },
      "version": "1.1.39",
      "minimumVersion": "1.0.0",
      "status": "available",
      "selectable": true,
      "capabilities": { "tool-policy": true, "...": true },
      "diagnostics": [{ "code": "RUNTIME_READY", "message": "OpenCode 1.1.39 is ready for platform tasks." }],
      "checkedAt": "2026-11-09T00:00:00.000Z"
    }
  ],
  "preference": {
    "selectedId": null,
    "effectiveId": "opencode",
    "source": "platform-default",
    "status": "ready",
    "runtime": { "...": "Same shape as entries in runtimes" },
    "diagnostic": null
  }
}
```

### `PUT /api/agent-runtime`

Body: `{ "user": "<user>", "runtimeId": "opencode" }`. A `null` `runtimeId` clears the personal default.

The API re-detects and validates before writing. An unknown or unselectable runtime returns `409`:

```json
{
  "error": "Pi is not currently available for platform tasks.",
  "code": "RUNTIME_SELECTION_UNAVAILABLE"
}
```

## Execution entry

Platform built-in tasks all enter the execution layer through `runGeneralAgent`. The entry reads the personal default when each new task starts:

- Not saved, or set to `opencode`: the existing OpenCode execution path is used.
- Any other value: the task fails with `AGENT_RUNTIME_UNAVAILABLE`; the engine is never silently switched.

Once the Pi execution adapter ships, the entry dispatches by adapter internally and business modules stay unchanged.
