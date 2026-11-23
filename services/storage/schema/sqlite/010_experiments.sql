CREATE TABLE experiment_heads (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL,
  watch_mode INTEGER NOT NULL DEFAULT 0,
  watch_enabled_at_ms INTEGER,
  metadata_hash TEXT NOT NULL,
  metadata_ref TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  lifecycle_revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  current_run_id TEXT,
  created_by TEXT NOT NULL,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, experiment_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, current_run_id) REFERENCES experiment_runs (workspace_id, experiment_id, run_id) ON DELETE NO ACTION,
  CHECK (state IN ('active','deleted')),
  CHECK (status IN ('draft','queued','running','done','partial','failed','cancelled')),
  CHECK (type IN ('single','llm','framework','skill')),
  CHECK (watch_mode IN (0,1)),
  CHECK ((state='active' AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_at_ms IS NOT NULL)),
  CHECK (length(name)>0),
  CHECK (length(experiment_id)>0),
  CHECK (watch_mode >= 0 AND watch_mode <= 9223372036854775807),
  CHECK (watch_enabled_at_ms >= 0 AND watch_enabled_at_ms <= 9223372036854775807),
  CHECK (length(metadata_hash)=64),
  CHECK (length(metadata_ref)>0),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (deleted_at_ms >= 0 AND deleted_at_ms <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (typeof(watch_mode)='integer'),
  CHECK (watch_enabled_at_ms IS NULL OR typeof(watch_enabled_at_ms)='integer'),
  CHECK (metadata_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(lifecycle_revision)='integer'),
  CHECK (deleted_at_ms IS NULL OR typeof(deleted_at_ms)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);

CREATE INDEX idx_experiment_heads_1 ON experiment_heads (workspace_id, state, scope, updated_at_ms, experiment_id);

CREATE INDEX idx_experiment_heads_2 ON experiment_heads (workspace_id, watch_mode, agent_name);

CREATE TRIGGER experiment_heads_update_guard BEFORE UPDATE ON experiment_heads WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.created_by<>OLD.created_by OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<>OLD.lifecycle_revision+(CASE WHEN NEW.state<>OLD.state THEN 1 ELSE 0 END) BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_heads_delete_guard BEFORE DELETE ON experiment_heads BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_runs (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  UNIQUE (workspace_id, experiment_id, run_id),
  UNIQUE (workspace_id, experiment_id, generation),
  FOREIGN KEY (workspace_id, experiment_id) REFERENCES experiment_heads (workspace_id, experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(experiment_id)>0),
  CHECK (generation >= 1 AND generation <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (typeof(generation)='integer'),
  CHECK (typeof(lifecycle_revision)='integer'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_experiment_runs_1 ON experiment_runs (workspace_id, experiment_id, created_at_ms);

CREATE TRIGGER experiment_runs_update_guard BEFORE UPDATE ON experiment_runs WHEN 1=1 BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_runs_delete_guard BEFORE DELETE ON experiment_runs BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_cases (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  lifecycle_revision INTEGER NOT NULL DEFAULT 1,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  trace_id TEXT,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  binding_hash TEXT,
  PRIMARY KEY (workspace_id, case_id),
  UNIQUE (workspace_id, experiment_id, case_id),
  FOREIGN KEY (workspace_id, experiment_id) REFERENCES experiment_heads (workspace_id, experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  CHECK (state IN ('active','deleted')),
  CHECK ((state='active' AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_at_ms IS NOT NULL)),
  CHECK (binding_hash IS NULL OR length(binding_hash)=64),
  CHECK (length(experiment_id)>0),
  CHECK (length(case_id)>0),
  CHECK (ordinal >= 0 AND ordinal <= 9223372036854775807),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (length(payload_hash)=64),
  CHECK (length(payload_ref)>0),
  CHECK (deleted_at_ms >= 0 AND deleted_at_ms <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (length(binding_hash)=64),
  CHECK (typeof(ordinal)='integer'),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(lifecycle_revision)='integer'),
  CHECK (payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (deleted_at_ms IS NULL OR typeof(deleted_at_ms)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer'),
  CHECK (binding_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE INDEX idx_experiment_cases_1 ON experiment_cases (workspace_id, experiment_id, state, ordinal);

CREATE TRIGGER experiment_cases_update_guard BEFORE UPDATE ON experiment_cases WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<>OLD.lifecycle_revision+(CASE WHEN NEW.state<>OLD.state THEN 1 ELSE 0 END) BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_cases_delete_guard BEFORE DELETE ON experiment_cases BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_result_slots (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  run_id TEXT,
  work_item_id TEXT,
  selected_result_id TEXT,
  review_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  evaluation_version INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, result_id),
  UNIQUE (workspace_id, case_id, evaluator_id),
  UNIQUE (workspace_id, experiment_id, result_id),
  UNIQUE (workspace_id, experiment_id, case_id, result_id),
  FOREIGN KEY (workspace_id, experiment_id, case_id) REFERENCES experiment_cases (workspace_id, experiment_id, case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, run_id) REFERENCES experiment_runs (workspace_id, experiment_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id, work_item_id, case_id, evaluator_id) REFERENCES work_items (workspace_id, run_id, work_item_id, case_key, evaluator_slot) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id, case_id, evaluator_id, selected_result_id) REFERENCES result_receipts (workspace_id, run_id, case_key, evaluator_slot, result_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, case_id, result_id, review_id) REFERENCES experiment_annotations (workspace_id, experiment_id, case_id, result_id, annotation_id) ON DELETE NO ACTION,
  CHECK (status IN ('pending','running','done','failed','cancelled','skipped')),
  CHECK ((run_id IS NULL AND work_item_id IS NULL AND selected_result_id IS NULL) OR (run_id IS NOT NULL AND work_item_id IS NOT NULL)),
  CHECK (length(experiment_id)>0),
  CHECK (length(case_id)>0),
  CHECK (length(result_id)>0),
  CHECK (length(evaluator_id)>0),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (evaluation_version >= 0 AND evaluation_version <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(evaluation_version)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);

CREATE INDEX idx_experiment_result_slots_1 ON experiment_result_slots (workspace_id, experiment_id, status);

CREATE TRIGGER experiment_result_slots_update_guard BEFORE UPDATE ON experiment_result_slots WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.result_id<>OLD.result_id OR NEW.evaluator_id<>OLD.evaluator_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_result_slots_delete_guard BEFORE DELETE ON experiment_result_slots BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_attempt_checkpoints (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  case_lifecycle_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  stage TEXT NOT NULL,
  command_id TEXT,
  trace_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, experiment_id, run_id, attempt_id, actor_principal_id),
  FOREIGN KEY (workspace_id, experiment_id, case_id) REFERENCES experiment_cases (workspace_id, experiment_id, case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, run_id) REFERENCES experiment_runs (workspace_id, experiment_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, work_item_id, attempt_id) REFERENCES work_attempts (workspace_id, work_item_id, attempt_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, run_id, work_item_id, case_id) REFERENCES work_items (workspace_id, run_id, work_item_id, case_key) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(experiment_id)>0),
  CHECK (length(case_id)>0),
  CHECK (fence >= 1 AND fence <= 9223372036854775807),
  CHECK (length(lease_owner)>0),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (case_lifecycle_revision >= 1 AND case_lifecycle_revision <= 9223372036854775807),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (length(payload_hash)=64),
  CHECK (length(payload_ref)>0),
  CHECK (length(stage)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (typeof(fence)='integer'),
  CHECK (typeof(lifecycle_revision)='integer'),
  CHECK (typeof(case_lifecycle_revision)='integer'),
  CHECK (typeof(revision)='integer'),
  CHECK (payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);

CREATE INDEX idx_experiment_attempt_checkpoints_1 ON experiment_attempt_checkpoints (workspace_id, experiment_id, case_id, created_at_ms);

CREATE INDEX idx_experiment_attempt_checkpoints_2 ON experiment_attempt_checkpoints (workspace_id, command_id);

CREATE TRIGGER experiment_attempt_checkpoints_update_guard BEFORE UPDATE ON experiment_attempt_checkpoints WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.run_id<>OLD.run_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.attempt_id<>OLD.attempt_id OR NEW.fence<>OLD.fence OR NEW.lease_owner<>OLD.lease_owner OR NEW.actor_principal_id<>OLD.actor_principal_id OR NEW.lifecycle_revision<>OLD.lifecycle_revision OR NEW.case_lifecycle_revision<>OLD.case_lifecycle_revision OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_attempt_checkpoints_delete_guard BEFORE DELETE ON experiment_attempt_checkpoints BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_annotations (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  case_id TEXT,
  result_id TEXT,
  machine_result_id TEXT,
  subject_id TEXT,
  actor_principal_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  lookup_key TEXT,
  PRIMARY KEY (workspace_id, annotation_id),
  UNIQUE (workspace_id, experiment_id, annotation_id),
  UNIQUE (workspace_id, experiment_id, case_id, result_id, annotation_id),
  FOREIGN KEY (workspace_id, experiment_id) REFERENCES experiment_heads (workspace_id, experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, case_id) REFERENCES experiment_cases (workspace_id, experiment_id, case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, case_id, result_id) REFERENCES experiment_result_slots (workspace_id, experiment_id, case_id, result_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, machine_result_id) REFERENCES result_receipts (workspace_id, result_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (kind IN ('review','comment','comment_remove','cancellation','cancellation_update','derived-evaluation','derived-issue')),
  CHECK (result_id IS NULL OR case_id IS NOT NULL),
  CHECK (kind<>'review' OR (result_id IS NOT NULL AND machine_result_id IS NOT NULL)),
  CHECK (kind<>'comment_remove' OR subject_id IS NOT NULL),
  CHECK (length(experiment_id)>0),
  CHECK (length(case_id)>0),
  CHECK (length(result_id)>0),
  CHECK (length(payload_hash)=64),
  CHECK (length(payload_ref)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_experiment_annotations_1 ON experiment_annotations (workspace_id, experiment_id, created_at_ms, annotation_id);

CREATE INDEX idx_experiment_annotations_2 ON experiment_annotations (workspace_id, result_id, created_at_ms);

CREATE INDEX idx_experiment_annotations_3 ON experiment_annotations (workspace_id, kind, lookup_key, created_at_ms, annotation_id);

CREATE TRIGGER experiment_annotations_update_guard BEFORE UPDATE ON experiment_annotations WHEN 1=1 BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_annotations_delete_guard BEFORE DELETE ON experiment_annotations BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_operation_receipts (
  workspace_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  response_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, actor_principal_id, operation_kind, operation_key),
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id) REFERENCES experiment_heads (workspace_id, experiment_id) ON DELETE NO ACTION,
  CHECK (length(operation_kind)>0),
  CHECK (length(operation_key)>0),
  CHECK (length(request_hash)=64),
  CHECK (length(experiment_id)>0),
  CHECK (length(response_hash)=64),
  CHECK (length(response_ref)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (response_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_experiment_operation_receipts_1 ON experiment_operation_receipts (workspace_id, experiment_id, created_at_ms);

CREATE TRIGGER experiment_operation_receipts_update_guard BEFORE UPDATE ON experiment_operation_receipts WHEN 1=1 BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_operation_receipts_delete_guard BEFORE DELETE ON experiment_operation_receipts BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE TABLE experiment_judge_traces (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, trace_id),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, run_id) REFERENCES experiment_runs (workspace_id, experiment_id, run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, experiment_id, run_id, attempt_id, owner_principal_id) REFERENCES experiment_attempt_checkpoints (workspace_id, experiment_id, run_id, attempt_id, actor_principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES work_attempts (workspace_id, attempt_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(experiment_id)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_experiment_judge_traces_1 ON experiment_judge_traces (workspace_id, experiment_id, run_id, attempt_id);

CREATE TRIGGER experiment_judge_traces_update_guard BEFORE UPDATE ON experiment_judge_traces WHEN 1=1 BEGIN SELECT RAISE(ABORT,'experiment invariant'); END;

CREATE TRIGGER experiment_judge_traces_delete_guard BEFORE DELETE ON experiment_judge_traces BEGIN SELECT RAISE(ABORT,'experiment history is retained'); END;

CREATE UNIQUE INDEX idx_experiment_case_active_binding ON experiment_cases (workspace_id,experiment_id,binding_hash) WHERE state='active';
