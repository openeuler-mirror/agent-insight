CREATE TABLE infra_metric_samples (
 workspace_id String,
 source_id String,
 sample_id String,
 owner_principal_id String,
 content_hash String,
 ts_ms Float64,
 received_at_ms Int64,
 sample_json String,
 retry_version UInt64 DEFAULT 1,
 CONSTRAINT infra_hash CHECK length(content_hash)=64,
 CONSTRAINT infra_clock CHECK isFinite(ts_ms),
 CONSTRAINT infra_received CHECK received_at_ms>=0,
 CONSTRAINT infra_retry CHECK retry_version>0 AND retry_version<=9223372036854775807
) ENGINE = ReplacingMergeTree(retry_version)
ORDER BY (workspace_id,source_id,ts_ms,sample_id);
