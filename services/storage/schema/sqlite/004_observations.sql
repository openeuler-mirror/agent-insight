CREATE TABLE ingest_batches (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  packet_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted',
  plan_ref TEXT,
  trace_ids_json TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  indexed_at_ms INTEGER,
  error_code TEXT,
  PRIMARY KEY (workspace_id, batch_id),
  UNIQUE (workspace_id, principal_id, receipt_key),
  CHECK (length(batch_id)>0),
  CHECK (length(receipt_key) BETWEEN 1 AND 512),
  CHECK (length(packet_hash)=64),
  CHECK (length(packet_ref)>0),
  CHECK (state IN ('accepted','prepared','indexed','failed')),
  CHECK (plan_ref IS NULL OR length(plan_ref)>0),
  CHECK (length(trace_ids_json)>0),
  CHECK (accepted_at_ms>=0),
  CHECK (indexed_at_ms IS NULL OR indexed_at_ms>=accepted_at_ms),
  CHECK (state<>'prepared' OR plan_ref IS NOT NULL),
  CHECK (state<>'indexed' OR (plan_ref IS NOT NULL AND indexed_at_ms IS NOT NULL)),
  CHECK (packet_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(accepted_at_ms)='integer'),
  CHECK (indexed_at_ms IS NULL OR typeof(indexed_at_ms)='integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_ingest_batches_actor ON ingest_batches (workspace_id, principal_id, accepted_at_ms);

CREATE INDEX idx_ingest_batches_state ON ingest_batches (state, accepted_at_ms);

CREATE TABLE obs_entity_heads (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, trace_id, entity_kind, entity_id),
  CHECK (entity_kind IN ('trace','span')),
  CHECK (length(entity_id)>0),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (source_revision BETWEEN 1 AND 9223372036854775807),
  CHECK (length(content_hash)=64),
  CHECK (length(artifact_ref)>0),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (entity_kind<>'trace' OR entity_id=trace_id),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(source_revision)='integer'),
  CHECK (content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer'),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION
);

CREATE TRIGGER ingest_batches_ledger_guard BEFORE UPDATE ON ingest_batches WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.principal_id IS NOT OLD.principal_id OR NEW.receipt_key IS NOT OLD.receipt_key OR NEW.packet_hash IS NOT OLD.packet_hash OR NEW.packet_ref IS NOT OLD.packet_ref OR NEW.trace_ids_json IS NOT OLD.trace_ids_json OR NEW.accepted_at_ms IS NOT OLD.accepted_at_ms OR (OLD.plan_ref IS NOT NULL AND NEW.plan_ref IS NOT OLD.plan_ref) OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','indexed','failed')) OR (OLD.state IN ('indexed','failed') AND (NEW.state<>OLD.state OR NEW.indexed_at_ms IS NOT OLD.indexed_at_ms OR NEW.error_code IS NOT OLD.error_code)) BEGIN SELECT RAISE(ABORT, 'observation ledger immutable or stale'); END;

CREATE TRIGGER ingest_batches_retain BEFORE DELETE ON ingest_batches BEGIN SELECT RAISE(ABORT, 'observation ledger retained'); END;

CREATE TRIGGER obs_entity_heads_ledger_guard BEFORE UPDATE ON obs_entity_heads WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.trace_id IS NOT OLD.trace_id OR NEW.entity_kind IS NOT OLD.entity_kind OR NEW.entity_id IS NOT OLD.entity_id OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.source_revision<OLD.source_revision OR (OLD.entity_kind='span' AND NEW.source_revision<=OLD.source_revision) OR NEW.updated_at_ms<OLD.updated_at_ms BEGIN SELECT RAISE(ABORT, 'observation ledger immutable or stale'); END;

CREATE TRIGGER obs_entity_heads_retain BEFORE DELETE ON obs_entity_heads BEGIN SELECT RAISE(ABORT, 'observation ledger retained'); END;
