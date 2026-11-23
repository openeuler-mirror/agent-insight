import copy
import json
import uuid

from .control import Conflict
from .contracts import canonical_json
from .datasets import DatasetStore, _json as dataset_json
from .evaluator_assets import EvaluatorAssets, _runtime, _id as evaluator_id
from .legacy import LegacyValidationError
from .legacy_import import _hash, _ms
from .legacy_import_traces import _array

ASSET_MODELS = frozenset({'CustomEvaluatorList', 'AgentEvalDataset'})


class AssetHistory:
    def __init__(self, importer): self.importer = importer; self.control = importer.control

    def write(self, con, row, scope, workspace, owner):
        if row['model'] == 'CustomEvaluatorList': return self._evaluators(con, row, scope, workspace, owner)
        return self._dataset(con, row, scope, workspace, owner)

    def _evaluators(self, con, row, scope, workspace, owner):
        store = EvaluatorAssets(self.control)
        cards = _array(row['data']['itemsJson'])
        if any(not isinstance(card, dict) or not isinstance(card.get('id'), str) or not card['id'] for card in cards):
            raise LegacyValidationError('Historical evaluator identities must be explicit')
        if len({card['id'] for card in cards}) != len(cards): raise LegacyValidationError('Historical evaluator identities are duplicated')
        timestamp = _ms(row['data']['updatedAt'])
        asset = evaluator_id('evaluator-list', workspace, scope.principal_id)
        if store._alias(con, workspace, asset): raise Conflict('Evaluator list already exists without this import receipt')
        members = []
        for card in cards:
            family = store._family(workspace, scope.principal_id, card['id'])
            if store._alias(con, workspace, family): raise Conflict('Evaluator identity already exists without this import receipt')
            artifact = store._persist({'format': 'agent-insight.evaluator-definition', 'version': 1,
                'evaluator_id': card['id'], 'card': {**_runtime(card), 'source': 'custom'}})
            release, _ = store._publish(con, scope, self.importer.actors[owner], workspace, family, None, artifact, timestamp)
            members.append({'evaluator_id': card['id'], 'asset_id': family, 'release_id': release,
                'content_hash': artifact[0], 'origin': 'user'})
        artifact = store._persist({'format': 'agent-insight.evaluator-list', 'version': 1, 'evaluators': cards, 'releases': members})
        release, _ = store._publish(con, scope, self.importer.actors[owner], workspace, asset, None, artifact, timestamp)
        return {'domain': 'asset_history', 'kind': 'evaluators', 'asset_id': asset, 'release_id': release, 'content_hash': artifact[0]}

    def _dataset(self, con, row, scope, workspace, owner):
        store = DatasetStore(self.control)
        source = row['data']
        record = {key: copy.deepcopy(value) for key, value in source.items() if key not in {
            'user', 'createdAt', 'updatedAt', 'tagsJson', 'fieldsJson', 'casesJson', 'referenceCasesJson', 'caseCount', 'projectionReady'}}
        for field in ('tags', 'fields', 'cases'): record[field] = _array(source[field + 'Json'])
        for case in record['cases']:
            reference = case.get('traceSource')
            if reference is None: continue
            aliases = {target[0] for key in ('taskId', 'executionId') if reference.get(key) for target in con.execute(
                'SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?', (workspace, reference[key]))}
            if len(aliases) != 1: raise LegacyValidationError('Historical Dataset Trace source must resolve uniquely after Trace import')
            trace = next(iter(aliases))
            resource = con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?", (workspace, trace)).fetchone()
            if not resource or resource[0] != scope.principal_id: raise LegacyValidationError('Historical Dataset Trace source belongs to another owner')
        prepared = store._prepare_record(record)
        identity = source['id']; created = _ms(source['createdAt']); updated = _ms(source['updatedAt'])
        if updated < created: raise LegacyValidationError('Historical Dataset update precedes creation')
        if con.execute('SELECT 1 FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (workspace, identity)).fetchone():
            raise Conflict('Dataset identity already exists without this import receipt')
        asset = str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json(['dataset', workspace, identity])))
        draft = str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json(['dataset-draft', workspace, identity])))
        release = str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json(['dataset-release', workspace, asset, 1, prepared['root']['hash']])))
        readonly = record['datasetKind'] == 'benchmark' or record['name'] == '可靠性故障注入评测集（内置）' or (
            record['datasetKind'] == 'reliability' and any('内置' in tag for tag in record['tags']))
        con.execute("INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES(?,?,'dataset',?,?,?)",
            (workspace, asset, 'dataset:' + asset, created, updated))
        self.importer.iam._record_resource(con, workspace, 'asset', asset, scope.principal_id, 'private', invalidate_policy=False)
        small = {'format': 'dataset-manifest-ref/v1', 'hash': prepared['root']['hash'], 'ref': prepared['root']['ref'], 'case_count': len(record['cases'])}
        con.execute("INSERT INTO asset_drafts(workspace_id,draft_id,asset_id,branch_name,manifest_json,edit_revision,created_at_ms,updated_at_ms) VALUES(?,?,?,'main',?,1,?,?)",
            (workspace, draft, asset, canonical_json(small), created, updated))
        con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',
            (workspace, release, asset, '1', prepared['root']['hash'], prepared['root']['ref'], scope.principal_id, updated))
        con.execute('INSERT INTO asset_release_seals VALUES(?,?,?,0,?)', (workspace, release, asset, updated))
        con.execute("INSERT INTO asset_aliases VALUES(?,?,'latest',?,1,?,?)", (workspace, asset, release, created, updated))
        con.execute('INSERT INTO dataset_compat_heads(workspace_id,dataset_id,asset_id,draft_id,release_id,manifest_hash,manifest_ref,read_only,generation_source,generation_status,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (workspace, identity, asset, draft, release, prepared['root']['hash'], prepared['root']['ref'], int(readonly),
             source.get('generationSource'), source.get('generationStatus'), scope.principal_id, created, updated))
        store._artifacts_tx(con, workspace, prepared['artifacts'])
        store._queue_projection_tx(con, workspace, asset, release, prepared['root']['hash'], prepared['root']['ref'], 1, updated)
        event = con.execute("SELECT event_id FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='dataset.release.published.v1'", (workspace, asset)).fetchone()[0]
        return {'domain': 'asset_history', 'kind': 'dataset', 'dataset_id': identity, 'asset_id': asset,
                'release_id': release, 'content_hash': prepared['root']['hash'], 'projection_event_id': event}

    def verify(self, con, row, workspace, proof):
        resource = con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='asset' AND resource_id=?", (workspace, proof['asset_id'])).fetchone()
        if not resource or resource[0] != self.importer.bindings[self.importer._owner(row)]['principal_id']:
            raise Conflict('Imported asset ownership changed')
        alias = con.execute("SELECT a.release_id,r.content_hash,r.manifest_ref FROM asset_aliases a JOIN asset_releases r ON r.workspace_id=a.workspace_id AND r.release_id=a.release_id WHERE a.workspace_id=? AND a.asset_id=? AND a.alias='latest'", (workspace, proof['asset_id'])).fetchone()
        if not alias or alias['release_id'] != proof['release_id'] or alias['content_hash'] != proof['content_hash']:
            raise Conflict('Imported asset changed or is missing')
        self.control._verify_artifact(alias['content_hash'], alias['manifest_ref'])
        if proof['kind'] == 'dataset':
            head = con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?', (workspace, proof['dataset_id'])).fetchone()
            if not head or head['state'] != 'active' or head['revision'] != 1 or head['manifest_hash'] != proof['content_hash']:
                raise Conflict('Imported Dataset changed')
            event = con.execute('SELECT state FROM outbox_events WHERE workspace_id=? AND event_id=?', (workspace, proof['projection_event_id'])).fetchone()
            return bool(event and event[0] == 'sent')
        return True
