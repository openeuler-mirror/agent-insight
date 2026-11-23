CREATE TABLE trace_legacy_ids (
  workspace_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, alias_kind, alias_id),
  CHECK (alias_kind IN ('task','execution')),
  CHECK (length(alias_id)>0),
  CHECK (created_at_ms>=0),
  CHECK (typeof(created_at_ms)='integer'),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION
);

CREATE INDEX idx_trace_legacy_ids_trace ON trace_legacy_ids (workspace_id, trace_id, alias_kind, created_at_ms, alias_id);

CREATE TABLE trace_annotations (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  label TEXT,
  query_override TEXT,
  final_result_override TEXT,
  feedback_json TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, trace_id),
  CHECK (length(extra_json)>0),
  CHECK (feedback_json IS NULL OR length(feedback_json)>0),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer'),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION
);

CREATE TABLE trace_tags (
  workspace_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, tag_id),
  UNIQUE (workspace_id, owner_principal_id, kind, name),
  CHECK (length(tag_id)>0),
  CHECK (kind IN ('version','business')),
  CHECK (length(name) BETWEEN 1 AND 80),
  CHECK (name=trim(name)),
  CHECK (description IS NULL OR length(description)<=300),
  CHECK (length(color)=7),
  CHECK (substr(color,1,1)='#'),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (substr(color,2) NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(revision)='integer'),
  CHECK (typeof(created_at_ms)='integer'),
  CHECK (typeof(updated_at_ms)='integer'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (owner_principal_id) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_trace_tags_kind ON trace_tags (workspace_id, kind, created_at_ms);

CREATE TABLE trace_tag_links (
  workspace_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, trace_id, tag_id),
  CHECK (created_at_ms>=0),
  CHECK (typeof(created_at_ms)='integer'),
  FOREIGN KEY (workspace_id, trace_id) REFERENCES trace_locators (workspace_id, trace_id) ON DELETE NO ACTION,
  FOREIGN KEY (workspace_id, tag_id) REFERENCES trace_tags (workspace_id, tag_id) ON DELETE NO ACTION,
  FOREIGN KEY (created_by) REFERENCES iam_principals (principal_id) ON DELETE NO ACTION
);

CREATE INDEX idx_trace_tag_links_tag ON trace_tag_links (workspace_id, tag_id, trace_id);

CREATE TRIGGER trace_legacy_ids_no_update BEFORE UPDATE ON trace_legacy_ids BEGIN SELECT RAISE(ABORT, 'legacy Trace identity mapping immutable'); END;

CREATE TRIGGER trace_legacy_ids_no_delete BEFORE DELETE ON trace_legacy_ids BEGIN SELECT RAISE(ABORT, 'legacy Trace identity mapping retained'); END;
