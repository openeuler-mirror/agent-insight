CREATE TABLE dataset_compat_heads (
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  revision BIGINT NOT NULL DEFAULT 1,
  lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  read_only BIGINT NOT NULL DEFAULT 0,
  generation_source TEXT,
  generation_status TEXT,
  created_by TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id,dataset_id),
  UNIQUE (workspace_id,asset_id),
  UNIQUE (workspace_id,draft_id),
  CHECK (state IN ('active','deleted')),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (lifecycle_revision BETWEEN 1 AND 9223372036854775807),
  CHECK (read_only IN (0,1)),
  CHECK (length(manifest_hash)=64 AND manifest_hash !~ '[^0-9a-f]'),
  CHECK (length(dataset_id)>0 AND length(manifest_ref)>0),
  CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  CHECK ((state='active' AND deleted_by IS NULL AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_by IS NOT NULL AND deleted_at_ms IS NOT NULL AND deleted_at_ms>=0)),
  FOREIGN KEY (workspace_id,asset_id) REFERENCES asset_identities(workspace_id,asset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,draft_id) REFERENCES asset_drafts(workspace_id,draft_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,asset_id,release_id) REFERENCES asset_release_seals(workspace_id,asset_id,release_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals(principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (deleted_by) REFERENCES iam_principals(principal_id) ON DELETE NO ACTION
);

CREATE TABLE dataset_operation_receipts (
  workspace_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  response_ref TEXT NOT NULL,
  response_meta_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id,actor_principal_id,operation_kind,operation_key),
  CHECK (length(request_hash)=64 AND request_hash !~ '[^0-9a-f]'),
  CHECK (length(response_hash)=64 AND response_hash !~ '[^0-9a-f]'),
  CHECK (length(operation_kind)>0 AND length(operation_key)>0 AND length(response_ref)>0 AND length(response_meta_json)>0),
  CHECK (created_at_ms>=0),
  FOREIGN KEY (workspace_id,dataset_id) REFERENCES dataset_compat_heads(workspace_id,dataset_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals(principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_dataset_heads_state ON dataset_compat_heads(workspace_id,state,updated_at_ms,dataset_id);
CREATE INDEX idx_dataset_receipts_dataset ON dataset_operation_receipts(workspace_id,dataset_id,created_at_ms);

CREATE FUNCTION dataset_head_asset_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM asset_identities a JOIN asset_drafts d ON d.workspace_id=a.workspace_id AND d.asset_id=a.asset_id WHERE a.workspace_id=NEW.workspace_id AND a.asset_id=NEW.asset_id AND a.kind='dataset' AND d.draft_id=NEW.draft_id) THEN RAISE EXCEPTION 'dataset asset/draft mismatch'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER dataset_head_asset_guard BEFORE INSERT ON dataset_compat_heads FOR EACH ROW EXECUTE PROCEDURE dataset_head_asset_guard_fn();
CREATE FUNCTION dataset_head_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.workspace_id<>NEW.workspace_id OR OLD.dataset_id<>NEW.dataset_id OR OLD.asset_id<>NEW.asset_id OR OLD.draft_id<>NEW.draft_id OR OLD.created_by<>NEW.created_by OR OLD.created_at_ms<>NEW.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.read_only<OLD.read_only OR (OLD.state<>NEW.state AND NEW.lifecycle_revision<>OLD.lifecycle_revision+1) OR (OLD.state=NEW.state AND NEW.lifecycle_revision<>OLD.lifecycle_revision) THEN RAISE EXCEPTION 'dataset identity/revision immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER dataset_head_update_guard BEFORE UPDATE ON dataset_compat_heads FOR EACH ROW EXECUTE PROCEDURE dataset_head_update_guard_fn();
CREATE FUNCTION dataset_ledger_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dataset ledger retained immutable'; END; $$;
CREATE TRIGGER dataset_heads_no_delete BEFORE DELETE ON dataset_compat_heads FOR EACH ROW EXECUTE PROCEDURE dataset_ledger_immutable_fn();
CREATE TRIGGER dataset_receipts_no_update BEFORE UPDATE ON dataset_operation_receipts FOR EACH ROW EXECUTE PROCEDURE dataset_ledger_immutable_fn();
CREATE TRIGGER dataset_receipts_no_delete BEFORE DELETE ON dataset_operation_receipts FOR EACH ROW EXECUTE PROCEDURE dataset_ledger_immutable_fn();
