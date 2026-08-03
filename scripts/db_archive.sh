#!/usr/bin/env bash

set -euo pipefail

ARCHIVE_FORMAT="agent-insight.db-archive"
ARCHIVE_VERSION="1"
DEFAULT_DB_NAME="witty_insight.db"
TEMP_DIR=""
COPIED_TABLES=()

usage() {
  cat <<'EOF'
Agent Insight SQLite data archive

Usage:
  bash db_archive.sh create --scope <traces|infra-metrics> \
    (--before <ISO-8601> | --from <ISO-8601> --to <ISO-8601>) \
    --output <directory|file.sqlite.gz> [--user <username>] \
    [--database <file>] [--keep-source] [--dry-run]

  bash db_archive.sh inspect --input <file.sqlite.gz>

  bash db_archive.sh import --input <file.sqlite.gz> \
    [--database <file>] [--dry-run]

Time windows use [from, to) semantics. YYYY-MM-DD uses local midnight.
Date-time values must include Z or a numeric timezone offset.
The default database is ~/.agent-insight/data/witty_insight.db.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sql_quote() {
  printf '%s' "${1//\'/\'\'}"
}

canonical_existing_file() {
  local input_path="$1"
  local parent
  [[ -f "$input_path" ]] || die "file not found: $input_path"
  parent="$(cd "$(dirname "$input_path")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$input_path")"
}

canonical_output_path() {
  local input_path="$1"
  local parent
  mkdir -p -- "$(dirname "$input_path")"
  parent="$(cd "$(dirname "$input_path")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$input_path")"
}

hash_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

table_exists() {
  local db_path="$1"
  local table_name="$2"
  [[ "$(sqlite3 -readonly "$db_path" "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='$(sql_quote "$table_name")';")" == "1" ]]
}

add_copied_table() {
  local table_name="$1"
  local existing
  for existing in "${COPIED_TABLES[@]:-}"; do
    [[ "$existing" == "$table_name" ]] && return
  done
  COPIED_TABLES+=("$table_name")
}

copy_table_where() {
  local snapshot_db="$1"
  local archive_db="$2"
  local table_name="$3"
  local condition="$4"
  local snapshot_sql

  table_exists "$snapshot_db" "$table_name" || return 0
  table_exists "$archive_db" "$table_name" || return 0
  snapshot_sql="$(sql_quote "$snapshot_db")"
  sqlite3 -batch -bail "$archive_db" "
    ATTACH DATABASE '$snapshot_sql' AS source;
    INSERT INTO main.\"$table_name\"
    SELECT s.* FROM source.\"$table_name\" AS s
    WHERE $condition;
    DETACH DATABASE source;
  "
  add_copied_table "$table_name"
}

validate_iso_time() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && return
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] \
    || die "time must be YYYY-MM-DD or ISO-8601 with timezone: $value"
}

iso_to_millis() {
  local value="$1"
  local quoted_value
  local seconds
  local fraction_digits=""
  local fraction_ms="0"
  validate_iso_time "$value"
  quoted_value="$(sql_quote "$value")"
  if [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    seconds="$(sqlite3 :memory: "SELECT strftime('%s', '$quoted_value 00:00:00', 'utc');")"
  else
    seconds="$(sqlite3 :memory: "SELECT strftime('%s', '$quoted_value');")"
  fi
  [[ "$seconds" =~ ^-?[0-9]+$ ]] || die "invalid timestamp: $value"
  if [[ "$value" =~ \.([0-9]+)(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
    fraction_digits="${BASH_REMATCH[1]}000"
    fraction_ms="${fraction_digits:0:3}"
    fraction_ms="$((10#$fraction_ms))"
  fi
  printf '%s\n' "$((seconds * 1000 + fraction_ms))"
}

resolve_database_path() {
  local explicit_path="$1"
  local database_url="${DATABASE_URL:-}"
  local resolved

  if [[ -n "$explicit_path" ]]; then
    resolved="$explicit_path"
  else
    [[ -z "${DB_HOST:-}" ]] || die "this script supports SQLite only; DB_HOST is set"
    if [[ -z "$database_url" || "$database_url" == "file:../data/$DEFAULT_DB_NAME" ]]; then
      resolved="${HOME:?HOME is not set}/.agent-insight/data/$DEFAULT_DB_NAME"
    elif [[ "$database_url" == file:* ]]; then
      resolved="${database_url#file:}"
      resolved="${resolved%%\?*}"
      if [[ "$resolved" != /* ]]; then
        resolved="$(pwd -P)/$resolved"
      fi
    else
      die "DATABASE_URL must be a SQLite file: URL"
    fi
  fi

  canonical_existing_file "$resolved"
}

schema_hash() {
  local db_path="$1"
  local schema_file="$2"
  sqlite3 -readonly -separator '|' "$db_path" "
    SELECT type, name, tbl_name, COALESCE(sql, '')
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_ai_%'
    ORDER BY type, name;
  " > "$schema_file"
  [[ -s "$schema_file" ]] || die "database schema is empty: $db_path"
  hash_file "$schema_file"
}

create_consistent_snapshot() {
  local source_db="$1"
  local snapshot_db="$2"
  local quoted_snapshot
  quoted_snapshot="$(sql_quote "$snapshot_db")"
  sqlite3 -readonly -batch -bail "$source_db" "VACUUM INTO '$quoted_snapshot';"
}

initialize_archive_schema() {
  local snapshot_db="$1"
  local archive_db="$2"
  local schema_file="$3"
  sqlite3 -readonly "$snapshot_db" ".schema" > "$schema_file"
  sqlite3 -batch -bail "$archive_db" < "$schema_file"
  sqlite3 -batch -bail "$archive_db" "
    CREATE TABLE _ai_archive_manifest (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE _ai_archive_counts (
      table_name TEXT PRIMARY KEY,
      row_count INTEGER NOT NULL
    );
    CREATE TABLE _ai_selected_root (id TEXT PRIMARY KEY);
    CREATE TABLE _ai_selected_execution (id TEXT PRIMARY KEY);
    CREATE TABLE _ai_selected_metric (id TEXT PRIMARY KEY);
  "
}

select_trace_ids() {
  local snapshot_db="$1"
  local archive_db="$2"
  local from_ms="$3"
  local to_ms="$4"
  local archive_user="$5"
  local snapshot_sql
  local user_condition=""
  snapshot_sql="$(sql_quote "$snapshot_db")"
  if [[ -n "$archive_user" ]]; then
    user_condition="AND user = '$(sql_quote "$archive_user")'"
  fi
  sqlite3 -batch -bail "$archive_db" "
    ATTACH DATABASE '$snapshot_sql' AS source;
    INSERT INTO _ai_selected_root(id)
    SELECT id
    FROM source.\"Execution\"
    WHERE COALESCE(isSubagent, 0) = 0
      $user_condition
      AND timestamp >= $from_ms
      AND timestamp < $to_ms;

    INSERT OR IGNORE INTO _ai_selected_execution(id)
    SELECT id FROM _ai_selected_root;

    INSERT OR IGNORE INTO _ai_selected_execution(id)
    SELECT e.id
    FROM source.\"Execution\" e
    WHERE e.rootExecutionId IN (SELECT id FROM _ai_selected_root);

    WITH RECURSIVE execution_tree(id) AS (
      SELECT id FROM _ai_selected_root
      UNION
      SELECT child.id
      FROM source.\"Execution\" child
      JOIN execution_tree parent ON child.parentExecutionId = parent.id
    )
    INSERT OR IGNORE INTO _ai_selected_execution(id)
    SELECT id FROM execution_tree;
    DETACH DATABASE source;
  "
}

copy_trace_archive() {
  local snapshot_db="$1"
  local archive_db="$2"

  copy_table_where "$snapshot_db" "$archive_db" "Execution" \
    's.id IN (SELECT id FROM main._ai_selected_execution)'
  copy_table_where "$snapshot_db" "$archive_db" "Session" \
    's.taskId IN (SELECT taskId FROM main."Execution" WHERE taskId IS NOT NULL)'
  copy_table_where "$snapshot_db" "$archive_db" "TraceEvaluation" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "ExecutionSkill" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "ExecutionTag" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "Evaluation" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "SkillIssue" \
    's.evaluationId IN (SELECT id FROM main."Evaluation")'
  copy_table_where "$snapshot_db" "$archive_db" "ExecutionMatch" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "FaultDiagnosisSession" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "FaultDiagnosisMessage" \
    's.sessionId IN (SELECT id FROM main."FaultDiagnosisSession")'
  copy_table_where "$snapshot_db" "$archive_db" "AgentDebugReport" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "AgentDebugSkillsAnalysis" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "TrajectoryEvalResult" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "SessionInfraLink" \
    's.rootExecutionId IN (SELECT id FROM main._ai_selected_root)'
  copy_table_where "$snapshot_db" "$archive_db" "ExperimentCase" \
    's.executionId IN (SELECT id FROM main."Execution")'
  copy_table_where "$snapshot_db" "$archive_db" "ExperimentEvalResult" \
    's.caseId IN (SELECT id FROM main."ExperimentCase")'
  copy_table_where "$snapshot_db" "$archive_db" "ExperimentEvalComment" \
    's.caseId IN (SELECT id FROM main."ExperimentCase")
      OR s.resultId IN (SELECT id FROM main."ExperimentEvalResult")'

  copy_table_where "$snapshot_db" "$archive_db" "Skill" \
    's.id IN (SELECT skillId FROM main."Evaluation")
      OR s.id IN (SELECT skillId FROM main."SkillIssue")'
  copy_table_where "$snapshot_db" "$archive_db" "SkillVersion" \
    's.skillId IN (SELECT id FROM main."Skill")'
  copy_table_where "$snapshot_db" "$archive_db" "Tag" \
    's.id IN (SELECT tagId FROM main."ExecutionTag")'
  copy_table_where "$snapshot_db" "$archive_db" "InfraSource" \
    's.id IN (SELECT sourceId FROM main."SessionInfraLink")'
  copy_table_where "$snapshot_db" "$archive_db" "Experiment" \
    's.id IN (SELECT experimentId FROM main."ExperimentCase")'
}

select_metric_ids() {
  local snapshot_db="$1"
  local archive_db="$2"
  local from_ms="$3"
  local to_ms="$4"
  local snapshot_sql
  snapshot_sql="$(sql_quote "$snapshot_db")"
  sqlite3 -batch -bail "$archive_db" "
    ATTACH DATABASE '$snapshot_sql' AS source;
    INSERT INTO _ai_selected_metric(id)
    SELECT id
    FROM source.\"InfraMetricSample\"
    WHERE tsMs >= $from_ms AND tsMs < $to_ms;
    DETACH DATABASE source;
  "
}

copy_metric_archive() {
  local snapshot_db="$1"
  local archive_db="$2"
  copy_table_where "$snapshot_db" "$archive_db" "InfraMetricSample" \
    's.id IN (SELECT id FROM main._ai_selected_metric)'
  copy_table_where "$snapshot_db" "$archive_db" "InfraSource" \
    's.id IN (SELECT sourceId FROM main."InfraMetricSample")'
}

write_archive_metadata() {
  local archive_db="$1"
  local scope="$2"
  local from_iso="$3"
  local to_iso="$4"
  local from_ms="$5"
  local to_ms="$6"
  local source_db="$7"
  local source_schema_hash="$8"
  local purge_requested="$9"
  local archive_user="${10}"
  local manifest_user="${archive_user:-<all-users>}"
  local created_at
  local agent_insight_version
  local table_name

  created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  agent_insight_version="${AGENT_INSIGHT_VERSION:-unknown}"

  sqlite3 -batch -bail "$archive_db" "
    INSERT INTO _ai_archive_manifest(key, value) VALUES
      ('format', '$(sql_quote "$ARCHIVE_FORMAT")'),
      ('version', '$(sql_quote "$ARCHIVE_VERSION")'),
      ('createdAt', '$(sql_quote "$created_at")'),
      ('scope', '$(sql_quote "$scope")'),
      ('user', '$(sql_quote "$manifest_user")'),
      ('from', '$(sql_quote "$from_iso")'),
      ('to', '$(sql_quote "$to_iso")'),
      ('fromMs', '$(sql_quote "$from_ms")'),
      ('toMs', '$(sql_quote "$to_ms")'),
      ('sourceDatabaseName', '$(sql_quote "$(basename "$source_db")")'),
      ('schemaHash', '$(sql_quote "$source_schema_hash")'),
      ('agentInsightVersion', '$(sql_quote "$agent_insight_version")'),
      ('purgeRequested', '$(sql_quote "$purge_requested")');
  "

  for table_name in "${COPIED_TABLES[@]:-}"; do
    sqlite3 -batch -bail "$archive_db" "
      INSERT INTO _ai_archive_counts(table_name, row_count)
      VALUES ('$(sql_quote "$table_name")', (SELECT COUNT(*) FROM \"$table_name\"));
    "
  done
}

verify_archive_database() {
  local archive_db="$1"
  local integrity
  local format
  local version
  local fk_errors

  integrity="$(sqlite3 -readonly "$archive_db" "PRAGMA integrity_check;")"
  [[ "$integrity" == "ok" ]] || die "archive integrity check failed: $integrity"
  fk_errors="$(sqlite3 -readonly "$archive_db" "PRAGMA foreign_key_check;")"
  [[ -z "$fk_errors" ]] || die "archive foreign key check failed: $fk_errors"
  format="$(sqlite3 -readonly "$archive_db" "SELECT value FROM _ai_archive_manifest WHERE key='format';")"
  version="$(sqlite3 -readonly "$archive_db" "SELECT value FROM _ai_archive_manifest WHERE key='version';")"
  [[ "$format" == "$ARCHIVE_FORMAT" ]] || die "unsupported archive format: $format"
  [[ "$version" == "$ARCHIVE_VERSION" ]] || die "unsupported archive version: $version"
}

write_compressed_archive() {
  local archive_db="$1"
  local final_file="$2"
  local partial_file="${final_file}.partial"
  local sidecar="${final_file}.sha256"
  local sidecar_partial="${sidecar}.partial"
  local expected_hash
  local verification_db="$TEMP_DIR/compressed-verification.sqlite"

  [[ ! -e "$final_file" ]] || die "archive already exists: $final_file"
  [[ ! -e "$sidecar" ]] || die "checksum file already exists: $sidecar"

  gzip -c "$archive_db" > "$partial_file"
  gzip -t "$partial_file"
  gzip -dc "$partial_file" > "$verification_db"
  verify_archive_database "$verification_db"
  expected_hash="$(hash_file "$partial_file")"
  printf '%s  %s\n' "$expected_hash" "$(basename "$final_file")" > "$sidecar_partial"
  mv -- "$partial_file" "$final_file"
  mv -- "$sidecar_partial" "$sidecar"
}

decompress_and_verify_archive() {
  local input_file="$1"
  local output_db="$2"
  local sidecar="${input_file}.sha256"
  local expected_hash
  local actual_hash

  if [[ -f "$sidecar" ]]; then
    expected_hash="$(awk 'NR == 1 {print $1}' "$sidecar")"
    actual_hash="$(hash_file "$input_file")"
    [[ -n "$expected_hash" && "$expected_hash" == "$actual_hash" ]] \
      || die "archive checksum mismatch: $input_file"
  else
    note "Warning: checksum sidecar not found: $sidecar"
  fi

  gzip -t "$input_file"
  gzip -dc "$input_file" > "$output_db"
  verify_archive_database "$output_db"
}

table_columns() {
  local db_path="$1"
  local table_name="$2"
  local alias="$3"
  local result=""
  local column_name
  local quoted_column

  while IFS= read -r column_name; do
    quoted_column="${column_name//\"/\"\"}"
    if [[ -n "$result" ]]; then
      result+=", "
    fi
    result+="$alias.\"$quoted_column\""
  done < <(sqlite3 -readonly "$db_path" "SELECT name FROM pragma_table_info('$(sql_quote "$table_name")') ORDER BY cid;")
  printf '%s\n' "$result"
}

append_import_table_sql() {
  local sql_file="$1"
  local archive_db="$2"
  local table_name="$3"
  local archive_columns
  local main_columns

  table_exists "$archive_db" "$table_name" || return 0
  [[ "$(sqlite3 -readonly "$archive_db" "SELECT COUNT(*) FROM \"$table_name\";")" != "0" ]] || return 0
  archive_columns="$(table_columns "$archive_db" "$table_name" "a")"
  main_columns="$(table_columns "$archive_db" "$table_name" "m")"

  {
    printf "INSERT INTO temp._ai_guard(label, ok)\n"
    printf "SELECT '%s', CASE WHEN NOT EXISTS (\n" "$(sql_quote "$table_name")"
    printf "  SELECT 1 FROM (\n"
    printf "    SELECT %s FROM archive.\"%s\" a JOIN main.\"%s\" m ON m.id = a.id\n" "$archive_columns" "$table_name" "$table_name"
    printf "    EXCEPT\n"
    printf "    SELECT %s FROM archive.\"%s\" a JOIN main.\"%s\" m ON m.id = a.id\n" "$main_columns" "$table_name" "$table_name"
    printf "  )\n"
    printf ") THEN 1 ELSE 0 END;\n"
    printf "INSERT INTO main.\"%s\"\n" "$table_name"
    printf "SELECT a.* FROM archive.\"%s\" a\n" "$table_name"
    printf "WHERE NOT EXISTS (SELECT 1 FROM main.\"%s\" m WHERE m.id = a.id);\n" "$table_name"
  } >> "$sql_file"
}

import_archive_database() {
  local target_db="$1"
  local archive_db="$2"
  local sql_file="$TEMP_DIR/import.sql"
  local archive_sql
  local table_name
  local target_schema_file="$TEMP_DIR/target-schema.sql"
  local target_hash
  local archive_hash
  local import_order=(
    Skill SkillVersion Tag InfraSource Experiment
    Execution Session Evaluation FaultDiagnosisSession ExperimentCase
    TraceEvaluation ExecutionSkill ExecutionTag SkillIssue ExecutionMatch
    FaultDiagnosisMessage AgentDebugReport AgentDebugSkillsAnalysis
    TrajectoryEvalResult SessionInfraLink InfraMetricSample
    ExperimentEvalResult ExperimentEvalComment
  )

  target_hash="$(schema_hash "$target_db" "$target_schema_file")"
  archive_hash="$(sqlite3 -readonly "$archive_db" "SELECT value FROM _ai_archive_manifest WHERE key='schemaHash';")"
  [[ "$target_hash" == "$archive_hash" ]] \
    || die "database schema does not match archive (target=$target_hash archive=$archive_hash)"

  archive_sql="$(sql_quote "$archive_db")"
  {
    printf '.bail on\n'
    printf "PRAGMA foreign_keys=ON;\n"
    printf "ATTACH DATABASE '%s' AS archive;\n" "$archive_sql"
    printf "BEGIN IMMEDIATE;\n"
    printf "CREATE TEMP TABLE _ai_guard(label TEXT, ok INTEGER CHECK(ok = 1));\n"
    printf "CREATE TEMP TABLE _ai_fk_before AS SELECT * FROM pragma_foreign_key_check;\n"
  } > "$sql_file"

  for table_name in "${import_order[@]}"; do
    append_import_table_sql "$sql_file" "$archive_db" "$table_name"
  done

  {
    printf "INSERT INTO temp._ai_guard(label, ok)\n"
    printf "SELECT 'foreign_key_check', CASE WHEN NOT EXISTS (\n"
    printf "  SELECT * FROM pragma_foreign_key_check\n"
    printf "  EXCEPT SELECT * FROM temp._ai_fk_before\n"
    printf ") THEN 1 ELSE 0 END;\n"
    printf "COMMIT;\n"
    printf "DETACH DATABASE archive;\n"
  } >> "$sql_file"

  sqlite3 -batch -bail "$target_db" < "$sql_file"
}

purge_condition() {
  local table_name="$1"
  case "$table_name" in
    Execution)
      printf '%s' 's.id IN (SELECT id FROM archive._ai_selected_execution)
        OR s.rootExecutionId IN (SELECT id FROM archive._ai_selected_root)
        OR s.parentExecutionId IN (SELECT id FROM archive._ai_selected_execution)'
      ;;
    Session)
      printf '%s' 's.taskId IN (SELECT taskId FROM archive."Execution" WHERE taskId IS NOT NULL)'
      ;;
    TraceEvaluation|ExecutionSkill|ExecutionTag|ExecutionMatch|AgentDebugReport|AgentDebugSkillsAnalysis|TrajectoryEvalResult)
      printf '%s' 's.executionId IN (SELECT id FROM archive."Execution")'
      ;;
    Evaluation)
      printf '%s' 's.executionId IN (SELECT id FROM archive."Execution")'
      ;;
    SkillIssue)
      printf '%s' 's.evaluationId IN (SELECT id FROM archive."Evaluation")'
      ;;
    FaultDiagnosisSession)
      printf '%s' 's.executionId IN (SELECT id FROM archive."Execution")'
      ;;
    FaultDiagnosisMessage)
      printf '%s' 's.sessionId IN (SELECT id FROM archive."FaultDiagnosisSession")'
      ;;
    SessionInfraLink)
      printf '%s' 's.rootExecutionId IN (SELECT id FROM archive._ai_selected_root)'
      ;;
    ExperimentCase)
      printf '%s' 's.executionId IN (SELECT id FROM archive."Execution")'
      ;;
    ExperimentEvalResult)
      printf '%s' 's.caseId IN (SELECT id FROM archive."ExperimentCase")'
      ;;
    ExperimentEvalComment)
      printf '%s' 's.caseId IN (SELECT id FROM archive."ExperimentCase")
        OR s.resultId IN (SELECT id FROM archive."ExperimentEvalResult")'
      ;;
    InfraMetricSample)
      printf '%s' 's.id IN (SELECT id FROM archive._ai_selected_metric)
        OR (
          s.tsMs >= CAST((SELECT value FROM archive._ai_archive_manifest WHERE key = '\''fromMs'\'') AS INTEGER)
          AND s.tsMs < CAST((SELECT value FROM archive._ai_archive_manifest WHERE key = '\''toMs'\'') AS INTEGER)
        )'
      ;;
    *)
      die "missing purge condition for table: $table_name"
      ;;
  esac
}

append_purge_guard_sql() {
  local sql_file="$1"
  local archive_db="$2"
  local table_name="$3"
  local condition
  local archive_columns
  local main_columns

  table_exists "$archive_db" "$table_name" || return 0
  condition="$(purge_condition "$table_name")"
  archive_columns="$(table_columns "$archive_db" "$table_name" "a")"
  main_columns="$(table_columns "$archive_db" "$table_name" "s")"

  {
    printf "INSERT INTO temp._ai_guard(label, ok)\n"
    printf "SELECT '%s', CASE WHEN\n" "$(sql_quote "$table_name")"
    printf "  (SELECT COUNT(*) FROM main.\"%s\" s WHERE %s) = (SELECT COUNT(*) FROM archive.\"%s\")\n" "$table_name" "$condition" "$table_name"
    printf "  AND (SELECT COUNT(*) FROM archive.\"%s\" a JOIN main.\"%s\" s ON s.id = a.id) = (SELECT COUNT(*) FROM archive.\"%s\")\n" "$table_name" "$table_name" "$table_name"
    printf "  AND NOT EXISTS (\n"
    printf "    SELECT 1 FROM (\n"
    printf "      SELECT %s FROM archive.\"%s\" a JOIN main.\"%s\" s ON s.id = a.id\n" "$archive_columns" "$table_name" "$table_name"
    printf "      EXCEPT\n"
    printf "      SELECT %s FROM archive.\"%s\" a JOIN main.\"%s\" s ON s.id = a.id\n" "$main_columns" "$table_name" "$table_name"
    printf "    )\n"
    printf "  )\n"
    printf "THEN 1 ELSE 0 END;\n"
  } >> "$sql_file"
}

purge_source_database() {
  local source_db="$1"
  local archive_db="$2"
  local scope="$3"
  local sql_file="$TEMP_DIR/purge.sql"
  local archive_sql
  local table_name
  local owned_tables=()
  local delete_order=()

  if [[ "$scope" == "traces" ]]; then
    owned_tables=(
      Execution Session TraceEvaluation ExecutionSkill ExecutionTag Evaluation
      SkillIssue ExecutionMatch FaultDiagnosisSession FaultDiagnosisMessage
      AgentDebugReport AgentDebugSkillsAnalysis TrajectoryEvalResult SessionInfraLink
      ExperimentCase ExperimentEvalResult ExperimentEvalComment
    )
    delete_order=(
      ExperimentEvalComment ExperimentEvalResult ExperimentCase
      FaultDiagnosisMessage FaultDiagnosisSession SkillIssue Evaluation
      TraceEvaluation ExecutionSkill ExecutionTag ExecutionMatch
      AgentDebugReport AgentDebugSkillsAnalysis TrajectoryEvalResult SessionInfraLink
      Session Execution
    )
  else
    owned_tables=(InfraMetricSample)
    delete_order=(InfraMetricSample)
  fi

  archive_sql="$(sql_quote "$archive_db")"
  {
    printf '.bail on\n'
    printf "PRAGMA foreign_keys=ON;\n"
    printf "ATTACH DATABASE '%s' AS archive;\n" "$archive_sql"
    printf "BEGIN IMMEDIATE;\n"
    printf "CREATE TEMP TABLE _ai_guard(label TEXT, ok INTEGER CHECK(ok = 1));\n"
    printf "CREATE TEMP TABLE _ai_fk_before AS SELECT * FROM pragma_foreign_key_check;\n"
  } > "$sql_file"

  for table_name in "${owned_tables[@]}"; do
    append_purge_guard_sql "$sql_file" "$archive_db" "$table_name"
  done

  if [[ "$scope" == "traces" && "$(sqlite3 -readonly "$archive_db" 'SELECT COUNT(*) FROM "Session";')" != "0" ]]; then
    {
      printf "INSERT INTO temp._ai_guard(label, ok)\n"
      printf "SELECT 'shared_session', CASE WHEN NOT EXISTS (\n"
      printf "  SELECT 1 FROM main.\"Execution\" e\n"
      printf "  WHERE e.taskId IN (SELECT taskId FROM archive.\"Session\")\n"
      printf "    AND e.id NOT IN (SELECT id FROM archive.\"Execution\")\n"
      printf ") THEN 1 ELSE 0 END;\n"
    } >> "$sql_file"
  fi

  for table_name in "${delete_order[@]}"; do
    table_exists "$archive_db" "$table_name" || continue
    printf "DELETE FROM main.\"%s\" WHERE id IN (SELECT id FROM archive.\"%s\");\n" "$table_name" "$table_name" >> "$sql_file"
  done

  {
    printf "INSERT INTO temp._ai_guard(label, ok)\n"
    printf "SELECT 'foreign_key_check', CASE WHEN NOT EXISTS (\n"
    printf "  SELECT * FROM pragma_foreign_key_check\n"
    printf "  EXCEPT SELECT * FROM temp._ai_fk_before\n"
    printf ") THEN 1 ELSE 0 END;\n"
    printf "COMMIT;\n"
    printf "DETACH DATABASE archive;\n"
  } >> "$sql_file"

  sqlite3 -batch -bail "$source_db" < "$sql_file"
}

print_archive_summary() {
  local archive_db="$1"
  sqlite3 -readonly -header -column "$archive_db" "
    SELECT key, value
    FROM _ai_archive_manifest
    WHERE key IN ('format', 'version', 'createdAt', 'scope', 'user', 'from', 'to', 'schemaHash')
    ORDER BY CASE key
      WHEN 'format' THEN 1 WHEN 'version' THEN 2 WHEN 'createdAt' THEN 3
      WHEN 'scope' THEN 4 WHEN 'user' THEN 5 WHEN 'from' THEN 6 WHEN 'to' THEN 7 ELSE 8 END;
    SELECT table_name, row_count FROM _ai_archive_counts ORDER BY table_name;
  "
}

create_command() {
  local database_arg=""
  local scope=""
  local archive_user=""
  local before_iso=""
  local from_iso=""
  local to_iso=""
  local output_arg=""
  local purge_requested="true"
  local keep_source_seen="false"
  local purge_source_seen="false"
  local dry_run="false"
  local source_db
  local output_file
  local output_dir
  local from_ms
  local to_ms
  local snapshot_db
  local archive_db
  local schema_file
  local source_schema_hash
  local now_label
  local window_label

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --database) [[ $# -ge 2 ]] || die "--database requires a value"; database_arg="$2"; shift 2 ;;
      --scope) [[ $# -ge 2 ]] || die "--scope requires a value"; scope="$2"; shift 2 ;;
      --user) [[ $# -ge 2 ]] || die "--user requires a value"; archive_user="$2"; shift 2 ;;
      --before) [[ $# -ge 2 ]] || die "--before requires a value"; before_iso="$2"; shift 2 ;;
      --from) [[ $# -ge 2 ]] || die "--from requires a value"; from_iso="$2"; shift 2 ;;
      --to) [[ $# -ge 2 ]] || die "--to requires a value"; to_iso="$2"; shift 2 ;;
      --output) [[ $# -ge 2 ]] || die "--output requires a value"; output_arg="$2"; shift 2 ;;
      --keep-source) purge_requested="false"; keep_source_seen="true"; shift ;;
      --purge-source) purge_requested="true"; purge_source_seen="true"; shift ;;
      --dry-run) dry_run="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown create option: $1" ;;
    esac
  done

  [[ "$scope" == "traces" || "$scope" == "infra-metrics" ]] \
    || die "--scope must be traces or infra-metrics"
  [[ "$keep_source_seen" != "true" || "$purge_source_seen" != "true" ]] \
    || die "--keep-source cannot be combined with --purge-source"
  if [[ "$scope" == "infra-metrics" && -n "$archive_user" ]]; then
    die "--user is not supported when --scope is infra-metrics"
  fi
  [[ -n "$output_arg" ]] || die "--output is required"
  require_command sqlite3
  require_command gzip
  if [[ -n "$before_iso" ]]; then
    [[ -z "$from_iso" && -z "$to_iso" ]] || die "--before cannot be combined with --from or --to"
    to_iso="$before_iso"
    from_ms="-9223372036854775808"
    to_ms="$(iso_to_millis "$to_iso")"
  else
    [[ -n "$from_iso" && -n "$to_iso" ]] || die "use --before or provide both --from and --to"
    from_ms="$(iso_to_millis "$from_iso")"
    to_ms="$(iso_to_millis "$to_iso")"
    (( from_ms < to_ms )) || die "--from must be earlier than --to"
  fi

  source_db="$(resolve_database_path "$database_arg")"

  now_label="$(date -u '+%Y%m%dT%H%M%SZ')"
  window_label="$(printf '%s_%s' "${from_iso:-begin}" "$to_iso" | tr -cd '[:alnum:]_-')"
  if [[ "$output_arg" == *.sqlite.gz ]]; then
    output_file="$(canonical_output_path "$output_arg")"
    output_dir="$(dirname "$output_file")"
  else
    mkdir -p -- "$output_arg"
    output_dir="$(cd "$output_arg" && pwd -P)"
    output_file="$output_dir/${scope}-${window_label}-${now_label}.sqlite.gz"
  fi
  [[ ! -e "$output_file" ]] || die "archive already exists: $output_file"

  TEMP_DIR="$(mktemp -d "$output_dir/.agent-insight-archive.XXXXXX")"
  snapshot_db="$TEMP_DIR/source-snapshot.sqlite"
  archive_db="$TEMP_DIR/archive.sqlite"
  schema_file="$TEMP_DIR/source-schema.sql"

  note "Creating a consistent SQLite snapshot..."
  create_consistent_snapshot "$source_db" "$snapshot_db"
  source_schema_hash="$(schema_hash "$snapshot_db" "$schema_file")"
  initialize_archive_schema "$snapshot_db" "$archive_db" "$TEMP_DIR/archive-schema.sql"

  if [[ "$scope" == "traces" ]]; then
    select_trace_ids "$snapshot_db" "$archive_db" "$from_ms" "$to_ms" "$archive_user"
    copy_trace_archive "$snapshot_db" "$archive_db"
  else
    table_exists "$snapshot_db" "InfraMetricSample" \
      || die "InfraMetricSample table does not exist"
    select_metric_ids "$snapshot_db" "$archive_db" "$from_ms" "$to_ms"
    copy_metric_archive "$snapshot_db" "$archive_db"
  fi

  write_archive_metadata "$archive_db" "$scope" "$from_iso" "$to_iso" \
    "$from_ms" "$to_ms" "$source_db" "$source_schema_hash" "$purge_requested" "$archive_user"
  verify_archive_database "$archive_db"
  print_archive_summary "$archive_db"

  if [[ "$dry_run" == "true" ]]; then
    note "Dry run complete; no archive file was written and source data was not changed."
    return
  fi

  write_compressed_archive "$archive_db" "$output_file"
  note "Archive written: $output_file"
  note "Checksum written: ${output_file}.sha256"

  if [[ "$purge_requested" == "true" ]]; then
    local purge_receipt="${output_file}.purged"
    note "Verifying that source rows have not changed before purge..."
    purge_source_database "$source_db" "$archive_db" "$scope"
    note "Source rows were purged transactionally."
    if printf 'purgedAt=%s\nsourceDatabaseName=%s\narchiveSha256=%s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
      "$(basename "$source_db")" \
      "$(hash_file "$output_file")" > "$purge_receipt"; then
      note "Purge receipt written: $purge_receipt"
    else
      printf 'Warning: source rows were purged, but the receipt could not be written: %s\n' "$purge_receipt" >&2
    fi
  fi
}

inspect_command() {
  local input_arg=""
  local input_file
  local archive_db

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input) [[ $# -ge 2 ]] || die "--input requires a value"; input_arg="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown inspect option: $1" ;;
    esac
  done
  [[ -n "$input_arg" ]] || die "--input is required"
  require_command sqlite3
  require_command gzip
  input_file="$(canonical_existing_file "$input_arg")"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-insight-archive.XXXXXX")"
  archive_db="$TEMP_DIR/archive.sqlite"
  decompress_and_verify_archive "$input_file" "$archive_db"
  print_archive_summary "$archive_db"
}

import_command() {
  local input_arg=""
  local database_arg=""
  local dry_run="false"
  local input_file
  local target_db
  local archive_db
  local target_schema_file
  local target_hash
  local archive_hash

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input) [[ $# -ge 2 ]] || die "--input requires a value"; input_arg="$2"; shift 2 ;;
      --database) [[ $# -ge 2 ]] || die "--database requires a value"; database_arg="$2"; shift 2 ;;
      --dry-run) dry_run="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown import option: $1" ;;
    esac
  done
  [[ -n "$input_arg" ]] || die "--input is required"
  require_command sqlite3
  require_command gzip
  input_file="$(canonical_existing_file "$input_arg")"
  target_db="$(resolve_database_path "$database_arg")"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-insight-archive.XXXXXX")"
  archive_db="$TEMP_DIR/archive.sqlite"
  target_schema_file="$TEMP_DIR/target-schema.sql"
  decompress_and_verify_archive "$input_file" "$archive_db"

  target_hash="$(schema_hash "$target_db" "$target_schema_file")"
  archive_hash="$(sqlite3 -readonly "$archive_db" "SELECT value FROM _ai_archive_manifest WHERE key='schemaHash';")"
  [[ "$target_hash" == "$archive_hash" ]] \
    || die "database schema does not match archive (target=$target_hash archive=$archive_hash)"

  print_archive_summary "$archive_db"
  if [[ "$dry_run" == "true" ]]; then
    local target_snapshot="$TEMP_DIR/target-snapshot.sqlite"
    create_consistent_snapshot "$target_db" "$target_snapshot"
    import_archive_database "$target_snapshot" "$archive_db"
    note "Dry run complete; archive compatibility and row conflicts were checked on a snapshot."
    note "Target database was not changed."
    return
  fi

  import_archive_database "$target_db" "$archive_db"
  note "Archive imported successfully: $input_file"
}

main() {
  local command="${1:-}"
  case "$command" in
    create) shift; create_command "$@" ;;
    inspect) shift; inspect_command "$@" ;;
    import) shift; import_command "$@" ;;
    -h|--help|"") usage ;;
    *) die "unknown command: $command" ;;
  esac
}

main "$@"
