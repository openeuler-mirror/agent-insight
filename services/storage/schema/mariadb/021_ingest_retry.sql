CREATE TABLE `ingest_deliveries` (
  `workspace_id` LONGTEXT NOT NULL,
  `batch_id` LONGTEXT NOT NULL,
  `event_id` LONGTEXT NOT NULL,
  `attempt_base` BIGINT NOT NULL DEFAULT 0,
  `attempt_limit` BIGINT NOT NULL DEFAULT 5,
  `generation` BIGINT NOT NULL DEFAULT 0,
  `last_error_code` LONGTEXT,
  `last_error_message` LONGTEXT,
  last_error_at_ms BIGINT,
  CHECK(attempt_base>=0 AND attempt_limit BETWEEN 1 AND 100 AND generation>=0),
  CHECK(last_error_at_ms IS NULL OR last_error_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `batch_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `event_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `ingest_batch_traces` (
  `workspace_id` LONGTEXT NOT NULL,
  `batch_id` LONGTEXT NOT NULL,
  `trace_id` LONGTEXT NOT NULL,
  `blocks_successors` BIGINT NOT NULL DEFAULT 1 CHECK(blocks_successors IN (0,1)),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `batch_id`(120), `trace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `ingest_batch_recoveries` (
  `workspace_id` LONGTEXT NOT NULL,
  `batch_id` LONGTEXT NOT NULL,
  `request_key` LONGTEXT NOT NULL,
  `generation` BIGINT NOT NULL,
  `actor_principal_id` LONGTEXT NOT NULL,
  `previous_attempts` BIGINT NOT NULL,
  `previous_error_code` LONGTEXT,
  `previous_error_message` LONGTEXT,
  previous_error_at_ms BIGINT,
  recovered_at_ms BIGINT NOT NULL,
  CHECK(generation>0 AND previous_attempts>=0 AND recovered_at_ms>=0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `batch_id`(120), `request_key`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`workspace_id`(120), `batch_id`(120), `generation`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `ingest_deliveries_set_keys_insert` BEFORE INSERT ON `ingest_deliveries` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_deliveries_set_keys_update` BEFORE UPDATE ON `ingest_deliveries` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`event_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`event_id`), ':', NEW.`event_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_batch_traces_set_keys_insert` BEFORE INSERT ON `ingest_batch_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_batch_traces_set_keys_update` BEFORE UPDATE ON `ingest_batch_traces` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`trace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`trace_id`), ':', NEW.`trace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_batch_recoveries_set_keys_insert` BEFORE INSERT ON `ingest_batch_recoveries` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`generation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`generation`), ':', NEW.`generation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `ingest_batch_recoveries_set_keys_update` BEFORE UPDATE ON `ingest_batch_recoveries` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`request_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`request_key`), ':', NEW.`request_key`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL AND NEW.`generation` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`, OCTET_LENGTH(NEW.`generation`), ':', NEW.`generation`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`batch_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`batch_id`), ':', NEW.`batch_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`actor_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`actor_principal_id`), ':', NEW.`actor_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_ingest_trace_batches` ON `ingest_batch_traces` (`workspace_id`(120), `trace_id`(120), `batch_id`(120));

-- next statement

ALTER TABLE `ingest_deliveries` ADD FOREIGN KEY (`_key_1`) REFERENCES `ingest_batches` (`_key_1`);

-- next statement

ALTER TABLE `ingest_deliveries` ADD FOREIGN KEY (`_key_2`) REFERENCES `outbox_events` (`_key_1`);

-- next statement

ALTER TABLE `ingest_batch_traces` ADD FOREIGN KEY (`_key_2`) REFERENCES `ingest_deliveries` (`_key_1`);

-- next statement

ALTER TABLE `ingest_batch_traces` ADD FOREIGN KEY (`_key_3`) REFERENCES `trace_locators` (`_key_1`);

-- next statement

ALTER TABLE `ingest_batch_recoveries` ADD FOREIGN KEY (`_key_3`) REFERENCES `ingest_deliveries` (`_key_1`);

-- next statement

ALTER TABLE `ingest_batch_recoveries` ADD FOREIGN KEY (`_key_4`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

INSERT INTO ingest_deliveries(workspace_id,batch_id,event_id,last_error_code,last_error_at_ms)
 SELECT b.workspace_id,b.batch_id,e.event_id,b.error_code,
 CASE WHEN b.state='failed' THEN e.updated_at_ms ELSE NULL END
 FROM ingest_batches b LEFT JOIN outbox_events e ON e.workspace_id=b.workspace_id
 AND e.aggregate_id=b.batch_id AND e.event_type='observability.otlp.accepted.v1';

-- next statement

INSERT INTO ingest_batch_traces(workspace_id,batch_id,trace_id) SELECT b.workspace_id,b.batch_id,j.trace_id FROM ingest_batches b JOIN JSON_TABLE(b.trace_ids_json, '$[*]' COLUMNS (trace_id TEXT PATH '$')) AS j ON 1=1;

-- next statement

UPDATE ingest_batch_traces SET blocks_successors=0 WHERE EXISTS (
 SELECT 1 FROM ingest_batches failed
 JOIN ingest_deliveries fd ON fd.workspace_id=failed.workspace_id AND fd.batch_id=failed.batch_id
 JOIN outbox_events fe ON fe.workspace_id=fd.workspace_id AND fe.event_id=fd.event_id
 JOIN ingest_batch_traces successor ON successor.workspace_id=failed.workspace_id AND successor.trace_id=ingest_batch_traces.trace_id
 JOIN ingest_batches prepared ON prepared.workspace_id=successor.workspace_id AND prepared.batch_id=successor.batch_id
 JOIN ingest_deliveries pd ON pd.workspace_id=prepared.workspace_id AND pd.batch_id=prepared.batch_id
 JOIN outbox_events pe ON pe.workspace_id=pd.workspace_id AND pe.event_id=pd.event_id
 WHERE failed.workspace_id=ingest_batch_traces.workspace_id AND failed.batch_id=ingest_batch_traces.batch_id
 AND failed.state='failed' AND failed.plan_ref IS NULL AND prepared.plan_ref IS NOT NULL
 AND (pe.created_at_ms>fe.created_at_ms OR (pe.created_at_ms=fe.created_at_ms AND pe.event_id>fe.event_id))
);

-- next statement

CREATE OR REPLACE TRIGGER `ingest_batches_ledger_guard` BEFORE UPDATE ON `ingest_batches` FOR EACH ROW
BEGIN
  IF NOT (NEW.workspace_id <=> OLD.workspace_id) OR NOT (NEW.batch_id <=> OLD.batch_id) OR NOT (NEW.principal_id <=> OLD.principal_id) OR NOT (NEW.receipt_key <=> OLD.receipt_key) OR NOT (NEW.packet_hash <=> OLD.packet_hash) OR NOT (NEW.packet_ref <=> OLD.packet_ref) OR NOT (NEW.trace_ids_json <=> OLD.trace_ids_json) OR NOT (NEW.accepted_at_ms <=> OLD.accepted_at_ms) OR (OLD.plan_ref IS NOT NULL AND NOT (NEW.plan_ref <=> OLD.plan_ref)) OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','indexed','failed')) OR ((OLD.state IN ('indexed','failed') AND (NEW.state<>OLD.state OR NOT (NEW.indexed_at_ms <=> OLD.indexed_at_ms) OR NOT (NEW.error_code <=> OLD.error_code))) AND NOT (OLD.state='failed' AND NEW.state=CASE WHEN OLD.plan_ref IS NULL THEN 'accepted' ELSE 'prepared' END AND NEW.error_code IS NULL AND (NEW.indexed_at_ms <=> OLD.indexed_at_ms) AND EXISTS(SELECT 1 FROM ingest_deliveries d JOIN ingest_batch_recoveries r ON r.workspace_id=d.workspace_id AND r.batch_id=d.batch_id AND r.generation=d.generation JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id WHERE d.workspace_id=OLD.workspace_id AND d.batch_id=OLD.batch_id AND (r.previous_error_code <=> OLD.error_code) AND r.previous_attempts=e.attempts AND d.attempt_base=e.attempts))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'observation ledger immutable or stale';
  END IF;
END;
