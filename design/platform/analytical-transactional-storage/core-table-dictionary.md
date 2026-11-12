# 核心表字段字典与首批建表契约

日期：2026-11-11。本轮细化 **21 张事务表 + 13 张 ClickHouse 表，共 34 张物理核心表**。其中 schema_meta、workspaces、asset_release_seals、obs_payload_manifests 是为迁移、租户外键、发布封存和正文完整性补充的 4 张基础表；不把前稿 59 张逻辑表全部宣称为已实现。

本字典来自同目录实现的机器目录，描述字段和 DDL 契约。SQLite 已进行真实引擎约束测试，PostgreSQL 15 的隔离事务 Schema 合同测试已通过；这不等于业务 PG 适配器全部实现。ClickHouse 25.8.12.129 已通过 macOS ARM64 单实例的 13 表建表、万 Span 分页和正文链路验证；这不等于 Linux/HA 或千级混合压测；openGauss DDL 是单独维护的候选版本，未通过指定发行版验证前不能称为已认证。

## 范围与未实现项

- 本轮事务表：`schema_meta`, `workspaces`, `asset_identities`, `asset_releases`, `asset_drafts`, `asset_release_dependencies`, `asset_release_seals`, `asset_aliases`, `runs`, `run_inputs`, `work_items`, `work_attempts`, `result_receipts`, `result_selections`, `outbox_events`, `inbox_receipts`, `trace_locators`, `snapshot_manifests`, `artifact_metadata`, `deletion_requests`, `migration_checkpoints`。
- 本轮 CH 表：`obs_payload_manifests`, `obs_trace_current`, `obs_span_current`, `obs_payload_chunks`, `obs_events`, `obs_entity_relations`, `snapshot_nodes`, `dataset_sample_revisions`, `dataset_release_members`, `eval_result_facts`, `eval_metric_facts`, `eval_result_selection_current`, `eval_publication_members`。
- 仍待后续批次：IAM 完整身份/凭据/成员、资产异步发布、插件与指标注册、run groups、人工裁决/评论、标签、资源引用/pin、客户端控制与配置、领域会话/计划、运维遥测与汇总代次等。现有服务/API 尚未全部切换到新表。

账号密码、用户分组和组管理员属于待实现IAM控制面；明确的目标表、权限矩阵及历史归组规则见 [总体设计 §4.2](phase2-requirements-design.md#42-账号密码登录用户组与组管理员新增明确需求)。当前workspace外键保护引用归属，不能替代Web请求鉴权。

## 公共类型与约束

- TEXT：UTF-8，标识符最多 512 字符且无控制字符，port 负责精确验证；SQL 不自动生成 UUID。
- BIGINT：带符号 64 位。时间 `_ms` 为 UTC Unix 毫秒；revision/fence/etag 统一限定 1..2^63-1，不能用墙钟拼接进程序号；CH 使用 UInt64 但 CHECK 相同范围。SQLite BIGINT 物理映射 INTEGER。
- manifest-json/v1：ASCII 键、按键排序、UTF-8、不允许浮点；超过 JS 安全整数范围的整数及定点金额用十进制字符串。语义内容 hash 为规范字节 SHA-256；schema_meta.checksum 则是执行 SQL 文件原始字节的 SHA-256。
- JSON 字段用 TEXT 保留，port 验证结构和大小；不依赖三库不同 JSON 语法。hash 由 port 验证小写十六进制，SQL 校验长度。
- 所有租户外键含 workspace_id，无跨 CH 外键。SQL 默认 NO ACTION；发布版本不通过级联清理删除。nullable FK 仅表示显式无引用，不表示跨租户或全局共享。
- 不可变表 UPDATE/DELETE 被触发器拒绝。普通应用也不能绕过发布服务直接改依赖；依赖图无环、角色/类型相容、版本可见性由服务层验证。
- schema_meta 仅迁移器写；SQL 不预插固定 checksum。新目标初始化拒绝包含旧业务表的数据库；重开新库需精确校验版本和 checksum，不隐式升级。

## 事务表字段

### schema_meta

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `version` | INTEGER | 否 | 应用显式提供 |
| `name` | TEXT | 否 | 应用显式提供 |
| `checksum` | TEXT | 否 | 应用显式提供 |
| `applied_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`version`。
CHECK：`version > 0`。
CHECK：`applied_at_ms >= 0`。

### workspaces

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `name` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | active |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id`。
CHECK：`state IN ('active','suspended','deleted')`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。

### asset_identities

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `asset_id` | TEXT | 否 | 应用显式提供 |
| `kind` | TEXT | 否 | 应用显式提供 |
| `name` | TEXT | 否 | 应用显式提供 |
| `visibility` | TEXT | 否 | private |
| `description` | TEXT | 否 | '' |
| `etag` | BIGINT | 否 | 1 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, asset_id`。
UNIQUE：`workspace_id, kind, name`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`kind IN ('skill','agent','evaluator','dataset','benchmark')`。
CHECK：`visibility IN ('private','workspace','public')`。
CHECK：`etag > 0`。
CHECK：`length(name) > 0`。
CHECK：`etag <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_asset_identities_1`：`workspace_id, kind, created_at_ms`。

### asset_releases

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `release_id` | TEXT | 否 | 应用显式提供 |
| `asset_id` | TEXT | 否 | 应用显式提供 |
| `version_label` | TEXT | 否 | 应用显式提供 |
| `content_hash` | TEXT | 否 | 应用显式提供 |
| `manifest_ref` | TEXT | 否 | 应用显式提供 |
| `schema_version` | INTEGER | 否 | 应用显式提供 |
| `publisher_id` | TEXT | 否 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, release_id`。
UNIQUE：`workspace_id, asset_id, version_label`。
UNIQUE：`workspace_id, asset_id, release_id`。
FK：`workspace_id,asset_id` → `asset_identities(workspace_id,asset_id)`。
CHECK：`length(content_hash) = 64`。
CHECK：`schema_version > 0`。
CHECK：`length(version_label) > 0`。
CHECK：`created_at_ms >= 0`。
INDEX `idx_asset_releases_1`：`workspace_id, asset_id, created_at_ms`。
不可变：禁止原地 UPDATE/DELETE；修订新建 release/事实。

### asset_drafts

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `draft_id` | TEXT | 否 | 应用显式提供 |
| `asset_id` | TEXT | 否 | 应用显式提供 |
| `branch_name` | TEXT | 否 | 应用显式提供 |
| `base_release_id` | TEXT | 是 | 应用显式提供 |
| `manifest_json` | TEXT | 否 | 应用显式提供 |
| `edit_revision` | BIGINT | 否 | 1 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, draft_id`。
UNIQUE：`workspace_id, asset_id, branch_name`。
FK：`workspace_id,asset_id` → `asset_identities(workspace_id,asset_id)`。
FK：`workspace_id,asset_id,base_release_id` → `asset_releases(workspace_id,asset_id,release_id)`。
CHECK：`edit_revision > 0`。
CHECK：`edit_revision <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。

### asset_release_dependencies

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `release_id` | TEXT | 否 | 应用显式提供 |
| `role` | TEXT | 否 | 应用显式提供 |
| `dependency_release_id` | TEXT | 否 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, release_id, role, dependency_release_id`。
FK：`workspace_id,release_id` → `asset_releases(workspace_id,release_id)`。
FK：`workspace_id,dependency_release_id` → `asset_releases(workspace_id,release_id)`。
CHECK：`release_id <> dependency_release_id`。
CHECK：`created_at_ms >= 0`。
INDEX `idx_asset_release_dependencies_1`：`workspace_id, dependency_release_id`。
不可变：禁止原地 UPDATE/DELETE；修订新建 release/事实。

### asset_release_seals

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `release_id` | TEXT | 否 | 应用显式提供 |
| `asset_id` | TEXT | 否 | 应用显式提供 |
| `dependency_count` | BIGINT | 否 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, release_id`。
UNIQUE：`workspace_id, asset_id, release_id`。
FK：`workspace_id,asset_id,release_id` → `asset_releases(workspace_id,asset_id,release_id)`。
CHECK：`dependency_count >= 0`。
CHECK：`created_at_ms >= 0`。
不可变：禁止原地 UPDATE/DELETE；修订新建 release/事实。

### asset_aliases

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `asset_id` | TEXT | 否 | 应用显式提供 |
| `alias` | TEXT | 否 | 应用显式提供 |
| `release_id` | TEXT | 否 | 应用显式提供 |
| `etag` | BIGINT | 否 | 1 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, asset_id, alias`。
FK：`workspace_id,asset_id` → `asset_identities(workspace_id,asset_id)`。
FK：`workspace_id,asset_id,release_id` → `asset_release_seals(workspace_id,asset_id,release_id)`。
CHECK：`etag > 0`。
CHECK：`etag <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。

### runs

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `run_id` | TEXT | 否 | 应用显式提供 |
| `name` | TEXT | 否 | 应用显式提供 |
| `plan_hash` | TEXT | 否 | 应用显式提供 |
| `plan_manifest_ref` | TEXT | 否 | 应用显式提供 |
| `dataset_release_id` | TEXT | 是 | 应用显式提供 |
| `expected_case_count` | BIGINT | 否 | 应用显式提供 |
| `status` | TEXT | 否 | draft |
| `etag` | BIGINT | 否 | 1 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, run_id`。
FK：`workspace_id` → `workspaces(workspace_id)`。
FK：`workspace_id,dataset_release_id` → `asset_release_seals(workspace_id,release_id)`。
CHECK：`length(plan_hash) = 64`。
CHECK：`expected_case_count >= 0`。
CHECK：`etag > 0`。
CHECK：`status IN ('draft','queued','running','done','partial','failed','cancelled')`。
CHECK：`etag <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_runs_1`：`workspace_id, status, created_at_ms`。

### run_inputs

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `run_id` | TEXT | 否 | 应用显式提供 |
| `slot` | TEXT | 否 | 应用显式提供 |
| `release_id` | TEXT | 否 | 应用显式提供 |
| `config_hash` | TEXT | 否 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, run_id, slot`。
FK：`workspace_id,run_id` → `runs(workspace_id,run_id)`。
FK：`workspace_id,release_id` → `asset_release_seals(workspace_id,release_id)`。
CHECK：`length(config_hash) = 64`。
CHECK：`created_at_ms >= 0`。
不可变：禁止原地 UPDATE/DELETE；修订新建 release/事实。

### work_items

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `work_item_id` | TEXT | 否 | 应用显式提供 |
| `run_id` | TEXT | 否 | 应用显式提供 |
| `case_key` | TEXT | 否 | 应用显式提供 |
| `phase` | TEXT | 否 | 应用显式提供 |
| `evaluator_slot` | TEXT | 否 | default |
| `status` | TEXT | 否 | queued |
| `priority` | INTEGER | 否 | 0 |
| `etag` | BIGINT | 否 | 1 |
| `next_attempt_at_ms` | BIGINT | 否 | 0 |
| `cancel_requested` | INTEGER | 否 | 0 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, work_item_id`。
UNIQUE：`workspace_id, run_id, case_key, phase, evaluator_slot`。
UNIQUE：`workspace_id, run_id, work_item_id`。
UNIQUE：`workspace_id, run_id, work_item_id, case_key`。
UNIQUE：`workspace_id, run_id, work_item_id, case_key, evaluator_slot`。
FK：`workspace_id,run_id` → `runs(workspace_id,run_id)`。
CHECK：`etag > 0`。
CHECK：`cancel_requested IN (0,1)`。
CHECK：`phase IN ('execute','evaluate','snapshot','publish','migrate')`。
CHECK：`status IN ('queued','running','done','failed','cancelled')`。
CHECK：`etag <= 9223372036854775807`。
CHECK：`next_attempt_at_ms >= 0`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_work_items_1`：`workspace_id, status, next_attempt_at_ms, priority`。
INDEX `idx_work_items_2`：`workspace_id, run_id, status`。

### work_attempts

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `attempt_id` | TEXT | 否 | 应用显式提供 |
| `work_item_id` | TEXT | 否 | 应用显式提供 |
| `attempt_no` | BIGINT | 否 | 应用显式提供 |
| `fence` | BIGINT | 否 | 应用显式提供 |
| `worker_id` | TEXT | 否 | 应用显式提供 |
| `status` | TEXT | 否 | 应用显式提供 |
| `lease_until_ms` | BIGINT | 否 | 应用显式提供 |
| `started_at_ms` | BIGINT | 否 | 应用显式提供 |
| `finished_at_ms` | BIGINT | 是 | 应用显式提供 |
| `error_code` | TEXT | 是 | 应用显式提供 |

PK：`workspace_id, attempt_id`。
UNIQUE：`workspace_id, work_item_id, attempt_no`。
UNIQUE：`workspace_id, work_item_id, fence`。
UNIQUE：`workspace_id, work_item_id, attempt_id`。
FK：`workspace_id,work_item_id` → `work_items(workspace_id,work_item_id)`。
CHECK：`attempt_no > 0`。
CHECK：`fence > 0`。
CHECK：`status IN ('running','done','failed','cancelled','expired')`。
CHECK：`lease_until_ms >= started_at_ms`。
CHECK：`fence <= 9223372036854775807`。
CHECK：`lease_until_ms >= 0`。
CHECK：`started_at_ms >= 0`。
CHECK：`finished_at_ms >= 0`。
INDEX `idx_work_attempts_1`：`workspace_id, status, lease_until_ms`。
INDEX `idx_work_attempts_2`：`workspace_id, work_item_id, attempt_no`。

### result_receipts

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `run_id` | TEXT | 否 | 应用显式提供 |
| `work_item_id` | TEXT | 否 | 应用显式提供 |
| `case_key` | TEXT | 否 | 应用显式提供 |
| `evaluator_slot` | TEXT | 否 | default |
| `receipt_id` | TEXT | 否 | 应用显式提供 |
| `attempt_id` | TEXT | 否 | 应用显式提供 |
| `receipt_key` | TEXT | 否 | 应用显式提供 |
| `result_id` | TEXT | 否 | 应用显式提供 |
| `content_hash` | TEXT | 否 | 应用显式提供 |
| `artifact_ref` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | accepted |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, receipt_id`。
UNIQUE：`workspace_id, attempt_id, receipt_key`。
UNIQUE：`workspace_id, result_id`。
UNIQUE：`workspace_id, run_id, result_id`。
UNIQUE：`workspace_id, run_id, case_key, evaluator_slot, result_id`。
FK：`workspace_id,work_item_id,attempt_id` → `work_attempts(workspace_id,work_item_id,attempt_id)`。
FK：`workspace_id,run_id,work_item_id,case_key,evaluator_slot` → `work_items(workspace_id,run_id,work_item_id,case_key,evaluator_slot)`。
CHECK：`length(content_hash) = 64`。
CHECK：`state IN ('accepted','indexed','published','quarantined')`。
CHECK：`created_at_ms >= 0`。
INDEX `idx_result_receipts_1`：`workspace_id, state, created_at_ms`。

### result_selections

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `run_id` | TEXT | 否 | 应用显式提供 |
| `case_key` | TEXT | 否 | 应用显式提供 |
| `evaluator_slot` | TEXT | 否 | 应用显式提供 |
| `result_id` | TEXT | 否 | 应用显式提供 |
| `selection_revision` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, run_id, case_key, evaluator_slot`。
FK：`workspace_id,run_id` → `runs(workspace_id,run_id)`。
FK：`workspace_id,run_id,case_key,evaluator_slot,result_id` → `result_receipts(workspace_id,run_id,case_key,evaluator_slot,result_id)`。
CHECK：`selection_revision > 0`。
CHECK：`selection_revision <= 9223372036854775807`。
CHECK：`updated_at_ms >= 0`。

### outbox_events

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `event_id` | TEXT | 否 | 应用显式提供 |
| `aggregate_id` | TEXT | 否 | 应用显式提供 |
| `aggregate_revision` | BIGINT | 否 | 应用显式提供 |
| `event_type` | TEXT | 否 | 应用显式提供 |
| `payload_json` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | pending |
| `attempts` | INTEGER | 否 | 0 |
| `next_attempt_at_ms` | BIGINT | 否 | 0 |
| `lease_owner` | TEXT | 是 | 应用显式提供 |
| `lease_until_ms` | BIGINT | 是 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, event_id`。
UNIQUE：`workspace_id, aggregate_id, aggregate_revision, event_type`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`aggregate_revision > 0`。
CHECK：`attempts >= 0`。
CHECK：`state IN ('pending','dispatching','sent','dead')`。
CHECK：`next_attempt_at_ms >= 0`。
CHECK：`lease_until_ms >= 0`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_outbox_events_1`：`state, next_attempt_at_ms, created_at_ms`。
INDEX `idx_outbox_events_2`：`workspace_id, aggregate_id, aggregate_revision`。

### inbox_receipts

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `source_id` | TEXT | 否 | 应用显式提供 |
| `event_id` | TEXT | 否 | 应用显式提供 |
| `content_hash` | TEXT | 否 | 应用显式提供 |
| `processed_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, source_id, event_id`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`length(content_hash) = 64`。
CHECK：`processed_at_ms >= 0`。
不可变：禁止原地 UPDATE/DELETE；修订新建 release/事实。

### trace_locators

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `trace_id` | TEXT | 否 | 应用显式提供 |
| `source_namespace` | TEXT | 否 | 应用显式提供 |
| `native_trace_id` | TEXT | 否 | 应用显式提供 |
| `trace_bucket` | TEXT | 否 | 应用显式提供 |
| `route_epoch` | BIGINT | 否 | 1 |
| `incarnation` | BIGINT | 否 | 1 |
| `state` | TEXT | 否 | active |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, trace_id`。
UNIQUE：`workspace_id, source_namespace, native_trace_id, incarnation`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`route_epoch > 0`。
CHECK：`incarnation > 0`。
CHECK：`state IN ('active','deleting','deleted')`。
CHECK：`route_epoch <= 9223372036854775807`。
CHECK：`incarnation <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_trace_locators_1`：`workspace_id, trace_bucket, state`。

### snapshot_manifests

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `snapshot_id` | TEXT | 否 | 应用显式提供 |
| `trace_id` | TEXT | 是 | 应用显式提供 |
| `manifest_ref` | TEXT | 否 | 应用显式提供 |
| `content_hash` | TEXT | 否 | 应用显式提供 |
| `node_count` | BIGINT | 否 | 应用显式提供 |
| `log_watermark` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | staging |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `published_at_ms` | BIGINT | 是 | 应用显式提供 |

PK：`workspace_id, snapshot_id`。
FK：`workspace_id` → `workspaces(workspace_id)`。
FK：`workspace_id,trace_id` → `trace_locators(workspace_id,trace_id)`。
CHECK：`node_count >= 0`。
CHECK：`length(content_hash) = 64`。
CHECK：`state IN ('staging','published','failed')`。
CHECK：`created_at_ms >= 0`。
CHECK：`published_at_ms >= 0`。
INDEX `idx_snapshot_manifests_1`：`workspace_id, state, created_at_ms`。

### artifact_metadata

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `artifact_id` | TEXT | 否 | 应用显式提供 |
| `namespace` | TEXT | 否 | 应用显式提供 |
| `object_ref` | TEXT | 否 | 应用显式提供 |
| `content_hash` | TEXT | 否 | 应用显式提供 |
| `size_bytes` | BIGINT | 否 | 应用显式提供 |
| `media_type` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | staging |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `published_at_ms` | BIGINT | 是 | 应用显式提供 |

PK：`workspace_id, artifact_id`。
UNIQUE：`workspace_id, namespace, object_ref`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`length(content_hash) = 64`。
CHECK：`size_bytes >= 0`。
CHECK：`state IN ('staging','published','deleted')`。
CHECK：`created_at_ms >= 0`。
CHECK：`published_at_ms >= 0`。
INDEX `idx_artifact_metadata_1`：`workspace_id, state, created_at_ms`。

### deletion_requests

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `deletion_id` | TEXT | 否 | 应用显式提供 |
| `resource_kind` | TEXT | 否 | 应用显式提供 |
| `resource_id` | TEXT | 否 | 应用显式提供 |
| `incarnation` | BIGINT | 否 | 应用显式提供 |
| `barrier_revision` | BIGINT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | requested |
| `requested_by` | TEXT | 否 | 应用显式提供 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, deletion_id`。
UNIQUE：`workspace_id, resource_kind, resource_id, incarnation`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`incarnation > 0`。
CHECK：`barrier_revision > 0`。
CHECK：`state IN ('requested','blocked','propagating','purged','failed')`。
CHECK：`incarnation <= 9223372036854775807`。
CHECK：`barrier_revision <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。
INDEX `idx_deletion_requests_1`：`workspace_id, state, created_at_ms`。

### migration_checkpoints

| 字段 | 逻辑类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | TEXT | 否 | 应用显式提供 |
| `migration_id` | TEXT | 否 | 应用显式提供 |
| `source_fingerprint` | TEXT | 否 | 应用显式提供 |
| `source_table` | TEXT | 否 | 应用显式提供 |
| `last_key` | TEXT | 否 | 应用显式提供 |
| `rows_processed` | BIGINT | 否 | 0 |
| `target_watermark` | TEXT | 否 | 应用显式提供 |
| `state` | TEXT | 否 | planned |
| `etag` | BIGINT | 否 | 1 |
| `created_at_ms` | BIGINT | 否 | 应用显式提供 |
| `updated_at_ms` | BIGINT | 否 | 应用显式提供 |

PK：`workspace_id, migration_id, source_table`。
FK：`workspace_id` → `workspaces(workspace_id)`。
CHECK：`length(source_fingerprint) = 64`。
CHECK：`rows_processed >= 0`。
CHECK：`etag > 0`。
CHECK：`state IN ('planned','running','verified','failed')`。
CHECK：`etag <= 9223372036854775807`。
CHECK：`created_at_ms >= 0`。
CHECK：`updated_at_ms >= 0`。

## ClickHouse 字段与物理键

生产环境的复制与分片由部署模板定义；这里是本地可执行的 ReplacingMergeTree 基线，不是 HA 配置。所有表具有 workspace 非空检查。排序键不是 SQL UNIQUE；不可变事实重试要求内容一致，读取正确性使用 FINAL/完整行 argMax，而非期待后台已合并。

### obs_trace_current

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `source_namespace` | LowCardinality(String) | 否 | '' |
| `native_trace_id` | String | 否 | '' |
| `root_trace_id` | String | 否 | '' |
| `agent_name` | String | 否 | '' |
| `framework` | LowCardinality(String) | 否 | '' |
| `started_at_ms` | Nullable(UInt64) | 是 | NULL |
| `ended_at_ms` | Nullable(UInt64) | 是 | NULL |
| `last_activity_at_ms` | Nullable(UInt64) | 是 | NULL |
| `execution_status` | LowCardinality(String) | 否 | '' |
| `span_count` | UInt64 | 否 | 0 |
| `llm_call_count` | UInt64 | 否 | 0 |
| `tool_call_count` | UInt64 | 否 | 0 |
| `input_tokens` | Nullable(UInt64) | 是 | NULL |
| `output_tokens` | Nullable(UInt64) | 是 | NULL |
| `cost_decimal` | String | 否 | '' |
| `currency` | LowCardinality(String) | 否 | '' |
| `price_rule_version` | String | 否 | '' |
| `attributes_json` | String | 否 | '{}' |
| `schema_version` | UInt16 | 否 | 1 |
| `revision` | UInt64 | 否 | 显式提供 |
| `is_deleted` | UInt8 | 否 | 0 |

ENGINE：`ReplacingMergeTree(revision)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, trace_id`。
CHECK：`is_deleted IN (0,1)`。
CHECK：`schema_version > 0`。
CHECK：`revision > 0 AND revision <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### obs_span_current

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `span_id` | String | 否 | 显式提供 |
| `parent_span_id` | String | 否 | '' |
| `source_namespace` | LowCardinality(String) | 否 | '' |
| `native_span_id` | String | 否 | '' |
| `kind` | LowCardinality(String) | 否 | '' |
| `name` | String | 否 | '' |
| `started_at_ms` | Nullable(UInt64) | 是 | NULL |
| `ended_at_ms` | Nullable(UInt64) | 是 | NULL |
| `duration_us` | Nullable(UInt64) | 是 | NULL |
| `model` | LowCardinality(String) | 否 | '' |
| `tool_name` | LowCardinality(String) | 否 | '' |
| `execution_status` | LowCardinality(String) | 否 | '' |
| `error_type` | LowCardinality(String) | 否 | '' |
| `input_tokens` | Nullable(UInt64) | 是 | NULL |
| `output_tokens` | Nullable(UInt64) | 是 | NULL |
| `payload_revision` | String | 否 | '' |
| `attributes_json` | String | 否 | '{}' |
| `schema_version` | UInt16 | 否 | 1 |
| `revision` | UInt64 | 否 | 显式提供 |
| `is_deleted` | UInt8 | 否 | 0 |

ENGINE：`ReplacingMergeTree(revision)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, trace_id, span_id`。
CHECK：`is_deleted IN (0,1)`。
CHECK：`schema_version > 0`。
CHECK：`revision > 0 AND revision <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### obs_payload_chunks

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `span_id` | String | 否 | 显式提供 |
| `payload_revision` | String | 否 | 显式提供 |
| `section` | LowCardinality(String) | 否 | 显式提供 |
| `chunk_no` | UInt32 | 否 | 显式提供 |
| `chunk_count` | UInt32 | 否 | 显式提供 |
| `uncompressed_bytes` | UInt32 | 否 | 显式提供 |
| `content_hash` | String | 否 | 显式提供 |
| `body` | String | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, trace_id, span_id, payload_revision, section, chunk_no`。
CHECK：`chunk_count > 0`。
CHECK：`chunk_no < chunk_count`。
CHECK：`uncompressed_bytes <= 262144`。
CHECK：`length(content_hash) = 64`。
CHECK：`length(body) = uncompressed_bytes`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### obs_events

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `event_id` | String | 否 | 显式提供 |
| `source_namespace` | LowCardinality(String) | 否 | '' |
| `event_type` | LowCardinality(String) | 否 | 显式提供 |
| `occurred_at_ms` | Nullable(UInt64) | 是 | NULL |
| `source_sequence` | String | 否 | '' |
| `payload_ref` | String | 否 | '' |
| `content_hash` | String | 否 | 显式提供 |
| `schema_version` | UInt16 | 否 | 1 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, trace_id, event_id`。
CHECK：`length(content_hash) = 64`。
CHECK：`schema_version > 0`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### obs_entity_relations

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `relation_id` | String | 否 | 显式提供 |
| `relation_kind` | LowCardinality(String) | 否 | 显式提供 |
| `source_entity_id` | String | 否 | 显式提供 |
| `target_entity_id` | String | 否 | 显式提供 |
| `attributes_json` | String | 否 | '{}' |
| `revision` | UInt64 | 否 | 显式提供 |
| `is_deleted` | UInt8 | 否 | 0 |

ENGINE：`ReplacingMergeTree(revision)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, relation_id`。
CHECK：`is_deleted IN (0,1)`。
CHECK：`revision > 0 AND revision <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### snapshot_nodes

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `snapshot_bucket` | Date | 否 | 显式提供 |
| `snapshot_id` | String | 否 | 显式提供 |
| `node_id` | String | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `span_id` | String | 否 | 显式提供 |
| `parent_node_id` | String | 否 | '' |
| `payload_revision` | String | 否 | '' |
| `node_json` | String | 否 | 显式提供 |
| `content_hash` | String | 否 | 显式提供 |
| `ordinal` | UInt64 | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(snapshot_bucket)`。
ORDER BY：`workspace_id, snapshot_bucket, snapshot_id, node_id`。
CHECK：`length(content_hash) = 64`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### dataset_sample_revisions

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `sample_bucket` | Date | 否 | 显式提供 |
| `dataset_id` | String | 否 | 显式提供 |
| `sample_revision_id` | String | 否 | 显式提供 |
| `case_key` | String | 否 | 显式提供 |
| `public_payload_ref` | String | 否 | 显式提供 |
| `private_payload_ref` | String | 否 | '' |
| `field_schema_release_id` | String | 否 | 显式提供 |
| `content_hash` | String | 否 | 显式提供 |
| `source_snapshot_id` | String | 否 | '' |
| `attributes_json` | String | 否 | '{}' |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(sample_bucket)`。
ORDER BY：`workspace_id, sample_bucket, dataset_id, sample_revision_id`。
CHECK：`length(content_hash) = 64`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### dataset_release_members

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `release_bucket` | Date | 否 | 显式提供 |
| `dataset_release_id` | String | 否 | 显式提供 |
| `ordinal` | UInt64 | 否 | 显式提供 |
| `case_key` | String | 否 | 显式提供 |
| `sample_revision_id` | String | 否 | 显式提供 |
| `sample_bucket` | Date | 否 | 显式提供 |
| `content_hash` | String | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(release_bucket)`。
ORDER BY：`workspace_id, release_bucket, dataset_release_id, ordinal`。
CHECK：`length(content_hash) = 64`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### eval_result_facts

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `result_bucket` | Date | 否 | 显式提供 |
| `result_id` | String | 否 | 显式提供 |
| `run_id` | String | 否 | 显式提供 |
| `case_key` | String | 否 | 显式提供 |
| `attempt_id` | String | 否 | 显式提供 |
| `evaluator_release_id` | String | 否 | 显式提供 |
| `input_snapshot_id` | String | 否 | 显式提供 |
| `verdict` | LowCardinality(String) | 否 | 显式提供 |
| `summary` | String | 否 | '' |
| `evidence_ref` | String | 否 | '' |
| `content_hash` | String | 否 | 显式提供 |
| `created_at_ms` | UInt64 | 否 | 显式提供 |
| `schema_version` | UInt16 | 否 | 1 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(result_bucket)`。
ORDER BY：`workspace_id, result_bucket, result_id`。
CHECK：`length(content_hash) = 64`。
CHECK：`verdict IN ('pass','warn','fail','inconclusive','not_applicable','error')`。
CHECK：`schema_version > 0`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### eval_metric_facts

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `result_bucket` | Date | 否 | 显式提供 |
| `result_id` | String | 否 | 显式提供 |
| `metric_definition_release_id` | String | 否 | 显式提供 |
| `metric_key` | String | 否 | 显式提供 |
| `dimension_key` | String | 否 | '' |
| `value_type` | LowCardinality(String) | 否 | 显式提供 |
| `value_int` | Nullable(Int64) | 是 | NULL |
| `value_float` | Nullable(Float64) | 是 | NULL |
| `value_decimal` | String | 否 | '' |
| `value_text` | String | 否 | '' |
| `unit` | LowCardinality(String) | 否 | '' |
| `method` | String | 否 | '' |
| `evidence_ref` | String | 否 | '' |
| `content_hash` | String | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(result_bucket)`。
ORDER BY：`workspace_id, result_bucket, result_id, metric_definition_release_id, metric_key, dimension_key`。
CHECK：`length(content_hash) = 64`。
CHECK：`value_type IN ('integer','float','decimal','boolean','category','missing')`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### eval_result_selection_current

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `run_bucket` | Date | 否 | 显式提供 |
| `run_id` | String | 否 | 显式提供 |
| `case_key` | String | 否 | 显式提供 |
| `evaluator_slot` | String | 否 | 显式提供 |
| `result_id` | String | 否 | 显式提供 |
| `review_decision_id` | String | 否 | '' |
| `selection_revision` | UInt64 | 否 | 显式提供 |
| `is_deleted` | UInt8 | 否 | 0 |

ENGINE：`ReplacingMergeTree(selection_revision)`。
PARTITION：`toYYYYMM(run_bucket)`。
ORDER BY：`workspace_id, run_bucket, run_id, case_key, evaluator_slot`。
CHECK：`is_deleted IN (0,1)`。
CHECK：`selection_revision > 0 AND selection_revision <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### eval_publication_members

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `publication_bucket` | Date | 否 | 显式提供 |
| `publication_id` | String | 否 | 显式提供 |
| `ordinal` | UInt64 | 否 | 显式提供 |
| `run_id` | String | 否 | 显式提供 |
| `case_key` | String | 否 | 显式提供 |
| `evaluator_slot` | String | 否 | 显式提供 |
| `result_id` | String | 否 | '' |
| `review_decision_id` | String | 否 | '' |
| `excluded_reason` | String | 否 | '' |
| `content_hash` | String | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(publication_bucket)`。
ORDER BY：`workspace_id, publication_bucket, publication_id, ordinal`。
CHECK：`length(content_hash) = 64`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。

### obs_payload_manifests

| 字段 | CH 类型 | 可空 | 默认 |
|---|---|---|---|
| `workspace_id` | String | 否 | 显式提供 |
| `trace_bucket` | Date | 否 | 显式提供 |
| `trace_id` | String | 否 | 显式提供 |
| `span_id` | String | 否 | 显式提供 |
| `payload_revision` | String | 否 | 显式提供 |
| `manifest_json` | String | 否 | 显式提供 |
| `retry_version` | UInt64 | 否 | 1 |

ENGINE：`ReplacingMergeTree(retry_version)`。
PARTITION：`toYYYYMM(trace_bucket)`。
ORDER BY：`workspace_id, trace_bucket, trace_id, span_id, payload_revision`。
CHECK：`retry_version > 0 AND retry_version <= 9223372036854775807`。
CHECK：`length(workspace_id) > 0`。
CHECK：`length(payload_revision) = 64`。
CHECK：`length(manifest_json) > 0`。

`payload_revision` 为全部 section 的 canonical bundle manifest 的 SHA-256，所有 section（如 input/output/tool_result）共享同一个 Span 正文版本。manifest_json 保存规范化清单，包含每个 section 的块数、字节数、块摘要和根摘要；先写齐、校验所有 section 的块，最后写此 manifest，再令 Span 引用该 revision。重试只能写相同内容，不能在同 revision 上替换某一 section。

读取时先取这个完整 bundle manifest，只从清单内读取对应 section/chunk 并核对完整性；不能以当前能查到的块数猜测正文已完整。SQL 只检查 manifest 非空、修订格式及整数范围，JSON 与 SHA-256 精确一致性由 canonical writer/reader 验证。

## 发布、并发和跨库一致性规则

1. **同资产别名**：alias 同时引用 workspace、asset、已封存 release 的复合键；草稿 base_release 也必须属于同一资产。禁止绑定另一个资产或租户的合法 release。
2. **发布封存**：一个事务插入 release、依赖边、seal，再更新 alias/outbox。seal.dependency_count 必须等于边数；seal 后拒绝追加/修改/删除依赖。PG/openGauss 触发器先锁 release 行串行化依赖插入和 seal，SQLite 短写事务串行化。同名同版本不可覆盖。
3. **冻结输入**：run_inputs 引用实际存在的固定 release，仅引用已封存 release，且在 runs.status=draft 时可 INSERT，随后不可 UPDATE/DELETE。非 draft 不能退回 draft，计划 hash/ref、Dataset release、分母和运行身份冻结。运行前固定计划；若需要更换输入，新建 run，不通过改 hash 欺骗旧实验。
4. **任务领取**：work_items 的 etag 是 CAS，evaluator_slot 冻结在 work item，唯一性为 run/case/phase/slot，因此同一 Case 可运行多个评估器；work_attempts 的 attempt_no 和 fence 在 item 内唯一，续租/完成必须匹配当前有效 attempt 与 fence。仅唯一键不能代替并发领取服务。
5. **结果归属**：result_receipts 的 workspace/run/item/attempt 复合引用保证回执属于自己的运行；result_selections 的 workspace/run/case/evaluator_slot/result_id 复合引用禁止在本租户内偷换其他 run、Case 或评估器槽的结果。evaluator_slot 默认 default，由任务冻结输入解释，不能在回调中随意改派。
6. **事务与 CH**：控制状态、结果回执与 outbox 同一 OLTP 事务提交；CH 写入和复制不参与此事务。状态区分 accepted/indexed/published，重复投递按稳定身份处理；失败不推进消费 checkpoint。
7. **Trace 身份**：内部 trace_id 删除后永不重用，locator 不硬删，deleted 不可恢复 active，bucket/source/native/incarnation 不可原地修改。相同原生 ID 重新出现须明确分配新内部 Trace ID 和新的 incarnation；不能复活旧数据。
8. **快照水位**：log_watermark 保存 JSON 向量 `{authority_epoch,topic,partitions:[{partition,offset}],sinks:...}`，不是假设全局单序号。snapshot_nodes 保存稳定成员与精确 payload_revision；RMT current 合并后不能按旧 revision 恢复历史。
9. **正文**：同 payload_revision 的块不可变；UTF-8 字节数与 hash 校验，块不超过 256KiB；所有块完整后才使 Span 引用该版本。CH 校验 length(body)=uncompressed_bytes，但 SHA-256/根 hash 由写入服务验证。obs_payload_manifests 将所有 section 固定在一个 bundle revision，发布 manifest 是正文写入链路的最后一步。
10. **分数与指标**：metric 的完整身份包含 metric_definition_release_id、key 与 dimension，避免不同指标版本冲突。只按有效 result selection 聚合，不能直接累计不同 Trace/Span 快照；未知不填零。
11. **备份与迁移**：源数据库只读预检/快照；目标全新隔离目录。回填保留身份映射和标准化版本，失败检查点可恢复，切换后新写入必须纳入反向迁移。旧库留存，不允许以重新建空库代替迁移。

## SQL 与机器目录

- [事务机器目录](../../../services/storage/schema/core-catalog.json)
- [CH 机器目录](../../../services/storage/schema/clickhouse-catalog.json)
- [SQLite DDL](../../../services/storage/schema/sqlite/001_core.sql)
- [PostgreSQL DDL](../../../services/storage/schema/postgresql/001_core.sql)
- [openGauss DDL](../../../services/storage/schema/opengauss/001_core.sql)
- [ClickHouse DDL](../../../services/storage/schema/clickhouse/001_core.sql)

表计数不包含由部署层生成的 Distributed/Replicated 代理、索引、触发器和物化视图。首轮是核心存储基础，不表示全平台 59 张逻辑表已细化或全部业务已迁移。

## 约束验证入口

- `python3 -m unittest discover -s services/storage/tests -p test_schema.py -v`：SQLite 真实引擎测试；未配置 PostgreSQL 容器时对应项明确 skip。
- `STORAGE_TEST_PG_CONTAINER=<专用 postgres:15-alpine 容器名> python3 -m unittest discover -s services/storage/tests -p test_schema.py -v`：通过容器内 psql 在随机临时 Schema 的事务内应用完整 PG DDL、验证关键约束，最后 ROLLBACK，不修改公共 Schema 或现有运行库。
- PG 实测仅证明该版本 DDL 和测试覆盖的约束；openGauss 不能由此推断通过。
