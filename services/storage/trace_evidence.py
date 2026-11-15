"""Bounded optimistic Trace evidence reads across control metadata and immutable payloads."""
import copy
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from types import SimpleNamespace

from .compatibility import LegacyTraceReads, TraceNotFound
from .control import Conflict, StorageError
from .contracts import identifier
from .iam import Forbidden, Unauthorized
from .observations import _payload_revision, _section_text, _legacy_value, _source_projection

MAX_EVIDENCE_BYTES=16*1024*1024
MAX_SPANS=100000
MAX_READ_SECONDS=60


class EvidenceUnavailable(StorageError):
    status=503


class EvidenceTooLarge(StorageError):
    status=413


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _size(value,limit):
    size=0
    for part in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).iterencode(value):
        size+=len(part.encode('utf-8'))
        if size>limit:raise EvidenceTooLarge('Trace evidence exceeds bounded byte budget')
    return size


def _parse(value):
    return json.loads(value,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite evidence')))


def _same(value,expected):
    if expected is None:return value is None
    if type(expected) is int:
        return type(value) is not bool and str(value)==str(expected)
    return value==expected


class _FrozenReads(LegacyTraceReads):
    def __init__(self,owner,token,workspace,route,summary,rows,expected):
        self.owner=owner;self.expected=expected;self.rows=rows;self.used={};self.bytes=0
        super().__init__(SimpleNamespace(route=lambda *_:route,summary=lambda *_:{'trace':summary}),owner.authorized)

    def _spans(self,*_):
        yield from self.rows

    def _postflight(self,*_):
        self.owner._deadline()

    def _section(self,token,workspace,route,row,name):
        self.owner._deadline();after=-1;parts=[];count=0;total=None
        expected=self.expected[row['span_id']]['sections'].get(name)
        source=self.expected[row['span_id']].get('verified_source_sections')
        if source is not None:
            text=source.get(name)
            if text is None:
                if expected is not None:raise EvidenceUnavailable('Verified source section is missing')
                return None
            if hashlib.sha256(text.encode('utf-8')).hexdigest()!=expected:raise EvidenceUnavailable('Verified source section checksum differs')
            self.used.setdefault(row['span_id'],{})[name]=expected
            return text
        while True:
            page=self.authorized.read_payload(token,workspace,route['trace_bucket'],route['trace_id'],row['span_id'],row['payload_revision'],name,after_chunk=after,limit=4)
            self.owner._deadline();chunks=page.get('chunks')
            if not isinstance(chunks,list) or len(chunks)>4:raise EvidenceUnavailable('Invalid evidence chunks')
            if page.get('available') is False:
                if expected is not None or chunks or count or page.get('next_chunk') is not None:raise EvidenceUnavailable('Evidence section unavailable')
                return None
            current=page.get('chunk_count')
            if isinstance(current,str) and current.isdigit():current=int(current)
            if type(current) is not int or not 1<=current<=4096 or (total is not None and total!=current) or not chunks:raise EvidenceUnavailable('Incomplete evidence chunks')
            total=current
            for chunk in chunks:
                if str(chunk.get('chunk_no'))!=str(after+1) or not isinstance(chunk.get('body'),str):raise EvidenceUnavailable('Evidence chunks are not contiguous')
                body=chunk['body'];self.bytes+=len(body.encode('utf-8'))
                if self.bytes>self.owner.byte_budget:raise EvidenceTooLarge('Evidence payload exceeds bounded byte budget')
                parts.append(body);count+=1;after+=1
            cursor=page.get('next_chunk')
            if cursor is None:
                if count!=total:raise EvidenceUnavailable('Evidence section truncated')
                text=''.join(parts)
                if expected is None or hashlib.sha256(text.encode('utf-8')).hexdigest()!=expected:raise EvidenceUnavailable('Evidence section checksum differs')
                self.used.setdefault(row['span_id'],{})[name]=expected
                return text
            if count>=total or str(cursor)!=str(after):raise EvidenceUnavailable('Evidence cursor did not advance')


class TraceEvidence:
    unavailable=EvidenceUnavailable
    too_large=EvidenceTooLarge

    def __init__(self,queries,authorized,*,max_bytes=None,allow_missing_session=False,analytics_fields=False):
        if max_bytes is not None and (type(max_bytes) is not int or not 1<=max_bytes<=128*1024*1024):raise ValueError('Invalid evidence byte budget')
        self.max_bytes=max_bytes;self.allow_missing_session=allow_missing_session;self.analytics_fields=analytics_fields
        self.queries=queries;self.authorized=authorized;self.control=queries.control;self.iam=authorized.iam;self.deadline=time.monotonic()+MAX_READ_SECONDS

    @property
    def byte_budget(self):return MAX_EVIDENCE_BYTES if self.max_bytes is None else self.max_bytes

    def _deadline(self):
        if time.monotonic()>self.deadline:raise EvidenceUnavailable('Evidence read timed out')

    def _capture(self,token,workspace,task,execution,trace_ref=None):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'read')
            traces=[];requested=[]
            if trace_ref is not None:
                matches={row[0] for row in con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(workspace,trace_ref)).fetchall()}
                if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace_ref)).fetchone():matches.add(trace_ref)
                if len(matches)>1:raise Conflict('Ambiguous Trace reference')
                if not matches:raise TraceNotFound('Trace not found')
                trace=next(iter(matches));traces.append(trace);requested.append(['trace',trace_ref,trace])
            for kind,ref in [('task',task),('execution',execution)]:
                if ref is None:continue
                row=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(workspace,kind,ref)).fetchone()
                traces.append(row[0] if row else ref);requested.append([kind,ref,row[0] if row else None])
            if len(set(traces))!=1:raise ValueError('Trace aliases must select one Trace')
            trace=traces[0]
            route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
            if route is None:raise TraceNotFound('Trace not found')
            self.iam._authorize(con,token,workspace,'read','trace',trace)
            if route['state']!='active':raise Conflict('Trace route retired')
            aliases={}
            for kind,key in [('task','task_id'),('execution','execution_id')]:
                row=con.execute('SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind=? ORDER BY created_at_ms,alias_id LIMIT 1',(workspace,trace,kind)).fetchone()
                aliases[key]=row[0] if row else trace
            owner=con.execute("SELECT a.owner_principal_id,p.normalized_login_name FROM iam_resource_access a JOIN iam_principals p ON p.principal_id=a.owner_principal_id WHERE a.workspace_id=? AND a.resource_kind='trace' AND a.resource_id=?",(workspace,trace)).fetchone()
            if owner is None:raise Forbidden('Trace ownership unavailable')
            annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
            barriers=[dict(row) for row in con.execute("SELECT * FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(workspace,trace,route['incarnation']))]
            if barriers:raise Conflict('Trace deletion barrier exists')
            heads=[];size=0
            last_kind='';last_entity=''
            while True:
                self._deadline()
                page=con.execute('SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND (entity_kind>? OR (entity_kind=? AND entity_id>?)) ORDER BY entity_kind,entity_id LIMIT 200',(workspace,trace,last_kind,last_kind,last_entity)).fetchall()
                if not page:break
                for row in page:
                    item=dict(row);size+=_size(item,self.byte_budget)
                    if len(heads)>=MAX_SPANS+1 or size>self.byte_budget:raise EvidenceTooLarge('Trace head vector exceeds budget')
                    heads.append(item);last_kind=item['entity_kind'];last_entity=item['entity_id']
            result={'scope':scope.fingerprint,'route':dict(route),'requested':requested,'aliases':aliases,'owner':dict(owner),
                    'annotation':dict(annotation) if annotation else None,'barriers':barriers,'heads':heads}
            _size(result,self.byte_budget)
            return result

    def _verify_end(self,token,workspace,task,execution,begin,trace_ref=None):
        self._deadline()
        try:end=self._capture(token,workspace,task,execution,trace_ref)
        except (TraceNotFound,EvidenceTooLarge):raise Conflict('Trace identity changed while reading') from None
        if end['scope']!=begin['scope']:raise Forbidden('Authorization changed while reading evidence')
        if end!=begin:raise Conflict('Trace evidence boundary changed; retry')

    def _artifact(self,head):
        self._deadline();target=Path(head['artifact_ref']);directory=self.control.artifact_directory
        if target.parent!=directory or directory.is_symlink() or not re.fullmatch('[0-9a-f]{64}',target.name):raise EvidenceUnavailable('Invalid evidence artifact')
        limit=self.byte_budget*6+4096
        try:
            fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as source:
                info=os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode):raise EvidenceUnavailable('Invalid evidence artifact')
                if info.st_size>limit:raise EvidenceTooLarge('Evidence artifact exceeds byte budget')
                parts=[];size=0;hasher=hashlib.sha256()
                while True:
                    self._deadline();block=source.read(min(65536,limit+1-size))
                    if not block:break
                    size+=len(block)
                    if size>limit:raise EvidenceTooLarge('Evidence artifact exceeds byte budget')
                    hasher.update(block);parts.append(block)
            if hasher.hexdigest()!=target.name:raise EvidenceUnavailable('Evidence artifact checksum differs')
            wrapper=_parse(b''.join(parts))
            if not isinstance(wrapper,dict) or wrapper.get('encoding')!='observation-json/v1' or not isinstance(wrapper.get('json'),str):raise EvidenceUnavailable('Unsupported evidence artifact encoding')
            if len(wrapper['json'].encode('utf-8'))>self.byte_budget:raise EvidenceTooLarge('Evidence artifact expands beyond budget')
            value=_parse(wrapper['json'])
            if _hash(value)!=head['content_hash']:raise EvidenceUnavailable('Evidence source checksum differs')
            return value
        except (OSError,ValueError,TypeError,KeyError,UnicodeError,RecursionError):raise EvidenceUnavailable('Evidence artifact is unavailable') from None

    @staticmethod
    def _fields(source,*,analytics_fields=False):
        sections=source['sections'];full=_parse(sections['attributes']);attrs={**full.get('resource',{}),**full.get('span',{})}
        raw=_legacy_value(_parse(sections['legacy_interaction'])) if 'legacy_interaction' in sections else {}
        attrs={**raw,**attrs};fields={}
        for name in ('legacy.is_subagent','is_subagent','isSubagent'):
            if name in attrs:
                if type(attrs[name]) is not bool:raise EvidenceUnavailable('Invalid source subagent flag')
                fields['isSubagent']=attrs[name];break
        for dest,names in {'query':('legacy.session_query','legacy.query','query'),'label':('legacy.session_label','legacy.label','label'),'finalResult':('legacy.final_result','final_result'),'skill':('legacy.skill','skill'),'skillVersion':('legacy.skill_version','skill_version','skillVersion'),'executionSkills':('legacy.execution_skills','execution_skills','executionSkills'),'agentId':('agent.id','legacy.agent_id','agentId'),'clientId':('agent.insight.client_id','client.id','legacy.client_id','client_id','clientId'),'skillOrigins':('legacy.skill_origins','skill_origins','skillOrigins','skill.origins')}.items():
            for name in names:
                if name in attrs:fields[dest]=attrs[name];break
        if 'query' not in fields:
            value,_=_section_text(sections.get('input'),'user')
            if value is not None:fields['query']=value
        if 'finalResult' not in fields:
            if isinstance(raw.get('content'),str):fields['finalResult']=raw['content']
            else:
                value,_=_section_text(sections.get('output'),'assistant')
                if value is not None:fields['finalResult']=value
        if analytics_fields:
            aliases={'model':('legacy.model','model','gen_ai.response.model','gen_ai.request.model','llm.model_name'),
                'observedAgents':('legacy.agents','agents','observed_agents','observedAgents'),
                'invokedSkills':('legacy.invoked_skills','invoked_skills','invokedSkills'),
                'parentExecutionId':('legacy.parent_execution_id','parent_execution_id','parentExecutionId'),
                'rootExecutionId':('legacy.root_execution_id','root_execution_id','rootExecutionId'),
                'failures':('legacy.failures','failures'),'skillIssues':('legacy.skill_issues','skill_issues','skillIssues'),
                'callStats':('legacy.call_stats','call_stats','callStats'),
                'observedIp':('legacy.observed_ip','agent_insight.observed_ip','observed_ip','observedIp'),
                'hostIp':('legacy.host_ip','host_ip','hostIp'),'hostName':('legacy.host_name','host_name','hostName')}
            numeric={'cacheReadInputTokens':'cache_read_input_tokens','cacheCreationInputTokens':'cache_creation_input_tokens',
                'reasoningTokens':'reasoning_tokens','maxSingleCallTokens':'max_single_call_tokens','toolCallErrorCount':'tool_call_error_count',
                'cost':'cost','latency':'latency','skillTriggerRate':'skill_trigger_rate'}
            for key,snake in numeric.items():aliases[key]=('legacy.'+snake,snake,key)
            for key,names in aliases.items():
                for name in names:
                    if name not in attrs:continue
                    if key in numeric and source['row'].get('parent_span_id') and not name.startswith('legacy.'):continue
                    value=attrs[name]
                    if key in numeric:
                        if value is not None and (type(value) not in (int,float) or not math.isfinite(value)):raise EvidenceUnavailable('Invalid full analytics metric')
                    elif key in {'observedAgents','invokedSkills'}:
                        if isinstance(value,str):value=_parse(value)
                        if value is not None and not isinstance(value,list):raise EvidenceUnavailable('Invalid full analytics collection')
                    elif key in {'failures','skillIssues','callStats'}:
                        if value is not None and not isinstance(value,(str,list,dict)):raise EvidenceUnavailable('Invalid full analytics JSON field')
                    elif value is not None and not isinstance(value,str):raise EvidenceUnavailable('Invalid full analytics text')
                    fields[key]=value;break
            if source['row'].get('model'):fields['model']=source['row']['model']
            for name in ('legacy.is_answer_correct','is_answer_correct','isAnswerCorrect'):
                if name in attrs:
                    if attrs[name] is not None and type(attrs[name]) is not bool:raise EvidenceUnavailable('Invalid full analytics correctness')
                    fields['isAnswerCorrect']=attrs[name];break
        return fields

    def _read(self,token,workspace,begin):
        route=begin['route'];trace=route['trace_id'];heads=begin['heads']
        trace_heads=[h for h in heads if h['entity_kind']=='trace' and h['entity_id']==trace]
        expected_heads={h['entity_id']:h for h in heads if h['entity_kind']=='span'}
        if len(trace_heads)!=1 or not expected_heads:raise EvidenceUnavailable('Trace has no prepared evidence')
        summary=self.queries.summary(token,workspace,trace).get('trace')
        if not summary or not _same(summary.get('revision'),trace_heads[0]['revision']):raise EvidenceUnavailable('Trace summary has not reached evidence boundary')
        if summary.get('is_deleted') not in (0,'0') or summary.get('schema_version') not in (1,'1'):raise EvidenceUnavailable('Trace summary has unsupported state')
        for field in ('workspace_id','trace_id','trace_bucket','source_namespace','native_trace_id'):
            if summary.get(field)!=route[field]:raise EvidenceUnavailable('Summary escaped evidence route')
        rows=[];after='';row_bytes=0
        while True:
            self._deadline();page=self.authorized.read_spans(token,workspace,route['trace_bucket'],trace,after_span_id=after,limit=200)
            if not isinstance(page,list) or len(page)>200:raise EvidenceUnavailable('Invalid bounded Span page')
            for row in page:
                sid=row.get('span_id');head=expected_heads.get(sid)
                if not isinstance(sid,str) or sid<=after or head is None or not _same(row.get('revision'),head['revision']):raise EvidenceUnavailable('Span set differs from evidence boundary')
                if row.get('workspace_id')!=workspace or row.get('trace_id')!=trace or row.get('trace_bucket')!=route['trace_bucket'] or row.get('is_deleted') not in (0,'0'):raise EvidenceUnavailable('Span escaped evidence route')
                row_bytes+=_size(row,self.byte_budget)
                if row_bytes>self.byte_budget:raise EvidenceTooLarge('Evidence structure exceeds byte budget')
                rows.append(row);after=sid
            if len(page)<200:break
        if len(rows)!=len(expected_heads):raise EvidenceUnavailable('Evidence Span set is incomplete')
        state=self._artifact(trace_heads[0])
        for field in ('span_count','llm_call_count','tool_call_count','started_at_ms','ended_at_ms','agent_name','framework'):
            if not _same(summary.get(field),state.get(field)):raise EvidenceUnavailable('Trace summary differs from source state')
        status='failed' if state['error_count'] else ('running' if state['running_count'] else 'done')
        if summary.get('execution_status')!=status:raise EvidenceUnavailable('Trace lifecycle differs from source state')
        summary_attrs=_parse(summary['attributes_json'])
        for key in ('error_count','running_count','input_missing_count','output_missing_count'):
            if not _same(summary_attrs.get(key),state[key]):raise EvidenceUnavailable('Summary coverage differs from source state')
        if summary_attrs.get('owner_principal_id')!=begin['owner']['owner_principal_id']:raise EvidenceUnavailable('Summary owner differs')
        for token_kind in ('input','output'):
            expected=None if state[token_kind+'_missing_count'] else state[token_kind+'_known_sum']
            if not _same(summary.get(token_kind+'_tokens'),expected):raise EvidenceUnavailable('Trace metric differs from source state')
        expected={};source_bytes=0;capsule=None;fields={};candidates={}
        for row in rows:
            self._deadline();source=self._artifact(expected_heads[row['span_id']]);source_bytes+=_size(source,self.byte_budget)
            if source_bytes>self.byte_budget:raise EvidenceTooLarge('Evidence sources exceed byte budget')
            if not _same(source.get('source_revision'),expected_heads[row['span_id']]['source_revision']):raise EvidenceUnavailable('Source revision differs')
            captured=source['row']
            for key,value in captured.items():
                if key!='attributes_json' and not _same(row.get(key),value):raise EvidenceUnavailable('Span differs from durable source')
            compact,_=_source_projection(source)
            if _parse(row['attributes_json'])!=compact:raise EvidenceUnavailable('Span structure projection differs from source')
            sections=source['sections']
            if not isinstance(sections,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in sections.items()) or _payload_revision(sections)!=row['payload_revision']:raise EvidenceUnavailable('Source payload revision differs')
            expected[row['span_id']]={'sections':{k:hashlib.sha256(v.encode('utf-8')).hexdigest() for k,v in sections.items()}}
            if self.analytics_fields:expected[row['span_id']]['verified_source_sections']=sections
            priority=3 if 'legacy_trace' in sections else (1 if row.get('parent_span_id') else 2)
            for key,value in self._fields(source,analytics_fields=self.analytics_fields).items():candidates.setdefault(key,[]).append((priority,row['span_id'],value))
        frozen=_FrozenReads(self,token,workspace,route,{**summary,'owner_username':begin['owner']['normalized_login_name']},rows,expected)
        for row in rows:
            if 'legacy_trace' not in expected[row['span_id']]['sections']:continue
            value=_parse(frozen._section(token,workspace,route,row,'legacy_trace'))
            if capsule is not None or value.get('format')!='agent-insight.trace-bundle-node' or value.get('version')!=1:raise EvidenceUnavailable('Invalid original Trace metadata')
            capsule=value
        providers=state.get('legacy_projection_sources',{})
        for key,values in candidates.items():
            if capsule is not None:continue
            if key=='agentId':
                values=[value for value in values if value[0]>=2]
                if not values:continue
            original='final_result' if key=='finalResult' else key;provider=providers.get(original,providers.get(original+'_preview',{})).get('span_id')
            selected=[v for v in values if v[1]==provider] if provider else []
            if not selected:
                priority=max(v[0] for v in values);selected=[v for v in values if v[0]==priority]
                if key in {'clientId','skillOrigins'} and priority<2:continue
                if len({_hash(v[2]) for v in selected})>1:raise EvidenceUnavailable('Full source field is ambiguous')
            fields[key]=selected[0][2]
        if capsule is not None:
            if not isinstance(capsule.get('execution'),dict):raise EvidenceUnavailable('Original execution is missing')
            execution=copy.deepcopy(capsule['execution']);session=copy.deepcopy(capsule.get('session'))
            if session is None and not self.allow_missing_session:raise TraceNotFound('Original Session is unavailable')
            if session is not None and not isinstance(session,dict):raise EvidenceUnavailable('Original Session is invalid')
            if session is None:pass
            elif capsule.get('primary')=='langfuse_node':
                nodes=[]
                for row in rows:
                    item=_parse(frozen._section(token,workspace,route,row,'legacy_interaction'))
                    if item.get('format')!='agent-insight.trace-item' or item.get('version')!=1 or item.get('kind')!='langfuse_node' or item.get('index')!=len(nodes):raise EvidenceUnavailable('Original Langfuse nodes are incomplete')
                    nodes.append(item['value'])
                if len(nodes)!=capsule.get('primary_count') or not isinstance(session.get('interactions'),list):raise EvidenceUnavailable('Original Langfuse representation is incomplete')
                session['langfuseTraceNodes']=nodes
            else:
                result=frozen.session(token,workspace,trace,view='full');session['interactions']=result['interactions']
        else:
            session=frozen.session(token,workspace,trace,view='full')
            started=summary.get('started_at_ms')
            timestamp=datetime.datetime.fromtimestamp(int(started)/1000,datetime.timezone.utc).isoformat().replace('+00:00','Z') if started is not None else None
            execution={'framework':summary.get('framework'),'agentName':summary.get('agent_name'),'isSubagent':False,'timestamp':timestamp,**fields}
        execution.update(id=begin['aliases']['execution_id'],taskId=begin['aliases']['task_id'],user=begin['owner']['normalized_login_name'])
        if session is not None:session.update(taskId=begin['aliases']['task_id'],user=begin['owner']['normalized_login_name'])
        annotation=begin['annotation'];overrides=_parse(annotation['extra_json']).get('override_fields',[]) if annotation else []
        for key,column,target in [('query','query_override','query'),('label','label','label'),('final_result','final_result_override','finalResult')]:
            if key in overrides:
                execution[target]=annotation[column]
                if session is not None and target in ('query','label'):session[target]=annotation[column]
        manifest={'project_id':'default','workspace_id':workspace,'trace_id':trace,'source_namespace':route['source_namespace'],
            'native_trace_id':route['native_trace_id'],'trace_bucket':route['trace_bucket'],'incarnation':str(route['incarnation']),'route_epoch':str(route['route_epoch']),
            'aliases':begin['aliases'],'owner_principal_id':begin['owner']['owner_principal_id'],'annotation_revision':str(annotation['revision'] if annotation else 0),
            'annotation_hash':_hash(annotation) if annotation else None,'encoding':'trace-evidence-json/v1','heads':[
                {'kind':h['entity_kind'],'id':h['entity_id'],'revision':str(h['revision']),'source_revision':str(h['source_revision']),'content_hash':h['content_hash']} for h in heads],
            'sections':{sid:expected[sid]['sections'] for sid in sorted(expected)},'execution_hash':_hash(execution),'session_hash':_hash(session),
            'coverage':'prepared-head-vector; not all accepted packets'}
        if self.analytics_fields:manifest['evidence_source']='prepared-source-artifacts'
        result={'format':'agent-insight.trace-evidence','version':1,'manifest':manifest,'execution':execution,'session':session}
        result['snapshot_hash']=_hash(result)
        result['captured_at']=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        _size(result,self.byte_budget)
        return result

    def read(self,credential,workspace_id,*,task_id=None,execution_id=None,trace_ref=None):
        identifier(workspace_id)
        if task_id is None and execution_id is None and trace_ref is None:raise ValueError('Explicit Trace identity required')
        for value in (task_id,execution_id,trace_ref):
            if value is not None:identifier(value)
        self.deadline=time.monotonic()+MAX_READ_SECONDS
        begin=self._capture(credential,workspace_id,task_id,execution_id,trace_ref)
        try:result=self._read(credential,workspace_id,begin)
        except Exception as exc:
            self._verify_end(credential,workspace_id,task_id,execution_id,begin,trace_ref)
            if isinstance(exc,(Unauthorized,Forbidden,Conflict,TraceNotFound,EvidenceUnavailable,EvidenceTooLarge)):raise
            raise EvidenceUnavailable('Trace evidence is unavailable') from None
        self._verify_end(credential,workspace_id,task_id,execution_id,begin,trace_ref)
        return result

    def read_execution(self,credential,workspace_id,*,task_id=None,execution_id=None,trace_ref=None):
        reader=TraceEvidence(self.queries,self.authorized,max_bytes=self.max_bytes,allow_missing_session=True,analytics_fields=self.analytics_fields)
        value=reader.read(credential,workspace_id,task_id=task_id,execution_id=execution_id,trace_ref=trace_ref)
        value.pop('session');value['format']='agent-insight.trace-execution'
        value['snapshot_hash']=_hash({key:item for key,item in value.items() if key not in ('snapshot_hash','captured_at')})
        return value
