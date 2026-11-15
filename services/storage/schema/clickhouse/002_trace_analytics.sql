CREATE TABLE obs_trace_analytics (
  workspace_id String,
  trace_bucket Date,
  trace_id String,
  boundary String,
  parser_version UInt16,
  projection_hash String,
  projection_json String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(boundary)=64,
  CONSTRAINT check_2 CHECK length(projection_hash)=64,
  CONSTRAINT check_3 CHECK parser_version=1,
  CONSTRAINT check_4 CHECK length(projection_json)<=2097152,
  CONSTRAINT check_5 CHECK retry_version>0 AND retry_version<=9223372036854775807
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(trace_bucket)
ORDER BY (workspace_id,trace_bucket,trace_id,boundary,parser_version,projection_hash);

CREATE TABLE obs_ras_events (
  workspace_id String,
  event_bucket Date,
  owner_principal_id String,
  task_id String,
  event_key String,
  event_id String,
  content_hash String,
  event_json String,
  retry_version UInt64 DEFAULT 1,
  CONSTRAINT check_1 CHECK length(content_hash)=64,
  CONSTRAINT check_2 CHECK length(event_json)<=262144,
  CONSTRAINT check_3 CHECK retry_version>0 AND retry_version<=9223372036854775807
) ENGINE = ReplacingMergeTree(retry_version)
PARTITION BY toYYYYMM(event_bucket)
ORDER BY (workspace_id,event_bucket,owner_principal_id,task_id,event_key,content_hash);
