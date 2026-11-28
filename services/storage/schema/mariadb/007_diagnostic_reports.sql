CREATE TABLE `diagnostic_report_runs` (
  `workspace_id` LONGTEXT NOT NULL,
  `report_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `request_key` LONGTEXT,
  `execution_id` LONGTEXT NOT NULL,
  `interactions_hash` LONGTEXT NOT NULL,
  `generator` LONGTEXT NOT NULL,
  `scope_fingerprint` LONGTEXT NOT NULL,
  `evidence_hash` LONGTEXT NOT NULL,
  `evidence_ref` LONGTEXT NOT NULL,
  `lease_secret_hash` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'running',
  `payload_hash` LONGTEXT,
  `payload_ref` LONGTEXT,
  `progress_hash` LONGTEXT,
  `progress_ref` LONGTEXT,
  `error_message` LONGTEXT,
  `lease_until_ms` BIGINT,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (kind IN ('agent-debug','skills-analysis')),
  CHECK (`status` IN ('running','done','failed','skipped')),
  CHECK (CHAR_LENGTH(report_id)>0),
  CHECK (interactions_hash IS NULL OR (BINARY interactions_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (evidence_hash IS NULL OR (BINARY evidence_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (lease_secret_hash IS NULL OR (BINARY lease_secret_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (payload_hash IS NULL OR (BINARY payload_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (progress_hash IS NULL OR (BINARY progress_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (CHAR_LENGTH(execution_id)>0),
  CHECK (CHAR_LENGTH(generator) BETWEEN 1 AND 300),
  CHECK (request_key IS NULL OR CHAR_LENGTH(request_key) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(interactions_hash)=64),
  CHECK (CHAR_LENGTH(evidence_hash)=64),
  CHECK (CHAR_LENGTH(lease_secret_hash)=64),
  CHECK (CHAR_LENGTH(scope_fingerprint)>0),
  CHECK (CHAR_LENGTH(evidence_ref)>0),
  CHECK ((payload_hash IS NULL AND payload_ref IS NULL) OR (payload_hash IS NOT NULL AND payload_ref IS NOT NULL AND CHAR_LENGTH(payload_hash)=64 AND CHAR_LENGTH(payload_ref)>0)),
  CHECK ((progress_hash IS NULL AND progress_ref IS NULL) OR (progress_hash IS NOT NULL AND progress_ref IS NOT NULL AND CHAR_LENGTH(progress_hash)=64 AND CHAR_LENGTH(progress_ref)>0)),
  CHECK (`status` NOT IN ('done','skipped') OR payload_ref IS NOT NULL),
  CHECK (error_message IS NULL OR CHAR_LENGTH(error_message)<=2000),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (lease_until_ms IS NULL OR lease_until_ms>=created_at_ms),
  CHECK (`status`<>'running' OR lease_until_ms IS NOT NULL),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `report_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `trace_id`(120), `kind`(120), `report_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `actor_principal_id`(120), `kind`(120), `request_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `diagnostic_report_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `report_id` LONGTEXT NOT NULL,
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120), `kind`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `diagnostic_report_runs_set_keys_insert` BEFORE INSERT ON `diagnostic_report_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnostic_report_runs_set_keys_update` BEFORE UPDATE ON `diagnostic_report_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnostic_report_heads_set_keys_insert` BEFORE INSERT ON `diagnostic_report_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnostic_report_heads_set_keys_update` BEFORE UPDATE ON `diagnostic_report_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`report_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`report_id`), ':', NEW.`report_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_diagnostic_report_runs_trace` ON `diagnostic_report_runs` (`workspace_id`(120), `trace_id`(120), `kind`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `diagnostic_report_runs_immutable` BEFORE UPDATE ON `diagnostic_report_runs` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.report_id <=> OLD.report_id) OR NOT (NEW.trace_id <=> OLD.trace_id) OR NOT (NEW.kind <=> OLD.kind) OR NOT (NEW.actor_principal_id <=> OLD.actor_principal_id) OR NOT (NEW.request_key <=> OLD.request_key) OR NOT (NEW.execution_id <=> OLD.execution_id) OR NOT (NEW.interactions_hash <=> OLD.interactions_hash) OR NOT (NEW.generator <=> OLD.generator) OR NOT (NEW.scope_fingerprint <=> OLD.scope_fingerprint) OR NOT (NEW.evidence_hash <=> OLD.evidence_hash) OR NOT (NEW.evidence_ref <=> OLD.evidence_ref) OR NOT (NEW.lease_secret_hash <=> OLD.lease_secret_hash) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR OLD.`status`<>'running' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnostic report immutable or invalid revision';
  END IF;
END;

-- next statement

CREATE TRIGGER `diagnostic_report_runs_no_delete` BEFORE DELETE ON `diagnostic_report_runs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnostic report history retained';
END;

-- next statement

CREATE TRIGGER `diagnostic_report_heads_key_immutable` BEFORE UPDATE ON `diagnostic_report_heads` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.trace_id <=> OLD.trace_id) OR NOT (NEW.kind <=> OLD.kind) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnostic report head key immutable';
  END IF;
END;

-- next statement

ALTER TABLE `diagnostic_report_runs` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `diagnostic_report_runs` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `diagnostic_report_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `diagnostic_report_runs` (`_key_2`);
