CREATE TABLE `collector_preparation_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `scope_kind` LONGTEXT NOT NULL,
  `scope_key` LONGTEXT NOT NULL,
  `operation_key` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT,
  `operation_kind` LONGTEXT NOT NULL,
  `input_hash` LONGTEXT NOT NULL,
  `input_text_hash` LONGTEXT NOT NULL,
  `input_text_ref` LONGTEXT NOT NULL,
  `context_hash` LONGTEXT NOT NULL,
  `context_ref` LONGTEXT NOT NULL,
  `capture_hash` LONGTEXT,
  `capture_ref` LONGTEXT,
  `plan_hash` LONGTEXT,
  `plan_ref` LONGTEXT,
  `seal_revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (scope_kind IN ('source','thread')),
  CHECK (CHAR_LENGTH(scope_key) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(operation_key) BETWEEN 1 AND 512),
  CHECK (operation_kind IN ('snapshot','complete','thread_only')),
  CHECK ((scope_kind='source' AND trace_id IS NOT NULL AND scope_key=trace_id AND operation_kind IN ('snapshot','complete')) OR (scope_kind='thread' AND trace_id IS NULL AND operation_kind='thread_only')),
  CHECK ((capture_hash IS NULL)=(capture_ref IS NULL)),
  CHECK ((plan_hash IS NULL)=(plan_ref IS NULL)),
  CHECK (plan_hash IS NULL OR capture_hash IS NOT NULL),
  CHECK (CHAR_LENGTH(input_hash)=64 AND BINARY input_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(input_text_hash)=64 AND BINARY input_text_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (CHAR_LENGTH(context_hash)=64 AND BINARY context_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (capture_hash IS NULL OR (CHAR_LENGTH(capture_hash)=64 AND BINARY capture_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (plan_hash IS NULL OR (CHAR_LENGTH(plan_hash)=64 AND BINARY plan_hash NOT REGEXP '[^0-9a-f]')),
  CHECK (input_text_ref IS NULL OR CHAR_LENGTH(input_text_ref) BETWEEN 1 AND 4096),
  CHECK (context_ref IS NULL OR CHAR_LENGTH(context_ref) BETWEEN 1 AND 4096),
  CHECK (capture_ref IS NULL OR CHAR_LENGTH(capture_ref) BETWEEN 1 AND 4096),
  CHECK (plan_ref IS NULL OR CHAR_LENGTH(plan_ref) BETWEEN 1 AND 4096),
  CHECK (seal_revision>=1 AND seal_revision<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (seal_revision=1+(CASE WHEN capture_hash IS NULL THEN 0 ELSE 1 END)+(CASE WHEN plan_hash IS NULL THEN 0 ELSE 1 END)),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `scope_kind`(120), `scope_key`(120), `operation_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `collector_preparation_receipts_set_keys_insert` BEFORE INSERT ON `collector_preparation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`scope_kind` IS NOT NULL AND NEW.`scope_key` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`scope_kind`), ':', NEW.`scope_kind`, OCTET_LENGTH(NEW.`scope_key`), ':', NEW.`scope_key`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `collector_preparation_receipts_set_keys_update` BEFORE UPDATE ON `collector_preparation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`scope_kind` IS NOT NULL AND NEW.`scope_key` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`scope_kind`), ':', NEW.`scope_kind`, OCTET_LENGTH(NEW.`scope_key`), ':', NEW.`scope_key`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_collector_preparation_owner` ON `collector_preparation_receipts` (`workspace_id`(120), `owner_principal_id`(120), `created_at_ms`, `scope_kind`(120), `scope_key`(120));

-- next statement

CREATE TRIGGER `collector_preparation_update_guard` BEFORE UPDATE ON `collector_preparation_receipts` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.scope_kind <=> OLD.scope_kind) OR NOT (NEW.scope_key <=> OLD.scope_key) OR NOT (NEW.operation_key <=> OLD.operation_key) OR NOT (NEW.owner_principal_id <=> OLD.owner_principal_id) OR NOT (NEW.trace_id <=> OLD.trace_id) OR NOT (NEW.operation_kind <=> OLD.operation_kind) OR NOT (NEW.input_hash <=> OLD.input_hash) OR NOT (NEW.input_text_hash <=> OLD.input_text_hash) OR NOT (NEW.input_text_ref <=> OLD.input_text_ref) OR NOT (NEW.context_hash <=> OLD.context_hash) OR NOT (NEW.context_ref <=> OLD.context_ref) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR (OLD.capture_hash IS NOT NULL AND (NOT (NEW.capture_hash <=> OLD.capture_hash) OR NOT (NEW.capture_ref <=> OLD.capture_ref))) OR (OLD.plan_hash IS NOT NULL AND (NOT (NEW.plan_hash <=> OLD.plan_hash) OR NOT (NEW.plan_ref <=> OLD.plan_ref))) OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.seal_revision<>OLD.seal_revision+1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'collector preparation identity and sealed slots are immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `collector_preparation_delete_guard` BEFORE DELETE ON `collector_preparation_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'collector preparation history is retained';
END;

-- next statement

ALTER TABLE `collector_preparation_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `collector_preparation_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `collector_preparation_receipts` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_locators` (`_key_1`);
