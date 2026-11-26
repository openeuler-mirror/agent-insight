"""Authorized batch snapshots and conservative Trace list query planning."""
import collections
import dataclasses
import json
import logging
import math
import time
import uuid

from .contracts import identifier, canonical_json, content_hash
from .control import Conflict
from .iam import Forbidden
from .read_transitions import TraceReadChanged


LOG = logging.getLogger(__name__)
BATCH_SIZE = 200


class UseCompatibility(Exception):
    pass


@dataclasses.dataclass
class ListPlan:
    mode: str
    page: int = 1
    size: int = 20
    direction: str = 'desc'
    filters: dict = dataclasses.field(default_factory=dict)
    facet: str = ''

    @classmethod
    def parse(cls, params, now):
        from .compatibility_list import _flag, _milliseconds
        allowed = {'user','workspace_id','paginated','databasePagination','page','pageSize','sort','dir','time','timeFrom','timeTo','status','anomaly','includeEvaluations','fields','includeTags','skipAutoEvalReady','collapseGoalPlusWorkers','ownership','listPart','framework','sourceKind','agentName','traceUser','tagIds','bizTag','includeSubagents','onlySubagents','summary','facet','column','kind'}
        if set(params) - allowed or params.get('sort','timestamp') != 'timestamp' or params.get('anomaly','all') not in ('all',''):
            raise UseCompatibility('complex_filter')
        mode = params.get('listPart')
        facet = params.get('facet')
        if facet == 'values' and params.get('column') in ('framework','sourceKind'):
            mode = 'facet'
        elif params.get('summary') == 'agents':
            mode = 'agents'
        elif facet is not None or params.get('summary') is not None:
            raise UseCompatibility('unsupported_facet')
        elif mode not in ('records','stats') or not _flag(params.get('paginated')):
            raise UseCompatibility('unpaged_request')
        page, size = int(params.get('page',1)), int(params.get('pageSize',20))
        direction = params.get('dir','desc')
        if not 1 <= page <= 1000000 or not 1 <= size <= 100 or direction not in ('asc','desc'):
            raise ValueError('invalid existing pagination')
        filters = {k:params[k] for k in ('framework','sourceKind','agentName','ownership','status') if params.get(k)}
        if filters.get('status') in ('all',''):filters.pop('status',None)
        filters['subagents'] = 'only' if _flag(params.get('onlySubagents')) else 'all' if _flag(params.get('includeSubagents')) else 'main'
        windows = {'30m':1800000,'1h':3600000,'3h':10800000,'24h':86400000,'7d':604800000,'30d':2592000000}
        window = params.get('time','all')
        if window not in ('all','custom',*windows):raise ValueError('invalid time window')
        if window in windows:filters['from'] = now - windows[window]
        if params.get('timeFrom'):filters['from'] = _milliseconds(params['timeFrom'])
        if params.get('timeTo'):filters['to'] = _milliseconds(params['timeTo'])
        if any(not math.isfinite(filters[key]) for key in ('from','to') if key in filters):
            raise ValueError('invalid finite time boundary')
        if mode == 'facet':filters = {'subagents':'all'}
        return cls(mode,page,size,direction,filters,params.get('column',''))


class BatchSnapshot:
    def __init__(self, api, token, workspace, ids=None, *, enrich=False):
        self.api, self.token, self.workspace = api, token, workspace
        self.routes = {}
        self.annotations = {}
        self.aliases = collections.defaultdict(list)
        self.heads = {}
        self.outcomes = {}
        self.links = collections.defaultdict(list)
        self.tags = collections.defaultdict(list)
        self.enrich = enrich
        with api.control.read_transaction() as con:
            self.scope = api.iam._scope(con,token)
            self.grant = api.iam._workspace(self.scope,workspace,'read')
            access, values = api.queries._selection(con,self.scope,workspace)
            query = "SELECT t.*,a.owner_principal_id,p.normalized_login_name AS owner_login FROM trace_locators t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id JOIN iam_principals p ON p.principal_id=a.owner_principal_id WHERE t.workspace_id=? AND t.state='active'" + access
            groups = [None] if ids is None else [list(ids)[i:i+BATCH_SIZE] for i in range(0,len(ids),BATCH_SIZE)]
            for group in groups:
                suffix = '' if group is None else ' AND t.trace_id IN ('+','.join('?' for _ in group)+')'
                for row in con.execute(query+suffix,tuple(values)+(tuple(group) if group is not None else ())):
                    self.routes[row['trace_id']] = dict(row)
            if ids is not None and set(ids) != set(self.routes):raise Forbidden('Trace access changed during batch read')
            if len(self.routes) > 100000:raise UseCompatibility('candidate_budget')
            if any(row['source_namespace'].startswith(('collector.source.v1','trace.bundle.','agent.record.')) for row in self.routes.values()):
                raise UseCompatibility('legacy_source')
            self._capture(con)

    def _capture(self, con):
        ws = self.workspace
        traces = list(self.routes)
        metadata = self.api.metadata
        counts = metadata._counts(con,self.scope,self.grant,ws) if self.enrich and metadata else {}
        for start in range(0,len(traces),BATCH_SIZE):
            group = traces[start:start+BATCH_SIZE]
            marks = ','.join('?' for _ in group)
            params = (ws,*group)
            for row in con.execute('SELECT * FROM deletion_requests WHERE workspace_id=? AND resource_kind=\'trace\' AND resource_id IN ('+marks+')',params):
                if str(row['incarnation']) == str(self.routes[row['resource_id']]['incarnation']):raise Conflict('Trace deletion barrier')
            for row in con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id IN ('+marks+')',params):
                self.annotations[row['trace_id']] = dict(row)
            for row in con.execute('SELECT * FROM trace_legacy_ids WHERE workspace_id=? AND trace_id IN ('+marks+') ORDER BY alias_kind,created_at_ms,alias_id',params):
                self.aliases[row['trace_id']].append(dict(row))
            for row in con.execute('SELECT * FROM trace_tag_links WHERE workspace_id=? AND trace_id IN ('+marks+') ORDER BY trace_id,tag_id',params):
                self.links[row['trace_id']].append(dict(row))
            for row in con.execute("SELECT trace_id,revision,source_revision,content_hash FROM obs_entity_heads WHERE workspace_id=? AND entity_kind='trace' AND trace_id=entity_id AND trace_id IN ("+marks+')',params):
                self.heads[row['trace_id']] = dict(row)
            identities = [str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json(['trace-outcome/v1',ws,self.routes[t]['owner_principal_id'],t,self.routes[t]['incarnation']]))) for t in group]
            for row in con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id IN ('+marks+')',(ws,*identities)):
                self.outcomes[row['experiment_id']] = dict(row)
            if self.enrich and metadata:
                query = 'SELECT l.trace_id,t.*,p.normalized_login_name AS login_name FROM trace_tag_links l JOIN trace_tags t ON t.workspace_id=l.workspace_id AND t.tag_id=l.tag_id JOIN iam_principals p ON p.principal_id=t.owner_principal_id WHERE l.workspace_id=? AND l.trace_id IN ('+marks+') ORDER BY t.created_at_ms DESC,t.tag_id'
                for row in con.execute(query,params):self.tags[row['trace_id']].append(metadata._dto(row,counts.get(row['tag_id'],0)))
        if self.enrich and (self.outcomes or any(json.loads(row['extra_json']).get('outcome_reset') is not None for row in self.annotations.values())):
            raise UseCompatibility('outcome_projection')

    def recheck(self):
        try:current = BatchSnapshot(self.api,self.token,self.workspace,list(self.routes),enrich=False)
        except UseCompatibility:raise Conflict('Trace source identity changed during batch read') from None
        if current.scope.fingerprint != self.scope.fingerprint:raise Forbidden('Authorization changed during batch read')
        if current.routes != self.routes or dict(current.aliases) != dict(self.aliases):raise Conflict('Trace identity changed during batch read')
        if current.annotations != self.annotations or current.heads != self.heads or current.outcomes != self.outcomes or dict(current.links) != dict(self.links):
            raise TraceReadChanged('Trace metadata changed during batch read')

    def select(self, params):
        selected = set(self.routes)
        if params.get('traceUser'):selected = {t for t in selected if self.routes[t]['owner_login'] == params['traceUser']}
        tags = set(filter(None,(params.get('tagIds') or params.get('bizTag') or '').split(',')))
        if tags:
            linked = {trace:{row['tag_id'] for row in links} for trace,links in self.links.items()}
            selected = {t for t in selected if tags <= linked.get(t,set())}
        return [dict(self.routes[t],_head_revision=self.heads.get(t,{}).get('revision')) for t in sorted(selected)]


def optimized_read(api, token, workspace, params):
    from .compatibility_list import record_from_summary
    from .trace_metadata import TraceMetadata
    started = time.monotonic()
    facts = api.queries.facts
    if not getattr(api.queries,'optimize_lists',False) or not callable(getattr(facts,'query_trace_list',None)):
        return None
    try:
        if params.get('facet') == 'tags':
            return api.metadata.list_tags(token,workspace,params.get('kind')) if api.metadata else []
        plan = ListPlan.parse(params,api.control.clock())
        snapshot = BatchSnapshot(api,token,workspace)
        selected = snapshot.select({} if plan.mode=='facet' else params)
        result = facts.query_trace_list(workspace,selected,plan)
        if plan.mode == 'records':
            rows = result['rows'][:plan.size]
            page = BatchSnapshot(api,token,workspace,[row['trace_id'] for row in rows],enrich=True)
            if page.scope.fingerprint != snapshot.scope.fingerprint:raise Forbidden('Authorization changed during pagination')
            executions = facts.read_root_executions(workspace,[page.routes[row['trace_id']] for row in rows]) if api.analytics and rows else {}
            records = []
            for row in rows:
                trace = row['trace_id'];route = page.routes[trace]
                if row['trace_bucket'] != route['trace_bucket']:raise Forbidden('Trace bucket changed')
                aliases = {key:next((a['alias_id'] for a in page.aliases.get(trace,[]) if a['alias_kind']==kind),trace) for kind,key in [('task','task_id'),('execution','execution_id')]}
                properties = TraceMetadata._properties(page.annotations.get(trace),workspace,trace) if api.metadata else {}
                record = record_from_summary(dict(row,created_at_ms=route['created_at_ms'],owner_principal_id=route['owner_principal_id']),aliases,properties,page.tags[trace],route['owner_login'],executions.get(trace))
                records.append({key:value for key,value in record.items() if not key.startswith('_')})
            page.recheck()
            output = dict(records=records,page=plan.page,pageSize=plan.size,hasMore=len(result['rows'])>plan.size,canViewAllTraces=snapshot.grant.role in ('owner','admin'))
        else:
            output = result
        snapshot.recheck()
        LOG.info('trace_list path=database mode=%s candidates=%d seconds=%.3f',plan.mode,len(selected),time.monotonic()-started)
        return output
    except UseCompatibility as error:
        LOG.info('trace_list path=compatibility reason=%s',str(error))
        return None
