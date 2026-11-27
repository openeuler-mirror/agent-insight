CREATE TABLE `iam_principals` (
  `principal_id` LONGTEXT NOT NULL,
  `normalized_login_name` LONGTEXT NOT NULL,
  `display_name` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'active',
  `auth_version` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (`status` IN ('active','disabled')),
  CHECK (CHAR_LENGTH(normalized_login_name) > 0),
  CHECK (normalized_login_name = trim(normalized_login_name)),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`principal_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`normalized_login_name`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_password_credentials` (
  `principal_id` LONGTEXT NOT NULL,
  `password_hash` LONGTEXT NOT NULL,
  `scheme` LONGTEXT NOT NULL,
  `parameters_json` LONGTEXT NOT NULL,
  `credential_version` BIGINT NOT NULL DEFAULT 1,
  `changed_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(scheme) > 0),
  CHECK (CHAR_LENGTH(parameters_json) > 0),
  CHECK (credential_version > 0 AND credential_version <= 9223372036854775807),
  CHECK (changed_at_ms >= 0),
  CHECK (CHAR_LENGTH(password_hash) = 64 AND BINARY password_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`principal_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_api_credentials` (
  `credential_id` LONGTEXT NOT NULL,
  `principal_id` LONGTEXT NOT NULL,
  `workspace_id` LONGTEXT NOT NULL,
  `token_hash` LONGTEXT NOT NULL,
  `capabilities_json` LONGTEXT NOT NULL,
  `auth_version` BIGINT NOT NULL,
  `issued_at_ms` BIGINT NOT NULL,
  `expires_at_ms` BIGINT NOT NULL,
  `revoked_at_ms` BIGINT,
  CHECK (expires_at_ms >= issued_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (issued_at_ms >= 0),
  CHECK (expires_at_ms >= 0),
  CHECK (revoked_at_ms >= 0),
  CHECK (CHAR_LENGTH(token_hash) = 64 AND BINARY token_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  `_key_4` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`credential_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`token_hash`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_external_identities` (
  `external_identity_id` LONGTEXT NOT NULL,
  `principal_id` LONGTEXT NOT NULL,
  `provider` LONGTEXT NOT NULL,
  `issuer` LONGTEXT NOT NULL,
  `subject` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (CHAR_LENGTH(provider) > 0),
  CHECK (CHAR_LENGTH(issuer) > 0),
  CHECK (CHAR_LENGTH(subject) > 0),
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`external_identity_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`provider`(120), `issuer`(120), `subject`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_sessions` (
  `session_id` LONGTEXT NOT NULL,
  `principal_id` LONGTEXT NOT NULL,
  `session_token_hash` LONGTEXT NOT NULL,
  `auth_version` BIGINT NOT NULL,
  `issued_at_ms` BIGINT NOT NULL,
  `expires_at_ms` BIGINT NOT NULL,
  `revoked_at_ms` BIGINT,
  CHECK (expires_at_ms >= issued_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms),
  CHECK (auth_version > 0 AND auth_version <= 9223372036854775807),
  CHECK (issued_at_ms >= 0),
  CHECK (expires_at_ms >= 0),
  CHECK (revoked_at_ms >= 0),
  CHECK (CHAR_LENGTH(session_token_hash) = 64 AND BINARY session_token_hash NOT REGEXP '[^0-9a-f]'),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`session_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`session_token_hash`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_groups` (
  `group_id` LONGTEXT NOT NULL,
  `group_key` LONGTEXT NOT NULL,
  `name` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'active',
  `created_by` LONGTEXT NOT NULL,
  `policy_revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (`status` IN ('active','disabled')),
  CHECK (CHAR_LENGTH(group_key) > 0),
  CHECK (policy_revision > 0 AND policy_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`group_id`(120)),
  UNIQUE (`_key_2`),
  KEY `_lookup_3` (`group_key`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_group_memberships` (
  `group_id` LONGTEXT NOT NULL,
  `principal_id` LONGTEXT NOT NULL,
  `role` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT 'active',
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (`role` IN ('owner','admin','member','viewer')),
  CHECK (`status` IN ('active','disabled')),
  CHECK (etag > 0 AND etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`group_id`(120), `principal_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_workspace_bindings` (
  `workspace_id` LONGTEXT NOT NULL,
  `owner_type` LONGTEXT NOT NULL,
  `owner_group_id` LONGTEXT,
  `owner_principal_id` LONGTEXT,
  `binding_revision` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK ((owner_type = 'group' AND owner_group_id IS NOT NULL AND owner_principal_id IS NULL) OR (owner_type = 'personal' AND owner_principal_id IS NOT NULL AND owner_group_id IS NULL)),
  CHECK (binding_revision > 0 AND binding_revision <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_resource_access` (
  `workspace_id` LONGTEXT NOT NULL,
  `resource_kind` LONGTEXT NOT NULL,
  `resource_id` LONGTEXT NOT NULL,
  `owner_principal_id` LONGTEXT NOT NULL,
  `visibility` LONGTEXT NOT NULL DEFAULT 'private',
  `etag` BIGINT NOT NULL DEFAULT 1,
  `created_at_ms` BIGINT NOT NULL,
  `updated_at_ms` BIGINT NOT NULL,
  CHECK (resource_kind IN ('trace','asset','run','snapshot','artifact')),
  CHECK (visibility IN ('private','group')),
  CHECK (CHAR_LENGTH(resource_id) > 0),
  CHECK (etag > 0 AND etag <= 9223372036854775807),
  CHECK (created_at_ms >= 0),
  CHECK (updated_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `resource_kind`(120), `resource_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TABLE `iam_resource_grants` (
  `workspace_id` LONGTEXT NOT NULL,
  `resource_kind` LONGTEXT NOT NULL,
  `resource_id` LONGTEXT NOT NULL,
  `grantee_principal_id` LONGTEXT NOT NULL,
  `created_at_ms` BIGINT NOT NULL,
  CHECK (created_at_ms >= 0),
  `_key_1` BINARY(32) INVISIBLE NOT NULL DEFAULT '',
  `_key_2` BINARY(32) INVISIBLE,
  `_key_3` BINARY(32) INVISIBLE,
  PRIMARY KEY (`_key_1`),
  KEY `_lookup_1` (`workspace_id`(120), `resource_kind`(120), `resource_id`(120), `grantee_principal_id`(120))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;

-- next statement

CREATE TRIGGER `iam_principals_set_keys_insert` BEFORE INSERT ON `iam_principals` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`normalized_login_name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`normalized_login_name`), ':', NEW.`normalized_login_name`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_principals_set_keys_update` BEFORE UPDATE ON `iam_principals` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`normalized_login_name` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`normalized_login_name`), ':', NEW.`normalized_login_name`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_password_credentials_set_keys_insert` BEFORE INSERT ON `iam_password_credentials` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_password_credentials_set_keys_update` BEFORE UPDATE ON `iam_password_credentials` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_api_credentials_set_keys_insert` BEFORE INSERT ON `iam_api_credentials` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`credential_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`credential_id`), ':', NEW.`credential_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`token_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`token_hash`), ':', NEW.`token_hash`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_api_credentials_set_keys_update` BEFORE UPDATE ON `iam_api_credentials` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`credential_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`credential_id`), ':', NEW.`credential_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`token_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`token_hash`), ':', NEW.`token_hash`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_4` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_external_identities_set_keys_insert` BEFORE INSERT ON `iam_external_identities` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`external_identity_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`external_identity_id`), ':', NEW.`external_identity_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`provider` IS NOT NULL AND NEW.`issuer` IS NOT NULL AND NEW.`subject` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`provider`), ':', NEW.`provider`, OCTET_LENGTH(NEW.`issuer`), ':', NEW.`issuer`, OCTET_LENGTH(NEW.`subject`), ':', NEW.`subject`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_external_identities_set_keys_update` BEFORE UPDATE ON `iam_external_identities` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`external_identity_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`external_identity_id`), ':', NEW.`external_identity_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`provider` IS NOT NULL AND NEW.`issuer` IS NOT NULL AND NEW.`subject` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`provider`), ':', NEW.`provider`, OCTET_LENGTH(NEW.`issuer`), ':', NEW.`issuer`, OCTET_LENGTH(NEW.`subject`), ':', NEW.`subject`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_sessions_set_keys_insert` BEFORE INSERT ON `iam_sessions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`session_token_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`session_token_hash`), ':', NEW.`session_token_hash`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_sessions_set_keys_update` BEFORE UPDATE ON `iam_sessions` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`session_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`session_id`), ':', NEW.`session_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`session_token_hash` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`session_token_hash`), ':', NEW.`session_token_hash`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_groups_set_keys_insert` BEFORE INSERT ON `iam_groups` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`group_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_key`), ':', NEW.`group_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_groups_set_keys_update` BEFORE UPDATE ON `iam_groups` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`group_key` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_key`), ':', NEW.`group_key`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`created_by` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`created_by`), ':', NEW.`created_by`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_group_memberships_set_keys_insert` BEFORE INSERT ON `iam_group_memberships` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`group_id` IS NOT NULL AND NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`, OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_group_memberships_set_keys_update` BEFORE UPDATE ON `iam_group_memberships` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`group_id` IS NOT NULL AND NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`, OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`group_id`), ':', NEW.`group_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`principal_id`), ':', NEW.`principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_workspace_bindings_set_keys_insert` BEFORE INSERT ON `iam_workspace_bindings` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`owner_group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_group_id`), ':', NEW.`owner_group_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_workspace_bindings_set_keys_update` BEFORE UPDATE ON `iam_workspace_bindings` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`owner_group_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_group_id`), ':', NEW.`owner_group_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_resource_access_set_keys_insert` BEFORE INSERT ON `iam_resource_access` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_resource_access_set_keys_update` BEFORE UPDATE ON `iam_resource_access` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`owner_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`owner_principal_id`), ':', NEW.`owner_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_resource_grants_set_keys_insert` BEFORE INSERT ON `iam_resource_grants` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL AND NEW.`grantee_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`, OCTET_LENGTH(NEW.`grantee_principal_id`), ':', NEW.`grantee_principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`grantee_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`grantee_principal_id`), ':', NEW.`grantee_principal_id`), 256)), NULL);
END;

-- next statement

CREATE TRIGGER `iam_resource_grants_set_keys_update` BEFORE UPDATE ON `iam_resource_grants` FOR EACH ROW
BEGIN
  SET NEW.`_key_1` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL AND NEW.`grantee_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`, OCTET_LENGTH(NEW.`grantee_principal_id`), ':', NEW.`grantee_principal_id`), 256)), NULL);
  SET NEW.`_key_2` = IF(NEW.`workspace_id` IS NOT NULL AND NEW.`resource_kind` IS NOT NULL AND NEW.`resource_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`workspace_id`), ':', NEW.`workspace_id`, OCTET_LENGTH(NEW.`resource_kind`), ':', NEW.`resource_kind`, OCTET_LENGTH(NEW.`resource_id`), ':', NEW.`resource_id`), 256)), NULL);
  SET NEW.`_key_3` = IF(NEW.`grantee_principal_id` IS NOT NULL, UNHEX(SHA2(CONCAT(OCTET_LENGTH(NEW.`grantee_principal_id`), ':', NEW.`grantee_principal_id`), 256)), NULL);
END;

-- next statement

CREATE INDEX `idx_iam_api_credentials_principal_scope` ON `iam_api_credentials` (`principal_id`(120), `workspace_id`(120), `revoked_at_ms`);

-- next statement

CREATE INDEX `idx_iam_api_credentials_expiry` ON `iam_api_credentials` (`expires_at_ms`);

-- next statement

CREATE INDEX `idx_iam_external_identities_principal` ON `iam_external_identities` (`principal_id`(120));

-- next statement

CREATE INDEX `idx_iam_sessions_principal` ON `iam_sessions` (`principal_id`(120), `revoked_at_ms`);

-- next statement

CREATE INDEX `idx_iam_sessions_expiry` ON `iam_sessions` (`expires_at_ms`);

-- next statement

CREATE INDEX `idx_iam_groups_created_by` ON `iam_groups` (`created_by`(120));

-- next statement

CREATE INDEX `idx_iam_group_memberships_principal` ON `iam_group_memberships` (`principal_id`(120), `status`(120), `group_id`(120));

-- next statement

CREATE INDEX `idx_iam_group_memberships_owners` ON `iam_group_memberships` (`group_id`(120), `role`(120), `status`(120));

-- next statement

CREATE INDEX `idx_iam_workspace_bindings_group` ON `iam_workspace_bindings` (`owner_group_id`(120));

-- next statement

CREATE INDEX `idx_iam_workspace_bindings_principal` ON `iam_workspace_bindings` (`owner_principal_id`(120));

-- next statement

CREATE INDEX `idx_iam_resource_access_owner` ON `iam_resource_access` (`owner_principal_id`(120), `workspace_id`(120), `resource_kind`(120));

-- next statement

CREATE INDEX `idx_iam_resource_access_visibility` ON `iam_resource_access` (`workspace_id`(120), `visibility`(120), `resource_kind`(120));

-- next statement

CREATE INDEX `idx_iam_resource_grants_principal` ON `iam_resource_grants` (`grantee_principal_id`(120), `workspace_id`(120), `resource_kind`(120));

-- next statement

CREATE TRIGGER `iam_membership_insert_policy` BEFORE INSERT ON `iam_group_memberships` FOR EACH ROW
BEGIN
  UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=NEW.group_id;
END;

-- next statement

CREATE TRIGGER `iam_membership_update_guard` BEFORE UPDATE ON `iam_group_memberships` FOR EACH ROW
BEGIN
  IF OLD.group_id<>NEW.group_id OR OLD.principal_id<>NEW.principal_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'membership identity immutable'; END IF;
  UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=OLD.group_id;
  IF OLD.`role`='owner' AND OLD.`status`='active' AND EXISTS (SELECT 1 FROM iam_principals p WHERE p.principal_id=OLD.principal_id AND p.`status`='active') AND EXISTS (SELECT 1 FROM iam_groups g WHERE g.group_id=OLD.group_id AND g.`status`='active') AND (NEW.`role`<>'owner' OR NEW.`status`<>'active') AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.principal_id<>OLD.principal_id AND m.`role`='owner' AND m.`status`='active' AND p.`status`='active') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last active group owner'; END IF;
END;

-- next statement

CREATE TRIGGER `iam_membership_delete_guard` BEFORE DELETE ON `iam_group_memberships` FOR EACH ROW
BEGIN
  UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id=OLD.group_id;
  IF OLD.`role`='owner' AND OLD.`status`='active' AND EXISTS (SELECT 1 FROM iam_principals p WHERE p.principal_id=OLD.principal_id AND p.`status`='active') AND EXISTS (SELECT 1 FROM iam_groups g WHERE g.group_id=OLD.group_id AND g.`status`='active') AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.principal_id<>OLD.principal_id AND m.`role`='owner' AND m.`status`='active' AND p.`status`='active') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last active group owner'; END IF;
END;

-- next statement

CREATE TRIGGER `iam_principal_update_owner_guard` BEFORE UPDATE ON `iam_principals` FOR EACH ROW
BEGIN
  IF OLD.`status`<>NEW.`status` OR OLD.principal_id<>NEW.principal_id THEN
    IF OLD.principal_id<>NEW.principal_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'principal identity immutable'; END IF;
    UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id IN (SELECT group_id FROM iam_group_memberships WHERE principal_id=OLD.principal_id);
    IF OLD.`status`='active' AND NEW.`status`='disabled' AND EXISTS (SELECT 1 FROM iam_group_memberships mine JOIN iam_groups g ON g.group_id=mine.group_id WHERE mine.principal_id=OLD.principal_id AND mine.`role`='owner' AND mine.`status`='active' AND g.`status`='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships other JOIN iam_principals p ON p.principal_id=other.principal_id WHERE other.group_id=mine.group_id AND other.principal_id<>OLD.principal_id AND other.`role`='owner' AND other.`status`='active' AND p.`status`='active')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last active group owner'; END IF;
  END IF;
END;

-- next statement

CREATE TRIGGER `iam_principal_delete_owner_guard` BEFORE DELETE ON `iam_principals` FOR EACH ROW
BEGIN
  UPDATE iam_groups SET policy_revision=policy_revision+1 WHERE group_id IN (SELECT group_id FROM iam_group_memberships WHERE principal_id=OLD.principal_id);
  IF OLD.`status`='active' AND EXISTS (SELECT 1 FROM iam_group_memberships mine JOIN iam_groups g ON g.group_id=mine.group_id WHERE mine.principal_id=OLD.principal_id AND mine.`role`='owner' AND mine.`status`='active' AND g.`status`='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships other JOIN iam_principals p ON p.principal_id=other.principal_id WHERE other.group_id=mine.group_id AND other.principal_id<>OLD.principal_id AND other.`role`='owner' AND other.`status`='active' AND p.`status`='active')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last active group owner'; END IF;
END;

-- next statement

CREATE TRIGGER `iam_binding_ownership_immutable` BEFORE UPDATE ON `iam_workspace_bindings` FOR EACH ROW
BEGIN
  IF NOT (OLD.workspace_id <=> NEW.workspace_id) OR NOT (OLD.owner_type <=> NEW.owner_type) OR NOT (OLD.owner_group_id <=> NEW.owner_group_id) OR NOT (OLD.owner_principal_id <=> NEW.owner_principal_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workspace ownership immutable';
  END IF;
END;

-- next statement

CREATE TRIGGER `iam_group_reenable_guard` BEFORE UPDATE ON `iam_groups` FOR EACH ROW
BEGIN
  IF OLD.group_id<>NEW.group_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'group identity immutable'; END IF;
  IF OLD.`status`='disabled' AND NEW.`status`='active' AND NOT EXISTS (SELECT 1 FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id=OLD.group_id AND m.`role`='owner' AND m.`status`='active' AND p.`status`='active') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'active group requires owner'; END IF;
END;

-- next statement

CREATE TRIGGER `iam_binding_no_delete` BEFORE DELETE ON `iam_workspace_bindings` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workspace ownership immutable';
END;

-- next statement

ALTER TABLE `iam_password_credentials` ADD FOREIGN KEY (`_key_1`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_api_credentials` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_api_credentials` ADD FOREIGN KEY (`_key_4`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `iam_external_identities` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_sessions` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_groups` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_group_memberships` ADD FOREIGN KEY (`_key_2`) REFERENCES `iam_groups` (`_key_1`);

-- next statement

ALTER TABLE `iam_group_memberships` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_workspace_bindings` ADD FOREIGN KEY (`_key_1`) REFERENCES `workspaces` (`_key_1`);

-- next statement

ALTER TABLE `iam_workspace_bindings` ADD FOREIGN KEY (`_key_2`) REFERENCES `iam_groups` (`_key_1`);

-- next statement

ALTER TABLE `iam_workspace_bindings` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_resource_access` ADD FOREIGN KEY (`_key_2`) REFERENCES `iam_workspace_bindings` (`_key_1`);

-- next statement

ALTER TABLE `iam_resource_access` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);

-- next statement

ALTER TABLE `iam_resource_grants` ADD FOREIGN KEY (`_key_2`) REFERENCES `iam_resource_access` (`_key_1`);

-- next statement

ALTER TABLE `iam_resource_grants` ADD FOREIGN KEY (`_key_3`) REFERENCES `iam_principals` (`_key_1`);
