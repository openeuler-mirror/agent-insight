"""IAM-scoped, source-bound statistics projections; raw evidence is prepared separately."""
import datetime
import base64
import hashlib
import hmac
import json
import re

from .contracts import content_hash, identifier
from .control import Conflict, StorageError
from .iam import Forbidden
from .trace_evidence import TraceEvidence

MAX_PROJECTION_BYTES=2*1024*1024
MAX_PAGE_BYTES=8*1024*1024
MAX_RAS_EVENTS=10000
PARSER_VERSION=1


class AnalyticsUnavailable(StorageError):
    status=503


class AnalyticsTooLarge(StorageError):
    status=413


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _hash(value):return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _digest(value):
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value):raise ValueError('Invalid analytics digest')
    return value


def _selection(value):
    if value is None:return {}
    if not isinstance(value,dict) or set(value)-{'from_ms','to_ms','agent'}:raise ValueError('Invalid analytics selection')
    for key in ('from_ms','to_ms'):
        if key in value and (type(value[key]) is not int or not 0<=value[key]<=2**53-1):raise ValueError('Invalid analytics time bound')
    if value.get('from_ms',0)>value.get('to_ms',2**53-1):raise ValueError('Invalid analytics time window')
    if 'agent' in value and (not isinstance(value['agent'],str) or not 1<=len(value['agent'])<=256 or value['agent']!=value['agent'].strip()):raise ValueError('Invalid analytics Agent selection')
    return dict(value)


def _milliseconds(value):
    try:
        if type(value) in (int,float):return float(value)
        parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
        return parsed.timestamp()*1000 if parsed.tzinfo else None
    except (ValueError,TypeError,AttributeError,OverflowError):return None


def _inside(value,selection):return (selection.get('from_ms') is None or value>=selection['from_ms']) and (selection.get('to_ms') is None or value<=selection['to_ms'])


def _projection_matches(value,selection):
    if not selection:return True
    for row in value['executions']:
        if selection.get('agent') and row.get('agentName')!=selection['agent']:continue
        timestamp=_milliseconds(row.get('timestamp'))
        if timestamp is None or _inside(timestamp,selection):return True
    for item in [value['collaboration'],*value['collaboration'].get('children',[])]:
        if not item['candidate']:continue
        if selection.get('agent') and not any(selection['agent'] in edge for edge in item['edges']):continue
        timestamp=_milliseconds(item['startTime'])
        if timestamp is None or _inside(timestamp,selection):return True
    return False


EXECUTION_FIELDS=frozenset('id taskId user timestamp query agentName framework model isSubagent parentExecutionId rootExecutionId observedAgents latency latencyMs tokens inputTokens outputTokens cacheReadInputTokens cacheCreationInputTokens reasoningTokens maxSingleCallTokens cost toolCallCount toolCallErrorCount llmCallCount isAnswerCorrect failures callStats skill skillVersion skills invokedSkills executionSkills stepCount skillTriggerRate skillIssues safety executionStatus execution_status traceStatus agentOwnership label endpoint'.split())
EXECUTION_FIELDS=EXECUTION_FIELDS|frozenset('clientId hostIp hostName observedIp sessionEndTime sessionLabel'.split())


def _projection(value):
    if not isinstance(value,dict) or set(value)!={'version','executions','collaboration','errors','provenance'} or type(value.get('version')) is not int or value['version']!=PARSER_VERSION:raise ValueError('Unsupported analytics projection')
    if not isinstance(value['executions'],list) or not 1<=len(value['executions'])<=10000:raise ValueError('Invalid analytics execution rows')
    for row in value['executions']:
        if not isinstance(row,dict) or set(row)-EXECUTION_FIELDS:raise ValueError('Unknown analytics execution field')
        identifier(row.get('id'));identifier(row.get('taskId'));identifier(row.get('user'))
    collaboration=value['collaboration'];_collaboration(collaboration)
    children=collaboration.get('children',[])
    if not isinstance(children,list) or len(children)>10000:raise ValueError('Invalid child collaboration coverage')
    for child in children:_collaboration(child,child=True)
    if not isinstance(value['errors'],list):raise ValueError('Invalid structured error projection')
    for row in value['errors']:
        if not isinstance(row,dict) or set(row)!={'executionId','clusters'} or not isinstance(row['clusters'],list):raise ValueError('Invalid structured error row')
        identifier(row['executionId'])
        for cluster in row['clusters']:
            if not isinstance(cluster,dict) or set(cluster)-{'key','node','errorCode','object','count','attribution'} or type(cluster.get('count')) is not int or cluster['count']<1:raise ValueError('Invalid structured error cluster')
    provenance=value['provenance']
    if not isinstance(provenance,dict) or set(provenance)!={'snapshot_hash'}:raise ValueError('Invalid analytics provenance')
    _digest(provenance['snapshot_hash'])
    try:text=_json(value)
    except (TypeError,ValueError,RecursionError,UnicodeError):raise ValueError('Analytics projection is not finite JSON') from None
    if len(text.encode('utf-8'))>MAX_PROJECTION_BYTES:raise AnalyticsTooLarge('Analytics projection exceeds 2MiB; explicit narrowing required')
    return text,hashlib.sha256(text.encode('utf-8')).hexdigest()


def _collaboration(value,*,child=False):
    fields={'candidate','startTime','edges'}|({'executionId'} if child else set())
    if not isinstance(value,dict) or not fields<=set(value) or set(value)-fields-({'children'} if not child else set()):raise ValueError('Invalid collaboration projection fields')
    if type(value['candidate']) is not bool or value['startTime'] is not None and not isinstance(value['startTime'],str) or not isinstance(value['edges'],list):raise ValueError('Invalid collaboration projection')
    if child:identifier(value['executionId'])
    for edge in value['edges']:
        if not isinstance(edge,list) or len(edge)!=2 or not all(isinstance(part,str) and 0<len(part)<=512 for part in edge):raise ValueError('Invalid collaboration edge')


class TraceAnalytics:
    def __init__(self,queries,authorized):
        self.queries=queries;self.authorized=authorized;self.control=queries.control;self.iam=queries.iam;self.facts=queries.facts

    def _boundary(self,con,token,workspace,trace,scope=None):
        scope=scope or self.iam._scope(con,token)
        self.iam._authorize_scope(con,scope,workspace,'read','trace',trace)
        for table,version in [('experiment_judge_traces',10),('diagnosis_judge_traces',11)]:
            if con.execute('SELECT 1 FROM schema_meta WHERE version=?',(version,)).fetchone() and con.execute('SELECT 1 FROM '+table+' WHERE workspace_id=? AND trace_id=? AND owner_principal_id<>?',(workspace,trace,scope.principal_id)).fetchone():raise Forbidden('Private evaluator Trace is excluded from analytics')
        route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        if route is None or route['state']!='active':raise Forbidden('Trace route is not active')
        if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(workspace,trace,route['incarnation'])).fetchone():raise Conflict('Trace deletion barrier')
        owner=con.execute("SELECT a.owner_principal_id,p.normalized_login_name FROM iam_resource_access a JOIN iam_principals p ON p.principal_id=a.owner_principal_id WHERE a.workspace_id=? AND a.resource_kind='trace' AND a.resource_id=?",(workspace,trace)).fetchone()
        aliases=[dict(row) for row in con.execute('SELECT alias_kind,alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? ORDER BY alias_kind,created_at_ms,alias_id',(workspace,trace))]
        annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        head=con.execute("SELECT revision,source_revision,content_hash FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='trace' AND entity_id=?",(workspace,trace,trace)).fetchone()
        # Ingest prepares every changed Span and advances this Trace head in the same control transaction.
        value={'route':dict(route),'owner':dict(owner),'aliases':aliases,'annotation':dict(annotation) if annotation else None,'trace_head':dict(head) if head else None,'parser_version':PARSER_VERSION}
        task=next((row['alias_id'] for row in aliases if row['alias_kind']=='task'),trace)
        return _hash(value),{'route':dict(route),'owner':dict(owner),'task_id':task,'trace_head_revision':head['revision'] if head else None}

    def _recheck(self,token,workspace,scope,boundaries):
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,workspace,'read')
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Authorization changed during analytics query')
            for trace,boundary in boundaries.items():
                if self._boundary(con,token,workspace,trace,current)[0]!=boundary:raise Conflict('Trace source changed during analytics query')

    def prepare(self,token,workspace,trace):
        identifier(workspace);identifier(trace)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);boundary,_=self._boundary(con,token,workspace,trace,scope)
        evidence=TraceEvidence(self.queries,self.authorized,max_bytes=128*1024*1024,allow_missing_session=True,analytics_fields=True).read(token,workspace,trace_ref=trace)
        summary=self.queries.summary(token,workspace,trace)['trace']
        self._recheck(token,workspace,scope,{trace:boundary})
        return {'trace_id':trace,'boundary':boundary,'summary':summary,'evidence':evidence}

    def publish(self,token,workspace,trace,boundary,projection):
        identifier(workspace);identifier(trace);_digest(boundary)
        text,digest=_projection(projection)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);actual,source=self._boundary(con,token,workspace,trace,scope)
            if actual!=boundary:raise Conflict('Analytics source boundary changed before publication')
            if any(row['user']!=source['owner']['normalized_login_name'] for row in projection['executions']):raise Forbidden('Analytics execution owner differs from authoritative Trace owner')
            old=con.execute('SELECT * FROM trace_analytics_publications WHERE workspace_id=? AND trace_id=? AND boundary=? AND parser_version=?',(workspace,trace,boundary,PARSER_VERSION)).fetchone()
            if old and old['projection_hash']!=digest:raise Conflict('Analytics parser produced divergent content for one boundary')
        self.facts.write_analytics({'workspace_id':workspace,'trace_bucket':source['route']['trace_bucket'],'trace_id':trace,'boundary':boundary,
            'parser_version':PARSER_VERSION,'projection_hash':digest,'projection_json':text,'retry_version':1})
        with self.control.transaction() as con:
            current=self.iam._scope(con,token)
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Authorization changed before analytics publication')
            if self._boundary(con,token,workspace,trace,current)[0]!=boundary:raise Conflict('Analytics source boundary changed during publication')
            old=con.execute('SELECT * FROM trace_analytics_publications WHERE workspace_id=? AND trace_id=? AND boundary=? AND parser_version=?',(workspace,trace,boundary,PARSER_VERSION)).fetchone()
            if old:
                if old['projection_hash']!=digest:raise Conflict('Analytics parser produced divergent content for one boundary')
                return dict(old)
            con.execute('INSERT INTO trace_analytics_publications VALUES(?,?,?,?,?,?,?,?)',(workspace,trace,boundary,PARSER_VERSION,digest,projection['provenance']['snapshot_hash'],scope.principal_id,self.control.clock()))
            return dict(con.execute('SELECT * FROM trace_analytics_publications WHERE workspace_id=? AND trace_id=? AND boundary=? AND parser_version=?',(workspace,trace,boundary,PARSER_VERSION)).fetchone())

    @staticmethod
    def _summary_might_match(summary,source,selection):
        if not summary or not any(key in selection for key in ('from_ms','to_ms')):return True
        if str(summary.get('revision'))!=str(source['trace_head_revision']):return True
        route=source['route']
        if any(summary.get(key)!=route[key] for key in ('workspace_id','trace_id','trace_bucket','source_namespace','native_trace_id')):return True
        try:attrs=json.loads(summary.get('attributes_json') or '{}')
        except (ValueError,TypeError):return True
        if not isinstance(attrs,dict) or attrs.get('owner_principal_id')!=source['owner']['owner_principal_id']:return True
        metrics=attrs.get('legacy_execution_metrics')
        if isinstance(metrics,dict) and not isinstance(attrs.get('execution_timestamp'),str):return True
        values=[summary.get('started_at_ms'),summary.get('ended_at_ms')]
        if isinstance(metrics,dict):values.extend([attrs['execution_timestamp'],metrics.get('session_start'),metrics.get('session_end')])
        times=[_milliseconds(value) for value in values if value is not None]
        if not times or any(value is None for value in times):return True
        return not (selection.get('from_ms') is not None and max(times)<selection['from_ms'] or selection.get('to_ms') is not None and min(times)>selection['to_ms'])

    def read(self,token,workspace,*,limit=200,cursor=None,selection=None):
        identifier(workspace)
        selection_filter=_selection(selection)
        if type(limit) is not int or not 1<=limit<=200:raise ValueError('Analytics page size must be 1..200')
        scope,_=self.queries._candidates(token,workspace,None,1)
        query=content_hash({'workspace_id':workspace,'domain':'trace-analytics','parser_version':PARSER_VERSION,'selection':selection_filter})
        after=self.queries._decode(cursor,scope.fingerprint,query) if cursor else None
        current,candidates=self.queries._candidates(token,workspace,after,limit+1)
        if current.fingerprint!=scope.fingerprint:raise Forbidden('Authorization changed during analytics pagination')
        more=len(candidates)>limit;candidates=candidates[:limit]
        boundaries={};sources={};accepted=[];pending=[]
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token)
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Authorization changed during analytics query')
            for row in candidates:
                trace=row['trace_id'];boundary,source=self._boundary(con,token,workspace,trace,current)
                boundaries[trace]=boundary;sources[trace]=source
                receipt=con.execute('SELECT * FROM trace_analytics_publications WHERE workspace_id=? AND trace_id=? AND boundary=? AND parser_version=?',(workspace,trace,boundary,PARSER_VERSION)).fetchone()
                if receipt:accepted.append({'trace_id':trace,'trace_bucket':row['trace_bucket'],'boundary':boundary,'projection_hash':receipt['projection_hash']})
                else:pending.append({'trace_id':trace,'boundary':boundary})
        if pending and any(key in selection_filter for key in ('from_ms','to_ms')):
            summaries=self.queries._trace_rows(workspace,[sources[row['trace_id']]['route'] for row in pending],status=None,agent=None,search=None)
            pending=[row for row in pending if self._summary_might_match(summaries.get((sources[row['trace_id']]['route']['trace_bucket'],row['trace_id'])),sources[row['trace_id']],selection_filter)]
        facts=self.facts.read_analytics(workspace,accepted) if accepted else []
        actual={(row['trace_id'],row['boundary'],row['projection_hash']):row for row in facts if row.get('workspace_id')==workspace}
        items=[];size=0
        for selection in accepted:
            row=actual.get((selection['trace_id'],selection['boundary'],selection['projection_hash']))
            if row is None:raise AnalyticsUnavailable('Accepted analytics projection is not readable')
            text=row.get('projection_json')
            if not isinstance(text,str) or len(text.encode('utf-8'))>MAX_PROJECTION_BYTES or hashlib.sha256(text.encode('utf-8')).hexdigest()!=selection['projection_hash']:raise AnalyticsUnavailable('Analytics projection checksum differs')
            try:projection=json.loads(text);_projection(projection)
            except (ValueError,TypeError,KeyError,RecursionError):raise AnalyticsUnavailable('Analytics projection is invalid') from None
            size+=len(text.encode('utf-8'))
            if size>MAX_PAGE_BYTES:raise AnalyticsTooLarge('Analytics page exceeds 8MiB; request fewer traces')
            if _projection_matches(projection,selection_filter):items.append({'trace_id':selection['trace_id'],'boundary':selection['boundary'],'projection':projection})
        selected_ids={row['trace_id'] for row in items+pending}
        events,ras_snapshot=self._ras_read(workspace,{trace:source for trace,source in sources.items() if trace in selected_ids})
        self._recheck(token,workspace,scope,boundaries)
        position=candidates[-1] if candidates else None
        next_cursor=self.queries._encode({'version':1,'scope':scope.fingerprint,'query':query,'created_at_ms':position['created_at_ms'],'trace_id':position['trace_id']}) if more else None
        ras_token=self.queries._encode({'purpose':'analytics-ras/v1','workspace_id':workspace,'scope':scope.fingerprint,'trace_ids':sorted(selected_ids),'snapshot_hash':_hash(ras_snapshot)})
        return {'items':items,'pending':pending,'next_cursor':next_cursor,'scope_fingerprint':scope.fingerprint,'project_id':scope.project_id,'ras_events':events,'ras_read_token':ras_token,
            'checked_sources':[{'trace_id':trace,'boundary':boundary} for trace,boundary in boundaries.items()]}

    @staticmethod
    def _ras_snapshot(con,workspace,sources):
        receipts=[];seen=set()
        frames={}
        for trace,source in sorted(sources.items()):
            owner=source['owner']['owner_principal_id'];task=source['task_id']
            frames[trace]={'owner':owner,'task':task,'incarnation':source['route']['incarnation'],'route_epoch':source['route']['route_epoch']}
            if (owner,task) in seen:continue
            seen.add((owner,task))
            rows=con.execute('SELECT * FROM ras_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND task_id=? ORDER BY occurred_at_ms,event_id LIMIT ?',(workspace,owner,task,MAX_RAS_EVENTS+1)).fetchall()
            receipts.extend(dict(row) for row in rows)
            if len(receipts)>MAX_RAS_EVENTS:raise AnalyticsTooLarge('RAS event page exceeds 10000; narrow the Trace selection')
        return {'sources':frames,'receipts':receipts}

    def _ras_read(self,workspace,sources):
        with self.control.read_transaction() as con:snapshot=self._ras_snapshot(con,workspace,sources)
        receipts=snapshot['receipts']
        if not receipts:return [],snapshot
        facts=self.facts.read_ras_events(workspace,receipts)
        index={(row['owner_principal_id'],row['task_id'],row['event_key'],row['content_hash']):row for row in facts if row.get('workspace_id')==workspace}
        events=[];size=0
        for receipt in receipts:
            row=index.get(tuple(receipt[k] for k in ('owner_principal_id','task_id','event_key','content_hash')))
            if row is None:raise AnalyticsUnavailable('Accepted RAS event is not readable')
            text=row.get('event_json')
            if not isinstance(text,str) or len(text.encode('utf-8'))>262144 or hashlib.sha256(text.encode('utf-8')).hexdigest()!=receipt['content_hash']:raise AnalyticsUnavailable('RAS event checksum differs')
            size+=len(text.encode('utf-8'))
            if size>MAX_PAGE_BYTES:raise AnalyticsTooLarge('RAS page exceeds 8MiB; narrow the Trace selection')
            events.append(json.loads(text))
        with self.control.read_transaction() as con:
            if self._ras_snapshot(con,workspace,sources)!=snapshot:raise Conflict('RAS event changed during analytics query')
        return events,snapshot

    def ras_ingest(self,token,workspace,events):
        identifier(workspace)
        if not isinstance(events,list) or not 1<=len(events)<=400:raise ValueError('RAS batch must contain 1..400 events')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'write')
            prepared=[];keys=set()
            for event in events:
                if not isinstance(event,dict) or set(event)-{'id','type','taskId','deliveryId','rasSessionKey','framework','platform','anomalyKind','severity','summary','actionTypes','payloadJson','ts'}:raise ValueError('Unknown RAS event fields')
                for key in ('id','taskId','type'):identifier(event.get(key))
                event_key=event.get('deliveryId') or event['id'];identifier(event_key)
                identity=(workspace,scope.principal_id,event['taskId'],event_key)
                if identity in keys:raise ValueError('Duplicate RAS event identity in one batch')
                keys.add(identity)
                old=con.execute('SELECT * FROM ras_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND task_id=? AND event_key=?',identity).fetchone()
                value=dict(event)
                if old:value['id']=old['event_id']
                try:
                    parsed=datetime.datetime.fromisoformat(value['ts'].replace('Z','+00:00'))
                    if parsed.tzinfo is None:raise ValueError()
                    stamp=int(parsed.timestamp()*1000)
                    if not 0<=stamp<=2**63-1:raise ValueError()
                    value['ts']=parsed.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                    text=_json(value)
                except (ValueError,TypeError,KeyError,OverflowError):raise ValueError('Invalid RAS timestamp or JSON') from None
                if len(text.encode('utf-8'))>262144:raise AnalyticsTooLarge('RAS event exceeds 256KiB')
                digest=hashlib.sha256(text.encode('utf-8')).hexdigest()
                prepared.append({'identity':identity,'old':dict(old) if old else None,'value':value,'text':text,'hash':digest,'stamp':stamp})
        for row in prepared:
            value=row['value'];bucket=datetime.datetime.fromtimestamp(row['stamp']/1000,datetime.timezone.utc).date().isoformat()
            self.facts.write_ras_event({'workspace_id':workspace,'event_bucket':bucket,'owner_principal_id':scope.principal_id,'task_id':value['taskId'],'event_key':row['identity'][-1],
                'event_id':value['id'],'content_hash':row['hash'],'event_json':row['text'],'retry_version':1})
        with self.control.transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,workspace,'write')
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Authorization changed during RAS ingestion')
            for row in prepared:
                old=con.execute('SELECT * FROM ras_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND task_id=? AND event_key=?',row['identity']).fetchone()
                if old and old['content_hash']==row['hash']:continue
                if (dict(old) if old else None)!=row['old']:raise Conflict('Concurrent RAS update; retry with the same normalized event')
                if old:con.execute('UPDATE ras_event_receipts SET content_hash=?,revision=revision+1,occurred_at_ms=? WHERE workspace_id=? AND owner_principal_id=? AND task_id=? AND event_key=?',(row['hash'],row['stamp'],*row['identity']))
                else:con.execute('INSERT INTO ras_event_receipts VALUES(?,?,?,?,?,?,?,?,?)',(*row['identity'],row['value']['id'],row['hash'],1,row['stamp'],self.control.clock()))
        return {'accepted':len(prepared),'ids':[row['value']['id'] for row in prepared]}

    def validate(self,token,workspace,items):
        if not isinstance(items,list) or len(items)>200:raise ValueError('Analytics validation requires at most 200 sources')
        boundaries={}
        for item in items:
            if not isinstance(item,dict) or set(item)!={'trace_id','boundary'}:raise ValueError('Invalid analytics source boundary')
            trace=identifier(item['trace_id']);boundary=_digest(item['boundary'])
            if trace in boundaries and boundaries[trace]!=boundary:raise Conflict('Conflicting source versions')
            boundaries[trace]=boundary
        scope=self.iam.scope(token);self._recheck(token,workspace,scope,boundaries)
        return {'scope_fingerprint':scope.fingerprint}

    def agent_metadata(self,token,workspace,items):
        from .dataset_generation_sources import GenerationSources
        from .compatibility import LegacyTraceReads
        from .observations import _legacy_value
        if not isinstance(items,list) or not 1<=len(items)<=200:raise ValueError('Agent metadata requires 1..200 sources')
        boundaries={}
        for item in items:
            if not isinstance(item,dict) or set(item)!={'trace_id','boundary','registrations'} or type(item['registrations']) is not bool:raise ValueError('Invalid Agent metadata selection')
            trace=identifier(item['trace_id']);boundary=_digest(item['boundary'])
            if trace in boundaries:raise ValueError('Duplicate Agent metadata source')
            boundaries[trace]=boundary
        scope=self.iam.scope(token);self._recheck(token,workspace,scope,boundaries)
        reader=GenerationSources(self.queries,self.authorized);result=[];source_bytes=0
        for item in items:
            trace=item['trace_id'];begin,summary,rows,heads,_=reader._boundary(token,workspace,trace)
            execution,session,capsule,identity=reader._metadata(begin,summary,rows,heads)
            agent_id=execution.get('agentId') if capsule else None
            if not capsule:
                values=[]
                for span in rows:
                    if span.get('parent_span_id'):continue
                    fields=TraceEvidence._fields(reader._source(span,heads[span['span_id']]))
                    if 'agentId' in fields:values.append(fields['agentId'])
                if len({_json(value) for value in values})>1:raise AnalyticsUnavailable('Root Agent registration identity is ambiguous')
                if values:agent_id=values[0]
            if agent_id is not None and not isinstance(agent_id,str):raise AnalyticsUnavailable('Agent registration identity is invalid')
            row={'trace_id':trace,'boundary':item['boundary'],'executionId':begin['aliases']['execution_id'],'taskId':begin['aliases']['task_id'],
                 'user':begin['owner']['normalized_login_name'],'agentId':agent_id,'agentName':identity['agentName'],'framework':identity['framework'],
                 'timestamp':execution.get('timestamp') or datetime.datetime.fromtimestamp(int(summary['started_at_ms'])/1000,datetime.timezone.utc).isoformat()}
            if item['registrations']:
                interactions=[]
                if capsule and capsule['primary']=='langfuse_node':
                    interactions=session.get('interactions',[]) if session else []
                    if not isinstance(interactions,list):raise AnalyticsUnavailable('Original Agent registrations are invalid')
                elif capsule and capsule['primary']=='carrier':pass
                else:
                    original=[]
                    for index,span in enumerate(rows):
                        source=reader._source(span,heads[span['span_id']]);source_bytes+=len(_json(source).encode('utf-8'))
                        if source_bytes>128*1024*1024:raise AnalyticsTooLarge('Agent metadata sources exceed byte budget')
                        text=source['sections'].get('legacy_interaction')
                        if capsule:
                            if text is None:raise AnalyticsUnavailable('Original Agent registration source is missing')
                            raw=json.loads(text)
                            if begin['route']['source_namespace']=='agent.record.v1':
                                attrs=json.loads(source['sections']['attributes']);attrs=attrs.get('span',{})
                                if attrs.get('legacy.transfer_kind')=='carrier':continue
                                if raw.get('format')!='agent-insight.trace-item' or raw.get('version')!=1 or raw.get('kind')!='interaction' or not isinstance(raw.get('value'),dict):raise AnalyticsUnavailable('Recorded Agent registration source differs')
                                projected=LegacyTraceReads(self.queries,self.authorized)._metadata(span,len(original),summary)
                                original.append((len(original),{**projected,**raw['value']}))
                            else:
                                if raw.get('format')!='agent-insight.trace-item' or raw.get('version')!=1 or raw.get('kind')!='interaction' or type(raw.get('index')) is not int:raise AnalyticsUnavailable('Original Agent registration source differs')
                                original.append((raw['index'],raw.get('value')))
                        else:
                            projected=LegacyTraceReads(self.queries,self.authorized)._metadata(span,index,summary)
                            attrs=json.loads(source['sections']['attributes']);resource=attrs.get('resource',{});attrs=attrs.get('span',{})
                            raw=_legacy_value(json.loads(text)) if text else {}
                            if not text:
                                for key in ('agent_insight.raw_interaction','agent_insight.interaction','legacy.interaction'):
                                    candidate=attrs.get(key)
                                    if isinstance(candidate,str):
                                        try:candidate=json.loads(candidate)
                                        except ValueError:candidate={}
                                    if isinstance(candidate,dict) and candidate:raw=candidate;break
                            if not isinstance(raw,dict):raw={'role':'trace'}
                            projected.update(raw)
                            if not text:
                                agent=resource.get('agent.name') or resource.get('service.name')
                                if agent and 'agent' not in raw:projected['agent']=agent
                                if span['kind']!='tool' and isinstance(attrs.get('legacy.role'),str) and 'role' not in raw:projected['role']=attrs['legacy.role']
                            interactions.append(projected)
                    if capsule:
                        original.sort(key=lambda pair:pair[0])
                        if len(original)!=capsule['primary_count'] or [index for index,_ in original]!=list(range(len(original))):raise AnalyticsUnavailable('Original Agent registration set is incomplete')
                        interactions=[raw for _,raw in original]
                row['interactions']=[{key:raw[key] for key in ('role','agent','subagent_name') if isinstance(raw.get(key),str)} if isinstance(raw,dict) else {} for raw in interactions]
            reader._verify_end(token,workspace,None,None,begin,trace)
            result.append(row)
            if len(_json(result).encode('utf-8'))>MAX_PAGE_BYTES:raise AnalyticsTooLarge('Agent metadata page exceeds 8MiB')
        self._recheck(token,workspace,scope,boundaries)
        return {'items':result,'scope_fingerprint':scope.fingerprint}

    def prepare_sources(self,token,workspace,experiment,run):
        from .experiments import ExperimentStore
        identifier(experiment);identifier(run)
        store=ExperimentStore(self.control)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);head=store._head(con,token,workspace,experiment)
            store._source_assets(con,scope,workspace,experiment,run)
            row,plan=store._plan(con,workspace,experiment,run)
            for source in store._source_routes(plan):store._source_route(con,scope,workspace,source)
        with self.control.transaction() as con:
            current=self.iam._scope(con,token);now=store._head(con,token,workspace,experiment)
            if current.fingerprint!=scope.fingerprint or now['lifecycle_revision']!=head['lifecycle_revision']:raise Conflict('Experiment source indexing scope changed')
            store._source_assets(con,current,workspace,experiment,run)
            current_run=con.execute('SELECT plan_hash FROM runs WHERE workspace_id=? AND run_id=?',(workspace,run)).fetchone()
            if current_run is None or current_run['plan_hash']!=row['plan_hash']:raise Conflict('Frozen RunPlan changed during source indexing')
            for source in store._source_routes(plan):store._source_route(con,current,workspace,source)
            store._index_trace_sources(con,workspace,run,plan,row['plan_hash'])
        return {'indexed':len(plan.get('frozen_trace_evidence',{}))}

    def _enrichment_snapshot(self,con,token,workspace,traces):
        from .experiments import ExperimentStore
        store=ExperimentStore(self.control);scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'read')
        boundaries={trace:self._boundary(con,token,workspace,trace,scope)[0] for trace in traces}
        selected=[];pending={};issues=[];diagnoses=[];heads={}
        for trace in traces:
            rows=con.execute("SELECT s.*,r.result_id AS machine_id,r.content_hash AS machine_hash,r.artifact_ref AS machine_ref,r.state AS machine_state,r.created_at_ms AS machine_created_at,c.revision AS case_revision,c.trace_id,c.state AS case_state,c.payload_hash AS case_hash,c.payload_ref AS case_ref,e.created_by AS experiment_owner,e.scope AS experiment_scope FROM experiment_result_slots s JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id JOIN experiment_heads e ON e.workspace_id=s.workspace_id AND e.experiment_id=s.experiment_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE c.workspace_id=? AND c.trace_id=? AND c.state='active' AND e.state='active' AND s.status='done' AND r.state<>'quarantined' ORDER BY r.created_at_ms DESC,s.result_id LIMIT 10001",(workspace,trace)).fetchall()
            if len(rows)>10000 or len(selected)+len(rows)>10000:raise AnalyticsTooLarge('Quality result selection exceeds 10000')
            for raw in rows:
                row=dict(raw);exp=row['experiment_id'];run=row['run_id']
                try:head=store._head(con,token,workspace,exp)
                except Forbidden:continue
                store._source_assets(con,scope,workspace,exp,run)
                heads[exp]=(head['revision'],head['lifecycle_revision'],head['metadata_hash'])
                source=con.execute('SELECT * FROM experiment_trace_sources WHERE workspace_id=? AND run_id=? AND case_id=?',(workspace,run,row['case_id'])).fetchone()
                if source is None:
                    pending[(exp,run)]={'experiment_id':exp,'run_id':run};continue
                source=dict(source);plan=con.execute('SELECT plan_hash FROM runs WHERE workspace_id=? AND run_id=?',(workspace,run)).fetchone()
                if source['trace_id']!=trace or plan is None or source['plan_hash']!=plan['plan_hash']:raise Conflict('Quality source index differs from selected RunPlan')
                store._source_route(con,scope,workspace,source)
                if row['evaluator_id']=='__trace_flow_attribution__':
                    match=con.execute("SELECT s.*,r.result_id AS machine_id,r.content_hash AS machine_hash,r.state AS machine_state FROM experiment_result_slots s LEFT JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE s.workspace_id=? AND s.experiment_id=? AND s.case_id=? AND s.evaluator_id='__trace_flow_match__'",(workspace,exp,row['case_id'])).fetchone()
                    row['current_match']=dict(match) if match else None
                row['source']=source;selected.append(row)
                found=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND result_id=? AND machine_result_id=? AND kind='derived-issue' ORDER BY annotation_id LIMIT 10001",(workspace,row['result_id'],row['machine_id'])).fetchall()
                for item in found:
                    issue=dict(item)|{'execution_id':source['execution_id'],'experiment_owner':row['experiment_owner']}
                    resolution=con.execute('SELECT * FROM experiment_derived_issue_annotations WHERE workspace_id=? AND issue_id=?',(workspace,item['annotation_id'])).fetchone()
                    issue['resolution']=dict(resolution) if resolution else None;issues.append(issue)
                if len(issues)>10000:raise AnalyticsTooLarge('Quality issue selection exceeds 10000')
            report=con.execute("SELECT r.* FROM diagnostic_report_heads h JOIN diagnostic_report_runs r ON r.workspace_id=h.workspace_id AND r.report_id=h.report_id WHERE h.workspace_id=? AND h.trace_id=? AND h.kind='agent-debug'",(workspace,trace)).fetchone()
            if report:diagnoses.append(dict(report))
        return {'scope':scope.fingerprint,'principal':scope.principal_id,'boundaries':boundaries,'heads':heads,'selected':selected,'issues':issues,'diagnoses':diagnoses,'pending_sources':list(pending.values())}

    @staticmethod
    def _result_evidence(result):
        evidence=result.get('evidence')
        if evidence is None and isinstance(result.get('evidenceJson'),str):
            try:evidence=json.loads(result['evidenceJson'])
            except ValueError:raise AnalyticsUnavailable('Selected quality evidence JSON is invalid') from None
        evidence=evidence or {}
        return evidence.get('json') or evidence if isinstance(evidence,dict) else {}

    @staticmethod
    def _alignment_current(row,result):
        match=row.get('current_match');packet=TraceAnalytics._result_evidence(result)
        value=packet.get('coreAlignmentAttribution') if isinstance(packet,dict) else None
        if not isinstance(match,dict) or match['status']!='done' or not match['machine_id'] or match['machine_state']=='quarantined' or not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1:return False
        expected={'machine_result_id':match['machine_id'],'content_hash':match['machine_hash'],'run_id':match['run_id']}
        return value.get('match_source')==expected

    @staticmethod
    def _trajectory(row,result):
        packet=TraceAnalytics._result_evidence(result)
        machine=packet.get('directTrajectory') if isinstance(packet,dict) else None
        if row['evaluator_id']=='__trace_flow_attribution__':
            machine=(packet.get('coreAlignmentAttribution') or {}).get('data') if isinstance(packet,dict) else None
        if isinstance(machine,dict):
            return {'executionId':row['source']['execution_id'],'trajectoryScore':machine.get('trajectoryScore'),'dimensionScoresJson':machine.get('dimensionScoresJson')}
        if row['evaluator_id']!='preset-agent-trace-quality':return None
        points=result.get('points')
        if points is None and isinstance(result.get('pointsJson'),str):
            try:points=json.loads(result['pointsJson'])
            except ValueError:raise AnalyticsUnavailable('Selected quality points JSON is invalid') from None
        points=points or []
        if not isinstance(points,list):return None
        dims={}
        for label,key in [('完整性','completeness'),('工具选择','toolChoice'),('冗余度','redundancy')]:
            point=next((item for item in points if isinstance(item,dict) and item.get('label')==label),None)
            if point is not None and type(point.get('score')) in (int,float):dims[key]=point['score']/100
        score=result.get('score')
        return {'executionId':row['source']['execution_id'],'trajectoryScore':score/100 if type(score) in (int,float) else None,'dimensionScoresJson':_json(dims) if dims else None}

    def enrich(self,token,workspace,traces):
        if not isinstance(traces,list) or len(traces)>200 or len(set(traces))!=len(traces):raise ValueError('Quality enrichment requires at most 200 distinct traces')
        for trace in traces:identifier(trace)
        from .experiments import ExperimentStore
        from .trace_reports import TraceReports,MAX_REPORT_BYTES
        store=ExperimentStore(self.control);reports=TraceReports(self.queries,self.authorized)
        with self.control.read_transaction() as con:before=self._enrichment_snapshot(con,token,workspace,traces)
        trajectories=[];issues=[];diagnoses=[];stale_alignments=set()
        for row in before['selected']:
            if row['experiment_owner']!=before['principal']:continue
            if row['evaluator_id'] not in {'__direct_trajectory__','__direct_trajectory__:preset-agent-trace-quality','preset-agent-trace-quality','__trace_flow_attribution__'}:continue
            packet=store._load(row['machine_hash'],row['machine_ref'])
            if row['evaluator_id']=='__trace_flow_attribution__' and not self._alignment_current(row,packet['result']):
                stale_alignments.add(row['machine_id']);continue
            trajectory=self._trajectory(row,packet['result'])
            if trajectory:
                trajectory['updatedAt']=datetime.datetime.fromtimestamp(row['updated_at_ms']/1000,datetime.timezone.utc).isoformat().replace('+00:00','Z')
                trajectories.append(trajectory)
        for row in before['issues']:
            if row['experiment_owner']!=before['principal']:continue
            if row['machine_result_id'] in stale_alignments:continue
            with self.control.read_transaction() as con:dto=store._derived_dto(row,con)
            if dto.get('resolvedAt') is not None:continue
            issues.append({'dedupKey':dto.get('dedupKey') or dto.get('ruleId') or dto.get('id') or row['annotation_id'],'severity':dto.get('severity') or 'medium',
                'summary':dto.get('summary') or '', 'suggestedFix':dto.get('suggestedFix'), 'category':dto.get('category'),
                'version':dto.get('version'),'skillId':dto.get('skillId') or row['lookup_key'],'skillName':dto.get('skillName') if isinstance(dto.get('skillName'),str) else None,'executionId':row['execution_id']})
        for row in before['diagnoses']:
            if row['status']!='done':continue
            payload=reports._load(row['payload_ref'],MAX_REPORT_BYTES,row['payload_hash'])
            if not isinstance(payload,dict):raise AnalyticsUnavailable('Current diagnosis report is invalid')
            diagnoses.append({'executionId':row['execution_id'],'report':{key:payload[key] for key in ('rootCause','triage') if key in payload}})
        with self.control.read_transaction() as con:
            after=self._enrichment_snapshot(con,token,workspace,traces)
            if after!=before:raise Conflict('Quality source selection changed during enrichment')
        trajectories.sort(key=lambda row:row['updatedAt'],reverse=True)
        read_token=self.queries._encode({'purpose':'analytics-enrichment/v1','workspace_id':workspace,'scope':before['scope'],'trace_ids':traces,'snapshot_hash':_hash(before)})
        result={'trajectories':trajectories,'issues':issues,'diagnoses':diagnoses,'pending_sources':before['pending_sources'],'scope_fingerprint':before['scope'],'read_token':read_token}
        if len(_json(result).encode('utf-8'))>MAX_PAGE_BYTES:raise AnalyticsTooLarge('Quality enrichment exceeds 8MiB; request fewer traces')
        return result

    def _read_snapshot_token(self,read_token,workspace,scope,purpose):
        try:
            if not isinstance(read_token,str) or not 1<=len(read_token)<=256*1024:raise ValueError()
            raw=base64.b64decode(read_token+'='*(-len(read_token)%4),altchars=b'-_',validate=True)
            if base64.urlsafe_b64encode(raw).decode().rstrip('=')!=read_token:raise ValueError()
            body,signature=raw[:-32],raw[-32:]
            if len(signature)!=32 or not hmac.compare_digest(signature,hmac.new(self.queries.secret,body,hashlib.sha256).digest()):raise ValueError()
            value=json.loads(body)
            if not isinstance(value,dict) or set(value)!={'purpose','workspace_id','scope','trace_ids','snapshot_hash'} or value['purpose']!=purpose or value['workspace_id']!=workspace or value['scope']!=scope.fingerprint:raise ValueError()
            traces=value['trace_ids'];_digest(value['snapshot_hash'])
            if not isinstance(traces,list) or len(traces)>200 or len(set(traces))!=len(traces):raise ValueError()
            for trace in traces:identifier(trace)
            return value
        except (ValueError,TypeError,KeyError,UnicodeError):raise Conflict('Invalid or expired analytics read token') from None

    def validate_enrichment(self,token,workspace,read_tokens):
        if not isinstance(read_tokens,list) or not 1<=len(read_tokens)<=200:raise ValueError('Enrichment validation requires 1..200 read tokens')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'read')
            for read_token in read_tokens:
                value=self._read_snapshot_token(read_token,workspace,scope,'analytics-enrichment/v1')
                if _hash(self._enrichment_snapshot(con,token,workspace,value['trace_ids']))!=value['snapshot_hash']:raise Conflict('Quality source selection changed across analytics pages')
        return {'scope_fingerprint':scope.fingerprint}

    def validate_ras(self,token,workspace,read_tokens):
        if not isinstance(read_tokens,list) or not 1<=len(read_tokens)<=200:raise ValueError('RAS validation requires 1..200 read tokens')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'read')
            for read_token in read_tokens:
                value=self._read_snapshot_token(read_token,workspace,scope,'analytics-ras/v1')
                sources={trace:self._boundary(con,token,workspace,trace,scope)[1] for trace in value['trace_ids']}
                if _hash(self._ras_snapshot(con,workspace,sources))!=value['snapshot_hash']:raise Conflict('RAS events changed across analytics pages')
        return {'scope_fingerprint':scope.fingerprint}

    def dispatch(self,action,token,workspace,value):
        if action=='read':return self.read(token,workspace,limit=value.get('limit',200),cursor=value.get('cursor'),selection=value.get('selection'))
        if action=='prepare':return self.prepare(token,workspace,value.get('trace_id'))
        if action=='publish':return self.publish(token,workspace,value.get('trace_id'),value.get('boundary'),value.get('projection'))
        if action=='ras_ingest':return self.ras_ingest(token,workspace,value.get('events'))
        if action=='validate':return self.validate(token,workspace,value.get('items'))
        if action=='agent_metadata':return self.agent_metadata(token,workspace,value.get('items'))
        if action=='enrich':return self.enrich(token,workspace,value.get('trace_ids'))
        if action=='prepare_sources':return self.prepare_sources(token,workspace,value.get('experiment_id'),value.get('run_id'))
        if action=='validate_enrichment':return self.validate_enrichment(token,workspace,value.get('read_tokens'))
        if action=='validate_ras':return self.validate_ras(token,workspace,value.get('read_tokens'))
        raise ValueError('Unsupported analytics action')
