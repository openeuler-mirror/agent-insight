"""Import frozen legacy exports through the normal authenticated OTLP accept path.

Only Session/Execution are recognized. Generic interaction arrays (including nested
function tool_calls) and OTLP-shaped spans are supported; Langfuse trees and other
shapes are quarantined. Execution-only rows become explicitly synthetic summaries.
Missing span IDs/times are labeled synthetic/unknown-duration, never historical
reconstructions. Old user credentials, settings and arbitrary row columns are not
copied. Keep source_id stable for one source; replay the same verified export to
resume using deterministic receipt keys. Re-exported revisions need a later delta
migration policy. Conversion holds one legacy row (max128MiB) plus compact Execution
metadata; packets spool privately to disk before any sender is called.
"""
from collections import Counter, defaultdict
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from .legacy import verify_export, LegacyValidationError, _read_export_file, _json_bytes, _valid_cell
from .observations import _normalize

MAX_ROW_BYTES = 128 * 1024 * 1024
MAX_PACKET_BYTES = 4 * 1024 * 1024
SESSION_FIELDS = {'id','taskId','user','startTime','endTime','interactions','query','label','model','langfuseTraceNodes'}
EXECUTION_FIELDS = {'id','taskId','user','timestamp','latency','query','finalResult','agentName','framework','model','inputTokens','outputTokens','executionStatus','isSubagent','parentExecutionId','rootExecutionId'}
INTERACTION_FIELDS = {'role','content','spanId','parentSpanId','traceId','name','model','usage','timestamp','timeInfo','requestMessages','tool_calls','agent'}


class _Quarantine(ValueError):
    pass


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _cell(cell):
    kind,value=cell
    if kind=='null': return None
    if kind=='text': return value
    if kind=='integer': return int(value)
    if kind=='real': return float.fromhex(value)
    raise _Quarantine('unsupported_blob_field')


def _rows(root,table,fields):
    digest=hashlib.sha256();count=0
    with _read_export_file(root,table['file']) as stream:
        while True:
            line=stream.readline(MAX_ROW_BYTES+1)
            if not line: break
            if len(line)>MAX_ROW_BYTES: raise LegacyValidationError('Legacy row exceeds128MiB conversion limit')
            try:
                item=json.loads(line);values=item['values']
                if set(item)!={'values'} or len(values)!=len(table['columns']) or not all(_valid_cell(c) for c in values) or line!=_json_bytes(item)+b'\n':
                    raise ValueError()
            except (ValueError,KeyError,TypeError) as exc: raise LegacyValidationError('Export changed during import preflight') from exc
            digest.update(line);count+=1
            selected={}
            for column,value in zip(table['columns'],values):
                if column['name'] in fields:
                    try: selected[column['name']]=_cell(value)
                    except _Quarantine: selected[column['name']]=None;selected['_unsupported_blob']=True
            yield selected
    if count!=table['row_count'] or digest.hexdigest()!=table['rows_sha256']:
        raise LegacyValidationError('Export changed during import preflight')


def _record_key(table,row):
    return _hash([table,row.get('id'),row.get('taskId'),row.get('user')])


def _identity(row):
    user=row.get('user');key=row.get('taskId') or row.get('id')
    if not isinstance(user,str) or not user or not isinstance(key,str) or not key: raise _Quarantine('missing_source_identity')
    return user,key


def _time(value):
    if type(value) is int and value>0: return value
    if isinstance(value,str):
        try:
            parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
            if parsed.tzinfo is None: raise ValueError()
            result=int(parsed.timestamp()*1000)
            if result>0:return result
        except (ValueError,OverflowError): pass
    raise _Quarantine('unsupported_timestamp')


def _text(value):
    if isinstance(value,str): return value
    return _json(value)


def _attrs(values):
    result=[]
    for key,value in values.items():
        if value is None:continue
        if type(value) is bool: encoded={'boolValue':value}
        elif type(value) is int: encoded={'intValue':str(value)}
        elif isinstance(value,str): encoded={'stringValue':value}
        else: encoded={'stringValue':_json(value)}
        result.append({'key':key,'value':encoded})
    return result


def _span_id(value,seed):
    if isinstance(value,str) and re.fullmatch('[0-9a-fA-F]{16}',value) and int(value,16): return value.lower(),False
    return _hash(['span',seed,value])[:16],True


def _usage(usage):
    if usage is None:return {}
    if not isinstance(usage,dict):raise _Quarantine('unsupported_usage')
    values={}
    for source,target in [('input_tokens','gen_ai.usage.input_tokens'),('output_tokens','gen_ai.usage.output_tokens')]:
        if source in usage:
            value=usage[source]
            if type(value) is not int or not 0<=value<=2**53-1:raise _Quarantine('unsupported_usage')
            values[target]=value
    return values


def _span(item,index,row,execution,trace,seed):
    if not isinstance(item,dict):raise _Quarantine('unsupported_interaction_shape')
    sid,synthetic=_span_id(item.get('spanId'),[seed,'interaction',index])
    original=item.get('spanId')
    parent=item.get('parentSpanId')
    # A named legacy parent must hash to the same ID as its corresponding interaction.
    if parent:parent=_span_id(parent,[seed,'named'])[0]
    data={'legacy.source_record_id':row.get('id'),'legacy.source_task_id':row.get('taskId'),
          'legacy.original_span_id':original,'legacy.original_trace_id':item.get('traceId'),
          'legacy.identity_synthesized':synthetic}
    if index==0:data.update({'legacy.session_query':row.get('query'),'legacy.session_label':row.get('label')})
    if 'startTimeUnixNano' in item or 'endTimeUnixNano' in item:
        allowed={'name','kind','attributes','events','links','status','startTimeUnixNano','endTimeUnixNano'}
        out={k:v for k,v in item.items() if k in allowed}
        if not isinstance(out.get('attributes',[]),list):raise _Quarantine('unsupported_interaction_shape')
        existing={a.get('key') for a in out.get('attributes',[]) if isinstance(a,dict)}
        if existing.intersection(data):raise _Quarantine('reserved_migration_attribute')
        out['attributes']=out.get('attributes',[])+_attrs(data)
        out.update(traceId=trace,spanId=sid)
        if parent:out['parentSpanId']=parent
        return out,[]
    info=item.get('timeInfo') or {}
    if not isinstance(info,dict):raise _Quarantine('unsupported_timestamp')
    raw_start=info.get('created') or item.get('timestamp')
    start=_time(raw_start if raw_start is not None else row.get('startTime'))
    end=_time(info['completed']) if info.get('completed') is not None else start
    if end<start:raise _Quarantine('unsupported_timestamp')
    if info.get('completed') is None:data['legacy.timing']='unknown_duration' if raw_start else 'session_anchor_unknown_duration'
    model=item.get('model') or execution.get('model') or row.get('model')
    data.update({'legacy.role':item.get('role'),'gen_ai.response.model':model,
                 'input.value':_text(item['requestMessages']) if item.get('requestMessages') is not None else None,
                 'output.value':_text(item['content']) if item.get('content') is not None else None})
    data.update(_usage(item.get('usage')))
    span={'traceId':trace,'spanId':sid,'name':item.get('name') or ('legacy.'+str(item.get('role') or 'interaction')),
          'kind':3 if model else 1,'startTimeUnixNano':str(start*1000000),'endTimeUnixNano':str(end*1000000),
          'attributes':_attrs(data),'status':{'code':0}}
    if parent:span['parentSpanId']=parent
    tools=item.get('tool_calls') or []
    if not isinstance(tools,list):raise _Quarantine('unsupported_tool_calls')
    extra=[]
    for tool_index,tool in enumerate(tools):
        if not isinstance(tool,dict) or not isinstance(tool.get('function'),dict):raise _Quarantine('unsupported_tool_calls')
        function=tool['function'];name=function.get('name')
        if not isinstance(name,str) or not name:raise _Quarantine('unsupported_tool_calls')
        tool_id,tool_synthetic=_span_id(tool.get('id'),[seed,'tool',index,tool_index])
        timing=tool.get('timing') or {}
        if not isinstance(timing,dict):raise _Quarantine('unsupported_timestamp')
        tool_start=_time(timing['started_at']) if timing.get('started_at') is not None else start
        tool_end=_time(timing['completed_at']) if timing.get('completed_at') is not None else tool_start
        extra.append({'traceId':trace,'spanId':tool_id,'parentSpanId':sid,'name':name,'kind':3,
            'startTimeUnixNano':str(tool_start*1000000),'endTimeUnixNano':str(tool_end*1000000),
            'attributes':_attrs({'gen_ai.tool.name':name,'input.value':_text(function.get('arguments')),
                'output.value':_text(tool.get('output',tool.get('result'))),'legacy.original_span_id':tool.get('id'),
                'legacy.identity_synthesized':tool_synthetic,'legacy.timing':None if timing.get('completed_at') else 'unknown_duration'}),
            'status':{'code':2 if tool.get('state') in ('error','failed') else 0}})
    return span,extra


def _convert(row,execution,source_id,source_hash,summary=False):
    user,key=_identity(row)
    if row.get('_unsupported_blob') or execution.get('_unsupported_blob'):raise _Quarantine('unsupported_blob_field')
    nodes=row.get('langfuseTraceNodes')
    if nodes not in (None,'','[]'):raise _Quarantine('unsupported_langfuse_tree')
    seed=[source_id,user,key];trace=_hash(['trace',seed])[:32]
    if summary:
        start=_time(row.get('timestamp'));latency=row.get('latency')
        if latency is not None and (type(latency) not in (int,float) or latency<0):raise _Quarantine('unsupported_timestamp')
        end=start+int(latency or 0)
        attrs={'legacy.summary_only':True,'legacy.source_record_id':row.get('id'),'legacy.source_task_id':row.get('taskId'),
            'input.value':row.get('query'),'output.value':row.get('finalResult'),'gen_ai.response.model':row.get('model'),
            'legacy.timing':'unknown_duration' if latency is None else None}
        attrs.update(_usage({k:row[v] for k,v in [('input_tokens','inputTokens'),('output_tokens','outputTokens')] if row.get(v) is not None}))
        spans=[{'traceId':trace,'spanId':_hash(['summary',seed])[:16],'name':'legacy.execution.summary','kind':1,
            'startTimeUnixNano':str(start*1000000),'endTimeUnixNano':str(end*1000000),'attributes':_attrs(attrs),
            'status':{'code':2 if row.get('executionStatus') in ('failed','error') else 0}}]
        warnings=[]
    else:
        raw=row.get('interactions')
        try:interactions=json.loads(raw) if isinstance(raw,str) and raw else []
        except ValueError:raise _Quarantine('invalid_interactions_json') from None
        if not isinstance(interactions,list):raise _Quarantine('unsupported_interaction_shape')
        if len(interactions)>100000:raise _Quarantine('too_many_interactions')
        if not interactions:
            anchor=dict(execution);anchor.update(id=row.get('id'),taskId=key,user=user,timestamp=row.get('startTime'),query=row.get('query'),finalResult=None,latency=None)
            if row.get('endTime') is not None:anchor['latency']=_time(row['endTime'])-_time(row.get('startTime'))
            return _convert(anchor,execution,source_id,source_hash,True)
        spans=[];warnings=set()
        # Stable named IDs allow parent references without relying on interaction order.
        names={item.get('spanId') for item in interactions if isinstance(item,dict) and isinstance(item.get('spanId'),str)}
        for index,item in enumerate(interactions):
            span,tools=_span(item,index,row,execution,trace,seed)
            if isinstance(item.get('spanId'),str) and item['spanId'] in names:
                span['spanId']=_span_id(item['spanId'],[seed,'named'])[0]
                for tool in tools:tool['parentSpanId']=span['spanId']
            spans.extend([span,*tools])
            if 'startTimeUnixNano' not in item:
                warnings.update(set(item)-INTERACTION_FIELDS)
                if isinstance(item.get('usage'),dict):warnings.update('usage.'+k for k in set(item['usage'])-{'input_tokens','output_tokens'})
        warnings=sorted(warnings)
    if len({s['spanId'] for s in spans})!=len(spans):raise _Quarantine('duplicate_span_identity')
    resource={'service.name':execution.get('agentName') or 'legacy-session','agent.name':execution.get('agentName') or 'legacy-session',
        'telemetry.sdk.name':execution.get('framework') or 'legacy','agent_insight.source_namespace':'legacy.sqlite.'+_hash(source_id),
        'legacy.source_fingerprint':source_hash,'legacy.source_user_hash':_hash(user),
        'legacy.execution_id':execution.get('id'),'legacy.execution_input_tokens':execution.get('inputTokens'),
        'legacy.execution_output_tokens':execution.get('outputTokens')}
    return spans,_attrs(resource),warnings


def _packets(spans,resource,max_spans,max_bytes):
    def body(items):return {'resourceSpans':[{'resource':{'attributes':resource},'scopeSpans':[{'scope':{'name':'agent-insight.legacy-import.v1'},'spans':items}]}]}
    packets=[];current=[];overhead=len(_json(body([])).encode());size=overhead
    for span in spans:
        span_bytes=len(_json(span).encode())
        required=span_bytes+(1 if current else 0)
        if current and (len(current)>=max_spans or size+required>max_bytes):
            packets.append(body(current));current=[];size=overhead;required=span_bytes
        if size+required>max_bytes:raise _Quarantine('packet_too_large')
        current.append(span);size+=required
    if current:packets.append(body(current))
    return packets


def _write_report(path,report,first=False):
    fd,name=tempfile.mkstemp(prefix='.trace-import-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as out:out.write(_json(report)+'\n');out.flush();os.fsync(out.fileno())
        if first:os.link(name,path)
        else:os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)


def import_legacy_traces(export_dir,bindings,*,source_id,sender=None,dry_run=True,report_path=None,max_spans_per_packet=256,max_packet_bytes=MAX_PACKET_BYTES):
    """Plan by default; apply explicitly with sender(credential,workspace,body,receipt_key=...).

    bindings maps exact old user strings to credential/workspace_id. report_path, if
    supplied, must be new in a private directory; checkpoints fsync after each ack.
    A partial/uncertain sender outcome is resumable by replaying this frozen export,
    using the same source_id, bindings and packet limits. No rollback is automatic.
    """
    if not isinstance(source_id,str) or not source_id or len(source_id)>512:raise ValueError('Explicit stable source_id required')
    if not isinstance(bindings,dict):raise ValueError('Explicit user bindings required')
    for user,binding in bindings.items():
        if (not isinstance(user,str) or not user or not isinstance(binding,dict) or set(binding)!={'credential','workspace_id'}
            or not isinstance(binding['credential'],str) or not re.fullmatch(r'(api|session)_[A-Za-z0-9_-]{43}',binding['credential'])
            or not isinstance(binding['workspace_id'],str) or not binding['workspace_id']):raise ValueError('Invalid explicit user binding')
    if type(dry_run) is not bool or (not dry_run and not callable(sender)):raise ValueError('Apply requires an explicit sender')
    if type(max_spans_per_packet) is not int or not 1<=max_spans_per_packet<=4096 or type(max_packet_bytes) is not int or not 512<=max_packet_bytes<=MAX_PACKET_BYTES:raise ValueError('Invalid bounded packet limits')
    output=Path(report_path).absolute() if report_path is not None else None
    if output and (output.exists() or output.is_symlink() or not output.parent.is_dir() or output.parent.is_symlink() or output.parent.stat().st_mode&0o077):raise ValueError('Report must be new in a private directory')
    root=Path(export_dir).absolute();manifest=verify_export(root);tables={t['name']:t for t in manifest['tables']}
    report={'format_version':1,'status':'planning','source_id_hash':_hash(source_id),'source_content_sha256':manifest['source_content_sha256'],
        'source_schema_sha256':manifest['source_schema_sha256'],'planned_records':0,'planned_packets':0,'planned_spans':0,
        'accepted_packets':0,'duplicate_packets':0,'execution_metadata_rows':0,'quarantined':[],'unsupported_fields':[],
        'unsupported_tables':{name:t['row_count'] for name,t in tables.items() if name not in {'Session','Execution'} and t['row_count']},'receipts':[]}
    for table,allowed in [('Session',SESSION_FIELDS),('Execution',EXECUTION_FIELDS)]:
        if table in tables:
            unsupported=sorted({c['name'] for c in tables[table]['columns']}-allowed)
            if unsupported:report['unsupported_fields'].append({'table':table,'fields':unsupported,'scope':'columns'})
    executions=defaultdict(list);sessions=Counter();consumed=set()
    if 'Execution' in tables:
        for row in _rows(root,tables['Execution'],EXECUTION_FIELDS):
            try:executions[_identity(row)].append(row)
            except _Quarantine as error:report['quarantined'].append({'table':'Execution','record_key':_record_key('Execution',row),'reason':str(error)})
    if 'Session' in tables:
        for row in _rows(root,tables['Session'],{'user','taskId','id'}):
            try:sessions[_identity(row)]+=1
            except _Quarantine:pass
    with tempfile.TemporaryFile(mode='w+b') as spool:
        def stage(table,row,execution,summary=False):
            record_key=_record_key(table,row)
            try:
                user,key=_identity(row)
                if user not in bindings:raise _Quarantine('unmapped_source_user')
                if table=='Session' and sessions[(user,key)]!=1:raise _Quarantine('ambiguous_session_identity')
                spans,resource,warnings=_convert(row,execution,source_id,manifest['source_content_sha256'],summary)
                packets=_packets(spans,resource,max_spans_per_packet,max_packet_bytes)
                for packet in packets:_normalize(packet,bindings[user]['workspace_id'])
                for index,packet in enumerate(packets):
                    receipt='legacy:'+_hash([source_id,manifest['source_content_sha256'],table,record_key,index,packet])
                    spool.write((_json({'source_user':user,'source_table':table,'source_record_key':record_key,'body':packet,'receipt_key':receipt})+'\n').encode())
                report['planned_records']+=1;report['planned_packets']+=len(packets);report['planned_spans']+=len(spans)
                if warnings:report['unsupported_fields'].append({'table':table,'record_key':record_key,'fields':warnings})
                return True
            except (ValueError,TypeError,OverflowError,KeyError) as error:
                report['quarantined'].append({'table':table,'record_key':record_key,'reason':str(error) if isinstance(error,_Quarantine) else 'unsupported_or_invalid_record'})
                return False
        if 'Session' in tables:
            for row in _rows(root,tables['Session'],SESSION_FIELDS):
                try:matches=executions.get(_identity(row),[])
                except _Quarantine:matches=[]
                for matched in matches:consumed.add(_record_key('Execution',matched))
                execution=matches[0] if len(matches)==1 else {}
                converted=stage('Session',row,execution)
                if converted and len(matches)==1:report['execution_metadata_rows']+=1
                if len(matches)>1 or (matches and not converted):
                    for matched in matches:report['quarantined'].append({'table':'Execution','record_key':_record_key('Execution',matched),'reason':'ambiguous_execution_metadata' if len(matches)>1 else 'paired_session_quarantined'})
        for matches in executions.values():
            for row in matches:
                record_key=_record_key('Execution',row)
                if record_key in consumed:continue
                if len(matches)>1:
                    report['quarantined'].append({'table':'Execution','record_key':record_key,'reason':'ambiguous_execution_identity'})
                else:stage('Execution',row,row,True)
        # No sender sees packets until every consumed source file has passed a fresh hash check.
        report['status']='dry_run' if dry_run else 'prepared'
        if output:_write_report(output,report,True)
        if dry_run:return report
        spool.seek(0)
        for line in spool:
            staged=json.loads(line);binding=bindings[staged['source_user']]
            try:
                ack=sender(binding['credential'],binding['workspace_id'],staged['body'],receipt_key=staged['receipt_key'])
                if not isinstance(ack,dict) or ack.get('state') not in {'accepted','prepared','indexed'} or not isinstance(ack.get('batch_id'),str) or not re.fullmatch('[A-Za-z0-9_-]{1,256}',ack['batch_id']):raise ValueError()
                trace_ids=ack.get('trace_ids',[])
                if not isinstance(trace_ids,list) or len(trace_ids)>4096 or not all(isinstance(t,str) and re.fullmatch('[A-Za-z0-9_-]{1,256}',t) for t in trace_ids):raise ValueError()
            except Exception:
                report['status']='partial';report['error']='sender_failed_or_ack_uncertain'
                if output:_write_report(output,report)
                return report
            report['accepted_packets']+=1;report['duplicate_packets']+=int(ack.get('duplicate') is True)
            report['receipts'].append({'source_table':staged['source_table'],'source_record_key':staged['source_record_key'],
                'workspace_id':binding['workspace_id'],'receipt_key':staged['receipt_key'],'batch_id':ack['batch_id'],'state':ack['state'],'trace_ids':trace_ids})
            if output:_write_report(output,report)
        report['status']='complete_with_quarantine' if report['quarantined'] else 'complete'
        if output:_write_report(output,report)
        return report


def http_sender(origin, *, timeout=15):
    """Build an explicit loopback HTTP sender; authorization is always a header."""
    from urllib.parse import urlsplit, urlunsplit
    from urllib.request import Request, build_opener, HTTPRedirectHandler
    if not isinstance(origin,str):raise ValueError('Explicit loopback origin required')
    try:
        parsed=urlsplit(origin);parsed.port
        valid=(parsed.scheme in {'http','https'} and parsed.hostname in {'localhost','127.0.0.1','::1'}
            and not parsed.username and not parsed.password and parsed.path in {'','/'}
            and not parsed.query and not parsed.fragment and '?' not in origin and '#' not in origin)
    except ValueError:valid=False
    if not valid or type(timeout) not in (int,float) or not 0<timeout<=120:raise ValueError('Explicit loopback origin and bounded timeout required')
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=build_opener(NoRedirect())
    endpoint=urlunsplit((parsed.scheme,parsed.netloc,'/v1/ingest/otlp','',''))
    def send(credential,workspace_id,body,*,receipt_key):
        if (not isinstance(credential,str) or not re.fullmatch(r'(api|session)_[A-Za-z0-9_-]{43}',credential)
            or not isinstance(workspace_id,str) or not workspace_id or workspace_id!=workspace_id.strip()
            or re.search(r'[\x00-\x1f\x7f]',workspace_id)
            or not isinstance(receipt_key,str) or not 1<=len(receipt_key)<=512 or re.search(r'[\x00-\x1f\x7f]',receipt_key)):
            raise ValueError('Destination headers cannot be represented exactly')
        encoded=_json(body).encode()
        if len(encoded)>MAX_PACKET_BYTES:raise ValueError('OTLP packet too large')
        request=Request(endpoint,data=encoded,method='POST',headers={'Content-Type':'application/json','Accept':'application/json',
            'Authorization':'Bearer '+credential,'X-Workspace-Id':workspace_id,'Idempotency-Key':receipt_key})
        with opener.open(request,timeout=timeout) as response:
            raw=response.read(MAX_PACKET_BYTES+1)
            if len(raw)>MAX_PACKET_BYTES:raise ValueError('Ingest acknowledgement too large')
            return json.loads(raw)
    return send
