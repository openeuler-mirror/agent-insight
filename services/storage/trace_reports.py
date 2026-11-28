"""Authorized Trace report runs with immutable evidence and fenced publication."""
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import uuid

from .control import Conflict, StorageError
from .contracts import identifier, revision
from .iam import Forbidden
from .trace_evidence import TraceEvidence, EvidenceTooLarge, EvidenceUnavailable, _hash, _size
from .compatibility import TraceNotFound
from .legacy_history import INERT_SOURCE, control_history_key, is_historical_control, assert_control_live

MAX_REPORT_BYTES = 8 * 1024 * 1024
MAX_PROGRESS_BYTES = 1024 * 1024
LEASE_MS = 15 * 60 * 1000
KINDS = {'agent-debug', 'skills-analysis'}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _hash_id(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('a SHA-256 value is required')
    return value


def _iso(value):
    return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class TraceReports:
    unavailable = EvidenceUnavailable
    too_large = EvidenceTooLarge

    def __init__(self, queries, authorized):
        self.queries = queries; self.authorized = authorized; self.control = queries.control; self.iam = authorized.iam
        self.evidence = TraceEvidence(queries, authorized)
        with self.control.read_transaction() as con:
            if con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0] < 7:
                raise StorageError('diagnostic reports migration 007 is required')

    @staticmethod
    def _kind(kind):
        if kind not in KINDS: raise ValueError('unsupported Trace report kind')
        return kind

    def _trace(self, con, token, ws, ref, capability='read'):
        identifier(ws); identifier(ref)
        self.iam._workspace(self.iam._scope(con, token), ws, capability)
        values = {r[0] for r in con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?', (ws, ref))}
        if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?', (ws, ref)).fetchone(): values.add(ref)
        if not values: raise TraceNotFound('Trace not found')
        if len(values) != 1: raise Conflict('Trace reference is ambiguous')
        trace = next(iter(values)); scope = self.iam._authorize(con, token, ws, capability, 'trace', trace)
        route = con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?', (ws, trace)).fetchone()
        if route is None or route['state'] != 'active': raise Conflict('Trace route is not active')
        if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?", (ws, trace, route['incarnation'])).fetchone():
            raise Conflict('Trace deletion barrier exists')
        return scope, dict(route)

    def _boundary(self, con, token, ws, ref, value):
        scope, route = self._trace(con, token, ws, ref, 'execute'); manifest = value['manifest']
        self.iam._workspace(scope, ws, 'write')
        for key in ('trace_id', 'trace_bucket', 'source_namespace', 'native_trace_id', 'incarnation', 'route_epoch'):
            if str(route[key]) != str(manifest[key]): raise Conflict('Trace route changed before report reservation')
        owner = con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?", (ws, route['trace_id'])).fetchone()
        if owner is None or owner[0] != manifest['owner_principal_id']: raise Conflict('Trace ownership changed before report reservation')
        annotation = con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?', (ws, route['trace_id'])).fetchone()
        if (_hash(dict(annotation)) if annotation else None) != manifest['annotation_hash']:
            raise Conflict('Trace annotation changed before report reservation')
        heads = []; kind = ''; entity = ''
        while True:
            rows = con.execute('SELECT entity_kind,entity_id,revision,source_revision,content_hash FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND (entity_kind>? OR (entity_kind=? AND entity_id>?)) ORDER BY entity_kind,entity_id LIMIT 200', (ws, route['trace_id'], kind, kind, entity)).fetchall()
            if not rows: break
            for row in rows:
                heads.append({'kind': row['entity_kind'], 'id': row['entity_id'], 'revision': str(row['revision']), 'source_revision': str(row['source_revision']), 'content_hash': row['content_hash']})
                kind = row['entity_kind']; entity = row['entity_id']
                if len(heads) > len(manifest['heads']): raise Conflict('Trace heads changed before report reservation')
        if heads != manifest['heads']: raise Conflict('Trace heads changed before report reservation')
        for alias_kind, key in [('task', 'task_id'), ('execution', 'execution_id')]:
            row = con.execute('SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind=? ORDER BY created_at_ms,alias_id LIMIT 1', (ws, route['trace_id'], alias_kind)).fetchone()
            if (row[0] if row else route['trace_id']) != manifest['aliases'][key]: raise Conflict('Trace alias changed before report reservation')
        return scope, route

    def _persist(self, value, limit, operation=None):
        _size(value, limit)
        return self.control.persist_artifact({'encoding': 'diagnostic-report-json/v1', 'json': _json(value), **({'operation': operation} if operation else {})})

    def _load(self, ref, limit, expected=None, *, with_operation=False):
        target = Path(ref); directory = self.control.artifact_directory
        if target.parent != directory or directory.is_symlink() or not re.fullmatch('[0-9a-f]{64}', target.name): raise EvidenceUnavailable('Invalid report artifact')
        maximum = limit * 6 + 4096
        try:
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode): raise EvidenceUnavailable('Invalid report artifact')
                if info.st_size > maximum: raise EvidenceTooLarge('Report artifact exceeds budget')
                body = stream.read(maximum + 1)
            if len(body) > maximum: raise EvidenceTooLarge('Report artifact exceeds budget')
            digest = hashlib.sha256(body).hexdigest()
            if digest != target.name or (expected is not None and digest != expected): raise EvidenceUnavailable('Report artifact checksum differs')
            wrapper = json.loads(body.decode('utf-8'))
            if not isinstance(wrapper, dict) or wrapper.get('encoding') != 'diagnostic-report-json/v1' or not isinstance(wrapper.get('json'), str): raise EvidenceUnavailable('Invalid report artifact encoding')
            if len(wrapper['json'].encode('utf-8')) > limit: raise EvidenceTooLarge('Report artifact expands beyond budget')
            value = json.loads(wrapper['json'], parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            _size(value, limit)
            return (value, wrapper.get('operation')) if with_operation else value
        except (OSError, ValueError, TypeError, UnicodeError, RecursionError): raise EvidenceUnavailable('Report artifact is unavailable') from None

    @staticmethod
    def _row(con, ws, trace, kind):
        row = con.execute('SELECT r.* FROM diagnostic_report_heads h JOIN diagnostic_report_runs r ON r.workspace_id=h.workspace_id AND r.report_id=h.report_id WHERE h.workspace_id=? AND h.trace_id=? AND h.kind=?', (ws, trace, kind)).fetchone()
        return dict(row) if row else None

    def _view(self, row):
        if row is None: return {'row': None, 'payload': None, 'progress': None}
        payload = self._load(row['payload_ref'], MAX_REPORT_BYTES, row['payload_hash']) if row['payload_ref'] else None
        progress = self._load(row['progress_ref'], MAX_PROGRESS_BYTES, row['progress_hash']) if row['progress_ref'] else None
        status = row['status']; error = row['error_message']
        history = self._history(row)
        if history: status = history['original_status']
        elif status == 'running' and row['lease_until_ms'] <= self.control.clock(): status = 'failed'; error = '后台任务已中断，请重新诊断。'
        stats = payload.get('stats', {}) if isinstance(payload, dict) else {}
        public = {'id': row['report_id'], 'executionId': row['execution_id'], 'interactionsHash': row['interactions_hash'],
                  'status': status, 'errorMessage': error, 'generator': row['generator'], 'revision': row['revision'],
                  'ranAt': _iso(row['created_at_ms']), 'updatedAt': _iso(row['updated_at_ms']), 'evidenceHash': row['evidence_hash'],
                  'stepCount': stats.get('stepCount', 0), 'issueCount': stats.get('issueCount', 0), 'llmCallCount': stats.get('llmCallCount', 0), 'durationMs': stats.get('durationMs'),
                  'keyActionCount': len(payload.get('keyActionResults', [])) if isinstance(payload, dict) and isinstance(payload.get('keyActionResults', []), list) else 0}
        if history: public.update(history.get('stats', {}))
        return {'row': public, 'payload': payload, 'progress': progress}

    def _history(self, row):
        with self.control.read_transaction() as con:
            marker = con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
                (row['workspace_id'], INERT_SOURCE, control_history_key('diagnosticReport', row['report_id']))).fetchone()
        if not marker: return None
        value = self._load(row['evidence_ref'], 16*1024*1024).get('legacy_history')
        if not isinstance(value, dict) or value.get('version') != 1 or value.get('source_row_hash') != marker[0]: raise EvidenceUnavailable('Historical report provenance differs')
        return value

    def read(self, token, ws, ref, kind):
        self._kind(kind)
        with self.control.read_transaction() as con:
            scope, route = self._trace(con, token, ws, ref); row = self._row(con, ws, route['trace_id'], kind)
        try: result = self._view(row)
        finally: self._postflight(token, ws, ref, route['trace_id'], kind, row, scope.fingerprint)
        return result

    def _postflight(self, token, ws, ref, trace, kind, row, fingerprint, capability='read'):
        with self.control.read_transaction() as con:
            current, _ = self._trace(con, token, ws, ref, capability)
            if current.fingerprint != fingerprint: raise Forbidden('Report authorization changed while reading')
            if self._row(con, ws, trace, kind) != row: raise Conflict('Report changed while reading')

    def _recover_begin(self, token, ws, ref, kind, expected_hash, interactions_hash, generator, operation, lease_token):
        with self.control.read_transaction() as con:
            scope, route = self._trace(con, token, ws, ref, 'execute')
            self.iam._workspace(scope, ws, 'write')
            self.iam._authorize(con, token, ws, 'read', 'trace', route['trace_id'])
            found = con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND actor_principal_id=? AND kind=? AND request_key=?', (ws,scope.principal_id,kind,operation['key'])).fetchone()
            if found is None: return None
            row = dict(found)
            assert_control_live(con, ws, 'diagnosticReport', row['report_id'])
            if row['trace_id'] != route['trace_id'] or row['evidence_hash'] != expected_hash or row['interactions_hash'] != interactions_hash or row['generator'] != generator: raise Conflict('Report request key already has different input')
            current = self._row(con, ws, route['trace_id'], kind)
            if current is None or current['report_id'] != row['report_id']: raise Conflict('Report request key no longer selects the current run')
        try:
            _, saved_operation = self._load(row['evidence_ref'], 16 * 1024 * 1024, with_operation=True)
            if saved_operation != operation: raise Conflict('Report request key already has different input')
            result = self._view(row)
        finally: self._postflight(token, ws, ref, row['trace_id'], kind, row, scope.fingerprint, 'execute')
        cached = row['status'] in ('done', 'skipped')
        busy = row['status'] == 'running' and row['lease_until_ms'] > self.control.clock()
        owned = busy and lease_token is not None and row['scope_fingerprint'] == scope.fingerprint and hmac.compare_digest(_digest(lease_token), row['lease_secret_hash'])
        result.update(cached=cached, busy=busy and not owned)
        if owned: result['leaseToken'] = lease_token
        return result

    def begin(self, token, ws, ref, kind, *, expected_snapshot_hash, interactions_hash, generator, force=False, request_key=None, payload=None, lease_token=None):
        self._kind(kind); _hash_id(expected_snapshot_hash); _hash_id(interactions_hash)
        if not isinstance(generator, str) or not 1 <= len(generator) <= 300: raise ValueError('bounded generator required')
        if type(force) is not bool: raise ValueError('force must be boolean')
        if request_key is not None: identifier(request_key)
        if lease_token is not None and (not isinstance(lease_token, str) or not re.fullmatch('[A-Za-z0-9_-]{43}', lease_token)): raise ValueError('Invalid private report lease')
        operation = {'key': request_key, 'body_hash': _hash({'snapshot': expected_snapshot_hash, 'interactions': interactions_hash, 'generator': generator, 'force': force, 'payload': payload})}
        if request_key is not None:
            recovered = self._recover_begin(token, ws, ref, kind, expected_snapshot_hash, interactions_hash, generator, operation, lease_token)
            if recovered is not None: return recovered
        value = self.evidence.read(token, ws, trace_ref=ref)
        if value['snapshot_hash'] != expected_snapshot_hash: raise Conflict('Trace evidence changed; refresh before diagnosis')
        with self.control.read_transaction() as con:
            prepared_scope, _ = self._boundary(con, token, ws, ref, value)
        _, evidence_ref = self._persist(value, 16 * 1024 * 1024, operation)
        candidate_id = str(uuid.uuid4())
        if kind == 'skills-analysis' and isinstance(payload, dict): payload = {**payload, 'runId': candidate_id}
        payload_hash, payload_ref = self._persist(payload, MAX_REPORT_BYTES) if payload is not None else (None, None)
        lease = lease_token or secrets.token_urlsafe(32); now = self.control.clock()
        trace = value['manifest']['trace_id']
        receipts = [('report-request', ws, prepared_scope.principal_id, kind, request_key)] if request_key else []
        with self.control.transaction(('diagnosis', ws, trace, kind), *receipts, shared=(('trace', ws, trace),)) as con:
            now = self.control.clock()
            scope, route = self._boundary(con, token, ws, ref, value); trace = route['trace_id']; current = self._row(con, ws, trace, kind)
            historical = current is not None and is_historical_control(con, ws, 'diagnosticReport', current['report_id'])
            if scope.fingerprint != prepared_scope.fingerprint: raise Forbidden('Report authorization changed while reserving')
            old = con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND actor_principal_id=? AND kind=? AND request_key=?', (ws, scope.principal_id, kind, request_key)).fetchone() if request_key is not None else None
            if old:
                old = dict(old)
                assert_control_live(con, ws, 'diagnosticReport', old['report_id'])
                if old['trace_id'] != trace or old['evidence_hash'] != expected_snapshot_hash or old['interactions_hash'] != interactions_hash or old['generator'] != generator: raise Conflict('Report request key already has different input')
                if current is None or current['report_id'] != old['report_id']: raise Conflict('Report request key no longer selects the current run')
                selected = old; cached = old['status'] in ('done', 'skipped'); busy = old['status'] == 'running' and old['lease_until_ms'] > now
                if busy and lease_token is not None and old['scope_fingerprint'] == scope.fingerprint and hmac.compare_digest(_digest(lease_token), old['lease_secret_hash']): busy = False
            elif current and not historical and current['evidence_hash'] == expected_snapshot_hash and current['interactions_hash'] == interactions_hash and current['generator'] == generator and (current['status'] == 'running' and current['lease_until_ms'] > now or not force and current['status'] in ('done', 'skipped')):
                selected = current; cached = current['status'] in ('done', 'skipped'); busy = not cached
            else:
                rid = candidate_id
                con.execute('INSERT INTO diagnostic_report_runs(workspace_id,report_id,trace_id,kind,actor_principal_id,request_key,execution_id,interactions_hash,generator,scope_fingerprint,evidence_hash,evidence_ref,lease_secret_hash,status,payload_hash,payload_ref,lease_until_ms,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (ws,rid,trace,kind,scope.principal_id,request_key,value['execution']['id'],interactions_hash,generator,scope.fingerprint,expected_snapshot_hash,evidence_ref,_digest(lease),'running',payload_hash,payload_ref,now+LEASE_MS,1,now,now))
                if current: con.execute('UPDATE diagnostic_report_heads SET report_id=? WHERE workspace_id=? AND trace_id=? AND kind=?', (rid,ws,trace,kind))
                else: con.execute('INSERT INTO diagnostic_report_heads VALUES(?,?,?,?)', (ws,trace,kind,rid))
                selected = dict(con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND report_id=?', (ws,rid)).fetchone()); cached = False; busy = False
        if old:
            return self._recover_begin(token, ws, ref, kind, expected_snapshot_hash, interactions_hash, generator, operation, lease_token)
        try: result = self._view(selected)
        finally: self._postflight(token, ws, ref, trace, kind, selected, scope.fingerprint, 'execute')
        result.update(cached=cached,busy=busy)
        if not cached and not busy and selected['lease_secret_hash'] == _digest(lease): result['leaseToken'] = lease
        return result

    def _publication(self, con, token, ws, report_id, expected_revision, lease_token, *, replay=False):
        found = con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND report_id=?', (ws,report_id)).fetchone()
        if found is None: raise TraceNotFound('Report run not found')
        row = dict(found); scope, _ = self._trace(con, token, ws, row['trace_id'], 'execute')
        assert_control_live(con, ws, 'diagnosticReport', report_id)
        if scope.principal_id != row['actor_principal_id'] or scope.fingerprint != row['scope_fingerprint']: raise Forbidden('Report run authorization changed')
        if not isinstance(lease_token, str) or not hmac.compare_digest(_digest(lease_token), row['lease_secret_hash']): raise Forbidden('Report publication lease required')
        head = self._row(con, ws, row['trace_id'], row['kind'])
        if head is None or head['report_id'] != report_id: raise Conflict('Report publication was fenced')
        if replay and row['revision'] == expected_revision + 1: return row
        if row['revision'] != expected_revision or row['status'] != 'running' or row['lease_until_ms'] <= self.control.clock(): raise Conflict('Report publication was fenced')
        return row

    def update(self, token, ws, report_id, expected_revision, lease_token, *, payload=None, progress=None, status=None, error_message=None, request_key=None):
        identifier(ws); identifier(report_id); revision(expected_revision)
        if status is not None and status not in {'done', 'failed', 'skipped'}: raise ValueError('terminal report status required')
        if status in ('done', 'skipped') and not isinstance(payload, dict): raise ValueError('complete report payload required')
        if error_message is not None and (not isinstance(error_message, str) or len(error_message) > 2000): raise ValueError('bounded error required')
        if payload is None and progress is None and status is None: raise ValueError('report update required')
        if request_key is not None: identifier(request_key)
        if payload is not None: _size(payload, MAX_REPORT_BYTES)
        if progress is not None: _size(progress, MAX_PROGRESS_BYTES)
        operation = {'key': request_key, 'base_revision': str(expected_revision), 'body_hash': _hash({'payload': payload, 'progress': progress, 'status': status, 'error_message': error_message})} if request_key is not None else None
        with self.control.read_transaction() as con:
            previous = self._publication(con, token, ws, report_id, expected_revision, lease_token, replay=operation is not None)
        if previous['revision'] != expected_revision:
            return self._operation_view(token, ws, previous, operation)
        payload_values = self._persist(payload, MAX_REPORT_BYTES) if payload is not None else None
        if operation is not None:
            progress_value = progress if progress is not None else self._load(previous['progress_ref'], MAX_PROGRESS_BYTES, previous['progress_hash']) if previous['progress_ref'] else None
            progress_values = self._persist(progress_value, MAX_PROGRESS_BYTES, operation)
        else: progress_values = self._persist(progress, MAX_PROGRESS_BYTES) if progress is not None else None
        now = self.control.clock()
        trace = previous['trace_id']
        with self.control.transaction(('diagnosis', ws, trace, previous['kind']), shared=(('trace', ws, trace),)) as con:
            now = self.control.clock()
            row = self._publication(con, token, ws, report_id, expected_revision, lease_token, replay=operation is not None)
            if row['revision'] != expected_revision:
                selected = row
            else:
                now = max(now, row['updated_at_ms'])
                sets = ['revision=revision+1','updated_at_ms=?','lease_until_ms=?']; args = [now,None if status else now+LEASE_MS]
                if payload_values: sets.extend(['payload_hash=?','payload_ref=?']); args.extend(payload_values)
                if progress_values: sets.extend(['progress_hash=?','progress_ref=?']); args.extend(progress_values)
                if status: sets.extend(['status=?','error_message=?']); args.extend([status,error_message.replace(token,'[redacted]') if error_message else None])
                args.extend([ws,report_id,expected_revision])
                con.execute('UPDATE diagnostic_report_runs SET '+','.join(sets)+' WHERE workspace_id=? AND report_id=? AND revision=?', args)
                selected = dict(con.execute('SELECT * FROM diagnostic_report_runs WHERE workspace_id=? AND report_id=?', (ws,report_id)).fetchone())
        if operation is not None: return self._operation_view(token, ws, selected, operation)
        try: result = self._view(selected)
        finally: self._postflight(token, ws, selected['trace_id'], selected['trace_id'], selected['kind'], selected, selected['scope_fingerprint'], 'execute')
        return result

    def _operation_view(self, token, ws, row, operation):
        try:
            if not row['progress_ref']: raise Conflict('Report operation receipt is unavailable')
            _, saved_operation = self._load(row['progress_ref'], MAX_PROGRESS_BYTES, row['progress_hash'], with_operation=True)
            if saved_operation != operation: raise Conflict('Report operation replay has different content')
            result = self._view(row)
        finally: self._postflight(token, ws, row['trace_id'], row['trace_id'], row['kind'], row, row['scope_fingerprint'], 'execute')
        return result

    def delete(self, token, ws, ref):
        with self.control.read_transaction() as con:
            _, before = self._trace(con, token, ws, ref, 'delete')
        with self.control.transaction(('diagnosis', ws, before['trace_id']), shared=(('trace', ws, before['trace_id']),)) as con:
            scope, route = self._trace(con, token, ws, ref, 'delete')
            if route['trace_id'] != before['trace_id']: raise Conflict('Report Trace identity changed')
            grant = self.iam._workspace(scope, ws, 'delete')
            owner = con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?", (ws,route['trace_id'])).fetchone()[0]
            if owner != scope.principal_id and grant.role not in ('owner','admin','personal'): raise Forbidden('Trace owner required')
            con.execute('DELETE FROM diagnostic_report_heads WHERE workspace_id=? AND trace_id=?', (ws,route['trace_id']))
        return {'ok': True}

    def authorize_recording(self, token, ws, report_id, lease_token):
        identifier(ws); identifier(report_id)
        with self.control.read_transaction() as con:
            found = con.execute('SELECT revision FROM diagnostic_report_runs WHERE workspace_id=? AND report_id=?', (ws,report_id)).fetchone()
            if found is None: raise TraceNotFound('Report run not found')
            row = self._publication(con, token, ws, report_id, found[0], lease_token)
            return {'report_run_id': report_id, 'parent_trace_id': row['trace_id']}
