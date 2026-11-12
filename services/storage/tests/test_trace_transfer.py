import copy
import json
import tempfile
import unittest
from pathlib import Path

from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore, Forbidden
from services.storage.trace_metadata import TraceMetadata
from services.storage.trace_service import TraceQueries
from services.storage.authorized import AuthorizedStorage
from services.storage.observations import ObservationIngest, _payload_revision


def node(identity='root',task='task',parent=None,root='root',interactions=None,nodes=None):
    execution=dict.fromkeys(('query','framework','tokens','cost','latency','toolCallCount','llmCallCount','inputTokens','outputTokens','toolCallErrorCount','cacheReadInputTokens','cacheCreationInputTokens','maxSingleCallTokens','reasoningTokens','model','endpoint','agentName','finalResult','skill','skillVersion','label','agentSessionId','subagentType','subagentName'))
    execution.update(id=identity,taskId=task,timestamp='2026-11-12T00:00:00Z',skills=[],invokedSkills=[],observedAgents=[],
        parentExecutionId=parent,rootExecutionId=root,isSubagent=parent is not None,query='question',framework='opencode',agentName='Agent')
    session={'taskId':task,'label':'Label','query':'question','startTime':'2026-11-12T00:00:00Z','endTime':None,'model':None,
        'interactions':interactions if interactions is not None else [{'role':'assistant','content':'answer','opaque':{'扩展':[1,2]},'call_ids':['c'],'request_id':'r'}]}
    if nodes is not None:session['langfuseTraceNodes']=nodes
    return {'execution':execution,'session':session}


def bundle(nodes=None):
    return {'format':'agent-insight.trace-bundle','version':1,'exportedAt':'2026-11-12T00:00:01Z','rootExecutionId':'root','executions':nodes or [node()]}


class MemoryFacts:
    def __init__(self):self.spans={};self.summaries={};self.payloads={}
    def write_spans(self,rows):
        for row in rows:self.spans[(row['workspace_id'],row['trace_id'],row['span_id'])]=copy.deepcopy(row)
    def _insert(self,table,rows):
        assert table=='obs_trace_current'
        for row in rows:self.summaries[(row['workspace_id'],row['trace_id'])]=copy.deepcopy(row)
    def write_payload_bundle(self,ws,bucket,trace,span,sections):
        self.payloads[(ws,trace,span,_payload_revision(sections))]=copy.deepcopy(sections);return {'payload_revision':_payload_revision(sections)}
    def write_payload_bundles(self,values):
        return [self.write_payload_bundle(value['workspace_id'],value['trace_bucket'],value['trace_id'],value['span_id'],value['sections']) for value in values]
    def read_spans(self,ws,bucket,trace,after_span_id='',limit=200,**options):
        return [copy.deepcopy(row) for (w,t,s),row in sorted(self.spans.items()) if w==ws and t==trace and s>after_span_id][:limit]
    def read_payload(self,ws,bucket,trace,span,revision,section,after_chunk=-1,limit=4):
        sections=self.payloads[(ws,trace,span,revision)]
        if section not in sections:return {'chunks':[],'chunk_count':0,'next_chunk':None,'complete':True,'available':False}
        text=sections[section];pieces=[text[i:i+65536] for i in range(0,len(text),65536)] or ['']
        chunks=[{'chunk_no':i,'body':pieces[i]} for i in range(after_chunk+1,min(after_chunk+1+limit,len(pieces)))]
        last=chunks[-1]['chunk_no'] if chunks else after_chunk
        return {'chunks':chunks,'chunk_count':len(pieces),'next_chunk':last if last+1<len(pieces) else None,'complete':after_chunk==-1 and len(chunks)==len(pieces)}
    def _request(self,sql,*,parameters):
        traces={v for k,v in parameters.items() if k.startswith('trace_')}
        return b'\n'.join(json.dumps(row).encode() for (w,t),row in self.summaries.items() if w==parameters['workspace_id'] and t in traces)


class TraceTransferTests(unittest.TestCase):
    def setUp(self):
        import importlib.util
        self.assertIsNotNone(importlib.util.find_spec('services.storage.trace_transfer'),'Trace bundle transfer compatibility must exist')
        from services.storage.trace_transfer import LegacyTraceTransfer
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.control=SQLiteControlStore(Path(self.tmp.name)/'db');self.control.initialize();self.iam=IAMStore(self.control)
        for name in ('alice','bob'):self.iam.create_principal(name,name,name)
        self.control.create_workspace('w','W');self.iam.bind_workspace('w',principal_id='alice')
        self.token=self.iam.issue_session_for_provisioning('alice');self.bob=self.iam.issue_session_for_provisioning('bob')
        self.facts=MemoryFacts();self.ingest=ObservationIngest(self.control,self.facts);self.metadata=TraceMetadata(self.control)
        self.queries=TraceQueries(self.control,self.facts,cursor_secret=b'private-transfer-test-cursor-secret')
        self.authorized=AuthorizedStorage(self.iam,self.facts)
        self.transfer=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest)

    def drain(self):
        for _ in range(100):
            if not self.ingest.work_once('worker'):return
        self.fail('unexpected endless work')

    def test_import_export_preserves_every_raw_extension_and_original_small_metadata(self):
        source=bundle();source['executions'][0]['execution']['opaqueMetadata']={'v':0.4}
        result=self.transfer.import_bundle(self.token,'w',source)
        self.assertEqual(result['rootExecutionId'],'root');self.assertEqual(result['rootTaskId'],'task');self.assertEqual(result['executionCount'],1)
        self.assertEqual(set(result),{'originalRootExecutionId','rootExecutionId','rootTaskId','executionCount','subagentCount','remappedIds'})
        self.assertEqual(len(result.batch_refs),1);self.assertEqual(self.facts.spans,{})
        self.drain();exported=self.transfer.export(self.token,'w','root')
        self.assertEqual(exported['executions'],source['executions']);self.assertEqual(exported['rootExecutionId'],'root')
        self.assertEqual(len(self.facts.spans),1)

    def test_tree_and_nested_json_references_are_remapped_on_identity_collision(self):
        source=bundle([node(),node('child','child-task','root')]);source['executions'][0]['session']['interactions'][0]['tool_calls']=[{'id':'opaque-call','function':{'name':'Task','arguments':'{"session_id":"child-task","executionId":"child"}'}}]
        first=self.transfer.import_bundle(self.token,'w',source);self.drain();self.transfer.mark_completed(self.token,'w',first)
        second=self.transfer.import_bundle(self.token,'w',source);self.drain()
        self.assertNotEqual(second['rootExecutionId'],first['rootExecutionId']);self.assertEqual(second['subagentCount'],1)
        mapping={r['original']:r['imported'] for r in second['remappedIds']};self.assertEqual(len(mapping),4)
        exported=self.transfer.export(self.token,'w',second['rootExecutionId']);root,child=exported['executions']
        self.assertEqual(child['execution']['parentExecutionId'],root['execution']['id']);self.assertEqual(child['execution']['rootExecutionId'],root['execution']['id'])
        args=json.loads(root['session']['interactions'][0]['tool_calls'][0]['function']['arguments'])
        self.assertEqual(args['session_id'],mapping['child-task']);self.assertEqual(args['executionId'],mapping['child'])
        self.assertEqual(root['session']['interactions'][0]['tool_calls'][0]['id'],'opaque-call')
        self.assertEqual(self.transfer.export(self.token,'w',mapping['child'])['rootExecutionId'],mapping['root'])

    def test_receipt_replay_keeps_identity_map_and_batches_but_changed_bundle_conflicts(self):
        from services.storage.control import Conflict
        first=self.transfer.import_bundle(self.token,'w',bundle(),receipt_key='receipt');self.drain()
        second=self.transfer.import_bundle(self.token,'w',bundle(),receipt_key='receipt')
        self.assertEqual(first,second);self.assertEqual(first.batch_refs,second.batch_refs)
        changed=bundle();changed['executions'][0]['session']['query']='different'
        with self.assertRaises(Conflict):self.transfer.import_bundle(self.token,'w',changed,receipt_key='receipt')

    def test_preflight_all_nodes_rejects_invalid_tree_before_any_trace_is_reserved(self):
        invalid=bundle([node(),node('child','child-task','missing')])
        with self.assertRaises(ValueError):self.transfer.import_bundle(self.token,'w',invalid)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],0)
        invalid=bundle([node(),node('child','child-task','root')]);invalid['executions'][1]['session']['startTime']='bad'
        with self.assertRaises(ValueError):self.transfer.import_bundle(self.token,'w',invalid)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],0)

    def test_bundle_cannot_grant_ownership_or_access_via_user_fields(self):
        source=bundle();source['user']='bob';source['executions'][0]['execution']['user']='bob'
        result=self.transfer.import_bundle(self.token,'w',source);self.drain()
        resolved=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT owner_principal_id FROM iam_resource_access WHERE resource_id=?',(resolved['trace_id'],)).fetchone()[0],'alice')
        with self.assertRaises(Forbidden):self.transfer.export(self.bob,'w','root')
        with self.assertRaises(Forbidden):self.transfer.import_bundle(self.bob,'w',source)

    def test_langfuse_primary_nodes_and_raw_secondary_representation_round_trip_exactly(self):
        nodes=[{'traceId':'old-trace','spanId':'root-span','parentSpanId':None,'sourceParentSpanId':None,'displayParentSpanId':None,'name':'chain','kind':'chain','startedAt':1794441600000,'completedAt':1794441601000,'durationMs':1000,'status':'unset','visibility':'visible','extra':{'request_id':'preserve'}},
            {'traceId':'old-trace','spanId':'child-span','parentSpanId':'root-span','sourceParentSpanId':'root-span','displayParentSpanId':'root-span','name':'model','kind':'llm','startedAt':1794441600000,'completedAt':1794441601000,'durationMs':1000,'status':'error','visibility':'visible','input':{'messages':[{'role':'user','content':'question'}]},'output':'failure','toolCallId':'arbitrary'}]
        source=bundle([node(nodes=nodes)]);self.transfer.import_bundle(self.token,'w',source);self.drain()
        self.assertEqual(len(self.facts.spans),2)
        exported=self.transfer.export(self.token,'w','root');self.assertEqual(exported['executions'],source['executions'])

    def test_empty_and_missing_session_are_distinguished_without_fake_original_interactions(self):
        source=bundle([node(interactions=[]),node('child','child-task','root')]);source['executions'][1]['session']=None
        self.transfer.import_bundle(self.token,'w',source);self.drain()
        exported=self.transfer.export(self.token,'w','root');self.assertEqual(exported['executions'],source['executions'])

    def test_bundle_limits_and_unknown_formats_fail_before_target_writes(self):
        from unittest.mock import patch
        from services.storage import trace_transfer
        with patch.object(trace_transfer,'MAX_BUNDLE_BYTES',128),self.assertRaises(ValueError):self.transfer.import_bundle(self.token,'w',bundle())
        wrong=bundle();wrong['version']=2
        with self.assertRaises(ValueError):self.transfer.import_bundle(self.token,'w',wrong)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],0)

    def test_native_export_preserves_captured_tree_and_annotation_overrides(self):
        from services.storage.tests.test_observations import packet
        root=self.ingest.accept(self.token,'w',packet(trace='a'*32))['trace_ids'][0]
        self.metadata.register_aliases_for_provisioning('w',root,execution_id='native-root',task_id='native-task')
        body=packet(trace='b'*32)
        attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.extend([{'key':'legacy.is_subagent','value':{'boolValue':True}},
            {'key':'legacy.root_execution_id','value':{'stringValue':'native-root'}},
            {'key':'legacy.parent_execution_id','value':{'stringValue':'native-root'}}])
        child=self.ingest.accept(self.token,'w',body)['trace_ids'][0]
        self.metadata.register_aliases_for_provisioning('w',child,execution_id='native-child',task_id='native-child-task')
        self.drain();self.metadata.patch(self.token,'w',root,{'label':'Updated label','query':'Updated query'})
        exported=self.transfer.export(self.token,'w','native-child')
        root_alias=self.metadata.resolve(self.token,'w','native-root','execution')['execution_id']
        self.assertEqual(exported['rootExecutionId'],root_alias);self.assertEqual(len(exported['executions']),2)
        first,second=exported['executions'];self.assertEqual(first['execution']['label'],'Updated label')
        self.assertEqual(first['execution']['query'],'Updated query');self.assertEqual(second['execution']['parentExecutionId'],root_alias)

    def test_imported_raw_is_lazy_but_full_interaction_preserves_all_original_extensions(self):
        source=bundle();raw=source['executions'][0]['session']['interactions'][0]
        raw.update(response_id='response',attempt_ids=['attempt'],_collaboration={'taskId':'task','index':0})
        result=self.transfer.import_bundle(self.token,'w',source);self.drain()
        trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        from unittest.mock import patch
        with patch.object(self.authorized,'read_payload',side_effect=AssertionError('normal structure cannot read payload')):
            structure=self.transfer.reads.session(self.token,'w',trace)
        loaded=self.transfer.reads.session(self.token,'w',trace,view='interaction',index=0)['interaction']
        for key in ('content','opaque','call_ids','request_id','response_id','attempt_ids','_collaboration'):self.assertEqual(loaded.get(key),raw[key])
        self.assertEqual(loaded['_payloadVersion'],structure['interactions'][0]['_payloadVersion'])

    def test_native_langfuse_structure_restores_full_nodes_without_double_counting_raw_secondary(self):
        nodes=[{'traceId':'old','spanId':'s','parentSpanId':None,'name':'node','kind':'llm','startedAt':1794441600000,'completedAt':1794441601000,'input':'question','output':'answer','status':'success','visibility':'visible'}]
        source=bundle([node(nodes=nodes)]);result=self.transfer.import_bundle(self.token,'w',source);self.drain()
        trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        structure=self.transfer.reads.session(self.token,'w',trace)
        self.assertEqual(structure.get('langfuseTraceNodes'),nodes)
        self.assertEqual(structure['interactions'][0]['content'],'answer')
        self.assertEqual(len(self.facts.spans),1)

    def test_unkeyed_partial_import_resumes_until_indexed_and_explicitly_completed(self):
        from unittest.mock import patch
        from services.storage.trace_transfer import TraceTransferPending
        source=bundle();source['executions'][0]['session']['interactions']=[{'role':'assistant','content':str(i)} for i in range(3)]
        original=self.ingest.accept_import;attempts=0
        def interrupted(*args,**kwargs):
            nonlocal attempts
            attempts+=1
            if attempts==2:raise OSError('simulated connection loss')
            return original(*args,**kwargs)
        with patch('services.storage.trace_transfer.MAX_PACKET_SPANS',1),patch.object(self.ingest,'accept_import',side_effect=interrupted):
            with self.assertRaises(TraceTransferPending):self.transfer.import_bundle(self.token,'w',source)
        with self.control.read_transaction() as con:before=con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0]
        with patch('services.storage.trace_transfer.MAX_PACKET_SPANS',1):resumed=self.transfer.import_bundle(self.token,'w',source)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],before)
        with self.assertRaises(TraceTransferPending):self.transfer.mark_completed(self.token,'w',resumed)
        self.drain();self.transfer.mark_completed(self.token,'w',resumed)
        with patch('services.storage.trace_transfer.MAX_PACKET_SPANS',1):again=self.transfer.import_bundle(self.token,'w',source)
        self.assertNotEqual(resumed['rootExecutionId'],again['rootExecutionId'])

    def test_raw_tool_usage_does_not_turn_a_tool_result_into_an_llm(self):
        source=bundle([node(interactions=[{'role':'tool','content':'found','usage':{'output':3},'tool_calls':[{'id':'call','function':{'name':'search','arguments':'q'},'output':'found'}]}])])
        self.transfer.import_bundle(self.token,'w',source);self.drain()
        row=next(iter(self.facts.spans.values()));self.assertEqual(row['kind'],'tool');self.assertEqual(row['tool_name'],'search')
        summary=next(iter(self.facts.summaries.values()));self.assertEqual(summary['llm_call_count'],0);self.assertEqual(summary['tool_call_count'],1)

    def test_imported_empty_session_has_no_fake_carrier_interaction(self):
        result=self.transfer.import_bundle(self.token,'w',bundle([node(interactions=[])]));self.drain()
        trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        structure=self.transfer.reads.session(self.token,'w',trace)
        self.assertEqual(structure['interactionCount'],0);self.assertEqual(structure['interactions'],[])
        for view in ('full','interactions'):
            self.assertEqual(self.transfer.reads.session(self.token,'w',trace,view=view)['interactions'],[])
        with self.assertRaises(ValueError):self.transfer.reads.session(self.token,'w',trace,view='interaction',index=0)
        self.assertEqual(self.transfer.export(self.token,'w',result['rootExecutionId'])['executions'][0]['session']['interactions'],[])

    def test_imported_missing_session_remains_unavailable_in_legacy_session_reads(self):
        from services.storage.compatibility import TraceNotFound
        source=bundle();source['executions'][0]['session']=None
        result=self.transfer.import_bundle(self.token,'w',source);self.drain()
        trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        for view in ('structure','full','interactions','interaction'):
            with self.assertRaises(TraceNotFound):self.transfer.reads.session(self.token,'w',trace,view=view,index=0)

    def test_more_than_four_mib_raw_body_roundtrips_and_fifty_mib_limit_is_enforced(self):
        from services.storage.trace_transfer import TraceBundleLimitError
        source=bundle();text='x'*(5*1024*1024);source['executions'][0]['session']['interactions'][0]['content']=text
        self.transfer.import_bundle(self.token,'w',source);self.drain()
        self.assertEqual(self.transfer.export(self.token,'w','root')['executions'][0]['session']['interactions'][0]['content'],text)
        source['executions'][0]['session']['interactions'][0]['content']='x'*(50*1024*1024)
        with self.assertRaises(TraceBundleLimitError):self.transfer.import_bundle(self.token,'w',source)


if __name__=='__main__':unittest.main()
