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
  accepted_at_ms BIGINT NOT NULL,
  indexed_at_ms BIGINT,
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
  CHECK (packet_hash ~ '^[0-9a-f]{64}$'),
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
  revision BIGINT NOT NULL,
  source_revision BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
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
  CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION
);

CREATE FUNCTION ingest_batches_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'observation ledger retained'; END IF; IF ROW(NEW.workspace_id,NEW.batch_id,NEW.principal_id,NEW.receipt_key,NEW.packet_hash,NEW.packet_ref,NEW.trace_ids_json,NEW.accepted_at_ms) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.batch_id,OLD.principal_id,OLD.receipt_key,OLD.packet_hash,OLD.packet_ref,OLD.trace_ids_json,OLD.accepted_at_ms) OR (OLD.plan_ref IS NOT NULL AND NEW.plan_ref IS DISTINCT FROM OLD.plan_ref) OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','indexed','failed')) OR (OLD.state IN ('indexed','failed') AND (NEW.state<>OLD.state OR NEW.indexed_at_ms IS DISTINCT FROM OLD.indexed_at_ms OR NEW.error_code IS DISTINCT FROM OLD.error_code)) THEN RAISE EXCEPTION 'observation ledger immutable or stale'; END IF; RETURN NEW; END $$;

CREATE TRIGGER ingest_batches_ledger_guard BEFORE UPDATE OR DELETE ON ingest_batches FOR EACH ROW EXECUTE PROCEDURE ingest_batches_guard_fn();

CREATE FUNCTION obs_entity_heads_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'observation ledger retained'; END IF; IF ROW(NEW.workspace_id,NEW.trace_id,NEW.entity_kind,NEW.entity_id,NEW.created_at_ms) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.trace_id,OLD.entity_kind,OLD.entity_id,OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.source_revision<OLD.source_revision OR (OLD.entity_kind='span' AND NEW.source_revision<=OLD.source_revision) OR NEW.updated_at_ms<OLD.updated_at_ms THEN RAISE EXCEPTION 'observation ledger immutable or stale'; END IF; RETURN NEW; END $$;

CREATE TRIGGER obs_entity_heads_ledger_guard BEFORE UPDATE OR DELETE ON obs_entity_heads FOR EACH ROW EXECUTE PROCEDURE obs_entity_heads_guard_fn();
