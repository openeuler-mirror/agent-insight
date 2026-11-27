CREATE TABLE `ingest_batches` (
  `workspace_id` LONGTEXT NOT NULL,
  `batch_id` LONGTEXT NOT NULL,
  `principal_id` LONGTEXT NOT NULL,
  `receipt_key` LONGTEXT NOT NULL,
  `packet_hash` LONGTEXT NOT NULL,
  `packet_ref` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'accepted',
  `plan_ref` LONGTEXT,
  `trace_ids_json` LONGTEXT NOT NULL,
  `accepted_at_ms` BIGINT NOT NULL,
  `indexed_at_ms` BIGINT,
  `error_code` LONGTEXT,
  CHECK (CHAR_LENGTH(batch_id)>0),
  CHECK (CHAR_LENGTH(receipt_key) BETWEEN 1 AND 512),
  CHECK (CHAR_LENGTH(packet_hash)=64),
  CHECK (CHAR_LENGTH(packet_ref)>0),
  CHECK (state IN ('accepted','prepared','indexed','failed')),
  CHECK (plan_ref IS NULL OR CHAR_LENGTH(plan_ref)>0),
  CHECK (CHAR_LENGTH(trace_ids_json)>0),
  CHECK (accepted_at_ms>=0),
  CHECK (indexed_at_ms IS NULL OR indexed_at_ms>=accepted_at_ms),
  CHECK (state<>'prepared' OR plan_ref IS NOT NULL),
  CHECK (state<>'indexed' OR (plan_ref IS NOT NULL AND indexed_at_ms IS NOT NULL)),
  CHECK (BINARY packet_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `batch_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `principal_id`(120), `receipt_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `obs_entity_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `entity_kind` LONGTEXT NOT NULL,
  `entity_id` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `source_revision` BIGINT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `artifact_ref` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (entity_kind IN ('trace','span')),
  CHECK (CHAR_LENGTH(entity_id)>0),
  CHECK (revision BETWEEN 1 AND 9223372036854775807),
  CHECK (source_revision BETWEEN 1 AND 9223372036854775807),
  CHECK (CHAR_LENGTH(content_hash)=64),
  CHECK (CHAR_LENGTH(artifact_ref)>0),
  CHECK (created_at_ms>=0),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (entity_kind<>'trace' OR entity_id=trace_id),
  CHECK (BINARY content_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120), `entity_kind`(120), `entity_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `ingest_batches_set_keys_insert` BEFORE INSERT ON `ingest_batches` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`principal_id` IS NOT NULL AND NEW.`receipt_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`, OCTET_LENGTH(NEW.`receipt_key`), ':', NEW.`receipt_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_batches_set_keys_update` BEFORE UPDATE ON `ingest_batches` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`principal_id` IS NOT NULL AND NEW.`receipt_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`, OCTET_LENGTH(NEW.`receipt_key`), ':', NEW.`receipt_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `obs_entity_heads_set_keys_insert` BEFORE INSERT ON `obs_entity_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`entity_kind` IS NOT NULL AND NEW.`entity_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`entity_kind`), ':', NEW.`entity_kind`, OCTET_LENGTH(NEW.`entity_id`), ':', NEW.`entity_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `obs_entity_heads_set_keys_update` BEFORE UPDATE ON `obs_entity_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL AND NEW.`entity_kind` IS NOT NULL AND NEW.`entity_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`, OCTET_LENGTH(NEW.`entity_kind`), ':', NEW.`entity_kind`, OCTET_LENGTH(NEW.`entity_id`), ':', NEW.`entity_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_ingest_batches_actor` ON `ingest_batches` (`workspace_id`(120), `principal_id`(120), `accepted_at_ms`);

-- next statement

CREATE INDEX `idx_ingest_batches_state` ON `ingest_batches` (`state`(120), `accepted_at_ms`);

-- next statement

CREATE TRIGGER `ingest_batches_ledger_guard` BEFORE UPDATE ON `ingest_batches` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.batch_id <=> OLD.batch_id) OR NOT (NEW.principal_id <=> OLD.principal_id) OR NOT (NEW.receipt_key <=> OLD.receipt_key) OR NOT (NEW.packet_hash <=> OLD.packet_hash) OR NOT (NEW.packet_ref <=> OLD.packet_ref) OR NOT (NEW.trace_ids_json <=> OLD.trace_ids_json) OR NOT (NEW.accepted_at_ms <=> OLD.accepted_at_ms) OR (OLD.plan_ref IS NOT NULL AND NOT (NEW.plan_ref <=> OLD.plan_ref)) OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','indexed','failed')) OR (OLD.state IN ('indexed','failed') AND (NEW.state<>OLD.state OR NOT (NEW.indexed_at_ms <=> OLD.indexed_at_ms) OR NOT (NEW.error_code <=> OLD.error_code))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'observation ledger immutable or stale';
  END IF;
END;

-- next statement

CREATE TRIGGER `ingest_batches_retain` BEFORE DELETE ON `ingest_batches` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'observation ledger retained';
END;

-- next statement

CREATE TRIGGER `obs_entity_heads_ledger_guard` BEFORE UPDATE ON `obs_entity_heads` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.trace_id <=> OLD.trace_id) OR NOT (NEW.entity_kind <=> OLD.entity_kind) OR NOT (NEW.entity_id <=> OLD.entity_id) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.source_revision<OLD.source_revision OR (OLD.entity_kind='span' AND NEW.source_revision<=OLD.source_revision) OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'observation ledger immutable or stale';
  END IF;
END;

-- next statement

CREATE TRIGGER `obs_entity_heads_retain` BEFORE DELETE ON `obs_entity_heads` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'observation ledger retained';
END;

-- next statement

ALTER TABLE `ingest_batches` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `ingest_batches` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `obs_entity_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `trace_locators` (`_key_1`);
