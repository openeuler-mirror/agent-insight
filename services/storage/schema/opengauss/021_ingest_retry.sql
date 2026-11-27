CREATE TABLE ingest_deliveries (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, event_id TEXT NOT NULL,
 attempt_base INTEGER NOT NULL DEFAULT 0, attempt_limit INTEGER NOT NULL DEFAULT 5,
 generation INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT, last_error_message TEXT, last_error_at_ms BIGINT,
 PRIMARY KEY(workspace_id,batch_id), UNIQUE(workspace_id,event_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES ingest_batches(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,event_id) REFERENCES outbox_events(workspace_id,event_id),
 CHECK(attempt_base>=0 AND attempt_limit BETWEEN 1 AND 100 AND generation>=0),
 CHECK(last_error_at_ms IS NULL OR last_error_at_ms>=0)
);
CREATE TABLE ingest_batch_traces (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, trace_id TEXT NOT NULL,
 blocks_successors INTEGER NOT NULL DEFAULT 1 CHECK(blocks_successors IN (0,1)),
 PRIMARY KEY(workspace_id,batch_id,trace_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES ingest_deliveries(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,trace_id) REFERENCES trace_locators(workspace_id,trace_id)
);
CREATE INDEX idx_ingest_trace_batches ON ingest_batch_traces(workspace_id,trace_id,batch_id);
CREATE TABLE ingest_batch_recoveries (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, request_key TEXT NOT NULL,
 generation INTEGER NOT NULL, actor_principal_id TEXT NOT NULL,
 previous_attempts INTEGER NOT NULL, previous_error_code TEXT,
 previous_error_message TEXT, previous_error_at_ms BIGINT, recovered_at_ms BIGINT NOT NULL,
 PRIMARY KEY(workspace_id,batch_id,request_key), UNIQUE(workspace_id,batch_id,generation),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES ingest_deliveries(workspace_id,batch_id),
 FOREIGN KEY(actor_principal_id) REFERENCES iam_principals(principal_id),
 CHECK(generation>0 AND previous_attempts>=0 AND recovered_at_ms>=0)
);
INSERT INTO ingest_deliveries(workspace_id,batch_id,event_id,last_error_code,last_error_at_ms)
 SELECT b.workspace_id,b.batch_id,e.event_id,b.error_code,
 CASE WHEN b.state='failed' THEN e.updated_at_ms ELSE NULL END
 FROM ingest_batches b LEFT JOIN outbox_events e ON e.workspace_id=b.workspace_id
 AND e.aggregate_id=b.batch_id AND e.event_type='observability.otlp.accepted.v1';
INSERT INTO ingest_batch_traces(workspace_id,batch_id,trace_id) SELECT b.workspace_id,b.batch_id,t.trace_id FROM ingest_batches b, json_array_elements_text(b.trace_ids_json::json) AS t(trace_id);
UPDATE ingest_batch_traces SET blocks_successors=0 WHERE EXISTS (
 SELECT 1 FROM ingest_batches failed
 JOIN ingest_deliveries fd ON fd.workspace_id=failed.workspace_id AND fd.batch_id=failed.batch_id
 JOIN outbox_events fe ON fe.workspace_id=fd.workspace_id AND fe.event_id=fd.event_id
 JOIN ingest_batch_traces successor ON successor.workspace_id=failed.workspace_id AND successor.trace_id=ingest_batch_traces.trace_id
 JOIN ingest_batches prepared ON prepared.workspace_id=successor.workspace_id AND prepared.batch_id=successor.batch_id
 JOIN ingest_deliveries pd ON pd.workspace_id=prepared.workspace_id AND pd.batch_id=prepared.batch_id
 JOIN outbox_events pe ON pe.workspace_id=pd.workspace_id AND pe.event_id=pd.event_id
 WHERE failed.workspace_id=ingest_batch_traces.workspace_id AND failed.batch_id=ingest_batch_traces.batch_id
 AND failed.state='failed' AND failed.plan_ref IS NULL AND prepared.plan_ref IS NOT NULL
 AND (pe.created_at_ms>fe.created_at_ms OR (pe.created_at_ms=fe.created_at_ms AND pe.event_id>fe.event_id))
);
CREATE OR REPLACE FUNCTION ingest_batches_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'observation ledger retained'; END IF; IF ROW(NEW.workspace_id,NEW.batch_id,NEW.principal_id,NEW.receipt_key,NEW.packet_hash,NEW.packet_ref,NEW.trace_ids_json,NEW.accepted_at_ms) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.batch_id,OLD.principal_id,OLD.receipt_key,OLD.packet_hash,OLD.packet_ref,OLD.trace_ids_json,OLD.accepted_at_ms) OR (OLD.plan_ref IS NOT NULL AND NEW.plan_ref IS DISTINCT FROM OLD.plan_ref) OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','indexed','failed')) OR ((OLD.state IN ('indexed','failed') AND (NEW.state<>OLD.state OR NEW.indexed_at_ms IS DISTINCT FROM OLD.indexed_at_ms OR NEW.error_code IS DISTINCT FROM OLD.error_code)) AND NOT (OLD.state='failed' AND NEW.state=CASE WHEN OLD.plan_ref IS NULL THEN 'accepted' ELSE 'prepared' END AND NEW.error_code IS NULL AND NEW.indexed_at_ms IS NOT DISTINCT FROM OLD.indexed_at_ms AND EXISTS(SELECT 1 FROM ingest_deliveries d JOIN ingest_batch_recoveries r ON r.workspace_id=d.workspace_id AND r.batch_id=d.batch_id AND r.generation=d.generation JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id WHERE d.workspace_id=OLD.workspace_id AND d.batch_id=OLD.batch_id AND r.previous_error_code IS NOT DISTINCT FROM OLD.error_code AND r.previous_attempts=e.attempts AND d.attempt_base=e.attempts))) THEN RAISE EXCEPTION 'observation ledger immutable or stale'; END IF; RETURN NEW; END $$;
