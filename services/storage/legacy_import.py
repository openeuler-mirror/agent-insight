"""Explicit, resumable semantic import from a verified private legacy export."""
import base64
from collections import Counter
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path

from .control import Conflict
from .iam import IAMStore, Forbidden
from .legacy import LegacyValidationError, _encode_value, _read_export_file, verify_export
from .legacy_plan import load_catalog, _bindings
from .legacy_plan import _valid_value
from .platform_controls import PlatformControls, MODELS

VERSION = 'legacy-semantic-import/v1'
INBOX = 'legacy-semantic-entity/v1'
CONTROL_MODELS = {model['name']: kind for kind, model in MODELS.items()}


def supported_legacy_models():
    from .legacy_import_traces import TRACE_MODELS
    from .legacy_import_assets import ASSET_MODELS
    from .legacy_import_telemetry import TELEMETRY_MODELS
    from .legacy_import_diagnosis import DIAGNOSIS_MODELS
    from .legacy_import_semantic import SEMANTIC_MODELS
    from .legacy_generation import GENERATION_MODELS
    from .legacy_import_experiments import SUPPORTED_MODELS
    return frozenset(CONTROL_MODELS) | TRACE_MODELS | ASSET_MODELS | TELEMETRY_MODELS | DIAGNOSIS_MODELS | SEMANTIC_MODELS | GENERATION_MODELS | SUPPORTED_MODELS


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _decode(cell):
    kind, value = cell
    if kind == 'null': return None
    if kind == 'integer': return int(value)
    if kind == 'real': return float.fromhex(value)
    if kind == 'blob': return base64.b64decode(value, validate=True)
    return value


def _ms(value):
    if type(value) is int and 0 <= value < 2**63: return value
    if isinstance(value, str):
        try:
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=datetime.timezone.utc)
            result = int(parsed.timestamp() * 1000)
            if result >= 0: return result
        except (ValueError, OverflowError): pass
    raise LegacyValidationError('Invalid historical timestamp')


def _iso(value):
    return datetime.datetime.fromtimestamp(_ms(value)/1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class _HistoricalClock:
    def __init__(self, control, timestamp): self.control = control; self.timestamp = timestamp
    def clock(self): return self.timestamp
    def __getattr__(self, name): return getattr(self.control, name)


class LegacyImport:
    def __init__(self, control, directory, *, source_id, bindings, actors=None,
                 row_bindings=None, selected_models=None, files=None, skill_directories=None, message_order=None,
                 max_rows=250000, max_bytes=512*1024*1024, ingest=None, facts=None, node_binary='node'):
        if not isinstance(source_id, str) or not 1 <= len(source_id) <= 512:
            raise LegacyValidationError('Explicit stable source ID required')
        self.control = control
        self.directory = Path(directory).absolute()
        self.source_id = source_id
        self.bindings = copy.deepcopy(_bindings(bindings))
        self.actors = dict(actors or {})
        self.row_bindings = dict(row_bindings or {})
        self.message_order = dict(message_order or {})
        self.files = copy.deepcopy(files or {})
        self.ingest = ingest
        self.facts = facts if facts is not None else getattr(ingest, 'facts', None)
        self.node_binary = node_binary
        self.selected_models = set(selected_models) if selected_models is not None else None
        self.manifest = verify_export(self.directory)
        self.catalog = {m['table']: m for m in load_catalog()['models']}
        if self.selected_models is not None and (not self.selected_models or self.selected_models - {model['model'] for model in self.catalog.values()}):
            raise LegacyValidationError('Selected models must be an explicit nonempty subset of the reviewed legacy catalog')
        self.rows = []
        size = 0
        for table in self.manifest['tables']:
            descriptor = self.catalog.get(table['name'])
            columns = {c['column']: c for c in descriptor['columns']} if descriptor else {}
            names = [c['name'] for c in table['columns']]
            digest = hashlib.sha256()
            with _read_export_file(self.directory, table['file']) as stream:
                for line in stream:
                    size += len(line)
                    if len(self.rows) >= max_rows or size > max_bytes:
                        raise LegacyValidationError('Semantic import exceeds explicit row/byte budget')
                    digest.update(line)
                    raw = json.loads(line)['values']
                    physical = dict(zip(names, map(_decode, raw)))
                    primary = descriptor['primary_key'] if descriptor else [c['name'] for c in table['columns'] if c['primary_key_position']]
                    key_values = [physical.get(key) for key in primary]
                    key = _hash([source_id, table['name'], [_encode_value(v) for v in key_values]])
                    data = {columns[name]['field']: value for name, value in physical.items() if name in columns}
                    for name, spec in columns.items():
                        if name not in physical or physical[name] is None: continue
                        field = spec['field']
                        if spec['prisma_type'] == 'Boolean':
                            if type(physical[name]) is not int or physical[name] not in (0, 1):
                                raise LegacyValidationError('Invalid historical boolean')
                            data[field] = bool(physical[name])
                        elif spec['prisma_type'] == 'DateTime': data[field] = _iso(physical[name])
                    self.rows.append({'table': table['name'], 'model': descriptor['model'] if descriptor else None,
                        'descriptor': descriptor, 'physical': physical, 'data': data, 'primary': key_values,
                        'entity_key': key, 'content_hash': _hash(raw), 'raw': raw,
                        'columns': names, 'selected': self.selected_models is None or descriptor and descriptor['model'] in self.selected_models})
            if digest.hexdigest() != table['rows_sha256']:
                raise LegacyValidationError('Export changed while preparing semantic import')
        self.iam = IAMStore(control)
        self._owner_cache = {}
        self._lookup_cache = {}
        self._by_model = {}
        for row in self.rows: self._by_model.setdefault(row['model'], []).append(row)
        for row in self._by_model.get('SkillVersion', []):
            if row['entity_key'] in self.files: continue
            directory = (skill_directories or {}).get(row['entity_key'])
            if directory is not None: self.files[row['entity_key']] = self._capture_skill_directory(directory)
            elif not row['data'].get('assetPath') and isinstance(row['data'].get('content'), str):
                declared = row['data'].get('files')
                try: declared = json.loads(declared) if isinstance(declared, str) and declared else declared
                except ValueError: continue
                if declared is None or declared == [] or declared == ['SKILL.md']:
                    self.files[row['entity_key']] = [{'path': 'SKILL.md', 'content': base64.b64encode(row['data']['content'].encode()).decode(), 'mode': 0o644}]
        self.import_manifest_hash = _hash([VERSION, source_id, self.manifest['source_content_sha256'], self.bindings, self.row_bindings, self.files, self.message_order])

    @staticmethod
    def _capture_skill_directory(value):
        root = Path(value)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir(): raise LegacyValidationError('Explicit existing Skill directory required')
        files = []; size = 0
        for path in sorted(root.rglob('*')):
            if path.is_symlink(): raise LegacyValidationError('Skill file package cannot contain symbolic links')
            if path.is_dir(): continue
            if not path.is_file(): raise LegacyValidationError('Skill package must contain regular files')
            before = path.stat(); size += before.st_size
            if size > 128*1024*1024 or len(files) >= 10000: raise LegacyValidationError('Skill package exceeds byte/file budget')
            with path.open('rb') as source: raw = source.read(128*1024*1024 + 1)
            after = path.stat()
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns) or len(raw) != before.st_size:
                raise LegacyValidationError('Skill package changed while capturing bytes')
            files.append({'path': path.relative_to(root).as_posix(), 'content': base64.b64encode(raw).decode(), 'mode': before.st_mode & 0o777})
        return files

    def lookup_rows(self, model, fields, values):
        key = model, tuple(fields)
        if key not in self._lookup_cache:
            index = {}
            for row in self._by_model.get(model, []):
                identity = tuple(row['physical'].get(field) for field in fields)
                index.setdefault(identity, []).append(row)
            self._lookup_cache[key] = index
        return self._lookup_cache[key].get(tuple(values), [])

    def _owner(self, row, visiting=None):
        if row['entity_key'] in self._owner_cache: return self._owner_cache[row['entity_key']]
        if row['entity_key'] in self.row_bindings:
            owner = self.row_bindings[row['entity_key']]
            if owner not in self.bindings: raise LegacyValidationError('Explicit row owner has no binding')
            return owner
        descriptor = row['descriptor']
        if not descriptor: return None
        if row['model'] in {'ExperimentEvalComment', 'ExperimentLocalExecution'}:
            parents = self.lookup_rows('Experiment', ['id'], [row['data'].get('experimentId')])
            return self._owner(parents[0], visiting) if len(parents) == 1 else None
        owner = descriptor['owner']
        if owner['kind'] == 'direct': return row['physical'].get(owner['column'])
        visiting = set(visiting or ())
        if row['entity_key'] in visiting: return None
        visiting.add(row['entity_key'])
        owners = set()
        for relation in descriptor['relations'] + descriptor['logical_relations']:
            if relation['field'] not in owner.get('relations', []): continue
            values = [row['physical'].get(field) for field in relation['from']]
            if any(value is None for value in values): continue
            candidates = self.lookup_rows(relation['target_model'], relation['to'], values)
            if len(candidates) != 1: return None
            inherited = self._owner(candidates[0], visiting)
            if inherited is None: return None
            owners.add(inherited)
        result = next(iter(owners)) if len(owners) == 1 else None
        self._owner_cache[row['entity_key']] = result
        return result

    def _issues(self, row):
        result = []
        descriptor = row['descriptor']
        if descriptor is None: return ['unknown_table']
        expected = {column['column'] for column in descriptor['columns']}
        from .legacy_import_semantic import SEMANTIC_MODELS
        from .semantic_usage import MODELS as SEMANTIC_DEFINITIONS
        semantic = SEMANTIC_DEFINITIONS.get(row['model'][0].lower()+row['model'][1:])
        defaults = {spec.get('column', field) for field, spec in semantic['fields'].items()
            if spec['nullable'] or spec['hasDefault'] and spec['default'] not in ('$id', '$now')} if semantic else set()
        if set(row['columns']) - expected or expected - set(row['columns']) - defaults: result.append('source_columns_differ')
        if any(not _valid_value(column, row['physical'].get(column['column'])) for column in descriptor['columns'] if column['column'] in row['physical'] or column['column'] not in defaults):
            result.append('source_scalar_type_differs')
        if not descriptor['primary_key'] or any(value is None for value in row['primary']): result.append('source_identity_missing')
        from .legacy_import_traces import TRACE_MODELS
        from .legacy_import_assets import ASSET_MODELS
        from .legacy_import_telemetry import TELEMETRY_MODELS
        from .legacy_import_diagnosis import DIAGNOSIS_MODELS, DiagnosisHistory
        from .legacy_generation import GENERATION_MODELS, GenerationHistory
        from .legacy_import_experiments import handles, ExperimentHistory
        if row['model'] not in supported_legacy_models():
            result.append('semantic_transformer_missing')
        if handles(row):
            result.extend(ExperimentHistory(self).issues(row))
            from .legacy_history import HISTORY_FENCE_VERSION
            if HISTORY_FENCE_VERSION < 1: result.append('inert_history_guard_required')
            if row['model'] in {'ExperimentEvalResult', 'TraceEvaluation', 'TrajectoryEvalResult', 'ExecutionMatch', 'SkillTriggerEvalRun', 'Evaluation'} and self.facts is None:
                result.append('facts_store_required')
        if row['model'] in GENERATION_MODELS: result.extend(GenerationHistory(self).issues(row))
        if row['model'] in SEMANTIC_MODELS and self.facts is None and (not semantic or semantic['immutable']): result.append('facts_store_required')
        if row['model'] in DIAGNOSIS_MODELS: result.extend(DiagnosisHistory(self).issues(row))
        if row['model'] in {'InfraMetricSample', 'RasAnomalyEvent'} and self.facts is None: result.append('facts_store_required')
        if row['model'] in TRACE_MODELS and self.ingest is None: result.append('trace_ingest_required')
        from .legacy_history import HISTORY_FENCE_VERSION, INERT_CONTROL_KINDS
        if CONTROL_MODELS.get(row['model']) in INERT_CONTROL_KINDS and HISTORY_FENCE_VERSION < 1:
            result.append('inert_history_guard_required')
        if row['model'] == 'InfraSource' and HISTORY_FENCE_VERSION < 1: result.append('inert_history_guard_required')
        if row['model'] == 'ExperimentEvalComment' and row['data'].get('user') not in self.bindings: result.append('comment_author_mapping_missing')
        owner = self._owner(row)
        if owner not in self.bindings: result.append('owner_mapping_missing')
        if row['model'] == 'SkillVersion':
            if row['entity_key'] not in self.files: result.append('skill_file_bundle_required')
            else:
                try: PlatformControls(self.control)._validate_files(self.files[row['entity_key']])
                except (ValueError, TypeError, KeyError): result.append('skill_file_bundle_invalid')
        return result

    def plan(self):
        counts = Counter()
        entities = []
        for row in self.rows:
            if not row['selected']: continue
            issues = self._issues(row)
            counts.update(issues)
            entities.append({key: row[key] for key in ('table', 'model', 'entity_key', 'content_hash')} | {'issues': issues})
        return {'format': VERSION, 'source_schema_sha256': self.manifest['source_schema_sha256'],
            'source_content_sha256': self.manifest['source_content_sha256'], 'binding_sha256': _hash(self.bindings),
            'import_manifest_sha256': self.import_manifest_hash,
            'entities': entities, 'issue_counts': dict(counts), 'blocked': sum(bool(item['issues']) for item in entities),
            'preflight_ready': not counts, 'full_migration_ready': False,
            'scope': 'selected-models' if self.selected_models is not None else 'all-source-models',
            'supported_model_count': len(supported_legacy_models()),
            'production_cutover_ready': False}

    def _actor(self, con, owner, capability='write'):
        binding = self.bindings[owner]
        token = self.actors.get(owner)
        if not isinstance(token, str): raise Forbidden('Explicit current owner credential required')
        scope = self.iam._scope(con, token)
        if scope.principal_id != binding['principal_id']: raise Forbidden('Current actor differs from explicit legacy owner mapping')
        grant = self.iam._workspace(scope, binding['workspace_id'], capability)
        return scope, grant, binding['workspace_id']

    def _checkpoint_id(self, row): return row['table'] + ':' + row['entity_key']

    def _checkpoint(self, con, migration, row, proof, *, state='verified'):
        owner = self._owner(row); workspace = self.bindings[owner]['workspace_id']; now = self.control.clock()
        source_table = self._checkpoint_id(row)
        con.execute('INSERT INTO migration_checkpoints VALUES(?,?,?,?,?,?,?, ?,1,?,?)',
            (workspace, migration, self.manifest['source_content_sha256'], source_table,
             _json([_encode_value(v) for v in row['primary']]), 1, _json(proof), state, now, now))

    def _control(self, con, row, scope, grant, workspace, owner):
        kind = CONTROL_MODELS[row['model']]
        data = copy.deepcopy(row['data'])
        if kind == 'user':
            token = self.actors[owner]
            if not token.startswith('api_'): raise LegacyValidationError('User migration requires an actual target API credential; old keys remain quarantined')
            data['apiKey'] = token
        created = _ms(data.get('createdAt') or data.get('timestamp') or data.get('startedAt') or data.get('parsedAt') or 0)
        updated = _ms(data.get('updatedAt') or created)
        if updated < created: raise LegacyValidationError('Historical update precedes creation')
        controls = PlatformControls(_HistoricalClock(self.control, created))
        normalized = controls._normalize(kind, data, owner)
        for field, spec in MODELS[kind]['fields'].items():
            if spec['updated'] and field in data: normalized[field] = data[field]
        data = normalized
        identity = data['id']
        if controls._row(con, workspace, kind, identity, True): raise Conflict('Historical control identity already exists without this import receipt')
        parent = controls._parent(con, scope, grant, workspace, kind, data, historical=True)
        for fields in MODELS[kind]['unique']:
            if fields == ['id'] or any(data.get(field) is None for field in fields): continue
            candidates = con.execute("SELECT * FROM platform_control_records WHERE kind=? AND state='active'" +
                (" AND workspace_id=? AND owner_principal_id=?" if kind != 'user' else ''),
                (kind, workspace, scope.principal_id) if kind != 'user' else (kind,)).fetchall()
            for candidate in candidates:
                original = controls._data(dict(candidate))
                if all(original.get(field) == data[field] for field in fields): raise Conflict('Historical control unique key collides with existing data')
        files = controls._validate_files(self.files[row['entity_key']]) if kind == 'skillVersion' else None
        asset = controls._asset(con, scope, workspace, kind, data, None, files)
        packed = {'format': 'platform-skill-files/v1', 'data': data, 'files': files} if kind == 'skillVersion' else data
        digest, ref = controls._persist(packed)
        metadata = _json(controls._metadata(kind, data))
        sort = _ms(data.get('updatedAt') or data.get('createdAt') or data.get('timestamp') or data.get('startedAt') or created)
        con.execute('INSERT INTO platform_control_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (workspace, kind, identity, scope.principal_id, owner, *parent, controls._unique(kind, data), controls._lookup(kind, data),
             data.get('status'), _ms(data['expiresAt']) if data.get('expiresAt') else None, sort, metadata, digest, ref, asset,
             'active', 1, created, updated))
        from .legacy_history import INERT_CONTROL_KINDS, INERT_SOURCE, control_history_key
        if kind in INERT_CONTROL_KINDS:
            con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (workspace, INERT_SOURCE,
                control_history_key(kind, identity), row['content_hash'], self.control.clock()))
        controls._bump_scope(con, workspace, scope.principal_id, owner, kind)
        return {'domain': 'control', 'kind': kind, 'record_id': identity, 'payload_hash': digest, 'revision': 1}

    def _ordered(self):
        selected = [row for row in self.rows if row['selected']]
        by_key = {row['entity_key']: row for row in selected}
        if len(by_key) != len(selected): raise LegacyValidationError('Source has duplicate stable primary-key identities')
        dependencies = {}; consumers = {}
        def target(model, fields, values):
            if any(value is None for value in values): return []
            return self.lookup_rows(model, fields, values)
        for row in selected:
            parents = []
            for relation in (row['descriptor'] or {}).get('relations', []) + (row['descriptor'] or {}).get('logical_relations', []):
                parents.extend(target(relation['target_model'], relation['to'], [row['physical'].get(field) for field in relation['from']]))
            data = row['data']
            if row['model'] == 'Session': parents.extend(target('Execution', ['taskId'], [data['taskId']]))
            if row['model'] == 'TraceThreadEvent':
                for field in ('executionId', 'relatedExecutionId'): parents.extend(target('Execution', ['id'], [data.get(field)]))
            if row['model'] == 'SessionInfraLink':
                parents.extend(target('InfraSource', ['id'], [data['sourceId']]))
                parents.extend(target('Execution', ['id'], [data['rootExecutionId']]))
            if row['model'] in {'FaultDiagnosisSession', 'DiagnosisRun', 'AgentDebugReport', 'AgentDebugSkillsAnalysis'}:
                parents.extend(target('Execution', ['id'], [data['executionId']]))
            if row['model'] == 'DiagnosisRun':
                from .legacy_import_diagnosis import DiagnosisHistory
                parents.extend(DiagnosisHistory(self).retest_rows(row)[0])
                parents.extend(target('Experiment', ['id'], [data.get('experimentId')]))
                parents.extend(target('ExperimentCase', ['id'], [data.get('caseId')]))
            if row['model'] == 'Experiment' and data.get('scope') == 'benchmark':
                for binding in self.lookup_rows('BenchmarkExperimentBinding', ['experimentId'], [data['id']]):
                    parents.extend(target('BenchmarkDataset', ['id'], [binding['data']['datasetId']]))
            if row['model'] in {'ExperimentCase', 'TraceEvaluation', 'TrajectoryEvalResult', 'ExecutionMatch', 'Evaluation'}:
                parents.extend(target('Execution', ['id'], [data.get('executionId')]))
                parents.extend(target('Execution', ['taskId'], [data.get('taskId')]))
            if row['model'] == 'ExperimentTraceAttempt':
                parents.extend(target('Execution', ['taskId'], [data.get('traceId')]))
            if row['model'] in {'ExperimentCancellation', 'ExperimentLocalExecution'}:
                parents.extend(target('Experiment', ['id'], [data.get('experimentId')]))
            if row['model'] == 'ExperimentEvalComment': parents.extend(target('ExperimentEvalResult', ['id'], [data.get('resultId')]))
            if row['model'] == 'BenchmarkExperimentBinding': parents.extend(target('ExperimentCase', ['experimentId'], [data['experimentId']]))
            if row['model'] == 'BenchmarkCaseRun': parents.extend(target('BenchmarkExperimentBinding', ['experimentId'], [data['experimentId']]))
            if row['model'] in {'Evaluation', 'SkillIssue', 'ExecutionMatch'}:
                parents.extend(target('SkillVersion', ['skillId', 'version'], [data.get('skillId'), data.get('skillVersion') if row['model'] == 'ExecutionMatch' else data.get('version')]))
            if row['model'] == 'SkillTriggerEvalRun':
                for skill in self.lookup_rows('Skill', ['name'], [data['skillName']]):
                    if self._owner(skill) == self._owner(row):
                        parents.append(skill); parents.extend(target('SkillVersion', ['skillId', 'version'], [skill['data']['id'], data['skillVersion']]))
            if row['model'] == 'AgentEvalDataset':
                try: cases = json.loads(data['casesJson'])
                except (TypeError, ValueError): raise LegacyValidationError('Historical Dataset cases are invalid') from None
                for case in cases:
                    reference = case.get('traceSource', {}) if isinstance(case, dict) else {}
                    for field, column in (('executionId', 'id'), ('taskId', 'taskId')):
                        parents.extend(target('Execution', [column], [reference.get(field)]))
            identities = {parent['entity_key'] for parent in parents if parent['entity_key'] != row['entity_key'] and parent['entity_key'] in by_key}
            dependencies[row['entity_key']] = identities
            for identity in identities: consumers.setdefault(identity, []).append(row['entity_key'])
        ready = [key for key, parents in dependencies.items() if not parents]; result = []
        for key in ready:
            result.append(by_key[key])
            for consumer in consumers.get(key, []):
                dependencies[consumer].remove(key)
                if not dependencies[consumer]: ready.append(consumer)
        if len(result) != len(selected): raise LegacyValidationError('Historical source has a dependency cycle')
        return result

    def apply(self, *, migration_id):
        from .legacy_import_semantic import SEMANTIC_MODELS
        from .legacy_import_experiments import handles as experimental_history_handles, ExperimentHistory
        if self.import_manifest_hash != _hash([VERSION, self.source_id, self.manifest['source_content_sha256'], self.bindings, self.row_bindings, self.files, self.message_order]):
            raise Conflict('Import configuration changed after its plan was prepared')
        if not isinstance(migration_id, str) or not 1 <= len(migration_id) <= 512: raise LegacyValidationError('Explicit migration ID required')
        plan = self.plan()
        if plan['blocked']: raise LegacyValidationError('Semantic import plan has unresolved rows; inspect plan issue counts')
        if verify_export(self.directory)['source_content_sha256'] != self.manifest['source_content_sha256']:
            raise Conflict('Frozen source export changed')
        result = {'format': VERSION, 'imported': 0, 'replayed': 0, 'pending': 0, 'blocked': 0, 'production_cutover_ready': False}
        for row in self._ordered():
            owner = self._owner(row)
            with self.control.transaction() as con:
                scope, grant, workspace = self._actor(con, owner)
                old = con.execute('SELECT source_fingerprint,target_watermark FROM migration_checkpoints WHERE migration_id=?', (migration_id,)).fetchall()
                if any(item[0] != self.manifest['source_content_sha256'] or json.loads(item[1]).get('import_manifest_hash') != self.import_manifest_hash for item in old):
                    raise Conflict('Migration ID is pinned to another source snapshot or identity mapping')
                receipt = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?', (workspace, INBOX, row['entity_key'])).fetchone()
                checkpoint = con.execute('SELECT * FROM migration_checkpoints WHERE workspace_id=? AND migration_id=? AND source_table=?', (workspace, migration_id, self._checkpoint_id(row))).fetchone()
                if receipt:
                    if receipt[0] != row['content_hash']: raise Conflict('Stable source entity has different content; explicit reconciliation required')
                    if not checkpoint: raise Conflict('Source entity belongs to another migration; verify and explicitly reuse its checkpoint')
                    if not self._verify_one(con, row, json.loads(checkpoint['target_watermark'])): raise Conflict('Previously verified import is no longer indexed')
                    result['replayed'] += 1
                    continue
                if checkpoint:
                    proof = json.loads(checkpoint['target_watermark'])
                    if not self._verify_one(con, row, proof): result['pending'] += 1; continue
                    con.execute("UPDATE migration_checkpoints SET state='verified',etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND migration_id=? AND source_table=?",
                        (self.control.clock(), workspace, migration_id, self._checkpoint_id(row)))
                else:
                    if experimental_history_handles(row): proof = ExperimentHistory(self).write(con, row, scope, workspace, owner)
                    elif row['model'] in CONTROL_MODELS: proof = self._control(con, row, scope, grant, workspace, owner)
                    elif row['model'] in {'CustomEvaluatorList', 'AgentEvalDataset'}:
                        from .legacy_import_assets import AssetHistory
                        proof = AssetHistory(self).write(con, row, scope, workspace, owner)
                    elif row['model'] in {'InfraSource', 'InfraMetricSample', 'SessionInfraLink', 'RasAnomalyEvent'}:
                        from .legacy_import_telemetry import TelemetryHistory
                        proof = TelemetryHistory(self).write(con, row, scope, workspace, owner)
                    elif row['model'] in {'FaultDiagnosisSession', 'FaultDiagnosisMessage', 'DiagnosisRun', 'AgentDebugReport', 'AgentDebugSkillsAnalysis'}:
                        from .legacy_import_diagnosis import DiagnosisHistory
                        proof = DiagnosisHistory(self).write(con, row, scope, workspace, owner)
                    elif row['model'] in SEMANTIC_MODELS:
                        from .legacy_import_semantic import SemanticHistory
                        proof = SemanticHistory(self).write(con, row, scope, workspace, owner)
                    elif row['model'] in {'TraceDatasetGenerationJob', 'TraceDatasetOperationReceipt'}:
                        from .legacy_generation import GenerationHistory
                        proof = GenerationHistory(self).write(con, row, scope, workspace, owner)
                    else:
                        from .legacy_import_traces import TraceHistory
                        proof = TraceHistory(self).write(con, row, scope, workspace, owner)
                    _, raw_ref = self.control.persist_artifact({'format': VERSION, 'source_id': self.source_id,
                        'table': row['table'], 'columns': row['columns'], 'values': row['raw'], 'entity_key': row['entity_key']})
                    proof['source_ref'] = raw_ref
                    proof['import_manifest_hash'] = self.import_manifest_hash
                    ready = self._verify_one(con, row, proof)
                    self._checkpoint(con, migration_id, row, proof, state='verified' if ready else 'running')
                    if not ready: result['pending'] += 1; continue
                con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (workspace, INBOX, row['entity_key'], row['content_hash'], self.control.clock()))
                result['imported'] += 1
        return result

    def _verify_one(self, con, row, proof):
        workspace = self.bindings[self._owner(row)]['workspace_id']
        if 'import_manifest_hash' in proof and proof['import_manifest_hash'] != self.import_manifest_hash: raise Conflict('Import identity mapping changed')
        if 'source_ref' in proof:
            self.control._verify_artifact(Path(proof['source_ref']).name, proof['source_ref'])
            source = json.loads(Path(proof['source_ref']).read_text())
            if source != {'format': VERSION, 'source_id': self.source_id, 'table': row['table'], 'columns': row['columns'], 'values': row['raw'], 'entity_key': row['entity_key']}:
                raise Conflict('Imported raw provenance differs from the frozen source row')
        if proof['domain'] == 'control':
            target = con.execute('SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND record_id=?', (workspace, proof['kind'], proof['record_id'])).fetchone()
            if target is None or target['payload_hash'] != proof['payload_hash'] or target['revision'] != proof['revision'] or target['state'] != 'active' or target['owner_principal_id'] != self.bindings[self._owner(row)]['principal_id']:
                raise Conflict('Imported target changed or is missing; do not overwrite current data')
            PlatformControls(self.control)._data(dict(target))
            return True
        if proof['domain'] in {'trace', 'thread', 'trace_tag'}:
            from .legacy_import_traces import TraceHistory
            return TraceHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'asset_history':
            from .legacy_import_assets import AssetHistory
            return AssetHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'telemetry':
            from .legacy_import_telemetry import TelemetryHistory
            return TelemetryHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'diagnosis_history':
            from .legacy_import_diagnosis import DiagnosisHistory
            return DiagnosisHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'semantic_history':
            from .legacy_import_semantic import SemanticHistory
            return SemanticHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'generation_history':
            from .legacy_generation import GenerationHistory
            return GenerationHistory(self).verify(con, row, workspace, proof)
        if proof['domain'] == 'experiment_history':
            from .legacy_import_experiments import ExperimentHistory
            return ExperimentHistory(self).verify(con, row, workspace, proof)
        raise LegacyValidationError('Unsupported target proof')

    def verify(self, *, migration_id):
        result = {'format': VERSION, 'verified': 0, 'production_cutover_ready': False}
        with self.control.read_transaction() as con:
            for row in self.rows:
                if not row['selected']: continue
                _, _, workspace = self._actor(con, self._owner(row), 'read')
                checkpoint = con.execute('SELECT * FROM migration_checkpoints WHERE workspace_id=? AND migration_id=? AND source_table=?', (workspace, migration_id, self._checkpoint_id(row))).fetchone()
                if checkpoint is None or checkpoint['source_fingerprint'] != self.manifest['source_content_sha256']: raise Conflict('Matching import checkpoint is missing')
                if not self._verify_one(con, row, json.loads(checkpoint['target_watermark'])): raise Conflict('Imported facts are not yet indexed')
                result['verified'] += 1
        return result
