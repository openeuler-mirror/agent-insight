CREATE TABLE `infra_sources` (
  `workspace_id` LONGTEXT NOT NULL,
  `source_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `endpoint` LONGTEXT NOT NULL,
  `scrape_url` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL DEFAULT 'pull',
  `auth_ref` LONGTEXT,
  `model` LONGTEXT,
  `hardware_name` LONGTEXT,
  `mem_bandwidth_gbs` DOUBLE,
  `scrape_interval_ms` BIGINT NOT NULL DEFAULT 1000,
  `enabled` BIGINT NOT NULL DEFAULT 1,
  `state` LONGTEXT NOT NULL DEFAULT 'active',
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (kind IN ('pull','push')),
  CHECK (state IN ('active','deleted')),
  CHECK (enabled IN (0,1)),
  CHECK (CHAR_LENGTH(endpoint)>0 AND CHAR_LENGTH(endpoint)<=16384),
  CHECK (scrape_interval_ms>=-2147483648 AND scrape_interval_ms<=2147483647 AND revision>=1),
  CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `source_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `session_infra_links` (
  `workspace_id` LONGTEXT NOT NULL,
  `root_trace_id` LONGTEXT NOT NULL,
  `link_id` LONGTEXT NOT NULL,
  `source_id` LONGTEXT NOT NULL,
  `model` LONGTEXT,
  `position` BIGINT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `retired_at_ms` BIGINT,
  CHECK (`position`>=0 AND created_at_ms>=0),
  CHECK (retired_at_ms IS NULL OR retired_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `root_trace_id`(120), `link_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `infra_sources_set_keys_insert` BEFORE INSERT ON `infra_sources` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`endpoint` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`endpoint`), ':', NEW.`endpoint`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `infra_sources_set_keys_update` BEFORE UPDATE ON `infra_sources` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`endpoint` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`endpoint`), ':', NEW.`endpoint`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `session_infra_links_set_keys_insert` BEFORE INSERT ON `session_infra_links` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL AND NEW.`link_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`, OCTET_LENGTH(NEW.`link_id`), ':', NEW.`link_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL AND NEW.`position` IS NOT NULL AND (NEW.`retired_at_ms` IS NULL), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`, OCTET_LENGTH(NEW.`position`), ':', NEW.`position`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `session_infra_links_set_keys_update` BEFORE UPDATE ON `session_infra_links` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL AND NEW.`link_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`, OCTET_LENGTH(NEW.`link_id`), ':', NEW.`link_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`root_trace_id` IS NOT NULL AND NEW.`position` IS NOT NULL AND (NEW.`retired_at_ms` IS NULL), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`root_trace_id`), ':', NEW.`root_trace_id`, OCTET_LENGTH(NEW.`position`), ':', NEW.`position`), 256)), NULL);
END;

-- next statement

CREATE UNIQUE INDEX `idx_infra_source_active_endpoint` ON `infra_sources` (`_key_4`);

-- next statement

CREATE INDEX `idx_infra_source_owner` ON `infra_sources` (`workspace_id`(120), `owner_principal_id`(120), `state`(120), `created_at_ms`, `source_id`(120));

-- next statement

CREATE UNIQUE INDEX `idx_session_infra_position` ON `session_infra_links` (`_key_4`);

-- next statement

CREATE TRIGGER `infra_source_update_guard` BEFORE UPDATE ON `infra_sources` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.source_id <=> OLD.source_id) OR NOT (NEW.owner_principal_id <=> OLD.owner_principal_id) OR NOT (NEW.endpoint <=> OLD.endpoint) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR OLD.state='deleted' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'infra source identity/history is retained';
  END IF;
END;

-- next statement

CREATE TRIGGER `infra_source_delete_guard` BEFORE DELETE ON `infra_sources` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'infra history is retained';
END;

-- next statement

CREATE TRIGGER `infra_link_delete_guard` BEFORE DELETE ON `session_infra_links` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'infra history is retained';
END;

-- next statement

CREATE TRIGGER `infra_link_integer_guard` BEFORE INSERT ON `session_infra_links` FOR EACH ROW
BEGIN
  IF FALSE OR FALSE OR (NEW.retired_at_ms IS NOT NULL AND FALSE) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'infra link clocks and positions require integers';
  END IF;
END;

-- next statement

CREATE TRIGGER `infra_link_update_guard` BEFORE UPDATE ON `session_infra_links` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.root_trace_id <=> OLD.root_trace_id) OR NOT (NEW.link_id <=> OLD.link_id) OR NOT (NEW.source_id <=> OLD.source_id) OR NOT (NEW.model <=> OLD.model) OR NOT (NEW.`position` <=> OLD.`position`) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL OR FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'infra link history is retained';
  END IF;
END;

-- next statement

ALTER TABLE `infra_sources` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `infra_sources` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `session_infra_links` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `session_infra_links` ADD FOREIGN KEY (`_key_3`) REFERENCES `infra_sources` (`_key_1`);
