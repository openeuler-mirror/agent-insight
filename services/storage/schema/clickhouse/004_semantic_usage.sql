CREATE TABLE semantic_immutable_facts (
 workspace_id String, owner_principal_id String, kind String, record_id String,
 content_hash String, body_json String, retry_version UInt64 DEFAULT 1,
 CONSTRAINT semantic_immutable_facts_hash CHECK length(content_hash)=64,
 CONSTRAINT semantic_immutable_facts_retry CHECK retry_version>0
) ENGINE = ReplacingMergeTree(retry_version)
ORDER BY(workspace_id,owner_principal_id,kind,record_id,content_hash);
CREATE TABLE usage_event_facts (
 workspace_id String, owner_principal_id String, kind String, record_id String,
 content_hash String, body_json String, retry_version UInt64 DEFAULT 1,
 CONSTRAINT usage_event_facts_hash CHECK length(content_hash)=64,
 CONSTRAINT usage_event_facts_retry CHECK retry_version>0
) ENGINE = ReplacingMergeTree(retry_version)
ORDER BY(workspace_id,owner_principal_id,kind,record_id,content_hash);
CREATE TABLE usage_daily_facts (
 workspace_id String, owner_principal_id String, kind String, record_id String,
 content_hash String, body_json String, retry_version UInt64 DEFAULT 1,
 CONSTRAINT usage_daily_facts_hash CHECK length(content_hash)=64,
 CONSTRAINT usage_daily_facts_retry CHECK retry_version>0
) ENGINE = ReplacingMergeTree(retry_version)
ORDER BY(workspace_id,owner_principal_id,kind,record_id,content_hash);
