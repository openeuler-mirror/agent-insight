CREATE TABLE `semantic_scopes` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `domain` LONGTEXT NOT NULL,
  `legacy_username` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 0,
  CHECK(domain IN ('goal','collaboration','usage')),
  CHECK(revision>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `domain`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `semantic_records` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `record_id` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `payload_ref` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'active',
  `revision` BIGINT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK(kind IN ('goalPlusSource','goalPlusGoal','goalPlusRun','goalPlusCandidate','goalPlusIteration','goalPlusAgentSession','goalPlusExecutionLink','goalPlusSemanticSnapshot','collaboration','collaborationEvent','collaborationEndpointResolution','collaborationSessionBinding')),
  CHECK(state IN ('active','deleted')),
  CHECK(CHAR_LENGTH(content_hash)=64 AND revision>0 AND created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `kind`(120), `record_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `semantic_unique_keys` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `constraint_key` LONGTEXT NOT NULL,
  `key_hash` LONGTEXT NOT NULL,
  `record_id` LONGTEXT NOT NULL,
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `kind`(120), `constraint_key`(120), `key_hash`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `usage_event_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `date_key` LONGTEXT NOT NULL,
  `received_at_ms` BIGINT NOT NULL,
  `raw_state` LONGTEXT NOT NULL DEFAULT 'active',
  CHECK(CHAR_LENGTH(content_hash)=64 AND received_at_ms>=0),
  CHECK(raw_state IN ('active','retired')),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `event_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `usage_daily_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `date_key` LONGTEXT NOT NULL,
  `feature_key` LONGTEXT NOT NULL,
  `event_key` LONGTEXT NOT NULL,
  `legacy_username` LONGTEXT NOT NULL,
  `total` BIGINT NOT NULL,
  `first_occurred_ms` BIGINT NOT NULL,
  `last_occurred_ms` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  CHECK(total>=0 AND revision>0 AND first_occurred_ms<=last_occurred_ms AND CHAR_LENGTH(content_hash)=64),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `owner_principal_id`(120), `date_key`(120), `feature_key`(120), `event_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `semantic_scopes_set_keys_insert` BEFORE INSERT ON `semantic_scopes` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`domain` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`domain`), ':', NEW.`domain`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `semantic_scopes_set_keys_update` BEFORE UPDATE ON `semantic_scopes` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`domain` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`domain`), ':', NEW.`domain`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `semantic_records_set_keys_insert` BEFORE INSERT ON `semantic_records` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `semantic_records_set_keys_update` BEFORE UPDATE ON `semantic_records` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `semantic_unique_keys_set_keys_insert` BEFORE INSERT ON `semantic_unique_keys` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`constraint_key` IS NOT NULL AND NEW.`key_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`constraint_key`), ':', NEW.`constraint_key`, OCTET_LENGTH(NEW.`key_hash`), ':', NEW.`key_hash`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `semantic_unique_keys_set_keys_update` BEFORE UPDATE ON `semantic_unique_keys` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`constraint_key` IS NOT NULL AND NEW.`key_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`constraint_key`), ':', NEW.`constraint_key`, OCTET_LENGTH(NEW.`key_hash`), ':', NEW.`key_hash`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `usage_event_receipts_set_keys_insert` BEFORE INSERT ON `usage_event_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `usage_event_receipts_set_keys_update` BEFORE UPDATE ON `usage_event_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `usage_daily_heads_set_keys_insert` BEFORE INSERT ON `usage_daily_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`date_key` IS NOT NULL AND NEW.`feature_key` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`date_key`), ':', NEW.`date_key`, OCTET_LENGTH(NEW.`feature_key`), ':', NEW.`feature_key`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `usage_daily_heads_set_keys_update` BEFORE UPDATE ON `usage_daily_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`date_key` IS NOT NULL AND NEW.`feature_key` IS NOT NULL AND NEW.`event_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`date_key`), ':', NEW.`date_key`, OCTET_LENGTH(NEW.`feature_key`), ':', NEW.`feature_key`, OCTET_LENGTH(NEW.`event_key`), ':', NEW.`event_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_semantic_scope` ON `semantic_records` (`workspace_id`(120), `owner_principal_id`(120), `kind`(120), `state`(120), `record_id`(120));

-- next statement

CREATE INDEX `idx_usage_receipt_cleanup` ON `usage_event_receipts` (`workspace_id`(120), `owner_principal_id`(120), `raw_state`(120), `date_key`(120), `event_id`(120));

-- next statement

CREATE INDEX `idx_usage_daily_scope` ON `usage_daily_heads` (`workspace_id`(120), `date_key`(120), `feature_key`(120), `owner_principal_id`(120));

-- next statement

ALTER TABLE `semantic_scopes` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `semantic_scopes` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `semantic_records` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `semantic_records` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `semantic_unique_keys` ADD FOREIGN KEY (`_key_2`) REFERENCES `semantic_records` (`_key_1`);

-- next statement

ALTER TABLE `usage_event_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `usage_event_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `usage_daily_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `usage_daily_heads` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);
