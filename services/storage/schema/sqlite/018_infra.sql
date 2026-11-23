CREATE TABLE infra_sources (
 workspace_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 owner_principal_id TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 scrape_url TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'pull',
 auth_ref TEXT,
 model TEXT,
 hardware_name TEXT,
 mem_bandwidth_gbs REAL,
 scrape_interval_ms INTEGER NOT NULL DEFAULT 1000,
 enabled INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'active',
 revision INTEGER NOT NULL DEFAULT 1,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY (workspace_id,source_id),
 FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE NO ACTION,
 FOREIGN KEY (owner_principal_id) REFERENCES iam_principals(principal_id) ON DELETE NO ACTION,
 CHECK (kind IN ('pull','push')),
 CHECK (state IN ('active','deleted')),
 CHECK (enabled IN (0,1)),
 CHECK (length(endpoint)>0 AND length(endpoint)<=16384),
 CHECK (scrape_interval_ms>=-2147483648 AND scrape_interval_ms<=2147483647 AND revision>=1),
 CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms)
);
CREATE UNIQUE INDEX idx_infra_source_active_endpoint ON infra_sources(workspace_id,owner_principal_id,endpoint) WHERE state='active';
CREATE INDEX idx_infra_source_owner ON infra_sources(workspace_id,owner_principal_id,state,created_at_ms,source_id);
CREATE TABLE session_infra_links (
 workspace_id TEXT NOT NULL,
 root_trace_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 model TEXT,
 position INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL,
 retired_at_ms INTEGER,
 PRIMARY KEY (workspace_id,root_trace_id,link_id),
 FOREIGN KEY (workspace_id,root_trace_id) REFERENCES trace_locators(workspace_id,trace_id) ON DELETE NO ACTION,
 FOREIGN KEY (workspace_id,source_id) REFERENCES infra_sources(workspace_id,source_id) ON DELETE NO ACTION,
 CHECK (position>=0 AND created_at_ms>=0),
 CHECK (retired_at_ms IS NULL OR retired_at_ms>=created_at_ms)
);
CREATE UNIQUE INDEX idx_session_infra_position ON session_infra_links(workspace_id,root_trace_id,position) WHERE retired_at_ms IS NULL;
CREATE TRIGGER infra_source_update_guard BEFORE UPDATE ON infra_sources WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_id IS NOT OLD.source_id OR NEW.owner_principal_id IS NOT OLD.owner_principal_id OR NEW.endpoint IS NOT OLD.endpoint OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR OLD.state='deleted' BEGIN SELECT RAISE(ABORT,'infra source identity/history is retained'); END;
CREATE TRIGGER infra_source_delete_guard BEFORE DELETE ON infra_sources BEGIN SELECT RAISE(ABORT,'infra history is retained'); END;
CREATE TRIGGER infra_link_delete_guard BEFORE DELETE ON session_infra_links BEGIN SELECT RAISE(ABORT,'infra history is retained'); END;
CREATE TRIGGER infra_source_integer_guard BEFORE INSERT ON infra_sources WHEN typeof(NEW.scrape_interval_ms)<>'integer' OR typeof(NEW.enabled)<>'integer' OR typeof(NEW.revision)<>'integer' OR typeof(NEW.created_at_ms)<>'integer' OR typeof(NEW.updated_at_ms)<>'integer' BEGIN SELECT RAISE(ABORT,'infra source clocks and revisions require integers'); END;
CREATE TRIGGER infra_source_integer_update_guard BEFORE UPDATE ON infra_sources WHEN typeof(NEW.scrape_interval_ms)<>'integer' OR typeof(NEW.enabled)<>'integer' OR typeof(NEW.revision)<>'integer' OR typeof(NEW.created_at_ms)<>'integer' OR typeof(NEW.updated_at_ms)<>'integer' BEGIN SELECT RAISE(ABORT,'infra source clocks and revisions require integers'); END;
CREATE TRIGGER infra_link_integer_guard BEFORE INSERT ON session_infra_links WHEN typeof(NEW.position)<>'integer' OR typeof(NEW.created_at_ms)<>'integer' OR (NEW.retired_at_ms IS NOT NULL AND typeof(NEW.retired_at_ms)<>'integer') BEGIN SELECT RAISE(ABORT,'infra link clocks and positions require integers'); END;
CREATE TRIGGER infra_link_update_guard BEFORE UPDATE ON session_infra_links WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.root_trace_id IS NOT OLD.root_trace_id OR NEW.link_id IS NOT OLD.link_id OR NEW.source_id IS NOT OLD.source_id OR NEW.model IS NOT OLD.model OR NEW.position IS NOT OLD.position OR NEW.created_at_ms IS NOT OLD.created_at_ms OR OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL OR typeof(NEW.retired_at_ms)<>'integer' BEGIN SELECT RAISE(ABORT,'infra link history is retained'); END;
