CREATE TABLE `dataset_compat_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `dataset_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `draft_id` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `manifest_hash` LONGTEXT NOT NULL,
  `manifest_ref` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'active',
  `revision` BIGINT NOT NULL DEFAULT 1,
  `lifecycle_revision` BIGINT NOT NULL DEFAULT 1,
  `read_only` BIGINT NOT NULL DEFAULT 0,
  `generation_source` LONGTEXT,
  `generation_status` LONGTEXT,
  `created_by` LONGTEXT NOT NULL,
  `deleted_by` LONGTEXT,
  `deleted_at_ms` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (state IN ('active','deleted')),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (lifecycle_revision BETWEEN 1 AND 9223372036854775807),
  CHECK (read_only IN (0,1)),
  CHECK (CHAR_LENGTH(manifest_hash)=64 AND BINARY manifest_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(dataset_id)>0 AND CHAR_LENGTH(manifest_ref)>0),
  CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  CHECK ((state='active' AND deleted_by IS NULL AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_by IS NOT NULL AND deleted_at_ms IS NOT NULL AND deleted_at_ms>=0)),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `dataset_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `asset_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `draft_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `dataset_operation_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `operation_kind` LONGTEXT NOT NULL,
  `operation_key` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `dataset_id` LONGTEXT NOT NULL,
  `response_hash` LONGTEXT NOT NULL,
  `response_ref` LONGTEXT NOT NULL,
  `response_meta_json` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(request_hash)=64 AND BINARY request_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(response_hash)=64 AND BINARY response_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(operation_kind)>0 AND CHAR_LENGTH(operation_key)>0 AND CHAR_LENGTH(response_ref)>0 AND CHAR_LENGTH(response_meta_json)>0),
  CHECK (created_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `actor_principal_id`(120), `operation_kind`(120), `operation_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `dataset_compat_heads_set_keys_insert` BEFORE INSERT ON `dataset_compat_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`draft_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`draft_id`), ':', NEW.`draft_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`deleted_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`deleted_by`), ':', NEW.`deleted_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `dataset_compat_heads_set_keys_update` BEFORE UPDATE ON `dataset_compat_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`draft_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`draft_id`), ':', NEW.`draft_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`deleted_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`deleted_by`), ':', NEW.`deleted_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `dataset_operation_receipts_set_keys_insert` BEFORE INSERT ON `dataset_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `dataset_operation_receipts_set_keys_update` BEFORE UPDATE ON `dataset_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_dataset_heads_state` ON `dataset_compat_heads` (`workspace_id`(120), `state`(120), `updated_at_ms`, `dataset_id`(120));

-- next statement

CREATE INDEX `idx_dataset_receipts_dataset` ON `dataset_operation_receipts` (`workspace_id`(120), `dataset_id`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `dataset_head_asset_guard` BEFORE INSERT ON `dataset_compat_heads` FOR EACH ROW
BEGIN
  IF NOT EXISTS(SELECT 1 FROM asset_identities a JOIN asset_drafts d ON d.workspace_id=a.workspace_id AND d.asset_id=a.asset_id WHERE a.workspace_id=NEW.workspace_id AND a.asset_id=NEW.asset_id AND a.kind='dataset' AND d.draft_id=NEW.draft_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dataset asset/draft mismatch';
  END IF;
END;

-- next statement

CREATE TRIGGER `dataset_head_update_guard` BEFORE UPDATE ON `dataset_compat_heads` FOR EACH ROW
BEGIN
  IF OLD.workspace_id<>NEW.workspace_id OR OLD.dataset_id<>NEW.dataset_id OR OLD.asset_id<>NEW.asset_id OR OLD.draft_id<>NEW.draft_id OR OLD.created_by<>NEW.created_by OR OLD.created_at_ms<>NEW.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.read_only<OLD.read_only OR (OLD.state<>NEW.state AND NEW.lifecycle_revision<>OLD.lifecycle_revision+1) OR (OLD.state=NEW.state AND NEW.lifecycle_revision<>OLD.lifecycle_revision) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dataset identity/revision immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `dataset_heads_no_delete` BEFORE DELETE ON `dataset_compat_heads` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dataset ledger retained immutable';
END;

-- next statement

CREATE TRIGGER `dataset_receipts_no_update` BEFORE UPDATE ON `dataset_operation_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dataset ledger retained immutable';
END;

-- next statement

CREATE TRIGGER `dataset_receipts_no_delete` BEFORE DELETE ON `dataset_operation_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dataset ledger retained immutable';
END;

-- next statement

ALTER TABLE `dataset_compat_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `asset_identities` (`_key_1`);

-- next statement

ALTER TABLE `dataset_compat_heads` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_drafts` (`_key_1`);

-- next statement

ALTER TABLE `dataset_compat_heads` ADD FOREIGN KEY (`_key_4`) REFERENCES `asset_release_seals` (`_key_2`);

-- next statement

ALTER TABLE `dataset_compat_heads` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `dataset_compat_heads` ADD FOREIGN KEY (`_key_6`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `dataset_operation_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `dataset_compat_heads` (`_key_1`);

-- next statement

ALTER TABLE `dataset_operation_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);
