PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id),
  CHECK (length(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (length(trim(name)) > 0),
  CHECK (length(name) <= 512),
  CHECK (status IN ('active','disabled')),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (typeof(updated_at_ms) = 'integer'),
  CHECK (instr(project_id,char(0)) = 0 AND instr(project_id,char(1)) = 0 AND instr(project_id,char(2)) = 0 AND instr(project_id,char(3)) = 0 AND instr(project_id,char(4)) = 0 AND instr(project_id,char(5)) = 0 AND instr(project_id,char(6)) = 0 AND instr(project_id,char(7)) = 0 AND instr(project_id,char(8)) = 0 AND instr(project_id,char(9)) = 0 AND instr(project_id,char(10)) = 0 AND instr(project_id,char(11)) = 0 AND instr(project_id,char(12)) = 0 AND instr(project_id,char(13)) = 0 AND instr(project_id,char(14)) = 0 AND instr(project_id,char(15)) = 0 AND instr(project_id,char(16)) = 0 AND instr(project_id,char(17)) = 0 AND instr(project_id,char(18)) = 0 AND instr(project_id,char(19)) = 0 AND instr(project_id,char(20)) = 0 AND instr(project_id,char(21)) = 0 AND instr(project_id,char(22)) = 0 AND instr(project_id,char(23)) = 0 AND instr(project_id,char(24)) = 0 AND instr(project_id,char(25)) = 0 AND instr(project_id,char(26)) = 0 AND instr(project_id,char(27)) = 0 AND instr(project_id,char(28)) = 0 AND instr(project_id,char(29)) = 0 AND instr(project_id,char(30)) = 0 AND instr(project_id,char(31)) = 0 AND instr(project_id,char(127)) = 0 AND instr(project_id,char(128)) = 0 AND instr(project_id,char(129)) = 0 AND instr(project_id,char(130)) = 0 AND instr(project_id,char(131)) = 0 AND instr(project_id,char(132)) = 0 AND instr(project_id,char(133)) = 0 AND instr(project_id,char(134)) = 0 AND instr(project_id,char(135)) = 0 AND instr(project_id,char(136)) = 0 AND instr(project_id,char(137)) = 0 AND instr(project_id,char(138)) = 0 AND instr(project_id,char(139)) = 0 AND instr(project_id,char(140)) = 0 AND instr(project_id,char(141)) = 0 AND instr(project_id,char(142)) = 0 AND instr(project_id,char(143)) = 0 AND instr(project_id,char(144)) = 0 AND instr(project_id,char(145)) = 0 AND instr(project_id,char(146)) = 0 AND instr(project_id,char(147)) = 0 AND instr(project_id,char(148)) = 0 AND instr(project_id,char(149)) = 0 AND instr(project_id,char(150)) = 0 AND instr(project_id,char(151)) = 0 AND instr(project_id,char(152)) = 0 AND instr(project_id,char(153)) = 0 AND instr(project_id,char(154)) = 0 AND instr(project_id,char(155)) = 0 AND instr(project_id,char(156)) = 0 AND instr(project_id,char(157)) = 0 AND instr(project_id,char(158)) = 0 AND instr(project_id,char(159)) = 0)
);

CREATE TABLE project_workspaces (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id),
  CHECK (length(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (created_at_ms >= 0),
  CHECK (typeof(created_at_ms) = 'integer'),
  CHECK (instr(project_id,char(0)) = 0 AND instr(project_id,char(1)) = 0 AND instr(project_id,char(2)) = 0 AND instr(project_id,char(3)) = 0 AND instr(project_id,char(4)) = 0 AND instr(project_id,char(5)) = 0 AND instr(project_id,char(6)) = 0 AND instr(project_id,char(7)) = 0 AND instr(project_id,char(8)) = 0 AND instr(project_id,char(9)) = 0 AND instr(project_id,char(10)) = 0 AND instr(project_id,char(11)) = 0 AND instr(project_id,char(12)) = 0 AND instr(project_id,char(13)) = 0 AND instr(project_id,char(14)) = 0 AND instr(project_id,char(15)) = 0 AND instr(project_id,char(16)) = 0 AND instr(project_id,char(17)) = 0 AND instr(project_id,char(18)) = 0 AND instr(project_id,char(19)) = 0 AND instr(project_id,char(20)) = 0 AND instr(project_id,char(21)) = 0 AND instr(project_id,char(22)) = 0 AND instr(project_id,char(23)) = 0 AND instr(project_id,char(24)) = 0 AND instr(project_id,char(25)) = 0 AND instr(project_id,char(26)) = 0 AND instr(project_id,char(27)) = 0 AND instr(project_id,char(28)) = 0 AND instr(project_id,char(29)) = 0 AND instr(project_id,char(30)) = 0 AND instr(project_id,char(31)) = 0 AND instr(project_id,char(127)) = 0 AND instr(project_id,char(128)) = 0 AND instr(project_id,char(129)) = 0 AND instr(project_id,char(130)) = 0 AND instr(project_id,char(131)) = 0 AND instr(project_id,char(132)) = 0 AND instr(project_id,char(133)) = 0 AND instr(project_id,char(134)) = 0 AND instr(project_id,char(135)) = 0 AND instr(project_id,char(136)) = 0 AND instr(project_id,char(137)) = 0 AND instr(project_id,char(138)) = 0 AND instr(project_id,char(139)) = 0 AND instr(project_id,char(140)) = 0 AND instr(project_id,char(141)) = 0 AND instr(project_id,char(142)) = 0 AND instr(project_id,char(143)) = 0 AND instr(project_id,char(144)) = 0 AND instr(project_id,char(145)) = 0 AND instr(project_id,char(146)) = 0 AND instr(project_id,char(147)) = 0 AND instr(project_id,char(148)) = 0 AND instr(project_id,char(149)) = 0 AND instr(project_id,char(150)) = 0 AND instr(project_id,char(151)) = 0 AND instr(project_id,char(152)) = 0 AND instr(project_id,char(153)) = 0 AND instr(project_id,char(154)) = 0 AND instr(project_id,char(155)) = 0 AND instr(project_id,char(156)) = 0 AND instr(project_id,char(157)) = 0 AND instr(project_id,char(158)) = 0 AND instr(project_id,char(159)) = 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE NO ACTION,
  FOREIGN KEY (project_id) REFERENCES projects (project_id) ON DELETE NO ACTION
);

CREATE INDEX idx_project_workspaces_project ON project_workspaces (project_id, workspace_id);

INSERT INTO projects(project_id,name,status,created_at_ms,updated_at_ms) VALUES ('default','default','active',0,0);

INSERT INTO project_workspaces(workspace_id,project_id,created_at_ms) SELECT workspace_id,'default',created_at_ms FROM workspaces;

CREATE TRIGGER project_workspaces_immutable_update BEFORE UPDATE ON project_workspaces BEGIN SELECT RAISE(ABORT, 'project workspace binding immutable'); END;

CREATE TRIGGER project_workspaces_immutable_delete BEFORE DELETE ON project_workspaces BEGIN SELECT RAISE(ABORT, 'project workspace binding immutable'); END;

CREATE TRIGGER project_id_immutable BEFORE UPDATE ON projects WHEN OLD.project_id<>NEW.project_id BEGIN SELECT RAISE(ABORT, 'project identity immutable'); END;

CREATE TRIGGER default_project_no_delete BEFORE DELETE ON projects WHEN OLD.project_id='default' BEGIN SELECT RAISE(ABORT, 'default project cannot be deleted'); END;
