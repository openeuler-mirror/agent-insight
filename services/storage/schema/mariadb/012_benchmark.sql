CREATE TABLE `benchmark_dataset_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `dataset_id` LONGTEXT NOT NULL,
  `public_dataset_id` LONGTEXT NOT NULL,
  `public_asset_id` LONGTEXT NOT NULL,
  `public_release_id` LONGTEXT NOT NULL,
  `private_asset_id` LONGTEXT NOT NULL,
  `private_release_id` LONGTEXT NOT NULL,
  `adapter_key` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `lifecycle_revision` BIGINT NOT NULL,
  `created_by` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (state IN ('active','deleted')),
  CHECK (CHAR_LENGTH(adapter_key)>0),
  CHECK (public_asset_id<>private_asset_id),
  CHECK (CHAR_LENGTH(content_hash)=64),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (lifecycle_revision>=1 AND lifecycle_revision<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK (BINARY content_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `dataset_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `public_dataset_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `private_asset_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `benchmark_experiment_bindings` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `dataset_id` LONGTEXT NOT NULL,
  `public_release_id` LONGTEXT NOT NULL,
  `private_release_id` LONGTEXT NOT NULL,
  `binding_hash` LONGTEXT NOT NULL,
  `binding_ref` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(binding_hash)=64),
  CHECK (CHAR_LENGTH(binding_ref)>0),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (BINARY binding_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `experiment_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `benchmark_jobs` (
  `workspace_id` LONGTEXT NOT NULL,
  `job_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `case_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `work_item_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `parent_job_id` LONGTEXT,
  `adapter_key` LONGTEXT NOT NULL,
  `evaluator_key` LONGTEXT,
  `attempt_no` BIGINT NOT NULL,
  `retry_of_job_id` LONGTEXT,
  `origin_credential_id` LONGTEXT NOT NULL,
  `origin_credential_kind` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `protocol_state` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `request_hash` LONGTEXT,
  `request_ref` LONGTEXT,
  `progress_hash` LONGTEXT,
  `progress_ref` LONGTEXT,
  `completion_hash` LONGTEXT,
  `completion_ref` LONGTEXT,
  `callback_epoch` BIGINT NOT NULL,
  `callback_token_hash` LONGTEXT,
  `callback_expires_ms` BIGINT,
  `callback_attempt_id` LONGTEXT,
  `callback_fence` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (kind IN ('execute','evaluate')),
  CHECK (origin_credential_kind IN ('api','session')),
  CHECK (protocol_state IN ('pending','preparing','dispatching','dispatch_unknown','running_agent','collecting','uploading','cleaning','submitted','queued','running_evaluator','normalizing','normalization_failed','completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid')),
  CHECK ((kind='execute' AND parent_job_id IS NULL) OR (kind='evaluate' AND parent_job_id IS NOT NULL)),
  CHECK ((callback_token_hash IS NULL AND callback_expires_ms IS NULL AND callback_attempt_id IS NULL AND callback_fence IS NULL) OR (callback_token_hash IS NOT NULL AND callback_expires_ms IS NOT NULL AND callback_attempt_id IS NOT NULL AND callback_fence IS NOT NULL)),
  CHECK (parent_job_id IS NULL OR parent_job_id<>job_id),
  CHECK (retry_of_job_id IS NULL OR retry_of_job_id<>job_id),
  CHECK (attempt_no>=1 AND attempt_no<=9223372036854775807),
  CHECK (revision>=1 AND revision<=9223372036854775807),
  CHECK (CHAR_LENGTH(request_hash)=64),
  CHECK (CHAR_LENGTH(request_ref)>0),
  CHECK (CHAR_LENGTH(progress_hash)=64),
  CHECK (CHAR_LENGTH(progress_ref)>0),
  CHECK (CHAR_LENGTH(completion_hash)=64),
  CHECK (CHAR_LENGTH(completion_ref)>0),
  CHECK (callback_epoch>=0 AND callback_epoch<=9223372036854775807),
  CHECK (CHAR_LENGTH(callback_token_hash)=64),
  CHECK (callback_expires_ms>=0 AND callback_expires_ms<=9223372036854775807),
  CHECK (callback_fence>=1 AND callback_fence<=9223372036854775807),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=0 AND updated_at_ms<=9223372036854775807),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK ((request_hash IS NULL)=(request_ref IS NULL)),
  CHECK ((progress_hash IS NULL)=(progress_ref IS NULL)),
  CHECK ((completion_hash IS NULL)=(completion_ref IS NULL)),
  CHECK (BINARY request_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY progress_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY completion_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY callback_token_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  `_key_8` BINARY(32) INVISIBLE,
  `_key_9` BINARY(32) INVISIBLE,
  `_key_10` BINARY(32) INVISIBLE,
  `_key_11` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `job_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `job_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `parent_job_id`(120), `attempt_no`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `benchmark_artifacts` (
  `workspace_id` LONGTEXT NOT NULL,
  `job_id` LONGTEXT NOT NULL,
  `artifact_id` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `media_type` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `storage_hash` LONGTEXT NOT NULL,
  `storage_ref` LONGTEXT NOT NULL,
  `contract_hash` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 512),
  CONSTRAINT benchmark_artifacts_size_bounds CHECK (size_bytes BETWEEN 1 AND 67108864),
  CHECK (CHAR_LENGTH(media_type) BETWEEN 1 AND 256),
  CHECK (CHAR_LENGTH(content_hash)=64),
  CHECK (size_bytes>=0 AND size_bytes<=9223372036854775807),
  CHECK (CHAR_LENGTH(storage_hash)=64),
  CHECK (CHAR_LENGTH(storage_ref)>0),
  CHECK (CHAR_LENGTH(contract_hash)=64),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (BINARY content_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY storage_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY contract_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `artifact_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `job_id`(120), `name`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `benchmark_operation_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `operation_kind` LONGTEXT NOT NULL,
  `operation_key` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT,
  `dataset_id` LONGTEXT,
  `job_id` LONGTEXT,
  `response_hash` LONGTEXT NOT NULL,
  `response_ref` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(operation_kind) BETWEEN 1 AND 128),
  CHECK (CHAR_LENGTH(operation_key) BETWEEN 1 AND 512),
  CHECK ((CASE WHEN experiment_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN dataset_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN job_id IS NOT NULL THEN 1 ELSE 0 END)=1),
  CHECK (CHAR_LENGTH(request_hash)=64),
  CHECK (CHAR_LENGTH(response_hash)=64),
  CHECK (CHAR_LENGTH(response_ref)>0),
  CHECK (created_at_ms>=0 AND created_at_ms<=9223372036854775807),
  CHECK (BINARY request_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY response_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `actor_principal_id`(120), `operation_kind`(120), `operation_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `benchmark_dataset_heads_set_keys_insert` BEFORE INSERT ON `benchmark_dataset_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_dataset_id`), ':', NEW.`public_dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_asset_id`), ':', NEW.`private_asset_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_asset_id` IS NOT NULL AND NEW.`public_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_asset_id`), ':', NEW.`public_asset_id`, OCTET_LENGTH(NEW.`public_release_id`), ':', NEW.`public_release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_asset_id` IS NOT NULL AND NEW.`private_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_asset_id`), ':', NEW.`private_asset_id`, OCTET_LENGTH(NEW.`private_release_id`), ':', NEW.`private_release_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_dataset_heads_set_keys_update` BEFORE UPDATE ON `benchmark_dataset_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_dataset_id`), ':', NEW.`public_dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_asset_id`), ':', NEW.`private_asset_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_asset_id` IS NOT NULL AND NEW.`public_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_asset_id`), ':', NEW.`public_asset_id`, OCTET_LENGTH(NEW.`public_release_id`), ':', NEW.`public_release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_asset_id` IS NOT NULL AND NEW.`private_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_asset_id`), ':', NEW.`private_asset_id`, OCTET_LENGTH(NEW.`private_release_id`), ':', NEW.`private_release_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_experiment_bindings_set_keys_insert` BEFORE INSERT ON `benchmark_experiment_bindings` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_release_id`), ':', NEW.`public_release_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_release_id`), ':', NEW.`private_release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_experiment_bindings_set_keys_update` BEFORE UPDATE ON `benchmark_experiment_bindings` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`public_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`public_release_id`), ':', NEW.`public_release_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`private_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`private_release_id`), ':', NEW.`private_release_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_jobs_set_keys_insert` BEFORE INSERT ON `benchmark_jobs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`parent_job_id` IS NOT NULL AND NEW.`attempt_no` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`parent_job_id`), ':', NEW.`parent_job_id`, OCTET_LENGTH(NEW.`attempt_no`), ':', NEW.`attempt_no`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`callback_attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`callback_attempt_id`), ':', NEW.`callback_attempt_id`), 256)), NULL);
  SET NEW.`_key_9` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`parent_job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`parent_job_id`), ':', NEW.`parent_job_id`), 256)), NULL);
  SET NEW.`_key_10` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`retry_of_job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`retry_of_job_id`), ':', NEW.`retry_of_job_id`), 256)), NULL);
  SET NEW.`_key_11` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_jobs_set_keys_update` BEFORE UPDATE ON `benchmark_jobs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`parent_job_id` IS NOT NULL AND NEW.`attempt_no` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`parent_job_id`), ':', NEW.`parent_job_id`, OCTET_LENGTH(NEW.`attempt_no`), ':', NEW.`attempt_no`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`callback_attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`callback_attempt_id`), ':', NEW.`callback_attempt_id`), 256)), NULL);
  SET NEW.`_key_9` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`parent_job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`parent_job_id`), ':', NEW.`parent_job_id`), 256)), NULL);
  SET NEW.`_key_10` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`retry_of_job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`retry_of_job_id`), ':', NEW.`retry_of_job_id`), 256)), NULL);
  SET NEW.`_key_11` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_artifacts_set_keys_insert` BEFORE INSERT ON `benchmark_artifacts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`artifact_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`artifact_id`), ':', NEW.`artifact_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_artifacts_set_keys_update` BEFORE UPDATE ON `benchmark_artifacts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`artifact_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`artifact_id`), ':', NEW.`artifact_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_operation_receipts_set_keys_insert` BEFORE INSERT ON `benchmark_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `benchmark_operation_receipts_set_keys_update` BEFORE UPDATE ON `benchmark_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_id`), ':', NEW.`dataset_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`job_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`job_id`), ':', NEW.`job_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_benchmark_dataset_heads_1` ON `benchmark_dataset_heads` (`workspace_id`(120), `adapter_key`(120), `state`(120), `updated_at_ms`);

-- next statement

CREATE TRIGGER `benchmark_dataset_heads_guard` BEFORE UPDATE ON `benchmark_dataset_heads` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.dataset_id <=> OLD.dataset_id) OR NOT (NEW.public_dataset_id <=> OLD.public_dataset_id) OR NOT (NEW.public_asset_id <=> OLD.public_asset_id) OR NOT (NEW.public_release_id <=> OLD.public_release_id) OR NOT (NEW.private_asset_id <=> OLD.private_asset_id) OR NOT (NEW.private_release_id <=> OLD.private_release_id) OR NOT (NEW.adapter_key <=> OLD.adapter_key) OR NOT (NEW.content_hash <=> OLD.content_hash) OR NOT (NEW.created_by <=> OLD.created_by) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<OLD.lifecycle_revision THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `benchmark_dataset_heads_retained` BEFORE DELETE ON `benchmark_dataset_heads` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark history retained';
END;

-- next statement

CREATE INDEX `idx_benchmark_experiment_bindings_1` ON `benchmark_experiment_bindings` (`workspace_id`(120), `dataset_id`(120), `experiment_id`(120));

-- next statement

CREATE TRIGGER `benchmark_experiment_bindings_guard` BEFORE UPDATE ON `benchmark_experiment_bindings` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `benchmark_experiment_bindings_retained` BEFORE DELETE ON `benchmark_experiment_bindings` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark history retained';
END;

-- next statement

CREATE INDEX `idx_benchmark_jobs_1` ON `benchmark_jobs` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `kind`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_benchmark_jobs_2` ON `benchmark_jobs` (`workspace_id`(120), `protocol_state`(120), `updated_at_ms`);

-- next statement

CREATE INDEX `idx_benchmark_jobs_3` ON `benchmark_jobs` (`workspace_id`(120), `origin_credential_id`(120));

-- next statement

CREATE TRIGGER `benchmark_jobs_guard` BEFORE UPDATE ON `benchmark_jobs` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.job_id <=> OLD.job_id) OR NOT (NEW.experiment_id <=> OLD.experiment_id) OR NOT (NEW.case_id <=> OLD.case_id) OR NOT (NEW.run_id <=> OLD.run_id) OR NOT (NEW.work_item_id <=> OLD.work_item_id) OR NOT (NEW.kind <=> OLD.kind) OR NOT (NEW.parent_job_id <=> OLD.parent_job_id) OR NOT (NEW.adapter_key <=> OLD.adapter_key) OR NOT (NEW.evaluator_key <=> OLD.evaluator_key) OR NOT (NEW.attempt_no <=> OLD.attempt_no) OR NOT (NEW.retry_of_job_id <=> OLD.retry_of_job_id) OR NOT (NEW.origin_credential_id <=> OLD.origin_credential_id) OR NOT (NEW.origin_credential_kind <=> OLD.origin_credential_kind) OR NOT (NEW.actor_principal_id <=> OLD.actor_principal_id) OR NOT (NEW.created_at_ms <=> OLD.created_at_ms) OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.callback_epoch<OLD.callback_epoch OR (OLD.request_hash IS NOT NULL AND NOT (NEW.request_hash <=> OLD.request_hash)) OR (OLD.request_ref IS NOT NULL AND NOT (NEW.request_ref <=> OLD.request_ref)) OR (OLD.completion_hash IS NOT NULL AND NOT (NEW.completion_hash <=> OLD.completion_hash)) OR (OLD.completion_ref IS NOT NULL AND NOT (NEW.completion_ref <=> OLD.completion_ref)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `benchmark_jobs_retained` BEFORE DELETE ON `benchmark_jobs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark history retained';
END;

-- next statement

CREATE INDEX `idx_benchmark_artifacts_1` ON `benchmark_artifacts` (`workspace_id`(120), `job_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_benchmark_artifacts_2` ON `benchmark_artifacts` (`workspace_id`(120), `content_hash`(120));

-- next statement

CREATE TRIGGER `benchmark_artifacts_guard` BEFORE UPDATE ON `benchmark_artifacts` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `benchmark_artifacts_retained` BEFORE DELETE ON `benchmark_artifacts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark history retained';
END;

-- next statement

CREATE INDEX `idx_benchmark_operation_receipts_1` ON `benchmark_operation_receipts` (`workspace_id`(120), `experiment_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_benchmark_operation_receipts_2` ON `benchmark_operation_receipts` (`workspace_id`(120), `job_id`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `benchmark_operation_receipts_guard` BEFORE UPDATE ON `benchmark_operation_receipts` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `benchmark_operation_receipts_retained` BEFORE DELETE ON `benchmark_operation_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'benchmark history retained';
END;

-- next statement

ALTER TABLE `benchmark_dataset_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `dataset_compat_heads` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_dataset_heads` ADD FOREIGN KEY (`_key_4`) REFERENCES `asset_release_seals` (`_key_2`);

-- next statement

ALTER TABLE `benchmark_dataset_heads` ADD FOREIGN KEY (`_key_5`) REFERENCES `asset_release_seals` (`_key_2`);

-- next statement

ALTER TABLE `benchmark_dataset_heads` ADD FOREIGN KEY (`_key_6`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_experiment_bindings` ADD FOREIGN KEY (`_key_1`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_experiment_bindings` ADD FOREIGN KEY (`_key_2`) REFERENCES `benchmark_dataset_heads` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_experiment_bindings` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_release_seals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_experiment_bindings` ADD FOREIGN KEY (`_key_4`) REFERENCES `asset_release_seals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_experiment_bindings` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_4`) REFERENCES `benchmark_experiment_bindings` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_5`) REFERENCES `experiment_cases` (`_key_2`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_6`) REFERENCES `experiment_runs` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_7`) REFERENCES `work_items` (`_key_4`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_8`) REFERENCES `work_attempts` (`_key_4`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_9`) REFERENCES `benchmark_jobs` (`_key_2`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_10`) REFERENCES `benchmark_jobs` (`_key_2`);

-- next statement

ALTER TABLE `benchmark_jobs` ADD FOREIGN KEY (`_key_11`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_artifacts` ADD FOREIGN KEY (`_key_3`) REFERENCES `benchmark_jobs` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_operation_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_operation_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_operation_receipts` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_operation_receipts` ADD FOREIGN KEY (`_key_5`) REFERENCES `benchmark_dataset_heads` (`_key_1`);

-- next statement

ALTER TABLE `benchmark_operation_receipts` ADD FOREIGN KEY (`_key_6`) REFERENCES `benchmark_jobs` (`_key_1`);
