CREATE TABLE `trace_diagnosis_sessions` (
  `workspace_id` LONGTEXT NOT NULL,
  `session_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `created_by` LONGTEXT NOT NULL,
  `opencode_session_id` LONGTEXT,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `next_sequence` BIGINT NOT NULL DEFAULT 1,
  `turn_fence` BIGINT NOT NULL DEFAULT 1,
  `active_request_key` LONGTEXT,
  `lease_owner` LONGTEXT,
  `lease_expires_at_ms` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(session_id) BETWEEN 1 AND 512),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (next_sequence BETWEEN 1 AND 9223372036854775807),
  CHECK (turn_fence BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms>=0),
  CHECK (opencode_session_id IS NULL OR CHAR_LENGTH(opencode_session_id) BETWEEN 1 AND 512),
  CHECK (active_request_key IS NULL OR CHAR_LENGTH(active_request_key) BETWEEN 1 AND 512),
  CHECK (lease_owner IS NULL OR CHAR_LENGTH(lease_owner) BETWEEN 1 AND 512),
  CHECK ((active_request_key IS NULL AND lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR (active_request_key IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `session_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `trace_diagnosis_messages` (
  `workspace_id` LONGTEXT NOT NULL,
  `session_id` LONGTEXT NOT NULL,
  `message_id` LONGTEXT NOT NULL,
  `seq` BIGINT NOT NULL,
  `request_key` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `role` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `content` LONGTEXT NOT NULL DEFAULT '',
  `content_hash` LONGTEXT NOT NULL,
  `evidence_hash` LONGTEXT,
  `opencode_session_id` LONGTEXT,
  `created_by` LONGTEXT NOT NULL,
  `turn_fence` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `error_code` LONGTEXT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(message_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(request_key) BETWEEN 1 AND 512),
  CHECK (seq BETWEEN 1 AND 9223372036854775807),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (turn_fence BETWEEN 1 AND 9223372036854775807),
  CHECK ((`role`='user' AND state='accepted' AND CHAR_LENGTH(content)>0) OR (`role`='assistant' AND state IN ('streaming','done','failed','interrupted'))),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (opencode_session_id IS NULL OR CHAR_LENGTH(opencode_session_id) BETWEEN 1 AND 512),
  CHECK (error_code IS NULL OR (CHAR_LENGTH(error_code) BETWEEN 1 AND 128 AND state IN ('failed','interrupted'))),
  CHECK ((CHAR_LENGTH(request_hash)=64 AND BINARY request_hash NOT REGEXP '[^0-9a-f]')),
  CHECK ((CHAR_LENGTH(content_hash)=64 AND BINARY content_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (evidence_hash IS NULL OR (CHAR_LENGTH(evidence_hash)=64 AND BINARY evidence_hash NOT REGEXP '[^0-9a-f]')),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `message_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `session_id`(120), `seq`),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `session_id`(120), `request_key`(120), `role`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `trace_diagnosis_sessions_set_keys_insert` BEFORE INSERT ON `trace_diagnosis_sessions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_sessions_set_keys_update` BEFORE UPDATE ON `trace_diagnosis_sessions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_messages_set_keys_insert` BEFORE INSERT ON `trace_diagnosis_messages` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`message_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`message_id`), ':', NEW.`message_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL AND NEW.`seq` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`, OCTET_LENGTH(NEW.`seq`), ':', NEW.`seq`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL AND NEW.`role` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`, OCTET_LENGTH(NEW.`role`), ':', NEW.`role`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_messages_set_keys_update` BEFORE UPDATE ON `trace_diagnosis_messages` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`message_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`message_id`), ':', NEW.`message_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL AND NEW.`seq` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`, OCTET_LENGTH(NEW.`seq`), ':', NEW.`seq`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL AND NEW.`role` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`, OCTET_LENGTH(NEW.`role`), ':', NEW.`role`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_diagnosis_sessions_updated` ON `trace_diagnosis_sessions` (`workspace_id`(120), `updated_at_ms`, `session_id`(120));

-- next statement

CREATE INDEX `idx_diagnosis_sessions_lease` ON `trace_diagnosis_sessions` (`lease_expires_at_ms`, `workspace_id`(120), `session_id`(120));

-- next statement

CREATE INDEX `idx_diagnosis_messages_upstream` ON `trace_diagnosis_messages` (`workspace_id`(120), `session_id`(120), `opencode_session_id`(120), `seq`);

-- next statement

CREATE TRIGGER `trace_diagnosis_sessions_guard` BEFORE UPDATE ON `trace_diagnosis_sessions` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.session_id <=> OLD.session_id) OR NOT (NEW.trace_id <=> OLD.trace_id) OR NOT (NEW.created_by <=> OLD.created_by) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.next_sequence<OLD.next_sequence OR NEW.turn_fence<OLD.turn_fence OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis session identity or counters immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_sessions_retain` BEFORE DELETE ON `trace_diagnosis_sessions` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis history retained';
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_messages_guard` BEFORE UPDATE ON `trace_diagnosis_messages` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.session_id <=> OLD.session_id) OR NOT (NEW.message_id <=> OLD.message_id) OR NOT (NEW.seq <=> OLD.seq) OR NOT (NEW.request_key <=> OLD.request_key) OR NOT (NEW.request_hash <=> OLD.request_hash) OR NOT (NEW.`role` <=> OLD.`role`) OR NOT (NEW.evidence_hash <=> OLD.evidence_hash) OR NOT (NEW.created_by <=> OLD.created_by) OR NOT (NEW.turn_fence <=> OLD.turn_fence) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR (OLD.`role`='assistant' AND OLD.state<>'streaming') OR (OLD.`role`='user' AND (NOT (NEW.content <=> OLD.content) OR NOT (NEW.content_hash <=> OLD.content_hash) OR NEW.state<>'accepted' OR (OLD.opencode_session_id IS NOT NULL AND NOT (NEW.opencode_session_id <=> OLD.opencode_session_id)))) OR (OLD.`role`='user' AND NOT (NEW.opencode_session_id <=> OLD.opencode_session_id) AND NOT EXISTS (SELECT 1 FROM trace_diagnosis_sessions s WHERE s.workspace_id=OLD.workspace_id AND s.session_id=OLD.session_id AND s.active_request_key=OLD.request_key AND s.turn_fence=OLD.turn_fence)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis message identity or terminal content immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `trace_diagnosis_messages_retain` BEFORE DELETE ON `trace_diagnosis_messages` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis history retained';
END;

-- next statement

CREATE INDEX `idx_diagnosis_messages_workspace_upstream` ON `trace_diagnosis_messages` (`workspace_id`(120), `opencode_session_id`(120), `session_id`(120));

-- next statement

ALTER TABLE `trace_diagnosis_sessions` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `trace_diagnosis_sessions` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `trace_diagnosis_messages` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_diagnosis_sessions` (`_key_1`);

-- next statement

ALTER TABLE `trace_diagnosis_messages` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);
