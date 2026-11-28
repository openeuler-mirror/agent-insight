CREATE TABLE `experiment_heads` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `type` LONGTEXT NOT NULL,
  `scope` LONGTEXT NOT NULL,
  `skill_name` LONGTEXT NOT NULL,
  `agent_name` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `watch_mode` BIGINT NOT NULL DEFAULT 0,
  `watch_enabled_at_ms` BIGINT,
  `metadata_hash` LONGTEXT NOT NULL,
  `metadata_ref` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `lifecycle_revision` BIGINT NOT NULL DEFAULT 1,
  `state` LONGTEXT NOT NULL,
  `current_run_id` LONGTEXT,
  `created_by` LONGTEXT NOT NULL,
  `deleted_at_ms` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (state IN ('active','deleted')),
  CHECK (`status` IN ('draft','queued','running','done','partial','failed','cancelled')),
  CHECK (`type` IN ('single','llm','framework','skill')),
  CHECK (watch_mode IN (0,1)),
  CHECK ((state='active' AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_at_ms IS NOT NULL)),
  CHECK (CHAR_LENGTH(name)>0),
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (watch_mode >= 0 AND watch_mode <= 9223372036854775807),
  CHECK (watch_enabled_at_ms >= 0 AND watch_enabled_at_ms <= 9223372036854775807),
  CHECK (CHAR_LENGTH(metadata_hash)=64),
  CHECK (CHAR_LENGTH(metadata_ref)>0),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (deleted_at_ms >= 0 AND deleted_at_ms <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (BINARY metadata_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `experiment_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_runs` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `generation` BIGINT NOT NULL,
  `lifecycle_revision` BIGINT NOT NULL,
  `created_by` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (generation >= 1 AND generation <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE,
  `_key_2` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_2`),
  KEY `_lookup_1` (`workspace_id`(120), `run_id`(120)),
  UNIQUE (`_key_1`),
  KEY `_lookup_3` (`workspace_id`(120), `experiment_id`(120), `run_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `experiment_id`(120), `generation`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_cases` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `case_id` LONGTEXT NOT NULL,
  `ordinal` BIGINT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `lifecycle_revision` BIGINT NOT NULL DEFAULT 1,
  `payload_hash` LONGTEXT NOT NULL,
  `payload_ref` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT,
  `deleted_at_ms` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  `binding_hash` LONGTEXT,
  CHECK (state IN ('active','deleted')),
  CHECK ((state='active' AND deleted_at_ms IS NULL) OR (state='deleted' AND deleted_at_ms IS NOT NULL)),
  CHECK (binding_hash IS NULL OR CHAR_LENGTH(binding_hash)=64),
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (CHAR_LENGTH(case_id)>0),
  CHECK (ordinal >= 0 AND ordinal <= 9223372036854775807),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (CHAR_LENGTH(payload_hash)=64),
  CHECK (CHAR_LENGTH(payload_ref)>0),
  CHECK (deleted_at_ms >= 0 AND deleted_at_ms <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (CHAR_LENGTH(binding_hash)=64),
  CHECK (BINARY payload_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY binding_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `case_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `experiment_id`(120), `case_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_result_slots` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `case_id` LONGTEXT NOT NULL,
  `result_id` LONGTEXT NOT NULL,
  `evaluator_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT,
  `work_item_id` LONGTEXT,
  `selected_result_id` LONGTEXT,
  `review_id` LONGTEXT,
  `status` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `evaluation_version` BIGINT NOT NULL DEFAULT 0,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (`status` IN ('pending','running','done','failed','cancelled','skipped')),
  CHECK ((run_id IS NULL AND work_item_id IS NULL AND selected_result_id IS NULL) OR (run_id IS NOT NULL AND work_item_id IS NOT NULL)),
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (CHAR_LENGTH(case_id)>0),
  CHECK (CHAR_LENGTH(result_id)>0),
  CHECK (CHAR_LENGTH(evaluator_id)>0),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (evaluation_version >= 0 AND evaluation_version <= 9223372036854775807),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  `_key_8` BINARY(32) INVISIBLE,
  `_key_9` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `result_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `case_id`(120), `evaluator_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `experiment_id`(120), `result_id`(120)),
  UNIQUE (`_key_4`),
  KEY `_lookup_7` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `result_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_attempt_checkpoints` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `case_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `work_item_id` LONGTEXT NOT NULL,
  `attempt_id` LONGTEXT NOT NULL,
  `fence` BIGINT NOT NULL,
  `lease_owner` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `lifecycle_revision` BIGINT NOT NULL,
  `case_lifecycle_revision` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `payload_hash` LONGTEXT NOT NULL,
  `payload_ref` LONGTEXT NOT NULL,
  `stage` LONGTEXT NOT NULL,
  `command_id` LONGTEXT,
  `trace_id` LONGTEXT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (CHAR_LENGTH(case_id)>0),
  CHECK (fence >= 1 AND fence <= 9223372036854775807),
  CHECK (CHAR_LENGTH(lease_owner)>0),
  CHECK (lifecycle_revision >= 1 AND lifecycle_revision <= 9223372036854775807),
  CHECK (case_lifecycle_revision >= 1 AND case_lifecycle_revision <= 9223372036854775807),
  CHECK (revision >= 1 AND revision <= 9223372036854775807),
  CHECK (CHAR_LENGTH(payload_hash)=64),
  CHECK (CHAR_LENGTH(payload_ref)>0),
  CHECK (CHAR_LENGTH(stage)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (updated_at_ms >= 0 AND updated_at_ms <= 9223372036854775807),
  CHECK (BINARY payload_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  `_key_8` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `attempt_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `experiment_id`(120), `run_id`(120), `attempt_id`(120), `actor_principal_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_annotations` (
  `workspace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `annotation_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `case_id` LONGTEXT,
  `result_id` LONGTEXT,
  `machine_result_id` LONGTEXT,
  `subject_id` LONGTEXT,
  `actor_principal_id` LONGTEXT NOT NULL,
  `payload_hash` LONGTEXT NOT NULL,
  `payload_ref` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `lookup_key` LONGTEXT,
  CHECK (kind IN ('review','comment','comment_remove','cancellation','cancellation_update','derived-evaluation','derived-issue')),
  CHECK (result_id IS NULL OR case_id IS NOT NULL),
  CHECK (kind<>'review' OR (result_id IS NOT NULL AND machine_result_id IS NOT NULL)),
  CHECK (kind<>'comment_remove' OR subject_id IS NOT NULL),
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (CHAR_LENGTH(case_id)>0),
  CHECK (CHAR_LENGTH(result_id)>0),
  CHECK (CHAR_LENGTH(payload_hash)=64),
  CHECK (CHAR_LENGTH(payload_ref)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (BINARY payload_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE,
  `_key_2` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  `_key_8` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_2`),
  KEY `_lookup_1` (`workspace_id`(120), `annotation_id`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_3` (`workspace_id`(120), `experiment_id`(120), `annotation_id`(120)),
  UNIQUE (`_key_1`),
  KEY `_lookup_5` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `result_id`(120), `annotation_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_operation_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `operation_kind` LONGTEXT NOT NULL,
  `operation_key` LONGTEXT NOT NULL,
  `request_hash` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `response_hash` LONGTEXT NOT NULL,
  `response_ref` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(operation_kind)>0),
  CHECK (CHAR_LENGTH(operation_key)>0),
  CHECK (CHAR_LENGTH(request_hash)=64),
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (CHAR_LENGTH(response_hash)=64),
  CHECK (CHAR_LENGTH(response_ref)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  CHECK (BINARY request_hash NOT REGEXP '[^0-9a-f]'),
  CHECK (BINARY response_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `actor_principal_id`(120), `operation_kind`(120), `operation_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `experiment_judge_traces` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `experiment_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `attempt_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(experiment_id)>0),
  CHECK (created_at_ms >= 0 AND created_at_ms <= 9223372036854775807),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `experiment_heads_set_keys_insert` BEFORE INSERT ON `experiment_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`current_run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`current_run_id`), ':', NEW.`current_run_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_heads_set_keys_update` BEFORE UPDATE ON `experiment_heads` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`current_run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`current_run_id`), ':', NEW.`current_run_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_runs_set_keys_insert` BEFORE INSERT ON `experiment_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`generation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`generation`), ':', NEW.`generation`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_runs_set_keys_update` BEFORE UPDATE ON `experiment_runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`generation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`generation`), ':', NEW.`generation`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_cases_set_keys_insert` BEFORE INSERT ON `experiment_cases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`binding_hash` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`binding_hash`), ':', NEW.`binding_hash`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_cases_set_keys_update` BEFORE UPDATE ON `experiment_cases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`binding_hash` IS NOT NULL AND (NEW.`state`='active'), UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`binding_hash`), ':', NEW.`binding_hash`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_result_slots_set_keys_insert` BEFORE INSERT ON `experiment_result_slots` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL AND NEW.`selected_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`, OCTET_LENGTH(NEW.`selected_result_id`), ':', NEW.`selected_result_id`), 256)), NULL);
  SET NEW.`_key_9` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL AND NEW.`review_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`, OCTET_LENGTH(NEW.`review_id`), ':', NEW.`review_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_result_slots_set_keys_update` BEFORE UPDATE ON `experiment_result_slots` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`evaluator_id` IS NOT NULL AND NEW.`selected_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`evaluator_id`), ':', NEW.`evaluator_id`, OCTET_LENGTH(NEW.`selected_result_id`), ':', NEW.`selected_result_id`), 256)), NULL);
  SET NEW.`_key_9` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL AND NEW.`review_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`, OCTET_LENGTH(NEW.`review_id`), ':', NEW.`review_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_attempt_checkpoints_set_keys_insert` BEFORE INSERT ON `experiment_attempt_checkpoints` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_attempt_checkpoints_set_keys_update` BEFORE UPDATE ON `experiment_attempt_checkpoints` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_annotations_set_keys_insert` BEFORE INSERT ON `experiment_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`machine_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`machine_result_id`), ':', NEW.`machine_result_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_annotations_set_keys_update` BEFORE UPDATE ON `experiment_annotations` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`annotation_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`annotation_id`), ':', NEW.`annotation_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`case_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`case_id`), ':', NEW.`case_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`machine_result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`machine_result_id`), ':', NEW.`machine_result_id`), 256)), NULL);
  SET NEW.`_key_8` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_operation_receipts_set_keys_insert` BEFORE INSERT ON `experiment_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_operation_receipts_set_keys_update` BEFORE UPDATE ON `experiment_operation_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`actor_principal_id` IS NOT NULL AND NEW.`operation_kind` IS NOT NULL AND NEW.`operation_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`, OCTET_LENGTH(NEW.`operation_kind`), ':', NEW.`operation_kind`, OCTET_LENGTH(NEW.`operation_key`), ':', NEW.`operation_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_judge_traces_set_keys_insert` BEFORE INSERT ON `experiment_judge_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `experiment_judge_traces_set_keys_update` BEFORE UPDATE ON `experiment_judge_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`experiment_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`experiment_id`), ':', NEW.`experiment_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_experiment_heads_1` ON `experiment_heads` (`workspace_id`(120), `state`(120), `scope`(120), `updated_at_ms`, `experiment_id`(120));

-- next statement

CREATE INDEX `idx_experiment_heads_2` ON `experiment_heads` (`workspace_id`(120), `watch_mode`, `agent_name`(120));

-- next statement

CREATE TRIGGER `experiment_heads_update_guard` BEFORE UPDATE ON `experiment_heads` FOR EACH ROW
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.created_by<>OLD.created_by OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<>OLD.lifecycle_revision+(CASE WHEN NEW.state<>OLD.state THEN 1 ELSE 0 END) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_heads_delete_guard` BEFORE DELETE ON `experiment_heads` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_runs_1` ON `experiment_runs` (`workspace_id`(120), `experiment_id`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `experiment_runs_update_guard` BEFORE UPDATE ON `experiment_runs` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_runs_delete_guard` BEFORE DELETE ON `experiment_runs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_cases_1` ON `experiment_cases` (`workspace_id`(120), `experiment_id`(120), `state`(120), `ordinal`);

-- next statement

CREATE TRIGGER `experiment_cases_update_guard` BEFORE UPDATE ON `experiment_cases` FOR EACH ROW
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms OR NEW.lifecycle_revision<>OLD.lifecycle_revision+(CASE WHEN NEW.state<>OLD.state THEN 1 ELSE 0 END) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_cases_delete_guard` BEFORE DELETE ON `experiment_cases` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_result_slots_1` ON `experiment_result_slots` (`workspace_id`(120), `experiment_id`(120), `status`(120));

-- next statement

CREATE TRIGGER `experiment_result_slots_update_guard` BEFORE UPDATE ON `experiment_result_slots` FOR EACH ROW
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.result_id<>OLD.result_id OR NEW.evaluator_id<>OLD.evaluator_id OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_result_slots_delete_guard` BEFORE DELETE ON `experiment_result_slots` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_attempt_checkpoints_1` ON `experiment_attempt_checkpoints` (`workspace_id`(120), `experiment_id`(120), `case_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_experiment_attempt_checkpoints_2` ON `experiment_attempt_checkpoints` (`workspace_id`(120), `command_id`(120));

-- next statement

CREATE TRIGGER `experiment_attempt_checkpoints_update_guard` BEFORE UPDATE ON `experiment_attempt_checkpoints` FOR EACH ROW
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.experiment_id<>OLD.experiment_id OR NEW.case_id<>OLD.case_id OR NEW.run_id<>OLD.run_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.attempt_id<>OLD.attempt_id OR NEW.fence<>OLD.fence OR NEW.lease_owner<>OLD.lease_owner OR NEW.actor_principal_id<>OLD.actor_principal_id OR NEW.lifecycle_revision<>OLD.lifecycle_revision OR NEW.case_lifecycle_revision<>OLD.case_lifecycle_revision OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_attempt_checkpoints_delete_guard` BEFORE DELETE ON `experiment_attempt_checkpoints` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_annotations_1` ON `experiment_annotations` (`workspace_id`(120), `experiment_id`(120), `created_at_ms`, `annotation_id`(120));

-- next statement

CREATE INDEX `idx_experiment_annotations_2` ON `experiment_annotations` (`workspace_id`(120), `result_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_experiment_annotations_3` ON `experiment_annotations` (`workspace_id`(120), `kind`(120), `lookup_key`(120), `created_at_ms`, `annotation_id`(120));

-- next statement

CREATE TRIGGER `experiment_annotations_update_guard` BEFORE UPDATE ON `experiment_annotations` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_annotations_delete_guard` BEFORE DELETE ON `experiment_annotations` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_operation_receipts_1` ON `experiment_operation_receipts` (`workspace_id`(120), `experiment_id`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `experiment_operation_receipts_update_guard` BEFORE UPDATE ON `experiment_operation_receipts` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_operation_receipts_delete_guard` BEFORE DELETE ON `experiment_operation_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE INDEX `idx_experiment_judge_traces_1` ON `experiment_judge_traces` (`workspace_id`(120), `experiment_id`(120), `run_id`(120), `attempt_id`(120));

-- next statement

CREATE TRIGGER `experiment_judge_traces_update_guard` BEFORE UPDATE ON `experiment_judge_traces` FOR EACH ROW
BEGIN
  IF 1=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment invariant';
  END IF;
END;

-- next statement

CREATE TRIGGER `experiment_judge_traces_delete_guard` BEFORE DELETE ON `experiment_judge_traces` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'experiment history is retained';
END;

-- next statement

CREATE UNIQUE INDEX `idx_experiment_case_active_binding` ON `experiment_cases` (`_key_5`);

-- next statement

ALTER TABLE `experiment_heads` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `experiment_heads` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_heads` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_runs` (`_key_1`);

-- next statement

ALTER TABLE `experiment_runs` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `experiment_runs` ADD FOREIGN KEY (`_key_2`) REFERENCES `runs` (`_key_1`);

-- next statement

ALTER TABLE `experiment_runs` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_cases` ADD FOREIGN KEY (`_key_3`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `experiment_cases` ADD FOREIGN KEY (`_key_4`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `experiment_result_slots` ADD FOREIGN KEY (`_key_5`) REFERENCES `experiment_cases` (`_key_2`);

-- next statement

ALTER TABLE `experiment_result_slots` ADD FOREIGN KEY (`_key_6`) REFERENCES `experiment_runs` (`_key_1`);

-- next statement

ALTER TABLE `experiment_result_slots` ADD FOREIGN KEY (`_key_7`) REFERENCES `work_items` (`_key_5`);

-- next statement

ALTER TABLE `experiment_result_slots` ADD FOREIGN KEY (`_key_8`) REFERENCES `result_receipts` (`_key_5`);

-- next statement

ALTER TABLE `experiment_result_slots` ADD FOREIGN KEY (`_key_9`) REFERENCES `experiment_annotations` (`_key_1`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_3`) REFERENCES `experiment_cases` (`_key_2`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_runs` (`_key_1`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_5`) REFERENCES `work_attempts` (`_key_4`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_6`) REFERENCES `work_items` (`_key_4`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_7`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `experiment_attempt_checkpoints` ADD FOREIGN KEY (`_key_8`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_annotations` ADD FOREIGN KEY (`_key_4`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `experiment_annotations` ADD FOREIGN KEY (`_key_5`) REFERENCES `experiment_cases` (`_key_2`);

-- next statement

ALTER TABLE `experiment_annotations` ADD FOREIGN KEY (`_key_6`) REFERENCES `experiment_result_slots` (`_key_4`);

-- next statement

ALTER TABLE `experiment_annotations` ADD FOREIGN KEY (`_key_7`) REFERENCES `result_receipts` (`_key_3`);

-- next statement

ALTER TABLE `experiment_annotations` ADD FOREIGN KEY (`_key_8`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_operation_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `experiment_operation_receipts` ADD FOREIGN KEY (`_key_3`) REFERENCES `experiment_heads` (`_key_1`);

-- next statement

ALTER TABLE `experiment_judge_traces` ADD FOREIGN KEY (`_key_1`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `experiment_judge_traces` ADD FOREIGN KEY (`_key_2`) REFERENCES `experiment_runs` (`_key_1`);

-- next statement

ALTER TABLE `experiment_judge_traces` ADD FOREIGN KEY (`_key_3`) REFERENCES `experiment_attempt_checkpoints` (`_key_2`);

-- next statement

ALTER TABLE `experiment_judge_traces` ADD FOREIGN KEY (`_key_4`) REFERENCES `work_attempts` (`_key_1`);

-- next statement

ALTER TABLE `experiment_judge_traces` ADD FOREIGN KEY (`_key_5`) REFERENCES `iam_principals` (`_key_1`);
