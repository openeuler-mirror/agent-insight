---
title: "Skill management HTTP APIs"
description: "Existing asset discovery, version and file, upload, publishing, and synchronization interfaces."
---

This page covers 22 existing HTTP methods for Skill asset management. For UI operations, see [Skills management, Chinese](../../../zh/how-to/optimization/skills/manage.md). Generation and optimization sessions, optimization points, static evaluation, Benchmark generation, flow parsing, and workbench experiments are outside this page's detailed scope. See the [Skill workbench, Chinese](../../../zh/explanation/optimization/skills/workbench-overview.md) and [Skill evaluation and experiments, Chinese](../../../zh/explanation/evaluation/skills/overview.md). This is not a complete contract for every Skill route.

## Identifiers and identity

Prefer `name` for external references, URL-encoding it in paths. Existing `:id` routes still take the Skill database ID; a name is not a substitute. Integer `version` is the local version number, starting at `0`; an enterprise `semanticVersion` is a separate field.

Identity handling is not uniformly enforced authentication:

| Interface category | Current behavior |
| --- | --- |
| Routes using `resolveUser` | A nonempty explicit `user` takes precedence over a Key; otherwise `x-witty-api-key` is resolved, with query `apiKey` used only when that header Key is absent. Explicit `user` is not a verified credential. See [HTTP identity conventions](../platform/http-api.md) |
| `canAccessSkill` paths | Public Skills, ownerless Skills, matching owners, and an empty identity pass. A nonempty identity accessing another owner's private Skill is denied. Success does not prove ownership was authenticated |
| Management-center and name-based version/file routes | Require a nonempty resolved identity, while retaining explicit `user` compatibility. The management center selects owned, shared, and public assets; name-based version/file routes additionally select the exact `sourceOwner` and check visibility |
| Legacy version-list and single-version `GET` | Query by ID without calling user resolution or access checks in the route |
| `automation/push` | Uses the JSON `user` directly, without `resolveUser`; an API Key does not replace the required `user` |

Set deployment access boundaries together with existing access controls. These compatibility paths do not establish account isolation for all routes. This page describes implementation behavior; this documentation work does not change permission logic.

## Asset discovery

| Method and path | Parameters and successful response | Main errors |
| --- | --- | --- |
| `GET /api/skill-management/skills` | `search` is trimmed and limited to 100 characters; `category` to 80. `source=all/uploaded/generated`, with invalid values treated as `all`; `page` defaults to `1`, `pageSize` to `9`, capped at `36`. Returns `{ items, total, page, pageSize, pages }`, ordered by update time descending then name ascending. `source` actually filters `isUploaded` | `401` missing identity; `500` query failure |
| Same route, exact-version mode | A nonempty `name` together with `version` selects an asset instead of a paginated list. Version must be a nonnegative integer. Returns `{ asset: { id, name, version, activeVersion, files } }` | `400` invalid version; `404` no visible Skill/version; `401/500` as above |
| `GET /api/skills` | Optional `query`, `category`, and `user`; `category=全部` disables category filtering. Returns an unpaginated array with `id/name/sourceOwner/description/category/tags/activeVersion/versions` and usage/quality summaries | `500` |
| `GET /api/skills/by-name` | Required query `name`, optional `user`. Returns `{ id, name, description, category, activeVersion }` from the first visible match; no exact source selector | `400` missing name; `404` not found; `500` |

Legacy `/api/skills` and `/by-name` do not add a visibility filter when identity is empty. With an identity, they include owned, ownerless, and public Skills. Use `sourceOwner` in the following section when the source must be explicit, rather than relying on the order of same-name matches. Legacy list usage summaries aggregate by Skill name and are not audit counts for an exact source.

```bash
curl --fail-with-body --get \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  --data-urlencode "search=example" \
  --data-urlencode "pageSize=9" \
  "$AGENT_INSIGHT_BASE_URL/api/skill-management/skills"
```

## Read versions and files by name

Both routes require the query parameter `sourceOwner` to be **present**: an empty value means an ownerless shared source; a nonempty value selects its owner. Do not omit it. Errors are `401` for missing identity, `400` for missing source or invalid input, `403` for an inaccessible private source, `404` for a missing source/version/file, and `500` for processing failures. Responses set `Cache-Control: no-store`.

| Method and path | Successful response |
| --- | --- |
| `GET /api/skills/by-name/:name/versions?sourceOwner=...` | `{ name, sourceOwner, versions: [{ version }] }`, in descending version order. Optional nonnegative integer `version` additionally returns `{ files: [{ path, size, executable }] }` for that version |
| `GET /api/skills/by-name/:name/versions/:version/files/:path?sourceOwner=...` | `{ path, size, isText, content?, truncated }`. Text returns at most the first `512 KiB`, with `truncated: true` when larger. Binary files omit content |

Reading validates the entire version package: at most `256` files, `10 MiB` total, and `64 KiB` for the root `SKILL.md`. Its frontmatter `name` must be valid and match the library name. Missing manifest files, links/special files, duplicate paths, or invalid paths can be rejected. This is not an arbitrary-file download interface. The lowercase-letter, digit, and hyphen name check, limited to 64 characters, belongs to this package-reading path; it does not imply every legacy upload route uses the same validation.

```bash
curl --fail-with-body --get \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  --data-urlencode "sourceOwner=$SKILL_SOURCE_OWNER" \
  --data-urlencode "version=0" \
  "$AGENT_INSIGHT_BASE_URL/api/skills/by-name/example-skill/versions"
```

## Legacy version and file routes

| Method and path | Parameters, response, and limits |
| --- | --- |
| `GET /api/skills/:id/versions` | Returns version objects with `version/semanticVersion/changeLog/createdAt/usage/trend/executions`. Summaries load at most 800 execution records from the last 14 days, attaching at most 30 per version. Missing Skill `404`, processing error `500`. This route does not check user identity |
| `GET /api/skills/:id/versions/:version` | Returns the version database record. Version not parseable as an integer `400`, not found `404`, processing error `500`. No user identity check |
| `POST /api/skills/:id/versions` | JSON requires nonempty `content`; optional `changeLog/user`. After `canAccessSkill`, creates the next local version and returns its record with `200`. Inherits the previous `assetPath/files`, does not copy attachments or activate the version, and starts flow parsing and static evaluation in the background |
| `DELETE /api/skills/:id/versions/:version` | Uses `resolveUser` and `canAccessSkill`. The last version cannot be deleted (`400`); delete the Skill instead. Returns `{ success, message, previousActiveVersion }`. Deleting the active version selects the first remaining version. This does not promise complete filesystem cleanup |
| `GET /api/skills/:id/versions/:version/files/:path` | Uses `canAccessSkill`. Path must be nonempty, contain no `..`, and not start with `/`; the resolved path prefix is checked. `SKILL.md` comes from the database. Text files larger than `512 KiB` return empty `content` with `truncated: true`; binary files return metadata only. This differs from the name-based route, which returns the first 512 KiB |
| `GET /api/skills/:id/versions/:version/download` | Uses `canAccessSkill`. Streams `application/zip` with filename `name-vVERSION.zip`, combining disk attachments and database root `SKILL.md`. A missing attachment directory can still produce a main-file-only package. Receiving headers does not prove the ZIP stream finished |

Unless specified otherwise, legacy write/file/download errors include `400` invalid parameters, `403` access denied, `404` missing Skill/version/file, and `500` processing failure. `POST /versions` starts at `1` if there is no previous version; normally upload or publishing has already created version `0`. Read the actual returned number rather than allocating it client-side.

## Upload and publishing

### Upload a folder

`POST /api/skills/upload` accepts `multipart/form-data`, not a ZIP. Repeated `files` and `paths` correspond by index. Paths should include the same top-level folder and a `SKILL.md`; saving strips the first directory segment. Optional `targetSkillId` selects an existing Skill; optional `user` uses compatibility identity resolution.

```bash
curl --fail-with-body \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  -F "files=@/path/to/example-skill/SKILL.md" \
  -F "paths=example-skill/SKILL.md" \
  "$AGENT_INSIGHT_BASE_URL/api/skills/upload"
```

Name and description come from the main file's frontmatter when available, otherwise falling back to the folder name and a default description. Without `targetSkillId`, an existing same-name Skill for the user returns `400`. With a target, errors are `404` if absent, `403` when both resolved identity and owner are nonempty and differ, and `400` when the extracted name differs. Missing files/main file return `400`; processing failures return `500`.

Success is `200` with `{ success: true, skill, version }`, where `version` is the newly created version record. The first is `0`; updates increment it and automatically activate it. The returned `skill` object was obtained before activation was updated; requery for final active state. Flow parsing and static evaluation run in the background, so upload success does not mean either has completed or passed.

### Save from a generation session

`POST /api/skills/publish` takes JSON `{ "sessionId": "..." }` and optional compatibility `user`. This existing generation-session publishing route is distinct from workbench sessions' own publish route. Missing ID, empty session files, or missing `SKILL.md` returns `400`; an absent session returns `404`. Identical main-file content to the latest same-name Skill version returns `409`, even if attachments changed.

Success is `200`: `{ success, skill, version, isNewSkill }`. A new Skill starts at `0`; existing ones increment and activate the version. Only files within the selected Skill directory are saved, excluding loose files outside it. Flow parsing starts in the background. This route loads the session by `sessionId` without checking its owner here; it does not establish session isolation. After an unknown request result, inspect assets and versions before retrying to avoid additional versions.

## Activation, synchronization flag, and deletion

| Method and path | JSON or query and result |
| --- | --- |
| `POST /api/skills/:id/activate` | Required `version`, optional `user`; uses `canAccessSkill`, verifies the version exists, updates `activeVersion`, and returns the updated Skill with `200`. Missing version `400`, missing Skill/version `404`, denied `403`, error `500` |
| `POST /api/skills/:id/toggle` | Required boolean `isUploaded`, optional `user`; uses `canAccessSkill`, returns `{ success, skill }`. This flag does not mean installation on a remote Agent succeeded. Corresponding errors are `400/403/404/500` |
| `DELETE /api/skills?id=...` | Required query `id`, optional `user`; returns `{ success: true }`. Denies with `403` only when both resolved identity and owner are nonempty and differ. Missing ID `400`, absent Skill `404`, error `500`. Removes the local asset directory and database record |

In enterprise mode, deleting a Skill or version first attempts deletion of its enterprise asset, only when the enterprise version matches the local `semanticVersion`. Enterprise deletion errors do not prevent local deletion; local `success` does not prove remote deletion succeeded.

## Automation and enterprise synchronization

| Method and path | Contract |
| --- | --- |
| `POST /api/skills/automation/import` | JSON requires `path`, optional `user`. This is a directory on the **server filesystem**, not the caller's machine. Reads root `SKILL.md` and copies the directory. First import creates `0`; each repeated same-name import increments and activates a version. Returns `{ success, skill: { id, name }, version, status: "created" or "updated" }`. Missing path/main file `400`, absent path `404`, error `500`. Starts flow parsing in the background; repeated requests are not deduplicated |
| `POST /api/skills/automation/push` | JSON requires `name/user`, optional numeric `version`; omission selects the highest version. Returns `{ success, activeVersion, isUploaded, message }`. It activates and sets `isUploaded: true`; it does not confirm remote distribution in this request. Missing name/user or no available version `400`, missing Skill/version `404`, error `500`. Uses body `user` directly |
| `POST /api/skills/sync-enterprise` | Requires `ORGANIZATION_MODE=true` (`400` otherwise). Resolves the user and forwards the request Cookie, then **awaits** synchronization. HTTP `200` does not prove every item succeeded: inspect `success/failedCount/results[].success/error`. Another synchronization in the same process returns `409`; route exception `500` |
| `GET /api/skills/sync-enterprise` | No user check; returns process-local `{ isSyncing, lastResult, startTime }`. This is not a persistent per-user task; it cannot recover complete progress across restarts or instances |

Enterprise synchronization processes items independently and can continue after an item fails. Even a global listing failure can return `200` with `success: false`. There is no general idempotency request ID or atomic transaction across the filesystem, database, and enterprise service.

## Execution records

| Method and path | Parameters and response |
| --- | --- |
| `GET /api/skills/:id/runs` | Uses `canAccessSkill`. Optional `version` accepts `v1`; `limit` defaults to `50`, range `1`–`500`; `offset` defaults to `0`, minimum `0`. Returns `{ total, items }` with item fields `trace_id/agent/started_at/duration_ms/status/version/query`; status is `success/failed/pending/unknown` |
| `GET /api/skills/logs` | Requires `skill`; optional `skill_version` accepts `v1`; `limit` defaults to `10` and accepts a positive integer. Returns a descending-time array including input/output, scores, and this Skill's routing/outcome details. A supplied Key that does not resolve to a user returns an empty array, not `401`; storage determines the read scope without identity |

Missing parameters/invalid version format can return `400`; ID routes also have `403/404`, and processing errors return `500`. A run-summary `success` is not a pass from every evaluator. See [evaluator output](../evaluation/evaluator-output.md).

## Implementation sources

This page describes local baseline `eabde5b0` reviewed for this documentation round, without promising future-version compatibility. Key implementations:

- [Asset list/deletion](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/route.ts), [management center](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skill-management/skills/route.ts), and [query rules](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/skill-workbench/skill-management.ts).
- [Upload](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/upload/route.ts), [publishing](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/publish/route.ts), [name-based reading](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/evaluators/evaluator-skill-service.ts), and [file-preview rules](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/evaluators/evaluator-skill-store.ts).
- [Automation import](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/automation/import/route.ts), [synchronization flag](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/automation/push/route.ts), [enterprise synchronization](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/sync-enterprise/route.ts), and [identity helpers](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/auth/auth.ts).

[中文权威版本](../../../zh/reference/optimization/skills-api.md)
