CREATE TABLE benchmark_dataset_heads (
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  public_dataset_id TEXT NOT NULL,
  public_asset_id TEXT NOT NULL,
  public_release_id TEXT NOT NULL,
  private_asset_id TEXT NOT NULL,
  private_release_id TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,dataset_id),
  UNIQUE (workspace_id,public_dataset_id),
  UNIQUE (workspace_id,private_asset_id),
  FOREIGN KEY (workspace_id,public_dataset_id) REFERENCES dataset_compat_heads (workspace_id,dataset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,public_asset_id,public_release_id) REFERENCES asset_release_seals (workspace_id,asset_id,release_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,private_asset_id,private_release_id) REFERENCES asset_release_seals (workspace_id,asset_id,release_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (state IN ('active','deleted')),
  CHECK (length(adapter_key)>0),
  CHECK (public_asset_id<>private_asset_id),
  CHECK (length(content_hash)=64),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (lifecycle_revision>=1 AND lifecycle_revision<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(lifecycle_revision)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);

CREATE INDEX idx_benchmark_dataset_heads_1 ON benchmark_dataset_heads (workspace_id,adapter_key,state,updated_at_ms);

CREATE TRIGGER benchmark_dataset_heads_guard BEFORE UPDATE ON benchmark_dataset_heads WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.public_dataset_id IS NOT OLD.public_dataset_id OR NEW.public_asset_id IS NOT OLD.public_asset_id OR NEW.public_release_id IS NOT OLD.public_release_id OR NEW.private_asset_id IS NOT OLD.private_asset_id OR NEW.private_release_id IS NOT OLD.private_release_id OR NEW.adapter_key IS NOT OLD.adapter_key OR NEW.content_hash IS NOT OLD.content_hash OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<OLD.lifecycle_revision BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_dataset_heads_retained BEFORE DELETE ON benchmark_dataset_heads BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;

CREATE TABLE benchmark_experiment_bindings (
  workspace_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  public_release_id TEXT NOT NULL,
  private_release_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,experiment_id),
  FOREIGN KEY (workspace_id,experiment_id) REFERENCES experiment_heads (workspace_id,experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,dataset_id) REFERENCES benchmark_dataset_heads (workspace_id,dataset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,public_release_id) REFERENCES asset_release_seals (workspace_id,release_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,private_release_id) REFERENCES asset_release_seals (workspace_id,release_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (length(binding_hash)=64),
  CHECK (length(binding_ref)>0),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (binding_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_benchmark_experiment_bindings_1 ON benchmark_experiment_bindings (workspace_id,dataset_id,experiment_id);

CREATE TRIGGER benchmark_experiment_bindings_guard BEFORE UPDATE ON benchmark_experiment_bindings WHEN 1=1 BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_experiment_bindings_retained BEFORE DELETE ON benchmark_experiment_bindings BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;

CREATE TABLE benchmark_jobs (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_job_id TEXT,
  adapter_key TEXT NOT NULL,
  evaluator_key TEXT,
  attempt_no INTEGER NOT NULL,
  retry_of_job_id TEXT,
  origin_credential_id TEXT NOT NULL,
  origin_credential_kind TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  protocol_state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  request_hash TEXT,
  request_ref TEXT,
  progress_hash TEXT,
  progress_ref TEXT,
  completion_hash TEXT,
  completion_ref TEXT,
  callback_epoch INTEGER NOT NULL,
  callback_token_hash TEXT,
  callback_expires_ms INTEGER,
  callback_attempt_id TEXT,
  callback_fence INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,job_id),
  UNIQUE (workspace_id,experiment_id,case_id,job_id),
  UNIQUE (workspace_id,parent_job_id,attempt_no),
  FOREIGN KEY (workspace_id,experiment_id) REFERENCES benchmark_experiment_bindings (workspace_id,experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id,case_id) REFERENCES experiment_cases (workspace_id,experiment_id,case_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id,run_id) REFERENCES experiment_runs (workspace_id,experiment_id,run_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,run_id,work_item_id,case_id) REFERENCES work_items (workspace_id,run_id,work_item_id,case_key) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,work_item_id,callback_attempt_id) REFERENCES work_attempts (workspace_id,work_item_id,attempt_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id,case_id,parent_job_id) REFERENCES benchmark_jobs (workspace_id,experiment_id,case_id,job_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id,case_id,retry_of_job_id) REFERENCES benchmark_jobs (workspace_id,experiment_id,case_id,job_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  CHECK (kind IN ('execute','evaluate')),
  CHECK (origin_credential_kind IN ('api','session')),
  CHECK (protocol_state IN ('pending','preparing','dispatching','dispatch_unknown','running_agent','collecting','uploading','cleaning','submitted','queued','running_evaluator','normalizing','normalization_failed','completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid')),
  CHECK ((kind='execute' AND parent_job_id IS NULL) OR (kind='evaluate' AND parent_job_id IS NOT NULL)),
  CHECK ((callback_token_hash IS NULL AND callback_expires_ms IS NULL AND callback_attempt_id IS NULL AND callback_fence IS NULL) OR (callback_token_hash IS NOT NULL AND callback_expires_ms IS NOT NULL AND callback_attempt_id IS NOT NULL AND callback_fence IS NOT NULL)),
  CHECK (parent_job_id IS NULL OR parent_job_id<>job_id),
  CHECK (retry_of_job_id IS NULL OR retry_of_job_id<>job_id),
  CHECK (attempt_no>=1 AND attempt_no<=9223372036854775807),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (length(request_hash)=64),
  CHECK (length(request_ref)>0),
  CHECK (length(progress_hash)=64),
  CHECK (length(progress_ref)>0),
  CHECK (length(completion_hash)=64),
  CHECK (length(completion_ref)>0),
  CHECK (callback_epoch>=0 AND callback_epoch<=9223372036854775807),
  CHECK (length(callback_token_hash)=64),
  CHECK (callback_expires_ms>=0 AND callback_expires_ms<=9223372036854775807),
  CHECK (callback_fence>=1 AND callback_fence<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK ((request_hash IS NULL)=(request_ref IS NULL)),
  CHECK ((progress_hash IS NULL)=(progress_ref IS NULL)),
  CHECK ((completion_hash IS NULL)=(completion_ref IS NULL)),
  CHECK (typeof(attempt_no)='integer'),
  CHECK (typeof(revision)='integer'),
  CHECK (request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (progress_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (completion_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(callback_epoch)='integer'),
  CHECK (callback_token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (callback_expires_ms IS NULL OR typeof(callback_expires_ms)='integer'),
  CHECK (callback_fence IS NULL OR typeof(callback_fence)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer')
);

CREATE INDEX idx_benchmark_jobs_1 ON benchmark_jobs (workspace_id,experiment_id,case_id,kind,created_at_ms);

CREATE INDEX idx_benchmark_jobs_2 ON benchmark_jobs (workspace_id,protocol_state,updated_at_ms);

CREATE INDEX idx_benchmark_jobs_3 ON benchmark_jobs (workspace_id,origin_credential_id);

CREATE TRIGGER benchmark_jobs_guard BEFORE UPDATE ON benchmark_jobs WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.job_id IS NOT OLD.job_id OR NEW.experiment_id IS NOT OLD.experiment_id OR NEW.case_id IS NOT OLD.case_id OR NEW.run_id IS NOT OLD.run_id OR NEW.work_item_id IS NOT OLD.work_item_id OR NEW.kind IS NOT OLD.kind OR NEW.parent_job_id IS NOT OLD.parent_job_id OR NEW.adapter_key IS NOT OLD.adapter_key OR NEW.evaluator_key IS NOT OLD.evaluator_key OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.retry_of_job_id IS NOT OLD.retry_of_job_id OR NEW.origin_credential_id IS NOT OLD.origin_credential_id OR NEW.origin_credential_kind IS NOT OLD.origin_credential_kind OR NEW.actor_principal_id IS NOT OLD.actor_principal_id OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.callback_epoch<OLD.callback_epoch OR (OLD.request_hash IS NOT NULL AND NEW.request_hash IS NOT OLD.request_hash) OR (OLD.request_ref IS NOT NULL AND NEW.request_ref IS NOT OLD.request_ref) OR (OLD.completion_hash IS NOT NULL AND NEW.completion_hash IS NOT OLD.completion_hash) OR (OLD.completion_ref IS NOT NULL AND NEW.completion_ref IS NOT OLD.completion_ref) BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_jobs_retained BEFORE DELETE ON benchmark_jobs BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;

CREATE TABLE benchmark_artifacts (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_hash TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,artifact_id),
  UNIQUE (workspace_id,job_id,name),
  FOREIGN KEY (workspace_id,job_id) REFERENCES benchmark_jobs (workspace_id,job_id) ON DELETE NO ACTION,
  CHECK (length(name) BETWEEN 1 AND 512),
  CHECK (size_bytes BETWEEN 1 AND 67108864),
  CHECK (length(media_type) BETWEEN 1 AND 256),
  CHECK (length(content_hash)=64),
  CHECK (size_bytes>=0 AND size_bytes<=9223372036854775807),
  CHECK (length(storage_hash)=64),
  CHECK (length(storage_ref)>0),
  CHECK (length(contract_hash)=64),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(size_bytes)='integer'),
  CHECK (storage_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (contract_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_benchmark_artifacts_1 ON benchmark_artifacts (workspace_id,job_id,created_at_ms);

CREATE INDEX idx_benchmark_artifacts_2 ON benchmark_artifacts (workspace_id,content_hash);

CREATE TRIGGER benchmark_artifacts_guard BEFORE UPDATE ON benchmark_artifacts WHEN 1=1 BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_artifacts_retained BEFORE DELETE ON benchmark_artifacts BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;

CREATE TABLE benchmark_operation_receipts (
  workspace_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  experiment_id TEXT,
  dataset_id TEXT,
  job_id TEXT,
  response_hash TEXT NOT NULL,
  response_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,actor_principal_id,operation_kind,operation_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (actor_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,experiment_id) REFERENCES experiment_heads (workspace_id,experiment_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,dataset_id) REFERENCES benchmark_dataset_heads (workspace_id,dataset_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id,job_id) REFERENCES benchmark_jobs (workspace_id,job_id) ON DELETE NO ACTION,
  CHECK (length(operation_kind) BETWEEN 1 AND 128),
  CHECK (length(operation_key) BETWEEN 1 AND 512),
  CHECK ((CASE WHEN experiment_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN dataset_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN job_id IS NOT NULL THEN 1 ELSE 0 END)=1),
  CHECK (length(request_hash)=64),
  CHECK (length(response_hash)=64),
  CHECK (length(response_ref)>0),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (response_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at_ms)='integer')
);

CREATE INDEX idx_benchmark_operation_receipts_1 ON benchmark_operation_receipts (workspace_id,experiment_id,created_at_ms);

CREATE INDEX idx_benchmark_operation_receipts_2 ON benchmark_operation_receipts (workspace_id,job_id,created_at_ms);

CREATE TRIGGER benchmark_operation_receipts_guard BEFORE UPDATE ON benchmark_operation_receipts WHEN 1=1 BEGIN SELECT RAISE(ABORT,'benchmark invariant'); END;

CREATE TRIGGER benchmark_operation_receipts_retained BEFORE DELETE ON benchmark_operation_receipts BEGIN SELECT RAISE(ABORT,'benchmark history retained'); END;
