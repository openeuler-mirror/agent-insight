CREATE TABLE diagnostic_report_runs (
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  request_key TEXT,
  execution_id TEXT NOT NULL,
  interactions_hash TEXT NOT NULL,
  generator TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  lease_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  payload_hash TEXT,
  payload_ref TEXT,
  progress_hash TEXT,
  progress_ref TEXT,
  error_message TEXT,
  lease_until_ms BIGINT,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, report_id),
  UNIQUE (workspace_id, trace_id, kind, report_id),
  UNIQUE (workspace_id, actor_principal_id, kind, request_key),
  CHECK (kind IN ('agent-debug','skills-analysis')),
  CHECK (status IN ('running','done','failed','skipped')),
  CHECK (length(report_id)>0),
  CHECK (interactions_hash IS NULL OR (interactions_hash ~ '^[0-9a-f]{64}$')),
  CHECK (evidence_hash IS NULL OR (evidence_hash ~ '^[0-9a-f]{64}$')),
  CHECK (lease_secret_hash IS NULL OR (lease_secret_hash ~ '^[0-9a-f]{64}$')),
  CHECK (payload_hash IS NULL OR (payload_hash ~ '^[0-9a-f]{64}$')),
  CHECK (progress_hash IS NULL OR (progress_hash ~ '^[0-9a-f]{64}$')),
  CHECK (length(execution_id)>0),
  CHECK (length(generator) BETWEEN 1 AND 300),
  CHECK (request_key IS NULL OR length(request_key) BETWEEN 1 AND 512),
  CHECK (length(interactions_hash)=64),
  CHECK (length(evidence_hash)=64),
  CHECK (length(lease_secret_hash)=64),
  CHECK (length(scope_fingerprint)>0),
  CHECK (length(evidence_ref)>0),
  CHECK ((payload_hash IS NULL AND payload_ref IS NULL) OR (payload_hash IS NOT NULL AND payload_ref IS NOT NULL AND length(payload_hash)=64 AND length(payload_ref)>0)),
  CHECK ((progress_hash IS NULL AND progress_ref IS NULL) OR (progress_hash IS NOT NULL AND progress_ref IS NOT NULL AND length(progress_hash)=64 AND length(progress_ref)>0)),
  CHECK (status NOT IN ('done','skipped') OR payload_ref IS NOT NULL),
  CHECK (error_message IS NULL OR length(error_message)<=2000),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (lease_until_ms IS NULL OR lease_until_ms>=created_at_ms),
  CHECK (status<>'running' OR lease_until_ms IS NOT NULL),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_diagnostic_report_runs_trace ON diagnostic_report_runs (workspace_id, trace_id, kind, created_at_ms);

CREATE TABLE diagnostic_report_heads (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  report_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, trace_id, kind),
  FOREIGN KEY (workspace_id, trace_id, kind, report_id) REFERENCES diagnostic_report_runs (workspace_id, trace_id, kind, report_id) ON DELETE NO ACTION
);

CREATE FUNCTION guard_diagnostic_report_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'diagnostic report history retained'; END IF; IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.report_id IS DISTINCT FROM OLD.report_id OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.actor_principal_id IS DISTINCT FROM OLD.actor_principal_id OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.interactions_hash IS DISTINCT FROM OLD.interactions_hash OR NEW.generator IS DISTINCT FROM OLD.generator OR NEW.scope_fingerprint IS DISTINCT FROM OLD.scope_fingerprint OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.lease_secret_hash IS DISTINCT FROM OLD.lease_secret_hash OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR OLD.status<>'running' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN RAISE EXCEPTION 'diagnostic report immutable or invalid revision'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER diagnostic_report_runs_immutable BEFORE UPDATE OR DELETE ON diagnostic_report_runs FOR EACH ROW EXECUTE PROCEDURE guard_diagnostic_report_run();
CREATE FUNCTION guard_diagnostic_report_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'diagnostic report head key immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER diagnostic_report_heads_key_immutable BEFORE UPDATE ON diagnostic_report_heads FOR EACH ROW EXECUTE PROCEDURE guard_diagnostic_report_head();
