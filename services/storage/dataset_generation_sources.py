"""Authorized generation-only projection: tool bodies never enter the JS sampling worker."""
import copy
import datetime
import hashlib
import json
import os
import stat
from pathlib import Path

from .control import Conflict
from .iam import Forbidden
from .trace_evidence import TraceEvidence, EvidenceUnavailable, EvidenceTooLarge, _hash, _size, _same
from .observations import _legacy_value, _payload_revision, _section_text, summary_status

MAX_SOURCE_BYTES=64*1024*1024
MAX_EVENT_BYTES=16*1024*1024
MAX_CATALOG_TRACES=10000


def platform(value):
    raw=(value or '').strip().lower() or 'otlp'
    aliases={'jiuwen':'jiuwenswarm','openjiuwen':'jiuwenswarm','claudecode':'claude','claude-code':'claude','dsh':'deepseek-harness','qwen-code':'qwencode','qwen_code':'qwencode','llama-index':'llamaindex'}
    for alias in ('qoder-cli','qoder-cn','qoder-desktop','qoder-jetbrains','qoder-work'):aliases[alias]='qoder'
    for alias in ('trae-cn','trae-ide','trae-ai'):aliases[alias]='trae'
    for alias in ('openclaw-gateway','openclaw-agent'):aliases[alias]='openclaw'
    return aliases.get(raw,raw)


def agent_key(row):
    if row.get('agentId'):return 'registered:'+row['agentId']
    identity=[platform(row['framework']),row.get('agentName') or '',row.get('clientId') or '']
    return 'legacy:'+hashlib.sha256(json.dumps(identity,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def _time_ms(value):
    return int(datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)


def _iso(value):
    if value is None:return ''
    if isinstance(value,str) and not value.isdigit():return value
    return datetime.datetime.fromtimestamp(int(value)/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def _fingerprint(begin):
    value={key:copy.deepcopy(item) for key,item in begin.items() if key!='heads'}
    value['heads']=[{key:item[key] for key in ('entity_kind','entity_id','revision','source_revision','content_hash')} for item in begin['heads']]
    return _hash(value)


def _execution_failed(value):
    if isinstance(value,str):
        try:value=json.loads(value)
        except ValueError:raise EvidenceUnavailable('Invalid source failures') from None
    return isinstance(value,list) and any(isinstance(item,dict) and item.get('failure_type') in ('opencode-session-error','goal_plus_pi_session_failed','agent-process-exit') for item in value)


def _event(raw,row):
    role=raw.get('role') or ('tool' if row['kind']=='tool' else 'assistant' if row['kind']=='llm' else 'trace')
    content=raw.get('content');nontext=False
    if isinstance(content,list):
        nontext=any(not isinstance(v,dict) or v.get('type') not in ('text','input_text','output_text') for v in content)
        content=''.join(v.get('text','') for v in content if isinstance(v,dict) and v.get('type') in ('text','input_text','output_text') and isinstance(v.get('text'),str))
    if role not in ('user','assistant'):content=''
    calls=raw.get('tool_calls') if isinstance(raw.get('tool_calls'),list) else []
    names=[]
    for call in calls:
        if not isinstance(call,dict):continue
        function=call.get('function') if isinstance(call.get('function'),dict) else {}
        name=function.get('name') or call.get('name')
        if isinstance(name,str) and name:names.append(name)
    timing=raw.get('timeInfo') if isinstance(raw.get('timeInfo'),dict) else {}
    return {'role':role,'content':content if isinstance(content,str) else '', 'channel':raw.get('channel',raw.get('type','')),
            'toolNames':names,'timestamp':_iso(raw.get('timestamp',timing.get('created',row['started_at_ms']))),
            'completedAt':_iso(timing.get('completed',row['ended_at_ms'])),'finishReason':raw.get('finish_reason',raw.get('stop_reason',raw.get('finish',''))),
            'nonText':nontext,'subagent':bool(raw.get('subagent_session_id')),'spanId':row['span_id'],'traceId':row['trace_id'],
            'truncated':bool(raw.get('_payloadDeferred') or raw.get('truncated')),'failed':row['execution_status']=='failed' or raw.get('status') in ('failed','error'),
            'retry':bool(raw.get('retry')),'delegated':bool(raw.get('delegated'))}


def _native_pair(row,sections):
    text=sections.get('input');messages=None
    if text is not None:
        try:messages=json.loads(text)
        except ValueError:messages=text
        if isinstance(messages,dict) and 'messages' in messages:messages=messages['messages']
        if isinstance(messages,dict) and 'role' in messages:messages=[messages]
    request=[]
    if isinstance(messages,str):request=[{'role':'user','content':messages}]
    elif isinstance(messages,list):
        users=[item for item in messages if isinstance(item,dict) and item.get('role')=='user']
        # History is not a declaration that the current request is independently executable.
        if len(users)==1 and all(isinstance(item,dict) and item.get('role') in ('system','user') for item in messages):request=users
    projected=[]
    for raw in request:
        event=_event(raw,row);event['timestamp']=_iso(row['started_at_ms']);event['completedAt']=event['timestamp']
        event['origin']={'kind':'otlp-declared-input','span_id':row['span_id'],'section':'input','section_sha256':hashlib.sha256(text.encode('utf-8')).hexdigest()}
        projected.append(event)
    output,_=_section_text(sections.get('output'),'assistant')
    attrs=json.loads(sections['attributes']).get('span',{})
    raw={'role':'assistant','content':output or ''}
    reasons=attrs.get('gen_ai.response.finish_reasons',attrs.get('gen_ai.response.finish_reason'))
    if isinstance(reasons,list) and len(reasons)==1:reasons=reasons[0]
    if isinstance(reasons,str):raw['finish_reason']=reasons
    reply=_event(raw,row);reply['timestamp']=_iso(row['ended_at_ms'])
    reply['origin']={'kind':'otlp-declared-output','span_id':row['span_id'],'section':'output','section_sha256':hashlib.sha256((sections.get('output') or '').encode('utf-8')).hexdigest()}
    return {'row':row,'request':projected,'reply':reply}


class GenerationSources(TraceEvidence):
    def __init__(self,*args,source_budget=None,**kwargs):
        super().__init__(*args,**kwargs)
        self.source_budget=source_budget

    def _artifact(self,head):
        self._deadline();target=Path(head['artifact_ref']);directory=self.control.artifact_directory
        if target.parent!=directory or directory.is_symlink() or len(target.name)!=64:raise EvidenceUnavailable('Invalid generation source artifact')
        try:
            fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as stream:
                info=os.fstat(stream.fileno());limit=MAX_SOURCE_BYTES*6+4096
                if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise EvidenceTooLarge('Generation source artifact exceeds kernel budget')
                digest=hashlib.sha256();parts=[];size=0
                while True:
                    self._deadline();block=stream.read(65536)
                    if not block:break
                    size+=len(block)
                    if self.source_budget is not None:
                        self.source_budget['remaining']-=len(block)
                        if self.source_budget['remaining']<0:raise EvidenceTooLarge('Execution metadata sources exceed cumulative byte budget')
                    if size>limit:raise EvidenceTooLarge('Generation source artifact exceeds kernel budget')
                    digest.update(block);parts.append(block)
            if digest.hexdigest()!=target.name:raise EvidenceUnavailable('Generation artifact checksum differs')
            wrapper=json.loads(b''.join(parts));text=wrapper['json']
            if wrapper['encoding']!='observation-json/v1' or not isinstance(text,str):raise ValueError()
            if len(text.encode('utf-8'))>MAX_SOURCE_BYTES:raise EvidenceTooLarge('Generation source expands beyond kernel budget')
            value=json.loads(text)
            if _hash(value)!=head['content_hash']:raise EvidenceUnavailable('Generation source checksum differs')
            return value
        except (OSError,KeyError,ValueError,TypeError,UnicodeError):raise EvidenceUnavailable('Generation source unavailable') from None

    def _boundary(self,token,ws,trace):
        self.deadline=__import__('time').monotonic()+60
        begin=self._capture(token,ws,None,None,trace)
        from .collector_sources import active_heads, order_rows
        heads={head['entity_id']:head for head in active_heads(self.control,begin,self._artifact)}
        tracehead=next((head for head in begin['heads'] if head['entity_kind']=='trace'),None)
        summary=self.queries.summary(token,ws,trace).get('trace')
        if not tracehead or not summary or not _same(summary.get('revision'),tracehead['revision']):raise EvidenceUnavailable('Generation source summary is not indexed')
        state=self._artifact(tracehead)
        for key in ('span_count','started_at_ms','ended_at_ms','framework','agent_name'):
            if not _same(summary.get(key),state.get(key)):raise EvidenceUnavailable('Generation source summary differs')
        expected_status=summary_status(state)
        if summary.get('execution_status')!=expected_status:raise EvidenceUnavailable('Generation source lifecycle differs')
        rows=[];after='';size=0
        while True:
            page=self.authorized.read_spans(token,ws,begin['route']['trace_bucket'],trace,after_span_id=after,limit=200)
            if not isinstance(page,list) or len(page)>200:raise EvidenceUnavailable('Invalid generation Span page')
            for row in page:
                sid=row.get('span_id');head=heads.get(sid)
                if not isinstance(sid,str) or sid<=after or not head or not _same(row.get('revision'),head['revision']):raise EvidenceUnavailable('Generation Span vector is not indexed')
                if row.get('workspace_id')!=ws or row.get('trace_id')!=trace or row.get('trace_bucket')!=begin['route']['trace_bucket'] or row.get('is_deleted') not in (0,'0'):raise EvidenceUnavailable('Generation Span escaped scope')
                size+=_size(row,MAX_EVENT_BYTES)
                if size>MAX_EVENT_BYTES:raise EvidenceTooLarge('Generation Span vector exceeds budget')
                after=sid;rows.append(row)
            if len(page)<200:break
        if len(rows)!=len(heads):raise EvidenceUnavailable('Generation Span set incomplete')
        return begin,summary,order_rows(begin,rows),heads,state

    def _source(self,row,head):
        source=self._artifact(head)
        for key,value in source['row'].items():
            if key!='attributes_json' and not _same(row.get(key),value):raise EvidenceUnavailable('Generation Span differs from frozen source')
        if not _same(source['source_revision'],head['source_revision']) or _payload_revision(source['sections'])!=row['payload_revision']:raise EvidenceUnavailable('Generation section hashes differ')
        return source

    def _metadata(self,begin,summary,rows,heads):
        execution={};session=None;fields={};capsule=None
        ordered=sorted(rows,key=lambda row:(0 if json.loads(row['attributes_json']).get('legacy.transfer_kind')=='carrier' and row['kind']=='trace' else 1 if not row.get('parent_span_id') else 2,row['span_id']))
        for row in ordered:
            source=self._source(row,heads[row['span_id']]);sections=source['sections']
            attributes=json.loads(sections['attributes']);attrs={**attributes.get('resource',{}),**attributes.get('span',{})}
            if not fields:fields=attrs
            if 'legacy_trace' in sections:
                capsule=json.loads(sections['legacy_trace']);execution=capsule.get('execution',{});session=capsule.get('session');break
            # Ordinary OTLP root attributes are the authoritative identity metadata.
            if not begin['route']['source_namespace'].startswith(('trace.bundle.','agent.record.','collector.source.v1')):break
        if not isinstance(execution,dict):raise EvidenceUnavailable('Invalid generation execution metadata')
        identity={'framework':execution.get('framework') or summary.get('framework') or '',
                  'agentId':execution.get('agentId') or fields.get('agent.id') or None,
                  'agentName':execution.get('agentName') or summary.get('agent_name') or '',
                  'clientId':execution.get('clientId') or fields.get('client.id') or None}
        return execution,session,capsule,identity

    def describe(self,token,ws,trace):
        begin,summary,rows,heads,state=self._boundary(token,ws,trace)
        execution,session,capsule,identity=self._metadata(begin,summary,rows,heads)
        stamp=_iso(_time_ms(execution.get('timestamp'))) if execution.get('timestamp') else _iso(summary['started_at_ms'])
        self._verify_end(token,ws,None,None,begin,trace)
        return {'id':trace,'fingerprint':_fingerprint(begin),'timestamp':stamp,'agentKey':agent_key(identity),'incarnation':str(begin['route']['incarnation']),'route_epoch':str(begin['route']['route_epoch']),**identity}

    def catalog_rows(self,token,ws):
        rows=[];cursor=None;scope=None
        while True:
            page=self.queries.list_traces(token,ws,limit=200,cursor=cursor)
            for item in page['items']:
                rows.append(self.describe(token,ws,item['trace_id']))
                if len(rows)>MAX_CATALOG_TRACES:raise EvidenceTooLarge('Generation catalog exceeds10000 Traces')
            cursor=page.get('next_cursor')
            if not cursor:
                with self.control.read_transaction() as con:
                    scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
                    for row in rows:
                        self.iam._authorize(con,token,ws,'read','trace',row['id'])
                        if not con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,row['id'])).fetchone():raise Conflict('Generation catalog changed')
                return rows

    def members(self,token,ws,config):
        rows=self.catalog_rows(token,ws)
        chosen=[row for row in rows if platform(row['framework'])==config['platform'] and config['from']<=row['timestamp']<config['to'] and row['agentKey']==config['agentKey']]
        return sorted(chosen,key=lambda row:(-int(datetime.datetime.fromisoformat(row['timestamp'].replace('Z','+00:00')).timestamp()*1000),row['id']))

    def read_source(self,token,ws,trace,fingerprint):
        begin,summary,rows,heads,state=self._boundary(token,ws,trace)
        if _fingerprint(begin)!=fingerprint:return {'reason':'SOURCE_CHANGED'}
        execution,session,capsule,identity=self._metadata(begin,summary,rows,heads)
        events=[];native=[];native_tools=[];sections_manifest={};size=0
        if capsule and capsule.get('primary')=='langfuse_node':
            if not isinstance(session,dict) or not isinstance(session.get('interactions'),list):raise EvidenceUnavailable('Original Langfuse interactions unavailable')
            sample=rows[0]
            for item in session['interactions']:
                if not isinstance(item,dict):raise EvidenceUnavailable('Invalid source interaction')
                event=_event(item,sample);size+=_size(event,MAX_EVENT_BYTES)
                if size>MAX_EVENT_BYTES:raise EvidenceTooLarge('Generation event text exceeds16MiB')
                events.append(event)
        else:
            for row in rows:
                source=self._source(row,heads[row['span_id']]);sections=source['sections']
                sections_manifest[row['span_id']]={name:hashlib.sha256(text.encode('utf-8')).hexdigest() for name,text in sections.items()}
                stored_attrs=json.loads(sections['attributes']);attrs={**stored_attrs.get('resource',{}),**stored_attrs.get('span',{})}
                if attrs.get('legacy.transfer_kind')=='carrier':continue
                raw=_legacy_value(json.loads(sections['legacy_interaction'])) if 'legacy_interaction' in sections else {}
                if not isinstance(raw,dict):raise EvidenceUnavailable('Invalid generation interaction')
                if not raw and row['kind']=='llm':
                    pair=_native_pair(row,sections);native.append(pair)
                    size+=_size(pair['request'],MAX_EVENT_BYTES)+_size(pair['reply'],MAX_EVENT_BYTES)
                    if size>MAX_EVENT_BYTES:raise EvidenceTooLarge('Generation event text exceeds16MiB')
                    continue
                if not raw:
                    raw={'role':attrs.get('legacy.role',attrs.get('role'))}
                    output,_=_section_text(sections.get('output'),'assistant')
                    if output is not None:raw['content']=output
                    if row['kind']=='tool':raw['tool_calls']=[{'function':{'name':row['tool_name']}}]
                event=_event(raw,row);size+=_size(event,MAX_EVENT_BYTES)
                if size>MAX_EVENT_BYTES:raise EvidenceTooLarge('Generation event text exceeds16MiB')
                if not capsule and row['kind']=='tool':native_tools.append((row,event))
                else:events.append(event)
        if native:
            parents={row['span_id']:row.get('parent_span_id') for row in rows};inferences={pair['row']['span_id'] for pair in native};linked={}
            for row,event in native_tools:
                parent=row.get('parent_span_id');visited=set()
                while parent and parent not in visited and parent not in inferences:visited.add(parent);parent=parents.get(parent)
                if parent in inferences:linked.setdefault(parent,[]).append(event)
            for pair in sorted(native,key=lambda value:(value['row']['started_at_ms'],value['row']['span_id'])):
                events.extend(pair['request'])
                events.extend(sorted(linked.get(pair['row']['span_id'],[])+[pair['reply']],key=lambda event:(event['timestamp'],event['spanId'])))
        else:events.extend(event for _,event in native_tools)
        annotation=begin['annotation'];overrides=json.loads(annotation['extra_json']).get('override_fields',[]) if annotation else []
        query=execution.get('query',session.get('query') if isinstance(session,dict) else '') or ''
        final=execution.get('finalResult') or ''
        if 'query' in overrides:query=annotation['query_override'] or ''
        if 'final_result' in overrides:final=annotation['final_result_override'] or ''
        source={'query':query,'finalResult':final,'completed':bool(session.get('endTime')) if isinstance(session,dict) else summary['execution_status']!='running',
                'failed':(_execution_failed(execution.get('failures')) or execution.get('status') in ('failed','error')) if capsule else summary['execution_status']=='failed','isSubagent':bool(execution.get('isSubagent')),'events':events,'platform':platform(identity['framework'])}
        result={'source':source,'revision':fingerprint,'section_hashes':sections_manifest}
        _size(result,MAX_EVENT_BYTES)
        self._verify_end(token,ws,None,None,begin,trace)
        return result
