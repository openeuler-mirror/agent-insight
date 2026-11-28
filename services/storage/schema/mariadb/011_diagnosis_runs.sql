CREATE TABLE `diagnosis_runs` (
  `workspace_id` LONGTEXT NOT NULL,
  `diagnosis_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `request_key` LONGTEXT NOT NULL,
  `source_kind` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT,
  `case_id` LONGTEXT,
  `trace_id` LONGTEXT NOT NULL,
  `source_fingerprint` LONGTEXT NOT NULL,
  `input_hash` LONGTEXT NOT NULL,
  `generator` LONGTEXT NOT NULL,
  `snapshot_hash` LONGTEXT NOT NULL,
  `snapshot_ref` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (source_kind IN ('experiment','trace-report')),
  CHECK ((source_kind='experiment' AND experiment_id IS NOT NULL AND case_id IS NOT NULL) OR (source_kind='trace-report' AND experiment_id IS NULL AND case_id IS NULL)),
  CHECK (CHAR_LENGTH(request_key) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(generator) BETWEEN 1 AND 300),
  CHECK (CHAR_LENGTH(snapshot_ref)>0),
  CHECK (created_at_ms>=0),
  CHECK (CHAR_LENGTH(source_fingerprint)=64),
  CHECK (CHAR_LENGTH(input_hash)=64),
  CHECK (CHAR_LENGTH(snapshot_hash)=64),
  CHECK (BINARY source_fingerprint NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY input_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY snapshot_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `diagnosis_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `actor_principal_id`(120), `request_key`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `diagnosis_id`(120), `actor_principal_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `diagnosis_judge_traces` (
  `workspace_id` LONGTEXT NOT NULL,
  `diagnosis_id` LONGTEXT NOT NULL,
  `attempt_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (created_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `diagnosis_runs_set_keys_insert` BEFORE INSERT ON `diagnosis_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnosis_runs_set_keys_update` BEFORE UPDATE ON `diagnosis_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnosis_judge_traces_set_keys_insert` BEFORE INSERT ON `diagnosis_judge_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `diagnosis_judge_traces_set_keys_update` BEFORE UPDATE ON `diagnosis_judge_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`diagnosis_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`diagnosis_id`), ':', NEW.`diagnosis_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_diagnosis_runs_source` ON `diagnosis_runs` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_diagnosis_runs_actor` ON `diagnosis_runs` (`workspace_id`(120), `actor_principal_id`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `diagnosis_runs_immutable` BEFORE UPDATE ON `diagnosis_runs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis identity immutable';
END;

-- next statement

CREATE TRIGGER `diagnosis_runs_retained` BEFORE DELETE ON `diagnosis_runs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis history retained';
END;

-- next statement

CREATE INDEX `idx_diagnosis_judge_traces_run` ON `diagnosis_judge_traces` (`workspace_id`(120), `diagnosis_id`(120), `attempt_id`(120));

-- next statement

CREATE TRIGGER `diagnosis_judge_traces_immutable` BEFORE UPDATE ON `diagnosis_judge_traces` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis identity immutable';
END;

-- next statement

CREATE TRIGGER `diagnosis_judge_traces_retained` BEFORE DELETE ON `diagnosis_judge_traces` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'diagnosis history retained';
END;

-- next statement

ALTER TABLE `diagnosis_runs` ADD FOREIGN KEY (`_key_1`) REFERENCES `runs` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_runs` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_runs` ADD FOREIGN KEY (`_key_5`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_runs` ADD FOREIGN KEY (`_key_6`) REFERENCES `experiment_cases` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_runs` ADD FOREIGN KEY (`_key_7`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_judge_traces` ADD FOREIGN KEY (`_key_2`) REFERENCES `diagnosis_runs` (`_key_3`);

-- next statement

ALTER TABLE `diagnosis_judge_traces` ADD FOREIGN KEY (`_key_3`) REFERENCES `work_attempts` (`_key_1`);

-- next statement

ALTER TABLE `diagnosis_judge_traces` ADD FOREIGN KEY (`_key_1`) REFERENCES `trace_locators` (`_key_1`);
