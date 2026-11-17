"""Explicit inert imports into the experiment and Benchmark domain authorities."""
import copy
import base64
import datetime
import hashlib
import json
import math
import uuid

from .control import Conflict
from .experiments import ExperimentStore, _json, _hash, _iso
from .iam import IAMStore, Forbidden
from .legacy import LegacyValidationError
from .legacy_history import INERT_SOURCE, control_history_key

SUPPORTED_MODELS = frozenset({'Experiment', 'ExperimentGroup', 'ExperimentCase',
    'ExperimentEvalResult', 'ExperimentEvalComment', 'ExperimentCancellation',
    'ExperimentTraceAttempt', 'ExperimentLocalExecution', 'BenchmarkDataset', 'BenchmarkDatasetCase',
    'BenchmarkExperimentBinding', 'BenchmarkCaseRun', 'BenchmarkArtifact', 'BenchmarkDispatchOutbox',
    'BenchmarkEvaluation', 'BenchmarkEvaluationArtifact', 'BenchmarkEvaluationDispatchOutbox',
    'TrajectoryEvalResult', 'TraceEvaluation', 'Evaluation', 'SkillIssue', 'ExecutionMatch', 'SkillTriggerEvalRun'})
VIEW_SOURCE = 'legacy-experiment-view/v1'
HEAD_STATUSES = {'draft', 'queued', 'running', 'done', 'partial', 'failed', 'cancelled'}
RESULT_STATUSES = {'pending', 'running', 'done', 'failed', 'cancelled', 'skipped'}


def _ms(value):
    if type(value) is int and value >= 0: return value
    if isinstance(value, str):
        try:
            stamp = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if stamp.tzinfo is None: raise ValueError('timezone required')
            result = round(stamp.timestamp() * 1000)
            if result >= 0: return result
        except ValueError: pass
    raise LegacyValidationError('An exact nonnegative historical timestamp is required')


def _internal(row, purpose):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'legacy-history:' + row['entity_key'] + ':' + purpose))


def handles(row):
    return row['model'] in SUPPORTED_MODELS and not (row['model'] == 'Evaluation' and row['data'].get('type') == 'static') and not (row['model'] == 'SkillIssue' and row['data'].get('source') in {'static', 'feedback'})


def _view_source(experiment, model):
    return VIEW_SOURCE + ':' + _hash(experiment) + ':' + model


def _insert(con, table, value):
    columns = list(value)
    con.execute('INSERT INTO ' + table + '(' + ','.join(columns) + ') VALUES(' + ','.join('?' for _ in columns) + ')', tuple(value.values()))


class ExperimentHistory:
    def __init__(self, importer):
        self.importer = importer
        self.control = importer.control
        self.store = ExperimentStore(self.control)
        self.iam = IAMStore(self.control)

    def issues(self, row):
        data = row['data']; model = row['model']; issues = []
        if model not in SUPPORTED_MODELS: return ['experiment_history_transformer_missing']
        if model == 'Experiment' and (data.get('status') not in HEAD_STATUSES or data.get('type', 'single') not in {'single', 'llm', 'framework', 'skill'}):
            issues.append('historical_experiment_status_not_representable')
        if model == 'ExperimentEvalResult' and data.get('status') not in RESULT_STATUSES:
            issues.append('historical_result_status_not_representable')
        if model in {'BenchmarkArtifact', 'BenchmarkEvaluationArtifact'} and row['entity_key'] not in getattr(self.importer, 'files', {}):
            issues.append('benchmark_artifact_bytes_required')
        if model == 'Evaluation' and data.get('type') not in {'dynamic', 'trigger'}: issues.append('static_evaluation_requires_control_importer')
        if model == 'SkillIssue' and data.get('source') not in {'dynamic', 'trigger'}: issues.append('static_issue_requires_control_importer')
        if model == 'BenchmarkDataset' and data.get('status') not in {'ready', 'deleted'}:
            issues.append('historical_benchmark_dataset_incomplete')
        return issues

    def _source(self, model, identity):
        values = [row for row in self.importer.rows if row['model'] == model and row['data'].get('id') == identity]
        if len(values) != 1: raise LegacyValidationError('Historical dependency is missing or ambiguous: ' + model)
        return values[0]

    def _head(self, con, ws, identity, principal):
        row = con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?', (ws, identity)).fetchone()
        if not row: raise Conflict('Historical Experiment must be imported first')
        if row['created_by'] != principal: raise Forbidden('Historical dependency belongs to another owner')
        if not con.execute('SELECT 1 FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
                (ws, INERT_SOURCE, control_history_key('experiment', identity))).fetchone():
            raise Conflict('Existing live Experiment cannot be adopted by a historical import')
        return dict(row)

    def _marker(self, con, ws, kind, identity, digest, now):
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (ws, INERT_SOURCE, control_history_key(kind, identity), digest, now))

    def _target(self, con, table, keys):
        found = con.execute('SELECT * FROM ' + table + ' WHERE ' + ' AND '.join(key + '=?' for key in keys), tuple(keys.values())).fetchone()
        if found is None: raise Conflict('Imported historical target is missing')
        return {'table': table, 'keys': keys, 'target_hash': _hash(dict(found))}

    def _proof(self, con, targets, artifacts=(), facts=None):
        return {'domain': 'experiment_history', 'targets': [self._target(con, table, keys) for table, keys in targets],
                'artifacts': [{'hash': digest, 'ref': ref} for digest, ref in artifacts], 'facts': facts or {}}

    def _trace(self, con, ws, data, principal):
        traces = []
        for field, kind in [('executionId', 'execution'), ('taskId', 'task')]:
            if not data.get(field): continue
            found = con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',
                                (ws, kind, data[field])).fetchone()
            if not found: raise Conflict('Historical Trace dependency has no imported alias')
            traces.append(found[0])
        if len(set(traces)) > 1: raise Conflict('Historical Trace aliases disagree')
        if not traces: return None
        found = con.execute("SELECT t.trace_id,a.owner_principal_id FROM trace_locators t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id WHERE t.workspace_id=? AND t.trace_id=?", (ws, traces[0])).fetchone()
        if not found or found['owner_principal_id'] != principal: raise Forbidden('Historical Trace belongs to another owner')
        return traces[0]

    def write(self, con, row, scope, workspace, owner):
        binding = self.importer.bindings.get(owner)
        if not binding or binding['principal_id'] != scope.principal_id or binding['workspace_id'] != workspace:
            raise Forbidden('Historical import actor differs from its explicit owner mapping')
        proof = self._write(con, row, scope, workspace, owner)
        proof.update(source_entity_key=row['entity_key'], source_content_hash=row['content_hash'],
                     owner_principal_id=scope.principal_id, workspace_id=workspace)
        return proof

    def _write(self, con, row, scope, workspace, owner):
        issues = self.issues(row)
        if issues: raise LegacyValidationError(','.join(issues))
        self.iam._workspace(scope, workspace, 'write')
        data = copy.deepcopy(row['data']); model = row['model']; identity = data.get('id', data.get('experimentId'))
        if model in {'Evaluation', 'SkillIssue'}: return self._derived(con, row, scope, workspace)
        if model in {'TrajectoryEvalResult', 'TraceEvaluation', 'ExecutionMatch'}: return self._trace_result(con, row, scope, workspace)
        if model == 'SkillTriggerEvalRun': return self._trigger(con, row, scope, workspace)
        if model.startswith('Benchmark'): return self._benchmark(con, row, scope, workspace, owner)
        if model == 'Experiment': return self._experiment(con, row, scope, workspace)
        head = self._head(con, workspace, data['experimentId'], scope.principal_id)
        if model == 'ExperimentGroup':
            value = self.store._load(head['metadata_hash'], head['metadata_ref'])
            if data not in value.get('groups', []): raise Conflict('Historical Group differs from sealed Experiment membership')
            return self._proof(con, [('experiment_heads', {'workspace_id': workspace, 'experiment_id': head['experiment_id']})], [(head['metadata_hash'], head['metadata_ref'])])
        if model == 'ExperimentCase': return self._case(con, row, scope, workspace, head)
        if model == 'ExperimentEvalResult': return self._result(con, row, scope, workspace, head)
        if model in {'ExperimentTraceAttempt', 'ExperimentLocalExecution'}:
            if model == 'ExperimentTraceAttempt':
                if not con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=?',
                        (workspace, head['experiment_id'], data['caseId'])).fetchone(): raise Conflict('Historical Trace attempt Case is missing')
                if data.get('traceId'): self._trace(con, workspace, {'taskId': data['traceId']}, scope.principal_id)
            return self._view(con, row, workspace, head)
        kind = 'comment' if model == 'ExperimentEvalComment' else 'cancellation'
        if model == 'ExperimentEvalComment':
            case = data.get('caseId'); result = data.get('resultId')
            if result and not case:
                result_row = con.execute('SELECT case_id FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND result_id=?',
                                         (workspace, head['experiment_id'], result)).fetchone()
                if not result_row: raise Conflict('Comment result dependency missing')
                case = result_row[0]
            actor = self.importer.bindings.get(data['user'])
            if not actor or actor['workspace_id'] != workspace: raise Forbidden('Historical comment author requires an explicit mapping')
            principal = actor['principal_id']
            if not con.execute('SELECT 1 FROM iam_principals WHERE principal_id=?', (principal,)).fetchone(): raise Forbidden('Comment author does not exist')
        else: case = None; result = None; principal = scope.principal_id
        if con.execute('SELECT 1 FROM experiment_annotations WHERE workspace_id=? AND annotation_id=?', (workspace, identity)).fetchone(): raise Conflict('Historical annotation ID already exists')
        digest, ref = self.store._put(data)
        _insert(con, 'experiment_annotations', {'workspace_id': workspace, 'experiment_id': head['experiment_id'],
            'annotation_id': identity, 'kind': kind, 'case_id': case, 'result_id': result,
            'actor_principal_id': principal, 'payload_hash': digest, 'payload_ref': ref, 'created_at_ms': _ms(data['createdAt'])})
        return self._proof(con, [('experiment_annotations', {'workspace_id': workspace, 'annotation_id': identity})], [(digest, ref)])

    def _experiment(self, con, row, scope, ws):
        data = copy.deepcopy(row['data']); identity = data['id']; created = _ms(data['createdAt']); updated = _ms(data['updatedAt'])
        if updated < created: raise LegacyValidationError('Historical Experiment dates are reversed')
        if con.execute('SELECT 1 FROM experiment_heads WHERE workspace_id=? AND experiment_id=?', (ws, identity)).fetchone(): raise Conflict('Historical Experiment ID already exists')
        data['groups'] = [copy.deepcopy(value['data']) for value in self.importer.rows
                          if value['model'] == 'ExperimentGroup' and value['data']['experimentId'] == identity]
        digest, ref = self.store._put(data)
        deleted = _ms(data['deletedAt']) if data.get('deletedAt') else None
        _insert(con, 'experiment_heads', {'workspace_id': ws, 'experiment_id': identity, 'name': data['name'],
            'type': data.get('type', 'single'), 'scope': data.get('scope', ''), 'skill_name': data.get('skillName', ''),
            'agent_name': data.get('agentName', ''), 'status': data['status'], 'watch_mode': int(data.get('watchMode', False)),
            'watch_enabled_at_ms': _ms(data['watchEnabledAt']) if data.get('watchEnabledAt') else None,
            'metadata_hash': digest, 'metadata_ref': ref, 'state': 'deleted' if deleted is not None else 'active',
            'created_by': scope.principal_id, 'deleted_at_ms': deleted, 'created_at_ms': created, 'updated_at_ms': updated})
        self.iam._record_resource(con, ws, 'run', identity, scope.principal_id, 'private', invalidate_policy=False)
        self._marker(con, ws, 'experiment', identity, row['content_hash'], created)
        cases = row.get('history_cases') or [copy.deepcopy(value['data']) for value in self.importer.rows if value['model'] == 'ExperimentCase' and value['data']['experimentId'] == identity]
        config = {'benchmark_lifecycle': 1, 'benchmark_case_lifecycles': {value['id']: 1 for value in cases}} if data.get('scope') == 'benchmark' else {}
        releases = {}
        if data.get('scope') == 'benchmark':
            bindings = [value for value in self.importer.rows if value['model'] == 'BenchmarkExperimentBinding' and value['data']['experimentId'] == identity]
            if len(bindings) != 1: raise LegacyValidationError('Historical Benchmark requires its unique source binding')
            dataset = con.execute('SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?', (ws, bindings[0]['data']['datasetId'])).fetchone()
            if not dataset or dataset['created_by'] != scope.principal_id: raise Forbidden('Historical Benchmark Dataset must be imported before its Experiment')
            releases = {'dataset': dataset['public_release_id'], 'benchmark': dataset['private_release_id']}
        plan = {'format': 'legacy-experiment-plan/v1', 'historical_only': True,
            'legacy_import': {'source_id': self.importer.source_id, 'entity_key': row['entity_key'],
                              'content_hash': row['content_hash'], 'owner': scope.principal_id,
                              'metadata_hash': digest},
            'releases': releases, 'config': config, 'experiment_config': copy.deepcopy(data), 'cases': cases,
            'frozen_evaluators': {}, 'frozen_trace_evidence': row.get('history_trace_routes', {}), 'work_members': [], 'expected_case_count': len(cases)}
        hashed, plan_ref = self.store._put(plan); run = _internal(row, 'run')
        _insert(con, 'runs', {'workspace_id': ws, 'run_id': run, 'name': data['name'], 'plan_hash': hashed,
            'plan_manifest_ref': plan_ref, 'expected_case_count': len(cases), 'status': 'draft',
            'created_at_ms': created, 'updated_at_ms': updated})
        _insert(con, 'experiment_runs', {'workspace_id': ws, 'experiment_id': identity, 'run_id': run,
            'generation': 1, 'lifecycle_revision': 1, 'created_by': scope.principal_id, 'created_at_ms': created})
        for slot, release in releases.items():
            con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)', (ws, run, slot, release, _hash(config), created))
        con.execute('UPDATE runs SET status=? WHERE workspace_id=? AND run_id=?', (data['status'], ws, run))
        con.execute('UPDATE experiment_heads SET current_run_id=?,revision=revision+1 WHERE workspace_id=? AND experiment_id=?', (run, ws, identity))
        return self._proof(con, [('experiment_heads', {'workspace_id': ws, 'experiment_id': identity}),
            ('runs', {'workspace_id': ws, 'run_id': run})], [(digest, ref), (hashed, plan_ref)])

    def _case(self, con, row, scope, ws, head):
        data = copy.deepcopy(row['data']); identity = data['id']; exp = head['experiment_id']
        if con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND case_id=?', (ws, identity)).fetchone(): raise Conflict('Historical Case ID already exists')
        trace = self._trace(con, ws, data, scope.principal_id); created = _ms(data['createdAt'])
        members = [value for value in self.importer.rows if value['model'] == 'ExperimentCase' and value['data']['experimentId'] == exp]
        members.sort(key=lambda value: (_ms(value['data']['createdAt']), value['data']['id']))
        ordinal = row['history_ordinal'] if 'history_ordinal' in row else next(i for i, value in enumerate(members) if value['entity_key'] == row['entity_key'])
        digest, ref = self.store._put(data); deleted = _ms(data['deletedAt']) if data.get('deletedAt') else None
        _insert(con, 'experiment_cases', {'workspace_id': ws, 'experiment_id': exp, 'case_id': identity,
            'ordinal': ordinal, 'state': 'deleted' if deleted is not None else 'active', 'payload_hash': digest,
            'payload_ref': ref, 'trace_id': trace, 'deleted_at_ms': deleted, 'created_at_ms': created,
            'updated_at_ms': created, 'binding_hash': _hash([trace, data.get('groupId')]) if trace else None})
        return self._proof(con, [('experiment_cases', {'workspace_id': ws, 'case_id': identity})], [(digest, ref)])

    def _trace_result(self, con, row, scope, ws):
        data = copy.deepcopy(row['data']); source = None
        if data.get('executionId'): source = self._source('Execution', data['executionId'])['data']
        elif data.get('taskId'):
            matches = [value for value in self.importer.rows if value['model'] == 'Execution' and value['data'].get('taskId') == data['taskId']]
            if len(matches) != 1: raise LegacyValidationError('Historical task-only Trace dependency is missing or ambiguous')
            source = matches[0]['data']
        elif row['model'] != 'TrajectoryEvalResult': raise LegacyValidationError('Historical Trace reference is required')
        trace = self._trace(con, ws, {'executionId': source['id'] if source else None, 'taskId': data.get('taskId')}, scope.principal_id)
        route = dict(con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?', (ws, trace)).fetchone()) if trace else None
        identity = _internal(row, 'experiment'); case_id = _internal(row, 'case'); result_id = _internal(row, 'result-slot')
        created = data.get('createdAt', data.get('ranAt', data.get('matchedAt'))); updated = data.get('updatedAt', created)
        flow = row['model'] == 'ExecutionMatch'; status = 'done' if flow else data['status']
        if status not in RESULT_STATUSES: raise LegacyValidationError('Historical Trace result status cannot be represented')
        trajectory = row['model'] == 'TrajectoryEvalResult'
        evaluator = '__trace_flow_match__' if flow else '__direct_trajectory__' if trajectory else 'legacy-metric:' + data['evaluatorId'] + ':' + data['metricKey']
        case = {'id': case_id, 'experimentId': identity, 'executionId': source['id'] if source else None,
            'taskId': source.get('taskId') if source else None, 'input': source.get('query') or '' if source else '',
            'actualOutput': source.get('finalResult') or '' if source else '', 'createdAt': created}
        head = {'id': identity, 'user': self.importer._owner(row), 'name': 'Legacy ' + row['model'] + ': ' + data['id'],
            'type': 'single', 'scope': 'legacy-flow-analysis' if flow else 'trajectory-direct' if trajectory else 'trace-metrics-history',
            'status': 'queued' if status == 'pending' else status if status in HEAD_STATUSES else 'done',
            'evaluatorIdsJson': _json([evaluator]), 'evaluatorConfigsJson': '{}', 'createdAt': created, 'updatedAt': updated,
            'legacy_source': {'model': row['model'], 'id': data['id']}}
        value = copy.deepcopy(data)
        if flow:
            mode = data.get('mode', 'compare')
            if mode not in {'compare', 'dynamic'}: raise LegacyValidationError('Historical Flow mode cannot be represented')
            skill = None
            if mode == 'compare':
                record = _skill_record(con, ws, scope.principal_id, data['skillId'], data['skillVersion'])
                skill = {'id': data['skillId'], 'name': json.loads(record['metadata_json'])['name'], 'version': data['skillVersion']}
                head['legacy_skill'] = {'id': data['skillId'], 'version': data['skillVersion']}
            manifest = {'version': 1, 'mode': mode, 'trace_id': trace, 'skill': skill,
                'quality_receipts': [], 'historical_source_reference_only': True}
            head['legacy_flow_manifest'] = manifest
            value.update(version=1, mode=mode, usedSkillName=skill['name'] if skill else None,
                usedSkillVersion=skill['version'] if skill else None, flowJson=None)
        def packed(model, value, purpose):
            return {'model': model, 'data': value, 'entity_key': _hash([row['entity_key'], purpose]), 'content_hash': row['content_hash']}
        head_row = packed('Experiment', head, 'head'); head_row['history_cases'] = [case]
        head_row['history_trace_routes'] = {case_id: {'historical_source_reference_only': True,
            'manifest': {key: route[key] for key in ['trace_id', 'incarnation', 'route_epoch']},
            'execution': {'id': source['id'], 'taskId': source.get('taskId')}, 'session': {}}} if route else {}
        first = self._experiment(con, head_row, scope, ws)
        actual_head = self._head(con, ws, identity, scope.principal_id)
        case_row = packed('ExperimentCase', case, 'case'); case_row['history_ordinal'] = 0
        second = self._case(con, case_row, scope, ws, actual_head)
        score = data.get('trajectoryScore') if trajectory else data.get('score')
        result = {'id': result_id, 'experimentId': identity, 'caseId': case_id, 'evaluatorId': evaluator,
            'status': status, 'score': score * 100 if trajectory and score is not None else score,
            'errorMessage': data.get('errorMessage'), 'createdAt': created, 'updatedAt': updated,
            'evidenceJson': _json({'json': {'coreFlowMatch' if flow else 'directTrajectory' if trajectory else 'traceEvaluation': value}})}
        third = self._result(con, packed('ExperimentEvalResult', result, 'result'), scope, ws, actual_head)
        return {'domain': 'experiment_history', 'targets': first['targets'] + second['targets'] + third['targets'],
            'artifacts': first['artifacts'] + second['artifacts'] + third['artifacts'], 'facts': third['facts']}

    def _trigger(self, con, row, scope, ws):
        data = copy.deepcopy(row['data']); identity = data['id']; created = data['createdAt']; updated = data['updatedAt']
        records = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind='skill' AND owner_principal_id=? AND state='active' LIMIT 20001", (ws, scope.principal_id)).fetchall()
        if len(records) > 20000: raise LegacyValidationError('Historical Skill lookup exceeds budget')
        matches = [value for value in records if json.loads(value['metadata_json']).get('name') == data['skillName']]
        if len(matches) != 1: raise Forbidden('Historical Trigger Skill owner/name is missing or ambiguous')
        skill_id = matches[0]['record_id']; _skill_record(con, ws, scope.principal_id, skill_id, data['skillVersion'])
        if data['status'] not in {'running', 'done', 'failed', 'cancelled'}: raise LegacyValidationError('Historical Trigger status cannot be represented')
        results = json.loads(data['resultsJson'])
        if not isinstance(results, list): raise LegacyValidationError('Historical Trigger result members must be an array')
        case_id = _internal(row, 'case'); result_id = _internal(row, 'slot')
        case = {'id': case_id, 'experimentId': identity, 'input': '', 'actualOutput': '', 'createdAt': created}
        head_data = {'id': identity, 'user': self.importer._owner(row), 'name': 'Legacy Trigger: ' + data['skillName'],
            'type': 'skill', 'scope': 'skill-trigger-analysis', 'skillName': data['skillName'], 'skillVersion': data['skillVersion'],
            'status': data['status'], 'evaluatorIdsJson': '["__skill_trigger_live__"]', 'evaluatorConfigsJson': '{}',
            'configSnapshotJson': _json({'coreTrigger': {'kind': 'run', 'historical_only': True}}),
            'createdAt': created, 'updatedAt': updated, 'legacy_skill': {'id': skill_id, 'version': data['skillVersion']},
            'legacy_trigger': data}
        def packed(model, value, purpose):
            return {'model': model, 'data': value, 'entity_key': _hash([row['entity_key'], purpose]), 'content_hash': row['content_hash']}
        head_row = packed('Experiment', head_data, 'head'); head_row['history_cases'] = [case]
        first = self._experiment(con, head_row, scope, ws); head = self._head(con, ws, identity, scope.principal_id)
        case_row = packed('ExperimentCase', case, 'case'); case_row['history_ordinal'] = 0
        second = self._case(con, case_row, scope, ws, head)
        report = {'items': results, 'passRate': data['passRate'], 'truePositiveRate': data['truePositiveRate'], 'falsePositiveRate': data['falsePositiveRate']}
        result = {'id': result_id, 'experimentId': identity, 'caseId': case_id, 'evaluatorId': '__skill_trigger_live__',
            'status': data['status'], 'score': data['passRate'] * 100 if data['status'] == 'done' else None,
            'durationMs': data.get('durationMs'), 'errorMessage': data.get('errorMessage'),
            'createdAt': created, 'updatedAt': updated, 'evidenceJson': _json({'json': {'coreTriggerResult': report}})}
        third = self._result(con, packed('ExperimentEvalResult', result, 'result'), scope, ws, head)
        return {'domain': 'experiment_history', 'targets': first['targets'] + second['targets'] + third['targets'],
            'artifacts': first['artifacts'] + second['artifacts'] + third['artifacts'], 'facts': third['facts']}

    def _derived(self, con, row, scope, ws):
        data = copy.deepcopy(row['data']); identity = data['id']; kind = 'derived-evaluation' if row['model'] == 'Evaluation' else 'derived-issue'
        if con.execute('SELECT 1 FROM experiment_annotations WHERE workspace_id=? AND annotation_id=?', (ws, identity)).fetchone(): raise Conflict('Historical derived identity already exists')
        _skill_record(con, ws, scope.principal_id, data['skillId'], data['version'])
        if row['model'] == 'SkillIssue':
            parent = con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='derived-evaluation'", (ws, data['evaluationId'])).fetchone()
            if not parent: raise Conflict('Historical Issue Evaluation must be imported first')
            head = self._head(con, ws, parent['experiment_id'], scope.principal_id)
            original = self.store._load(parent['payload_hash'], parent['payload_ref'])
            if original['skillId'] != data['skillId'] or original['version'] != data['version'] or original['type'] != data['source']:
                raise Conflict('Historical Issue escaped its actual Evaluation Skill/version/source')
            case = parent['case_id']; result_id = parent['result_id']; machine = parent['machine_result_id']; base = None
        else:
            created = data['ranAt']; exp_id = _internal(row, 'experiment'); case = _internal(row, 'case'); result_id = _internal(row, 'slot')
            status = {'ok': 'done', 'partial': 'done', 'failed': 'failed'}.get(data['status'])
            if status is None: raise LegacyValidationError('Historical Evaluation status cannot be represented')
            source = self._source('Execution', data['executionId'])['data'] if data.get('executionId') else None
            trace = self._trace(con, ws, {'executionId': data.get('executionId')}, scope.principal_id)
            case_data = {'id': case, 'experimentId': exp_id, 'executionId': data.get('executionId'),
                'taskId': source.get('taskId') if source else None, 'input': source.get('query') or '' if source else '',
                'actualOutput': source.get('finalResult') or '' if source else '', 'createdAt': created}
            head_data = {'id': exp_id, 'user': self.importer._owner(row), 'name': 'Legacy Skill Evaluation: ' + identity,
                'type': 'single', 'scope': 'legacy-skill-evaluation', 'skillName': '', 'skillVersion': data['version'],
                'status': status, 'evaluatorIdsJson': '["__legacy_skill_evaluation__"]', 'evaluatorConfigsJson': '{}',
                'createdAt': created, 'updatedAt': created, 'legacy_skill': {'id': data['skillId'], 'version': data['version']}}
            def packed(model, value, purpose):
                return {'model': model, 'data': value, 'entity_key': _hash([row['entity_key'], purpose]), 'content_hash': row['content_hash']}
            head_row = packed('Experiment', head_data, 'head'); head_row['history_cases'] = [case_data]
            if trace:
                route = dict(con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?', (ws, trace)).fetchone())
                head_row['history_trace_routes'] = {case: {'historical_source_reference_only': True,
                    'manifest': {key: route[key] for key in ['trace_id', 'incarnation', 'route_epoch']},
                    'execution': {'id': source['id'], 'taskId': source.get('taskId')}, 'session': {}}}
            first = self._experiment(con, head_row, scope, ws); head = self._head(con, ws, exp_id, scope.principal_id)
            case_row = packed('ExperimentCase', case_data, 'case'); case_row['history_ordinal'] = 0
            second = self._case(con, case_row, scope, ws, head)
            result = {'id': result_id, 'experimentId': exp_id, 'caseId': case, 'evaluatorId': '__legacy_skill_evaluation__',
                'status': status, 'score': None, 'createdAt': created, 'updatedAt': created,
                'evidenceJson': _json({'json': {'legacyEvaluation': data}})}
            third = self._result(con, packed('ExperimentEvalResult', result, 'result'), scope, ws, head)
            machine = next(value['keys']['result_id'] for value in third['targets'] if value['table'] == 'result_receipts')
            base = {'domain': 'experiment_history', 'targets': first['targets'] + second['targets'] + third['targets'],
                'artifacts': first['artifacts'] + second['artifacts'] + third['artifacts'], 'facts': third['facts']}
        digest, ref = self.store._put(data)
        _insert(con, 'experiment_annotations', {'workspace_id': ws, 'experiment_id': head['experiment_id'],
            'annotation_id': identity, 'kind': kind, 'case_id': case, 'result_id': result_id, 'machine_result_id': machine,
            'actor_principal_id': scope.principal_id, 'payload_hash': digest, 'payload_ref': ref,
            'created_at_ms': _ms(data.get('createdAt', data.get('ranAt'))), 'lookup_key': data['skillId']})
        proof = self._proof(con, [('experiment_annotations', {'workspace_id': ws, 'annotation_id': identity})], [(digest, ref)])
        if base:
            base['targets'] += proof['targets']; base['artifacts'] += proof['artifacts']; return base
        return proof

    def _view(self, con, row, ws, head, *, data=None, extra_targets=(), artifacts=()):
        identity = row['data'].get('id', row['data'].get('experimentId'))
        source = _view_source(head['experiment_id'], row['model'])
        packet = {'format': VIEW_SOURCE, 'model': row['model'], 'owner': head['created_by'],
            'experiment_id': head['experiment_id'], 'head_revision': head['revision'],
            'head_lifecycle_revision': head['lifecycle_revision'], 'data': data if data is not None else row['data']}
        digest, ref = self.store._put(packet)
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (ws, source, identity, digest, self.control.clock()))
        targets = [('inbox_receipts', {'workspace_id': ws, 'source_id': source, 'event_id': identity}), *extra_targets]
        return self._proof(con, targets, [(digest, ref), *artifacts])

    def _benchmark(self, con, row, scope, ws, owner):
        from .benchmark_core import BenchmarkStore
        from .datasets import DatasetStore
        store = BenchmarkStore(self.control); data = copy.deepcopy(row['data']); model = row['model']
        if model in {'BenchmarkDataset', 'BenchmarkDatasetCase'}:
            identity = data['id'] if model == 'BenchmarkDataset' else data['datasetId']
            if model == 'BenchmarkDatasetCase':
                head = con.execute('SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?', (ws, identity)).fetchone()
                if not head or head['created_by'] != scope.principal_id: raise Conflict('Historical Benchmark Dataset must be imported first')
                member = next((value for value in store._private_dataset(con, dict(head))['cases'] if value['id'] == data['id']), None)
                if not member or member.get('legacy') != data: raise Conflict('Benchmark Case differs from sealed original membership')
                return self._proof(con, [('benchmark_dataset_heads', {'workspace_id': ws, 'dataset_id': identity})])
            if con.execute('SELECT 1 FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?', (ws, identity)).fetchone(): raise Conflict('Historical Benchmark Dataset ID already exists')
            public = con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (ws, data['agentEvalDatasetId'])).fetchone()
            if not public or public['created_by'] != scope.principal_id: raise Forbidden('Historical public Dataset is missing or belongs to another owner')
            dataset_store = DatasetStore(self.control)
            root = dataset_store._load(public['manifest_hash'], public['manifest_ref'])
            public_data = copy.deepcopy(root.get('dataset', root.get('metadata', root)))
            original = self._source('AgentEvalDataset', data['agentEvalDatasetId']) if any(value['model'] == 'AgentEvalDataset' and value['data']['id'] == data['agentEvalDatasetId'] for value in self.importer.rows) else None
            if original:
                public_data = {key: value for key, value in original['data'].items() if key not in {'casesJson', 'fieldsJson', 'tagsJson'}}
                for key in ['cases', 'fields', 'tags']: public_data[key] = json.loads(original['data'].get(key + 'Json', '[]'))
            public_data.setdefault('name', data['name']); public_data.setdefault('cases', [])
            cases = []
            for source in self.importer.rows:
                if source['model'] != 'BenchmarkDatasetCase' or source['data']['datasetId'] != identity: continue
                value = source['data']; cases.append({'id': value['id'], 'externalCaseId': value['externalCaseId'],
                    'ordinal': value['ordinal'], 'rawCase': json.loads(value['rawCaseJson']),
                    'publicPayload': json.loads(value['publicPayloadJson']), 'privatePayload': json.loads(value['privatePayloadJson']),
                    'sourceFingerprint': value['sourceFingerprint'], 'publicFingerprint': value['publicFingerprint'],
                    'privateFingerprint': value['privateFingerprint'], 'legacy': copy.deepcopy(value)})
            cases.sort(key=lambda value: value['ordinal'])
            if len(cases) != data['caseCount'] or [value['ordinal'] for value in cases] != list(range(len(cases))):
                raise LegacyValidationError('Historical Benchmark Dataset membership is incomplete')
            private = {'format': 'benchmark-dataset/v1', 'dataset_id': identity, 'adapter_key': data['adapterKey'],
                'source': json.loads(data.get('sourceJson', '{}')), 'public_dataset': public_data, 'cases': cases, 'legacy': data}
            digest, ref = store._put(private); created = _ms(data['createdAt']); updated = _ms(data['updatedAt'])
            asset = _internal(row, 'private-asset'); release = _internal(row, 'private-release')
            _insert(con, 'asset_identities', {'workspace_id': ws, 'asset_id': asset, 'kind': 'benchmark', 'name': 'benchmark:' + asset,
                'created_at_ms': created, 'updated_at_ms': updated})
            self.iam._record_resource(con, ws, 'asset', asset, scope.principal_id, 'private', invalidate_policy=False)
            _insert(con, 'asset_releases', {'workspace_id': ws, 'release_id': release, 'asset_id': asset, 'version_label': '1',
                'content_hash': digest, 'manifest_ref': ref, 'schema_version': 1, 'publisher_id': scope.principal_id, 'created_at_ms': updated})
            con.execute('INSERT INTO asset_release_seals VALUES(?,?,?,0,?)', (ws, release, asset, updated))
            content = data['contentHash'].removeprefix('sha256:')
            _insert(con, 'benchmark_dataset_heads', {'workspace_id': ws, 'dataset_id': identity,
                'public_dataset_id': data['agentEvalDatasetId'], 'public_asset_id': public['asset_id'], 'public_release_id': public['release_id'],
                'private_asset_id': asset, 'private_release_id': release, 'adapter_key': data['adapterKey'], 'content_hash': content,
                'state': 'deleted' if data.get('status') == 'deleted' else 'active', 'revision': 1, 'lifecycle_revision': 1,
                'created_by': scope.principal_id, 'created_at_ms': created, 'updated_at_ms': updated})
            return self._proof(con, [('benchmark_dataset_heads', {'workspace_id': ws, 'dataset_id': identity})], [(digest, ref)])
        if model == 'BenchmarkExperimentBinding':
            head = self._head(con, ws, data['experimentId'], scope.principal_id)
            dataset = con.execute('SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?', (ws, data['datasetId'])).fetchone()
            if not dataset or dataset['created_by'] != scope.principal_id: raise Forbidden('Benchmark Dataset owner differs')
            private = store._private_dataset(con, dict(dataset)); source_cases = {value['id']: value for value in private['cases']}
            source_head = self._source('Experiment', data['experimentId'])['data']; evaluators = json.loads(source_head.get('evaluatorIdsJson', '[]'))
            if len(evaluators) != 1: raise LegacyValidationError('Historical Benchmark adapter evaluator binding is ambiguous')
            cases = []
            for source in self.importer.rows:
                if source['model'] != 'ExperimentCase' or source['data']['experimentId'] != data['experimentId']: continue
                runs = [value for value in self.importer.rows if value['model'] == 'BenchmarkCaseRun' and value['data']['experimentCaseId'] == source['data']['id']]
                members = {value['data'].get('datasetCaseId') for value in runs}
                if len(members) != 1 or next(iter(members)) not in source_cases: raise LegacyValidationError('Historical Benchmark Case source binding is unavailable')
                cases.append({**copy.deepcopy(source['data']), 'dataset_case': copy.deepcopy(source_cases[next(iter(members))])})
            if len(cases) != data['expectedCaseCount']: raise LegacyValidationError('Historical Benchmark binding Case count differs')
            binding = {'format': 'benchmark-binding/v1', 'dataset_id': data['datasetId'],
                'dataset_content_hash': data['datasetContentHash'], 'public_release_id': dataset['public_release_id'],
                'private_release_id': dataset['private_release_id'], 'selection': json.loads(data['selectionJson']),
                'run_config': json.loads(data['runConfigJson']), 'adapter': {'key': data['adapterKey'], 'evaluatorId': evaluators[0]},
                'cases': cases, 'historical_only': True, 'legacy': data}
            digest, ref = store._put(binding)
            _insert(con, 'benchmark_experiment_bindings', {'workspace_id': ws, 'experiment_id': data['experimentId'],
                'dataset_id': data['datasetId'], 'public_release_id': dataset['public_release_id'], 'private_release_id': dataset['private_release_id'],
                'binding_hash': digest, 'binding_ref': ref, 'actor_principal_id': scope.principal_id, 'created_at_ms': _ms(data['createdAt'])})
            return self._proof(con, [('benchmark_experiment_bindings', {'workspace_id': ws, 'experiment_id': data['experimentId']})], [(digest, ref)])
        if model in {'BenchmarkCaseRun', 'BenchmarkEvaluation'}:
            parent = None
            if model == 'BenchmarkCaseRun':
                head = self._head(con, ws, data['experimentId'], scope.principal_id); case = data['experimentCaseId']; kind = 'execute'
            else:
                parent = con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?', (ws, data['caseRunId'])).fetchone()
                if not parent or parent['actor_principal_id'] != scope.principal_id: raise Forbidden('Historical Benchmark parent job is unavailable')
                head = self._head(con, ws, parent['experiment_id'], scope.principal_id); case = parent['case_id']; kind = 'evaluate'
            if not con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=?', (ws, head['experiment_id'], case)).fetchone(): raise Conflict('Historical Benchmark Case missing')
            identity = data['id']; work = _internal(row, 'job-import'); run = head['current_run_id']; created = _ms(data['createdAt']); updated = _ms(data['updatedAt'])
            if con.execute('SELECT 1 FROM benchmark_jobs WHERE workspace_id=? AND job_id=?', (ws, identity)).fetchone(): raise Conflict('Historical Benchmark Job ID already exists')
            origin, is_api = self.iam._authenticate(con, self.importer.actors[owner]); origin_id = origin['credential_id'] if is_api else origin['session_id']
            work_slot = 'legacy-benchmark:' + identity
            _insert(con, 'work_items', {'workspace_id': ws, 'work_item_id': work, 'run_id': run, 'case_key': case,
                'phase': 'migrate', 'evaluator_slot': work_slot, 'status': 'done', 'created_at_ms': created, 'updated_at_ms': updated})
            request = {'historical_only': True, 'legacy': data}
            if data.get('taskEnvelopeJson'): request['task'] = json.loads(data['taskEnvelopeJson'])
            request_hash, request_ref = store._put(request)
            progress = json.loads(data['progressJson']) if data.get('progressJson') else {}
            progress_hash, progress_ref = store._put(progress)
            completion = {'historical_only': True, 'legacy': data}
            for field, key in [('runFactsJson', 'runFacts'), ('cleanupJson', 'cleanup'), ('runtimeFactsJson', 'runtimeFacts')]:
                if data.get(field): completion[key] = json.loads(data[field])
            completion_hash, completion_ref = store._put(completion)
            status = {'evaluated': 'completed', 'queued': 'queued' if kind == 'evaluate' else 'pending'}.get(data['status'], data['status'])
            allowed = {'pending','preparing','dispatching','dispatch_unknown','running_agent','collecting','uploading','cleaning','submitted','queued','running_evaluator','normalizing','normalization_failed','completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid'}
            if status not in allowed: raise LegacyValidationError('Historical Benchmark status cannot be represented')
            _insert(con, 'benchmark_jobs', {'workspace_id': ws, 'job_id': identity, 'experiment_id': head['experiment_id'],
                'case_id': case, 'run_id': run, 'work_item_id': work, 'kind': kind, 'parent_job_id': parent['job_id'] if parent else None,
                'adapter_key': data['adapterKey'], 'evaluator_key': data.get('evaluatorKey'), 'attempt_no': data.get('attemptNo', 1),
                'retry_of_job_id': data.get('retryOfEvaluationId') if parent else data.get('retryOfRunId'),
                'origin_credential_id': origin_id, 'origin_credential_kind': 'api' if is_api else 'session', 'actor_principal_id': scope.principal_id,
                'protocol_state': status, 'revision': 1, 'request_hash': request_hash, 'request_ref': request_ref,
                'progress_hash': progress_hash, 'progress_ref': progress_ref, 'completion_hash': completion_hash,
                'completion_ref': completion_ref, 'callback_epoch': 0, 'created_at_ms': created, 'updated_at_ms': updated})
            self._marker(con, ws, 'benchmarkJob', identity, row['content_hash'], created)
            targets = [('benchmark_jobs', {'workspace_id': ws, 'job_id': identity})]
            artifacts = [(request_hash, request_ref), (progress_hash, progress_ref), (completion_hash, completion_ref)]
            facts = {}
            if model == 'BenchmarkEvaluation' and data.get('normalizedResultJson'):
                normalized = json.loads(data['normalizedResultJson'])
                if not isinstance(normalized, dict): raise LegacyValidationError('Historical normalized Benchmark result must be an object')
                attempt = _internal(row, 'normalization-receipt'); machine = _internal(row, 'normalized-machine')
                _insert(con, 'work_attempts', {'workspace_id': ws, 'attempt_id': attempt, 'work_item_id': work,
                    'attempt_no': 1, 'fence': 1, 'worker_id': 'legacy-history-importer', 'status': 'done',
                    'lease_until_ms': updated, 'started_at_ms': updated, 'finished_at_ms': updated})
                packet = {'format': 'agent-insight.machine-result', 'version': 1, 'historical_only': True,
                    'source_kind': 'legacy-history/v1', 'run_id': run, 'case_key': case, 'evaluator_slot': work_slot,
                    'attempt_id': attempt, 'result': normalized}
                hashed, reference = self.store._put(packet); artifacts.append((hashed, reference))
                _insert(con, 'result_receipts', {'workspace_id': ws, 'run_id': run, 'work_item_id': work, 'case_key': case,
                    'evaluator_slot': work_slot, 'receipt_id': _internal(row, 'normalization-receipt-id'), 'attempt_id': attempt,
                    'receipt_key': row['entity_key'], 'result_id': machine, 'content_hash': hashed, 'artifact_ref': reference,
                    'state': 'accepted', 'created_at_ms': updated})
                targets.append(('result_receipts', {'workspace_id': ws, 'result_id': machine}))
                score = normalized.get('score')
                if score is not None and (type(score) not in (int, float) or not math.isfinite(score)):
                    raise LegacyValidationError('Historical normalized Benchmark score is not finite')
                fact = {'workspace_id': ws, 'result_bucket': _iso(updated)[:10], 'result_id': machine,
                    'run_id': run, 'case_key': case, 'attempt_id': attempt, 'evaluator_release_id': 'legacy:' + data['evaluatorKey'],
                    'input_snapshot_id': 'legacy-case:' + case, 'verdict': normalized.get('verdict') or 'inconclusive',
                    'summary': (normalized.get('summary') or '')[:200], 'evidence_ref': 'experiment.machine:' + hashed,
                    'content_hash': hashed, 'created_at_ms': updated, 'schema_version': 1, 'retry_version': 1}
                metric = {'workspace_id': ws, 'result_bucket': _iso(updated)[:10], 'result_id': machine,
                    'metric_definition_release_id': 'legacy:benchmark:score/v1', 'metric_key': 'score', 'dimension_key': '',
                    'value_type': 'missing' if score is None else 'float', 'value_int': None, 'value_float': score,
                    'value_decimal': '', 'value_text': '', 'unit': '', 'method': '', 'evidence_ref': '', 'retry_version': 1}
                metric['content_hash'] = _hash(metric); facts = {'eval_result_facts': [fact], 'eval_metric_facts': [metric]}
                if self.importer.facts is None: raise LegacyValidationError('Historical result import requires a facts target')
                for table, values in facts.items(): self.importer.facts._insert(table, values)
            proof = self._view(con, row, ws, head, extra_targets=targets, artifacts=artifacts)
            proof['facts'] = facts
            return proof
        job_id = data['runId'] if model in {'BenchmarkArtifact', 'BenchmarkDispatchOutbox'} else data['evaluationId']
        job = con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?', (ws, job_id)).fetchone()
        if not job or job['actor_principal_id'] != scope.principal_id: raise Forbidden('Historical Benchmark artifact/dispatch job is missing')
        head = self._head(con, ws, job['experiment_id'], scope.principal_id)
        if model in {'BenchmarkDispatchOutbox', 'BenchmarkEvaluationDispatchOutbox'}:
            return self._view(con, row, ws, head)
        files = getattr(self.importer, 'files', {})[row['entity_key']]
        if isinstance(files, list):
            if len(files) != 1: raise LegacyValidationError('A Benchmark artifact requires one explicit byte object')
            files = files[0]
        encoded = files.get('content', files.get('bytes_base64'))
        try: raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError): raise LegacyValidationError('Explicit Benchmark artifact base64 bytes required') from None
        digest = hashlib.sha256(raw).hexdigest()
        if digest != data['sha256'].removeprefix('sha256:') or len(raw) != data['sizeBytes']: raise Conflict('Historical Benchmark artifact byte hash/size differs')
        stored_hash, stored_ref = store._put({'format': 'benchmark-bytes/v1', 'bytes_base64': encoded})
        _insert(con, 'benchmark_artifacts', {'workspace_id': ws, 'job_id': job_id, 'artifact_id': data['id'],
            'name': data['name'], 'kind': data.get('kind', 'submission'), 'media_type': data['mediaType'],
            'content_hash': digest, 'size_bytes': len(raw), 'storage_hash': stored_hash, 'storage_ref': stored_ref,
            'contract_hash': row['content_hash'], 'created_at_ms': _ms(data['createdAt'])})
        return self._proof(con, [('benchmark_artifacts', {'workspace_id': ws, 'artifact_id': data['id']})], [(stored_hash, stored_ref)])

    def _result(self, con, row, scope, ws, head):
        data = copy.deepcopy(row['data']); exp = head['experiment_id']; case = data['caseId']; identity = data['id']; evaluator = data['evaluatorId']
        if not con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=?', (ws, exp, case)).fetchone(): raise Conflict('Historical result Case dependency missing')
        if con.execute('SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND (result_id=? OR (case_id=? AND evaluator_id=?))', (ws, identity, case, evaluator)).fetchone(): raise Conflict('Historical result slot already exists')
        created = _ms(data['createdAt']); updated = _ms(data['updatedAt']); run = head['current_run_id']
        if updated < created: raise LegacyValidationError('Historical result dates are reversed')
        work = _internal(row, 'receipt-work'); attempt = _internal(row, 'receipt-attempt'); machine = _internal(row, 'machine')
        imported_at = self.control.clock()
        _insert(con, 'work_items', {'workspace_id': ws, 'work_item_id': work, 'run_id': run,
            'case_key': case, 'phase': 'migrate', 'evaluator_slot': evaluator, 'status': 'done', 'created_at_ms': imported_at, 'updated_at_ms': imported_at})
        _insert(con, 'work_attempts', {'workspace_id': ws, 'attempt_id': attempt, 'work_item_id': work,
            'attempt_no': 1, 'fence': 1, 'worker_id': 'legacy-history-importer', 'status': 'done',
            'lease_until_ms': imported_at, 'started_at_ms': imported_at, 'finished_at_ms': imported_at})
        value = {key: value for key, value in data.items() if not key.startswith('human')}
        packet = {'format': 'agent-insight.machine-result', 'version': 1, 'historical_only': True,
            'source_kind': 'legacy-history/v1', 'run_id': run, 'case_key': case, 'evaluator_slot': evaluator,
            'attempt_id': attempt, 'result': value}
        digest, ref = self.store._put(packet)
        _insert(con, 'result_receipts', {'workspace_id': ws, 'run_id': run, 'work_item_id': work,
            'case_key': case, 'evaluator_slot': evaluator, 'receipt_id': _internal(row, 'receipt'),
            'attempt_id': attempt, 'receipt_key': row['entity_key'], 'result_id': machine,
            'content_hash': digest, 'artifact_ref': ref, 'state': 'accepted', 'created_at_ms': updated})
        _insert(con, 'result_selections', {'workspace_id': ws, 'run_id': run, 'case_key': case,
            'evaluator_slot': evaluator, 'result_id': machine, 'selection_revision': 1, 'updated_at_ms': updated})
        _insert(con, 'experiment_result_slots', {'workspace_id': ws, 'experiment_id': exp, 'case_id': case,
            'result_id': identity, 'evaluator_id': evaluator, 'run_id': run, 'work_item_id': work,
            'selected_result_id': machine, 'status': data['status'], 'evaluation_version': data.get('attempts', 0),
            'created_at_ms': created, 'updated_at_ms': updated})
        artifacts = [(digest, ref)]; targets = [('experiment_result_slots', {'workspace_id': ws, 'result_id': identity}),
            ('result_receipts', {'workspace_id': ws, 'result_id': machine})]
        review = None
        if any(value is not None for key, value in data.items() if key.startswith('human')):
            review = _internal(row, 'review'); review_data = {key: value for key, value in data.items() if key.startswith('human')}
            human = self.importer.bindings.get(data.get('humanBy'))
            if data.get('humanBy') and (not human or human['workspace_id'] != ws): raise Forbidden('Historical reviewer requires an explicit identity mapping')
            review_hash, review_ref = self.store._put(review_data); artifacts.append((review_hash, review_ref))
            _insert(con, 'experiment_annotations', {'workspace_id': ws, 'experiment_id': exp,
                'annotation_id': review, 'kind': 'review', 'case_id': case, 'result_id': identity,
                'machine_result_id': machine, 'actor_principal_id': human['principal_id'] if human else scope.principal_id,
                'payload_hash': review_hash, 'payload_ref': review_ref,
                'created_at_ms': _ms(data['humanAt']) if data.get('humanAt') else updated})
            con.execute('UPDATE experiment_result_slots SET review_id=?,revision=revision+1 WHERE workspace_id=? AND result_id=?', (review, ws, identity))
            targets.append(('experiment_annotations', {'workspace_id': ws, 'annotation_id': review}))
        bucket = _iso(updated)[:10]; verdict = data.get('verdict') or ('error' if data['status'] == 'failed' else 'inconclusive')
        facts = {'eval_result_facts': [{'workspace_id': ws, 'result_bucket': bucket, 'result_id': machine,
            'run_id': run, 'case_key': case, 'attempt_id': attempt, 'evaluator_release_id': 'legacy:' + evaluator,
            'input_snapshot_id': 'legacy-case:' + case, 'verdict': verdict, 'summary': (data.get('summary') or '')[:200],
            'evidence_ref': 'experiment.machine:' + digest, 'content_hash': digest, 'created_at_ms': updated,
            'schema_version': 1, 'retry_version': 1}], 'eval_metric_facts': [],
            'eval_result_selection_current': [{'workspace_id': ws, 'run_bucket': _iso(head['created_at_ms'])[:10],
                'run_id': run, 'case_key': case, 'evaluator_slot': evaluator, 'result_id': machine,
                'selection_revision': 1, 'review_decision_id': review or '', 'is_deleted': int(head['state'] != 'active')}]}
        for key, value in [('score', data.get('score')), ('human_score', data.get('humanScore'))]:
            if key == 'human_score' and value is None: continue
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise LegacyValidationError('Historical metric is not finite')
            metric = {'workspace_id': ws, 'result_bucket': bucket, 'result_id': machine,
                'metric_definition_release_id': 'builtin:' + key + '/v1', 'metric_key': key,
                'dimension_key': review if key == 'human_score' else '', 'value_type': 'missing' if value is None else 'float',
                'value_int': None, 'value_float': value, 'value_decimal': '', 'value_text': '', 'unit': 'points',
                'method': '', 'evidence_ref': '', 'retry_version': 1}
            metric['content_hash'] = _hash(metric); facts['eval_metric_facts'].append(metric)
        if self.importer.facts is None: raise LegacyValidationError('Historical result import requires an explicit facts target')
        for table, values in facts.items(): self.importer.facts._insert(table, values)
        return self._proof(con, targets, artifacts, facts)

    def verify(self, con, row, workspace, proof):
        owner = self.importer.bindings.get(self.importer._owner(row))
        if not owner or proof.get('source_entity_key') != row['entity_key'] or proof.get('source_content_hash') != row['content_hash'] or proof.get('owner_principal_id') != owner['principal_id'] or proof.get('workspace_id') != workspace or owner['workspace_id'] != workspace:
            raise Conflict('Historical target proof differs from the source row or owner mapping')
        allowed = {'experiment_heads', 'runs', 'experiment_cases', 'experiment_result_slots',
                   'experiment_annotations', 'result_receipts', 'result_selections', 'inbox_receipts',
                   'benchmark_dataset_heads', 'benchmark_experiment_bindings', 'benchmark_jobs', 'benchmark_artifacts'}
        for target in proof['targets']:
            if target['table'] not in allowed or target['keys'].get('workspace_id') != workspace:
                raise LegacyValidationError('Unknown historical verification target')
            actual = self._target(con, target['table'], target['keys'])
            if actual['target_hash'] != target['target_hash']: raise Conflict('Imported historical target changed; refusing overwrite')
        for artifact in proof.get('artifacts', []): self.control._verify_artifact(artifact['hash'], artifact['ref'])
        facts = self.importer.facts
        for table, values in proof.get('facts', {}).items():
            if hasattr(facts, '_request'):
                identity = values[0]
                query = 'SELECT * FROM ' + table + ' FINAL WHERE workspace_id={w:String} AND result_id={r:String} FORMAT JSONEachRow'
                actual = [json.loads(line) for line in facts._request(query, parameters={'w': workspace, 'r': identity['result_id']}).splitlines() if line]
            elif hasattr(facts, 'rows'): actual = facts.rows.get(table, [])
            else: raise LegacyValidationError('Historical fact target has no readback contract')
            for value in values:
                if not any(all(candidate.get(key) == expected or str(candidate.get(key)) == str(expected)
                               for key, expected in value.items()) for candidate in actual): return False
        return True


def _views(store, con, ws, head, models):
    if head['state'] != 'active': return []
    marker = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
        (ws, INERT_SOURCE, control_history_key('experiment', head['experiment_id']))).fetchone()
    if not marker: return []
    result = []; size = 0
    for model in models:
        source = _view_source(head['experiment_id'], model)
        rows = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? ORDER BY event_id LIMIT 10001', (ws, source)).fetchall()
        if len(rows) > 10000: raise LegacyValidationError('Historical projection exceeds the original response budget')
        for row in rows:
            value = store._load(row['content_hash'], str(store.control.artifact_directory / row['content_hash']))
            if value.get('format') != VIEW_SOURCE or value.get('model') != model or value.get('experiment_id') != head['experiment_id'] or value.get('owner') != head['created_by']:
                raise Conflict('Historical view receipt identity differs')
            if value.get('head_revision') != head['revision'] or value.get('head_lifecycle_revision') != head['lifecycle_revision']: continue
            size += len(_json(value).encode())
            if size > 64*1024*1024: raise LegacyValidationError('Historical projection exceeds the original response budget')
            result.append(value)
    return result


def enrich_snapshot(store, con, ws, head, snapshot):
    values = _views(store, con, ws, head, ['ExperimentTraceAttempt', 'ExperimentLocalExecution'])
    if not values: return snapshot
    cases = {value['id']: value for value in snapshot['experiment']['cases']}
    for value in values:
        data = copy.deepcopy(value['data'])
        if value['model'] == 'ExperimentLocalExecution': snapshot['local_executions'].append(data)
        elif data['caseId'] in cases:
            case = cases[data['caseId']]
            if not any(existing['id'] == data['id'] for existing in case['traceAttempts']): case['traceAttempts'].append(data)
    for case in cases.values(): case['traceAttempts'].sort(key=lambda value: (value['attemptNo'], value.get('createdAt', ''), value['id']), reverse=True)
    snapshot['experiment']['traceAttempts'] = [value for case in cases.values() for value in case['traceAttempts']]
    return snapshot


def historical_benchmark_plan(store, con, scope, ws, exp, run):
    head = con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?', (ws, exp)).fetchone()
    if not head: return None
    marker = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
        (ws, INERT_SOURCE, control_history_key('experiment', exp))).fetchone()
    if not marker: return None
    store.iam._authorize_scope(con, scope, ws, 'read', 'run', exp)
    if head['state'] != 'active': raise Conflict('Historical Benchmark has been deleted')
    _, plan = store.experiments._plan(con, ws, exp, run or head['current_run_id'])
    binding = plan.get('legacy_import', {})
    if plan.get('format') != 'legacy-experiment-plan/v1' or plan.get('historical_only') is not True or binding.get('owner') != head['created_by'] or binding.get('content_hash') != marker[0] or binding.get('metadata_hash') != head['metadata_hash']:
        raise Conflict('Historical Benchmark import authority differs')
    row = con.execute('SELECT b.*,d.public_asset_id,d.private_asset_id,d.created_by FROM benchmark_experiment_bindings b JOIN benchmark_dataset_heads d ON d.workspace_id=b.workspace_id AND d.dataset_id=b.dataset_id WHERE b.workspace_id=? AND b.experiment_id=?', (ws, exp)).fetchone()
    if not row or row['created_by'] != head['created_by'] or row['actor_principal_id'] != head['created_by']:
        raise Forbidden('Historical Benchmark source owner differs')
    for asset, release, kind in [(row['public_asset_id'], row['public_release_id'], 'dataset'), (row['private_asset_id'], row['private_release_id'], 'benchmark')]:
        seal = con.execute('SELECT a.kind,s.asset_id,p.owner_principal_id FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id JOIN iam_resource_access p ON p.workspace_id=s.workspace_id AND p.resource_kind=\'asset\' AND p.resource_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?', (ws, release)).fetchone()
        if not seal or seal['asset_id'] != asset or seal['kind'] != kind or seal['owner_principal_id'] != head['created_by']:
            raise Forbidden('Historical Benchmark private/public seal owner differs')
        if kind == 'dataset': store.iam._authorize_scope(con, scope, ws, 'read', 'asset', asset)
    return plan


def enrich_benchmark_view(store, con, ws, head, snapshot, scope):
    rows = _views(store.experiments, con, ws, head, ['BenchmarkCaseRun', 'BenchmarkEvaluation'])
    sources = {value['data']['id']: value for value in rows}; owner = scope.principal_id == head['created_by']
    for run in snapshot.get('benchmark_runs', []):
        source = sources.get(run['id'])
        if source:
            data = copy.deepcopy(source['data']); data.pop('storagePath', None)
            if not owner:
                data = {key: value for key, value in data.items() if key in {'id','experimentId','experimentCaseId','ordinal','status','adapterKey','retryOfRunId','startedAt','finishedAt','createdAt','updatedAt'}}
            run.update(data)
        for evaluation in run.get('evaluations', []):
            source = sources.get(evaluation['id'])
            if source:
                data = copy.deepcopy(source['data']); data.pop('storagePath', None)
                if not owner: data = {key: value for key, value in data.items() if key in {'id','caseRunId','attemptNo','status','adapterKey','evaluatorKey','createdAt','updatedAt','startedAt','finishedAt'}}
                evaluation.update(data)
    return snapshot


def _skill_record(con, ws, owner, identity, version):
    row = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind='skill' AND record_id=? AND state='active'", (ws, identity)).fetchone()
    if not row or row['owner_principal_id'] != owner: raise Forbidden('Historical Skill is deleted or its owner changed')
    versions = con.execute("SELECT metadata_json FROM platform_control_records WHERE workspace_id=? AND kind='skillVersion' AND parent_id=? AND owner_principal_id=? AND state='active'", (ws, identity, owner)).fetchall()
    if not any(json.loads(value['metadata_json']).get('version') == version for value in versions):
        raise Forbidden('Historical Skill version is unavailable')
    return row


def guard_historical_skill(store, con, ws, head):
    marker = con.execute('SELECT 1 FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
        (ws, INERT_SOURCE, control_history_key('experiment', head['experiment_id']))).fetchone()
    if not marker: return
    data = store._load(head['metadata_hash'], head['metadata_ref']); skill = data.get('legacy_skill')
    if skill: _skill_record(con, ws, head['created_by'], skill['id'], skill['version'])


def _historical_plan(store, con, ws, head):
    marker = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
        (ws, INERT_SOURCE, control_history_key('experiment', head['experiment_id']))).fetchone()
    if not marker: return None
    _, plan = store._plan(con, ws, head['experiment_id'], head['current_run_id']); binding = plan.get('legacy_import', {})
    if head['state'] != 'active' or plan.get('format') != 'legacy-experiment-plan/v1' or plan.get('historical_only') is not True or binding.get('owner') != head['created_by'] or binding.get('content_hash') != marker[0] or binding.get('metadata_hash') != head['metadata_hash']:
        raise Conflict('Historical source authority or lifecycle differs')
    return plan


def historical_trigger_run(store, con, ws, scope, head):
    plan = _historical_plan(store, con, ws, head)
    if plan is None: return None
    metadata = store._load(head['metadata_hash'], head['metadata_ref']); source = metadata.get('legacy_trigger')
    if not isinstance(source, dict): return None
    store.iam._authorize_scope(con, scope, ws, 'read', 'run', head['experiment_id'])
    if scope.principal_id != head['created_by']: raise Forbidden('Historical Trigger requires its owner')
    guard_historical_skill(store, con, ws, head)
    if source['id'] != head['experiment_id'] or source['status'] != head['status']: raise Conflict('Historical Trigger current head differs')
    value = copy.deepcopy(source); value['results'] = json.loads(value.pop('resultsJson'))
    for key in ['durationMs', 'modelId', 'workspaceRoot', 'errorMessage']: value.setdefault(key, None)
    return value


def historical_flow_lookup(store, con, ws, scope, trace, experiment_id=None):
    native = con.execute("SELECT 1 FROM experiment_heads e JOIN experiment_cases c ON c.workspace_id=e.workspace_id AND c.experiment_id=e.experiment_id JOIN experiment_result_slots s ON s.workspace_id=c.workspace_id AND s.case_id=c.case_id WHERE e.workspace_id=? AND e.created_by=? AND e.scope='trace-flow-analysis' AND e.state='active' AND c.state='active' AND c.trace_id=? AND s.evaluator_id='__trace_flow_match__' AND s.status='done' AND s.selected_result_id IS NOT NULL LIMIT 1", (ws, scope.principal_id, trace)).fetchone()
    if native: return None
    params = [ws, scope.principal_id, trace]
    extra = ''
    if experiment_id: extra = ' AND e.experiment_id=?'; params.append(experiment_id)
    rows = con.execute("SELECT e.*,c.case_id,s.result_id AS slot_id,s.selected_result_id FROM experiment_heads e JOIN experiment_cases c ON c.workspace_id=e.workspace_id AND c.experiment_id=e.experiment_id JOIN experiment_result_slots s ON s.workspace_id=c.workspace_id AND s.case_id=c.case_id WHERE e.workspace_id=? AND e.created_by=? AND e.scope='legacy-flow-analysis' AND e.state='active' AND c.state='active' AND c.trace_id=? AND s.evaluator_id='__trace_flow_match__' AND s.status='done'" + extra + ' ORDER BY e.updated_at_ms DESC,e.experiment_id DESC LIMIT 2', tuple(params)).fetchall()
    for source in rows:
        head = dict(source); plan = _historical_plan(store, con, ws, head)
        if plan is None: continue
        store.iam._authorize_scope(con, scope, ws, 'read', 'run', head['experiment_id']); guard_historical_skill(store, con, ws, head)
        for route in store._source_routes(plan, head['case_id']): store._source_route(con, scope, ws, route)
        receipt = con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?', (ws, head['selected_result_id'])).fetchone()
        if not receipt or receipt['state'] == 'quarantined': raise Conflict('Historical Flow machine source unavailable')
        packet = store._load(receipt['content_hash'], receipt['artifact_ref'])
        value = json.loads(packet['result']['evidenceJson'])['json']['coreFlowMatch']
        manifest = store._load(head['metadata_hash'], head['metadata_ref'])['legacy_flow_manifest']
        if manifest['trace_id'] != trace or value['mode'] != manifest['mode']: raise Conflict('Historical Flow source identity differs')
        return {'experiment_id': head['experiment_id'], 'case_id': head['case_id'], 'result_slot_id': head['slot_id'],
            'machine_result_id': receipt['result_id'], 'content_hash': receipt['content_hash'], 'run_id': receipt['run_id'],
            'created_at': _iso(receipt['created_at_ms']), 'manifest': manifest, 'value': value}
    return None
