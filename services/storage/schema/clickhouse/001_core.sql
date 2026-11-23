CREATE TABLE obs_trace_current (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  source_namespace LowCardinality(String) DEFAULT '',
  native_trace_id String DEFAULT '',
  root_trace_id String DEFAULT '',
  agent_name String DEFAULT '',
  framework LowCardinality(String) DEFAULT '',
  started_at_ms Nullable(UInt64) DEFAULT NULL,
  ended_at_ms Nullable(UInt64) DEFAULT NULL,
  last_activity_at_ms Nullable(UInt64) DEFAULT NULL,
  execution_status LowCardinality(String) DEFAULT '',
  span_count UInt64 DEFAULT 0,
  llm_call_count UInt64 DEFAULT 0,
  tool_call_count UInt64 DEFAULT 0,
  input_tokens Nullable(UInt64) DEFAULT NULL,
  output_tokens Nullable(UInt64) DEFAULT NULL,
  cost_decimal String DEFAULT '',
  currency LowCardinality(String) DEFAULT '',
  price_rule_version String DEFAULT '',
  attributes_json String DEFAULT '{}',
  schema_version UInt16 DEFAULT 1,
  revision UInt64,
  is_deleted UInt8 DEFAULT 0,
  CONSTRAINT check_1 CHECK is_deleted IN (0,1),
  CONSTRAINT check_2 CHECK schema_version > 0,
  CONSTRAINT check_3 CHECK revision > 0 AND revision <= 9223372036854775807,
  CONSTRAINT check_4 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, trace_id);

CREATE TABLE obs_span_current (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  span_id String,
  parent_span_id String DEFAULT '',
  source_namespace LowCardinality(String) DEFAULT '',
  native_span_id String DEFAULT '',
  kind LowCardinality(String) DEFAULT '',
  name String DEFAULT '',
  started_at_ms Nullable(UInt64) DEFAULT NULL,
  ended_at_ms Nullable(UInt64) DEFAULT NULL,
  duration_us Nullable(UInt64) DEFAULT NULL,
  model LowCardinality(String) DEFAULT '',
  tool_name LowCardinality(String) DEFAULT '',
  execution_status LowCardinality(String) DEFAULT '',
  error_type LowCardinality(String) DEFAULT '',
  input_tokens Nullable(UInt64) DEFAULT NULL,
  output_tokens Nullable(UInt64) DEFAULT NULL,
  payload_revision String DEFAULT '',
  attributes_json String DEFAULT '{}',
  schema_version UInt16 DEFAULT 1,
  revision UInt64,
  is_deleted UInt8 DEFAULT 0,
  CONSTRAINT check_1 CHECK is_deleted IN (0,1),
  CONSTRAINT check_2 CHECK schema_version > 0,
  CONSTRAINT check_3 CHECK revision > 0 AND revision <= 9223372036854775807,
  CONSTRAINT check_4 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, trace_id, span_id);

CREATE TABLE obs_payload_chunks (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  span_id String,
  payload_revision String,
  section LowCardinality(String),
  chunk_no UInt32,
  chunk_count UInt32,
  uncompressed_bytes UInt32,
  content_hash String,
  body String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK chunk_count > 0,
  CONSTRAINT check_2 CHECK chunk_no < chunk_count,
  CONSTRAINT check_3 CHECK uncompressed_bytes <= 262144,
  CONSTRAINT check_4 CHECK length(content_hash) = 64,
  CONSTRAINT check_5 CHECK length(body) = uncompressed_bytes,
  CONSTRAINT check_6 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_7 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, trace_id, span_id, payload_revision, section, chunk_no);

CREATE TABLE obs_events (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  event_id String,
  source_namespace LowCardinality(String) DEFAULT '',
  event_type LowCardinality(String),
  occurred_at_ms Nullable(UInt64) DEFAULT NULL,
  source_sequence String DEFAULT '',
  payload_ref String DEFAULT '',
  content_hash String,
  schema_version UInt16 DEFAULT 1,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK schema_version > 0,
  CONSTRAINT check_3 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_4 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, trace_id, event_id);

CREATE TABLE obs_entity_relations (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  relation_id String,
  relation_kind LowCardinality(String),
  source_entity_id String,
  target_entity_id String,
  attributes_json String DEFAULT '{}',
  revision UInt64,
  is_deleted UInt8 DEFAULT 0,
  CONSTRAINT check_1 CHECK is_deleted IN (0,1),
  CONSTRAINT check_2 CHECK revision > 0 AND revision <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, relation_id);

CREATE TABLE snapshot_nodes (
  workspace_id String,
  snapshot_bucket Date,
  snapshot_id String,
  node_id String,
  trace_id String,
  span_id String,
  parent_node_id String DEFAULT '',
  payload_revision String DEFAULT '',
  node_json String,
  content_hash String,
  ordinal UInt64,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(snapshot_bucket)
ORDER BY (workspace_id, snapshot_bucket, snapshot_id, node_id);

CREATE TABLE dataset_sample_revisions (
  workspace_id String,
  sample_bucket Date,
  dataset_id String,
  sample_revision_id String,
  case_key String,
  public_payload_ref String,
  private_payload_ref String DEFAULT '',
  field_schema_release_id String,
  content_hash String,
  source_snapshot_id String DEFAULT '',
  attributes_json String DEFAULT '{}',
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(sample_bucket)
ORDER BY (workspace_id, sample_bucket, dataset_id, sample_revision_id);

CREATE TABLE dataset_release_members (
  workspace_id String,
  release_bucket Date,
  dataset_release_id String,
  ordinal UInt64,
  case_key String,
  sample_revision_id String,
  sample_bucket Date,
  content_hash String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(release_bucket)
ORDER BY (workspace_id, release_bucket, dataset_release_id, ordinal);

CREATE TABLE eval_result_facts (
  workspace_id String,
  result_bucket Date,
  result_id String,
  run_id String,
  case_key String,
  attempt_id String,
  evaluator_release_id String,
  input_snapshot_id String,
  verdict LowCardinality(String),
  summary String DEFAULT '',
  evidence_ref String DEFAULT '',
  content_hash String,
  created_at_ms UInt64,
  schema_version UInt16 DEFAULT 1,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK verdict IN ('pass','warn','fail','inconclusive','not_applicable','error'),
  CONSTRAINT check_3 CHECK schema_version > 0,
  CONSTRAINT check_4 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_5 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(result_bucket)
ORDER BY (workspace_id, result_bucket, result_id);

CREATE TABLE eval_metric_facts (
  workspace_id String,
  result_bucket Date,
  result_id String,
  metric_definition_release_id String,
  metric_key String,
  dimension_key String DEFAULT '',
  value_type LowCardinality(String),
  value_int Nullable(Int64) DEFAULT NULL,
  value_float Nullable(Float64) DEFAULT NULL,
  value_decimal String DEFAULT '',
  value_text String DEFAULT '',
  unit LowCardinality(String) DEFAULT '',
  method String DEFAULT '',
  evidence_ref String DEFAULT '',
  content_hash String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK value_type IN ('integer','float','decimal','boolean','category','missing'),
  CONSTRAINT check_3 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_4 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(result_bucket)
ORDER BY (workspace_id, result_bucket, result_id, metric_definition_release_id, metric_key, dimension_key);

CREATE TABLE eval_result_selection_current (
  workspace_id String,
  run_bucket Date,
  run_id String,
  case_key String,
  evaluator_slot String,
  result_id String,
  review_decision_id String DEFAULT '',
  selection_revision UInt64,
  is_deleted UInt8 DEFAULT 0,
  CONSTRAINT check_1 CHECK is_deleted IN (0,1),
  CONSTRAINT check_2 CHECK selection_revision > 0 AND selection_revision <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(selection_revision)
PARTITION BY toYYYYMM(run_bucket)
ORDER BY (workspace_id, run_bucket, run_id, case_key, evaluator_slot);

CREATE TABLE eval_publication_members (
  workspace_id String,
  publication_bucket Date,
  publication_id String,
  ordinal UInt64,
  run_id String,
  case_key String,
  evaluator_slot String,
  result_id String DEFAULT '',
  review_decision_id String DEFAULT '',
  excluded_reason String DEFAULT '',
  content_hash String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash) = 64,
  CONSTRAINT check_2 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_3 CHECK length(workspace_id) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(publication_bucket)
ORDER BY (workspace_id, publication_bucket, publication_id, ordinal);

CREATE TABLE obs_payload_manifests (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  span_id String,
  payload_revision String,
  manifest_json String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK retry_version > 0 AND retry_version <= 9223372036854775807,
  CONSTRAINT check_2 CHECK length(workspace_id) > 0,
  CONSTRAINT check_3 CHECK length(payload_revision) = 64,
  CONSTRAINT check_4 CHECK length(manifest_json) > 0
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id, trace_bucket, trace_id, span_id, payload_revision);
