CREATE TABLE `platform_control_records` (
  `workspace_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `record_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `legacy_username` LONGTEXT NOT NULL,
  `parent_kind` LONGTEXT,
  `parent_id` LONGTEXT,
  `unique_key` LONGTEXT,
  `lookup_hash` LONGTEXT,
  `status` LONGTEXT,
  `expires_at_ms` BIGINT,
  `sort_ms` BIGINT NOT NULL,
  `metadata_json` LONGTEXT NOT NULL,
  `payload_hash` LONGTEXT NOT NULL,
  `payload_ref` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT,
  `state` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (kind IN ('user','skill','skillVersion','config','userSettings','parsedFlow','userGuideState','registeredAgent','evaluation','skillIssue','skillTriggerEvalSet','batchEvalTask','skillGeneratorSession','skillGeneratorMessage','skillOptSession','skillOptPlan','skillOptPlanItem','skillOptMessage','skillOptIteration','skillWorkbenchSession','skillWorkbenchMessage','skillWorkbenchTask','skillOptimizationRecord','skillSnapshotEvaluation','reliabilityInstallToken','reliabilityClient','reliabilityClientCredential','reliabilityCommand','reliabilityClientConfig','reliabilityConfigSnapshot','reliabilityConfigDelivery','reliabilityConfigLoad','skillDeployment','skillDeploymentEvent','faultInjectionTask','faultInjectionRun','faultInjectionWorker','grayscaleTask','debugHistory','debugJobResult','_scope','_receipt')),
  CHECK (CHAR_LENGTH(record_id) BETWEEN 1 AND 1024),
  CHECK (CHAR_LENGTH(legacy_username) BETWEEN 1 AND 512),
  CHECK ((parent_kind IS NULL)=(parent_id IS NULL)),
  CHECK (state IN ('active','deleted')),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (created_at_ms>=0 AND updated_at_ms>=created_at_ms),
  CHECK (CHAR_LENGTH(payload_hash)=64),
  CHECK (CHAR_LENGTH(payload_ref) BETWEEN 1 AND 4096),
  CHECK (lookup_hash IS NULL OR CHAR_LENGTH(lookup_hash)=64),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `kind`(120), `record_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `platform_control_records_set_keys_insert` BEFORE INSERT ON `platform_control_records` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`parent_kind` IS NOT NULL AND NEW.`parent_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`parent_kind`), ':', NEW.`parent_kind`, OCTET_LENGTH(NEW.`parent_id`), ':', NEW.`parent_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`kind` IS NOT NULL AND NEW.`lookup_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`lookup_hash`), ':', NEW.`lookup_hash`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`unique_key` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`unique_key`), ':', NEW.`unique_key`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `platform_control_records_set_keys_update` BEFORE UPDATE ON `platform_control_records` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`record_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`record_id`), ':', NEW.`record_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`parent_kind` IS NOT NULL AND NEW.`parent_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`parent_kind`), ':', NEW.`parent_kind`, OCTET_LENGTH(NEW.`parent_id`), ':', NEW.`parent_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`kind` IS NOT NULL AND NEW.`lookup_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`lookup_hash`), ':', NEW.`lookup_hash`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`unique_key` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`unique_key`), ':', NEW.`unique_key`), 256)), NULL);
END;

-- next statement

CREATE UNIQUE INDEX `uq_control_lookup` ON `platform_control_records` (`_key_6`);

-- next statement

CREATE UNIQUE INDEX `uq_control_unique_active` ON `platform_control_records` (`_key_7`);

-- next statement

CREATE INDEX `idx_control_owner` ON `platform_control_records` (`workspace_id`(120), `kind`(120), `owner_principal_id`(120), `sort_ms`, `record_id`(120));

-- next statement

CREATE INDEX `idx_control_parent` ON `platform_control_records` (`workspace_id`(120), `kind`(120), `parent_kind`(120), `parent_id`(120), `status`(120), `sort_ms`);

-- next statement

CREATE INDEX `idx_control_expiry` ON `platform_control_records` (`workspace_id`(120), `kind`(120), `status`(120), `expires_at_ms`);

-- next statement

CREATE TRIGGER `control_record_update_guard` BEFORE UPDATE ON `platform_control_records` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.kind <=> OLD.kind) OR NOT (NEW.record_id <=> OLD.record_id) OR NOT (NEW.owner_principal_id <=> OLD.owner_principal_id) OR NOT (NEW.legacy_username <=> OLD.legacy_username) OR NOT (NEW.parent_kind <=> OLD.parent_kind) OR NOT (NEW.parent_id <=> OLD.parent_id) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'control identity and revisions are retained';
  END IF;
END;

-- next statement

CREATE TRIGGER `control_record_delete_guard` BEFORE DELETE ON `platform_control_records` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'control history is retained';
END;

-- next statement

ALTER TABLE `platform_control_records` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `platform_control_records` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `platform_control_records` ADD FOREIGN KEY (`_key_4`) REFERENCES `platform_control_records` (`_key_1`);

-- next statement

ALTER TABLE `platform_control_records` ADD FOREIGN KEY (`_key_5`) REFERENCES `asset_identities` (`_key_1`);
