CREATE TABLE `schema_meta` (
  `version` BIGINT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `checksum` LONGTEXT NOT NULL,
  `applied_at_ms` BIGINT NOT NULL,
  CHECK (version > 0),
  CHECK (applied_at_ms >= 0),
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `workspaces` (
  `workspace_id` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'active',
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (state IN ('active','suspended','deleted')),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_identities` (
  `workspace_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `visibility` LONGTEXT NOT NULL DEFAULT 'private',
  `description` LONGTEXT NOT NULL DEFAULT '',
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (kind IN ('skill','agent','evaluator','dataset','benchmark')),
  CHECK (visibility IN ('private','workspace','public')),
  CHECK (etag > 0),
  CHECK (CHAR_LENGTH(name) > 0),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `asset_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `kind`(120), `name`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_releases` (
  `workspace_id` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `version_label` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `manifest_ref` LONGTEXT NOT NULL,
  `schema_version` BIGINT NOT NULL,
  `publisher_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(content_hash) = 64),
  CHECK (schema_version > 0),
  CHECK (CHAR_LENGTH(version_label) > 0),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `release_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `asset_id`(120), `version_label`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `asset_id`(120), `release_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_drafts` (
  `workspace_id` LONGTEXT NOT NULL,
  `draft_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `branch_name` LONGTEXT NOT NULL,
  `base_release_id` LONGTEXT,
  `manifest_json` LONGTEXT NOT NULL,
  `edit_revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (edit_revision > 0),
  CHECK (edit_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `draft_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `asset_id`(120), `branch_name`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_release_dependencies` (
  `workspace_id` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `role` LONGTEXT NOT NULL,
  `dependency_release_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (release_id <> dependency_release_id),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `release_id`(120), `role`(120), `dependency_release_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_release_seals` (
  `workspace_id` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `dependency_count` BIGINT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (dependency_count >= 0),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `release_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `asset_id`(120), `release_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `asset_aliases` (
  `workspace_id` LONGTEXT NOT NULL,
  `asset_id` LONGTEXT NOT NULL,
  `alias` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (etag > 0),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `asset_id`(120), `alias`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `runs` (
  `workspace_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `plan_hash` LONGTEXT NOT NULL,
  `plan_manifest_ref` LONGTEXT NOT NULL,
  `dataset_release_id` LONGTEXT,
  `expected_case_count` BIGINT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'draft',
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(plan_hash) = 64),
  CHECK (expected_case_count >= 0),
  CHECK (etag > 0),
  CHECK (`status` IN ('draft','queued','running','done','partial','failed','cancelled')),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `run_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `run_inputs` (
  `workspace_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `slot` LONGTEXT NOT NULL,
  `release_id` LONGTEXT NOT NULL,
  `config_hash` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(config_hash) = 64),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `run_id`(120), `slot`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `work_items` (
  `workspace_id` LONGTEXT NOT NULL,
  `work_item_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `case_key` LONGTEXT NOT NULL,
  `phase` LONGTEXT NOT NULL,
  `evaluator_slot` LONGTEXT NOT NULL DEFAULT 'default',
  `status` LONGTEXT NOT NULL DEFAULT 'queued',
  `priority` BIGINT NOT NULL DEFAULT 0,
  `etag` BIGINT NOT NULL DEFAULT 1,
  `next_attempt_at_ms` BIGINT NOT NULL DEFAULT 0,
  `cancel_requested` BIGINT NOT NULL DEFAULT 0,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (etag > 0),
  CHECK (cancel_requested IN (0,1)),
  CHECK (phase IN ('execute','evaluate','snapshot','publish','migrate')),
  CHECK (`status` IN ('queued','running','done','failed','cancelled')),
  CHECK (etag <= 9223372036854775807),
  CHECK (next_attempt_at_ms >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `work_item_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `run_id`(120), `case_key`(120), `phase`(120), `evaluator_slot`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `run_id`(120), `work_item_id`(120)),
  UNIQUE (`_key_4`),
  KEY `_lookup_7` (`workspace_id`(120), `run_id`(120), `work_item_id`(120), `case_key`(120)),
  UNIQUE (`_key_5`),
  KEY `_lookup_9` (`workspace_id`(120), `run_id`(120), `work_item_id`(120), `case_key`(120), `evaluator_slot`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `work_attempts` (
  `workspace_id` LONGTEXT NOT NULL,
  `attempt_id` LONGTEXT NOT NULL,
  `work_item_id` LONGTEXT NOT NULL,
  `attempt_no` BIGINT NOT NULL,
  `fence` BIGINT NOT NULL,
  `worker_id` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `lease_until_ms` BIGINT NOT NULL,
  `started_at_ms` BIGINT NOT NULL,
  `finished_at_ms` BIGINT,
  `error_code` LONGTEXT,
  CHECK (attempt_no > 0),
  CHECK (fence > 0),
  CHECK (`status` IN ('running','done','failed','cancelled','expired')),
  CHECK (lease_until_ms >= started_at_ms),
  CHECK (fence <= 9223372036854775807),
  CHECK (lease_until_ms >= 0),
  CHECK (started_at_ms >= 0),
  CHECK (finished_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `attempt_id`(120)),
  UNIQUE (`_key_2`),
  UNIQUE (`_key_3`),
  KEY `_lookup_4` (`workspace_id`(120), `work_item_id`(120), `fence`),
  UNIQUE (`_key_4`),
  KEY `_lookup_6` (`workspace_id`(120), `work_item_id`(120), `attempt_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `result_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `work_item_id` LONGTEXT NOT NULL,
  `case_key` LONGTEXT NOT NULL,
  `evaluator_slot` LONGTEXT NOT NULL DEFAULT 'default',
  `receipt_id` LONGTEXT NOT NULL,
  `attempt_id` LONGTEXT NOT NULL,
  `receipt_key` LONGTEXT NOT NULL,
  `result_id` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `artifact_ref` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'accepted',
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(content_hash) = 64),
  CHECK (state IN ('accepted','indexed','published','quarantined')),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  `_key_5` BINARY(32) INVISIBLE,
  `_key_6` BINARY(32) INVISIBLE,
  `_key_7` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `receipt_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `attempt_id`(120), `receipt_key`(120)),
  UNIQUE (`_key_3`),
  KEY `_lookup_5` (`workspace_id`(120), `result_id`(120)),
  UNIQUE (`_key_4`),
  KEY `_lookup_7` (`workspace_id`(120), `run_id`(120), `result_id`(120)),
  UNIQUE (`_key_5`),
  KEY `_lookup_9` (`workspace_id`(120), `run_id`(120), `case_key`(120), `evaluator_slot`(120), `result_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `result_selections` (
  `workspace_id` LONGTEXT NOT NULL,
  `run_id` LONGTEXT NOT NULL,
  `case_key` LONGTEXT NOT NULL,
  `evaluator_slot` LONGTEXT NOT NULL,
  `result_id` LONGTEXT NOT NULL,
  `selection_revision` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (selection_revision > 0),
  CHECK (selection_revision <= 9223372036854775807),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `run_id`(120), `case_key`(120), `evaluator_slot`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `outbox_events` (
  `workspace_id` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `aggregate_id` LONGTEXT NOT NULL,
  `aggregate_revision` BIGINT NOT NULL,
  `event_type` LONGTEXT NOT NULL,
  `payload_json` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'pending',
  `attempts` BIGINT NOT NULL DEFAULT 0,
  `next_attempt_at_ms` BIGINT NOT NULL DEFAULT 0,
  `lease_owner` LONGTEXT,
  `lease_until_ms` BIGINT,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (aggregate_revision > 0),
  CHECK (attempts >= 0),
  CHECK (state IN ('pending','dispatching','sent','dead')),
  CHECK (next_attempt_at_ms >= 0),
  CHECK (lease_until_ms >= 0),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `event_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `aggregate_id`(120), `aggregate_revision`, `event_type`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `inbox_receipts` (
  `workspace_id` LONGTEXT NOT NULL,
  `source_id` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `processed_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(content_hash) = 64),
  CHECK (processed_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `source_id`(120), `event_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `trace_locators` (
  `workspace_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `source_namespace` LONGTEXT NOT NULL,
  `native_trace_id` LONGTEXT NOT NULL,
  `trace_bucket` LONGTEXT NOT NULL,
  `route_epoch` BIGINT NOT NULL DEFAULT 1,
  `incarnation` BIGINT NOT NULL DEFAULT 1,
  `state` LONGTEXT NOT NULL DEFAULT 'active',
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (route_epoch > 0),
  CHECK (incarnation > 0),
  CHECK (state IN ('active','deleting','deleted')),
  CHECK (route_epoch <= 9223372036854775807),
  CHECK (incarnation <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `trace_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `source_namespace`(120), `native_trace_id`(120), `incarnation`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `snapshot_manifests` (
  `workspace_id` LONGTEXT NOT NULL,
  `snapshot_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT,
  `manifest_ref` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `node_count` BIGINT NOT NULL,
  `log_watermark` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'staging',
  `created_at_ms` BIGINT NOT NULL,
  `published_at_ms` BIGINT,
  CHECK (node_count >= 0),
  CHECK (CHAR_LENGTH(content_hash) = 64),
  CHECK (state IN ('staging','published','failed')),
  CHECK (created_at_ms >= 0),
  CHECK (published_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `snapshot_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `artifact_metadata` (
  `workspace_id` LONGTEXT NOT NULL,
  `artifact_id` LONGTEXT NOT NULL,
  `namespace` LONGTEXT NOT NULL,
  `object_ref` LONGTEXT NOT NULL,
  `content_hash` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `media_type` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'staging',
  `created_at_ms` BIGINT NOT NULL,
  `published_at_ms` BIGINT,
  CHECK (CHAR_LENGTH(content_hash) = 64),
  CHECK (size_bytes >= 0),
  CHECK (state IN ('staging','published','deleted')),
  CHECK (created_at_ms >= 0),
  CHECK (published_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `artifact_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `namespace`(120), `object_ref`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `deletion_requests` (
  `workspace_id` LONGTEXT NOT NULL,
  `deletion_id` LONGTEXT NOT NULL,
  `resource_kind` LONGTEXT NOT NULL,
  `resource_id` LONGTEXT NOT NULL,
  `incarnation` BIGINT NOT NULL,
  `barrier_revision` BIGINT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'requested',
  `requested_by` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (incarnation > 0),
  CHECK (barrier_revision > 0),
  CHECK (state IN ('requested','blocked','propagating','purged','failed')),
  CHECK (incarnation <= 9223372036854775807),
  CHECK (barrier_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `deletion_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `resource_kind`(120), `resource_id`(120), `incarnation`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `migration_checkpoints` (
  `workspace_id` LONGTEXT NOT NULL,
  `migration_id` LONGTEXT NOT NULL,
  `source_fingerprint` LONGTEXT NOT NULL,
  `source_table` LONGTEXT NOT NULL,
  `last_key` LONGTEXT NOT NULL,
  `rows_processed` BIGINT NOT NULL DEFAULT 0,
  `target_watermark` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT 'planned',
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(source_fingerprint) = 64),
  CHECK (rows_processed >= 0),
  CHECK (etag > 0),
  CHECK (state IN ('planned','running','verified','failed')),
  CHECK (etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `migration_id`(120), `source_table`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `workspaces_set_keys_insert` BEFORE INSERT ON `workspaces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `workspaces_set_keys_update` BEFORE UPDATE ON `workspaces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_identities_set_keys_insert` BEFORE INSERT ON `asset_identities` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_identities_set_keys_update` BEFORE UPDATE ON `asset_identities` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`kind` IS NOT NULL AND NEW.`name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`kind`), ':', NEW.`kind`, OCTET_LENGTH(NEW.`name`), ':', NEW.`name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_releases_set_keys_insert` BEFORE INSERT ON `asset_releases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`version_label` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`version_label`), ':', NEW.`version_label`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_releases_set_keys_update` BEFORE UPDATE ON `asset_releases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`version_label` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`version_label`), ':', NEW.`version_label`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_drafts_set_keys_insert` BEFORE INSERT ON `asset_drafts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`draft_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`draft_id`), ':', NEW.`draft_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`branch_name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`branch_name`), ':', NEW.`branch_name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`base_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`base_release_id`), ':', NEW.`base_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_drafts_set_keys_update` BEFORE UPDATE ON `asset_drafts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`draft_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`draft_id`), ':', NEW.`draft_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`branch_name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`branch_name`), ':', NEW.`branch_name`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`base_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`base_release_id`), ':', NEW.`base_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_release_dependencies_set_keys_insert` BEFORE INSERT ON `asset_release_dependencies` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL AND NEW.`role` IS NOT NULL AND NEW.`dependency_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`, OCTET_LENGTH(NEW.`role`), ':', NEW.`role`, OCTET_LENGTH(NEW.`dependency_release_id`), ':', NEW.`dependency_release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dependency_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dependency_release_id`), ':', NEW.`dependency_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_release_dependencies_set_keys_update` BEFORE UPDATE ON `asset_release_dependencies` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL AND NEW.`role` IS NOT NULL AND NEW.`dependency_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`, OCTET_LENGTH(NEW.`role`), ':', NEW.`role`, OCTET_LENGTH(NEW.`dependency_release_id`), ':', NEW.`dependency_release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dependency_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dependency_release_id`), ':', NEW.`dependency_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_release_seals_set_keys_insert` BEFORE INSERT ON `asset_release_seals` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_release_seals_set_keys_update` BEFORE UPDATE ON `asset_release_seals` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_aliases_set_keys_insert` BEFORE INSERT ON `asset_aliases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`alias` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`alias`), ':', NEW.`alias`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `asset_aliases_set_keys_update` BEFORE UPDATE ON `asset_aliases` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`alias` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`alias`), ':', NEW.`alias`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`asset_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`asset_id`), ':', NEW.`asset_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `runs_set_keys_insert` BEFORE INSERT ON `runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_release_id`), ':', NEW.`dataset_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `runs_set_keys_update` BEFORE UPDATE ON `runs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`dataset_release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`dataset_release_id`), ':', NEW.`dataset_release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `run_inputs_set_keys_insert` BEFORE INSERT ON `run_inputs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`slot`), ':', NEW.`slot`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `run_inputs_set_keys_update` BEFORE UPDATE ON `run_inputs` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`slot`), ':', NEW.`slot`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`release_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`release_id`), ':', NEW.`release_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `work_items_set_keys_insert` BEFORE INSERT ON `work_items` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`phase` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`phase`), ':', NEW.`phase`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `work_items_set_keys_update` BEFORE UPDATE ON `work_items` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`phase` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`phase`), ':', NEW.`phase`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `work_attempts_set_keys_insert` BEFORE INSERT ON `work_attempts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_no` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_no`), ':', NEW.`attempt_no`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`fence` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`fence`), ':', NEW.`fence`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `work_attempts_set_keys_update` BEFORE UPDATE ON `work_attempts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_no` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_no`), ':', NEW.`attempt_no`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`fence` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`fence`), ':', NEW.`fence`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `result_receipts_set_keys_insert` BEFORE INSERT ON `result_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`receipt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`receipt_id`), ':', NEW.`receipt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`receipt_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`receipt_key`), ':', NEW.`receipt_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `result_receipts_set_keys_update` BEFORE UPDATE ON `result_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`receipt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`receipt_id`), ':', NEW.`receipt_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL AND NEW.`receipt_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`, OCTET_LENGTH(NEW.`receipt_key`), ':', NEW.`receipt_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_5` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
  SET NEW.`_key_6` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`attempt_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`attempt_id`), ':', NEW.`attempt_id`), 256)), NULL);
  SET NEW.`_key_7` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`work_item_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`work_item_id`), ':', NEW.`work_item_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `result_selections_set_keys_insert` BEFORE INSERT ON `result_selections` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `result_selections_set_keys_update` BEFORE UPDATE ON `result_selections` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`run_id` IS NOT NULL AND NEW.`case_key` IS NOT NULL AND NEW.`evaluator_slot` IS NOT NULL AND NEW.`result_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`run_id`), ':', NEW.`run_id`, OCTET_LENGTH(NEW.`case_key`), ':', NEW.`case_key`, OCTET_LENGTH(NEW.`evaluator_slot`), ':', NEW.`evaluator_slot`, OCTET_LENGTH(NEW.`result_id`), ':', NEW.`result_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `outbox_events_set_keys_insert` BEFORE INSERT ON `outbox_events` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`aggregate_id` IS NOT NULL AND NEW.`aggregate_revision` IS NOT NULL AND NEW.`event_type` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`aggregate_id`), ':', NEW.`aggregate_id`, OCTET_LENGTH(NEW.`aggregate_revision`), ':', NEW.`aggregate_revision`, OCTET_LENGTH(NEW.`event_type`), ':', NEW.`event_type`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `outbox_events_set_keys_update` BEFORE UPDATE ON `outbox_events` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`aggregate_id` IS NOT NULL AND NEW.`aggregate_revision` IS NOT NULL AND NEW.`event_type` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`aggregate_id`), ':', NEW.`aggregate_id`, OCTET_LENGTH(NEW.`aggregate_revision`), ':', NEW.`aggregate_revision`, OCTET_LENGTH(NEW.`event_type`), ':', NEW.`event_type`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `inbox_receipts_set_keys_insert` BEFORE INSERT ON `inbox_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `inbox_receipts_set_keys_update` BEFORE UPDATE ON `inbox_receipts` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_id`), ':', NEW.`source_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_locators_set_keys_insert` BEFORE INSERT ON `trace_locators` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_namespace` IS NOT NULL AND NEW.`native_trace_id` IS NOT NULL AND NEW.`incarnation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_namespace`), ':', NEW.`source_namespace`, OCTET_LENGTH(NEW.`native_trace_id`), ':', NEW.`native_trace_id`, OCTET_LENGTH(NEW.`incarnation`), ':', NEW.`incarnation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `trace_locators_set_keys_update` BEFORE UPDATE ON `trace_locators` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`source_namespace` IS NOT NULL AND NEW.`native_trace_id` IS NOT NULL AND NEW.`incarnation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`source_namespace`), ':', NEW.`source_namespace`, OCTET_LENGTH(NEW.`native_trace_id`), ':', NEW.`native_trace_id`, OCTET_LENGTH(NEW.`incarnation`), ':', NEW.`incarnation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `snapshot_manifests_set_keys_insert` BEFORE INSERT ON `snapshot_manifests` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`snapshot_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`snapshot_id`), ':', NEW.`snapshot_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `snapshot_manifests_set_keys_update` BEFORE UPDATE ON `snapshot_manifests` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`snapshot_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`snapshot_id`), ':', NEW.`snapshot_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `artifact_metadata_set_keys_insert` BEFORE INSERT ON `artifact_metadata` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`artifact_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`artifact_id`), ':', NEW.`artifact_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`namespace` IS NOT NULL AND NEW.`object_ref` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`namespace`), ':', NEW.`namespace`, OCTET_LENGTH(NEW.`object_ref`), ':', NEW.`object_ref`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `artifact_metadata_set_keys_update` BEFORE UPDATE ON `artifact_metadata` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`artifact_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`artifact_id`), ':', NEW.`artifact_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`namespace` IS NOT NULL AND NEW.`object_ref` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`namespace`), ':', NEW.`namespace`, OCTET_LENGTH(NEW.`object_ref`), ':', NEW.`object_ref`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `deletion_requests_set_keys_insert` BEFORE INSERT ON `deletion_requests` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`deletion_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`deletion_id`), ':', NEW.`deletion_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL AND NEW.`incarnation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`, OCTET_LENGTH(NEW.`incarnation`), ':', NEW.`incarnation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `deletion_requests_set_keys_update` BEFORE UPDATE ON `deletion_requests` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`deletion_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`deletion_id`), ':', NEW.`deletion_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL AND NEW.`incarnation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`, OCTET_LENGTH(NEW.`incarnation`), ':', NEW.`incarnation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `migration_checkpoints_set_keys_insert` BEFORE INSERT ON `migration_checkpoints` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`migration_id` IS NOT NULL AND NEW.`source_table` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`migration_id`), ':', NEW.`migration_id`, OCTET_LENGTH(NEW.`source_table`), ':', NEW.`source_table`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `migration_checkpoints_set_keys_update` BEFORE UPDATE ON `migration_checkpoints` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`migration_id` IS NOT NULL AND NEW.`source_table` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`migration_id`), ':', NEW.`migration_id`, OCTET_LENGTH(NEW.`source_table`), ':', NEW.`source_table`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_asset_identities_1` ON `asset_identities` (`workspace_id`(120), `kind`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_asset_releases_1` ON `asset_releases` (`workspace_id`(120), `asset_id`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_asset_release_dependencies_1` ON `asset_release_dependencies` (`workspace_id`(120), `dependency_release_id`(120));

-- next statement

CREATE INDEX `idx_runs_1` ON `runs` (`workspace_id`(120), `status`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_work_items_1` ON `work_items` (`workspace_id`(120), `status`(120), `next_attempt_at_ms`, `priority`);

-- next statement

CREATE INDEX `idx_work_items_2` ON `work_items` (`workspace_id`(120), `run_id`(120), `status`(120));

-- next statement

CREATE INDEX `idx_work_attempts_1` ON `work_attempts` (`workspace_id`(120), `status`(120), `lease_until_ms`);

-- next statement

CREATE INDEX `idx_work_attempts_2` ON `work_attempts` (`workspace_id`(120), `work_item_id`(120), `attempt_no`);

-- next statement

CREATE INDEX `idx_result_receipts_1` ON `result_receipts` (`workspace_id`(120), `state`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_outbox_events_1` ON `outbox_events` (`state`(120), `next_attempt_at_ms`, `created_at_ms`);

-- next statement

CREATE INDEX `idx_outbox_events_2` ON `outbox_events` (`workspace_id`(120), `aggregate_id`(120), `aggregate_revision`);

-- next statement

CREATE INDEX `idx_trace_locators_1` ON `trace_locators` (`workspace_id`(120), `trace_bucket`(120), `state`(120));

-- next statement

CREATE INDEX `idx_snapshot_manifests_1` ON `snapshot_manifests` (`workspace_id`(120), `state`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_artifact_metadata_1` ON `artifact_metadata` (`workspace_id`(120), `state`(120), `created_at_ms`);

-- next statement

CREATE INDEX `idx_deletion_requests_1` ON `deletion_requests` (`workspace_id`(120), `state`(120), `created_at_ms`);

-- next statement

CREATE TRIGGER `immutable_asset_releases_update` BEFORE UPDATE ON `asset_releases` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_releases';
END;

-- next statement

CREATE TRIGGER `immutable_asset_releases_delete` BEFORE DELETE ON `asset_releases` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_releases';
END;

-- next statement

CREATE TRIGGER `immutable_asset_release_dependencies_update` BEFORE UPDATE ON `asset_release_dependencies` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_release_dependencies';
END;

-- next statement

CREATE TRIGGER `immutable_asset_release_dependencies_delete` BEFORE DELETE ON `asset_release_dependencies` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_release_dependencies';
END;

-- next statement

CREATE TRIGGER `immutable_asset_release_seals_update` BEFORE UPDATE ON `asset_release_seals` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_release_seals';
END;

-- next statement

CREATE TRIGGER `immutable_asset_release_seals_delete` BEFORE DELETE ON `asset_release_seals` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable asset_release_seals';
END;

-- next statement

CREATE TRIGGER `immutable_run_inputs_update` BEFORE UPDATE ON `run_inputs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable run_inputs';
END;

-- next statement

CREATE TRIGGER `immutable_run_inputs_delete` BEFORE DELETE ON `run_inputs` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable run_inputs';
END;

-- next statement

CREATE TRIGGER `immutable_inbox_receipts_update` BEFORE UPDATE ON `inbox_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable inbox_receipts';
END;

-- next statement

CREATE TRIGGER `immutable_inbox_receipts_delete` BEFORE DELETE ON `inbox_receipts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable inbox_receipts';
END;

-- next statement

CREATE TRIGGER `dependencies_sealed` BEFORE INSERT ON `asset_release_dependencies` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM asset_release_seals WHERE workspace_id=NEW.workspace_id AND release_id=NEW.release_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'release dependencies sealed';
  END IF;
END;

-- next statement

CREATE TRIGGER `seal_count_matches` BEFORE INSERT ON `asset_release_seals` FOR EACH ROW
BEGIN
  IF NEW.dependency_count <> (SELECT COUNT(*) FROM asset_release_dependencies WHERE workspace_id=NEW.workspace_id AND release_id=NEW.release_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dependency count mismatch';
  END IF;
END;

-- next statement

CREATE TRIGGER `run_inputs_frozen` BEFORE INSERT ON `run_inputs` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM runs WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND `status`<>'draft') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'run inputs frozen';
  END IF;
END;

-- next statement

CREATE TRIGGER `trace_identity_stable` BEFORE UPDATE ON `trace_locators` FOR EACH ROW
BEGIN
  IF OLD.workspace_id<>NEW.workspace_id OR OLD.trace_id<>NEW.trace_id OR OLD.trace_bucket<>NEW.trace_bucket OR OLD.source_namespace<>NEW.source_namespace OR OLD.native_trace_id<>NEW.native_trace_id OR OLD.incarnation<>NEW.incarnation OR (OLD.state='deleted' AND NEW.state<>'deleted') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'trace identity cannot change or resurrect';
  END IF;
END;

-- next statement

CREATE TRIGGER `trace_locator_no_delete` BEFORE DELETE ON `trace_locators` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'trace locator deletion ledger retained';
END;

-- next statement

CREATE TRIGGER `run_plan_frozen` BEFORE UPDATE ON `runs` FOR EACH ROW
BEGIN
  IF (OLD.`status` <> 'draft' AND NEW.`status` = 'draft') OR (OLD.`status` <> 'draft' AND (NOT (OLD.workspace_id <=> NEW.workspace_id) OR NOT (OLD.run_id <=> NEW.run_id) OR NOT (OLD.plan_hash <=> NEW.plan_hash) OR NOT (OLD.plan_manifest_ref <=> NEW.plan_manifest_ref) OR NOT (OLD.dataset_release_id <=> NEW.dataset_release_id) OR NOT (OLD.expected_case_count <=> NEW.expected_case_count))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'run plan frozen';
  END IF;
END;

-- next statement

ALTER TABLE `asset_identities` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `asset_releases` ADD FOREIGN KEY (`_key_4`) REFERENCES `asset_identities` (`_key_1`);

-- next statement

ALTER TABLE `asset_drafts` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_identities` (`_key_1`);

-- next statement

ALTER TABLE `asset_drafts` ADD FOREIGN KEY (`_key_4`) REFERENCES `asset_releases` (`_key_3`);

-- next statement

ALTER TABLE `asset_release_dependencies` ADD FOREIGN KEY (`_key_2`) REFERENCES `asset_releases` (`_key_1`);

-- next statement

ALTER TABLE `asset_release_dependencies` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_releases` (`_key_1`);

-- next statement

ALTER TABLE `asset_release_seals` ADD FOREIGN KEY (`_key_2`) REFERENCES `asset_releases` (`_key_3`);

-- next statement

ALTER TABLE `asset_aliases` ADD FOREIGN KEY (`_key_2`) REFERENCES `asset_identities` (`_key_1`);

-- next statement

ALTER TABLE `asset_aliases` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_release_seals` (`_key_2`);

-- next statement

ALTER TABLE `runs` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `runs` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_release_seals` (`_key_1`);

-- next statement

ALTER TABLE `run_inputs` ADD FOREIGN KEY (`_key_2`) REFERENCES `runs` (`_key_1`);

-- next statement

ALTER TABLE `run_inputs` ADD FOREIGN KEY (`_key_3`) REFERENCES `asset_release_seals` (`_key_1`);

-- next statement

ALTER TABLE `work_items` ADD FOREIGN KEY (`_key_6`) REFERENCES `runs` (`_key_1`);

-- next statement

ALTER TABLE `work_attempts` ADD FOREIGN KEY (`_key_5`) REFERENCES `work_items` (`_key_1`);

-- next statement

ALTER TABLE `result_receipts` ADD FOREIGN KEY (`_key_6`) REFERENCES `work_attempts` (`_key_4`);

-- next statement

ALTER TABLE `result_receipts` ADD FOREIGN KEY (`_key_7`) REFERENCES `work_items` (`_key_5`);

-- next statement

ALTER TABLE `result_selections` ADD FOREIGN KEY (`_key_2`) REFERENCES `runs` (`_key_1`);

-- next statement

ALTER TABLE `result_selections` ADD FOREIGN KEY (`_key_3`) REFERENCES `result_receipts` (`_key_5`);

-- next statement

ALTER TABLE `outbox_events` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `inbox_receipts` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `trace_locators` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `snapshot_manifests` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `snapshot_manifests` ADD FOREIGN KEY (`_key_3`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `artifact_metadata` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `deletion_requests` ADD FOREIGN KEY (`_key_3`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `migration_checkpoints` ADD FOREIGN KEY (`_key_2`) REFERENCES `workspaces` (`_key_1`);
