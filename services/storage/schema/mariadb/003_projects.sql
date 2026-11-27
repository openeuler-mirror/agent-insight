CREATE TABLE `projects` (
  `project_id` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'active',
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (CHAR_LENGTH(trim(name)) > 0),
  CHECK (CHAR_LENGTH(name) <= 512),
  CHECK (`status` IN ('active','disabled')),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  CHECK (instr(project_id,CHAR(0 USING utf8mb4)) = 0 AND instr(project_id,CHAR(1 USING utf8mb4)) = 0 AND instr(project_id,CHAR(2 USING utf8mb4)) = 0 AND instr(project_id,CHAR(3 USING utf8mb4)) = 0 AND instr(project_id,CHAR(4 USING utf8mb4)) = 0 AND instr(project_id,CHAR(5 USING utf8mb4)) = 0 AND instr(project_id,CHAR(6 USING utf8mb4)) = 0 AND instr(project_id,CHAR(7 USING utf8mb4)) = 0 AND instr(project_id,CHAR(8 USING utf8mb4)) = 0 AND instr(project_id,CHAR(9 USING utf8mb4)) = 0 AND instr(project_id,CHAR(10 USING utf8mb4)) = 0 AND instr(project_id,CHAR(11 USING utf8mb4)) = 0 AND instr(project_id,CHAR(12 USING utf8mb4)) = 0 AND instr(project_id,CHAR(13 USING utf8mb4)) = 0 AND instr(project_id,CHAR(14 USING utf8mb4)) = 0 AND instr(project_id,CHAR(15 USING utf8mb4)) = 0 AND instr(project_id,CHAR(16 USING utf8mb4)) = 0 AND instr(project_id,CHAR(17 USING utf8mb4)) = 0 AND instr(project_id,CHAR(18 USING utf8mb4)) = 0 AND instr(project_id,CHAR(19 USING utf8mb4)) = 0 AND instr(project_id,CHAR(20 USING utf8mb4)) = 0 AND instr(project_id,CHAR(21 USING utf8mb4)) = 0 AND instr(project_id,CHAR(22 USING utf8mb4)) = 0 AND instr(project_id,CHAR(23 USING utf8mb4)) = 0 AND instr(project_id,CHAR(24 USING utf8mb4)) = 0 AND instr(project_id,CHAR(25 USING utf8mb4)) = 0 AND instr(project_id,CHAR(26 USING utf8mb4)) = 0 AND instr(project_id,CHAR(27 USING utf8mb4)) = 0 AND instr(project_id,CHAR(28 USING utf8mb4)) = 0 AND instr(project_id,CHAR(29 USING utf8mb4)) = 0 AND instr(project_id,CHAR(30 USING utf8mb4)) = 0 AND instr(project_id,CHAR(31 USING utf8mb4)) = 0 AND instr(project_id,CHAR(127 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,128 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,129 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,130 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,131 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,132 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,133 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,134 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,135 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,136 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,137 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,138 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,139 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,140 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,141 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,142 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,143 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,144 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,145 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,146 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,147 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,148 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,149 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,150 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,151 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,152 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,153 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,154 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,155 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,156 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,157 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,158 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,159 USING utf8mb4)) = 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`project_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `project_workspaces` (
  `workspace_id` LONGTEXT NOT NULL,
  `project_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(project_id) BETWEEN 1 AND 512),
  CHECK (project_id = trim(project_id)),
  CHECK (created_at_ms >= 0),
  CHECK (instr(project_id,CHAR(0 USING utf8mb4)) = 0 AND instr(project_id,CHAR(1 USING utf8mb4)) = 0 AND instr(project_id,CHAR(2 USING utf8mb4)) = 0 AND instr(project_id,CHAR(3 USING utf8mb4)) = 0 AND instr(project_id,CHAR(4 USING utf8mb4)) = 0 AND instr(project_id,CHAR(5 USING utf8mb4)) = 0 AND instr(project_id,CHAR(6 USING utf8mb4)) = 0 AND instr(project_id,CHAR(7 USING utf8mb4)) = 0 AND instr(project_id,CHAR(8 USING utf8mb4)) = 0 AND instr(project_id,CHAR(9 USING utf8mb4)) = 0 AND instr(project_id,CHAR(10 USING utf8mb4)) = 0 AND instr(project_id,CHAR(11 USING utf8mb4)) = 0 AND instr(project_id,CHAR(12 USING utf8mb4)) = 0 AND instr(project_id,CHAR(13 USING utf8mb4)) = 0 AND instr(project_id,CHAR(14 USING utf8mb4)) = 0 AND instr(project_id,CHAR(15 USING utf8mb4)) = 0 AND instr(project_id,CHAR(16 USING utf8mb4)) = 0 AND instr(project_id,CHAR(17 USING utf8mb4)) = 0 AND instr(project_id,CHAR(18 USING utf8mb4)) = 0 AND instr(project_id,CHAR(19 USING utf8mb4)) = 0 AND instr(project_id,CHAR(20 USING utf8mb4)) = 0 AND instr(project_id,CHAR(21 USING utf8mb4)) = 0 AND instr(project_id,CHAR(22 USING utf8mb4)) = 0 AND instr(project_id,CHAR(23 USING utf8mb4)) = 0 AND instr(project_id,CHAR(24 USING utf8mb4)) = 0 AND instr(project_id,CHAR(25 USING utf8mb4)) = 0 AND instr(project_id,CHAR(26 USING utf8mb4)) = 0 AND instr(project_id,CHAR(27 USING utf8mb4)) = 0 AND instr(project_id,CHAR(28 USING utf8mb4)) = 0 AND instr(project_id,CHAR(29 USING utf8mb4)) = 0 AND instr(project_id,CHAR(30 USING utf8mb4)) = 0 AND instr(project_id,CHAR(31 USING utf8mb4)) = 0 AND instr(project_id,CHAR(127 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,128 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,129 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,130 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,131 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,132 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,133 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,134 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,135 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,136 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,137 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,138 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,139 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,140 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,141 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,142 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,143 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,144 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,145 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,146 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,147 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,148 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,149 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,150 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,151 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,152 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,153 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,154 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,155 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,156 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,157 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,158 USING utf8mb4)) = 0 AND instr(project_id,CHAR(194,159 USING utf8mb4)) = 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `projects_set_keys_insert` BEFORE INSERT ON `projects` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`project_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`project_id`), ':', NEW.`project_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `projects_set_keys_update` BEFORE UPDATE ON `projects` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`project_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`project_id`), ':', NEW.`project_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `project_workspaces_set_keys_insert` BEFORE INSERT ON `project_workspaces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`project_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`project_id`), ':', NEW.`project_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `project_workspaces_set_keys_update` BEFORE UPDATE ON `project_workspaces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`project_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`project_id`), ':', NEW.`project_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_project_workspaces_project` ON `project_workspaces` (`project_id`(120), `workspace_id`(120));

-- next statement

CREATE TRIGGER `project_workspaces_immutable_update` BEFORE UPDATE ON `project_workspaces` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'project workspace binding immutable';
END;

-- next statement

CREATE TRIGGER `project_workspaces_immutable_delete` BEFORE DELETE ON `project_workspaces` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'project workspace binding immutable';
END;

-- next statement

CREATE TRIGGER `project_id_immutable` BEFORE UPDATE ON `projects` FOR EACH ROW
BEGIN
  IF OLD.project_id<>NEW.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'project identity immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `default_project_no_delete` BEFORE DELETE ON `projects` FOR EACH ROW
BEGIN
  IF OLD.project_id='default' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'default project cannot be deleted';
  END IF;
END;

-- next statement

ALTER TABLE `project_workspaces` ADD FOREIGN KEY (`_key_1`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `project_workspaces` ADD FOREIGN KEY (`_key_2`) REFERENCES `projects` (`_key_1`);

-- next statement

INSERT INTO projects(project_id,name,status,created_at_ms,updated_at_ms) VALUES ('default','default','active',0,0);

-- next statement

INSERT INTO project_workspaces(workspace_id,project_id,created_at_ms) SELECT workspace_id,'default',created_at_ms FROM workspaces;
