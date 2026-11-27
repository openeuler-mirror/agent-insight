CREATE TABLE `dataset_generation_jobs` (
  `workspace_id` LONGTEXT NOT NULL,
  `job_id` LONGTEXT NOT NULL,
  `dataset_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `request_id` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `config_hash` LONGTEXT NOT NULL,
  `config_ref` LONGTEXT NOT NULL,
  `members_hash` LONGTEXT NOT NULL,
  `members_ref` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','deleted')),
  `stage` LONGTEXT NOT NULL,
  `stage_index` BIGINT NOT NULL CHECK(stage_index BETWEEN 0 AND 6),
  `generated_count` BIGINT NOT NULL CHECK(generated_count>=0),
  `attempt_count` BIGINT NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  `epoch` BIGINT NOT NULL CHECK(epoch>=0),
  `revision` BIGINT NOT NULL CHECK(revision>=1),
  `dataset_revision` BIGINT NOT NULL CHECK(dataset_revision>=1),
  `dataset_lifecycle_revision` BIGINT NOT NULL CHECK(dataset_lifecycle_revision>=1),
  `lease_owner` LONGTEXT,
  `lease_until_ms` BIGINT,
  `summary_hash` LONGTEXT,
  `summary_ref` LONGTEXT,
  `capture_hash` LONGTEXT,
  `capture_ref` LONGTEXT,
  `result_hash` LONGTEXT,
  `error_code` LONGTEXT,
  `error_message` LONGTEXT,
  `deletion_id` LONGTEXT,
  `created_at_ms` BIGINT NOT NULL CHECK(created_at_ms>=0),
  `updated_at_ms` BIGINT NOT NULL CHECK(updated_at_ms>=created_at_ms),
  CHECK(CHAR_LENGTH(request_hash)=64 AND CHAR_LENGTH(config_hash)=64 AND CHAR_LENGTH(members_hash)=64),
  CHECK((lease_owner IS NULL AND lease_until_ms IS NULL) OR (lease_owner IS NOT NULL AND lease_until_ms IS NOT NULL)),
  CHECK((summary_hash IS NULL AND summary_ref IS NULL) OR (summary_hash IS NOT NULL AND summary_ref IS NOT NULL AND CHAR_LENGTH(summary_hash)=64)),
  CHECK((capture_hash IS NULL AND capture_ref IS NULL) OR (capture_hash IS NOT NULL AND capture_ref IS NOT NULL AND CHAR_LENGTH(capture_hash)=64)),
  CHECK((`status`='running' AND lease_owner IS NOT NULL AND lease_until_ms IS NOT NULL) OR (`status`<>'running' AND lease_owner IS NULL AND lease_until_ms IS NULL)),
  CHECK((`status`='deleted')=(deletion_id IS NOT NULL)),
  CHECK(`status` NOT IN ('succeeded','failed') OR (result_hash IS NOT NULL AND CHAR_LENGTH(result_hash)=64)),
  CHECK(lease_until_ms IS NULL OR lease_until_ms>=0),
  CHECK(CHAR_LENGTH(config_ref)>0 AND CHAR_LENGTH(members_ref)>0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `job_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `dataset_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `actor_principal_id`(120), `request_id`(120)),
  UNIQUE (`_key_4`),
  KEY `_lookup_7` (`workspace_id`(120), `deletion_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `dataset_generation_jobs_set_keys_insert` BEFORE INSERT ON `dataset_generation_jobs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`request_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`request_id`), ':', NEW.`request_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`deletion_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`deletion_id`), ':', NEW.`deletion_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `dataset_generation_jobs_set_keys_update` BEFORE UPDATE ON `dataset_generation_jobs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`request_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`request_id`), ':', NEW.`request_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`deletion_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`deletion_id`), ':', NEW.`deletion_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_dataset_generation_actor` ON `dataset_generation_jobs` (`workspace_id`(120), `actor_principal_id`(120), `status`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `dataset_generation_guard` BEFORE UPDATE ON `dataset_generation_jobs` FOR EACH ROW
BEGIN
  IF NOT (OLD.workspace_id <=> NEW.workspace_id) OR NOT (OLD.job_id <=> NEW.job_id) OR NOT (OLD.dataset_id <=> NEW.dataset_id) OR NOT (OLD.actor_principal_id <=> NEW.actor_principal_id) OR NOT (OLD.request_id <=> NEW.request_id) OR NOT (OLD.request_hash <=> NEW.request_hash) OR NOT (OLD.config_hash <=> NEW.config_hash) OR NOT (OLD.config_ref <=> NEW.config_ref) OR NOT (OLD.members_hash <=> NEW.members_hash) OR NOT (OLD.members_ref <=> NEW.members_ref) OR NOT (OLD.created_at_ms <=> NEW.created_at_ms) OR NOT (OLD.dataset_lifecycle_revision <=> NEW.dataset_lifecycle_revision) OR NEW.revision<>OLD.revision+1 OR NEW.epoch<OLD.epoch OR (OLD.`status` IN ('succeeded','failed','deleted') AND NEW.`status`<>OLD.`status` AND NEW.`status`<>'deleted') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid generation transition';
  END IF;
END;

-- next statement

CREATE TRIGGER `dataset_generation_keep` BEFORE DELETE ON `dataset_generation_jobs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'generation receipts retained';
END;

-- next statement

ALTER TABLE `dataset_generation_jobs` ADD FOREIGN KEY (`_key_2`) REFERENCES `dataset_compat_heads` (`_key_1`);

-- next statement

ALTER TABLE `dataset_generation_jobs` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);
