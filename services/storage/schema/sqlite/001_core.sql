PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  PRIMARY KEY (version),
  CHECK (version > 0),
  CHECK (applied_at_ms >= 0),
  CHECK (typeof(version) = 'integer'),
  CHECK (typeof(applied_at_ms) = 'integer')
);

CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id),
  CHECK (state IN ('active','suspended','deleted')),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer')
);

CREATE TABLE asset_identities (
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  description TEXT NOT NULL DEFAULT '',
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, asset_id),
  UNIQUE (workspace_id, kind, name),
  CHECK (kind IN ('skill','agent','evaluator','dataset','benchmark')),
  CHECK (visibility IN ('private','workspace','public')),
  CHECK (etag > 0),
  CHECK (length(name) > 0),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_asset_identities_1 ON asset_identities (workspace_id, kind, created_at_ms);

CREATE TABLE asset_releases (
  workspace_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest_ref TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  publisher_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, release_id),
  UNIQUE (workspace_id, asset_id, version_label),
  UNIQUE (workspace_id, asset_id, release_id),
  CHECK (length(content_hash) = 64),
  CHECK (schema_version > 0),
  CHECK (length(version_label) > 0),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(schema_version) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES asset_identities (workspace_id, asset_id) ON DELETE NO ACTION
);

CREATE INDEX idx_asset_releases_1 ON asset_releases (workspace_id, asset_id, created_at_ms);

CREATE TABLE asset_drafts (
  workspace_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_release_id TEXT,
  manifest_json TEXT NOT NULL,
  edit_revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, draft_id),
  UNIQUE (workspace_id, asset_id, branch_name),
  CHECK (edit_revision > 0),
  CHECK (edit_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(edit_revision) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES asset_identities (workspace_id, asset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, asset_id, base_release_id) REFERENCES asset_releases (workspace_id, asset_id, release_id) ON DELETE NO ACTION
);

CREATE TABLE asset_release_dependencies (
  workspace_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  role TEXT NOT NULL,
  dependency_release_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, release_id, role, dependency_release_id),
  CHECK (release_id <> dependency_release_id),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, release_id) REFERENCES asset_releases (workspace_id, release_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, dependency_release_id) REFERENCES asset_releases (workspace_id, release_id) ON DELETE NO ACTION
);

CREATE INDEX idx_asset_release_dependencies_1 ON asset_release_dependencies (workspace_id, dependency_release_id);

CREATE TABLE asset_release_seals (
  workspace_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  dependency_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, release_id),
  UNIQUE (workspace_id, asset_id, release_id),
  CHECK (dependency_count >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(dependency_count) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, asset_id, release_id) REFERENCES asset_releases (workspace_id, asset_id, release_id) ON DELETE NO ACTION
);

CREATE TABLE asset_aliases (
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  release_id TEXT NOT NULL,
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, asset_id, alias),
  CHECK (etag > 0),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES asset_identities (workspace_id, asset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, asset_id, release_id) REFERENCES asset_release_seals (workspace_id, asset_id, release_id) ON DELETE NO ACTION
);

CREATE TABLE runs (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_manifest_ref TEXT NOT NULL,
  dataset_release_id TEXT,
  expected_case_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  CHECK (length(plan_hash) = 64),
  CHECK (expected_case_count >= 0),
  CHECK (etag > 0),
  CHECK (status IN ('draft','queued','running','done','partial','failed','cancelled')),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(expected_case_count) = 'integer'),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, dataset_release_id) REFERENCES asset_release_seals (workspace_id, release_id) ON DELETE NO ACTION
);

CREATE INDEX idx_runs_1 ON runs (workspace_id, status, created_at_ms);

CREATE TABLE run_inputs (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  release_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id, slot),
  CHECK (length(config_hash) = 64),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, release_id) REFERENCES asset_release_seals (workspace_id, release_id) ON DELETE NO ACTION
);

CREATE TABLE work_items (
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  case_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  evaluator_slot TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  etag INTEGER NOT NULL DEFAULT 1,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, work_item_id),
  UNIQUE (workspace_id, run_id, case_key, phase, evaluator_slot),
  UNIQUE (workspace_id, run_id, work_item_id),
  UNIQUE (workspace_id, run_id, work_item_id, case_key),
  UNIQUE (workspace_id, run_id, work_item_id, case_key, evaluator_slot),
  CHECK (etag > 0),
  CHECK (cancel_requested IN (0,1)),
  CHECK (phase IN ('execute','evaluate','snapshot','publish','migrate')),
  CHECK (status IN ('queued','running','done','failed','cancelled')),
  CHECK (etag <= 9223372036854775807),
  CHECK (next_attempt_at_ms >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(priority) = 'integer'),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(next_attempt_at_ms) = 'integer'),
  CHECK (typeof(cancel_requested) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, run_id) ON DELETE NO ACTION
);

CREATE INDEX idx_work_items_1 ON work_items (workspace_id, status, next_attempt_at_ms, priority);

CREATE INDEX idx_work_items_2 ON work_items (workspace_id, run_id, status);

CREATE TABLE work_attempts (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  error_code TEXT,
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, work_item_id, attempt_no),
  UNIQUE (workspace_id, work_item_id, fence),
  UNIQUE (workspace_id, work_item_id, attempt_id),
  CHECK (attempt_no > 0),
  CHECK (fence > 0),
  CHECK (status IN ('running','done','failed','cancelled','expired')),
  CHECK (lease_until_ms >= started_at_ms),
  CHECK (fence <= 9223372036854775807),
  CHECK (lease_until_ms >= 0),
  CHECK (started_at_ms >= 0),
  CHECK (finished_at_ms >= 0),
  CHECK (typeof(attempt_no) = 'integer'),
  CHECK (typeof(fence) = 'integer'),
  CHECK (typeof(lease_until_ms) = 'integer'),
  CHECK (typeof(started_at_ms) = 'integer'),
  CHECK (finished_at_ms IS NULL OR typeof(finished_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items (workspace_id, work_item_id) ON DELETE NO ACTION
);

CREATE INDEX idx_work_attempts_1 ON work_attempts (workspace_id, status, lease_until_ms);

CREATE INDEX idx_work_attempts_2 ON work_attempts (workspace_id, work_item_id, attempt_no);

CREATE TABLE result_receipts (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  case_key TEXT NOT NULL,
  evaluator_slot TEXT NOT NULL DEFAULT 'default',
  receipt_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted',
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, receipt_id),
  UNIQUE (workspace_id, attempt_id, receipt_key),
  UNIQUE (workspace_id, result_id),
  UNIQUE (workspace_id, run_id, result_id),
  UNIQUE (workspace_id, run_id, case_key, evaluator_slot, result_id),
  CHECK (length(content_hash) = 64),
  CHECK (state IN ('accepted','indexed','published','quarantined')),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, work_item_id, attempt_id) REFERENCES work_attempts (workspace_id, work_item_id, attempt_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id, work_item_id, case_key, evaluator_slot) REFERENCES work_items (workspace_id, run_id, work_item_id, case_key, evaluator_slot) ON DELETE NO ACTION
);

CREATE INDEX idx_result_receipts_1 ON result_receipts (workspace_id, state, created_at_ms);

CREATE TABLE result_selections (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  case_key TEXT NOT NULL,
  evaluator_slot TEXT NOT NULL,
  result_id TEXT NOT NULL,
  selection_revision INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id, case_key, evaluator_slot),
  CHECK (selection_revision > 0),
  CHECK (selection_revision <= 9223372036854775807),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(selection_revision) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id, case_key, evaluator_slot, result_id) REFERENCES result_receipts (workspace_id, run_id, case_key, evaluator_slot, result_id) ON DELETE NO ACTION
);

CREATE TABLE outbox_events (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, aggregate_id, aggregate_revision, event_type),
  CHECK (aggregate_revision > 0),
  CHECK (attempts >= 0),
  CHECK (state IN ('pending','dispatching','sent','dead')),
  CHECK (next_attempt_at_ms >= 0),
  CHECK (lease_until_ms >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(aggregate_revision) = 'integer'),
  CHECK (typeof(attempts) = 'integer'),
  CHECK (typeof(next_attempt_at_ms) = 'integer'),
  CHECK (lease_until_ms IS NULL OR typeof(lease_until_ms) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_outbox_events_1 ON outbox_events (state, next_attempt_at_ms, created_at_ms);

CREATE INDEX idx_outbox_events_2 ON outbox_events (workspace_id, aggregate_id, aggregate_revision);

CREATE TABLE inbox_receipts (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_id, event_id),
  CHECK (length(content_hash) = 64),
  CHECK (processed_at_ms >= 0),
  CHECK (typeof(processed_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE TABLE trace_locators (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  native_trace_id TEXT NOT NULL,
  trace_bucket TEXT NOT NULL,
  route_epoch INTEGER NOT NULL DEFAULT 1,
  incarnation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, trace_id),
  UNIQUE (workspace_id, source_namespace, native_trace_id, incarnation),
  CHECK (route_epoch > 0),
  CHECK (incarnation > 0),
  CHECK (state IN ('active','deleting','deleted')),
  CHECK (route_epoch <= 9223372036854775807),
  CHECK (incarnation <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(route_epoch) = 'integer'),
  CHECK (typeof(incarnation) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_trace_locators_1 ON trace_locators (workspace_id, trace_bucket, state);

CREATE TABLE snapshot_manifests (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  trace_id TEXT,
  manifest_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  log_watermark TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staging',
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  PRIMARY KEY (workspace_id, snapshot_id),
  CHECK (node_count >= 0),
  CHECK (length(content_hash) = 64),
  CHECK (state IN ('staging','published','failed')),
  CHECK (created_at_ms >= 0),
  CHECK (published_at_ms >= 0),
  CHECK (typeof(node_count) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (published_at_ms IS NULL OR typeof(published_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_snapshot_manifests_1 ON snapshot_manifests (workspace_id, state, created_at_ms);

CREATE TABLE artifact_metadata (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staging',
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  PRIMARY KEY (workspace_id, artifact_id),
  UNIQUE (workspace_id, namespace, object_ref),
  CHECK (length(content_hash) = 64),
  CHECK (size_bytes >= 0),
  CHECK (state IN ('staging','published','deleted')),
  CHECK (created_at_ms >= 0),
  CHECK (published_at_ms >= 0),
  CHECK (typeof(size_bytes) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (published_at_ms IS NULL OR typeof(published_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_artifact_metadata_1 ON artifact_metadata (workspace_id, state, created_at_ms);

CREATE TABLE deletion_requests (
  workspace_id TEXT NOT NULL,
  deletion_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  barrier_revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested',
  requested_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, deletion_id),
  UNIQUE (workspace_id, resource_kind, resource_id, incarnation),
  CHECK (incarnation > 0),
  CHECK (barrier_revision > 0),
  CHECK (state IN ('requested','blocked','propagating','purged','failed')),
  CHECK (incarnation <= 9223372036854775807),
  CHECK (barrier_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(incarnation) = 'integer'),
  CHECK (typeof(barrier_revision) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_deletion_requests_1 ON deletion_requests (workspace_id, state, created_at_ms);

CREATE TABLE migration_checkpoints (
  workspace_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_table TEXT NOT NULL,
  last_key TEXT NOT NULL,
  rows_processed INTEGER NOT NULL DEFAULT 0,
  target_watermark TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, migration_id, source_table),
  CHECK (length(source_fingerprint) = 64),
  CHECK (rows_processed >= 0),
  CHECK (etag > 0),
  CHECK (state IN ('planned','running','verified','failed')),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(rows_processed) = 'integer'),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE TRIGGER immutable_asset_releases_update BEFORE UPDATE ON asset_releases BEGIN SELECT RAISE(ABORT, 'immutable asset_releases'); END;

CREATE TRIGGER immutable_asset_releases_delete BEFORE DELETE ON asset_releases BEGIN SELECT RAISE(ABORT, 'immutable asset_releases'); END;

CREATE TRIGGER immutable_asset_release_dependencies_update BEFORE UPDATE ON asset_release_dependencies BEGIN SELECT RAISE(ABORT, 'immutable asset_release_dependencies'); END;

CREATE TRIGGER immutable_asset_release_dependencies_delete BEFORE DELETE ON asset_release_dependencies BEGIN SELECT RAISE(ABORT, 'immutable asset_release_dependencies'); END;

CREATE TRIGGER immutable_asset_release_seals_update BEFORE UPDATE ON asset_release_seals BEGIN SELECT RAISE(ABORT, 'immutable asset_release_seals'); END;

CREATE TRIGGER immutable_asset_release_seals_delete BEFORE DELETE ON asset_release_seals BEGIN SELECT RAISE(ABORT, 'immutable asset_release_seals'); END;

CREATE TRIGGER immutable_run_inputs_update BEFORE UPDATE ON run_inputs BEGIN SELECT RAISE(ABORT, 'immutable run_inputs'); END;

CREATE TRIGGER immutable_run_inputs_delete BEFORE DELETE ON run_inputs BEGIN SELECT RAISE(ABORT, 'immutable run_inputs'); END;

CREATE TRIGGER immutable_inbox_receipts_update BEFORE UPDATE ON inbox_receipts BEGIN SELECT RAISE(ABORT, 'immutable inbox_receipts'); END;

CREATE TRIGGER immutable_inbox_receipts_delete BEFORE DELETE ON inbox_receipts BEGIN SELECT RAISE(ABORT, 'immutable inbox_receipts'); END;

CREATE TRIGGER dependencies_sealed BEFORE INSERT ON asset_release_dependencies WHEN EXISTS (SELECT 1 FROM asset_release_seals WHERE workspace_id=NEW.workspace_id AND release_id=NEW.release_id) BEGIN SELECT RAISE(ABORT, 'release dependencies sealed'); END;

CREATE TRIGGER seal_count_matches BEFORE INSERT ON asset_release_seals WHEN NEW.dependency_count <> (SELECT COUNT(*) FROM asset_release_dependencies WHERE workspace_id=NEW.workspace_id AND release_id=NEW.release_id) BEGIN SELECT RAISE(ABORT, 'dependency count mismatch'); END;

CREATE TRIGGER run_inputs_frozen BEFORE INSERT ON run_inputs WHEN EXISTS (SELECT 1 FROM runs WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND status<>'draft') BEGIN SELECT RAISE(ABORT, 'run inputs frozen'); END;

CREATE TRIGGER trace_identity_stable BEFORE UPDATE ON trace_locators WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.trace_id<>NEW.trace_id OR OLD.trace_bucket<>NEW.trace_bucket OR OLD.source_namespace<>NEW.source_namespace OR OLD.native_trace_id<>NEW.native_trace_id OR OLD.incarnation<>NEW.incarnation OR (OLD.state='deleted' AND NEW.state<>'deleted') BEGIN SELECT RAISE(ABORT, 'trace identity cannot change or resurrect'); END;

CREATE TRIGGER trace_locator_no_delete BEFORE DELETE ON trace_locators BEGIN SELECT RAISE(ABORT, 'trace locator deletion ledger retained'); END;

CREATE TRIGGER run_plan_frozen BEFORE UPDATE ON runs WHEN (OLD.status <> 'draft' AND NEW.status = 'draft') OR (OLD.status <> 'draft' AND (OLD.workspace_id IS NOT NEW.workspace_id OR OLD.run_id IS NOT NEW.run_id OR OLD.plan_hash IS NOT NEW.plan_hash OR OLD.plan_manifest_ref IS NOT NEW.plan_manifest_ref OR OLD.dataset_release_id IS NOT NEW.dataset_release_id OR OLD.expected_case_count IS NOT NEW.expected_case_count)) BEGIN SELECT RAISE(ABORT, 'run plan frozen'); END;
