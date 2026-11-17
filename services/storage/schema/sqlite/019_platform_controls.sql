CREATE TABLE platform_control_records (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  legacy_username TEXT NOT NULL,
  parent_kind TEXT,
  parent_id TEXT,
  unique_key TEXT,
  lookup_hash TEXT,
  status TEXT,
  expires_at_ms INTEGER,
  sort_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  asset_id TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,kind,record_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,parent_kind,parent_id) REFERENCES platform_control_records (workspace_id,kind,record_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,asset_id) REFERENCES asset_identities (workspace_id,asset_id) ON DELETE NO ACTION,
  CHECK (kind IN ('user','skill','skillVersion','config','userSettings','parsedFlow','userGuideState','registeredAgent','evaluation','skillIssue','skillTriggerEvalSet','batchEvalTask','skillGeneratorSession','skillGeneratorMessage','skillOptSession','skillOptPlan','skillOptPlanItem','skillOptMessage','skillOptIteration','skillWorkbenchSession','skillWorkbenchMessage','skillWorkbenchTask','skillOptimizationRecord','skillSnapshotEvaluation','reliabilityInstallToken','reliabilityClient','reliabilityClientCredential','reliabilityCommand','reliabilityClientConfig','reliabilityConfigSnapshot','reliabilityConfigDelivery','reliabilityConfigLoad','skillDeployment','skillDeploymentEvent','faultInjectionTask','faultInjectionRun','faultInjectionWorker','grayscaleTask','debugHistory','debugJobResult','_scope','_receipt')),
  CHECK (length(record_id) BETWEEN 1 AND 1024),
  CHECK (length(legacy_username) BETWEEN 1 AND 512),
  CHECK ((parent_kind IS NULL)=(parent_id IS NULL)),
  CHECK (state IN ('active','deleted')),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  CHECK (length(payload_hash)=64),
  CHECK (length(payload_ref) BETWEEN 1 AND 4096),
  CHECK (lookup_hash IS NULL OR length(lookup_hash)=64),
  CHECK (typeof(expires_at_ms)='integer' OR expires_at_ms IS NULL),
  CHECK (typeof(sort_ms)='integer'),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);
CREATE UNIQUE INDEX uq_control_lookup ON platform_control_records (kind,lookup_hash);
CREATE UNIQUE INDEX uq_control_unique_active ON platform_control_records (workspace_id,owner_principal_id,kind,unique_key) WHERE state='active';
CREATE INDEX idx_control_owner ON platform_control_records (workspace_id,kind,owner_principal_id,sort_ms,record_id);
CREATE INDEX idx_control_parent ON platform_control_records (workspace_id,kind,parent_kind,parent_id,status,sort_ms);
CREATE INDEX idx_control_expiry ON platform_control_records (workspace_id,kind,status,expires_at_ms);
CREATE TRIGGER control_record_update_guard BEFORE UPDATE ON platform_control_records WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.kind IS NOT OLD.kind OR NEW.record_id IS NOT OLD.record_id OR NEW.owner_principal_id IS NOT OLD.owner_principal_id OR NEW.legacy_username IS NOT OLD.legacy_username OR NEW.parent_kind IS NOT OLD.parent_kind OR NEW.parent_id IS NOT OLD.parent_id OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms BEGIN SELECT RAISE(ABORT,'control identity and revisions are retained'); END;
CREATE TRIGGER control_record_delete_guard BEFORE DELETE ON platform_control_records BEGIN SELECT RAISE(ABORT,'control history is retained'); END;
