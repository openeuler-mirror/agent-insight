"""Fixed historical generation records, with no worker or lease authority."""
import datetime
import base64
import hashlib
import json
import re
import uuid

from .control import Conflict
from .legacy import LegacyValidationError
from .legacy_history import INERT_SOURCE, control_history_key
from .platform_controls import PlatformControls

FORMAT = 'legacy-generation-history/v1'
GENERATION_MODELS = frozenset({'TraceDatasetGenerationJob', 'TraceDatasetOperationReceipt'})


def _hash(value): return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()).hexdigest()


def _error(code, status, message):
    error = Conflict(message); error.code = code; error.status = status
    return error


def _stamp(value):
    if value is None: return 0
    if type(value) is int: return value
    return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()*1000)


class GenerationHistoryStore:
    def __init__(self, control): self.control = control; self.controls = PlatformControls(control)

    @staticmethod
    def _key(category, key): return _hash([FORMAT, category, key])

    def find(self, con, workspace, owner, category, key):
        row = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND owner_principal_id=? AND kind='_receipt' AND unique_key=? AND state='active'",
            (workspace, owner, self._key(category, key))).fetchone()
        if not row: return None
        value = self.controls._data(dict(row))
        if value.get('format') != FORMAT: raise Conflict('Historical generation lookup has another authority')
        return value

    def clock(self, con, workspace):
        rows = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind='_receipt' AND unique_key=? AND state='active'",
            (workspace, self._key('clock', 'clock-high-water'))).fetchall()
        high = self.control.clock()
        for row in rows:
            value = self.controls._data(dict(row))
            if value.get('format') != FORMAT: raise Conflict('Historical generation clock has another authority')
            high = max(high, value['data'].get('clockHighWaterMs') or 0)
        return high

    @staticmethod
    def request_hash(raw, now):
        from .trace_outcome import JS_TRIM_WHITESPACE
        if not isinstance(raw, dict): raise ValueError('Generation config must be object')
        name = raw.get('name'); description = raw.get('description', ''); limit = raw.get('limit'); request = raw.get('requestId')
        name = name.strip(JS_TRIM_WHITESPACE) if isinstance(name, str) else ''
        length = lambda value: len(value.encode('utf-16-le'))//2
        if not name or length(name) > 50 or not isinstance(description, str) or length(description) > 200 or type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError('Invalid generation config')
        if not isinstance(raw.get('platform'), str) or not isinstance(raw.get('agentKey'), str) or not raw['agentKey'] or not isinstance(request, str) or not re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', request, re.I):
            raise ValueError('Invalid generation identity')
        from .dataset_generation import _time
        start = _time(raw.get('from')); end = _time(raw.get('to'))
        if end-start not in (86400000, 7*86400000, 30*86400000) or end > now+300000: raise ValueError('Invalid generation window')
        request_body = {'name': name, 'description': description, 'platform': raw['platform'], 'agentKey': raw['agentKey'],
                        'from': raw['from'], 'to': raw['to'], 'limit': limit}
        return hashlib.sha256(json.dumps(request_body, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()).hexdigest()

    def replay_create(self, con, workspace, owner, raw):
        request = raw.get('requestId') if isinstance(raw, dict) else None
        if not isinstance(request, str): return None
        request = request.lower()
        job = self.find(con, workspace, owner, 'job-request', request)
        receipt = self.find(con, workspace, owner, 'receipt-create', request)
        if not job and not receipt: return None
        now = self.clock(con, workspace)
        data = (job or receipt)['data']
        if data.get('requestHash') != self.request_hash(raw, now): raise _error('IDEMPOTENCY_CONFLICT', 409, 'Historical request has different configuration')
        if job:
            if data['status'] == 'deleting': raise _error('REQUEST_EXPIRED', 410, 'Historical request is deleting')
            return {'datasetId': data['datasetId'], 'jobId': data['id'], 'historical_inert': True}
        if data['outcome'] == 'succeeded' and data.get('expiresAt') and _stamp(data['expiresAt']) > now and data.get('datasetId') and data.get('jobId'):
            dataset = con.execute('SELECT h.generation_status,a.owner_principal_id FROM dataset_compat_heads h JOIN iam_resource_access a ON a.workspace_id=h.workspace_id AND a.resource_kind=\'asset\' AND a.resource_id=h.asset_id WHERE h.workspace_id=? AND h.dataset_id=? AND h.state=\'active\'',
                (workspace, data['datasetId'])).fetchone()
            if dataset and dataset['owner_principal_id'] == owner and dataset['generation_status'] == 'published':
                return {'datasetId': data['datasetId'], 'jobId': data['jobId'], 'historical_inert': True}
        raise _error('REQUEST_EXPIRED', 410, 'Historical request has ended')

    def progress(self, con, workspace, owner, dataset):
        job = self.find(con, workspace, owner, 'job-dataset', dataset)
        head = con.execute('SELECT h.*,a.owner_principal_id FROM dataset_compat_heads h JOIN iam_resource_access a ON a.workspace_id=h.workspace_id AND a.resource_kind=\'asset\' AND a.resource_id=h.asset_id WHERE h.workspace_id=? AND h.dataset_id=?', (workspace, dataset)).fetchone()
        if not head or head['owner_principal_id'] != owner or head['state'] != 'active': raise LookupError('Dataset not found')
        if job:
            data = job['data']
            if data['status'] == 'deleting':
                error = _error('DATASET_DELETING', 409, 'Historical dataset is deleting'); error.details = {'deletionId': data.get('deletionId')}; raise error
            status = 'published' if data['status'] == 'succeeded' else 'failed' if data['status'] == 'failed' else 'generating'
            config = json.loads(data['configJson'])
            return {'datasetId': dataset, 'jobId': data['id'], 'status': status, 'stage': data['stage'], 'stageIndex': data['stageIndex'],
                'totalStages': 6, 'generatedCount': data['generatedCount'], 'summary': None,
                'error': {'code': data.get('errorCode'), 'message': data.get('errorMessage')} if status == 'failed' else None,
                'generationConfig': {key: config.get(key) for key in ('name', 'description', 'platform', 'agentKey', 'from', 'to', 'limit', 'requestId')} if status == 'failed' else None,
                'canCancel': status != 'published', 'canFinish': status == 'published', 'canReturn': status == 'failed', 'historical_inert': True}
        receipt = self.find(con, workspace, owner, 'receipt-create-dataset', dataset)
        if head['generation_source'] == 'trace' and head['generation_status'] == 'published':
            from .datasets import DatasetStore
            root = DatasetStore(self.control)._load(head['manifest_hash'], head['manifest_ref'])
            data = receipt['data'] if receipt else {}
            job_id = data.get('jobId') if data.get('expiresAt') and _stamp(data['expiresAt']) > self.clock(con, workspace) else None
            return {'datasetId': dataset, 'jobId': job_id, 'status': 'published', 'stage': 'complete', 'stageIndex': 6,
                'totalStages': 6, 'generatedCount': len(root['members']), 'summary': None, 'error': None, 'generationConfig': None,
                'canCancel': False, 'canFinish': True, 'canReturn': False, 'historical_inert': True}
        return None

    def deletion_id(self, workspace, owner, dataset): return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([FORMAT, workspace, owner, dataset, 'delete'], separators=(',', ':'))))

    def has_dataset(self, con, workspace, owner, dataset):
        return self.find(con, workspace, owner, 'job-dataset', dataset) or self.find(con, workspace, owner, 'receipt-create-dataset', dataset) or self.find(con, workspace, owner, 'receipt-delete-dataset', dataset)

    def deletion(self, con, workspace, owner, deletion):
        job = self.find(con, workspace, owner, 'deletion-job', deletion)
        if job:
            head = con.execute('SELECT state FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (workspace, job['data']['datasetId'])).fetchone()
            return {'deletionId': deletion, 'status': 'deleted' if head and head[0] == 'deleted' else 'deleting', 'error': None}
        saved = self.find(con, workspace, owner, 'deletion-receipt', deletion)
        if saved and saved['data'].get('outcome') == 'deleted':
            head = con.execute('SELECT state FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (workspace, saved['data'].get('datasetId'))).fetchone()
            if head and head[0] != 'deleted': raise Conflict('Historical deletion was superseded by current data')
            return {'deletionId': deletion, 'status': 'deleted', 'error': None}
        rows = con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND owner_principal_id=? AND kind='_receipt' AND state='active'", (workspace, owner)).fetchall()
        if len(rows) > 20000: raise Conflict('Historical generation deletion lookup exceeds budget')
        for row in rows:
            metadata = json.loads(row['metadata_json'])
            if metadata.get('history_domain') != FORMAT or metadata.get('category') not in {'job-dataset', 'receipt-create-dataset', 'receipt-delete-dataset'}: continue
            data = self.controls._data(dict(row))['data']; dataset = data.get('datasetId')
            if dataset and self.deletion_id(workspace, owner, dataset) == deletion:
                head = con.execute('SELECT state FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (workspace, dataset)).fetchone()
                if head and head['state'] == 'deleted': return {'deletionId': deletion, 'status': 'deleted', 'error': None}
        return None


class GenerationHistory:
    def __init__(self, importer): self.importer = importer; self.control = importer.control; self.store = GenerationHistoryStore(importer.control)

    def issues(self, row):
        from .legacy_history import HISTORY_FENCE_VERSION
        result = []
        if HISTORY_FENCE_VERSION < 1: result.append('inert_history_guard_required')
        if row['model'] == 'TraceDatasetGenerationJob':
            if row['data']['status'] not in {'queued', 'running', 'succeeded', 'failed', 'deleting'}: result.append('generation_status_unsupported')
            if row['data'].get('captureManifestHash'):
                package = self.importer.files.get(row['entity_key'])
                if not isinstance(package, list) or not package: result.append('generation_capture_package_required')
                else:
                    try:
                        self.store.controls._validate_files(package)
                        if not any(hashlib.sha256(base64.b64decode(item['content'], validate=True)).hexdigest() == row['data']['captureManifestHash'] for item in package):
                            result.append('generation_capture_manifest_hash_unverified')
                    except (TypeError, ValueError): result.append('generation_capture_package_invalid')
        return result

    def write(self, con, row, scope, workspace, owner):
        from .legacy_import import _ms
        data = row['data']; controls = self.store.controls
        if row['model'] == 'TraceDatasetGenerationJob':
            head = con.execute('SELECT h.dataset_id,a.owner_principal_id FROM dataset_compat_heads h JOIN iam_resource_access a ON a.workspace_id=h.workspace_id AND a.resource_kind=\'asset\' AND a.resource_id=h.asset_id WHERE h.workspace_id=? AND h.dataset_id=?', (workspace, data['datasetId'])).fetchone()
            if not head or head['owner_principal_id'] != scope.principal_id: raise Conflict('Historical generation Dataset owner differs')
            if con.execute('SELECT 1 FROM dataset_generation_jobs WHERE workspace_id=? AND (job_id=? OR dataset_id=? OR (actor_principal_id=? AND request_id=?))',
                (workspace, data['id'], data['datasetId'], scope.principal_id, data['requestId'])).fetchone(): raise Conflict('Historical generation collides with a live job')
            aliases = [('job', data['id']), ('job-request', data['requestId'].lower()), ('job-dataset', data['datasetId'])]
            if data.get('deletionId'): aliases.append(('deletion-job', data['deletionId']))
            created = _ms(data['createdAt']); updated = _ms(data['updatedAt'])
        else:
            aliases = [('receipt', data['id'])]
            if data['kind'] == 'clock': aliases.append(('clock', 'clock-high-water'))
            elif data['kind'] in {'create', 'delete'}:
                aliases.append(('receipt-' + data['kind'], data['operationKey'].lower() if data['kind'] == 'create' else data['operationKey']))
                if data.get('datasetId'): aliases.append(('receipt-' + data['kind'] + '-dataset', data['datasetId']))
                if data.get('deletionId'): aliases.append(('deletion-receipt', data['deletionId']))
            else: raise LegacyValidationError('Historical generation receipt kind is unsupported')
            created = updated = 0
        packed = {'format': FORMAT, 'source_entity': row['entity_key'], 'source_hash': row['content_hash'],
                  'record_type': 'job' if row['model'] == 'TraceDatasetGenerationJob' else 'receipt', 'data': data}
        if row['entity_key'] in self.importer.files:
            capture_hash, capture_ref = self.control.persist_artifact({'format': 'legacy-generation-capture/v1', 'files': self.importer.files[row['entity_key']]})
            packed['capture_package'] = {'hash': capture_hash, 'ref': capture_ref}
        digest, ref = controls._persist(packed); proofs = []
        for category, key in aliases:
            record = 'legacy-generation:' + _hash([row['entity_key'], category, key])
            metadata = json.dumps({'history_domain': FORMAT, 'category': category, 'key_hash': _hash(key)}, separators=(',', ':'))
            con.execute('INSERT INTO platform_control_records(workspace_id,kind,record_id,owner_principal_id,legacy_username,unique_key,status,sort_ms,metadata_json,payload_hash,payload_ref,state,revision,created_at_ms,updated_at_ms) VALUES(?,\'_receipt\',?,?,?,?,?,?,?,?,?,\'active\',1,?,?)',
                (workspace, record, scope.principal_id, owner, self.store._key(category, key), data.get('status') or data.get('outcome'), created, metadata, digest, ref, created, updated))
            target = con.execute('SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=\'_receipt\' AND record_id=?', (workspace, record)).fetchone()
            proofs.append({'record_id': record, 'target_hash': _hash(dict(target))})
        if row['model'] == 'TraceDatasetGenerationJob':
            con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)', (workspace, INERT_SOURCE, control_history_key('datasetGenerationJob', data['id']), row['content_hash'], self.control.clock()))
        return {'domain': 'generation_history', 'records': proofs}

    def verify(self, con, row, workspace, proof):
        owner = self.importer.bindings[self.importer._owner(row)]['principal_id']
        for expected in proof['records']:
            target = con.execute('SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=\'_receipt\' AND record_id=?', (workspace, expected['record_id'])).fetchone()
            if not target or target['owner_principal_id'] != owner or _hash(dict(target)) != expected['target_hash']: raise Conflict('Imported generation history changed')
            value = self.store.controls._data(dict(target))
            if value.get('capture_package'): self.control._verify_artifact(value['capture_package']['hash'], value['capture_package']['ref'])
        return True
