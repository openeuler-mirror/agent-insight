import copy
import importlib.util
import json
import unittest
from unittest.mock import patch

from services.storage.tests import test_trace_transfer as fixture
from services.storage.tests.test_observations import packet
from services.storage.control import Conflict
from services.storage.iam import Forbidden


def snapshot(task='provider-session',answer='answer'):
    raw=[{'info':{'id':'message-user','role':'user','time':{'created':1794441600000}},'parts':[{'type':'text','text':'question'}]},
         {'info':{'id':'message-assistant','role':'assistant','time':{'created':1794441601000,'completed':1794441602000}},'parts':[{'type':'tool','id':'tool-part','callID':'call-search','tool':'search','state':{'status':'completed','input':{'q':'x'},'output':'found'}},{'type':'text','text':answer}]}]
    interactions=[{'role':'user','content':'question','timeInfo':{'created':1794441600000},'_providerMessageId':'message-user','_providerMessage':raw[0]},
                  {'role':'assistant','content':answer,'timeInfo':{'created':1794441601000,'completed':1794441602000},'usage':{'input':4,'output':2},'tool_calls':[{'id':'call-search','function':{'name':'search','arguments':'{"q":"x"}'},'state':'completed','output':'found'}],
                   '_providerMessageId':'message-assistant','_providerMessage':raw[1]}]
    return {'record':{'task_id':task,'upload_id':task,'user':'forged','agentName':'fault-diagnosis-agent','framework':'opencode','query':'question','final_result':answer,'timestamp':'2026-11-12T00:00:00Z','trace_started_at':'2026-11-12T00:00:00Z','trace_completed_at':'2026-11-12T00:00:02Z','interactions':interactions,'failures':[]},'rawMessages':raw}


class AgentTraceTests(unittest.TestCase):
    setUp=fixture.TraceTransferTests.setUp
    drain=fixture.TraceTransferTests.drain

    def recorder(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.agent_traces'))
        from services.storage.agent_traces import AgentTraceRecorder
        return AgentTraceRecorder(self.control,self.ingest)

    def heads(self,trace):
        with self.control.read_transaction() as con:return {row['entity_id']:dict(row) for row in con.execute("SELECT * FROM obs_entity_heads WHERE trace_id=? AND entity_kind='span'",(trace,))}

    def test_standard_record_is_durable_stable_alias_private_and_preserves_raw_provider_tools(self):
        service=self.recorder();body=snapshot();receipt=service.record(self.token,'w',body)
        self.assertEqual(receipt['task_id'],'provider-session');self.assertEqual(receipt['execution_id'],'provider-session');self.assertEqual(receipt['state'],'accepted')
        self.assertEqual(self.facts.spans,{});self.drain()
        resolved=self.metadata.resolve(self.token,'w','provider-session');self.assertEqual(resolved['trace_id'],receipt['trace_id'])
        full=self.transfer.reads.session(self.token,'w',receipt['trace_id'],view='full')
        self.assertEqual(len(full['interactions']),2);self.assertEqual(full['interactions'][1]['_providerMessage'],body['rawMessages'][1]);self.assertEqual(full['interactions'][1]['tool_calls'][0]['output'],'found')
        summary=self.facts.summaries[('w',receipt['trace_id'])];self.assertEqual(summary['tool_call_count'],1);self.assertEqual(summary['llm_call_count'],1)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT owner_principal_id FROM iam_resource_access WHERE resource_id=?',(receipt['trace_id'],)).fetchone()[0],'alice')

    def test_identical_full_snapshot_is_idempotent_without_advancing_source_revisions(self):
        service=self.recorder();body=snapshot();first=service.record(self.token,'w',body);self.drain();heads=self.heads(first['trace_id'])
        again=service.record(self.token,'w',copy.deepcopy(body));self.drain()
        self.assertEqual(first['trace_id'],again['trace_id']);self.assertTrue(again['duplicate']);self.assertEqual(first['batch_refs'],again['batch_refs']);self.assertEqual(heads,self.heads(first['trace_id']))

    def test_updated_message_and_new_turn_do_not_duplicate_prior_history_or_tokens(self):
        service=self.recorder();body=snapshot();first=service.record(self.token,'w',body);self.drain();before=self.heads(first['trace_id'])
        changed=snapshot(answer='corrected');service.record(self.token,'w',changed);self.drain()
        full=self.transfer.reads.session(self.token,'w',first['trace_id'],view='full');self.assertEqual(len(full['interactions']),2);self.assertEqual(full['interactions'][1]['content'],'corrected')
        summary=self.facts.summaries[('w',first['trace_id'])];self.assertEqual(summary['input_tokens'],None);self.assertEqual(summary['span_count'],4)
        after=self.heads(first['trace_id']);self.assertEqual(len(after),len(before));self.assertTrue(any(h['source_revision']==2 for h in after.values()))
        old=service.record(self.token,'w',body);self.drain();self.assertTrue(old['duplicate']);self.assertEqual(after,self.heads(first['trace_id']))

    def test_append_turn_and_source_message_ids_remain_stable(self):
        service=self.recorder();body=snapshot();first=service.record(self.token,'w',body);self.drain();before=self.heads(first['trace_id'])
        added={'role':'assistant','content':'second turn','_providerMessageId':'message-second','_providerMessage':{'info':{'id':'message-second','role':'assistant'},'parts':[{'type':'text','text':'second turn'}]}}
        body['record']['interactions'].append(added);body['rawMessages'].append(added['_providerMessage']);body['record']['final_result']='second turn'
        service.record(self.token,'w',body);self.drain();full=self.transfer.reads.session(self.token,'w',first['trace_id'],view='full')
        self.assertEqual([item.get('_providerMessageId') for item in full['interactions']],['message-user','message-assistant','message-second'])
        for key,head in before.items():
            if key!='f'*16:self.assertEqual(head,self.heads(first['trace_id'])[key])

    def test_forged_user_cross_workspace_and_alias_collision_cannot_take_ownership(self):
        service=self.recorder();first=service.record(self.token,'w',snapshot());self.drain()
        with self.assertRaises(Forbidden):service.record(self.bob,'w',snapshot())
        with self.assertRaises(Forbidden):service.record(self.token,'other',snapshot())
        trace=self.ingest.accept(self.token,'w',packet(trace='b'*32))['trace_ids'][0]
        self.metadata.register_aliases_for_provisioning('w',trace,task_id='reserved')
        with self.assertRaises(Conflict):service.record(self.token,'w',snapshot(task='reserved'))
        self.assertEqual(self.metadata.resolve(self.token,'w','provider-session')['trace_id'],first['trace_id'])

    def test_failed_run_includes_actual_error_and_never_fakes_success_output(self):
        service=self.recorder();body=snapshot();body['record'].pop('final_result');body['record']['failures']=[{'context':'MODEL_ERROR','description':'actual failure'}]
        body['record']['interactions'].append({'role':'system','error':{'code':'MODEL_ERROR','message':'actual failure'},'timestamp':'2026-11-12T00:00:02Z'})
        receipt=service.record(self.token,'w',body);self.drain();full=self.transfer.reads.session(self.token,'w',receipt['trace_id'],view='full')
        self.assertTrue(any(i.get('error',{}).get('message')=='actual failure' for i in full['interactions']));self.assertEqual(self.facts.summaries[('w',receipt['trace_id'])]['execution_status'],'failed')

    def test_provider_snapshot_cannot_silently_drop_or_reorder_existing_messages(self):
        service=self.recorder();body=snapshot();first=service.record(self.token,'w',body);self.drain();before=self.heads(first['trace_id'])
        missing=copy.deepcopy(body);missing['record']['interactions'].pop(0);missing['rawMessages'].pop(0)
        with self.assertRaises(Conflict):service.record(self.token,'w',missing)
        reordered=copy.deepcopy(body);reordered['record']['interactions'].reverse();reordered['rawMessages'].reverse()
        with self.assertRaises(Conflict):service.record(self.token,'w',reordered)
        self.assertEqual(before,self.heads(first['trace_id']))

    def test_interrupted_submission_reuses_frozen_plan_and_stable_revisions(self):
        from unittest.mock import patch
        service=self.recorder();original=self.ingest.accept_import;attempts=0
        def failing(*args,**kwargs):
            nonlocal attempts
            attempts+=1
            if attempts==2:raise OSError('simulated interruption')
            return original(*args,**kwargs)
        with patch('services.storage.agent_traces.MAX_PACKET_SPANS',1),patch.object(self.ingest,'accept_import',side_effect=failing):
            with self.assertRaises(service.pending):service.record(self.token,'w',snapshot())
        with patch('services.storage.agent_traces.MAX_PACKET_SPANS',1):receipt=service.record(self.token,'w',snapshot())
        self.drain();self.assertEqual(len(self.heads(receipt['trace_id'])),4)
        self.assertTrue(all(row['source_revision']==1 for row in self.heads(receipt['trace_id']).values()))

    def test_parent_context_validated_and_internal_lease_material_never_persisted(self):
        service=self.recorder();body=snapshot();parent=self.ingest.accept(self.token,'w',packet())['trace_ids'][0];self.drain()
        body['context']={'parent_trace_id':parent,'diagnosis_session_id':'diagnosis','request_key':'request','lease_owner':'secret-internal-lease','turn_fence':7}
        receipt=service.record(self.token,'w',body);self.drain()
        with self.control.read_transaction() as con:row=con.execute('SELECT extra_json FROM trace_annotations WHERE trace_id=?',(receipt['trace_id'],)).fetchone()[0]
        self.assertNotIn('secret-internal-lease',row)
        for sections in self.facts.payloads.values():self.assertNotIn('secret-internal-lease',json.dumps(sections))
        forged=snapshot(task='another');forged['context']={'parent_trace_id':'not-authorized'}
        with self.assertRaises(Forbidden):service.record(self.token,'w',forged)

    def test_deleted_trace_cannot_be_resurrected_and_payload_budget_is_explicit(self):
        service=self.recorder();receipt=service.record(self.token,'w',snapshot());self.drain();self.metadata.delete(self.token,'w',receipt['trace_id'])
        with self.assertRaises(Conflict):service.record(self.token,'w',snapshot())
        with patch('services.storage.agent_traces.MAX_RECORD_BYTES',128),self.assertRaises(ValueError):service.record(self.token,'w',snapshot(task='new'))

    def test_receipt_verification_requires_exact_indexed_agent_operation_and_current_context(self):
        service=self.recorder();body=snapshot();parent=self.ingest.accept(self.token,'w',packet())['trace_ids'][0];self.drain()
        context={'parent_trace_id':parent,'diagnosis_session_id':'d','request_key':'turn-1'};body['context']=context
        receipt=service.record(self.token,'w',body)
        with self.assertRaises(service.pending):service.verify_receipt(self.token,'w',receipt,context=context,task_id='provider-session')
        self.drain();verified=service.verify_receipt(self.token,'w',receipt,context=context,task_id='provider-session')
        self.assertEqual(verified['state'],'indexed');self.assertEqual(verified['input_hash'],receipt['input_hash'])
        for forged in [dict(receipt,input_hash='0'*64),dict(receipt,receipt_key='wrong'),dict(receipt,task_id='other')]:
            with self.subTest(forged=forged),self.assertRaises(Conflict):service.verify_receipt(self.token,'w',forged,context=context,task_id='provider-session')
        with self.assertRaises(Conflict):service.verify_receipt(self.token,'w',receipt,context={**context,'request_key':'turn-2'},task_id='provider-session')
        with self.assertRaises(Forbidden):service.verify_receipt(self.bob,'w',receipt,context=context,task_id='provider-session')

    def test_regular_actor_owned_batch_and_another_parent_cannot_forge_agent_receipt(self):
        service=self.recorder();body=snapshot();parent=self.ingest.accept(self.token,'w',packet())['trace_ids'][0];self.drain()
        context={'parent_trace_id':parent,'diagnosis_session_id':'d','request_key':'request'};body['context']=context
        receipt=service.record(self.token,'w',body);self.drain()
        other=self.ingest.accept(self.token,'w',packet(trace='b'*32));self.drain()
        forged=copy.deepcopy(receipt);forged['batch_refs']=[{'workspace_id':'w','batch_id':other['batch_id'],'trace_ids':other['trace_ids']}]
        with self.assertRaises(Conflict):service.verify_receipt(self.token,'w',forged,context=context,task_id='provider-session')
        with self.assertRaises(Conflict):service.verify_receipt(self.token,'w',receipt,context={**context,'parent_trace_id':other['trace_ids'][0]},task_id='provider-session')
        self.metadata.delete(self.token,'w',receipt['trace_id'])
        with self.assertRaises(Conflict):service.verify_receipt(self.token,'w',receipt,context=context,task_id='provider-session')

    def test_older_concurrent_replay_cannot_clear_new_pending_or_shrink_full_receipts(self):
        service=self.recorder();body=snapshot()
        with patch('services.storage.agent_traces.MAX_PACKET_SPANS',1):first=service.record(self.token,'w',body)
        self.drain();changed=snapshot(answer='updated')
        with patch.object(self.ingest,'accept_import',side_effect=OSError('offline')):
            with self.assertRaises(service.pending):service.record(self.token,'w',changed)
        with self.control.read_transaction() as con:_,_,before=service._annotation(con,'w',first['trace_id'])
        pending=before['pending'];op=before['operations'][first['input_hash']];original=self.ingest.accept_import;count=0
        def partial(*args,**kwargs):
            nonlocal count
            count+=1
            if count==2:raise OSError('old retry interrupted')
            return original(*args,**kwargs)
        with patch.object(self.ingest,'accept_import',side_effect=partial),self.assertRaises(service.pending):service._submit(self.token,'w',first['trace_id'],first['input_hash'],op['plan_digest'])
        with self.control.read_transaction() as con:_,_,after=service._annotation(con,'w',first['trace_id'])
        self.assertEqual(after['pending'],pending);self.assertEqual(after['operations'][first['input_hash']]['batch_refs'],op['batch_refs'])
        service._submit(self.token,'w',first['trace_id'],first['input_hash'],op['plan_digest'])
        with self.control.read_transaction() as con:_,_,after=service._annotation(con,'w',first['trace_id'])
        self.assertEqual(after['pending'],pending)
        resumed=service.record(self.token,'w',changed);self.drain();self.assertEqual(resumed['trace_id'],first['trace_id'])

    def test_unavailable_provider_failure_retains_old_history_and_records_explicit_coverage(self):
        service=self.recorder();first=service.record(self.token,'w',snapshot());self.drain()
        body=snapshot();body['rawMessages']=[];body['record']['source_messages_unavailable']=True
        body['record']['interactions']=[{'role':'system','error':{'code':'MODEL_ERROR','message':'provider disconnected'},'timestamp':'2026-11-12T00:00:03Z'}]
        body['record']['failures']=[{'context':'MODEL_ERROR','description':'provider disconnected'}];body['record'].pop('final_result')
        service.record(self.token,'w',body);self.drain();full=self.transfer.reads.session(self.token,'w',first['trace_id'],view='full')
        self.assertEqual(len(full['interactions']),3);self.assertEqual(full['interactions'][1]['content'],'answer');self.assertEqual(full['interactions'][2]['error']['message'],'provider disconnected')
        from services.storage.trace_evidence import TraceEvidence
        evidence=TraceEvidence(self.queries,self.authorized).read(self.token,'w',task_id='provider-session')
        self.assertTrue(evidence['execution']['source_messages_unavailable']);self.assertIsNone(evidence['execution']['finalResult'])

    def test_failed_turn_then_success_retains_local_errors_without_rejecting_provider_history(self):
        service=self.recorder();body=snapshot();body['context']={'request_key':'failed-turn'}
        failure={'role':'system','error':{'code':'MODEL_ERROR','message':'actual failure'},'timestamp':'2026-11-12T00:00:02Z'}
        body['record']['interactions'].append(failure);body['record']['failures']=[{'context':'MODEL_ERROR'}]
        first=service.record(self.token,'w',body);self.drain()
        same_time=copy.deepcopy(body);same_time['context']['request_key']='second-failed-turn'
        service.record(self.token,'w',same_time);self.drain()
        recovered=snapshot();recovered['context']={'request_key':'recovered-turn'}
        service.record(self.token,'w',recovered);self.drain()
        full=self.transfer.reads.session(self.token,'w',first['trace_id'],view='full')
        self.assertEqual(sum(item.get('error',{}).get('message')=='actual failure' for item in full['interactions']),2)
        self.assertEqual(sum(item.get('_providerMessageId')=='message-assistant' for item in full['interactions']),1)

    def test_direct_request_response_provenance_is_preserved_without_fake_sdk_messages(self):
        service=self.recorder();body=snapshot(task='direct-request');body['record']['framework']='direct-llm'
        body['record'].pop('final_result');body['record']['failures']=[{'context':'PARSE_FAILED','description':'actual parse error'}]
        raw=[{'format':'agent-insight.direct-message','version':1,'source':'direct-llm','id':'direct-message-'+str(i),'role':role,'content':content} for i,(role,content) in enumerate([('system','actual rubric'),('user','actual full input'),('assistant','partial response')])]
        body['rawMessages']=raw;body['record']['interactions']=[{**item,'_providerMessageId':item['id'],'_providerMessage':copy.deepcopy(item)} for item in raw]
        body['record']['interactions'][2].update(status='error',error={'code':'PARSE_FAILED','message':'actual parse error'})
        receipt=service.record(self.token,'w',body);self.drain();full=self.transfer.reads.session(self.token,'w',receipt['trace_id'],view='full')
        self.assertEqual(len(full['interactions']),3);self.assertEqual(full['interactions'][2]['content'],'partial response')
        self.assertEqual([item['_providerMessage'] for item in full['interactions']],raw)
        summary=self.facts.summaries[('w',receipt['trace_id'])];self.assertEqual(summary['framework'],'direct-llm');self.assertEqual(summary['llm_call_count'],1);self.assertEqual(summary['execution_status'],'failed')
