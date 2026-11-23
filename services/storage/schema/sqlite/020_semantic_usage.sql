CREATE TABLE semantic_scopes (
 workspace_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, domain TEXT NOT NULL,
 legacy_username TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,owner_principal_id,domain),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
 FOREIGN KEY(owner_principal_id) REFERENCES iam_principals(principal_id),
 CHECK(domain IN ('goal','collaboration','usage')), CHECK(revision>=0)
);
CREATE TABLE semantic_records (
 workspace_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, kind TEXT NOT NULL,
 record_id TEXT NOT NULL, content_hash TEXT NOT NULL, payload_ref TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,owner_principal_id,kind,record_id),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
 FOREIGN KEY(owner_principal_id) REFERENCES iam_principals(principal_id),
 CHECK(kind IN ('goalPlusSource','goalPlusGoal','goalPlusRun','goalPlusCandidate','goalPlusIteration','goalPlusAgentSession','goalPlusExecutionLink','goalPlusSemanticSnapshot','collaboration','collaborationEvent','collaborationEndpointResolution','collaborationSessionBinding')), CHECK(state IN ('active','deleted')),
 CHECK(length(content_hash)=64 AND revision>0 AND created_at_ms>=0 AND updated_at_ms>=created_at_ms)
);
CREATE INDEX idx_semantic_scope ON semantic_records(workspace_id,owner_principal_id,kind,state,record_id);
CREATE TABLE semantic_unique_keys (
 workspace_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, kind TEXT NOT NULL,
 constraint_key TEXT NOT NULL, key_hash TEXT NOT NULL, record_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,owner_principal_id,kind,constraint_key,key_hash),
 FOREIGN KEY(workspace_id,owner_principal_id,kind,record_id) REFERENCES semantic_records(workspace_id,owner_principal_id,kind,record_id)
);
CREATE TABLE usage_event_receipts (
 workspace_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, event_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, date_key TEXT NOT NULL, received_at_ms INTEGER NOT NULL,
 raw_state TEXT NOT NULL DEFAULT 'active',
 PRIMARY KEY(workspace_id,owner_principal_id,event_id),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
 FOREIGN KEY(owner_principal_id) REFERENCES iam_principals(principal_id),
 CHECK(length(content_hash)=64 AND received_at_ms>=0), CHECK(raw_state IN ('active','retired'))
);
CREATE INDEX idx_usage_receipt_cleanup ON usage_event_receipts(workspace_id,owner_principal_id,raw_state,date_key,event_id);
CREATE TABLE usage_daily_heads (
 workspace_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, date_key TEXT NOT NULL,
 feature_key TEXT NOT NULL, event_key TEXT NOT NULL, legacy_username TEXT NOT NULL,
 total INTEGER NOT NULL, first_occurred_ms INTEGER NOT NULL, last_occurred_ms INTEGER NOT NULL,
 revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
 PRIMARY KEY(workspace_id,owner_principal_id,date_key,feature_key,event_key),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
 FOREIGN KEY(owner_principal_id) REFERENCES iam_principals(principal_id),
 CHECK(total>=0 AND revision>0 AND first_occurred_ms<=last_occurred_ms AND length(content_hash)=64)
);
CREATE INDEX idx_usage_daily_scope ON usage_daily_heads(workspace_id,date_key,feature_key,owner_principal_id);
