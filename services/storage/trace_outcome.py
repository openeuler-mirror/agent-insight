import copy
import json
import math
import uuid

JS_TRIM_WHITESPACE=' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

from .contracts import identifier
from .control import Conflict
from .experiments import MAX_BYTES, ExperimentUnavailable, _hash, _iso, _json
from .iam import Forbidden
from .trace_metadata import TraceMetadata

SCOPE='trace-outcome'
SLOT='__trace_outcome__'


def _source(store,con,token,ws,reference,write=False):
    scope=store.iam._scope(con,token);store.iam._workspace(scope,ws,'read')
    aliases=con.execute("SELECT DISTINCT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=? AND alias_kind IN ('task','execution')",(ws,identifier(reference))).fetchall()
    if len(aliases)>1:raise Conflict('Outcome source alias is ambiguous')
    trace=aliases[0][0] if aliases else reference
    _,route=TraceMetadata(store.control)._trace(con,token,ws,trace,'write' if write else 'read')
    owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()[0]
    if write and scope.principal_id!=owner:raise Forbidden('Only the Trace owner can evaluate or cancel')
    identity=str(uuid.uuid5(uuid.NAMESPACE_URL,_json(['trace-outcome/v1',ws,owner,trace,route['incarnation']])))
    return scope,dict(route),owner,identity


def _flow(store,con,scope,ws,manifest):
    reference=manifest.get('flow_source')
    if reference is None:
        existing=con.execute("SELECT 1 FROM experiment_heads e JOIN experiment_cases c ON c.workspace_id=e.workspace_id AND c.experiment_id=e.experiment_id JOIN experiment_result_slots s ON s.workspace_id=c.workspace_id AND s.case_id=c.case_id WHERE e.workspace_id=? AND e.created_by=? AND e.scope='trace-flow-analysis' AND e.state='active' AND c.state='active' AND c.trace_id=? AND s.evaluator_id='__trace_flow_match__' AND s.status='done' AND s.selected_result_id IS NOT NULL LIMIT 1",(ws,scope.principal_id,manifest['trace_id'])).fetchone()
        if existing or manifest.get('execution_steps') is not None:raise Conflict('Outcome Flow selection appeared while preparing inputs')
        return
    if not isinstance(reference,dict) or set(reference)!={'experiment_id','machine_result_id','content_hash','run_id'}:raise ValueError('Invalid frozen Outcome flow selection')
    row=con.execute("SELECT e.created_by,e.scope,s.selected_result_id,s.status,r.content_hash,r.run_id,r.artifact_ref,r.state FROM experiment_heads e JOIN experiment_result_slots s ON s.workspace_id=e.workspace_id AND s.experiment_id=e.experiment_id JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE e.workspace_id=? AND e.experiment_id=? AND e.state='active' AND c.state='active' AND c.trace_id=? AND s.evaluator_id='__trace_flow_match__'",(ws,reference['experiment_id'],manifest['trace_id'])).fetchone()
    if not row or row['created_by']!=scope.principal_id or row['scope']!='trace-flow-analysis' or row['status']!='done' or row['state']=='quarantined' or any(row[column]!=reference[key] for key,column in [('machine_result_id','selected_result_id'),('content_hash','content_hash'),('run_id','run_id')]):raise Conflict('Frozen Outcome Flow selection changed')
    store._source_assets(con,scope,ws,reference['experiment_id'],reference['run_id'])
    packet=store._load(row['content_hash'],row['artifact_ref']);value=packet.get('result',{}).get('evidence',{}).get('json',{}).get('coreFlowMatch',{})
    raw=value.get('extractedSteps');steps=json.loads(raw) if isinstance(raw,str) and raw else raw
    if _json(steps)!=_json(manifest.get('execution_steps')):raise Conflict('Frozen Outcome steps differ from Flow result')


def validate_start(store,con,token,ws,body,scope,head,snapshot,traces):
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private frozen Outcome attestation required')
    manifest=body.get('config',{}).get('core_outcome')
    if not isinstance(manifest,dict) or type(manifest.get('version')) is not int or manifest['version']!=1 or manifest.get('mode') not in {'rejudge','edited-final-result'}:raise ValueError('Frozen Outcome manifest required')
    saved=json.loads(snapshot['experiment']['configSnapshotJson']).get('coreOutcome')
    if _json(manifest)!=_json(saved) or _json(body.get('config',{}).get('model_selection'))!=_json(manifest.get('model_selection')):raise Conflict('Frozen Outcome configuration differs')
    if len(traces)!=1 or len(snapshot['experiment']['cases'])!=1:raise Conflict('Outcome requires one real Trace source')
    evidence=next(iter(traces.values()))
    if manifest.get('trace_id')!=evidence['manifest']['trace_id'] or manifest.get('trace_snapshot_hash')!=evidence['snapshot_hash'] or evidence['manifest']['owner_principal_id']!=scope.principal_id:raise Conflict('Frozen Outcome source differs')
    _flow(store,con,scope,ws,manifest)


def _receipt_result(store,con,scope,ws,action,body,result,exp):
    key,digest,old=store._receipt(con,scope,ws,action,body)
    if old:raise Conflict('Outcome receipt was concurrently recorded')
    hashed,ref=store._put(result,MAX_BYTES)
    con.execute('INSERT INTO experiment_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,action,key,digest,exp,hashed,ref,store.control.clock()))
    return result


def _lookup_tx(store,con,token,ws,body):
    if 'require_write' in body and type(body['require_write']) is not bool:raise ValueError('Write preflight flag must be boolean')
    scope,route,owner,identity=_source(store,con,token,ws,body['trace_ref'],body.get('require_write') is True)
    head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
    result={'outcome':None,'is_evaluating':False,'run_id':None,'experiment_id':identity}
    boundary={'trace_id':route['trace_id'],'incarnation':str(route['incarnation']),'route_epoch':str(route['route_epoch']),'head':None,'slot':None,'selection':None}
    annotation=con.execute('SELECT revision,extra_json FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,route['trace_id'])).fetchone()
    reset=json.loads(annotation['extra_json']).get('outcome_reset') if annotation else None
    if reset is not None:
        if not isinstance(reset,dict) or type(reset.get('version')) is not int or reset['version']!=1 or reset.get('experiment_id')!=identity or str(reset.get('incarnation'))!=str(route['incarnation']) or type(reset.get('through_generation')) is not int or reset['through_generation']<0:raise Conflict('Outcome query reset source differs')
        reset_source={'version':1,'through_generation':reset['through_generation'],'annotation_revision':str(annotation['revision']),'content_hash':_hash(reset)}
        if 'query_projection' in reset:reset_source['query_projection']=copy.deepcopy(reset['query_projection'])
        boundary['answer_reset']=reset_source;result['answer_reset']=reset_source
    if head is None:return {**result,'selection_hash':_hash(boundary)}
    if head['state']!='active' or head['scope']!=SCOPE or head['created_by']!=owner:raise Conflict('Outcome source identity differs')
    boundary['head']={key:head[key] for key in ('revision','lifecycle_revision','metadata_hash','current_run_id','status')}
    result['run_id']=head['current_run_id']
    slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=?',(ws,identity,SLOT)).fetchone()
    if slot is None:return {**result,'selection_hash':_hash(boundary)}
    case=store._case(con,ws,identity,slot['case_id'])
    if case['trace_id']!=route['trace_id']:raise Conflict('Outcome Case source differs')
    boundary['slot']={key:slot[key] for key in ('result_id','revision','run_id','status','selected_result_id')}
    result['is_evaluating']=slot['status'] in {'pending','running'}
    selected=con.execute("SELECT s.*,e.generation,r.content_hash,r.artifact_ref,r.state,r.attempt_id,r.work_item_id FROM result_selections s JOIN experiment_runs e ON e.workspace_id=s.workspace_id AND e.run_id=s.run_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.result_id JOIN work_items w ON w.workspace_id=r.workspace_id AND w.work_item_id=r.work_item_id WHERE s.workspace_id=? AND e.experiment_id=? AND s.case_key=? AND s.evaluator_slot=? AND w.status='done' ORDER BY e.generation DESC LIMIT 1",(ws,identity,case['case_id'],SLOT)).fetchone()
    if selected:
        if selected['state'] not in {'accepted','indexed','published'}:raise ExperimentUnavailable('Outcome selected result is unavailable')
        packet=store._load(selected['content_hash'],selected['artifact_ref'])
        if packet.get('format')!='agent-insight.machine-result' or packet.get('version')!=1 or packet.get('run_id')!=selected['run_id'] or packet.get('case_key')!=case['case_id'] or packet.get('evaluator_slot')!=SLOT or packet.get('attempt_id')!=selected['attempt_id'] or packet.get('result',{}).get('status')!='done':raise Conflict('Outcome receipt source differs')
        index=con.execute('SELECT i.*,r.plan_hash AS current_plan_hash FROM experiment_trace_sources i JOIN runs r ON r.workspace_id=i.workspace_id AND r.run_id=i.run_id WHERE i.workspace_id=? AND i.run_id=? AND i.case_id=?',(ws,selected['run_id'],case['case_id'])).fetchone()
        if index is None or index['trace_id']!=route['trace_id'] or index['incarnation']!=route['incarnation'] or index['route_epoch']!=route['route_epoch'] or index['plan_hash']!=index['current_plan_hash']:raise Conflict('Outcome indexed source differs')
        store._source_route(con,scope,ws,dict(index))
        value=packet.get('result',{}).get('evidence',{}).get('json',{}).get('coreOutcome')
        if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1 or value.get('source_snapshot_hash')!=index['snapshot_hash']:raise ExperimentUnavailable('Outcome result DTO is unavailable')
        score=value.get('answer_score')
        if score is not None and (type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=1):raise ExperimentUnavailable('Outcome score is invalid')
        if type(value.get('is_answer_correct')) is not bool or not isinstance(value.get('judgment_reason'),str) or not isinstance(value.get('failures'),list) or value.get('skill_issues') is not None and not isinstance(value['skill_issues'],list):raise ExperimentUnavailable('Outcome result is incomplete')
        source={key:str(index[key]) if key in {'incarnation','route_epoch'} else index[key] for key in ('trace_id','incarnation','route_epoch','execution_id','snapshot_hash','plan_hash')}
        result['outcome']={'value':value,'experiment_id':identity,'run_id':selected['run_id'],'machine_result_id':selected['result_id'],'content_hash':selected['content_hash'],'generation':selected['generation'],'source':source}
        boundary['selection']={key:selected[key] for key in ('run_id','result_id','selection_revision','content_hash','generation')}
        boundary['source']=source
        if reset is not None and selected['generation']>reset['through_generation']:result.pop('answer_reset',None)
    return {**result,'selection_hash':_hash(boundary)}


def dispatch_outcome(store,action,token,ws,body):
    if action=='outcome_lookup':
        with store.control.read_transaction() as con:
            scope=store.iam._scope(con,token);fingerprint=scope.fingerprint;result=_lookup_tx(store,con,token,ws,body)
        with store.control.read_transaction() as con:
            current=store.iam._scope(con,token)
            if current.fingerprint!=fingerprint:raise Forbidden('Outcome authorization changed during read')
            if _json(_lookup_tx(store,con,token,ws,body))!=_json(result):raise Conflict('Outcome selection changed during read')
        return result
    if action=='outcome_query' and (not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True):raise Forbidden('Private frozen query attestation required')
    with store.control.read_transaction() as con:
        scope,route,owner,identity=_source(store,con,token,ws,body['trace_ref'],True)
        _,_,receipt=store._receipt(con,scope,ws,action,body)
        if receipt:return store._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES)
    if action in {'outcome_begin','outcome_query'}:
        if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private frozen Outcome attestation required')
        if store.evidence is None:raise ExperimentUnavailable('Outcome requires real Trace evidence')
        reader=copy.copy(store.evidence)
        if action=='outcome_query' or body.get('config',{}).get('core_outcome',{}).get('mode')=='edited-final-result':reader.allow_missing_session=True
        evidence=reader.read(token,ws,trace_ref=body['trace_ref'])
    with store.control.transaction(('evaluation', ws), ('trace', ws), ('diagnosis', ws)) as con:
        scope,current,owner,identity=_source(store,con,token,ws,body['trace_ref'],True)
        _,_,receipt=store._receipt(con,scope,ws,action,body)
        if receipt:return store._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES)
        if action=='outcome_cancel':
            head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
            if head is None:
                store._create(con,token,ws,{'experiment':{'id':identity,'name':'Trace Outcome '+current['trace_id'],'scope':SCOPE,'evaluatorIdsJson':_json([SLOT]),'cases':[]}},scope,private=True)
                return _receipt_result(store,con,scope,ws,action,body,{'success':True,'cancelled':False},identity)
            live=con.execute("SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=? AND status IN ('pending','running')",(ws,identity,SLOT)).fetchone()
            if live:store._append_cancel(con,ws,dict(head),None,scope);store._cancel_items(con,ws,identity);store._settle(con,ws,identity)
            result={'success':True,'cancelled':bool(live),**({'runId':head['current_run_id']} if live else {})}
            return _receipt_result(store,con,scope,ws,action,body,result,identity)
        if current['trace_id']!=route['trace_id'] or current['incarnation']!=route['incarnation']:raise Conflict('Outcome source lifecycle changed')
        store._verify_evidence(con,token,ws,evidence)
        if action=='outcome_query':
            if body.get('source_snapshot_hash')!=evidence['snapshot_hash']:raise Conflict('Query routing was prepared against another Trace snapshot')
            previous=_lookup_tx(store,con,token,ws,{'trace_ref':current['trace_id']})
            if body.get('previous_outcome_selection')!=previous['selection_hash']:raise Conflict('Previous Outcome changed while preparing query')
            projection=body.get('query_projection');_query_projection(projection)
            head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
            if head is None:
                case={'id':str(uuid.uuid5(uuid.NAMESPACE_URL,identity+':case')),'taskId':evidence['execution']['taskId'],'executionId':evidence['execution']['id'],'input':body.get('query'),'actualOutput':evidence['execution'].get('finalResult') or ''}
                store._create(con,token,ws,{'experiment':{'id':identity,'name':'Trace Outcome '+current['trace_id'],'scope':SCOPE,'evaluatorIdsJson':_json([SLOT]),'cases':[case]}},scope,private=True)
            patch_query(store,con,token,ws,current['trace_id'],body.get('query'),projection)
            result={'experiment_id':identity,'trace_id':current['trace_id'],'execution_id':evidence['execution']['id'],'task_id':evidence['execution']['taskId']}
            return _receipt_result(store,con,scope,ws,action,body,result,identity)
        config=copy.deepcopy(body.get('config',{}));manifest=config.get('core_outcome')
        if not isinstance(manifest,dict) or type(manifest.get('version')) is not int or manifest['version']!=1 or manifest.get('mode') not in {'rejudge','edited-final-result'}:raise ValueError('Frozen Outcome manifest required')
        if 'previous_outcome_selection' in manifest or 'previous_outcome' in manifest:
            previous=_lookup_tx(store,con,token,ws,{'trace_ref':current['trace_id']})
            if 'previous_outcome_selection' in manifest and manifest['previous_outcome_selection']!=previous['selection_hash']:raise Conflict('Previous Outcome selection changed while preparing edit')
            selected=previous['outcome']
            expected_previous={'selection_hash':previous['selection_hash'],'failures':selected['value']['failures'],'skill_issues':selected['value']['skill_issues']} if selected else None
            if 'previous_outcome' in manifest and _json(expected_previous)!=_json(manifest['previous_outcome']):raise Conflict('Previous Outcome changed while preparing edit')
        expected=manifest.get('trace_snapshot_hash')
        if expected is not None and expected!=evidence['snapshot_hash']:raise Conflict('Outcome configuration was prepared against another source')
        if 'final_result' in body:
            if manifest['mode']!='edited-final-result' or not isinstance(body['final_result'],str):raise ValueError('Final Result edit requires text and editing mode')
            final=body['final_result'].strip(JS_TRIM_WHITESPACE);TraceMetadata(store.control)._patch(con,token,ws,current['trace_id'],{'final_result':final},int(evidence['manifest']['annotation_revision']))
            evidence=copy.deepcopy(evidence);evidence['execution']['finalResult']=final
            ann=dict(con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,current['trace_id'])).fetchone())
            evidence['manifest'].update(annotation_revision=str(ann['revision']),annotation_hash=_hash(ann),execution_hash=_hash(evidence['execution']))
            evidence['snapshot_hash']=_hash({k:v for k,v in evidence.items() if k not in {'snapshot_hash','captured_at'}})
        elif manifest['mode']=='edited-final-result':raise ValueError('Edited Outcome requires Final Result')
        manifest.update(trace_id=current['trace_id'],trace_snapshot_hash=evidence['snapshot_hash']);config['model_selection']=manifest.get('model_selection')
        case_id=str(uuid.uuid5(uuid.NAMESPACE_URL,identity+':case'));source={'id':case_id,'taskId':evidence['execution']['taskId'],'executionId':evidence['execution']['id'],'input':evidence['execution'].get('query') or '','actualOutput':evidence['execution'].get('finalResult') or ''}
        head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
        metadata={'id':identity,'name':'Trace Outcome '+current['trace_id'],'scope':SCOPE,'evaluatorIdsJson':_json([SLOT]),'configSnapshotJson':_json({'coreOutcome':manifest}),'cases':[source]}
        if head is None:store._create(con,token,ws,{'experiment':metadata},scope,private=True)
        else:
            if head['state']!='active' or head['scope']!=SCOPE or head['created_by']!=scope.principal_id:raise Conflict('Outcome head identity differs')
            store._update(con,token,ws,{'experiment_id':identity,'changes':{'configSnapshotJson':metadata['configSnapshotJson']}},scope)
            store._case_write(con,token,ws,identity,source,0)
        snapshot=store._snapshot(con,ws,store._head(con,token,ws,identity));request={'experiment_id':identity,'force_new_trace':True,'config':config,'frozen_evaluators':{SLOT:{'id':SLOT,'version':1}},'releases':body.get('releases',{})}
        started=store._start(con,token,ws,request,scope,(snapshot,{case_id:evidence}))
        slot=con.execute('SELECT result_id FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=?',(ws,identity,SLOT)).fetchone()
        result={'experiment_id':identity,'run_id':started['run_id'],'result_id':slot[0],'trace_id':current['trace_id'],'execution_id':evidence['execution']['id'],'task_id':evidence['execution']['taskId']}
        return _receipt_result(store,con,scope,ws,action,body,result,identity)


def validate_result(store,con,token,ws,body,checkpoint,result):
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private Outcome result attestation required')
    _,plan=store._plan(con,ws,checkpoint['experiment_id'],checkpoint['run_id'])
    source=plan['frozen_trace_evidence'].get(checkpoint['case_id'])
    value=result.get('evidence',{}).get('json',{}).get('coreOutcome')
    if not source or not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1 or value.get('source_snapshot_hash')!=source['snapshot_hash']:raise Conflict('Outcome result requires its real frozen source')
    score=value.get('answer_score')
    if score is not None and (type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=1):raise ValueError('Outcome answer score must be 0..1 or null')
    if result.get('score')!=(score*100 if score is not None else None) or type(value.get('is_answer_correct')) is not bool or not isinstance(value.get('judgment_reason'),str) or not isinstance(value.get('failures'),list) or value.get('skill_issues') is not None and not isinstance(value['skill_issues'],list):raise ValueError('Outcome result DTO is incomplete')

    template=plan.get('config',{}).get('core_outcome',{}).get('record_projection')
    projected=value.get('record_projection')
    if template is not None:
        if not isinstance(template,dict) or not isinstance(template.get('outcome_evaluation'),dict):raise Conflict('Outcome frozen record projection is unavailable')
        expected=copy.deepcopy(template);outcome=expected['outcome_evaluation'];outcome['reason']=value['judgment_reason']
        if outcome.get('status')=='available':outcome.update(score=score,is_correct=value['is_answer_correct'])
        breakdown=outcome.get('skill_breakdown')
        if not isinstance(breakdown,list):raise Conflict('Outcome frozen Skill breakdown is unavailable')
        for item in breakdown:item.update(score=score if outcome.get('status')=='available' else None,is_correct=value['is_answer_correct'] if outcome.get('status')=='available' else None)
        if _json(projected)!=_json(expected):raise Conflict('Outcome record projection differs from frozen real sources')
    elif projected is not None:raise Conflict('Outcome result cannot invent a record projection')



def patch_query(store,con,token,ws,trace,query,query_projection=None):
    if not isinstance(query,str) or not query.strip(JS_TRIM_WHITESPACE):raise ValueError('query must be nonempty')
    scope,route,_,identity=_source(store,con,token,ws,trace,True)
    head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
    generation=0
    if head:
        if head['scope']!=SCOPE or head['state']!='active' or head['created_by']!=scope.principal_id:raise Conflict('Outcome query reset identity differs')
        generation=con.execute('SELECT COALESCE(MAX(generation),0) FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()[0]
        active=con.execute("SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=? AND status IN ('pending','running')",(ws,identity,SLOT)).fetchone()
        if active:store._append_cancel(con,ws,dict(head),None,scope);store._cancel_items(con,ws,identity);store._settle(con,ws,identity)
    marker={'version':1,'experiment_id':identity,'incarnation':str(route['incarnation']),'through_generation':generation}
    if query_projection is not None:_query_projection(query_projection);marker['query_projection']=copy.deepcopy(query_projection)
    return TraceMetadata(store.control)._patch(con,token,ws,route['trace_id'],{'query':query.strip(JS_TRIM_WHITESPACE)},extra_changes={'outcome_reset':marker})



def _query_projection(value):
    if not isinstance(value,dict) or set(value)!={'is_skill_correct','skill_trigger_rate','routing_evaluation','outcome_evaluation'} or type(value['is_skill_correct']) is not bool or not isinstance(value['routing_evaluation'],dict) or not isinstance(value['outcome_evaluation'],dict):raise ValueError('Frozen query routing projection is required')
    rate=value['skill_trigger_rate']
    if rate is not None and (type(rate) not in (int,float) or not math.isfinite(rate) or not 0<=rate<=1):raise ValueError('Invalid query routing scalar')
    if len(_json(value).encode())>1024*1024:raise ValueError('Frozen query routing projection exceeds budget')
