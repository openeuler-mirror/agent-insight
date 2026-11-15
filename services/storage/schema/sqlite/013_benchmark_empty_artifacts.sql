CREATE TABLE benchmark_artifacts_v13 (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_hash TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,artifact_id),
  UNIQUE (workspace_id,job_id,name),
  FOREIGN KEY (workspace_id,job_id) REFERENCES benchmark_jobs (workspace_id,job_id) ON DELETE NO ACTION,
  CHECK (length(name) BETWEEN 1 AND 512),
  CHECK (size_bytes BETWEEN 0 AND 67108864),
  CHECK (length(media_type) BETWEEN 1 AND 256),
  CHECK (length(content_hash)=64),
  CHECK (size_bytes>=0 AND size_bytes<=9223372036854775807),
  CHECK (length(storage_hash)=64),
  CHECK (length(storage_ref)>0),
  CHECK (length(contract_hash)=64),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(size_bytes)='integer'),
  CHECK (storage_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (contract_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

INSERT INTO benchmark_artifacts_v13 SELECT * FROM benchmark_artifacts;

DROP TABLE benchmark_artifacts;

ALTER TABLE benchmark_artifacts_v13 RENAME TO benchmark_artifacts;

CREATE INDEX idx_benchmark_artifacts_1 ON benchmark_artifacts (workspace_id,job_id,created_at_ms);

CREATE INDEX idx_benchmark_artifacts_2 ON benchmark_artifacts (workspace_id,content_hash);

CREATE TRIGGER benchmark_artifacts_guard BEFORE UPDATE ON benchmark_artifacts WHEN 1=1 BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_artifacts_retained BEFORE DELETE ON benchmark_artifacts BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;

