"""Read-only, transaction-consistent legacy SQLite inventory and export."""
from contextlib import contextmanager
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3


class LegacyValidationError(ValueError):
    pass


LEGACY_MODELS = {
    'Skill': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'SkillVersion': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'User': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'Execution': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'TraceThread': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'TraceThreadEvent': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'TraceEvaluation': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ExecutionSkill': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ExecutionSkillOrigin': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'Tag': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExecutionTag': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'Evaluation': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'SkillIssue': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'Config': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'Session': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'UserSettings': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ParsedFlow': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ExecutionMatch': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'UserGuideState': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'SkillGeneratorSession': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillGeneratorMessage': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptSession': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptPlan': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptPlanItem': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptMessage': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptIteration': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillWorkbenchSession': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillWorkbenchMessage': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillWorkbenchTask': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillOptimizationRecord': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'SkillSnapshotEvaluation': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'CustomEvaluatorList': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'AgentEvalDataset': 'OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域',
    'DebugHistory': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'BatchEvalTask': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GrayscaleTask': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'DebugJobResult': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'TrajectoryEvalResult': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'RegisteredAgent': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'FaultDiagnosisSession': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'FaultDiagnosisMessage': 'OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用',
    'DiagnosisRun': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'AgentDebugReport': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'AgentDebugSkillsAnalysis': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'SkillTriggerEvalSet': 'OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域',
    'SkillTriggerEvalRun': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'SessionInfraLink': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'InfraSource': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'FaultInjectionTask': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'FaultInjectionRun': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'FaultInjectionWorker': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'RasAnomalyEvent': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'InfraMetricSample': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'Experiment': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentCancellation': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentLocalExecution': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentGroup': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentCase': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'BenchmarkDataset': 'OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域',
    'BenchmarkDatasetCase': 'OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域',
    'BenchmarkExperimentBinding': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'BenchmarkCaseRun': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'BenchmarkArtifact': 'OLTP 制品元数据；ArtifactStore 字节及 CH 分析引用',
    'BenchmarkDispatchOutbox': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'BenchmarkEvaluation': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'BenchmarkEvaluationArtifact': 'OLTP 制品元数据；ArtifactStore 字节及 CH 分析引用',
    'BenchmarkEvaluationDispatchOutbox': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentTraceAttempt': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ExperimentEvalResult': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ExperimentEvalComment': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'PlatformUsageEvent': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'PlatformUsageDaily': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ReliabilityInstallToken': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityClient': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'SkillDeployment': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'SkillDeploymentEvent': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'ReliabilityClientCredential': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityCommand': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityClientConfig': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityConfigSnapshot': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityConfigDelivery': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'ReliabilityConfigLoad': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusSource': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusGoal': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusRun': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusCandidate': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusIteration': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'GoalPlusAgentSession': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'GoalPlusExecutionLink': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'GoalPlusSemanticSnapshot': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'Collaboration': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'CollaborationEvent': 'CH 事实/关系/投影，编辑或生命周期指针保留 OLTP',
    'CollaborationEndpointResolution': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'CollaborationSessionBinding': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'TraceDatasetGenerationJob': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
    'TraceDatasetOperationReceipt': 'OLTP 控制/身份/任务，历史事件按领域拆入 CH',
}


def classify_table(name):
    target = LEGACY_MODELS.get(name)
    return {"status": "mapped" if target else "unclassified", "target": target}


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _encode_value(value):
    if value is None:
        return ["null", None]
    if isinstance(value, int):
        return ["integer", str(value)]
    if isinstance(value, float):
        return ["real", value.hex()]
    if isinstance(value, str):
        return ["text", value]
    if isinstance(value, bytes):
        return ["blob", base64.b64encode(value).decode("ascii")]
    raise LegacyValidationError("Unsupported SQLite value type")


@contextmanager
def _snapshot(path):
    source = Path(path).resolve(strict=True)
    if not source.is_file():
        raise LegacyValidationError("Source must be an existing SQLite file")
    db = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        db.execute("PRAGMA query_only=ON")
        db.create_function("_legacy_sort_key", 1, lambda v: _json_bytes(_encode_value(v)), deterministic=True)
        db.execute("BEGIN")
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise LegacyValidationError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise LegacyValidationError("Foreign key violations: resolve explicitly before migration")
        yield db
    except sqlite3.DatabaseError as exc:
        raise LegacyValidationError("SQLite source cannot be validated or read") from exc
    finally:
        db.rollback()
        db.close()


def _schema_objects(db):
    return [
        {"type": row[0], "name": row[1], "table": row[2], "sql": row[3]}
        for row in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY"
        )
        if not row[1].startswith("sqlite_")
    ]


def _private_file(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, "wb")


def _write_private(path, content):
    with _private_file(path) as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _collect(db, output=None):
    objects = _schema_objects(db)
    schema_hash = hashlib.sha256(_json_bytes(objects)).hexdigest()
    table_names = sorted(obj["name"] for obj in objects if obj["type"] == "table")
    tables = []
    for ordinal, name in enumerate(table_names):
        columns = [
            {"name": c[1], "declared_type": c[2], "not_null": bool(c[3]),
             "default_sql": c[4], "primary_key_position": c[5], "hidden": c[6]}
            for c in db.execute("PRAGMA table_xinfo(" + _quote(name) + ")") if c[6] != 1
        ]
        if not columns:
            raise LegacyValidationError("Source table has no readable columns")
        quoted = [_quote(c["name"]) for c in columns]
        # Canonical cells break SQLite equality ties such as -0.0 versus +0.0.
        order = ",".join("_legacy_sort_key(" + q + ")" for q in quoted)
        query = "SELECT " + ",".join(quoted) + " FROM " + _quote(name) + " ORDER BY " + order
        filename = f"table-{ordinal:04d}-{hashlib.sha256(name.encode()).hexdigest()[:12]}.jsonl"
        stream = _private_file(output / filename) if output is not None else None
        digest = hashlib.sha256()
        count = 0
        try:
            for row in db.execute(query):
                encoded = _json_bytes({"values": [_encode_value(value) for value in row]}) + b"\n"
                digest.update(encoded)
                count += 1
                if stream is not None:
                    stream.write(encoded)
            if stream is not None:
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if stream is not None:
                stream.close()
        table = {"name": name, "columns": columns, "row_count": count,
                 "rows_sha256": digest.hexdigest(), "classification": classify_table(name)}
        if output is not None:
            table["file"] = filename
        tables.append(table)
    summary = [{"name": t["name"], "columns": t["columns"], "row_count": t["row_count"], "rows_sha256": t["rows_sha256"]} for t in tables]
    return {"format_version": 1, "integrity_status": "ok", "source_schema_sha256": schema_hash,
            "source_content_sha256": hashlib.sha256(_json_bytes({"schema": schema_hash, "tables": summary})).hexdigest(),
            "schema_objects": objects, "tables": tables,
            "unclassified_tables": [t["name"] for t in tables if t["classification"]["status"] == "unclassified"]}


def inventory_database(path):
    with _snapshot(path) as db:
        return _collect(db)


def export_database(path, output_dir):
    output = Path(output_dir).absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("Export destination must not already exist")
    with _snapshot(path) as db:
        output.mkdir(mode=0o700)
        _sync_directory(output.parent)
        _write_private(output / ".incomplete", b"incomplete\n")
        manifest = _collect(db, output)
        _write_private(output / "schema.json", _json_bytes(manifest["schema_objects"]) + b"\n")
        manifest["status"] = "complete"
        _write_private(output / "manifest.pending", _json_bytes(manifest) + b"\n")
        _sync_directory(output)
        os.replace(output / "manifest.pending", output / "manifest.json")
        _sync_directory(output)
        (output / ".incomplete").unlink()
        _sync_directory(output)
        return manifest


def _require(condition, message):
    if not condition:
        raise LegacyValidationError(message)


def _read_export_file(directory, filename):
    _require(isinstance(filename, str) and filename not in ('', '.', '..')
             and Path(filename).name == filename and '/' not in filename and '\\' not in filename,
             'Export file reference must be a simple filename')
    path = directory / filename
    _require(path.is_file() and not path.is_symlink(), 'Export file is missing or is a symbolic link')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    return os.fdopen(os.open(path, flags), 'rb')


def _valid_cell(cell):
    if not isinstance(cell, list) or len(cell) != 2:
        return False
    kind, value = cell
    if kind == 'null':
        return value is None
    if not isinstance(value, str):
        return False
    if kind == 'text':
        return True
    if kind == 'integer':
        try:
            return str(int(value)) == value and -(2 ** 63) <= int(value) < 2 ** 63
        except ValueError:
            return False
    if kind == 'real':
        try:
            return float.fromhex(value).hex() == value
        except ValueError:
            return False
    if kind == 'blob':
        try:
            return base64.b64encode(base64.b64decode(value, validate=True)).decode('ascii') == value
        except ValueError:
            return False
    return False


def verify_export(directory):
    root = Path(directory).absolute()
    try:
        _require(root.is_dir() and not root.is_symlink(), 'Export directory is missing or is a symbolic link')
        _require(not (root / '.incomplete').exists(), 'Export is incomplete')
        with _read_export_file(root, 'manifest.json') as stream:
            manifest = json.load(stream)
        _require(isinstance(manifest, dict) and type(manifest.get('format_version')) is int
                 and manifest.get('format_version') == 1
                 and manifest.get('status') == 'complete' and manifest.get('integrity_status') == 'ok',
                 'Unsupported or incomplete export manifest')
        with _read_export_file(root, 'schema.json') as stream:
            schema = json.load(stream)
        _require(isinstance(schema, list) and schema == manifest['schema_objects'], 'Schema file differs from manifest')
        for obj in schema:
            _require(isinstance(obj, dict) and set(obj) == {'type', 'name', 'table', 'sql'}
                     and obj['type'] in ('table', 'index', 'view', 'trigger')
                     and isinstance(obj['name'], str) and isinstance(obj['table'], str)
                     and (obj['sql'] is None or isinstance(obj['sql'], str)), 'Invalid schema object descriptor')
        schema_hash = hashlib.sha256(_json_bytes(schema)).hexdigest()
        _require(schema_hash == manifest['source_schema_sha256'], 'Schema fingerprint differs from manifest')
        tables = manifest['tables']
        _require(isinstance(tables, list), 'Invalid manifest tables')
        names = [t['name'] for t in tables]
        _require(all(isinstance(n, str) for n in names) and names == sorted(set(names)), 'Table names must be sorted and unique')
        schema_tables = sorted(obj['name'] for obj in schema if obj['type'] == 'table')
        _require(names == schema_tables, 'Table list differs from schema')
        expected_files = {'manifest.json', 'schema.json'}
        summary = []
        unclassified = []
        for ordinal, table in enumerate(tables):
            filename = f"table-{ordinal:04d}-{hashlib.sha256(table['name'].encode()).hexdigest()[:12]}.jsonl"
            _require(table['file'] == filename, 'Table filename differs from deterministic manifest mapping')
            columns = table['columns']
            _require(isinstance(columns, list) and len(columns) > 0, 'Table columns are missing')
            for column in columns:
                _require(isinstance(column, dict)
                         and set(column) == {'name', 'declared_type', 'not_null', 'default_sql', 'primary_key_position', 'hidden'}
                         and isinstance(column['name'], str) and isinstance(column['declared_type'], str)
                         and type(column['not_null']) is bool
                         and (column['default_sql'] is None or isinstance(column['default_sql'], str))
                         and type(column['primary_key_position']) is int and column['primary_key_position'] >= 0
                         and type(column['hidden']) is int and column['hidden'] in (0, 2, 3),
                         'Invalid physical column descriptor')
            column_names = [column['name'] for column in columns]
            _require(all(isinstance(n, str) for n in column_names) and len(set(column_names)) == len(column_names), 'Invalid table column names')
            _require(type(table['row_count']) is int and table['row_count'] >= 0, 'Invalid table row count')
            classification = table['classification']
            _require(classification['status'] in ('mapped', 'unclassified'), 'Invalid migration classification')
            if classification['status'] == 'unclassified':
                unclassified.append(table['name'])
            digest = hashlib.sha256()
            count = 0
            with _read_export_file(root, filename) as stream:
                for line in stream:
                    _require(line.endswith(b'\n'), 'Table file has an unterminated row')
                    row = json.loads(line)
                    _require(isinstance(row, dict) and set(row) == {'values'}
                             and isinstance(row['values'], list) and len(row['values']) == len(columns)
                             and all(_valid_cell(cell) for cell in row['values']), 'Invalid typed row in table file')
                    _require(line == _json_bytes(row) + b'\n', 'Table row is not canonically encoded')
                    digest.update(line)
                    count += 1
            _require(count == table['row_count'] and digest.hexdigest() == table['rows_sha256'], 'Table rows or fingerprint differ from manifest')
            expected_files.add(filename)
            summary.append({'name': table['name'], 'columns': columns, 'row_count': count, 'rows_sha256': digest.hexdigest()})
        _require(unclassified == manifest['unclassified_tables'], 'Unclassified table list differs from manifest')
        source_hash = hashlib.sha256(_json_bytes({'schema': schema_hash, 'tables': summary})).hexdigest()
        _require(source_hash == manifest['source_content_sha256'], 'Source fingerprint differs from manifest')
        _require({p.name for p in root.iterdir()} == expected_files, 'Export has unlisted or missing files')
        return manifest
    except LegacyValidationError:
        raise
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, OverflowError) as exc:
        raise LegacyValidationError('Export files or manifest cannot be validated') from exc
