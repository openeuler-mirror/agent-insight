import datetime
import hashlib
import json
import math

from .control import Conflict
from .infra import InfraStore, EVENT as INFRA_EVENT, _json as infra_json
from .legacy import LegacyValidationError
from .legacy_history import INERT_SOURCE, control_history_key
from .legacy_import import _hash, _ms
from .trace_analytics import ras_task_deleted, _json as ras_json

TELEMETRY_MODELS = frozenset({'InfraSource', 'InfraMetricSample', 'SessionInfraLink', 'RasAnomalyEvent'})


class TelemetryHistory:
    def __init__(self, importer): self.importer = importer; self.control = importer.control; self.facts = importer.facts

    def write(self, con, row, scope, workspace, owner):
        if row['model'] == 'RasAnomalyEvent': return self._ras(con, row, scope, workspace)
        if row['model'] == 'InfraMetricSample': return self._sample(con, row, scope, workspace)
        if row['model'] == 'SessionInfraLink': return self._link(con, row, scope, workspace, owner)
        data = row['data']; store = InfraStore(self.control, self.facts)
        fields = store._fields(data)
        con.execute('INSERT INTO infra_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
            (workspace, data['id'], scope.principal_id, data['endpoint'], data['scrapeUrl'], data['kind'], fields.get('auth_ref'),
             data.get('model'), data.get('hardwareName'), data.get('memBandwidthGBs'), data['scrapeIntervalMs'],
             int(data['enabled']), 'active', _ms(data['createdAt']), _ms(data['updatedAt'])))
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (workspace, INERT_SOURCE,
            control_history_key('infraSource', data['id']), row['content_hash'], self.control.clock()))
        target = con.execute('SELECT * FROM infra_sources WHERE workspace_id=? AND source_id=?', (workspace, data['id'])).fetchone()
        return {'domain': 'telemetry', 'kind': 'infra_source', 'target_hash': _hash(dict(target))}

    def _sample(self, con, row, scope, workspace):
        data = row['data']
        source = con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND source_id=? AND state='active'", (workspace, data['sourceId'])).fetchone()
        if not source or source['owner_principal_id'] != scope.principal_id: raise Conflict('Historical Infra sample source is missing or belongs to another owner')
        if type(data['tsMs']) not in (int, float) or not math.isfinite(data['tsMs']): raise LegacyValidationError('Finite historical sample clock required')
        for field in ('gauges', 'counters', 'histograms', 'waitingByReason'):
            if data.get(field) is not None:
                try: parsed = json.loads(data[field], parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                except (TypeError, ValueError): raise LegacyValidationError('Historical Infra partition is invalid') from None
                if not isinstance(parsed, dict): raise LegacyValidationError('Historical Infra partition object required')
        text = infra_json({key: data.get(key) for key in ('tsMs', 'via', 'model', 'gauges', 'counters', 'histograms', 'waitingByReason')})
        digest = hashlib.sha256(infra_json([data['sourceId'], text]).encode()).hexdigest()
        fact = {'workspace_id': workspace, 'source_id': data['sourceId'], 'sample_id': data['id'], 'owner_principal_id': scope.principal_id,
            'content_hash': digest, 'ts_ms': data['tsMs'], 'received_at_ms': _ms(data['createdAt']), 'sample_json': text, 'retry_version': 1}
        ref = InfraStore(self.control, self.facts).artifacts._persist(fact)[1]
        event = 'infra:' + data['id']
        payload = infra_json({'source_id': data['sourceId'], 'artifact_ref': ref, 'content_hash': digest})
        con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)',
            (workspace, event, data['id'], INFRA_EVENT, payload, _ms(data['createdAt']), _ms(data['createdAt'])))
        return {'domain': 'telemetry', 'kind': 'infra_sample', 'event_id': event, 'content_hash': digest}

    def _link(self, con, row, scope, workspace, owner):
        data = row['data']; store = InfraStore(self.control, self.facts)
        trace, actual = store._trace(con, self.importer.actors[owner], workspace, data['rootExecutionId'], 'write')
        if actual != scope.principal_id: raise Conflict('Historical Infra link Trace owner differs')
        source = store._source(con, self.importer.actors[owner], workspace, data['sourceId'])
        if source['owner_principal_id'] != scope.principal_id: raise Conflict('Historical Infra link source owner differs')
        if con.execute('SELECT 1 FROM session_infra_links WHERE workspace_id=? AND root_trace_id=? AND source_id=? AND ((model IS NULL AND ? IS NULL) OR model=?) AND retired_at_ms IS NULL',
            (workspace, trace, data['sourceId'], data.get('model'), data.get('model'))).fetchone(): raise Conflict('Duplicate historical Infra association requires explicit resolution')
        order = con.execute('SELECT MAX(position) FROM session_infra_links WHERE workspace_id=? AND root_trace_id=?', (workspace, trace)).fetchone()[0]
        con.execute('INSERT INTO session_infra_links VALUES(?,?,?,?,?,?,?,NULL)',
            (workspace, trace, data['id'], data['sourceId'], data.get('model'), 0 if order is None else order+1, _ms(data['createdAt'])))
        target = con.execute('SELECT * FROM session_infra_links WHERE workspace_id=? AND root_trace_id=? AND link_id=?', (workspace, trace, data['id'])).fetchone()
        return {'domain': 'telemetry', 'kind': 'infra_link', 'trace_id': trace, 'target_hash': _hash(dict(target))}

    def _ras(self, con, row, scope, workspace):
        data = row['data']
        if ras_task_deleted(con, workspace, scope.principal_id, data['taskId']): raise Conflict('Historical RAS task has a deletion barrier')
        identity = (workspace, scope.principal_id, data['taskId'], data['deliveryId'])
        if con.execute('SELECT 1 FROM ras_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND task_id=? AND event_key=?', identity).fetchone():
            raise Conflict('RAS delivery identity already exists without this import receipt')
        event = {key: value for key, value in data.items() if key not in {'user', 'executionId'}}
        text = ras_json(event); digest = hashlib.sha256(text.encode()).hexdigest(); stamp = _ms(data['ts'])
        fact = {'workspace_id': workspace, 'event_bucket': datetime.datetime.fromtimestamp(stamp/1000, datetime.timezone.utc).date().isoformat(),
            'owner_principal_id': scope.principal_id, 'task_id': data['taskId'], 'event_key': data['deliveryId'],
            'event_id': data['id'], 'content_hash': digest, 'event_json': text, 'retry_version': 1}
        self.facts.write_ras_event(fact)
        con.execute('INSERT INTO ras_event_receipts VALUES(?,?,?,?,?,?,1,?,?)', (*identity, data['id'], digest, stamp, _ms(data['createdAt'])))
        return {'domain': 'telemetry', 'kind': 'ras', 'content_hash': digest}

    def verify(self, con, row, workspace, proof):
        data = row['data']; owner = self.importer.bindings[self.importer._owner(row)]['principal_id']
        if proof['kind'] == 'infra_source':
            target = con.execute('SELECT * FROM infra_sources WHERE workspace_id=? AND source_id=?', (workspace, data['id'])).fetchone()
            if not target or target['owner_principal_id'] != owner or _hash(dict(target)) != proof['target_hash']: raise Conflict('Imported Infra source changed')
            if target['auth_ref']: self.control._verify_artifact(target['auth_ref'].rsplit('/', 1)[-1], target['auth_ref'])
            return True
        if proof['kind'] == 'infra_link':
            target = con.execute('SELECT * FROM session_infra_links WHERE workspace_id=? AND root_trace_id=? AND link_id=?', (workspace, proof['trace_id'], data['id'])).fetchone()
            if not target or _hash(dict(target)) != proof['target_hash']: raise Conflict('Imported Infra association changed')
            return True
        if proof['kind'] == 'ras':
            receipt = con.execute('SELECT * FROM ras_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND task_id=? AND event_key=?',
                (workspace, owner, data['taskId'], data['deliveryId'])).fetchone()
            if not receipt or receipt['content_hash'] != proof['content_hash']: raise Conflict('Imported RAS receipt changed')
            values = self.facts.read_ras_events(workspace, [dict(receipt)])
            return any(value.get('event_id') == data['id'] and value.get('content_hash') == proof['content_hash']
                and hashlib.sha256(value['event_json'].encode()).hexdigest() == proof['content_hash'] for value in values)
        event = con.execute('SELECT state FROM outbox_events WHERE workspace_id=? AND event_id=?', (workspace, proof['event_id'])).fetchone()
        if not event or event[0] != 'sent': return False
        after = None
        for _ in range(20):
            values = self.facts.read_infra_samples(workspace, data['sourceId'], from_ms=data['tsMs'], to_ms=data['tsMs'], limit=5000, after=after)
            found = next((value for value in values if value['sample_id'] == data['id']), None)
            if found:
                if found['content_hash'] != proof['content_hash'] or hashlib.sha256(infra_json([data['sourceId'], found['sample_json']]).encode()).hexdigest() != proof['content_hash']:
                    raise Conflict('Imported Infra fact changed')
                return True
            if len(values) < 5000: return False
            after = {key: values[-1][key] for key in ('ts_ms', 'sample_id')}
        raise LegacyValidationError('Historical Infra verification exceeds sample scan budget')
