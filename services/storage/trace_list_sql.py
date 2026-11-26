"""Bounded ClickHouse reads for the ordinary Trace summary query plan."""
import collections
import hashlib
import json
import math

from .contracts import content_hash, identifier
from .trace_list_query import BATCH_SIZE, UseCompatibility


def literal(value):
    return "'" + str(value).replace('\\','\\\\').replace("'","\\'") + "'"


def route_predicate(store, workspace, routes):
    pairs = []
    for route in routes:
        store._scope(workspace,route['trace_bucket'],route['trace_id'])
        pairs.append('('+literal(route['trace_bucket'])+','+literal(route['trace_id'])+')')
    if sum(map(len,pairs)) > 3*1024*1024:raise UseCompatibility('candidate_bytes')
    return 'workspace_id={workspace:String} AND (trace_bucket,trace_id) IN ('+','.join(pairs)+')'


def expressions(routes, plan):
    attrs = 'attributes_json'
    def field(name, default):
        return "if(JSONHas("+attrs+","+literal(name)+"),JSONExtractString("+attrs+","+literal(name)+"),"+literal(default)+")"
    fields = dict(framework='framework',agentName='agent_name',sourceKind=field('source_kind','otlp'),ownership=field('ownership','user'),
                  status="multiIf(execution_status='done','success',execution_status='failed','failed',execution_status='running','running','unknown')")
    times = {str(r['created_at_ms']) for r in routes}
    fallback = 'toInt64('+next(iter(times))+')' if len(times)==1 else 'transform(trace_id,['+','.join(literal(r['trace_id']) for r in routes)+'],CAST(['+','.join(str(r['created_at_ms']) for r in routes)+'],\'Array(Int64)\'),toInt64(0))'
    timestamp = 'coalesce(started_at_ms,toUInt64('+fallback+'))'
    predicates = []
    for key,value in plan.filters.items():
        if key in fields:predicates.append(fields[key]+'='+literal(value))
        elif key == 'from':predicates.append(timestamp+'>='+str(float(value)))
        elif key == 'to':predicates.append(timestamp+'<='+str(float(value)))
        elif key == 'subagents' and value != 'all':predicates.append(('NOT ' if value=='main' else '')+"JSONExtractBool(attributes_json,'is_subagent')")
    supported = ['isValidJSON(attributes_json)', "JSONType(attributes_json)='Object'"]
    for key in ('source_kind','ownership'):
        supported.append("(NOT JSONHas(attributes_json,"+literal(key)+") OR JSONType(attributes_json,"+literal(key)+")='String')")
    supported.append("(NOT JSONHas(attributes_json,'is_subagent') OR JSONType(attributes_json,'is_subagent') IN ('Bool','Null'))")
    if plan.mode == 'stats':
        supported.append("JSONExtractRaw(attributes_json,'legacy_execution_metrics') IN ('','{}')")
        supported.append("(NOT JSONHas(attributes_json,'tool_error_count') OR JSONExtractRaw(attributes_json,'tool_error_count')='null' OR match(JSONExtractRaw(attributes_json,'tool_error_count'),'^\"?-?[0-9]+\"?$'))")
        supported.append("length(JSONExtractRaw(attributes_json,'tool_error_count')) <= 18")
    return fields,timestamp,' AND '.join(predicates) or '1',' AND '.join(supported)


def query_trace_list(store, workspace, routes, plan):
    from .read_transitions import TraceReadChanged
    if plan.mode == 'records':
        groups = [routes] if routes else []
    else:groups = [routes[i:i+BATCH_SIZE] for i in range(0,len(routes),BATCH_SIZE)]
    totals = collections.Counter()
    facets = collections.Counter()
    records = []
    for group in groups:
        scope = route_predicate(store,workspace,group)
        fields,timestamp,match,supported = expressions(group,plan)
        params = {'workspace':workspace}
        guard = 'SELECT countIf(NOT ('+supported+')) AS incompatible FROM obs_trace_current FINAL WHERE '+scope+' AND is_deleted=0 FORMAT JSONEachRow'
        checked = [json.loads(line) for line in store._request(guard,parameters=params).splitlines() if line]
        if len(checked)!=1 or int(checked[0]['incompatible']):raise UseCompatibility('summary_field_shape')
        # Versions are captured in PostgreSQL before querying facts and rechecked afterwards.
        expected = [(r['trace_id'],r.get('_head_revision')) for r in group if r.get('_head_revision') is not None]
        if expected:
            pairs = ','.join('('+literal(t)+','+literal(str(rev))+')' for t,rev in expected)
            ids = ','.join(literal(t) for t,_ in expected)
            query = 'SELECT count() AS stale FROM obs_trace_current FINAL WHERE '+scope+' AND is_deleted=0 AND trace_id IN ('+ids+') AND (trace_id,toString(revision)) NOT IN ('+pairs+') FORMAT JSONEachRow'
            stale = json.loads(store._request(query,parameters=params))
            if int(stale['stale']):raise TraceReadChanged('Trace summary differs from captured revision')
        base = ' FROM obs_trace_current FINAL WHERE '+scope+' AND is_deleted=0 AND ('+match+')'
        if plan.mode == 'records':
            order = plan.direction.upper()
            sql = 'SELECT *'+base+' ORDER BY '+timestamp+' '+order+',trace_id '+order+' LIMIT '+str(plan.size+1)+' OFFSET '+str((plan.page-1)*plan.size)+' FORMAT JSONEachRow'
            records = [json.loads(line) for line in store._request(sql,parameters=params).splitlines() if line]
        elif plan.mode == 'stats':
            latency = 'if(isNull(started_at_ms) OR isNull(ended_at_ms),0.,greatest(0.,toFloat64(ended_at_ms)-toFloat64(started_at_ms)))'
            errors = "toInt64OrZero(replaceAll(JSONExtractRaw(attributes_json,'tool_error_count'),'\"',''))"
            sql = "SELECT count() AS total,countIf(execution_status='failed') AS failedCount,sum("+latency+') AS latencySum,sum(toDecimal256(coalesce(tool_call_count,0),0)) AS toolCalls,sum(toDecimal256('+errors+',0)) AS toolErrors'+base+' FORMAT JSONEachRow'
            row = json.loads(store._request(sql,parameters=params))
            for key in ('total','failedCount','toolCalls','toolErrors'):totals[key] += int(row[key])
            totals['latencySum'] += float(row['latencySum'])
        else:
            expression = fields['agentName' if plan.mode=='agents' else plan.facet]
            sql = 'SELECT '+expression+' AS value,count() AS count'+base+' GROUP BY value FORMAT JSONEachRow'
            for line in store._request(sql,parameters=params).splitlines():
                if line:
                    row=json.loads(line);facets[row['value']] += int(row['count'])
    if plan.mode == 'records':return {'rows':records}
    if plan.mode == 'agents':return {'agents':sorted(value for value in facets if value)}
    if plan.mode == 'facet':return [{'value':value,'count':count} for value,count in sorted(facets.items(),key=lambda item:(-item[1],item[0]))]
    return {'stats':dict(total=totals['total'],failedCount=totals['failedCount'],avgLatencyMs=totals['latencySum']/totals['total'] if totals['total'] else 0,
                         toolErrorRate=math.floor(totals['toolErrors']/totals['toolCalls']*1000+.5)/10 if totals['toolCalls'] else 0)}


def read_root_executions(store, workspace, routes):
    from .clickhouse import IncompletePayload
    from .trace_analytics import AnalyticsTooLarge, AnalyticsUnavailable, MAX_EXECUTION_SOURCE_BYTES, MAX_PAGE_BYTES
    from .trace_evidence import TraceEvidence
    from .execution_metadata import select_execution
    result = {};budget = MAX_EXECUTION_SOURCE_BYTES
    for start in range(0,len(routes),BATCH_SIZE):
        group = routes[start:start+BATCH_SIZE]
        roots = collections.defaultdict(list)
        sql = 'SELECT * FROM obs_span_current FINAL WHERE '+route_predicate(store,workspace,group)+" AND is_deleted=0 AND parent_span_id='' ORDER BY trace_id,span_id LIMIT 1001 BY trace_id FORMAT JSONEachRow"
        for line in store._request(sql,parameters={'workspace':workspace}).splitlines():
            if line:
                row=json.loads(line);roots[row['trace_id']].append(row)
        if any(len(rows)>1000 for rows in roots.values()):raise AnalyticsTooLarge('Execution has too many roots')
        all_roots=[row for rows in roots.values() for row in rows]
        sections={}
        for offset in range(0,len(all_roots),BATCH_SIZE):
            batch=all_roots[offset:offset+BATCH_SIZE]
            tuples=','.join('('+','.join(literal(identifier(str(row[key]))) for key in ('trace_bucket','trace_id','span_id','payload_revision'))+')' for row in batch)
            where='workspace_id={workspace:String} AND (trace_bucket,trace_id,span_id,payload_revision) IN ('+tuples+')'
            manifests={}
            for line in store._request('SELECT trace_id,span_id,payload_revision,manifest_json FROM obs_payload_manifests FINAL WHERE '+where+' FORMAT JSONEachRow',parameters={'workspace':workspace}).splitlines():
                if line:
                    row=json.loads(line);key=(row['trace_id'],row['span_id']);manifest=json.loads(row['manifest_json'])
                    if key in manifests or content_hash(manifest)!=row['payload_revision'] or type(manifest.get('schema_version')) is not int or manifest['schema_version']!=1 or not isinstance(manifest.get('sections'),dict):raise IncompletePayload('invalid root payload manifest')
                    manifests[key]=manifest
            chunks=collections.defaultdict(list)
            for line in store._request('SELECT trace_id,span_id,chunk_no,chunk_count,uncompressed_bytes,content_hash,body FROM obs_payload_chunks FINAL WHERE '+where+" AND section='attributes' ORDER BY trace_id,span_id,chunk_no FORMAT JSONEachRow",parameters={'workspace':workspace}).splitlines():
                if line:
                    row=json.loads(line);chunks[(row['trace_id'],row['span_id'])].append(row)
            for row in batch:
                key=(row['trace_id'],row['span_id']);manifest=manifests.get(key)
                if manifest is None:raise IncompletePayload('root payload is not published')
                expected=manifest['sections'].get('attributes')
                if expected is None:sections[key]='{}';continue
                pages=chunks[key]
                if type(expected.get('chunk_count')) is not int or not 1<=expected['chunk_count']<=4096 or len(pages)!=expected['chunk_count'] or len(expected.get('chunk_hashes',[]))!=len(pages):raise IncompletePayload('incomplete root attributes')
                for index,chunk in enumerate(pages):
                    raw=chunk['body'].encode();budget-=len(raw)
                    if budget<0:raise AnalyticsTooLarge('Execution metadata source budget exceeded')
                    if (int(chunk['chunk_no'])!=index or int(chunk['chunk_count'])!=len(pages) or len(raw)!=int(chunk['uncompressed_bytes']) or hashlib.sha256(raw).hexdigest()!=chunk['content_hash'] or chunk['content_hash']!=expected['chunk_hashes'][index]):raise IncompletePayload('corrupt root attributes')
                value=''.join(chunk['body'] for chunk in pages)
                if len(value.encode())!=expected.get('uncompressed_bytes') or hashlib.sha256(value.encode()).hexdigest()!=expected.get('content_hash'):raise IncompletePayload('root attributes hash differs')
                sections[key]=value
        for route in group:
            candidates=collections.defaultdict(list)
            for row in roots[route['trace_id']]:
                value=sections[(row['trace_id'],row['span_id'])]
                fields=TraceEvidence._fields({'row':row,'sections':{'attributes':value}},analytics_fields=True)
                attrs=json.loads(value);attrs={**attrs.get('resource',{}),**attrs.get('span',{})}
                for camel,snake in (('answerScore','answer_score'),('skillScore','skill_score'),('judgmentReason','judgment_reason'),('isSkillCorrect','is_skill_correct'),('expectedSkillVersion','expected_skill_version')):
                    for key in ('legacy.'+snake,snake,camel):
                        if key in attrs:fields[camel]=attrs[key];break
                for key,value in select_execution(fields).items():candidates[key].append(value)
            execution={}
            for key,values in candidates.items():
                if len({json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False) for v in values})!=1:raise AnalyticsUnavailable('Root execution metadata is ambiguous')
                execution[key]=values[0]
            result[route['trace_id']]=execution
            if len(json.dumps(result,ensure_ascii=False,allow_nan=False).encode())>MAX_PAGE_BYTES:
                raise AnalyticsTooLarge('Execution metadata page exceeds budget')
    return result
