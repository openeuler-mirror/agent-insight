CREATE TABLE projects (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (project_id),
  CHECK (length(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (length(trim(name)) > 0),
  CHECK (length(name) <= 512),
  CHECK (status IN ('active','disabled')),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (project_id !~ '[[:cntrl:]]'),
  CHECK (strpos(project_id,chr(128)) = 0 AND strpos(project_id,chr(129)) = 0 AND strpos(project_id,chr(130)) = 0 AND strpos(project_id,chr(131)) = 0 AND strpos(project_id,chr(132)) = 0 AND strpos(project_id,chr(133)) = 0 AND strpos(project_id,chr(134)) = 0 AND strpos(project_id,chr(135)) = 0 AND strpos(project_id,chr(136)) = 0 AND strpos(project_id,chr(137)) = 0 AND strpos(project_id,chr(138)) = 0 AND strpos(project_id,chr(139)) = 0 AND strpos(project_id,chr(140)) = 0 AND strpos(project_id,chr(141)) = 0 AND strpos(project_id,chr(142)) = 0 AND strpos(project_id,chr(143)) = 0 AND strpos(project_id,chr(144)) = 0 AND strpos(project_id,chr(145)) = 0 AND strpos(project_id,chr(146)) = 0 AND strpos(project_id,chr(147)) = 0 AND strpos(project_id,chr(148)) = 0 AND strpos(project_id,chr(149)) = 0 AND strpos(project_id,chr(150)) = 0 AND strpos(project_id,chr(151)) = 0 AND strpos(project_id,chr(152)) = 0 AND strpos(project_id,chr(153)) = 0 AND strpos(project_id,chr(154)) = 0 AND strpos(project_id,chr(155)) = 0 AND strpos(project_id,chr(156)) = 0 AND strpos(project_id,chr(157)) = 0 AND strpos(project_id,chr(158)) = 0 AND strpos(project_id,chr(159)) = 0)
);

CREATE TABLE project_workspaces (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id),
  CHECK (length(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (created_at_ms >= 0),
  CHECK (project_id !~ '[[:cntrl:]]'),
  CHECK (strpos(project_id,chr(128)) = 0 AND strpos(project_id,chr(129)) = 0 AND strpos(project_id,chr(130)) = 0 AND strpos(project_id,chr(131)) = 0 AND strpos(project_id,chr(132)) = 0 AND strpos(project_id,chr(133)) = 0 AND strpos(project_id,chr(134)) = 0 AND strpos(project_id,chr(135)) = 0 AND strpos(project_id,chr(136)) = 0 AND strpos(project_id,chr(137)) = 0 AND strpos(project_id,chr(138)) = 0 AND strpos(project_id,chr(139)) = 0 AND strpos(project_id,chr(140)) = 0 AND strpos(project_id,chr(141)) = 0 AND strpos(project_id,chr(142)) = 0 AND strpos(project_id,chr(143)) = 0 AND strpos(project_id,chr(144)) = 0 AND strpos(project_id,chr(145)) = 0 AND strpos(project_id,chr(146)) = 0 AND strpos(project_id,chr(147)) = 0 AND strpos(project_id,chr(148)) = 0 AND strpos(project_id,chr(149)) = 0 AND strpos(project_id,chr(150)) = 0 AND strpos(project_id,chr(151)) = 0 AND strpos(project_id,chr(152)) = 0 AND strpos(project_id,chr(153)) = 0 AND strpos(project_id,chr(154)) = 0 AND strpos(project_id,chr(155)) = 0 AND strpos(project_id,chr(156)) = 0 AND strpos(project_id,chr(157)) = 0 AND strpos(project_id,chr(158)) = 0 AND strpos(project_id,chr(159)) = 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (project_id) REFERENCES projects (project_id) ON DELETE NO ACTION
);

CREATE INDEX idx_project_workspaces_project ON project_workspaces (project_id, workspace_id);

INSERT INTO projects(project_id,name,status,created_at_ms,updated_at_ms) VALUES ('default','default','active',0,0);

INSERT INTO project_workspaces(workspace_id,project_id,created_at_ms) SELECT workspace_id,'default',created_at_ms FROM workspaces;

CREATE FUNCTION storage_project_binding_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'project workspace binding immutable'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER project_workspaces_immutable BEFORE UPDATE OR DELETE ON project_workspaces FOR EACH ROW EXECUTE PROCEDURE storage_project_binding_immutable();

CREATE FUNCTION storage_project_identity_guard() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' THEN IF OLD.project_id='default' THEN RAISE EXCEPTION 'default project cannot be deleted'; END IF; RETURN OLD; END IF; IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'project identity immutable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER project_identity_guard BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE PROCEDURE storage_project_identity_guard();
