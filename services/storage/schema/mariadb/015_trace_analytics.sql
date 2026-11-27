CREATE TABLE `trace_analytics_publications` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `boundary` LONGTEXT NOT NULL,
  `parser_version` BIGINT NOT NULL,
  `projection_hash` LONGTEXT NOT NULL,
  `snapshot_hash` LONGTEXT NOT NULL,
  `created_by` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(boundary)=64 AND BINARY boundary NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(projection_hash)=64 AND BINARY projection_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(snapshot_hash)=64 AND BINARY snapshot_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (parser_version=1),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120), `boundary`(120), `parser_version`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `ras_event_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `task_id` LONGTEXT NOT NULL,
  `event_key` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `occurred_at_ms` BIGINT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(task_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(event_key) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(event_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(content_hash)=64 AND BINARY content_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (occurred_at_ms>=0 AND occurred_at_ms<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `task_id`(120), `event_key`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `owner_principal_id`(120), `event_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_trace_sources` (
  `workspace_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `case_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `incarnation` BIGINT NOT NULL,
  `route_epoch` BIGINT NOT NULL,
  `execution_id` LONGTEXT NOT NULL,
  `snapshot_hash` LONGTEXT NOT NULL,
  `plan_hash` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(execution_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(snapshot_hash)=64 AND BINARY snapshot_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(plan_hash)=64 AND BINARY plan_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (incarnation>=1 AND incarnation<=9223372036854775807),
  CHECK (route_epoch>=1 AND route_epoch<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `run_id`(120), `case_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `trace_analytics_publications_set_keys_insert` BEFORE INSERT ON `trace_analytics_publications` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`boundary` IS NOT NULL AND NEW.`parser_version` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`boundary`), ':', NEW.`boundary`, OCTET_LENGTH(NEW.`parser_version`), ':', NEW.`parser_version`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_analytics_publications_set_keys_update` BEFORE UPDATE ON `trace_analytics_publications` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`boundary` IS NOT NULL AND NEW.`parser_version` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`boundary`), ':', NEW.`boundary`, OCTET_LENGTH(NEW.`parser_version`), ':', NEW.`parser_version`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ras_event_receipts_set_keys_insert` BEFORE INSERT ON `ras_event_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`task_id` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`task_id`), ':', NEW.`task_id`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ras_event_receipts_set_keys_update` BEFORE UPDATE ON `ras_event_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`task_id` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`task_id`), ':', NEW.`task_id`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_trace_sources_set_keys_insert` BEFORE INSERT ON `experiment_trace_sources` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_trace_sources_set_keys_update` BEFORE UPDATE ON `experiment_trace_sources` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_trace_analytics_publications_1` ON `trace_analytics_publications` (`workspace_id`(120), `created_at_ms`, `trace_id`(120));

-- next statement

CREATE TRIGGER `trace_analytics_publications_update_guard` BEFORE UPDATE ON `trace_analytics_publications` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics publications are immutable';
END;

-- next statement

CREATE TRIGGER `trace_analytics_publications_delete_guard` BEFORE DELETE ON `trace_analytics_publications` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics history is retained';
END;

-- next statement

CREATE INDEX `idx_ras_event_receipts_1` ON `ras_event_receipts` (`workspace_id`(120), `owner_principal_id`(120), `task_id`(120), `occurred_at_ms`, `event_id`(120));

-- next statement

CREATE TRIGGER `ras_event_receipts_update_guard` BEFORE UPDATE ON `ras_event_receipts` FOR EACH ROW
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.owner_principal_id<>OLD.owner_principal_id OR NEW.task_id<>OLD.task_id OR NEW.event_key<>OLD.event_key OR NEW.event_id<>OLD.event_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RAS event identity or revision changed';
  END IF;
END;

-- next statement

CREATE TRIGGER `ras_event_receipts_delete_guard` BEFORE DELETE ON `ras_event_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RAS history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_trace_sources_1` ON `experiment_trace_sources` (`workspace_id`(120), `trace_id`(120), `run_id`(120), `case_id`(120));

-- next statement

CREATE TRIGGER `experiment_trace_sources_update_guard` BEFORE UPDATE ON `experiment_trace_sources` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'frozen Trace source index is immutable';
END;

-- next statement

CREATE TRIGGER `experiment_trace_sources_delete_guard` BEFORE DELETE ON `experiment_trace_sources` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'frozen Trace source history is retained';
END;

-- next statement

ALTER TABLE `trace_analytics_publications` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `trace_analytics_publications` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `ras_event_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `ras_event_receipts` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_trace_sources` ADD FOREIGN KEY (`_key_2`) REFERENCES `experiment_runs` (`_key_2`);

-- next statement

ALTER TABLE `experiment_trace_sources` ADD FOREIGN KEY (`_key_3`) REFERENCES `experiment_cases` (`_key_1`);

-- next statement

ALTER TABLE `experiment_trace_sources` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_locators` (`_key_1`);
