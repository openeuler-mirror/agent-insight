"""Legacy Trace DTOs over authorized, paginated Span and immutable payload reads."""
import copy
import datetime
import hashlib
import json

from .control import StorageError
from .iam import Forbidden

MAX_STRUCTURE_SPANS = 100000
MAX_STRUCTURE_BYTES = 16 * 1024 * 1024
MAX_FULL_BYTES = 128 * 1024 * 1024
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
MAX_PAYLOAD_CHUNKS = 4096



class CompatibilityLimitError(StorageError):
    status=413


class TraceNotFound(LookupError):
    status=404


class InvalidInteractionIndex(ValueError):
    status=400


def _bytes(value):
    return len(json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))


def _integer(value):
    if value is None:return None
    if type(value) is int:return value
    if isinstance(value,str):
        try:return int(value)
        except ValueError:pass
    raise ValueError('invalid stored integer metric')


def _object(value):
    if isinstance(value,str):
        try:value=json.loads(value)
        except (ValueError,TypeError):return {}
    return value if isinstance(value,dict) else {}


def _iso(value):
    if value is None:return None
    return datetime.datetime.fromtimestamp(_integer(value)/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def _usage(value):
    if not isinstance(value,dict):return {}
    result={}
    aliases={'input_tokens':'input','output_tokens':'output','total_tokens':'total','reasoning_tokens':'reasoning'}
    for key,metric in value.items():
        target=aliases.get(key,key)
        if target in {'input','output','total','reasoning'} and metric is not None:result[target]=_integer(metric)
        elif target in {'cache','estimated','source','scope','missing_context'} and metric is not None:result[target]=copy.deepcopy(metric)
    return result


class LegacyTraceReads:
    def __init__(self, queries, authorized):
        self.queries=queries
        self.authorized=authorized

    def _spans(self,token,workspace,route):
        if route.get('source_namespace')=='collector.source.v1':
            from .collector_sources import current_rows, current_boundary
            begin=current_boundary(self.queries.control,token,workspace,route)
            rows=list(self._scan_spans(token,workspace,route))
            if _bytes(rows)>MAX_STRUCTURE_BYTES:raise CompatibilityLimitError('Collector structure exceeds16MiB')
            yield from current_rows(self.queries.control,token,workspace,route,rows,begin=begin)
            return
        yield from self._scan_spans(token,workspace,route)

    def _scan_spans(self,token,workspace,route):
        after='';count=0
        while True:
            rows=self.authorized.read_spans(token,workspace,route['trace_bucket'],route['trace_id'],after_span_id=after,limit=200)
            if not isinstance(rows,list) or len(rows)>200:raise ValueError('invalid bounded Span page')
            if not rows:return
            for row in rows:
                sid=row.get('span_id')
                if not isinstance(sid,str) or not sid or sid<=after:raise ValueError('Span pages are not strictly ordered')
                if row.get('trace_id',route['trace_id'])!=route['trace_id']:raise ValueError('Span escaped its Trace route')
                after=sid;count+=1
                if count>MAX_STRUCTURE_SPANS:raise CompatibilityLimitError('Trace structure exceeds100000 Spans')
                yield row
            if len(rows)<200:return

    def _metadata(self,row,index,summary):
        attrs=_object(row.get('attributes_json'));nested=_object(attrs.get('span'))
        attrs={**attrs,**nested}
        kind=row.get('kind');role=attrs.get('legacy.role',attrs.get('role'))
        if kind=='tool':role='tool'
        elif not isinstance(role,str) or not role:role='assistant' if kind=='llm' else 'trace'
        interaction={'role':role,'spanId':row['span_id'],'parentSpanId':row.get('parent_span_id') or '',
            'traceId':row.get('trace_id',summary['trace_id']),'_interactionIndex':index,'_payloadDeferred':True,
            '_payloadVersion':row.get('payload_revision'),'trace_kind':'tool' if kind=='tool' else ('llm' if kind=='llm' else 'chain')}
        if not isinstance(interaction['_payloadVersion'],str) or not interaction['_payloadVersion']:
            raise ValueError('Span has no exact payload revision')
        agent=attrs.get('agent.name') or attrs.get('agent') or summary.get('agent_name')
        if agent:interaction['agent']=agent
        preview=attrs.get('content_preview')
        if preview is not None:
            if not isinstance(preview,str) or len(preview)>240:raise ValueError('invalid compact content preview')
            interaction['content']=preview
        if row.get('model'):interaction['model']=row['model']
        timing={}
        for source,target in [('started_at_ms','created'),('ended_at_ms','completed')]:
            if row.get(source) is not None:timing[target]=_integer(row[source])
        if timing:interaction['timeInfo']=timing
        if 'created' in timing:interaction['timestamp']=timing['created']
        usage={}
        for source,target in [('input_tokens','input'),('output_tokens','output')]:
            if row.get(source) is not None:usage[target]=_integer(row[source])
        if 'input' in usage and 'output' in usage:usage['total']=usage['input']+usage['output']
        else:usage['missing_context']=True
        if usage:interaction['usage']=usage
        if kind=='tool':
            name=row.get('tool_name') or row.get('name')
            call={'id':row['span_id'],'type':'function','function':{'name':name}}
            if timing:call['timing']={k:timing[v] for k,v in [('started_at','created'),('completed_at','completed')] if v in timing}
            if row.get('execution_status') in {'done','failed'}:call['state']='error' if row['execution_status']=='failed' else 'success'
            interaction['tool_calls']=[call]
        elif kind!='llm':
            if row.get('name'):interaction['trace_name']=row['name']
            if row.get('execution_status'):interaction['trace_status']=row['execution_status']
        if row.get('execution_status')=='failed':interaction.update(status='error',trace_status='error')
        if row.get('error_type'):interaction['error']=row['error_type']
        if isinstance(attrs.get('legacy.tool_calls'),list):interaction['tool_calls']=copy.deepcopy(attrs['legacy.tool_calls'])
        elif kind=='tool' and isinstance(attrs.get('legacy.tool_call'),dict):interaction['tool_calls']=[copy.deepcopy(attrs['legacy.tool_call'])]
        semantic={key:value for key,value in interaction.items() if key not in {'_interactionIndex','_payloadDeferred','_payloadVersion'}}
        version={'format':1,'workspace_id':row.get('workspace_id'),'bucket':row.get('trace_bucket'),
                 'row_revision':str(row.get('revision')),'payload_revision':row['payload_revision'],'interaction':semantic}
        interaction['_payloadVersion']=hashlib.sha256(json.dumps(version,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        return interaction

    def _section(self,token,workspace,route,row,name):
        after=-1;parts=[];size=0;count=0;expected=None
        while True:
            page=self.authorized.read_payload(token,workspace,route['trace_bucket'],route['trace_id'],row['span_id'],row['payload_revision'],name,after_chunk=after,limit=4)
            chunks=page.get('chunks')
            if not isinstance(chunks,list) or len(chunks)>4:raise ValueError('invalid bounded payload page')
            if page.get('available') is False:
                if chunks or page.get('next_chunk') is not None or count:raise ValueError('inconsistent unavailable payload section')
                return None
            if not chunks:raise ValueError('payload section is incomplete')
            total=_integer(page.get('chunk_count'))
            if total is None or not 1<=total<=MAX_PAYLOAD_CHUNKS or (expected is not None and expected!=total):raise ValueError('payload section count changed')
            expected=total
            for chunk in chunks:
                if _integer(chunk.get('chunk_no'))!=after+1 or not isinstance(chunk.get('body'),str):raise ValueError('payload chunks are not contiguous')
                body=chunk['body'];size+=len(body.encode('utf-8'));count+=1
                if size>MAX_PAYLOAD_BYTES or count>MAX_PAYLOAD_CHUNKS:raise CompatibilityLimitError('Payload section exceeds bounded compatibility read')
                parts.append(body);after+=1
            next_chunk=page.get('next_chunk')
            if next_chunk is None:
                if count!=expected:raise ValueError('payload section was truncated')
                return ''.join(parts)
            if count>=expected or _integer(next_chunk)!=after:raise ValueError('payload page cursor did not advance exactly')

    def _restore_original(self,text,row,metadata,require_capsule=False):
        try:source=json.loads(text)
        except (ValueError,TypeError):raise ValueError('original interaction section is invalid') from None
        if not isinstance(source,dict):raise ValueError('original interaction must be an object')
        if source.get('format')=='agent-insight.trace-item':
            if source.get('version')!=1 or source.get('kind')!='interaction':raise ValueError('unsupported original interaction capsule')
            raw=source.get('value')
        elif require_capsule:raise ValueError('original interaction capsule is missing')
        else:raw=source
        interaction=copy.deepcopy(metadata)
        if isinstance(raw,dict):interaction.update(copy.deepcopy(raw))
        else:interaction.update(role='trace',trace_kind='chain',content=json.dumps(raw,ensure_ascii=False),raw=copy.deepcopy(raw))
        interaction.update({'spanId':metadata['spanId'],'parentSpanId':metadata['parentSpanId'],'traceId':metadata['traceId'],
            '_interactionIndex':metadata['_interactionIndex'],'_payloadDeferred':False,'_payloadVersion':metadata['_payloadVersion']})
        if row.get('execution_status')=='failed':interaction.update(status='error',trace_status='error')
        return interaction

    def _full(self,token,workspace,route,row,metadata,context):
        compact=_object(row.get('attributes_json'));compact={**compact,**_object(compact.get('span'))}
        if route.get('source_namespace','').startswith('trace.bundle.') or compact.get('legacy.interaction_section')=='legacy_interaction':
            text=self._section(token,workspace,route,row,'legacy_interaction')
            return self._restore_original(text,row,metadata,route.get('source_namespace','').startswith('trace.bundle.'))
        sections={name:self._section(token,workspace,route,row,name) for name in ('input','output','attributes')}
        if sum(len(value.encode('utf-8')) for value in sections.values() if value is not None)>MAX_PAYLOAD_BYTES:
            raise CompatibilityLimitError('Payload bundle exceeds64MiB compatibility budget')
        attrs=_object(sections['attributes']);resource=_object(attrs.get('resource'));attrs=_object(attrs.get('span'))
        if attrs.get('legacy.interaction_section')=='legacy_interaction':
            text=self._section(token,workspace,route,row,'legacy_interaction')
            return self._restore_original(text,row,metadata)
        interaction=copy.deepcopy(metadata)
        raw={}
        for key in ('agent_insight.raw_interaction','agent_insight.interaction','legacy.interaction'):
            raw=_object(attrs.get(key))
            if raw:break
        interaction.update(copy.deepcopy(raw))
        if isinstance(raw.get('usage'),dict):
            original=_usage(raw['usage']);current=metadata.get('usage',{})
            interaction['usage']={**current,**copy.deepcopy(raw['usage']),**original}
            if 'input' in interaction['usage'] and 'output' in interaction['usage']:
                interaction['usage'].pop('missing_context',None)
                if 'total' not in original:interaction['usage']['total']=interaction['usage']['input']+interaction['usage']['output']
        agent=resource.get('agent.name') or resource.get('service.name')
        if agent and 'agent' not in raw:interaction['agent']=agent
        if row.get('kind')!='tool' and isinstance(attrs.get('legacy.role'),str) and 'role' not in raw:interaction['role']=attrs['legacy.role']
        parameters={'gen_ai.request.temperature':'temperature','gen_ai.request.max_tokens':'max_tokens','gen_ai.request.top_p':'top_p','gen_ai.response.finish_reasons':'finish_reason'}
        for source,target in parameters.items():
            if source in attrs and target not in raw:interaction[target]=copy.deepcopy(attrs[source])
        if 'content' not in raw and sections['output'] is not None and row.get('kind')!='tool':interaction['content']=sections['output']
        if 'requestMessages' not in raw and sections['input'] is not None and row.get('kind')!='tool':
            text=sections['input']
            try:messages=json.loads(text)
            except ValueError:messages=None
            interaction['requestMessages']=messages if isinstance(messages,list) and all(isinstance(m,dict) for m in messages) else [{'role':'user','content':text}]
        if row.get('kind')=='tool':
            interaction['role']='tool';call=copy.deepcopy(metadata['tool_calls'][0])
            original_calls=raw.get('tool_calls')
            if isinstance(original_calls,list) and len(original_calls)==1 and isinstance(original_calls[0],dict):
                call.update(copy.deepcopy(original_calls[0]))
            elif isinstance(attrs.get('legacy.original_span_id'),str) and attrs['legacy.original_span_id']:
                call['id']=attrs['legacy.original_span_id']
            if sections['input'] is not None and 'arguments' not in call.get('function',{}):call.setdefault('function',{})['arguments']=sections['input']
            if sections['output'] is not None:
                call.setdefault('output',sections['output']);call.setdefault('result',sections['output'])
            interaction['tool_calls']=[call]
        if row.get('execution_status')=='failed':
            interaction.update(status='error',trace_status='error')
            if not interaction.get('error_summary'):
                message=next((attrs[k] for k in ('error.message','exception.message','otel.status_description') if isinstance(attrs.get(k),str) and attrs[k]),None)
                if message is None and not interaction.get('error'):
                    source=self._section(token,workspace,route,row,'otlp_span')
                    message=_object(_object(source).get('status')).get('message')
                if isinstance(message,str) and message:interaction['error_summary']=message
        for field,source in [('query','legacy.session_query'),('label','legacy.session_label')]:
            if context.get(field) is None and attrs.get(source) is not None:context[field]=attrs[source]
        interaction.update({'spanId':metadata['spanId'],'parentSpanId':metadata['parentSpanId'],'traceId':metadata['traceId'],
            '_interactionIndex':metadata['_interactionIndex'],'_payloadDeferred':False,'_payloadVersion':metadata['_payloadVersion']})
        return interaction

    def _owner(self,summary):
        owner=summary.get('owner_username')
        control=getattr(self.queries,'control',None)
        if owner is None and control is not None and summary.get('owner_principal_id'):
            with control.read_transaction() as con:
                row=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(summary['owner_principal_id'],)).fetchone()
                if row:owner=row[0]
        return owner if owner is not None else summary.get('owner_principal_id')

    def _postflight(self,token,workspace,route):
        current=self.queries.route(token,workspace,route['trace_id'])
        if current['trace_bucket']!=route['trace_bucket']:raise Forbidden('Trace route changed during compatibility read')

    def _langfuse_session(self,token,workspace,route,summary,view,index):
        metadata=None;nodes=[];version=None
        for row in self._spans(token,workspace,route):
            text=self._section(token,workspace,route,row,'legacy_trace')
            if text is not None:
                if metadata is not None:raise ValueError('duplicate original Session capsule')
                metadata=_object(text);version=row['payload_revision']
            capsule=_object(self._section(token,workspace,route,row,'legacy_interaction'))
            if capsule.get('format')!='agent-insight.trace-item' or capsule.get('version')!=1 or capsule.get('kind')!='langfuse_node' or capsule.get('index')!=len(nodes):raise ValueError('invalid original Langfuse node capsule')
            nodes.append(capsule.get('value'))
        if not metadata or metadata.get('format')!='agent-insight.trace-bundle-node' or metadata.get('primary_count')!=len(nodes):raise ValueError('original Langfuse tree is incomplete')
        session=metadata.get('session');execution=metadata.get('execution')
        if not isinstance(session,dict) or not isinstance(execution,dict):raise TraceNotFound('Original Session is unavailable')
        raw=session.get('interactions')
        if not isinstance(raw,list):raise ValueError('original secondary interactions are invalid')
        interactions=[]
        for position,value in enumerate(raw):
            item=copy.deepcopy(value) if isinstance(value,dict) else {'raw':copy.deepcopy(value)}
            item.update(_interactionIndex=position,_payloadDeferred=False,_payloadVersion=version);interactions.append(item)
        facts={'status':summary.get('execution_status'),'latency':execution.get('latency'),'tokens':execution.get('tokens'),'cost':execution.get('cost'),'timestamp':execution.get('timestamp'),'framework':execution.get('framework')}
        if view=='interaction':
            if index>=len(interactions):raise InvalidInteractionIndex('Interaction index out of range')
            result={'taskId':session['taskId'],'index':index,'interaction':interactions[index],'execution':facts}
        else:
            result={'taskId':session['taskId'],'label':session.get('label'),'query':session.get('query'),'user':self._owner(summary),
                'startTime':int(datetime.datetime.fromisoformat(session['startTime'].replace('Z','+00:00')).timestamp()*1000),
                'interactionCount':len(interactions),'interactions':interactions,'langfuseTraceNodes':nodes,'execution':facts}
        if _bytes(result)>MAX_FULL_BYTES:raise CompatibilityLimitError('Original Langfuse Session exceeds128MiB')
        self._postflight(token,workspace,route)
        return result

    def session_page(self,token,workspace,trace,cursor=None,span_id=None,index=0):
        from .control import Conflict
        route=self.queries.route(token,workspace,trace)
        summary=self.queries.summary(token,workspace,trace).get('trace')
        if not summary:raise TraceNotFound('Trace has no indexed facts')
        if not cursor and not span_id and int(summary.get('span_count') or 0)<=500 and route.get('source_namespace','').startswith(('trace.bundle.','agent.record.','collector.source.v1')):
            return self.session(token,workspace,trace,view='structure')
        scope=self.queries.iam.scope(token)
        query=hashlib.sha256(json.dumps([workspace,trace,str(summary['revision']),'session-page-v1']).encode()).hexdigest()
        after=self.queries._decode(cursor,scope.fingerprint,query) if cursor else (0,'')
        if span_id:
            row=self.authorized.read_span(token,workspace,route['trace_bucket'],trace,span_id)
            if not row:raise TraceNotFound('Span unavailable')
            result={'interaction':self._full(token,workspace,route,row,self._metadata(row,index,summary),{})}
        else:
            rows=self.authorized.read_spans(token,workspace,route['trace_bucket'],trace,limit=500,time_after=after)
            interactions=[self._metadata(row,index+i,summary) for i,row in enumerate(rows)]
            next_cursor=None
            if len(rows)==500:
                last=rows[-1]
                next_cursor=self.queries._encode({'version':1,'scope':scope.fingerprint,'query':query,'created_at_ms':int(last.get('started_at_ms') or 0),'trace_id':last['span_id']})
            result={'taskId':trace,'user':self._owner(summary),'startTime':summary.get('started_at_ms'),
                    'interactions':interactions,'interactionCount':summary.get('span_count'),
                    'nextCursor':next_cursor,'paged':True,'execution':{'status':summary.get('execution_status')}}
        current=self.queries.summary(token,workspace,trace).get('trace')
        if not current or str(current['revision'])!=str(summary['revision']):raise Conflict('Trace changed; refresh')
        self._postflight(token,workspace,route)
        return result

    def session(self,token,workspace_id,trace_id,view='structure',index=None):
        if view not in {'structure','interaction','interactions','full'}:raise ValueError('unknown legacy Trace view')
        if view=='interaction' and (type(index) is not int or not 0<=index<MAX_STRUCTURE_SPANS):raise InvalidInteractionIndex('Interaction index out of range')
        route=self.queries.route(token,workspace_id,trace_id)
        if not route:raise TraceNotFound('Trace is not available')
        summary=self.queries.summary(token,workspace_id,trace_id).get('trace')
        if summary is None:raise TraceNotFound('Trace has no indexed facts')
        source_langfuse=False
        if route.get('source_namespace')=='collector.source.v1' and getattr(self.queries,'control',None) is not None:
            from .collector_sources import primary_kind
            source_langfuse=primary_kind(self.queries.control,token,workspace_id,route)=='langfuse_node'
        if source_langfuse or route.get('source_namespace','').startswith('trace.bundle.') and route['source_namespace'].endswith('.lf'):
            return self._langfuse_session(token,workspace_id,route,summary,view,index)
        input_tokens=_integer(summary.get('input_tokens'));output_tokens=_integer(summary.get('output_tokens'))
        start=_integer(summary.get('started_at_ms'));end=_integer(summary.get('ended_at_ms'))
        execution={'status':summary.get('execution_status'),'framework':summary.get('framework'),
            'latency':end-start if start is not None and end is not None else None,
            'tokens':input_tokens+output_tokens if input_tokens is not None and output_tokens is not None else None,
            'cost':None,'timestamp':_iso(start)}
        base={'taskId':trace_id,'label':summary.get('label'),'query':summary.get('query'),'user':self._owner(summary),
              'startTime':start,'interactionCount':0,'interactions':[],'execution':execution}
        source_rows=None
        if route.get('source_namespace')=='collector.source.v1':
            from .collector_sources import CollectorSourcePending, _ms as source_ms
            source_rows=list(self._spans(token,workspace_id,route));capsule=None
            for source_row in source_rows:
                text=self._section(token,workspace_id,route,source_row,'legacy_trace')
                if text is not None:
                    if capsule is not None:raise CollectorSourcePending('Collector Session metadata is ambiguous')
                    capsule=_object(text)
            if capsule is None:raise CollectorSourcePending('Collector Session metadata is unavailable')
            captured=capsule.get('session');original=capsule.get('execution')
            if captured is None:raise TraceNotFound('Original Session is unavailable')
            if not isinstance(captured,dict) or not isinstance(original,dict):raise CollectorSourcePending('Collector Session metadata differs')
            base.update(taskId=captured['taskId'],label=captured.get('label'),query=captured.get('query'),startTime=source_ms(captured['startTime']))
            for field in ('framework','tokens','latency','cost','timestamp'):
                if field in original:execution[field]=copy.deepcopy(original[field])
        rows=[];tools={};size=_bytes(base);position=-1;selected=None
        for row in source_rows if source_rows is not None else self._spans(token,workspace_id,route):
            attrs=_object(row.get('attributes_json'));attrs={**attrs,**_object(attrs.get('span'))}
            if attrs.get('legacy.tool_structure_oversized') and view=='structure':
                raise CompatibilityLimitError('Tool structure exceeds compact budget; use complete Trace view')
            if attrs.get('legacy.transfer_kind')=='carrier':
                if attrs.get('legacy.transfer_has_session') is False:
                    self._postflight(token,workspace_id,route)
                    raise TraceNotFound('Original Session is unavailable')
                if row.get('kind')=='tool' and row.get('parent_span_id'):
                    call=self._metadata(row,-1,summary)['tool_calls'][0]
                    dependency={'call':call,'span_id':row['span_id'],'revision':str(row.get('revision')),'payload_revision':row['payload_revision']}
                    size+=_bytes(dependency)+1
                    if size>MAX_STRUCTURE_BYTES:raise CompatibilityLimitError('Trace tool structure exceeds16MiB compatibility budget')
                    tools.setdefault(row['parent_span_id'],[]).append(dependency)
                continue
            position+=1
            metadata=self._metadata(row,position,summary)
            for field,source in [('query','legacy.session_query'),('label','legacy.session_label')]:
                if source_rows is None and base.get(field) is None and attrs.get(source) is not None:base[field]=attrs[source]
            if view=='interaction' and position==index:selected=(row,metadata)
            size+=_bytes(metadata)+1
            if size>MAX_STRUCTURE_BYTES:raise CompatibilityLimitError('Trace structure exceeds16MiB compatibility response budget')
            if view in {'full','interactions'}:rows.append(row)
            base['interactions'].append(metadata)
        for metadata in base['interactions']:
            dependencies=tools.get(metadata['spanId'])
            if not dependencies or metadata['role']!='assistant' or metadata.get('tool_calls'):continue
            metadata['tool_calls']=[copy.deepcopy(item['call']) for item in dependencies]
            # Hidden tool facts may change independently of the message payload.
            version={'message':metadata['_payloadVersion'],'tools':dependencies}
            metadata['_payloadVersion']=hashlib.sha256(json.dumps(version,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        if view=='interaction':
            if selected is None:raise InvalidInteractionIndex('Interaction index out of range')
            row,metadata=selected
            interaction=self._full(token,workspace_id,route,row,metadata,{})
            result={'taskId':trace_id,'index':index,'interaction':interaction,'execution':execution}
            if _bytes(result)>MAX_FULL_BYTES:raise CompatibilityLimitError('Interaction exceeds128MiB compatibility response budget')
            self._postflight(token,workspace_id,route)
            return result
        base['interactionCount']=len(base['interactions'])
        if view!='structure':
            size=_bytes({**base,'interactions':[]})
            for position,row in enumerate(rows):
                loaded=self._full(token,workspace_id,route,row,base['interactions'][position],base)
                size+=_bytes(loaded)+1
                if size>MAX_FULL_BYTES:raise CompatibilityLimitError('Trace exceeds128MiB compatibility response budget')
                base['interactions'][position]=loaded
        if _bytes(base)>(MAX_STRUCTURE_BYTES if view=='structure' else MAX_FULL_BYTES):raise CompatibilityLimitError('Compatibility response exceeds its explicit budget')
        self._postflight(token,workspace_id,route)
        return base
