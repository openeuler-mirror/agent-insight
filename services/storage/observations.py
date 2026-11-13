import copy
import datetime
import hashlib
import json
import re
import uuid
from pathlib import Path

from .clickhouse import ClickHouseStore
from .contracts import canonical_json, content_hash, identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden
from .projects import resolve_project


EVENT_TYPE = 'observability.otlp.accepted.v1'
MAX_PACKET_BYTES = 4 * 1024 * 1024
MAX_IMPORT_PACKET_BYTES = 128 * 1024 * 1024
MAX_SPANS = 4096
MAX_NORMALIZED_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53-1


class IngestConflict(Conflict):
    pass


class _RouteRetired(IngestConflict):
    pass


class _LeaseLost(StorageError):
    pass


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _integer(value, minimum=0, maximum=2**64-1):
    if isinstance(value,str) and re.fullmatch(r'-?[0-9]+',value): value=int(value)
    if type(value) is not int or not minimum<=value<=maximum: raise ValueError('invalid OTLP integer')
    return value


def _value(value):
    if not isinstance(value,dict) or len(value)!=1: raise ValueError('invalid OTLP attribute value')
    kind,item=next(iter(value.items()))
    if kind=='stringValue' and isinstance(item,str): return item
    if kind=='boolValue' and type(item) is bool: return item
    if kind=='intValue': return _integer(item,-(2**63),2**63-1)
    if kind=='doubleValue' and type(item) in (float,int): return item
    if kind=='bytesValue' and isinstance(item,str): return item
    if kind=='arrayValue' and isinstance(item,dict) and isinstance(item.get('values',[]),list): return [_value(v) for v in item.get('values',[])]
    if kind=='kvlistValue' and isinstance(item,dict): return _attributes(item.get('values',[]))
    raise ValueError('invalid OTLP attribute value')


def _attributes(attributes):
    if not isinstance(attributes,list) or len(attributes)>4096: raise ValueError('invalid OTLP attributes')
    result={}
    for attribute in attributes:
        if not isinstance(attribute,dict) or not isinstance(attribute.get('key'),str) or not attribute['key']: raise ValueError('invalid OTLP attribute key')
        key=attribute['key']
        if key in result: raise ValueError('duplicate OTLP attribute key')
        result[key]=_value(attribute.get('value'))
    return result


def _text(value, limit=512):
    if not isinstance(value,str) or len(value)>limit: raise ValueError('invalid OTLP text')
    value.encode('utf-8')
    return value


def _hex(value,length,*,optional=False):
    if optional and value in (None,''): return ''
    if not isinstance(value,str) or not re.fullmatch('[0-9a-fA-F]{'+str(length)+'}',value) or int(value,16)==0: raise ValueError('invalid OTLP identifier')
    return value.lower()


def _payload_revision(sections):
    metadata={}
    for name,text in sections.items():
        data=text.encode('utf-8');chunks=list(ClickHouseStore._chunks(data))
        metadata[name]={'content_hash':hashlib.sha256(data).hexdigest(),'uncompressed_bytes':len(data),
                        'chunk_count':len(chunks),'chunk_hashes':[hashlib.sha256(c).hexdigest() for c in chunks]}
    return content_hash({'schema_version':1,'sections':metadata})


RAW_INTERACTION_KEYS = ('agent_insight.raw_interaction','agent_insight.interaction','legacy.interaction')
RAW_CONTENT_KEYS = ('gen_ai.input','gen_ai.input.messages','llm.input_messages','input.value',
                    'gen_ai.output','gen_ai.output.messages','llm.output_messages','output.value')


def _legacy_value(value):
    if (isinstance(value,dict) and value.get('format')=='agent-insight.trace-item' and value.get('version')==1
            and value.get('kind') in ('interaction','langfuse_node','carrier') and isinstance(value.get('value'),dict)):
        return value['value']
    return value


def _same_legacy_content(value,expected):
    if expected is None:return False
    def parsed(item):
        if isinstance(item,str):
            try:return json.loads(item)
            except ValueError:pass
        return item
    return _json(parsed(value))==_json(parsed(expected))


def _legacy_sections(span,resource_attrs,attrs):
    candidates=[span['agent_insight_legacy_interaction']] if 'agent_insight_legacy_interaction' in span else []
    candidates.extend(attrs[key] for key in RAW_INTERACTION_KEYS if key in attrs)
    trace=span.get('agent_insight_legacy_trace')
    if not candidates and trace is None:return None
    extras={};raw=None;raw_text=None
    for value in candidates:
        if isinstance(value,str):
            parsed=json.loads(value,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite legacy interaction')))
            text=value
        else:parsed=value;text=_json(value)
        if not isinstance(parsed,dict):raise ValueError('legacy interaction must be a JSON object')
        if raw is not None and _json(raw)!=_json(parsed):raise ValueError('conflicting legacy interaction copies')
        if raw is None:raw=parsed;raw_text=text
    if raw_text is not None:
        if len(raw_text.encode('utf-8'))>64*1024*1024:raise ValueError('legacy interaction exceeds64MiB')
        extras['legacy_interaction']=raw_text
    if trace is not None:
        if not isinstance(trace,dict):raise ValueError('legacy Trace metadata must be an object')
        extras['legacy_trace']=_json(trace)
    removed=set(RAW_INTERACTION_KEYS);resource_removed=set(RAW_INTERACTION_KEYS)
    if raw is not None:
        original=_legacy_value(raw)
        for key in RAW_CONTENT_KEYS:
            expected=original.get('requestMessages',original.get('input')) if key in RAW_CONTENT_KEYS[:4] else original.get('content',original.get('output'))
            if _same_legacy_content(attrs.get(key),expected):removed.add(key)
            if _same_legacy_content(resource_attrs.get(key),expected):resource_removed.add(key)
    resource={k:v for k,v in resource_attrs.items() if k not in resource_removed}
    clean={k:v for k,v in attrs.items() if k not in removed}
    if raw_text is not None:
        clean['legacy.interaction_section']='legacy_interaction'
        clean['legacy.interaction_sha256']=hashlib.sha256(raw_text.encode('utf-8')).hexdigest()
    slim={k:v for k,v in span.items() if k not in ('agent_insight_legacy_interaction','agent_insight_legacy_trace')}
    slim['attributes']=[item for item in span.get('attributes',[]) if item.get('key') not in removed]
    return resource,clean,slim,extras,raw is not None


def _normalize(body, workspace_id):
    if not isinstance(body,dict) or not isinstance(body.get('resourceSpans'),list): raise ValueError('resourceSpans required')
    result=[];seen=set();normalized_bytes=0
    for resource_span in body['resourceSpans']:
        if not isinstance(resource_span,dict): raise ValueError('invalid resource span')
        resource=resource_span.get('resource',{})
        if not isinstance(resource,dict): raise ValueError('invalid resource')
        resource_attrs=_attributes(resource.get('attributes',[]))
        source=resource_attrs.get('agent_insight.source_namespace','otlp')
        identifier(source)
        agent=_text(resource_attrs.get('agent.name',resource_attrs.get('service.name','')))
        framework=_text(resource_attrs.get('telemetry.sdk.name',''))
        scopes=resource_span.get('scopeSpans',[])
        if not isinstance(scopes,list): raise ValueError('invalid scope spans')
        for scope in scopes:
            if not isinstance(scope,dict) or not isinstance(scope.get('spans',[]),list): raise ValueError('invalid scope')
            for span in scope.get('spans',[]):
                if not isinstance(span,dict): raise ValueError('invalid span')
                native_trace=_hex(span.get('traceId'),32);native_span=_hex(span.get('spanId'),16)
                trace_id=str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json([workspace_id,source,native_trace,1])))
                identity=(trace_id,native_span)
                if identity in seen: raise ValueError('duplicate span in packet')
                seen.add(identity)
                attrs=_attributes(span.get('attributes',[]))
                source_rev=revision(_integer(attrs.get('agent_insight.revision',1),1,2**63-1))
                start=_integer(span.get('startTimeUnixNano'),1)
                end=_integer(span.get('endTimeUnixNano'),start)
                start_ms=start//1000000;end_ms=end//1000000
                bucket_date=datetime.datetime.fromtimestamp(start_ms/1000,datetime.timezone.utc).date()
                epoch=datetime.date(1970,1,1)
                if not epoch<=bucket_date<=epoch+datetime.timedelta(days=65535): raise ValueError('Trace bucket exceeds ClickHouse Date range')
                bucket=bucket_date.isoformat()
                status=span.get('status',{})
                if not isinstance(status,dict): raise ValueError('invalid span status')
                code=status.get('code',0)
                if code not in (0,1,2,'STATUS_CODE_UNSET','STATUS_CODE_OK','STATUS_CODE_ERROR'): raise ValueError('invalid span status')
                state='failed' if code in (2,'STATUS_CODE_ERROR') else 'done'
                kind=span.get('kind',0)
                if kind not in (0,1,2,3,4,5,'SPAN_KIND_UNSPECIFIED','SPAN_KIND_INTERNAL','SPAN_KIND_SERVER','SPAN_KIND_CLIENT','SPAN_KIND_PRODUCER','SPAN_KIND_CONSUMER'): raise ValueError('invalid span kind')
                model=_text(attrs.get('gen_ai.response.model',attrs.get('gen_ai.request.model',attrs.get('llm.model_name',''))))
                tool=_text(attrs.get('gen_ai.tool.name',attrs.get('tool.name','')))
                normalized_kind='tool' if tool or attrs.get('legacy.role')=='tool' or attrs.get('role')=='tool' else ('llm' if model or any(k.startswith('gen_ai.') for k in attrs) else str(kind))
                def token(*keys):
                    for key in keys:
                        if key in attrs: return _integer(attrs[key],0,MAX_SAFE_INTEGER)
                    return None
                legacy=_legacy_sections(span,resource_attrs,attrs)
                if legacy is None:
                    sections={'attributes':_json({'resource':resource_attrs,'span':attrs}), 'otlp_span':_json(span)}
                else:
                    clean_resource,clean_attrs,slim,extra_sections,raw_mode=legacy
                    sections={'attributes':_json({'resource':clean_resource,'span':clean_attrs}),'otlp_span':_json(slim),**extra_sections}
                if legacy is None or not legacy[-1]:
                    for name,keys in [('input',('gen_ai.input','gen_ai.input.messages','llm.input_messages','input.value')),('output',('gen_ai.output','gen_ai.output.messages','llm.output_messages','output.value'))]:
                        for key in keys:
                            if key in attrs:
                                sections[name]=attrs[key] if isinstance(attrs[key],str) else _json(attrs[key]);break
                row={'workspace_id':workspace_id,'trace_bucket':bucket,'trace_id':trace_id,'span_id':native_span,
                     'parent_span_id':_hex(span.get('parentSpanId'),16,optional=True),'source_namespace':source,'native_span_id':native_span,
                     'kind':normalized_kind,'name':_text(span.get('name',''),2048),'started_at_ms':start_ms,'ended_at_ms':end_ms,
                     'duration_us':(end-start)//1000,'model':model,'tool_name':tool,'execution_status':state,
                     'error_type':_text(attrs.get('error.type','')),'input_tokens':token('gen_ai.usage.input_tokens','llm.token_count.prompt'),
                     'output_tokens':token('gen_ai.usage.output_tokens','llm.token_count.completion'),
                     'payload_revision':_payload_revision(sections),'attributes_json':'{}','schema_version':1,'is_deleted':0}
                normalized_bytes+=sum(len(text.encode('utf-8')) for text in sections.values())+len(_json(row).encode('utf-8'))
                if normalized_bytes>MAX_NORMALIZED_BYTES: raise ValueError('normalized packet exceeds 64MiB; split shared resource attributes')
                source_snapshot={'row':row,'sections':sections,'source_revision':str(source_rev),'native_trace_id':native_trace,'agent_name':agent,'framework':framework}
                result.append(source_snapshot)
                if len(result)>MAX_SPANS: raise ValueError('packet exceeds 4096 spans')
    if not result: raise ValueError('packet has no spans')
    return result


def normalize_import(body,workspace_id):
    identifier(workspace_id)
    if len(_json(body).encode('utf-8'))>MAX_IMPORT_PACKET_BYTES:raise ValueError('import packet exceeds128MiB')
    return _normalize(body,workspace_id)


MAX_COMPACT_METADATA_BYTES = 2048
PROJECTION_FIELDS = ('query','label','model','observed_ip','source_kind','final_result','is_subagent',
    'parent_execution_id','root_execution_id','source_execution_id','agent_session_id','subagent_name','subagent_type','ownership',
    'skills','invoked_skills','agents','query_preview','final_result_preview')


def _compact_add(target,key,value,*,value_limit=512,budget=MAX_COMPACT_METADATA_BYTES):
    if value is None:return False
    try:
        if len(canonical_json(value).encode('utf-8'))>value_limit:return False
        if len(canonical_json(dict(target,**{key:value})).encode('utf-8'))>budget:return False
    except ValueError:return False
    target[key]=value
    return True


def _message_text(value):
    if isinstance(value,str):return value
    if isinstance(value,list):
        parts=[]
        for block in value:
            if isinstance(block,str):parts.append(block)
            elif isinstance(block,dict) and block.get('type') in ('text','input_text','output_text') and isinstance(block.get('text'),str):parts.append(block['text'])
        return '\n'.join(parts) if parts else None
    return None


def _section_text(text,role):
    if not isinstance(text,str):return None,None
    if text.lstrip().startswith(('[','{','"')):
        try:value=json.loads(text)
        except ValueError:return text,None
        if isinstance(value,str):return value,None
        messages=value.get('messages') if isinstance(value,dict) and 'messages' in value else value
        if isinstance(messages,dict):messages=[messages]
        if isinstance(messages,list):
            selected=[m for m in messages if isinstance(m,dict) and m.get('role')==role]
            if selected:
                return _message_text(selected[-1].get('content')),role
        return None,None
    return text,None


def _tool_structure_call(call):
    if not isinstance(call,dict):raise ValueError('invalid original tool call')
    function=call.get('function') if isinstance(call.get('function'),dict) else None
    name=(function.get('name') if function is not None else None) or call.get('name') or ''
    normalized=name.lower() if isinstance(name,str) else ''
    arguments=function.get('arguments',call.get('arguments')) if function is not None else call.get('arguments')
    if normalized in ('task','skill','load_skill','skill_view','skill_tool'):
        parsed=arguments
        if isinstance(parsed,str):
            try:parsed=json.loads(parsed)
            except ValueError:parsed=None
        if isinstance(parsed,dict):
            keys=('subagent_type','subagentType','session_id','sessionId','subagent_session_id','subagentSessionId','description') if normalized=='task' else ('name','skill_name','skillName','skill','version')+(('id',) if normalized in ('skill','load_skill') else ())
            selected={key:parsed[key] for key in keys if key in parsed}
            arguments=_json(selected) if isinstance(arguments,str) else selected
        elif isinstance(arguments,str):arguments=arguments if len(arguments.strip())<=240 else arguments.strip()[:240]+'…'
    elif isinstance(arguments,str) and len(arguments)>240:arguments='{}'
    result={key:copy.deepcopy(call[key]) for key in ('id','type','name','state','timing','trace_split_parallel_task') if key in call}
    if function is not None:
        result['function']={key:copy.deepcopy(function[key]) for key in ('name',) if key in function}
        if arguments is not None:result['function']['arguments']=arguments
    elif arguments is not None:result['arguments']=arguments
    if normalized=='task':
        def linkage(value,depth=0):
            if value is None or depth>3:return None
            if isinstance(value,str):
                if len(value)<=240:return value
                try:return linkage(json.loads(value),depth+1)
                except ValueError:return None
            if isinstance(value,list):
                values=[selected for item in value if (selected:=linkage(item,depth+1)) is not None]
                return values or None
            if isinstance(value,dict):
                selected={key:copy.deepcopy(value[key]) for key in ('session_id','sessionId','subagent_session_id','subagentSessionId') if key in value}
                if selected:return selected
                for key,item in value.items():
                    child=linkage(item,depth+1)
                    if child is not None:return {key:child}
            return None
        output=linkage(call.get('output',call.get('result')))
        if output is not None:result['output']=output
    return result


def _source_projection(source):
    sections=source['sections'];full=json.loads(sections['attributes'])
    attrs={**full.get('resource',{}),**full.get('span',{})}
    raw=json.loads(sections['legacy_interaction']) if 'legacy_interaction' in sections else {}
    for key in RAW_INTERACTION_KEYS:
        candidate=attrs.get(key)
        if isinstance(candidate,str):
            try:candidate=json.loads(candidate)
            except ValueError:continue
        if isinstance(candidate,dict):raw=candidate;break
    raw=_legacy_value(raw)
    attrs={**raw,**attrs}
    if 'legacy_trace' in sections:
        trace=json.loads(sections['legacy_trace']);execution=trace.get('execution',{});session=trace.get('session')
        if session is None:session={}
        if not isinstance(execution,dict) or not isinstance(session,dict):raise ValueError('invalid legacy Trace metadata')
        for original,destination in [('query','legacy.session_query'),('label','legacy.session_label'),('finalResult','legacy.final_result'),('model','model'),
            ('observedIp','observed_ip'),('sourceKind','source_kind'),('skills','skills'),('invokedSkills','invoked_skills'),('observedAgents','agents'),
            ('isSubagent','is_subagent'),('parentExecutionId','parent_execution_id'),('rootExecutionId','root_execution_id'),
            ('sourceExecutionId','source_execution_id'),('agentSessionId','agent_session_id'),('agentOwnership','ownership'),
            ('subagentName','subagent_name'),('subagentType','subagent_type')]:
            if original in execution and execution[original] is not None:attrs[destination]=execution[original]
        for original,destination in [('query','legacy.session_query'),('label','legacy.session_label')]:
            if original in session and session[original] is not None:attrs[destination]=session[original]
    compact={}
    if 'legacy_interaction' in sections:_compact_add(compact,'legacy.interaction_section','legacy_interaction')
    if type(attrs.get('legacy.transfer_has_session')) is bool:_compact_add(compact,'legacy.transfer_has_session',attrs['legacy.transfer_has_session'])
    for key in ('legacy.transfer_kind','legacy.original_parent_span_id'):
        if isinstance(attrs.get(key),str):_compact_add(compact,key,attrs[key],value_limit=256)
    if type(attrs.get('legacy.transfer_index')) is int:_compact_add(compact,'legacy.transfer_index',attrs['legacy.transfer_index'])
    for key in ('legacy.role','role','agent.name','agent','trace_kind','trace_name','trace_status'):
        if isinstance(attrs.get(key),str):_compact_add(compact,key,attrs[key],value_limit=256)
    tool_key=None;tool_value=None
    if attrs.get('legacy.transfer_kind')=='carrier' and source['row']['kind']=='tool':
        tool_key='legacy.tool_call';tool_value=raw
    elif source['row']['source_namespace']!='agent.record.v1' and isinstance(raw.get('tool_calls'),list) and raw['tool_calls']:
        tool_key='legacy.tool_calls';tool_value=raw['tool_calls']
    if tool_key:
        # Core messages use one compact call per carrier, avoiding a per-message fan-out limit.
        try:
            if tool_key=='legacy.tool_call':projected=_tool_structure_call(tool_value)
            else:
                projected=[];projected_bytes=2
                for call in tool_value:
                    item=_tool_structure_call(call);projected_bytes+=len(_json(item).encode('utf-8'))+1
                    if projected_bytes>MAX_COMPACT_METADATA_BYTES:raise ValueError('tool structure exceeds compact budget')
                    projected.append(item)
            added=_compact_add(compact,tool_key,projected,value_limit=MAX_COMPACT_METADATA_BYTES)
        except ValueError:added=False
        if not added:
            while not _compact_add(compact,'legacy.tool_structure_oversized',True):compact.popitem()
    input_text,_=_section_text(sections.get('input'),'user')
    output_text,output_role=_section_text(sections.get('output'),'assistant')
    if input_text is None and raw.get('requestMessages') is not None:input_text,_=_section_text(_json(raw['requestMessages']),'user')
    if input_text is None:input_text=_message_text(raw.get('input'))
    if output_text is None:output_text=_message_text(raw.get('content',raw.get('output')))
    preview=output_text if output_text is not None else input_text
    if preview is not None:_compact_add(compact,'content_preview',preview[:240],value_limit=1024)
    for key in ('legacy.session_query','legacy.session_label','legacy.original_span_id','legacy.original_trace_id',
                'legacy.source_task_id','legacy.source_record_id','call_id','call_ids','request_id','response_id',
                'attempt_id','attempt_ids','gen_ai.request.id','gen_ai.response.id','gen_ai.request_id','gen_ai.response_id',
                'inference.call_id','inference.call_ids','inference.request_id','inference.response_id',
                'agent_insight.call_id','agent_insight.call_ids','openinference.span.kind',
                'subagentSessionId','subagentName','subagentType','agent_session_id','agent.session_id'):
        value=attrs.get(key)
        if isinstance(value,(str,list)):_compact_add(compact,key,value)
    fields={}
    aliases={
        'query':('legacy.session_query','legacy.query','query'),
        'label':('legacy.session_label','legacy.label','label'),
        'final_result':('legacy.final_result','final_result'),
        'observed_ip':('legacy.observed_ip','agent_insight.observed_ip','observed_ip','observedIp'),
        'source_kind':('legacy.source_kind','source_kind','sourceKind'),
        'ownership':('legacy.agent_ownership','agent_ownership','agentOwnership','ownership'),
        'is_subagent':('legacy.is_subagent','is_subagent','isSubagent'),
        'parent_execution_id':('legacy.parent_execution_id','parent_execution_id','parentExecutionId'),
        'root_execution_id':('legacy.root_execution_id','root_execution_id','rootExecutionId'),
        'source_execution_id':('legacy.source_execution_id','source_execution_id','sourceExecutionId'),
        'agent_session_id':('legacy.agent_session_id','agent_session_id','agentSessionId'),
        'subagent_name':('legacy.subagent_name','subagent_name','subagentName'),
        'subagent_type':('legacy.subagent_type','subagent_type','subagentType'),
        'skills':('legacy.skills','skills'),'invoked_skills':('legacy.invoked_skills','invoked_skills','invokedSkills'),
        'agents':('legacy.agents','agents','observed_agents','observedAgents'),
    }
    for field,names in aliases.items():
        for name in names:
            if name in attrs:
                value=attrs[name]
                if field in ('skills','invoked_skills','agents') and isinstance(value,str) and len(value.encode())<=4096:
                    try:value=json.loads(value)
                    except ValueError:break
                if field=='is_subagent':valid=type(value) is bool
                elif field in ('skills','agents'):valid=isinstance(value,list) and len(value)<=32 and all(isinstance(v,str) for v in value)
                elif field=='invoked_skills':valid=isinstance(value,list) and len(value)<=32 and all(isinstance(v,dict) and set(v)<={'name','version'} and isinstance(v.get('name'),str) and (v.get('version') is None or type(v.get('version')) is int) for v in value)
                else:valid=isinstance(value,str)
                if valid:fields[field]=value
                break
    if source['row']['model']:fields['model']=source['row']['model']
    elif isinstance(attrs.get('model'),str):fields['model']=attrs['model']
    role=attrs.get('legacy.role',attrs.get('role'))
    if 'query' not in fields and input_text is not None:fields['query']=input_text
    if 'query' not in fields and role=='user' and output_text is not None:fields['query']=output_text
    if 'final_result' not in fields and output_text is not None and role!='user':fields['final_result']=output_text
    bounded={}
    for field in PROJECTION_FIELDS:
        if field not in fields:continue
        value=fields[field]
        if not _compact_add(bounded,field,value) and field in ('query','final_result') and isinstance(value,str):
            _compact_add(bounded,field+'_preview',value[:240],value_limit=1024)
    return compact,bounded


def _merge_projection(state,source,fields):
    projection=state.get('legacy_projection',{});providers=state.get('legacy_projection_sources',{})
    span=source['row']['span_id'];priority=3 if 'legacy_trace' in source['sections'] else (1 if source['row']['parent_span_id'] else 2)
    for key in list(projection):
        if providers.get(key,{}).get('span_id')==span and key not in fields:
            projection.pop(key,None);providers.pop(key,None)
    for key,value in fields.items():
        previous=providers.get(key,{})
        if key not in projection or previous.get('span_id')==span or priority>previous.get('priority',0):
            projection[key]=value;providers[key]={'span_id':span,'priority':priority}
    bounded={};retained={}
    for key in sorted(projection,key=lambda k:(-providers.get(k,{}).get('priority',0),PROJECTION_FIELDS.index(k))):
        if _compact_add(bounded,key,projection[key],value_limit=1024):retained[key]=providers[key]
    state['legacy_projection']=bounded;state['legacy_projection_sources']=retained


class ObservationIngest:
    def __init__(self,control,facts):
        self.control=control;self.facts=facts;self.iam=IAMStore(control)

    def _load(self,ref):
        try:
            self.control._verify_artifact(Path(ref).name,ref)
        except Conflict:
            raise IngestConflict('durable observation artifact is missing or corrupt') from None
        value=json.loads(Path(ref).read_text(encoding='utf-8'))
        if isinstance(value,dict) and value.get('encoding')=='observation-json/v1':
            return json.loads(value['json'])
        return value

    def _persist(self,value):
        return self.control.persist_artifact({'encoding':'observation-json/v1','json':_json(value)})

    def accept(self,credential,workspace_id,body,receipt_key=None):
        return self._accept(credential,workspace_id,body,receipt_key,MAX_PACKET_BYTES)

    def accept_import(self,credential,workspace_id,body,receipt_key=None):
        return self._accept(credential,workspace_id,body,receipt_key,MAX_IMPORT_PACKET_BYTES)

    def _accept(self,credential,workspace_id,body,receipt_key,max_packet_bytes):
        identifier(workspace_id)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential);self.iam._workspace(scope,workspace_id,'write');resolve_project(con,workspace_id)
        if isinstance(body,(str,bytes,bytearray)):
            if len(body if not isinstance(body,str) else body.encode('utf-8'))>max_packet_bytes: raise ValueError('packet exceeds bounded ingress size')
            try: body=json.loads(body,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            except (UnicodeError,RecursionError) as exc: raise ValueError('invalid OTLP JSON') from exc
        try:
            raw=_json(body);data=raw.encode('utf-8')
            if len(data)>max_packet_bytes: raise ValueError('packet exceeds bounded ingress size')
            spans=_normalize(body,workspace_id)
        except (TypeError,OverflowError,UnicodeError,RecursionError) as exc: raise ValueError('invalid bounded OTLP JSON') from exc
        packet_hash=hashlib.sha256(data).hexdigest()
        receipt_key=packet_hash if receipt_key is None else identifier(receipt_key)
        _,packet_ref=self.control.persist_artifact({'encoding':'otlp-json/v1','json':raw})
        now=self.control.clock();trace_ids=sorted({span['row']['trace_id'] for span in spans})
        with self.control.transaction() as con:
            scope=self.iam._scope(con,credential);self.iam._workspace(scope,workspace_id,'write');resolve_project(con,workspace_id)
            old=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND principal_id=? AND receipt_key=?',(workspace_id,scope.principal_id,receipt_key)).fetchone()
            if old:
                if old['packet_hash']!=packet_hash: raise Conflict('receipt key has different content')
                return {'batch_id':old['batch_id'],'state':old['state'],'trace_ids':json.loads(old['trace_ids_json']),'duplicate':True}
            schema_version=con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0]
            for trace_id in trace_ids:
                span=next(s for s in spans if s['row']['trace_id']==trace_id);row=span['row']
                locator=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace_id,trace_id)).fetchone()
                if locator:
                    if locator['state']!='active': raise Forbidden('Trace is not active')
                    self.iam._authorize(con,credential,workspace_id,'write','trace',trace_id)
                else:
                    con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',
                        (workspace_id,trace_id,row['source_namespace'],span['native_trace_id'],row['trace_bucket'],now,now))
                    self.iam._record_resource(con,workspace_id,'trace',trace_id,scope.principal_id,'private',invalidate_policy=False)
                    if schema_version>=5 and row['source_namespace']=='otlp':
                        native=span['native_trace_id']
                        collision=con.execute('SELECT trace_id FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace_id,native)).fetchone()
                        if collision and collision[0]!=trace_id:raise Conflict('native Trace ID collides with an existing internal identity')
                        for alias_kind in ('task','execution'):
                            existing=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(workspace_id,alias_kind,native)).fetchone()
                            if existing and existing[0]!=trace_id:raise Conflict('native Trace ID collides with a registered legacy identity')
                            if not existing:con.execute('INSERT INTO trace_legacy_ids VALUES(?,?,?,?,?)',(workspace_id,alias_kind,native,trace_id,now))
            batch_id=str(uuid.uuid4());event_id=str(uuid.uuid4())
            con.execute('INSERT INTO ingest_batches(workspace_id,batch_id,principal_id,receipt_key,packet_hash,packet_ref,trace_ids_json,accepted_at_ms) VALUES(?,?,?,?,?,?,?,?)',
                (workspace_id,batch_id,scope.principal_id,receipt_key,packet_hash,packet_ref,canonical_json(trace_ids),now))
            # The shared writer lock makes this durable queue order stable even when clock values tie or regress.
            previous=con.execute('SELECT MAX(created_at_ms) FROM outbox_events WHERE event_type=?',(EVENT_TYPE,)).fetchone()[0]
            queue_time=max(now,(previous+1) if previous is not None else now)
            con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)',
                (workspace_id,event_id,batch_id,EVENT_TYPE,canonical_json({'batch_id':batch_id}),queue_time,now))
        return {'batch_id':batch_id,'state':'accepted','trace_ids':trace_ids,'duplicate':False}

    def batch_status(self,credential,workspace_id,batch_id):
        identifier(workspace_id);identifier(batch_id)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential);resolve_project(con,workspace_id)
            row=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(workspace_id,batch_id)).fetchone()
            if row is None: raise Forbidden('batch is not accessible')
            capability='write' if row['principal_id']==scope.principal_id and 'read' not in scope.capabilities else 'read'
            grant=self.iam._workspace(scope,workspace_id,capability)
            if row['principal_id']!=scope.principal_id and grant.role not in ('owner','admin','personal'): raise Forbidden('batch is not accessible')
            trace_ids=json.loads(row['trace_ids_json'])
            for trace_id in trace_ids:
                self.iam._authorize(con,credential,workspace_id,capability,'trace',trace_id)
            return {'batch_id':batch_id,'state':row['state'],'trace_ids':trace_ids,'accepted_at_ms':row['accepted_at_ms'],
                    'indexed_at_ms':row['indexed_at_ms'],'error_code':row['error_code']}

    def _claim(self,worker_id,lease_ms):
        now=self.control.clock()
        with self.control.transaction() as con:
            row=con.execute("SELECT * FROM outbox_events WHERE event_type=? AND state IN ('pending','dispatching') ORDER BY created_at_ms,event_id LIMIT 1",(EVENT_TYPE,)).fetchone()
            if row is None or row['next_attempt_at_ms']>now or (row['state']=='dispatching' and row['lease_until_ms'] is not None and row['lease_until_ms']>now): return None
            attempt=revision(row['attempts']+1)
            con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",
                (attempt,worker_id,now+lease_ms,now,row['workspace_id'],row['event_id']))
            result=dict(row);result.update(attempts=attempt,lease_owner=worker_id,lease_until_ms=now+lease_ms)
            return result

    def _owned(self,con,event):
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(event['workspace_id'],event['event_id'])).fetchone()
        if not row or row['state']!='dispatching' or row['attempts']!=event['attempts'] or row['lease_owner']!=event['lease_owner'] or row['lease_until_ms']<=self.control.clock(): raise _LeaseLost('worker lease lost')
        return row

    def _renew(self,event,lease_ms,trace_ids=()):
        with self.control.transaction() as con:
            self._owned(con,event)
            for trace_id in trace_ids:
                if con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(event['workspace_id'],trace_id)).fetchone() is None:
                    raise _RouteRetired('Trace route no longer active')
            now=self.control.clock()
            con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND attempts=? AND lease_owner=?',
                (now+lease_ms,now,event['workspace_id'],event['event_id'],event['attempts'],event['lease_owner']))

    def _put_head(self,con,ws,trace,kind,entity,version,source_version,snapshot,old,now):
        digest=hashlib.sha256(_json(snapshot).encode('utf-8')).hexdigest()
        _,ref=self._persist(snapshot)
        if old:
            con.execute('UPDATE obs_entity_heads SET revision=?,source_revision=?,content_hash=?,artifact_ref=?,updated_at_ms=? WHERE workspace_id=? AND trace_id=? AND entity_kind=? AND entity_id=?',
                (version,source_version,digest,ref,max(now,old['updated_at_ms']),ws,trace,kind,entity))
        else:
            con.execute('INSERT INTO obs_entity_heads VALUES(?,?,?,?,?,?,?,?,?,?)',(ws,trace,kind,entity,version,source_version,digest,ref,now,now))

    @staticmethod
    def _delta(summary,row,direction):
        summary['span_count']+=direction
        summary['error_count']+=direction*(row['execution_status']=='failed')
        summary['running_count']+=direction*(row['execution_status']=='running')
        summary['llm_call_count']+=direction*(row['kind']=='llm')
        summary['tool_call_count']+=direction*(row['kind']=='tool')
        if summary.get('tool_error_count') is not None:
            summary['tool_error_count']+=direction*(row['kind']=='tool' and row['execution_status']=='failed')
        for token in ('input','output'):
            value=row[token+'_tokens']
            summary[token+'_missing_count']+=direction*(value is None)
            summary[token+'_known_sum']+=direction*(value or 0)

    def _prepare(self,event,lease_ms=30000):
        ws=event['workspace_id'];now=self.control.clock()
        with self.control.transaction() as con:
            self._owned(con,event)
            batch=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(ws,event['aggregate_id'])).fetchone()
            if batch is None: raise IngestConflict('missing batch')
            for trace_id in json.loads(batch['trace_ids_json']):
                if con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace_id)).fetchone() is None:
                    raise _RouteRetired('Trace route no longer active')
            if batch['plan_ref']: return self._load(batch['plan_ref'])
            packet=self._load(batch['packet_ref'])
            if packet.get('encoding')!='otlp-json/v1': raise IngestConflict('invalid packet encoding')
            if hashlib.sha256(packet['json'].encode('utf-8')).hexdigest()!=batch['packet_hash']: raise IngestConflict('packet checksum mismatch')
            spans=_normalize(json.loads(packet['json']),ws)
            plan={'spans':[],'payloads':[],'summaries':[]};traces={}
            for source in spans:
                row=source['row'];trace=row['trace_id'];span=row['span_id']
                locator=con.execute("SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace)).fetchone()
                if not locator: raise IngestConflict('Trace route no longer active')
                row['trace_bucket']=locator['trace_bucket']
                head=con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span' AND entity_id=?",(ws,trace,span)).fetchone()
                source_version=int(source['source_revision']);digest=hashlib.sha256(_json(source).encode('utf-8')).hexdigest()
                if head and source_version<head['source_revision']: continue
                if head and source_version==head['source_revision']:
                    if digest!=head['content_hash']: raise IngestConflict('source revision content conflict')
                    continue
                if trace not in traces:
                    trace_head=con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='trace' AND entity_id=?",(ws,trace,trace)).fetchone()
                    state=self._load(trace_head['artifact_ref']) if trace_head else dict.fromkeys(('span_count','error_count','running_count','llm_call_count','tool_call_count','input_known_sum','output_known_sum','input_missing_count','output_missing_count'),0)
                    if trace_head:
                        state.setdefault('tool_error_count',None);state.setdefault('legacy_projection_complete',False)
                    else:
                        state['tool_error_count']=0;state['legacy_projection_complete']=True
                    traces[trace]=[trace_head,state,source,locator]
                state=traces[trace][1]
                compact,fields=_source_projection(source)
                _merge_projection(state,source,fields)
                is_root=not row['parent_span_id']
                if not state.get('agent_name') or (is_root and not state.get('display_is_root')):
                    state['agent_name']=source['agent_name'];state['framework']=source['framework'];state['display_is_root']=is_root
                if head:
                    previous=self._load(head['artifact_ref'])['row']
                    if ((previous['started_at_ms']==state['started_at_ms'] and row['started_at_ms']>previous['started_at_ms']) or
                            (previous['ended_at_ms']==state['ended_at_ms'] and row['ended_at_ms']<previous['ended_at_ms'])):
                        state['_recompute_bounds']=True
                    self._delta(state,previous,-1)
                self._delta(state,row,1)
                state['started_at_ms']=min(state.get('started_at_ms',row['started_at_ms']),row['started_at_ms'])
                state['ended_at_ms']=max(state.get('ended_at_ms',row['ended_at_ms']),row['ended_at_ms'])
                version=revision(head['revision']+1 if head else 1)
                self._put_head(con,ws,trace,'span',span,version,source_version,source,head,now)
                plan['payloads'].append({'workspace_id':ws,'trace_bucket':row['trace_bucket'],'trace_id':trace,'span_id':span,'sections':source['sections'],'payload_revision':row['payload_revision']})
                plan['spans'].append(dict(row,attributes_json=canonical_json(compact),revision=version))
            for trace,(head,state,source,locator) in traces.items():
                if state.pop('_recompute_bounds',False):
                    starts=[];ends=[]
                    for current in con.execute("SELECT artifact_ref FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span'",(ws,trace)):
                        current_row=self._load(current[0])['row'];starts.append(current_row['started_at_ms']);ends.append(current_row['ended_at_ms'])
                    state['started_at_ms']=min(starts);state['ended_at_ms']=max(ends)
                version=revision(head['revision']+1 if head else 1)
                owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()[0]
                metadata={'owner_principal_id':owner,'source':'otlp','error_count':state['error_count'],'running_count':state['running_count'],
                    'input_missing_count':state['input_missing_count'],'output_missing_count':state['output_missing_count'],
                    'tool_error_count':state['tool_error_count'],'tool_error_count_known':state['tool_error_count'] is not None,
                    'legacy_projection_complete':state['legacy_projection_complete']}
                for key,value in state.get('legacy_projection',{}).items():_compact_add(metadata,key,value,value_limit=1024)
                summary={'workspace_id':ws,'trace_bucket':locator['trace_bucket'],'trace_id':trace,'source_namespace':source['row']['source_namespace'],
                    'native_trace_id':source['native_trace_id'],'agent_name':state['agent_name'],'framework':state['framework'],
                    'started_at_ms':state['started_at_ms'],'ended_at_ms':state['ended_at_ms'],'last_activity_at_ms':state['ended_at_ms'],
                    'execution_status':'failed' if state['error_count'] else ('running' if state['running_count'] else 'done'),
                    'span_count':state['span_count'],'llm_call_count':state['llm_call_count'],'tool_call_count':state['tool_call_count'],
                    'input_tokens':None if state['input_missing_count'] else state['input_known_sum'],
                    'output_tokens':None if state['output_missing_count'] else state['output_known_sum'],
                    'attributes_json':canonical_json(metadata),
                    'schema_version':1,'revision':version,'is_deleted':0}
                self._put_head(con,ws,trace,'trace',trace,version,1,state,head,now)
                plan['summaries'].append(summary)
            _,ref=self._persist(plan)
            con.execute("UPDATE ingest_batches SET state='prepared',plan_ref=? WHERE workspace_id=? AND batch_id=?",(ref,ws,batch['batch_id']))
            # The shared transaction lock prevents reclaim during preparation; renew after its final fsync.
            renewed=self.control.clock()
            con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND attempts=? AND lease_owner=?',
                (renewed+lease_ms,renewed,ws,event['event_id'],event['attempts'],event['lease_owner']))
            return plan

    def work_once(self,worker_id,lease_ms=30000):
        identifier(worker_id)
        if type(lease_ms) is not int or not 1000<=lease_ms<=300000: raise ValueError('lease must be 1000..300000ms')
        event=self._claim(worker_id,lease_ms)
        if event is None: return False
        prepared=False
        try:
            plan=self._prepare(event,lease_ms);prepared=True
            bulk=getattr(self.facts,'write_payload_bundles',None)
            for offset in range(0,len(plan['payloads']),128):
                payloads=plan['payloads'][offset:offset+128]
                self._renew(event,lease_ms,{p['trace_id'] for p in payloads})
                if callable(bulk):
                    results=bulk(payloads)
                    if not isinstance(results,list) or len(results)!=len(payloads): raise IngestConflict('payload batch receipt mismatch')
                else:
                    results=[]
                    for payload in payloads:
                        self._renew(event,lease_ms,[payload['trace_id']])
                        results.append(self.facts.write_payload_bundle(payload['workspace_id'],payload['trace_bucket'],payload['trace_id'],payload['span_id'],payload['sections']))
                for payload,result in zip(payloads,results):
                    actual=result.get('payload_revision') if callable(bulk) else result.get('payload_revision',payload['payload_revision'])
                    if actual!=payload['payload_revision']: raise IngestConflict('payload revision mismatch')
            for rows,method in [(plan['spans'],self.facts.write_spans),(plan['summaries'],lambda rows:self.facts._insert('obs_trace_current',rows))]:
                for offset in range(0,len(rows),128):
                    selected=rows[offset:offset+128]
                    self._renew(event,lease_ms,{row['trace_id'] for row in selected});method(selected)
            with self.control.transaction() as con:
                self._owned(con,event);now=self.control.clock()
                con.execute("UPDATE ingest_batches SET state='indexed',indexed_at_ms=CASE WHEN accepted_at_ms>? THEN accepted_at_ms ELSE ? END,error_code=NULL WHERE workspace_id=? AND batch_id=?",(now,now,event['workspace_id'],event['aggregate_id']))
                con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now,event['workspace_id'],event['event_id']))
        except _LeaseLost:
            return True
        except Exception as exc:
            permanent=isinstance(exc,_RouteRetired) or (not prepared and isinstance(exc,(IngestConflict,ValueError,FileNotFoundError)))
            try:
                with self.control.transaction() as con:
                    self._owned(con,event);now=self.control.clock()
                    if permanent:
                        con.execute("UPDATE ingest_batches SET state='failed',error_code='invalid_source_revision_or_artifact' WHERE workspace_id=? AND batch_id=?",(event['workspace_id'],event['aggregate_id']))
                    con.execute('UPDATE outbox_events SET state=?,lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',
                        ('dead' if permanent else 'pending',now+min(60000,1000*2**min(event['attempts'],6)),now,event['workspace_id'],event['event_id']))
            except _LeaseLost: pass
        return True
