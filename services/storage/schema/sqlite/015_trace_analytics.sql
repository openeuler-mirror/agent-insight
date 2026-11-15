CREATE TABLE trace_analytics_publications (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  boundary TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  projection_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,trace_id,boundary,parser_version),
  FOREIGN KEY (workspace_id,trace_id) REFERENCES trace_locators (workspace_id,trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(boundary)=64 AND boundary NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(projection_hash)=64 AND projection_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (parser_version=1 AND typeof(parser_version)='integer'),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807 AND typeof(created_at_ms)='integer')
);
CREATE INDEX idx_trace_analytics_publications_1 ON trace_analytics_publications (workspace_id,created_at_ms,trace_id);
CREATE TRIGGER trace_analytics_publications_update_guard BEFORE UPDATE ON trace_analytics_publications BEGIN SELECT RAISE(ABORT,'analytics publications are immutable'); END;
CREATE TRIGGER trace_analytics_publications_delete_guard BEFORE DELETE ON trace_analytics_publications BEGIN SELECT RAISE(ABORT,'analytics history is retained'); END;

CREATE TABLE ras_event_receipts (
  workspace_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,owner_principal_id,task_id,event_key),
  UNIQUE (workspace_id,owner_principal_id,event_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(task_id) BETWEEN 1 AND 512),
  CHECK (length(event_key) BETWEEN 1 AND 512),
  CHECK (length(event_id) BETWEEN 1 AND 512),
  CHECK (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (revision>=1 AND revision<=9223372036854775807 AND typeof(revision)='integer'),
  CHECK (occurred_at_ms>=0 AND occurred_at_ms<=9223372036854775807 AND typeof(occurred_at_ms)='integer'),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807 AND typeof(created_at_ms)='integer')
);
CREATE INDEX idx_ras_event_receipts_1 ON ras_event_receipts (workspace_id,owner_principal_id,task_id,occurred_at_ms,event_id);
CREATE TRIGGER ras_event_receipts_update_guard BEFORE UPDATE ON ras_event_receipts WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.owner_principal_id<>OLD.owner_principal_id OR NEW.task_id<>OLD.task_id OR NEW.event_key<>OLD.event_key OR NEW.event_id<>OLD.event_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'RAS event identity or revision changed'); END;
CREATE TRIGGER ras_event_receipts_delete_guard BEFORE DELETE ON ras_event_receipts BEGIN SELECT RAISE(ABORT,'RAS history is retained'); END;

CREATE TABLE experiment_trace_sources (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  route_epoch INTEGER NOT NULL,
  execution_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,run_id,case_id),
  FOREIGN KEY (workspace_id,run_id) REFERENCES experiment_runs (workspace_id,run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,case_id) REFERENCES experiment_cases (workspace_id,case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,trace_id) REFERENCES trace_locators (workspace_id,trace_id) ON DELETE NO ACTION,
  CHECK (length(execution_id) BETWEEN 1 AND 512),
  CHECK (length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(plan_hash)=64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (incarnation>=1 AND incarnation<=9223372036854775807 AND typeof(incarnation)='integer'),
  CHECK (route_epoch>=1 AND route_epoch<=9223372036854775807 AND typeof(route_epoch)='integer'),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807 AND typeof(created_at_ms)='integer')
);
CREATE INDEX idx_experiment_trace_sources_1 ON experiment_trace_sources (workspace_id,trace_id,run_id,case_id);
CREATE TRIGGER experiment_trace_sources_update_guard BEFORE UPDATE ON experiment_trace_sources BEGIN SELECT RAISE(ABORT,'frozen Trace source index is immutable'); END;
CREATE TRIGGER experiment_trace_sources_delete_guard BEFORE DELETE ON experiment_trace_sources BEGIN SELECT RAISE(ABORT,'frozen Trace source history is retained'); END;
