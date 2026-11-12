PRAGMA foreign_keys = ON;

CREATE TABLE iam_principals (
  principal_id TEXT NOT NULL,
  normalized_login_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (principal_id),
  UNIQUE (normalized_login_name),
  CHECK (status IN ('active','disabled')),
  CHECK (length(normalized_login_name) > 0),
  CHECK (normalized_login_name = trim(normalized_login_name)),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(auth_version) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer')
);

CREATE TABLE iam_password_credentials (
  principal_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  scheme TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  changed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (principal_id),
  CHECK (length(scheme) > 0),
  CHECK (length(parameters_json) > 0),
  CHECK (credential_version > 0 AND credential_version <= 9223372036854775807),
  CHECK (changed_at_ms >= 0),
  CHECK (length(password_hash) = 64 AND password_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(credential_version) = 'integer'),
  CHECK (typeof(changed_at_ms) = 'integer'),
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE TABLE iam_api_credentials (
  credential_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  PRIMARY KEY (credential_id),
  UNIQUE (token_hash),
  CHECK (expires_at_ms >= issued_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (issued_at_ms >= 0),
  CHECK (expires_at_ms >= 0),
  CHECK (revoked_at_ms >= 0),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(auth_version) = 'integer'),
  CHECK (typeof(issued_at_ms) = 'integer'),
  CHECK (typeof(expires_at_ms) = 'integer'),
  CHECK (revoked_at_ms IS NULL OR typeof(revoked_at_ms) = 'integer'),
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_api_credentials_principal_scope ON iam_api_credentials (principal_id, workspace_id, revoked_at_ms);

CREATE INDEX idx_iam_api_credentials_expiry ON iam_api_credentials (expires_at_ms);

CREATE TABLE iam_external_identities (
  external_identity_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (external_identity_id),
  UNIQUE (provider, issuer, subject),
  CHECK (length(provider) > 0),
  CHECK (length(issuer) > 0),
  CHECK (length(subject) > 0),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_external_identities_principal ON iam_external_identities (principal_id);

CREATE TABLE iam_sessions (
  session_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  PRIMARY KEY (session_id),
  UNIQUE (session_token_hash),
  CHECK (expires_at_ms >= issued_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (issued_at_ms >= 0),
  CHECK (expires_at_ms >= 0),
  CHECK (revoked_at_ms >= 0),
  CHECK (length(session_token_hash) = 64 AND session_token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(auth_version) = 'integer'),
  CHECK (typeof(issued_at_ms) = 'integer'),
  CHECK (typeof(expires_at_ms) = 'integer'),
  CHECK (revoked_at_ms IS NULL OR typeof(revoked_at_ms) = 'integer'),
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_sessions_principal ON iam_sessions (principal_id, revoked_at_ms);

CREATE INDEX idx_iam_sessions_expiry ON iam_sessions (expires_at_ms);

CREATE TABLE iam_groups (
  group_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  policy_revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id),
  UNIQUE (group_key),
  CHECK (status IN ('active','disabled')),
  CHECK (length(group_key) > 0),
  CHECK (policy_revision > 0 AND policy_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(policy_revision) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_groups_created_by ON iam_groups (created_by);

CREATE TABLE iam_group_memberships (
  group_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, principal_id),
  CHECK (role IN ('owner','admin','member','viewer')),
  CHECK (status IN ('active','disabled')),
  CHECK (etag > 0 AND etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (group_id) REFERENCES iam_groups (group_id) ON DELETE NO ACTION,
  FOREIGN KEY (principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_group_memberships_principal ON iam_group_memberships (principal_id, status, group_id);

CREATE INDEX idx_iam_group_memberships_owners ON iam_group_memberships (group_id, role, status);

CREATE TABLE iam_workspace_bindings (
  workspace_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_group_id TEXT,
  owner_principal_id TEXT,
  binding_revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id),
  CHECK ((owner_type = 'group' AND owner_group_id IS NOT NULL AND owner_principal_id IS NULL) OR (owner_type = 'personal' AND owner_principal_id IS NOT NULL AND owner_group_id IS NULL)),
  CHECK (binding_revision > 0 AND binding_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(binding_revision) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_group_id) REFERENCES iam_groups (group_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_workspace_bindings_group ON iam_workspace_bindings (owner_group_id);

CREATE INDEX idx_iam_workspace_bindings_principal ON iam_workspace_bindings (owner_principal_id);

CREATE TABLE iam_resource_access (
  workspace_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  etag INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, resource_kind, resource_id),
  CHECK (resource_kind IN ('trace','asset','run','snapshot','artifact')),
  CHECK (visibility IN ('private','group')),
  CHECK (length(resource_id) > 0),
  CHECK (etag > 0 AND etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(etag) = 'integer'),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id) REFERENCES iam_workspace_bindings (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_resource_access_owner ON iam_resource_access (owner_principal_id, workspace_id, resource_kind);

CREATE INDEX idx_iam_resource_access_visibility ON iam_resource_access (workspace_id, visibility, resource_kind);

CREATE TABLE iam_resource_grants (
  workspace_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  grantee_principal_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, resource_kind, resource_id, grantee_principal_id),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  FOREIGN KEY (workspace_id, resource_kind, resource_id) REFERENCES iam_resource_access (workspace_id, resource_kind, resource_id) ON DELETE NO ACTION,
  FOREIGN KEY (grantee_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_iam_resource_grants_principal ON iam_resource_grants (grantee_principal_id, workspace_id, resource_kind);

CREATE TRIGGER iam_membership_insert_policy BEFORE INSERT ON iam_group_memberships BEGIN UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=NEW.group_id; END;

CREATE TRIGGER iam_membership_update_guard BEFORE UPDATE ON iam_group_memberships BEGIN SELECT RAISE(ABORT, 'membership identity immutable') WHERE OLD.group_id<>NEW.group_id OR OLD.principal_id<>NEW.principal_id; UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=OLD.group_id; SELECT RAISE(ABORT, 'last active group owner') WHERE OLD.role='owner' AND OLD.status='active' AND EXISTS (SELECT 1 FROM iam_principals p WHERE p.principal_id=OLD.principal_id AND p.status='active') AND EXISTS (SELECT 1 FROM iam_groups g WHERE g.group_id=OLD.group_id AND g.status='active') AND (NEW.role<>'owner' OR NEW.status<>'active') AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.principal_id<>OLD.principal_id AND m.role='owner' AND m.status='active' AND p.status='active'); END;

CREATE TRIGGER iam_membership_delete_guard BEFORE DELETE ON iam_group_memberships BEGIN UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=OLD.group_id; SELECT RAISE(ABORT, 'last active group owner') WHERE OLD.role='owner' AND OLD.status='active' AND EXISTS (SELECT 1 FROM iam_principals p WHERE p.principal_id=OLD.principal_id AND p.status='active') AND EXISTS (SELECT 1 FROM iam_groups g WHERE g.group_id=OLD.group_id AND g.status='active') AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.principal_id<>OLD.principal_id AND m.role='owner' AND m.status='active' AND p.status='active'); END;

CREATE TRIGGER iam_principal_update_owner_guard BEFORE UPDATE ON iam_principals WHEN OLD.status<>NEW.status OR OLD.principal_id<>NEW.principal_id BEGIN SELECT RAISE(ABORT, 'principal identity immutable') WHERE OLD.principal_id<>NEW.principal_id; UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id IN (SELECT group_id FROM iam_group_memberships WHERE principal_id=OLD.principal_id); SELECT RAISE(ABORT, 'last active group owner') WHERE OLD.status='active' AND NEW.status='disabled' AND EXISTS (SELECT 1 FROM iam_group_memberships mine JOIN iam_groups g ON g.group_id=mine.group_id WHERE mine.principal_id=OLD.principal_id AND mine.role='owner' AND mine.status='active' AND g.status='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships other JOIN iam_principals p ON p.principal_id=other.principal_id WHERE other.group_id=mine.group_id AND other.principal_id<>OLD.principal_id AND other.role='owner' AND other.status='active' AND p.status='active')); END;

CREATE TRIGGER iam_principal_delete_owner_guard BEFORE DELETE ON iam_principals BEGIN UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id IN (SELECT group_id FROM iam_group_memberships WHERE principal_id=OLD.principal_id); SELECT RAISE(ABORT, 'last active group owner') WHERE OLD.status='active' AND EXISTS (SELECT 1 FROM iam_group_memberships mine JOIN iam_groups g ON g.group_id=mine.group_id WHERE mine.principal_id=OLD.principal_id AND mine.role='owner' AND mine.status='active' AND g.status='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships other JOIN iam_principals p ON p.principal_id=other.principal_id WHERE other.group_id=mine.group_id AND other.principal_id<>OLD.principal_id AND other.role='owner' AND other.status='active' AND p.status='active')); END;

CREATE TRIGGER iam_binding_ownership_immutable BEFORE UPDATE ON iam_workspace_bindings WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.owner_type IS NOT NEW.owner_type OR OLD.owner_group_id IS NOT NEW.owner_group_id OR OLD.owner_principal_id IS NOT NEW.owner_principal_id BEGIN SELECT RAISE(ABORT, 'workspace ownership immutable'); END;

CREATE TRIGGER iam_group_reenable_guard BEFORE UPDATE ON iam_groups BEGIN SELECT RAISE(ABORT, 'group identity immutable') WHERE OLD.group_id<>NEW.group_id; SELECT RAISE(ABORT, 'active group requires owner') WHERE OLD.status='disabled' AND NEW.status='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.role='owner' AND m.status='active' AND p.status='active'); END;

CREATE TRIGGER iam_binding_no_delete BEFORE DELETE ON iam_workspace_bindings BEGIN SELECT RAISE(ABORT, 'workspace ownership immutable'); END;
