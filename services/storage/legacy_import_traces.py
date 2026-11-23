import copy
import hashlib
import json
import subprocess

from .collector_sources import CollectorSources, _hash as source_hash
from .collector_preparations import CollectorPreparations
from .control import Conflict
from .legacy import LegacyValidationError
from .legacy_import import _hash, _ms

TRACE_MODELS = frozenset({'Execution', 'Session', 'TraceThread', 'TraceThreadEvent', 'ExecutionSkill', 'ExecutionSkillOrigin', 'Tag', 'ExecutionTag'})


def _array(value):
    if value is None: return []
    try:
        result = json.loads(value, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError): raise LegacyValidationError('Historical Trace array is invalid') from None
    if not isinstance(result, list): raise LegacyValidationError('Historical Trace array required')
    return result


class _MigrationSources(CollectorSources):
    def _scope(self, con, token, workspace):
        scope = self.iam._scope(con, token)
        self.iam._workspace(scope, workspace, 'write')
        return scope


class TraceHistory:
    def __init__(self, importer):
        self.importer = importer
        self.control = importer.control
        self.ingest = importer.ingest
        self.sources = _MigrationSources(self.control, self.ingest)

    def _matching(self, model, **fields):
        return [row for row in self.importer.rows if row['model'] == model and all(row['data'].get(key) == value for key, value in fields.items())]

    def _same_owner(self, row, other):
        if self.importer._owner(row) != self.importer._owner(other): raise LegacyValidationError('Historical Trace relation crosses owners')

    def _session(self, row, owner):
        if row is None: return None
        data = copy.deepcopy(row['data'])
        data['interactions'] = _array(data.get('interactions'))
        if data.get('langfuseTraceNodes') is not None: data['langfuseTraceNodes'] = _array(data['langfuseTraceNodes'])
        data['user'] = owner
        return data

    def _text(self, session):
        value = json.dumps(session, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        try:
            result = subprocess.run([self.importer.node_binary, '-e',
                "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))))"],
                input=value, text=True, capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired): raise LegacyValidationError('Node Session representation could not be generated') from None
        if result.returncode or not result.stdout: raise LegacyValidationError('Node Session representation could not be generated')
        return result.stdout

    def _source(self, con, workspace, task):
        alias = con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?", (workspace, task)).fetchone()
        if not alias: return None
        annotation, _, state = self.sources._state(con, workspace, alias[0])
        return alias[0], state

    def _proof(self, con, row, workspace, source):
        trace, state = source
        provenance = state.get('historical_import', {})
        if provenance.get('source_id_sha256') != _hash(self.importer.source_id) or provenance.get('entities', {}).get(row['entity_key']) != row['content_hash']:
            raise Conflict('Historical Trace identity belongs to another source or current data')
        return {'domain': 'trace', 'trace_id': trace, 'task_id': state['task_id'], 'source_revision': state['source_revision'],
                'snapshot_ref': state.get('snapshot_ref'), 'operation_key': provenance['operation_key']}

    def write(self, con, row, scope, workspace, owner):
        if row['model'] in {'Tag', 'ExecutionTag'}: return self._tag(con, row, scope, workspace, owner)
        if row['model'] in {'TraceThread', 'TraceThreadEvent'}: return self._thread(con, row, scope, workspace, owner)
        if row['model'] in {'ExecutionSkill', 'ExecutionSkillOrigin'}: return self._skill_relation(con, row, workspace)
        data = row['data']
        if row['model'] == 'Execution':
            execution = copy.deepcopy(data)
            task = data.get('taskId') or data['id']
            matching = self._matching('Session', taskId=data.get('taskId')) if data.get('taskId') else []
            if len(matching) > 1: raise LegacyValidationError('Historical Session identity is ambiguous')
            session_row = matching[0] if matching else None
            if session_row: self._same_owner(row, session_row)
        else:
            task = data['taskId']
            matching = self._matching('Execution', taskId=task)
            if matching:
                if len(matching) != 1: raise LegacyValidationError('Historical task belongs to multiple Executions')
                self._same_owner(row, matching[0])
                source = self._source(con, workspace, task)
                if not source: raise Conflict('Parent Execution has not been imported')
                return self._proof(con, row, workspace, source)
            execution = None
            session_row = row
        if self._source(con, workspace, task): raise Conflict('Historical task collides with existing Trace data')
        session = self._session(session_row, owner)
        text = self._text(session)
        session = json.loads(text)
        started = _ms(data['timestamp'] if execution else data['startTime'])
        operation = 'legacy:' + row['entity_key']
        actual_execution = data['id'] if execution else 'legacy-session-' + row['entity_key']
        reservation = self.sources._reserve(con, self.importer.actors[owner], workspace,
            {'operation': 'snapshot', 'operation_key': operation, 'task_id': task, 'execution_id': actual_execution,
             'legacy_username': owner, 'framework': data.get('framework'), 'started_at_ms': started,
             'operation_request': {'source_id_sha256': _hash(self.importer.source_id), 'entity_key': row['entity_key'], 'content_hash': row['content_hash']}})
        trace = reservation['trace_id']
        route, _, state = self.sources._owned(con, self.importer.actors[owner], workspace, trace)
        slot = source_hash(operation)
        op = state['operations'][slot]
        entities = {row['entity_key']: row['content_hash']}
        if session_row: entities[session_row['entity_key']] = session_row['content_hash']
        state['historical_import'] = {'source_id_sha256': _hash(self.importer.source_id), 'entities': entities, 'operation_key': operation}
        sources = []
        if execution is not None:
            for field in ('skills', 'invokedSkills', 'observedAgents'): execution[field] = _array(execution.get(field))
            original_task = execution.get('taskId')
            execution['taskId'] = task
            execution['user'] = owner
            snapshot = {'execution': execution, 'session': session}
            # Only fixed legacy columns are imported. This does not create internal run/lease authority.
            original_kind = execution.get('sourceKind')
            original_client = execution.get('clientId')
            execution['sourceKind'] = None
            snapshot, framework = self.sources._snapshot(state, op, snapshot)
            snapshot['execution']['sourceKind'] = original_kind
            snapshot['execution']['clientId'] = original_client
            snapshot['execution']['taskId'] = original_task
            execution = snapshot['execution']
            session = snapshot['session']
            state['framework'] = framework
            skills = []
            for item in self._matching('ExecutionSkill', executionId=data['id']):
                self._same_owner(row, item)
                value = copy.deepcopy(item['data'])
                origins = self._matching('ExecutionSkillOrigin', executionSkillId=item['data']['id'])
                if len(origins) > 1: raise LegacyValidationError('Historical Skill origin is ambiguous')
                if origins:
                    self._same_owner(row, origins[0]); value['origin'] = copy.deepcopy(origins[0]['data'])
                    entities[origins[0]['entity_key']] = origins[0]['content_hash']
                skills.append(value); entities[item['entity_key']] = item['content_hash']
            state['execution_skills'] = skills
            sources = self.sources._sources(workspace, route, snapshot, state)
            _, state['snapshot_ref'] = self.ingest._persist(snapshot)
            state['relations'] = {key: copy.deepcopy(execution.get(key)) for key in ('isSubagent', 'parentExecutionId', 'rootExecutionId')}
            if execution.get('traceThreadId'):
                parent = con.execute('SELECT owner_principal_id FROM collector_trace_threads WHERE workspace_id=? AND thread_id=?', (workspace, execution['traceThreadId'])).fetchone()
                if not parent or parent[0] != scope.principal_id: raise Conflict('Historical Thread has not been imported for this owner')
                con.execute('INSERT INTO collector_trace_thread_executions VALUES(?,?,?,?,?,?,?,?)',
                    (workspace, trace, execution['traceThreadId'], scope.principal_id, execution['id'], task, execution.get('sourceExecutionId'), started))
        _, state['session_ref'] = self.ingest._persist(session)
        state['source_revision'] += 1
        if source_hash(json.loads(text)) != source_hash(session): text = self._text(session)
        prep = CollectorPreparations(self.control, self.ingest)
        state['prepared_session'] = {'source_revision': state['source_revision'], 'snapshot_ref': state.get('snapshot_ref'),
            'session_hash': source_hash(json.loads(text)), 'text_ref': prep._persist_text(text), 'text_hash': hashlib.sha256(text.encode()).hexdigest()}
        op.update(stage='committed', source_revision=state['source_revision'], snapshot_ref=state.get('snapshot_ref'))
        op['batch_refs'] = self.sources._enqueue(con, workspace, trace, state, op, sources)
        if not op['batch_refs']: state['pending'] = None
        self.sources._write(con, workspace, trace, state)
        return self._proof(con, row, workspace, (trace, state))

    def verify(self, con, row, workspace, proof):
        if proof['domain'] == 'trace_tag':
            if row['model'] == 'Tag':
                target = con.execute('SELECT * FROM trace_tags WHERE workspace_id=? AND tag_id=?', (workspace, row['data']['id'])).fetchone()
            else:
                target = con.execute('SELECT * FROM trace_tag_links WHERE workspace_id=? AND trace_id=? AND tag_id=?', (workspace, proof['trace_id'], row['data']['tagId'])).fetchone()
            if not target or _hash(dict(target)) != proof['target_hash']: raise Conflict('Imported Trace tag changed')
            return True
        if proof['domain'] == 'thread':
            table = 'collector_trace_threads' if row['model'] == 'TraceThread' else 'collector_trace_thread_events'
            column = 'thread_id' if row['model'] == 'TraceThread' else 'event_id'
            target = con.execute('SELECT * FROM ' + table + ' WHERE workspace_id=? AND ' + column + '=?', (workspace, row['data']['id'])).fetchone()
            if not target or _hash(dict(target)) != proof['target_hash']: raise Conflict('Imported Thread history changed')
            return True
        route, _, state = self.sources._owned(con, self.importer.actors[self.importer._owner(row)], workspace, proof['trace_id'])
        current = self._proof(con, row, workspace, (proof['trace_id'], state))
        if current != {key: value for key, value in proof.items() if key not in {'source_ref', 'import_manifest_hash'}}: raise Conflict('Imported Trace source changed')
        op = state['operations'].get(source_hash(proof['operation_key']))
        return op is not None and self.sources._op_state(con, workspace, proof['trace_id'], op) == 'indexed'

    def _skill_relation(self, con, row, workspace):
        skill = row
        if row['model'] == 'ExecutionSkillOrigin':
            matches = self._matching('ExecutionSkill', id=row['data']['executionSkillId'])
            if len(matches) != 1: raise LegacyValidationError('Historical Skill relation is missing')
            skill = matches[0]
        matches = self._matching('Execution', id=skill['data']['executionId'])
        if len(matches) != 1: raise LegacyValidationError('Historical Skill Execution is missing')
        source = self._source(con, workspace, matches[0]['data'].get('taskId') or matches[0]['data']['id'])
        if not source: raise Conflict('Historical Skill Execution has not been imported')
        return self._proof(con, row, workspace, source)

    def _thread(self, con, row, scope, workspace, owner):
        data = row['data']; now = self.control.clock()
        if row['model'] == 'TraceThread':
            con.execute('INSERT INTO collector_trace_threads VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)',
                (workspace, data['id'], scope.principal_id, data['framework'], data['sourceThreadId'], owner,
                 data.get('sourceKind'), _ms(data['startedAt']) if data.get('startedAt') is not None else None,
                 _ms(data['updatedAt']) if data.get('updatedAt') is not None else None, data.get('metadataJson'), now, now))
            target = con.execute('SELECT * FROM collector_trace_threads WHERE workspace_id=? AND thread_id=?', (workspace, data['id'])).fetchone()
        else:
            def reference(key):
                if not data.get(key): return None
                target = con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?", (workspace, data[key])).fetchone()
                if not target: raise Conflict('Historical Thread event references a missing Execution')
                self.importer.iam._authorize(con, self.importer.actors[owner], workspace, 'read', 'trace', target[0])
                return target[0]
            con.execute('INSERT INTO collector_trace_thread_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
                (workspace, data['eventKey'], data['id'], data['traceThreadId'], reference('executionId'), reference('relatedExecutionId'),
                 data['kind'], data.get('status'), data.get('sourceTurnId'), data.get('phaseId'), _ms(data['startedAt']),
                 _ms(data['completedAt']) if data.get('completedAt') is not None else None, data.get('payloadJson'), now, now))
            target = con.execute('SELECT * FROM collector_trace_thread_events WHERE workspace_id=? AND event_id=?', (workspace, data['id'])).fetchone()
        return {'domain': 'thread', 'target_hash': _hash(dict(target))}

    def _tag(self, con, row, scope, workspace, owner):
        data = row['data']
        if row['model'] == 'Tag':
            con.execute('INSERT INTO trace_tags VALUES(?,?,?,?,?,?,?,1,?,?)',
                (workspace, data['id'], scope.principal_id, data['kind'], data['name'], data.get('description'),
                 data['color'].lower(), _ms(data['createdAt']), _ms(data['updatedAt'])))
            target = con.execute('SELECT * FROM trace_tags WHERE workspace_id=? AND tag_id=?', (workspace, data['id'])).fetchone()
            return {'domain': 'trace_tag', 'target_hash': _hash(dict(target))}
        tag = con.execute('SELECT owner_principal_id FROM trace_tags WHERE workspace_id=? AND tag_id=?', (workspace, data['tagId'])).fetchone()
        alias = con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?", (workspace, data['executionId'])).fetchone()
        if not alias or not tag or tag[0] != scope.principal_id: raise Conflict('Historical tag references a missing or foreign target')
        self.importer.iam._authorize(con, self.importer.actors[owner], workspace, 'write', 'trace', alias[0])
        con.execute('INSERT INTO trace_tag_links VALUES(?,?,?,?,?)', (workspace, alias[0], data['tagId'], scope.principal_id, _ms(data['createdAt'])))
        target = con.execute('SELECT * FROM trace_tag_links WHERE workspace_id=? AND trace_id=? AND tag_id=?', (workspace, alias[0], data['tagId'])).fetchone()
        return {'domain': 'trace_tag', 'trace_id': alias[0], 'target_hash': _hash(dict(target))}
