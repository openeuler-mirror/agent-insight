from .control import Conflict
from .legacy_import import _hash
from .semantic_usage import SemanticUsageStore, MODELS

SEMANTIC_MODELS = frozenset({kind[0].upper()+kind[1:] for kind in MODELS} | {'PlatformUsageEvent', 'PlatformUsageDaily'})


class SemanticHistory:
    def __init__(self, importer): self.importer = importer; self.store = SemanticUsageStore(importer.control, importer.facts)

    def write(self, con, row, scope, workspace, owner):
        result = self.store.import_history_row(con, workspace, scope.principal_id, owner, row['model'], row['data'])
        proof = {'domain': 'semantic_history', 'kind': result['kind'], 'record_id': result['id'], 'content_hash': result['content_hash']}
        target = self._target(con, row, workspace, scope.principal_id, proof)
        if not target: raise Conflict('Historical semantic helper did not persist its target')
        proof['target_hash'] = _hash(dict(target))
        return proof

    def _target(self, con, row, workspace, owner, proof):
        if proof['kind'] == 'usage':
            return con.execute('SELECT * FROM usage_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND event_id=?', (workspace, owner, proof['record_id'])).fetchone()
        if proof['kind'] == 'daily':
            data = row['data']
            return con.execute('SELECT * FROM usage_daily_heads WHERE workspace_id=? AND owner_principal_id=? AND date_key=? AND feature_key=? AND event_key=?',
                (workspace, owner, data['dateKey'], data['featureKey'], data['eventKey'])).fetchone()
        return con.execute('SELECT * FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?',
            (workspace, owner, proof['kind'], proof['record_id'])).fetchone()

    def verify(self, con, row, workspace, proof):
        owner = self.importer.bindings[self.importer._owner(row)]['principal_id']
        target = self._target(con, row, workspace, owner, proof)
        if not target or target['content_hash'] != proof['content_hash'] or _hash(dict(target)) != proof['target_hash']:
            raise Conflict('Imported semantic target changed or is missing')
        if proof['kind'] in {'usage', 'daily'}:
            table = 'usage_event_facts' if proof['kind'] == 'usage' else 'usage_daily_facts'
            value = self.importer.facts.read_semantic_fact(table, workspace, owner, proof['kind'], proof['record_id'], proof['content_hash'])
            if value is None: return False
            if _hash(value) != proof['content_hash']: raise Conflict('Imported usage fact differs')
            return True
        self.store._payload(target)
        self.store._record_body(target)
        return True
