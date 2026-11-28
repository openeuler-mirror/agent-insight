CREATE TABLE `collector_trace_threads` (
  `workspace_id` LONGTEXT NOT NULL,
  `thread_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `framework` LONGTEXT NOT NULL,
  `source_thread_id` LONGTEXT NOT NULL,
  `legacy_username` LONGTEXT NOT NULL,
  `source_kind` LONGTEXT,
  `started_at_ms` BIGINT,
  `updated_at_ms` BIGINT,
  `metadata_json` LONGTEXT,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `modified_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(workspace_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(thread_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(owner_principal_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(framework) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(source_thread_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(legacy_username) BETWEEN 1 AND 512),
  CHECK (started_at_ms IS NULL OR (started_at_ms>=0 AND started_at_ms<=9223372036854775807)),
  CHECK (updated_at_ms IS NULL OR (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807)),
  CHECK ((revision>=1 AND revision<=9223372036854775807)),
  CHECK ((created_at_ms>=0 AND created_at_ms<=9223372036854775807)),
  CHECK ((modified_at_ms>=0 AND modified_at_ms<=9223372036854775807)),
  CHECK (modified_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `thread_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `owner_principal_id`(120), `framework`(120), `source_thread_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `collector_trace_thread_events` (
  `workspace_id` LONGTEXT NOT NULL,
  `event_key` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `thread_id` LONGTEXT NOT NULL,
  `execution_trace_id` LONGTEXT,
  `related_trace_id` LONGTEXT,
  `kind` LONGTEXT NOT NULL,
  `status` LONGTEXT,
  `source_turn_id` LONGTEXT,
  `phase_id` LONGTEXT,
  `started_at_ms` BIGINT NOT NULL,
  `completed_at_ms` BIGINT,
  `payload_json` LONGTEXT,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `modified_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(workspace_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(event_key) BETWEEN 1 AND 1024),
  CHECK (CHAR_LENGTH(event_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(thread_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(kind) BETWEEN 1 AND 512),
  CHECK ((started_at_ms>=0 AND started_at_ms<=9223372036854775807)),
  CHECK (completed_at_ms IS NULL OR (completed_at_ms>=0 AND completed_at_ms<=9223372036854775807)),
  CHECK ((revision>=1 AND revision<=9223372036854775807)),
  CHECK ((created_at_ms>=0 AND created_at_ms<=9223372036854775807)),
  CHECK ((modified_at_ms>=0 AND modified_at_ms<=9223372036854775807)),
  CHECK (modified_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `event_key`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `event_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `collector_trace_thread_executions` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `thread_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `execution_id` LONGTEXT NOT NULL,
  `task_id` LONGTEXT NOT NULL,
  `source_execution_id` LONGTEXT,
  `timestamp_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(workspace_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(trace_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(thread_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(owner_principal_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(execution_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(task_id) BETWEEN 1 AND 512),
  CHECK ((timestamp_ms>=0 AND timestamp_ms<=9223372036854775807)),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `collector_trace_threads_set_keys_insert` BEFORE INSERT ON `collector_trace_threads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`framework` IS NOT NULL AND NEW.`source_thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`framework`), ':', NEW.`framework`, OCTET_LENGTH(NEW.`source_thread_id`), ':', NEW.`source_thread_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_trace_threads_set_keys_update` BEFORE UPDATE ON `collector_trace_threads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`framework` IS NOT NULL AND NEW.`source_thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`framework`), ':', NEW.`framework`, OCTET_LENGTH(NEW.`source_thread_id`), ':', NEW.`source_thread_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_trace_thread_events_set_keys_insert` BEFORE INSERT ON `collector_trace_thread_events` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`execution_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`execution_trace_id`), ':', NEW.`execution_trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`related_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`related_trace_id`), ':', NEW.`related_trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_trace_thread_events_set_keys_update` BEFORE UPDATE ON `collector_trace_thread_events` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`execution_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`execution_trace_id`), ':', NEW.`execution_trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`related_trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`related_trace_id`), ':', NEW.`related_trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_trace_thread_executions_set_keys_insert` BEFORE INSERT ON `collector_trace_thread_executions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_trace_thread_executions_set_keys_update` BEFORE UPDATE ON `collector_trace_thread_executions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`thread_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`thread_id`), ':', NEW.`thread_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_ct_threads_0` ON `collector_trace_threads` (`workspace_id`(120), `owner_principal_id`(120), `framework`(120), `updated_at_ms`, `thread_id`(120));

-- next statement

CREATE TRIGGER `collector_trace_threads_guard` BEFORE UPDATE ON `collector_trace_threads` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.thread_id <=> OLD.thread_id) OR NOT (NEW.owner_principal_id <=> OLD.owner_principal_id) OR NOT (NEW.framework <=> OLD.framework) OR NOT (NEW.source_thread_id <=> OLD.source_thread_id) OR NOT (NEW.legacy_username <=> OLD.legacy_username) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.modified_at_ms<OLD.modified_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'collector Thread identity or revision differs';
  END IF;
END;

-- next statement

CREATE INDEX `idx_ct_thread_events_0` ON `collector_trace_thread_events` (`workspace_id`(120), `thread_id`(120), `started_at_ms`, `event_key`(120));

-- next statement

CREATE INDEX `idx_ct_thread_events_1` ON `collector_trace_thread_events` (`workspace_id`(120), `execution_trace_id`(120), `started_at_ms`, `event_key`(120));

-- next statement

CREATE TRIGGER `collector_trace_thread_events_guard` BEFORE UPDATE ON `collector_trace_thread_events` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.event_key <=> OLD.event_key) OR NOT (NEW.event_id <=> OLD.event_id) OR NOT (NEW.thread_id <=> OLD.thread_id) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.modified_at_ms<OLD.modified_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'collector Thread identity or revision differs';
  END IF;
END;

-- next statement

CREATE INDEX `idx_ct_thread_executions_0` ON `collector_trace_thread_executions` (`workspace_id`(120), `thread_id`(120), `timestamp_ms`, `trace_id`(120));

-- next statement

CREATE INDEX `idx_ct_thread_executions_1` ON `collector_trace_thread_executions` (`workspace_id`(120), `thread_id`(120), `source_execution_id`(120));

-- next statement

ALTER TABLE `collector_trace_threads` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_threads` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_events` ADD FOREIGN KEY (`_key_3`) REFERENCES `collector_trace_threads` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_events` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_events` ADD FOREIGN KEY (`_key_5`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_executions` ADD FOREIGN KEY (`_key_1`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_executions` ADD FOREIGN KEY (`_key_2`) REFERENCES `collector_trace_threads` (`_key_1`);

-- next statement

ALTER TABLE `collector_trace_thread_executions` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);
