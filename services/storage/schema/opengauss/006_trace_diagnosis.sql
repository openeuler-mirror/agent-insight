CREATE TABLE trace_diagnosis_sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  opencode_session_id TEXT,
  revision BIGINT NOT NULL DEFAULT 1,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  turn_fence BIGINT NOT NULL DEFAULT 1,
  active_request_key TEXT,
  lease_owner TEXT,
  lease_expires_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, session_id),
  UNIQUE (workspace_id, trace_id),
  CHECK (length(session_id) BETWEEN 1 AND 512),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (next_sequence BETWEEN 1 AND 9223372036854775807),
  CHECK (turn_fence BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms>=0),
  CHECK (opencode_session_id IS NULL OR length(opencode_session_id) BETWEEN 1 AND 512),
  CHECK (active_request_key IS NULL OR length(active_request_key) BETWEEN 1 AND 512),
  CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 512),
  CHECK ((active_request_key IS NULL AND lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR (active_request_key IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_diagnosis_sessions_updated ON trace_diagnosis_sessions (workspace_id, updated_at_ms, session_id);

CREATE INDEX idx_diagnosis_sessions_lease ON trace_diagnosis_sessions (lease_expires_at_ms, workspace_id, session_id);

CREATE TABLE trace_diagnosis_messages (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  evidence_hash TEXT,
  opencode_session_id TEXT,
  created_by TEXT NOT NULL,
  turn_fence BIGINT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, message_id),
  UNIQUE (workspace_id, session_id, seq),
  UNIQUE (workspace_id, session_id, request_key, role),
  CHECK (length(message_id) BETWEEN 1 AND 512),
  CHECK (length(request_key) BETWEEN 1 AND 512),
  CHECK (seq BETWEEN 1 AND 9223372036854775807),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (turn_fence BETWEEN 1 AND 9223372036854775807),
  CHECK ((role='user' AND state='accepted' AND length(content)>0) OR (role='assistant' AND state IN ('streaming','done','failed','interrupted'))),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (opencode_session_id IS NULL OR length(opencode_session_id) BETWEEN 1 AND 512),
  CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 128 AND state IN ('failed','interrupted'))),
  CHECK ((request_hash ~ '^[0-9a-f]{64}$')),
  CHECK ((content_hash ~ '^[0-9a-f]{64}$')),
  CHECK (evidence_hash IS NULL OR (evidence_hash ~ '^[0-9a-f]{64}$')),
  FOREIGN KEY (workspace_id, session_id) REFERENCES trace_diagnosis_sessions (workspace_id, session_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_diagnosis_messages_upstream ON trace_diagnosis_messages (workspace_id, session_id, opencode_session_id, seq);

CREATE FUNCTION trace_diagnosis_sessions_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'diagnosis history retained'; END IF; IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.next_sequence<OLD.next_sequence OR NEW.turn_fence<OLD.turn_fence OR NEW.updated_at_ms<OLD.updated_at_ms THEN RAISE EXCEPTION 'diagnosis session identity or counters immutable'; END IF; RETURN NEW; END $$;

CREATE TRIGGER trace_diagnosis_sessions_guard BEFORE UPDATE OR DELETE ON trace_diagnosis_sessions FOR EACH ROW EXECUTE PROCEDURE trace_diagnosis_sessions_guard_fn();

CREATE FUNCTION trace_diagnosis_messages_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'diagnosis history retained'; END IF; IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.role IS DISTINCT FROM OLD.role OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.turn_fence IS DISTINCT FROM OLD.turn_fence OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR (OLD.role='assistant' AND OLD.state<>'streaming') OR (OLD.role='user' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.state<>'accepted' OR (OLD.opencode_session_id IS NOT NULL AND NEW.opencode_session_id IS DISTINCT FROM OLD.opencode_session_id))) OR (OLD.role='user' AND NEW.opencode_session_id IS DISTINCT FROM OLD.opencode_session_id AND NOT EXISTS (SELECT 1 FROM trace_diagnosis_sessions s WHERE s.workspace_id=OLD.workspace_id AND s.session_id=OLD.session_id AND s.active_request_key=OLD.request_key AND s.turn_fence=OLD.turn_fence)) THEN RAISE EXCEPTION 'diagnosis message identity or terminal content immutable'; END IF; RETURN NEW; END $$;

CREATE TRIGGER trace_diagnosis_messages_guard BEFORE UPDATE OR DELETE ON trace_diagnosis_messages FOR EACH ROW EXECUTE PROCEDURE trace_diagnosis_messages_guard_fn();

CREATE INDEX idx_diagnosis_messages_workspace_upstream ON trace_diagnosis_messages (workspace_id, opencode_session_id, session_id);
