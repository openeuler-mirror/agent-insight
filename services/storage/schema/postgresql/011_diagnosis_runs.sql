CREATE TABLE diagnosis_runs (
  workspace_id TEXT NOT NULL,
  diagnosis_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  experiment_id TEXT,
  case_id TEXT,
  trace_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generator TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id,diagnosis_id),
  UNIQUE (workspace_id,actor_principal_id,request_key),
  UNIQUE (workspace_id,diagnosis_id,actor_principal_id),
  FOREIGN KEY (workspace_id,diagnosis_id) REFERENCES runs (workspace_id,run_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id) REFERENCES experiment_heads (workspace_id,experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,case_id) REFERENCES experiment_cases (workspace_id,case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,trace_id) REFERENCES trace_locators (workspace_id,trace_id) ON DELETE NO ACTION,
  CHECK (source_kind IN ('experiment','trace-report')),
  CHECK ((source_kind='experiment' AND experiment_id IS NOT NULL AND case_id IS NOT NULL) OR (source_kind='trace-report' AND experiment_id IS NULL AND case_id IS NULL)),
  CHECK (length(request_key) BETWEEN 1 AND 512),
  CHECK (length(generator) BETWEEN 1 AND 300),
  CHECK (length(snapshot_ref)>0),
  CHECK (created_at_ms>=0),
  CHECK (length(source_fingerprint)=64),
  CHECK (length(input_hash)=64),
  CHECK (length(snapshot_hash)=64),
  CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CHECK (snapshot_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_diagnosis_runs_source ON diagnosis_runs (workspace_id,experiment_id,case_id,created_at_ms);

CREATE INDEX idx_diagnosis_runs_actor ON diagnosis_runs (workspace_id,actor_principal_id,created_at_ms);

CREATE FUNCTION diagnosis_runs_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'diagnosis history immutable'; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER diagnosis_runs_immutable BEFORE UPDATE OR DELETE ON diagnosis_runs FOR EACH ROW EXECUTE PROCEDURE diagnosis_runs_guard();

CREATE TABLE diagnosis_judge_traces (
  workspace_id TEXT NOT NULL,
  diagnosis_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id,trace_id),
  FOREIGN KEY (workspace_id,diagnosis_id,owner_principal_id) REFERENCES diagnosis_runs (workspace_id,diagnosis_id,actor_principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,attempt_id) REFERENCES work_attempts (workspace_id,attempt_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,trace_id) REFERENCES trace_locators (workspace_id,trace_id) ON DELETE NO ACTION,
  CHECK (created_at_ms>=0)
);

CREATE INDEX idx_diagnosis_judge_traces_run ON diagnosis_judge_traces (workspace_id,diagnosis_id,attempt_id);

CREATE FUNCTION diagnosis_judge_traces_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'diagnosis history immutable'; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER diagnosis_judge_traces_immutable BEFORE UPDATE OR DELETE ON diagnosis_judge_traces FOR EACH ROW EXECUTE PROCEDURE diagnosis_judge_traces_guard();
