CREATE TABLE experiment_derived_issue_annotations (
  workspace_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  machine_result_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  resolved_run_id TEXT NOT NULL,
  resolved_at_ms BIGINT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  issue_payload_hash TEXT NOT NULL,
  machine_content_hash TEXT NOT NULL,
  selection_revision BIGINT NOT NULL,
  PRIMARY KEY (workspace_id,annotation_id),
  UNIQUE (workspace_id,actor_principal_id,operation_key,issue_id),
  UNIQUE (workspace_id,issue_id),
  FOREIGN KEY (workspace_id,experiment_id,issue_id) REFERENCES experiment_annotations (workspace_id,experiment_id,annotation_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,machine_result_id) REFERENCES result_receipts (workspace_id,result_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,actor_principal_id,operation_kind,operation_key) REFERENCES experiment_operation_receipts (workspace_id,actor_principal_id,operation_kind,operation_key) ON DELETE NO ACTION,
  CHECK (operation_kind='derived_issue_resolve'),
  CHECK (length(annotation_id)>0),
  CHECK (length(resolved_run_id) BETWEEN 1 AND 512),
  CHECK (length(operation_key)>0),
  CHECK (resolved_at_ms>=0 AND resolved_at_ms<=9223372036854775807),
  CHECK (selection_revision>0 AND selection_revision<=9223372036854775807),
  CHECK (length(request_hash)=64),
  CHECK (length(issue_payload_hash)=64),
  CHECK (length(machine_content_hash)=64),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (issue_payload_hash ~ '^[0-9a-f]{64}$'),
  CHECK (machine_content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_derived_issue_resolution_1 ON experiment_derived_issue_annotations (workspace_id,issue_id,resolved_at_ms,annotation_id);

CREATE FUNCTION derived_issue_resolution_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'derived issue annotations are immutable and retained'; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER derived_issue_resolution_guard BEFORE UPDATE OR DELETE ON experiment_derived_issue_annotations FOR EACH ROW EXECUTE PROCEDURE derived_issue_resolution_guard();

