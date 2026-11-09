---
title: "Skill 管理 HTTP 接口"
description: "Skill 资产检索、版本与文件、上传发布及自动化同步的现有接口。"
---

本页覆盖 Skill 资产管理的 22 个现有 HTTP 方法。操作流程见 [Skills 管理](../../how-to/optimization/skills/manage.md)。生成与优化会话、优化点、静态评估、Benchmark 生成、流程解析和工作台实验不在本页展开，分别见 [Skill 工作台](../../explanation/optimization/skills/workbench-overview.md)与 [Skill 评估与实验](../../explanation/evaluation/skills/overview.md)；本页不代表所有 Skill 路由的完整契约。

## 标识与身份

对外定位优先使用 `name`，路径中的名称需 URL 编码。已有 `:id` 接口仍使用 Skill 数据库 ID，不能将名称直接填入。整数 `version` 是本地版本号，从 `0` 开始；企业 `semanticVersion` 是另一字段。

身份不是统一的强制鉴权：

| 接口类别 | 当前行为 |
| --- | --- |
| 采用 `resolveUser` 的入口 | 非空显式 `user` 优先于 Key；否则解析 `x-witty-api-key`，无该 Key 时再读查询 `apiKey`。显式 `user` 不是已验证凭证，详见 [HTTP 身份约定](../platform/http-api.md) |
| `canAccessSkill` 路径 | 公共 Skill、无属主 Skill、匹配属主或空身份均可通过；有身份且访问其他用户的私有 Skill 才拒绝。不能把返回成功等同于已验证所有权 |
| 管理中心及按名称版本/文件入口 | 要求解析出非空身份；但仍保留显式 `user` 兼容方式。管理中心筛选本人、共享及公共资产；按名称版本/文件另按 `sourceOwner` 精确查来源并检查可见性 |
| 遗留版本列表及单版本 `GET` | 按 ID 查询，不在路由中调用用户解析或访问检查 |
| `automation/push` | 直接使用 JSON 的 `user`，不调用 `resolveUser`，API Key 不能代替必填 `user` |

部署方需结合现有访问控制设置调用边界；不能根据上述兼容路径推导出所有路由均提供账号隔离。下文描述的是实现行为，本轮未修改权限逻辑。

## 资产检索

| 方法与路径 | 参数与成功响应 | 主要失败 |
| --- | --- | --- |
| `GET /api/skill-management/skills` | `search` 去空白截取 100 字符，`category` 截取 80 字符；`source=all/uploaded/generated`，非法值按 `all`；`page` 默认 `1`，`pageSize` 默认 `9`、最多 `36`。返回 `{ items, total, page, pageSize, pages }`，按更新时间倒序、名称正序；`source` 实际按 `isUploaded` 筛选 | `401` 无身份；`500` 查询失败 |
| 同上，精确版本模式 | 同时传非空 `name` 和 `version` 时，不走分页列表；版本必须为非负整数。返回 `{ asset: { id, name, version, activeVersion, files } }` | `400` 版本非法；`404` 无可见 Skill/版本；`401/500` 同上 |
| `GET /api/skills` | 可选 `query`、`category`、`user`；`category=全部` 不筛选。返回数组，含 `id/name/sourceOwner/description/category/tags/activeVersion/versions` 及使用、质量摘要；不分页 | `500` |
| `GET /api/skills/by-name` | 必填查询 `name`，可选 `user`。返回 `{ id, name, description, category, activeVersion }`，取可见同名结果第一项，不提供精确来源选择 | `400` 缺名称；`404` 未找到；`500` |

遗留 `/api/skills` 与 `/by-name` 在身份为空时不加可见性筛选；有身份时包含本人、无属主及公共 Skill。需要明确来源时使用下一节的 `sourceOwner`，不要靠同名结果的返回顺序选择资产。旧列表中的使用摘要按 Skill 名称聚合，不能视为精确来源的审计计数。

```bash
curl --fail-with-body --get \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  --data-urlencode "search=example" \
  --data-urlencode "pageSize=9" \
  "$AGENT_INSIGHT_BASE_URL/api/skill-management/skills"
```

## 按名称读取版本与文件

这两个入口都要求查询参数中**存在** `sourceOwner`：空值表示无属主的共享来源，非空值表示具体属主；不可省略。缺身份 `401`，缺来源或非法输入 `400`，私有来源不可见 `403`，来源、版本或文件不存在 `404`；处理异常 `500`。响应带 `Cache-Control: no-store`。

| 方法与路径 | 成功响应 |
| --- | --- |
| `GET /api/skills/by-name/:name/versions?sourceOwner=...` | `{ name, sourceOwner, versions: [{ version }] }`，版本号降序；可选 `version` 为非负整数，选中时额外返回 `{ files: [{ path, size, executable }] }` |
| `GET /api/skills/by-name/:name/versions/:version/files/:path?sourceOwner=...` | `{ path, size, isText, content?, truncated }`。文本最多返回前 `512 KiB`，超出时 `truncated: true`；二进制不返回正文 |

读取会验证整个版本包：最多 `256` 文件、总计 `10 MiB`、根 `SKILL.md` 最多 `64 KiB`；需有效 frontmatter `name`，且与库名称一致。缺失清单文件、链接/特殊文件、重复或不合法路径均可被拒绝，不能把它当作任意文件下载接口。名称为小写字母、数字及连字符、最多 64 字符的校验属于该包读取链路，不代表所有遗留上传入口都执行同样校验。

```bash
curl --fail-with-body --get \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  --data-urlencode "sourceOwner=$SKILL_SOURCE_OWNER" \
  --data-urlencode "version=0" \
  "$AGENT_INSIGHT_BASE_URL/api/skills/by-name/example-skill/versions"
```

## 遗留版本与文件接口

| 方法与路径 | 参数、响应与边界 |
| --- | --- |
| `GET /api/skills/:id/versions` | 返回版本数组，包括 `version/semanticVersion/changeLog/createdAt/usage/trend/executions`。运行摘要最多取近 14 天 800 条记录，每版本最多附 30 条；无 Skill `404`，异常 `500`。该路由不检查用户身份 |
| `GET /api/skills/:id/versions/:version` | 返回版本数据库记录；版本不能解析为整数 `400`，未找到 `404`，异常 `500`。不检查用户身份 |
| `POST /api/skills/:id/versions` | JSON 必填非空 `content`，可选 `changeLog/user`；经 `canAccessSkill` 后创建下一本地版本，返回新版本记录 `200`。继承上版 `assetPath/files`，不复制附件，不自动激活；后台启动流程解析和静态评估 |
| `DELETE /api/skills/:id/versions/:version` | 经 `resolveUser`、`canAccessSkill`；不能删除最后一版（`400`），应删除整个 Skill。成功 `{ success, message, previousActiveVersion }`；删除激活版时，改用剩余版本列表第一项。不是完整文件系统清理承诺 |
| `GET /api/skills/:id/versions/:version/files/:path` | 经 `canAccessSkill`。路径非空，不含 `..`，不以 `/` 开头，并做解析路径前缀检查；`SKILL.md` 从数据库返回。文本文件超过 `512 KiB` 时返回空 `content`、`truncated: true`；二进制只返回元数据。与按名称入口的“返回前 512 KiB”不同 |
| `GET /api/skills/:id/versions/:version/download` | 经 `canAccessSkill`，返回 `application/zip` 流，文件名 `名称-v版本.zip`；磁盘附件加数据库中的根 `SKILL.md`。即使附件目录不存在，也可能得到仅含主文件的包。收到响应头不代表 ZIP 流已完整传输 |

除表内特别说明，遗留写入、文件与下载入口常见 `400` 参数错误、`403` 访问拒绝、`404` Skill/版本/文件缺失、`500` 处理错误。`POST /versions` 的版本计算无历史版本时从 `1` 开始；通常已有上传/发布的版本 `0`。调用方应按实际返回值读取，不能自行分配版本号。

## 上传与发布

### 文件夹上传

`POST /api/skills/upload` 接收 `multipart/form-data`，不是 ZIP：重复的 `files` 和 `paths` 按索引一一对应。路径需带同一顶层文件夹，包含 `SKILL.md`；保存时剥去首段目录。可选 `targetSkillId` 指向已有 Skill，可选 `user` 走兼容身份解析。

```bash
curl --fail-with-body \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  -F "files=@/path/to/example-skill/SKILL.md" \
  -F "paths=example-skill/SKILL.md" \
  "$AGENT_INSIGHT_BASE_URL/api/skills/upload"
```

名称、描述优先读主文件 frontmatter，否则回退目录名与默认描述。未给 `targetSkillId` 时同用户同名已存在返回 `400`；给定目标时，目标不存在 `404`，解析身份与属主均非空且不符 `403`，提取名称不一致 `400`。无文件或缺主文件 `400`，异常 `500`。

成功 `200` 返回 `{ success: true, skill, version }`；`version` 是新版本记录。首次从 `0` 开始，更新时递增，并自动设为激活版本。`skill` 是更新激活前取得的对象，最终激活状态应重新查询。流程解析、静态评估在后台执行，上传成功不代表它们完成或通过。

### 从生成会话保存

`POST /api/skills/publish` 使用 JSON `{ "sessionId": "..." }`，可选兼容 `user`。这是现有生成会话发布入口，不等同于工作台会话自己的发布接口。缺 ID、会话无文件或无 `SKILL.md` 为 `400`，会话不存在 `404`；主文件与同名 Skill 最新版完全相同为 `409`，即使附件有变化也按此主文件判断。

成功 `200`：`{ success, skill, version, isNewSkill }`。首次版本 `0`，已有 Skill 递增并自动激活；保存选中 Skill 目录的文件，不保存目录外散文件。后台启动流程解析。本路由按 `sessionId` 查会话，未在此处校验会话属主；不能据此承诺会话隔离。未知请求结果时先查资产与版本，避免重试创建额外版本。

## 激活、同步标记与删除

| 方法与路径 | JSON 或查询与结果 |
| --- | --- |
| `POST /api/skills/:id/activate` | 必填 `version`，可选 `user`；经 `canAccessSkill`，版本存在后更新 `activeVersion`，返回更新后的 Skill `200`。缺版本 `400`，Skill/版本不存在 `404`，拒绝 `403`，异常 `500` |
| `POST /api/skills/:id/toggle` | 必填布尔 `isUploaded`，可选 `user`；经 `canAccessSkill`，返回 `{ success, skill }`。此标记不等于远端 Agent 已安装成功；`400/403/404/500` 按对应错误 |
| `DELETE /api/skills?id=...` | 必填查询 `id`，可选 `user`；返回 `{ success: true }`。仅当解析身份和 Skill 属主均非空且不同时拒绝 `403`；缺 ID `400`，未找到 `404`，异常 `500`。删除本地资产目录和数据库记录 |

企业模式下，整个 Skill 或单版本删除会先尝试删除对应企业资产：仅企业版本与本地 `semanticVersion` 相符才删除远端。企业删除失败仍继续本地删除；本地 `success` 不能证明企业删除成功。

## 自动化与企业同步

| 方法与路径 | 约定 |
| --- | --- |
| `POST /api/skills/automation/import` | JSON 必填 `path`，可选 `user`；路径指**服务端**文件系统上的目录，不是请求方目录。读取根 `SKILL.md` 并复制目录；首次创建 `0`，同名 Skill 每次递增并激活。返回 `{ success, skill: { id, name }, version, status: "created"或"updated" }`。缺路径/主文件 `400`，路径不存在 `404`，异常 `500`；后台解析流程，不保证重复请求去重 |
| `POST /api/skills/automation/push` | JSON 必填 `name/user`，可选数字 `version`；不传版本时取最大版本号。返回 `{ success, activeVersion, isUploaded, message }`，只激活并设置 `isUploaded: true`，不在此请求里确认远端分发。缺名称/用户或没有版本 `400`，Skill/指定版本不存在 `404`，异常 `500`。该路由直接采用体内 `user` |
| `POST /api/skills/sync-enterprise` | 仅 `ORGANIZATION_MODE=true` 可用（否则 `400`）；读取解析用户并转发请求 Cookie，**等待**同步服务结果，成功 HTTP `200` 不代表每项成功，须看 `success/failedCount/results[].success/error`。同进程已有同步返回 `409`，路由异常 `500` |
| `GET /api/skills/sync-enterprise` | 无用户检查，返回进程内 `{ isSyncing, lastResult, startTime }`。状态不是按用户隔离的持久任务；重启/多实例不能据此恢复完整进度 |

企业同步逐项处理，某项失败可继续其余项；全局列表获取失败也可能以 `200`、`success: false` 返回。没有通用的幂等请求 ID 或跨文件系统、数据库、企业服务的原子事务承诺。

## 运行记录

| 方法与路径 | 参数与响应 |
| --- | --- |
| `GET /api/skills/:id/runs` | 经 `canAccessSkill`；可选 `version`（支持 `v1`）、`limit` 默认 `50`、范围 `1`～`500`，`offset` 默认 `0`、最小 `0`。返回 `{ total, items }`，item 含 `trace_id/agent/started_at/duration_ms/status/version/query`；状态为 `success/failed/pending/unknown` |
| `GET /api/skills/logs` | 必填 `skill`，可选 `skill_version`（支持 `v1`）、`limit` 默认 `10`、有效正整数。返回按时间倒序数组，含输入输出、分数及该 Skill 的 routing/outcome 明细。提供 Key 但未匹配到用户时返回空数组，不返回 `401`；无身份读取范围由存储层决定 |

运行记录缺参数/版本格式错误可返回 `400`；ID 路径另有 `403/404`，处理失败 `500`。运行摘要中的 `success` 不等于所有评估器给出通过判定，详见 [评估器输出](../evaluation/evaluator-output.md)。

## 实现依据

基于本轮本地代码基线 `eabde5b0` 说明，本文不作对未来版本的兼容承诺。关键实现：

- [资产列表与删除](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/route.ts)、[管理中心](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skill-management/skills/route.ts)与 [查询规则](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/skill-workbench/skill-management.ts)。
- [上传](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/upload/route.ts)、[发布](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/publish/route.ts)、[按名称读取](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/evaluators/evaluator-skill-service.ts)与 [文件预览规则](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/evaluators/evaluator-skill-store.ts)。
- [自动化导入](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/automation/import/route.ts)、[同步标记](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/automation/push/route.ts)、[企业同步](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/app/api/skills/sync-enterprise/route.ts)与 [身份辅助函数](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/auth/auth.ts)。

[English](../../../en/reference/optimization/skills-api.md)
