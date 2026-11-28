CREATE TABLE `trace_legacy_ids` (
  `workspace_id` LONGTEXT NOT NULL,
  `alias_kind` LONGTEXT NOT NULL,
  `alias_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (alias_kind IN ('task','execution')),
  CHECK (CHAR_LENGTH(alias_id)>0),
  CHECK (created_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `alias_kind`(120), `alias_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `trace_annotations` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `label` LONGTEXT,
  `query_override` LONGTEXT,
  `final_result_override` LONGTEXT,
  `feedback_json` LONGTEXT,
  `extra_json` LONGTEXT NOT NULL DEFAULT '{}',
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(extra_json)>0),
  CHECK (feedback_json IS NULL OR CHAR_LENGTH(feedback_json)>0),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `trace_tags` (
  `workspace_id` LONGTEXT NOT NULL,
  `tag_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `description` LONGTEXT,
  `color` LONGTEXT NOT NULL DEFAULT '#6366f1',
  `revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(tag_id)>0),
  CHECK (kind IN ('version','business')),
  CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 80),
  CHECK (name=trim(name)),
  CHECK (description IS NULL OR CHAR_LENGTH(description)<=300),
  CHECK (CHAR_LENGTH(color)=7),
  CHECK (substr(color,1,1)='#'),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (BINARY substr(color,2) NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `tag_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `owner_principal_id`(120), `kind`(120), `name`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `trace_tag_links` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `tag_id` LONGTEXT NOT NULL,
  `created_by` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (created_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120), `tag_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `trace_legacy_ids_set_keys_insert` BEFORE INSERT ON `trace_legacy_ids` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`alias_kind` IS NOT NULL AND NEW.`alias_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`alias_kind`), ':', NEW.`alias_kind`, OCTET_LENGTH(NEW.`alias_id`), ':', NEW.`alias_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_legacy_ids_set_keys_update` BEFORE UPDATE ON `trace_legacy_ids` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`alias_kind` IS NOT NULL AND NEW.`alias_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`alias_kind`), ':', NEW.`alias_kind`, OCTET_LENGTH(NEW.`alias_id`), ':', NEW.`alias_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_annotations_set_keys_insert` BEFORE INSERT ON `trace_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_annotations_set_keys_update` BEFORE UPDATE ON `trace_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_tags_set_keys_insert` BEFORE INSERT ON `trace_tags` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_tags_set_keys_update` BEFORE UPDATE ON `trace_tags` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_tag_links_set_keys_insert` BEFORE INSERT ON `trace_tag_links` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_tag_links_set_keys_update` BEFORE UPDATE ON `trace_tag_links` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`tag_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`tag_id`), ':', NEW.`tag_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_trace_legacy_ids_trace` ON `trace_legacy_ids` (`workspace_id`(120), `trace_id`(120), `alias_kind`(120), `created_at_ms`, `alias_id`(120));

-- next statement

CREATE INDEX `idx_trace_tags_kind` ON `trace_tags` (`workspace_id`(120), `kind`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_trace_tag_links_tag` ON `trace_tag_links` (`workspace_id`(120), `tag_id`(120), `trace_id`(120));

-- next statement

CREATE TRIGGER `trace_legacy_ids_no_update` BEFORE UPDATE ON `trace_legacy_ids` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy Trace identity mapping immutable';
END;

-- next statement

CREATE TRIGGER `trace_legacy_ids_no_delete` BEFORE DELETE ON `trace_legacy_ids` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy Trace identity mapping retained';
END;

-- next statement

ALTER TABLE `trace_legacy_ids` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `trace_annotations` ADD FOREIGN KEY (`_key_1`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `trace_tags` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `trace_tags` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `trace_tag_links` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `trace_tag_links` ADD FOREIGN KEY (`_key_3`) REFERENCES `trace_tags` (`_key_1`);

-- next statement

ALTER TABLE `trace_tag_links` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);
