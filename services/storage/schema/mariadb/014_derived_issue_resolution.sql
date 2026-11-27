CREATE TABLE `experiment_derived_issue_annotations` (
  `workspace_id` LONGTEXT NOT NULL,
  `annotation_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `issue_id` LONGTEXT NOT NULL,
  `machine_result_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `resolved_run_id` LONGTEXT NOT NULL,
  `resolved_at_ms` BIGINT NOT NULL,
  `operation_kind` LONGTEXT NOT NULL,
  `operation_key` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `issue_payload_hash` LONGTEXT NOT NULL,
  `machine_content_hash` LONGTEXT NOT NULL,
  `selection_revision` BIGINT NOT NULL,
  CHECK (operation_kind='derived_issue_resolve'),
  CHECK (CHAR_LENGTH(annotation_id)>0),
  CHECK (CHAR_LENGTH(resolved_run_id) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(operation_key)>0),
  CHECK (resolved_at_ms>=0 AND resolved_at_ms<=9223372036854775807),
  CHECK (selection_revision>0 AND selection_revision<=9223372036854775807),
  CHECK (CHAR_LENGTH(request_hash)=64),
  CHECK (CHAR_LENGTH(issue_payload_hash)=64),
  CHECK (CHAR_LENGTH(machine_content_hash)=64),
  CHECK (BINARY request_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY issue_payload_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY machine_content_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  `_key_8` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `annotation_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `actor_principal_id`(120), `operation_key`(120), `issue_id`(120)),
  UNIQUE (`_key_3`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `experiment_derived_issue_annotations_set_keys_insert` BEFORE INSERT ON `experiment_derived_issue_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_key` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`machine_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`machine_result_id`), ':', NEW.`machine_result_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_derived_issue_annotations_set_keys_update` BEFORE UPDATE ON `experiment_derived_issue_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_key` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`issue_id`), ':', NEW.`issue_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`machine_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`machine_result_id`), ':', NEW.`machine_result_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_derived_issue_resolution_1` ON `experiment_derived_issue_annotations` (`workspace_id`(120), `issue_id`(120), `resolved_at_ms`, `annotation_id`(120));

-- next statement

CREATE TRIGGER `derived_issue_resolution_update_guard` BEFORE UPDATE ON `experiment_derived_issue_annotations` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'derived issue annotations are immutable';
END;

-- next statement

CREATE TRIGGER `derived_issue_resolution_delete_guard` BEFORE DELETE ON `experiment_derived_issue_annotations` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'derived issue annotation history is retained';
END;

-- next statement

ALTER TABLE `experiment_derived_issue_annotations` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_annotations` (`_key_3`);

-- next statement

ALTER TABLE `experiment_derived_issue_annotations` ADD FOREIGN KEY (`_key_5`) REFERENCES `result_receipts` (`_key_3`);

-- next statement

ALTER TABLE `experiment_derived_issue_annotations` ADD FOREIGN KEY (`_key_6`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_derived_issue_annotations` ADD FOREIGN KEY (`_key_7`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_derived_issue_annotations` ADD FOREIGN KEY (`_key_8`) REFERENCES `experiment_operation_receipts` (`_key_1`);
