import hashlib
import json
import secrets
import uuid
from pathlib import Path

from .control import Conflict
from .experiments import ExperimentStore
from .legacy import LegacyValidationError
from .legacy_history import INERT_SOURCE, control_history_key
from .legacy_import import _hash, _ms
from .trace_reports import MAX_REPORT_BYTES

DIAGNOSIS_MODELS = frozenset({'FaultDiagnosisSession', 'FaultDiagnosisMessage', 'DiagnosisRun', 'AgentDebugReport', 'AgentDebugSkillsAnalysis'})


class DiagnosisHistory:
    def __init__(self, importer): self.importer = importer; self.control = importer.control

    def _trace(self, con, row, scope, workspace, execution):
        alias = con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?", (workspace, execution)).fetchone()
        if not alias: raise Conflict('Historical diagnosis references a missing Trace')
        owner = con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?", (workspace, alias[0])).fetchone()
        if not owner or owner[0] != scope.principal_id: raise Conflict('Historical diagnosis Trace belongs to another owner')
        self.importer.iam._authorize(con, self.importer.actors[self.importer._owner(row)], workspace, 'read', 'trace', alias[0])
        route = con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?', (workspace, alias[0])).fetchone()
        if route['state'] != 'active': raise Conflict('Historical diagnosis Trace is not active')
        return dict(route)

    def _messages(self, session):
        rows = self.importer.lookup_rows('FaultDiagnosisMessage', ['sessionId'], [session])
        if session in self.importer.message_order:
            order = self.importer.message_order[session]
            if not isinstance(order, list) or len(order) != len(rows) or set(order) != {row['data']['id'] for row in rows}:
                raise LegacyValidationError('Explicit historical message order must contain each message ID exactly once')
            index = {identity: ordinal for ordinal, identity in enumerate(order)}
            return sorted(rows, key=lambda row: index[row['data']['id']])
        clocks = [_ms(row['data']['createdAt']) for row in rows]
        if len(set(clocks)) != len(clocks): raise LegacyValidationError('Tied historical message clocks require an explicit message order')
        return sorted(rows, key=lambda row: _ms(row['data']['createdAt']))

    def issues(self, row):
        result = []
        data = row['data']
        if row['model'] in {'FaultDiagnosisSession', 'FaultDiagnosisMessage'}:
            session = data['id'] if row['model'] == 'FaultDiagnosisSession' else data['sessionId']
            try: self._messages(session)
            except LegacyValidationError: result.append('diagnosis_message_order_mapping_required')
        if row['model'] == 'FaultDiagnosisMessage' and data['role'] not in {'user', 'assistant'}: result.append('diagnosis_message_role_unsupported')
        if row['model'] in {'DiagnosisRun', 'AgentDebugReport', 'AgentDebugSkillsAnalysis'}:
            from .legacy_history import HISTORY_FENCE_VERSION
            if HISTORY_FENCE_VERSION < 1: result.append('inert_history_guard_required')
            if data['status'] not in {'pending', 'running', 'done', 'failed', 'skipped', 'cancelled'}: result.append('diagnosis_status_unsupported')
        if row['model'] == 'DiagnosisRun' and bool(data.get('experimentId')) != bool(data.get('caseId')): result.append('diagnosis_source_incomplete')
        return result

    def write(self, con, row, scope, workspace, owner):
        if row['model'] == 'FaultDiagnosisSession':
            data = row['data']; route = self._trace(con, row, scope, workspace, data['executionId'])
            messages = self._messages(data['id'])
            con.execute('INSERT INTO trace_diagnosis_sessions(workspace_id,session_id,trace_id,created_by,opencode_session_id,next_sequence,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)',
                (workspace, data['id'], route['trace_id'], scope.principal_id, data.get('opencodeSessionId'), len(messages)+1, _ms(data['createdAt']), _ms(data['updatedAt'])))
            target = con.execute('SELECT * FROM trace_diagnosis_sessions WHERE workspace_id=? AND session_id=?', (workspace, data['id'])).fetchone()
            return {'domain': 'diagnosis_history', 'kind': 'conversation', 'target_hash': _hash(dict(target))}
        if row['model'] == 'FaultDiagnosisMessage': return self._message(con, row, scope, workspace)
        if row['model'] == 'DiagnosisRun': return self._run(con, row, scope, workspace)
        return self._report(con, row, scope, workspace)

    def _message(self, con, row, scope, workspace):
        data = row['data']; session = con.execute('SELECT * FROM trace_diagnosis_sessions WHERE workspace_id=? AND session_id=?', (workspace, data['sessionId'])).fetchone()
        if not session or session['created_by'] != scope.principal_id: raise Conflict('Historical diagnosis conversation is unavailable')
        messages = self._messages(data['sessionId'])
        sequence = next(index+1 for index, message in enumerate(messages) if message['entity_key'] == row['entity_key'])
        request = 'legacy:' + row['entity_key']; stamp = _ms(data['createdAt'])
        con.execute('INSERT INTO trace_diagnosis_messages(workspace_id,session_id,message_id,seq,request_key,request_hash,role,state,content,content_hash,created_by,turn_fence,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
            (workspace, data['sessionId'], data['id'], sequence, request, row['content_hash'], data['role'],
             'accepted' if data['role'] == 'user' else 'done', data['content'], hashlib.sha256(data['content'].encode()).hexdigest(), scope.principal_id, stamp, stamp))
        target = con.execute('SELECT * FROM trace_diagnosis_messages WHERE workspace_id=? AND message_id=?', (workspace, data['id'])).fetchone()
        return {'domain': 'diagnosis_history', 'kind': 'message', 'target_hash': _hash(dict(target))}

    def _marker(self, con, workspace, kind, identity, row):
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (workspace, INERT_SOURCE,
            control_history_key(kind, identity), row['content_hash'], self.control.clock()))

    def _report(self, con, row, scope, workspace):
        data = row['data']; route = self._trace(con, row, scope, workspace, data['executionId'])
        kind = 'agent-debug' if row['model'] == 'AgentDebugReport' else 'skills-analysis'
        created = _ms(data['ranAt']); updated = _ms(data['updatedAt'])
        if data['status'] not in {'pending', 'running', 'done', 'failed', 'skipped'}: raise LegacyValidationError('Historical report state is unsupported')
        raw_payload = data.get('reportJson') if kind == 'agent-debug' else data.get('analysisJson')
        try: payload = json.loads(raw_payload) if raw_payload is not None else None
        except (TypeError, ValueError): raise LegacyValidationError('Historical report JSON is invalid') from None
        if payload is not None and not isinstance(payload, dict): raise LegacyValidationError('Historical report object required')
        def persist(value):
            text = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(',', ':'))
            if len(text.encode()) > MAX_REPORT_BYTES: raise LegacyValidationError('Historical report exceeds target byte budget')
            return self.control.persist_artifact({'encoding': 'diagnostic-report-json/v1', 'json': text})
        history = {'version': 1, 'source_entity_key': row['entity_key'], 'source_table': row['table'], 'source_row_hash': row['content_hash'], 'original_status': data['status'],
            'stats': {key: data[key] for key in ('stepCount', 'issueCount', 'llmCallCount', 'durationMs', 'keyActionCount') if key in data}}
        evidence = {'legacy_history': history, 'manifest': {key: route[key] for key in ('trace_id', 'incarnation', 'route_epoch')}}
        digest, evidence_ref = persist(evidence)
        payload_hash, payload_ref = persist(payload) if payload is not None else (None, None)
        stored_status = 'running' if data['status'] == 'pending' else data['status']
        con.execute('INSERT INTO diagnostic_report_runs(workspace_id,report_id,trace_id,kind,actor_principal_id,execution_id,interactions_hash,generator,scope_fingerprint,evidence_hash,evidence_ref,lease_secret_hash,status,payload_hash,payload_ref,error_message,lease_until_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (workspace, data['id'], route['trace_id'], kind, scope.principal_id, data['executionId'], data['interactionsHash'],
             data.get('generator') or 'legacy-skills-analysis-import/v1', scope.fingerprint, digest, evidence_ref,
             hashlib.sha256(secrets.token_bytes(32)).hexdigest(), stored_status, payload_hash, payload_ref,
             data.get('errorMessage'), created if stored_status == 'running' else None, created, updated))
        con.execute('INSERT INTO diagnostic_report_heads VALUES(?,?,?,?)', (workspace, route['trace_id'], kind, data['id']))
        self._marker(con, workspace, 'diagnosticReport', data['id'], row)
        target = con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND report_id=?', (workspace, data['id'])).fetchone()
        return {'domain': 'diagnosis_history', 'kind': 'report', 'target_hash': _hash(dict(target))}

    def retest_rows(self, row):
        data = row['data']
        try: snapshot = json.loads(data['inputSnapshotJson'])
        except (ValueError, TypeError): return [], ['invalid_snapshot']
        if not isinstance(snapshot, dict): return [], ['invalid_snapshot']
        selected = {}; missing = []
        def add(model, fields, values, required=True):
            rows = self.importer.lookup_rows(model, fields, values) if all(value is not None for value in values) else []
            rows = [item for item in rows if self.importer._owner(item) == self.importer._owner(row)]
            if required and len(rows) != 1: missing.append(model)
            for item in rows: selected[item['entity_key']] = item
            return rows
        executions = add('Execution', ['id'], [data.get('executionId')])
        for execution in executions: add('Session', ['taskId'], [execution['data'].get('taskId')])
        experiments = add('Experiment', ['id'], [data.get('experimentId')])
        add('ExperimentCase', ['id'], [data.get('caseId')])
        results = snapshot.get('results')
        if not isinstance(results, list) or not results: missing.append('completed_results')
        for result in results if isinstance(results, list) else []:
            if isinstance(result, dict): add('ExperimentEvalResult', ['id'], [result.get('id')])
            else: missing.append('invalid_result')
        experiment = snapshot.get('experiment')
        config = experiment.get('config', {}) if isinstance(experiment, dict) else {}
        if not isinstance(config, dict): config = {}
        add('AgentEvalDataset', ['id'], [config.get('datasetId') or config.get('agentEvalDatasetId')])
        if isinstance(results, list) and any(str(result.get('evaluatorId', '')).startswith('custom-') for result in results if isinstance(result, dict)):
            add('CustomEvaluatorList', ['user'], [self.importer._owner(row)])
        skills = snapshot.get('skills')
        if not isinstance(skills, list): missing.append('skills')
        for skill in skills if isinstance(skills, list) else []:
            if not isinstance(skill, dict): missing.append('invalid_skill'); continue
            for parent in add('Skill', ['name'], [skill.get('name')]):
                add('SkillVersion', ['skillId', 'version'], [parent['data']['id'], skill.get('version')])
        return list(selected.values()), sorted(set(missing))

    @staticmethod
    def verify_retest_baselines(control, con, token, workspace, principal, history, facts):
        from .legacy_import import LegacyImport, INBOX, VERSION, _decode
        from .observations import ObservationIngest
        from .iam import IAMStore
        from types import MethodType, SimpleNamespace
        from pathlib import Path
        baseline = history.get('retest_baseline')
        if not baseline or baseline.get('missing'):
            raise Conflict('Historical diagnosis has no complete migrated Trace/asset/source baseline; diagnose the current source again')
        tool = LegacyImport.__new__(LegacyImport)
        tool.control = control; tool.iam = IAMStore(control); tool.facts = facts; tool.ingest = ObservationIngest(control, facts)
        tool.source_id = baseline['source_id']; tool.import_manifest_hash = baseline['import_manifest_hash']
        tool.bindings = {'history': {'principal_id': principal, 'workspace_id': workspace}}
        tool.actors = {'history': token}; tool._owner = MethodType(lambda self, row: 'history', tool)
        for source in baseline['rows']:
            receipt = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?', (workspace, INBOX, source['entity_key'])).fetchone()
            checkpoints = con.execute('SELECT * FROM migration_checkpoints WHERE workspace_id=? AND source_table=?', (workspace, source['table'] + ':' + source['entity_key'])).fetchall()
            if not receipt or receipt[0] != source['content_hash'] or len(checkpoints) != 1 or checkpoints[0]['state'] != 'verified':
                raise Conflict('Historical diagnosis source migration is incomplete or ambiguous')
            if not tool._verify_one(con, source, json.loads(checkpoints[0]['target_watermark'])):
                raise Conflict('Historical diagnosis facts have not been indexed')
        own = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?', (workspace, INBOX, history['source_entity_key'])).fetchone()
        checkpoints = con.execute('SELECT target_watermark,state FROM migration_checkpoints WHERE workspace_id=? AND source_table=?', (workspace, history['source_table'] + ':' + history['source_entity_key'])).fetchall()
        if not own or own[0] != history['source_row_hash'] or len(checkpoints) != 1 or checkpoints[0]['state'] != 'verified': raise Conflict('Historical diagnosis has no verified import receipt')
        proof = json.loads(checkpoints[0]['target_watermark'])
        control._verify_artifact(Path(proof['source_ref']).name, proof['source_ref'])
        raw = json.loads(Path(proof['source_ref']).read_text())
        if raw.get('format') != VERSION or raw.get('source_id') != tool.source_id or raw.get('entity_key') != history['source_entity_key'] or _hash(raw['values']) != own[0]: raise Conflict('Historical diagnosis raw provenance changed')
        values = dict(zip(raw['columns'], map(_decode, raw['values'])))
        DiagnosisHistory(SimpleNamespace(control=control)).verify(con, {'data': {'id': values['id']}}, workspace, proof)
        return json.loads(values['inputSnapshotJson'])

    def _run(self, con, row, scope, workspace):
        data = row['data']; route = self._trace(con, row, scope, workspace, data['executionId'])
        try: snapshot = json.loads(data['inputSnapshotJson'])
        except (ValueError, TypeError): raise LegacyValidationError('Historical diagnosis snapshot is invalid') from None
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get('execution'), dict) or snapshot['execution'].get('id') != data['executionId']:
            raise LegacyValidationError('Historical diagnosis snapshot must retain its real Execution identity')
        created = _ms(data['createdAt']); updated = _ms(data['completedAt']) if data.get('completedAt') else created
        status = 'queued' if data['status'] == 'pending' else data['status']
        if status not in {'queued', 'running', 'done', 'failed', 'cancelled'}: raise LegacyValidationError('Historical DiagnosisRun status is unsupported')
        source = {'source_kind': 'experiment', 'experiment_id': data['experimentId'], 'case_id': data['caseId']} if data.get('experimentId') else {'source_kind': 'trace-report', 'execution_id': data['executionId']}
        history = {'version': 1, 'source_entity_key': row['entity_key'], 'source_table': row['table'], 'source_row_hash': row['content_hash'], 'original_status': data['status'], 'completed_at': data.get('completedAt'),
                   'attempt_id': data.get('attemptId'), 'lease_until': data.get('leaseUntil')}
        baseline_rows, missing = self.retest_rows(row)
        history['retest_baseline'] = {'source_id': self.importer.source_id, 'import_manifest_hash': self.importer.import_manifest_hash, 'missing': missing,
            'rows': [{key: item[key] for key in ('table', 'model', 'data', 'entity_key', 'content_hash', 'raw', 'columns')} for item in baseline_rows]}
        plan = {'legacy_history': history, 'snapshot': snapshot, 'config': {'retry_of_run_id': data.get('retryOfRunId'), 'model_selection': None},
            'evidence': {'manifest': {key: route[key] for key in ('trace_id', 'incarnation', 'route_epoch')}},
            'source': source, 'plans': [], 'generator': data['generatorVersion'], 'source_report': None}
        store = ExperimentStore(self.control)
        digest, ref = store._put(plan)
        con.execute('INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,1,?,?,?)',
            (workspace, data['id'], 'DiagnosisRun', digest, ref, status, created, updated))
        con.execute('INSERT INTO diagnosis_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (workspace, data['id'], scope.principal_id, data['requestKey'], source['source_kind'], data.get('experimentId'), data.get('caseId'),
             route['trace_id'], _hash([row['entity_key'], row['content_hash']]), data['inputHash'], data['generatorVersion'], digest, ref, created))
        self.importer.iam._record_resource(con, workspace, 'run', data['id'], scope.principal_id, 'private', invalidate_policy=False)
        self._marker(con, workspace, 'diagnosisRun', data['id'], row)
        if data.get('reportJson') is not None or data.get('errorMessage') is not None:
            try: report = json.loads(data['reportJson']) if data.get('reportJson') is not None else None
            except (TypeError, ValueError): raise LegacyValidationError('Historical diagnosis report JSON is invalid') from None
            packet = {'report': report, 'error_message': data.get('errorMessage'), 'progress': None, 'status': data['status']}
            payload_hash, payload_ref = store._put(packet)
            item = str(uuid.uuid5(uuid.NAMESPACE_URL, row['entity_key'] + ':migration-item'))
            attempt = str(uuid.uuid5(uuid.NAMESPACE_URL, row['entity_key'] + ':migration-attempt'))
            result = str(uuid.uuid5(uuid.NAMESPACE_URL, row['entity_key'] + ':migration-result'))
            receipt = str(uuid.uuid5(uuid.NAMESPACE_URL, row['entity_key'] + ':migration-receipt'))
            case = data.get('caseId') or data['executionId']
            con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'migrate','diagnosis','done',?,?)", (workspace, item, data['id'], case, created, updated))
            con.execute("INSERT INTO work_attempts VALUES(?,?,?,1,1,'legacy-import','done',?,?,?,NULL)", (workspace, attempt, item, created, created, updated))
            con.execute('INSERT INTO result_receipts(workspace_id,run_id,work_item_id,case_key,evaluator_slot,receipt_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                (workspace, data['id'], item, case, 'diagnosis', receipt, attempt, row['entity_key'], result, payload_hash, payload_ref, updated))
            con.execute('INSERT INTO result_selections VALUES(?,?,?,?,?,1,?)', (workspace, data['id'], case, 'diagnosis', result, updated))
        target = con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND diagnosis_id=?', (workspace, data['id'])).fetchone()
        return {'domain': 'diagnosis_history', 'kind': 'run', 'target_hash': _hash(dict(target)), 'run_status': status}

    def verify(self, con, row, workspace, proof):
        table, identity = {'conversation': ('trace_diagnosis_sessions', 'session_id'), 'message': ('trace_diagnosis_messages', 'message_id'),
            'report': ('diagnostic_report_runs', 'report_id'), 'run': ('diagnosis_runs', 'diagnosis_id')}[proof['kind']]
        target = con.execute('SELECT * FROM ' + table + ' WHERE workspace_id=? AND ' + identity + '=?', (workspace, row['data']['id'])).fetchone()
        if not target or _hash(dict(target)) != proof['target_hash']: raise Conflict('Imported diagnosis history changed or is missing')
        if proof['kind'] == 'report':
            head = con.execute('SELECT report_id FROM diagnostic_report_heads WHERE workspace_id=? AND trace_id=? AND kind=?',
                (workspace, target['trace_id'], target['kind'])).fetchone()
            if not head or head[0] != target['report_id']: raise Conflict('Imported report selection changed')
            for field in ('evidence_ref', 'payload_ref', 'progress_ref'):
                if target[field]: self.control._verify_artifact(Path(target[field]).name, target[field])
        if proof['kind'] == 'run':
            run = con.execute('SELECT * FROM runs WHERE workspace_id=? AND run_id=?', (workspace, row['data']['id'])).fetchone()
            if not run or run['status'] != proof['run_status']: raise Conflict('Imported DiagnosisRun state changed')
            self.control._verify_artifact(target['snapshot_hash'], target['snapshot_ref'])
            self.control._verify_artifact(run['plan_hash'], run['plan_manifest_ref'])
            for result in con.execute('SELECT artifact_ref,content_hash FROM result_receipts WHERE workspace_id=? AND run_id=?', (workspace, row['data']['id'])):
                self.control._verify_artifact(result['content_hash'], result['artifact_ref'])
        return True
