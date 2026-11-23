import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.authorized import AuthorizedStorage
from services.storage.control import SQLiteControlStore, Conflict
from services.storage.iam import IAMStore, Forbidden
from services.storage.observations import ObservationIngest
from services.storage.trace_metadata import TraceMetadata
from services.storage.trace_service import TraceQueries
from services.storage.tests.test_trace_transfer import MemoryFacts, node


class CurrentFacts(MemoryFacts):
    def read_spans(self,*args,**kwargs):
        workspace,bucket,trace=args[:3];after=kwargs.get('after_span_id','');limit=kwargs.get('limit',200)
        return [copy.deepcopy(row) for (w,t,sid),row in sorted(self.spans.items()) if w==workspace and t==trace and sid>after and not row.get('is_deleted')][:limit]


class CollectorSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1794873600000
        self.control=self.make_control();self.control.initialize();self.iam=IAMStore(self.control)
        for name in ('admin','alice','bob'):self.iam.create_principal(name,name,name)
        self.iam.create_group('g','g','Group','admin')
        for name in ('alice','bob'):self.iam.set_membership_for_provisioning('g',name,'member')
        self.control.create_workspace('w','Workspace');self.iam.bind_workspace('w',group_id='g')
        self.tokens={name:self.iam.issue_session_for_provisioning(name,ttl_ms=86400000) for name in ('admin','alice','bob')}
        self.token=self.tokens['alice'];self.api=self.iam.issue_api_credential(self.token,'w',['write'],ttl_ms=30*86400000)
        self.facts=CurrentFacts();self.ingest=ObservationIngest(self.control,self.facts);self.metadata=TraceMetadata(self.control)
        self.queries=TraceQueries(self.control,self.facts,cursor_secret=b'collector-source-private-test-secret');self.authorized=AuthorizedStorage(self.iam,self.facts)

    def make_control(self):return SQLiteControlStore(Path(self.tmp.name)/'core.db',clock=lambda:self.now)
    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.collector_sources'),'public collector source ledger required')
        from services.storage.collector_sources import CollectorSources
        return CollectorSources(self.control,self.ingest)
    def body(self,key='one',task='task',execution='execution',framework='pi-agent',operation='snapshot',raw=None,**extra):
        return {'operation_key':key,'operation':operation,'task_id':task,'execution_id':execution,'framework':framework,
                'legacy_username':'legacy-alice','operation_request':raw if raw is not None else {'task_id':task,'opaque':{'扩展':0.4}},**extra}
    def snapshot(self,items=None,**execution):
        value=node(identity='execution',task='task',interactions=items if items is not None else [
            {'role':'user','content':'question','_providerMessageId':'u'},
            {'role':'assistant','content':'answer','_providerMessageId':'a','usage':{'input':0,'output':4},'tool_calls':[{'id':'tool','function':{'name':'read','arguments':'{}'},'output':'full tool text'}]}])
        value['execution'].update(framework='pi-agent',skill='fixture',skillVersion=0,answerScore=0,cost=0.4);value['execution'].update(execution)
        return value
    def reserve(self,key='one',**extra):return self.service().reserve(self.api,'w',self.body(key,**extra))
    def commit(self,reserved,snapshot=None):
        return self.service().commit(self.api,'w',{'task_id':reserved['task_id'],'operation_key':reserved['operation_key'],
            'expected_revision':reserved['base_revision'],'snapshot':snapshot or self.snapshot()})
    def drain(self):
        for _ in range(100):
            if not self.ingest.work_once('collector-test'):return
        self.fail('collector outbox did not drain')
    def read(self,trace):
        from services.storage.trace_evidence import TraceEvidence
        return TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)
    def heads(self,trace):
        with self.control.read_transaction() as con:return {row['entity_id']:dict(row) for row in con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id='w' AND trace_id=? AND entity_kind='span'",(trace,))}

    def test_write_only_api_reserves_private_source_and_indexes_exact_original_capsules(self):
        reserved=self.reserve();self.assertEqual(reserved['state'],'reserved');self.assertIsNone(reserved['snapshot']);self.assertEqual(self.facts.spans,{})
        value=self.snapshot();value['session']['interactions'][1]['opaque']={'浮点':0.4,'big':2**62,'null':None}
        accepted=self.commit(reserved,value);self.assertEqual(accepted['state'],'accepted');self.assertTrue(accepted['batch_refs']);self.drain()
        done=self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'});self.assertEqual(done['state'],'indexed')
        evidence=self.read(done['trace_id']);self.assertEqual(evidence['execution']['id'],'execution');self.assertEqual(evidence['execution']['taskId'],'task')
        self.assertEqual(evidence['execution']['skillVersion'],0);self.assertEqual(evidence['execution']['answerScore'],0);self.assertEqual(evidence['execution']['cost'],0.4)
        self.assertEqual(evidence['session']['interactions'][1]['opaque'],value['session']['interactions'][1]['opaque'])
        self.assertEqual(evidence['session']['interactions'][1]['tool_calls'][0]['output'],'full tool text')
        self.assertNotIn(self.api,json.dumps(done));self.assertNotIn(str(self.control.artifact_directory),json.dumps(done))

    def test_completion_first_has_no_fake_facts_and_keeps_bucket_and_time_across_retry(self):
        source=self.body('complete',operation='complete',framework=None,completion_at_ms=1794873600000)
        complete=self.service().complete(self.api,'w',source);self.assertEqual(complete['state'],'indexed');self.assertEqual(self.facts.spans,{})
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM obs_entity_heads').fetchone()[0],0)
            bucket=con.execute('SELECT trace_bucket FROM trace_locators').fetchone()[0]
        self.now+=3600000;again=self.service().complete(self.api,'w',source);self.assertEqual(again['completed_at_ms'],complete['completed_at_ms'])
        reserved=self.reserve('snapshot',started_at_ms=1794787200000);value=self.snapshot();value['execution']['timestamp']='2026-11-16T00:00:00Z';value['session']['startTime']='2026-11-16T00:00:00Z'
        self.commit(reserved,value);self.drain();evidence=self.read(complete['trace_id'])
        self.assertEqual(evidence['session']['endTime'],'2026-11-17T00:00:00.000Z')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT trace_bucket FROM trace_locators').fetchone()[0],bucket)

    def test_receipt_replay_is_frozen_and_key_content_conflict_does_not_rewrite(self):
        first=self.reserve();accepted=self.commit(first);self.drain();before=self.heads(accepted['trace_id']);self.now+=9000
        replay=self.reserve();self.assertEqual(replay['state'],'indexed');self.assertTrue(replay['duplicate']);self.assertEqual(replay['received_at_ms'],first['received_at_ms'])
        with self.assertRaises(Conflict):self.reserve(raw={'different':True})
        self.assertEqual(before,self.heads(accepted['trace_id']))

    def test_new_request_can_resume_a_prior_reserved_and_committed_operation(self):
        old=self.reserve('old');pending=self.reserve('new',raw={'next':True});self.assertEqual(pending['operation_key'],'old');self.assertTrue(pending['resume_pending']);self.assertEqual(pending['operation_request'],old['operation_request'])
        accepted=self.commit(pending);again=self.reserve('new',raw={'next':True});self.assertEqual(again['operation_key'],'old');self.assertEqual(again['state'],'accepted')
        self.drain();new=self.reserve('new',raw={'next':True});self.assertEqual(new['operation_key'],'new');self.assertEqual(new['base_revision'],'1');self.assertEqual(new['snapshot']['execution']['id'],'execution')

    def test_source_canonical_execution_alias_survives_new_incoming_upload_id(self):
        first=self.reserve();self.commit(first);self.drain();second=self.reserve('second',execution='incoming-id')
        self.assertEqual(second['execution_id'],'execution');self.assertEqual(second['trace_id'],first['trace_id'])
        with self.control.read_transaction() as con:self.assertIsNone(con.execute("SELECT 1 FROM trace_legacy_ids WHERE alias_id='incoming-id'").fetchone())

    def test_wrong_cas_and_changed_committed_snapshot_are_rejected(self):
        first=self.reserve();bad={'task_id':'task','operation_key':'one','expected_revision':'99','snapshot':self.snapshot()}
        with self.assertRaises(Conflict):self.service().commit(self.api,'w',bad)
        self.commit(first)
        with self.assertRaises(Conflict):self.commit(first,self.snapshot(query='different'))

    def test_snapshot_shrink_retires_facts_and_reappearance_uses_same_identity(self):
        original=self.snapshot([{'role':'assistant','content':'old','_providerMessageId':'a','model':'removed-model','error':'bad','usage':{'input':7,'output':2}},
                                {'role':'tool','name':'removed-tool','content':'old tool','_providerMessageId':'tool'},
                                {'role':'user','content':'keep','_providerMessageId':'u'}],skills=['removed-skill'],invokedSkills=[{'name':'removed-skill','version':0}])
        first=self.reserve();receipt=self.commit(first,original);self.drain();before=self.heads(receipt['trace_id'])
        second=self.reserve('shrink',raw={'shrink':True});clean=self.snapshot([{'role':'user','content':'keep','_providerMessageId':'u'}],skill=None,skills=[],invokedSkills=[],finalResult=None,query='new-query');clean['session']['query']='new-query'
        self.commit(second,clean);self.drain();after=self.heads(receipt['trace_id']);self.assertEqual(set(before),set(after))
        retired=[row for row in self.facts.spans.values() if row['is_deleted']];self.assertEqual(len(retired),2)
        summary=self.facts.summaries[('w',receipt['trace_id'])];self.assertEqual(summary['error_count'] if 'error_count' in summary else json.loads(summary['attributes_json'])['error_count'],0);self.assertEqual(summary['tool_call_count'],0);self.assertEqual(summary['llm_call_count'],0)
        projection=json.loads(summary['attributes_json']);self.assertNotIn('removed-skill',json.dumps(projection));self.assertNotIn('removed-model',json.dumps(projection));self.assertEqual(projection['query'],'new-query')
        evidence=self.read(receipt['trace_id']);self.assertEqual([item['content'] for item in evidence['session']['interactions']],['keep'])
        from services.storage.dataset_generation_sources import GenerationSources
        reader=GenerationSources(self.queries,self.authorized);description=reader.describe(self.token,'w',receipt['trace_id']);source=reader.read_source(self.token,'w',receipt['trace_id'],description['fingerprint']);self.assertEqual(len(source['source']['events']),1)
        third=self.reserve('return',raw={'return':True});self.commit(third,original);self.drain();restored=self.heads(receipt['trace_id'])
        for sid,row in before.items():self.assertGreater(restored[sid]['source_revision'],row['source_revision'])
        self.assertEqual(len(self.read(receipt['trace_id'])['session']['interactions']),3)

    def test_stable_provider_ids_preserve_current_message_order_after_reorder(self):
        first=self.reserve();receipt=self.commit(first);self.drain();before=self.heads(receipt['trace_id'])
        changed=self.snapshot(list(reversed(self.snapshot()['session']['interactions'])));self.commit(self.reserve('reverse',raw={'reverse':True}),changed);self.drain()
        self.assertEqual(set(before),set(self.heads(receipt['trace_id'])))
        self.assertEqual([value['_providerMessageId'] for value in self.read(receipt['trace_id'])['session']['interactions']],['a','u'])

    def test_epoch_zero_snapshot_keeps_zero_times_without_relaxing_transfer_defaults(self):
        value=self.snapshot([{'role':'user','content':'epoch','timeInfo':{'created':0,'completed':0}}]);value['execution']['timestamp']='1970-01-01T00:00:00.000Z';value['session']['startTime']='1970-01-01T00:00:00.000Z'
        accepted=self.commit(self.reserve(started_at_ms=0),value);self.drain();self.assertEqual(self.facts.summaries[('w',accepted['trace_id'])]['started_at_ms'],0)
        from services.storage.trace_transfer import _ms
        with self.assertRaises(ValueError):_ms('1970-01-01T00:00:00.000Z')

    def test_owner_scope_deletion_and_preexisting_nonledger_namespace_are_not_adopted(self):
        first=self.reserve();bob=self.iam.issue_api_credential(self.tokens['bob'],'w',['write']);admin=self.iam.issue_api_credential(self.tokens['admin'],'w',['write'])
        for token in (bob,admin):
            with self.assertRaises(Forbidden):self.service().reserve(token,'w',self.body())
        with self.control.transaction() as con:con.execute("UPDATE trace_locators SET state='deleting' WHERE trace_id=?",(first['trace_id'],))
        with self.assertRaises(Conflict):self.commit(first)

    def test_untrusted_ordinary_otlp_cannot_create_or_append_reserved_source_namespace(self):
        from services.storage.tests.test_observations import packet
        from services.storage.trace_transfer import _attribute
        value=packet();value['resourceSpans'][0]['resource']['attributes'].append(_attribute('agent_insight.source_namespace','collector.source.v1'))
        with self.assertRaises(Forbidden):self.ingest.accept(self.api,'w',value)

    def test_failed_ch_publish_keeps_pending_and_retry_reuses_heads_and_plan(self):
        first=self.reserve();receipt=self.commit(first);original=self.facts._insert;failed=False
        def fail_once(table,rows):
            nonlocal failed
            if not failed:failed=True;raise OSError('isolated sink failure')
            return original(table,rows)
        self.facts._insert=fail_once;self.assertTrue(self.ingest.work_once('one'));before=self.heads(receipt['trace_id']);pending=self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'});self.assertEqual(pending['state'],'prepared')
        self.now+=10000;self.drain();self.assertEqual(before,self.heads(receipt['trace_id']));self.assertEqual(self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'})['state'],'indexed')

    def test_public_payload_cannot_claim_internal_context_or_change_source_framework(self):
        raw=self.body();raw['context']={'experiment_id':'forged'}
        with self.assertRaises(ValueError):self.service().reserve(self.api,'w',raw)
        first=self.reserve();self.commit(first);self.drain()
        with self.assertRaises(Conflict):self.reserve('other',framework='opencode')

    def test_retired_head_artifact_or_ledger_tampering_is_not_a_skip_permission(self):
        first=self.reserve();receipt=self.commit(first);self.drain();second=self.reserve('shrink',raw={'shrink':True});self.commit(second,self.snapshot([{'role':'user','content':'question','_providerMessageId':'u'}]));self.drain()
        with self.control.transaction() as con:
            row=con.execute('SELECT extra_json FROM trace_annotations WHERE trace_id=?',(receipt['trace_id'],)).fetchone();extra=json.loads(row[0]);extra['collector_source_v1']['entities']={};con.execute('UPDATE trace_annotations SET extra_json=?,revision=revision+1 WHERE trace_id=?',(json.dumps(extra),receipt['trace_id']))
        from services.storage.trace_evidence import EvidenceUnavailable
        with self.assertRaises(EvidenceUnavailable):self.read(receipt['trace_id'])

    def test_multibatch_private_snapshot_never_exposes_partial_current_dto(self):
        from services.storage.collector_sources import CollectorSourcePending
        items=[{'role':'assistant','content':str(i),'_providerMessageId':str(i)} for i in range(5)]
        with patch('services.storage.collector_sources.MAX_PACKET_SPANS',2):
            first=self.reserve();receipt=self.commit(first,self.snapshot(items));self.assertEqual(len(receipt['batch_refs']),3)
            with self.assertRaises(CollectorSourcePending):self.queries.summary(self.token,'w',receipt['trace_id'])
            self.assertTrue(self.ingest.work_once('first'))
            self.assertNotEqual(self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'})['state'],'indexed')
            with self.assertRaises(CollectorSourcePending):self.queries.list_traces(self.token,'w')
            self.drain();self.assertEqual(len(self.read(receipt['trace_id'])['session']['interactions']),5)

    def test_actual_nested_tool_failure_is_a_tool_fact_and_retires_with_message(self):
        value=self.snapshot([{'role':'assistant','content':'done','_providerMessageId':'a','tool_calls':[{'id':'failed-tool','function':{'name':'read','arguments':'{}'},'output':'full failure','state':{'status':'error'}}]}, {'role':'user','content':'next','_providerMessageId':'u'}])
        receipt=self.commit(self.reserve(),value);self.drain();summary=self.facts.summaries[('w',receipt['trace_id'])]
        self.assertEqual(summary['llm_call_count'],1);self.assertEqual(summary['tool_call_count'],1);self.assertEqual(json.loads(summary['attributes_json'])['tool_error_count'],1)
        next_value=self.snapshot([{'role':'user','content':'next','_providerMessageId':'u'}]);self.commit(self.reserve('clean',raw={'clean':True}),next_value);self.drain()
        summary=self.facts.summaries[('w',receipt['trace_id'])];self.assertEqual(summary['tool_call_count'],0);self.assertEqual(json.loads(summary['attributes_json'])['tool_error_count'],0)

    def test_completed_messages_do_not_end_an_ongoing_session_until_completion_is_indexed(self):
        from services.storage.collector_sources import CollectorSourcePending
        receipt=self.commit(self.reserve());self.drain();summary=self.queries.summary(self.token,'w',receipt['trace_id'])['trace'];self.assertEqual(summary['execution_status'],'running')
        self.assertEqual(json.loads(summary['attributes_json'])['running_count'],0)
        completion=self.service().complete(self.api,'w',self.body('completion',operation='complete',completion_at_ms=self.now+2000))
        self.assertEqual(completion['state'],'accepted')
        with self.assertRaises(CollectorSourcePending):self.queries.summary(self.token,'w',receipt['trace_id'])
        self.drain();self.assertEqual(self.queries.summary(self.token,'w',receipt['trace_id'])['trace']['execution_status'],'done')
        self.assertEqual(self.read(receipt['trace_id'])['session']['endTime'],'2026-11-17T00:00:02.000Z')

    def test_langfuse_primary_nodes_and_secondary_original_interactions_survive_reorder_and_shrink(self):
        value=self.snapshot([{'role':'user','content':'secondary raw'}]);value['session']['langfuseTraceNodes']=[
            {'spanId':'lf-1','kind':'llm','name':'first','startedAt':1794873600000,'completedAt':1794873601000,'output':'first output'},
            {'spanId':'lf-2','kind':'tool','name':'read','startedAt':1794873601000,'completedAt':1794873602000,'output':'second output'}]
        receipt=self.commit(self.reserve(),value);self.drain()
        second=self.reserve('lf-shrink',raw={'lf':True});value['session']['langfuseTraceNodes'].pop(0);self.commit(second,value);self.drain()
        evidence=self.read(receipt['trace_id']);self.assertEqual(evidence['session']['interactions'][0]['content'],'secondary raw');self.assertEqual([v['spanId'] for v in evidence['session']['langfuseTraceNodes']],['lf-2'])
        from services.storage.compatibility import LegacyTraceReads
        direct=LegacyTraceReads(self.queries,self.authorized).session(self.token,'w',receipt['trace_id'],view='full');self.assertEqual(direct['langfuseTraceNodes'][0]['spanId'],'lf-2');self.assertEqual(direct['interactions'][0]['content'],'secondary raw')

    def test_known_privileged_origin_fields_cannot_be_claimed_inside_snapshot_metadata(self):
        first=self.reserve()
        for key,value in [('recorderContext',{'experiment_id':'x'}),('experiment_fence','7'),('sourceKind','diagnosis')]:
            snapshot=self.snapshot();snapshot['execution'][key]=value
            with self.subTest(key=key):
                with self.assertRaises(ValueError):self.commit(first,snapshot)

    def test_preexisting_owned_reserved_namespace_without_ledger_is_not_provenance(self):
        source=AuthorizedStorage(self.iam,self.facts).create_trace(self.token,'w','preexisting','2026-11-17',source_namespace='collector.source.v1',native_trace_id='a'*32)
        self.metadata.register_aliases_for_provisioning('w','preexisting',task_id='task',execution_id='execution')
        with self.assertRaises(Conflict):self.reserve()

    def test_shrink_recomputes_bounds_and_drops_retired_projection_provider(self):
        value=self.snapshot([{'role':'assistant','content':'old','_providerMessageId':'old','timeInfo':{'created':1794873600000,'completed':1794873609000},'model':'retired-model'}, {'role':'user','content':'new','_providerMessageId':'new','timeInfo':{'created':1794873603000,'completed':1794873604000}}]);receipt=self.commit(self.reserve(),value);self.drain()
        clean=self.snapshot([value['session']['interactions'][1]],model=None,query='new-query',finalResult=None);clean['session']['query']='new-query'
        self.commit(self.reserve('shrink-bounds',raw={'bounds':True}),clean);self.drain();summary=self.queries.summary(self.token,'w',receipt['trace_id'])['trace']
        self.assertEqual(summary['started_at_ms'],1794873603000);self.assertEqual(summary['ended_at_ms'],1794873604000);self.assertNotIn('retired-model',json.dumps(summary))

    def test_identical_old_commit_replays_after_later_completion_without_repreparing(self):
        first=self.reserve();snapshot=self.snapshot();receipt=self.commit(first,snapshot);self.drain()
        self.service().complete(self.api,'w',self.body('later-complete',operation='complete',completion_at_ms=self.now+5000));self.drain();heads=self.heads(receipt['trace_id'])
        replay=self.commit(first,snapshot);self.assertEqual(replay['state'],'indexed');self.assertTrue(replay['duplicate']);self.assertEqual(self.heads(receipt['trace_id']),heads)
        self.assertEqual(self.read(receipt['trace_id'])['session']['endTime'],'2026-11-17T00:00:05.000Z')
        newer=self.snapshot(query='newer');newer['session']['query']='newer';self.commit(self.reserve('newer',raw={'newer':True}),newer);self.drain();heads=self.heads(receipt['trace_id'])
        self.assertTrue(self.commit(first,snapshot)['duplicate']);self.assertEqual(self.heads(receipt['trace_id']),heads);self.assertEqual(self.read(receipt['trace_id'])['execution']['query'],'newer')

    def test_explicit_message_epoch_zero_is_not_replaced_by_nonzero_session_anchor(self):
        snapshot=self.snapshot([{'role':'user','content':'epoch','timeInfo':{'created':0,'completed':0}}]);receipt=self.commit(self.reserve(),snapshot);self.drain()
        self.assertEqual(self.facts.summaries[('w',receipt['trace_id'])]['started_at_ms'],0)
        self.assertEqual(self.read(receipt['trace_id'])['session']['interactions'][0]['timeInfo']['created'],0)

    def test_attested_first_device_binding_is_retained_for_later_api_only_snapshots(self):
        first=self.reserve(verified_client_id='device-A');receipt=self.commit(first);self.drain();self.assertEqual(self.read(receipt['trace_id'])['execution']['clientId'],'device-A')
        second=self.reserve('api-only',raw={'api':True});value=self.snapshot(clientId='unverified-B');self.commit(second,value);self.drain();self.assertEqual(self.read(receipt['trace_id'])['execution']['clientId'],'device-A')
        third=self.reserve('other-device',raw={'device':True},verified_client_id='device-B');self.commit(third,self.snapshot(clientId='device-B'));self.drain();self.assertEqual(self.read(receipt['trace_id'])['execution']['clientId'],'device-A')

    def test_raw_initial_device_binding_is_not_accepted_as_attestation(self):
        receipt=self.commit(self.reserve(),self.snapshot(clientId='body-forged'));self.drain();self.assertIsNone(self.read(receipt['trace_id'])['execution']['clientId'])

    def test_deterministic_preparation_rejection_retains_failed_receipt_and_fences_late_commit(self):
        first=self.reserve(raw={'timestamp':'invalid'});failure={'task_id':'task','operation_key':'one','input_hash':first['input_hash'],'error_code':'INVALID_SOURCE_INPUT'}
        rejected=self.service().reject_preparation(self.api,'w',failure);self.assertEqual(rejected['state'],'failed');self.assertEqual(rejected['operation_request'],{'timestamp':'invalid'})
        with self.assertRaises(Conflict):self.commit(first)
        second=self.reserve('correct',raw={'timestamp':'2026-11-17T00:00:00Z'});self.assertEqual(second['state'],'reserved')
        replay=self.service().reject_preparation(self.api,'w',failure);self.assertTrue(replay['duplicate']);self.assertEqual(self.reserve('newest',raw={'newest':True})['operation_key'],'correct')
        self.assertEqual(self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'})['state'],'failed')

    def test_preparation_rejection_cannot_discard_committed_or_transient_failures(self):
        first=self.reserve();failure={'task_id':'task','operation_key':'one','input_hash':first['input_hash'],'error_code':'MODEL_UNAVAILABLE'}
        with self.assertRaises(ValueError):self.service().reject_preparation(self.api,'w',failure)
        self.assertEqual(self.reserve('next',raw={'next':True})['operation_key'],'one');self.commit(first)
        failure['error_code']='INVALID_SOURCE_INPUT'
        with self.assertRaises(Conflict):self.service().reject_preparation(self.api,'w',failure)
        self.assertEqual(self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'})['state'],'accepted')

    def test_ras_fallback_reads_only_current_capsule_when_compact_subagent_flag_does_not_fit(self):
        import time
        from services.storage.trace_analytics import TraceAnalytics
        original=self.snapshot([{'role':'assistant','content':'old','_providerMessageId':'old'}, {'role':'user','content':'child','_providerMessageId':'child'}]);receipt=self.commit(self.reserve(),original);self.drain()
        current=self.snapshot([original['session']['interactions'][1]],isSubagent=True,query='q'*500,label='l'*500,model='m'*500,observedIp='i'*456,sourceKind='upload');current['session'].update(query='q'*500,label='l'*500)
        self.commit(self.reserve('child',raw={'child':True}),current);self.drain();summary=self.facts.summaries[('w',receipt['trace_id'])];self.assertNotIn('is_subagent',json.loads(summary['attributes_json']))
        service=TraceAnalytics(self.queries,self.authorized)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,self.token);result=service._ras_trace_link(con,scope,'w','task',deadline=time.monotonic()+60)
        self.assertIsNone(result['execution_id'])

    def test_current_device_headers_do_not_change_the_same_original_operation_identity(self):
        first=self.reserve(verified_client_id='device-A');retried=self.reserve();self.assertTrue(retried['duplicate']);self.assertEqual(retried['provenance']['verified_client_id'],'device-A')
        again=self.reserve(verified_client_id='device-B');self.assertEqual(again['provenance']['verified_client_id'],'device-A')
        with self.assertRaises(Conflict):self.reserve(verified_client_id='device-B',raw={'changed':True})
        receipt=self.commit(retried);self.drain();self.assertEqual(self.read(receipt['trace_id'])['execution']['clientId'],'device-A')

    def test_unknown_nullable_framework_is_preserved_until_first_real_framework_binding(self):
        first=self.reserve(framework=None);value=self.snapshot(framework=None);receipt=self.commit(first,value);self.drain();self.assertIsNone(self.read(receipt['trace_id'])['execution']['framework'])
        next_value=self.snapshot();self.commit(self.reserve('known',raw={'known':True}),next_value);self.drain();self.assertEqual(self.read(receipt['trace_id'])['execution']['framework'],'pi-agent')
        with self.assertRaises(Conflict):self.reserve('foreign-framework',framework='opencode')

    def test_public_portable_export_preserves_original_metrics_nulls_raw_items_and_overrides(self):
        from services.storage.trace_transfer import LegacyTraceTransfer
        value=self.snapshot();value['execution'].update(rootExecutionId=None,framework=None,tokens=0,inputTokens=None,toolCallCount=None,latency=0,finalResult=None);value['session']['endTime']='2026-11-12T00:00:02.000Z'
        receipt=self.commit(self.reserve(framework=None),value);self.drain();service=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest)
        exported=service.export(self.token,'w','execution')['executions'][0]
        for key in ('rootExecutionId','framework','tokens','inputTokens','toolCallCount','latency','finalResult','skillVersion'):self.assertEqual(exported['execution'][key],value['execution'][key])
        self.assertEqual(exported['session']['interactions'],value['session']['interactions']);self.assertEqual(exported['session']['endTime'],value['session']['endTime']);self.assertNotIn('user',exported['execution'])
        self.metadata.patch(self.token,'w',receipt['trace_id'],{'query':'manual override'})
        changed=service.export(self.token,'w','execution')['executions'][0];self.assertEqual(changed['execution']['query'],'manual override');self.assertEqual(changed['session']['query'],'manual override')

    def test_portable_export_of_source_child_keeps_root_and_original_nested_graph(self):
        from services.storage.trace_transfer import LegacyTraceTransfer
        self.commit(self.reserve(),self.snapshot(rootExecutionId=None));self.drain()
        reserved=self.reserve('child',task='child-task',execution='child-execution',raw={'child':True});child=self.snapshot(isSubagent=True,parentExecutionId='execution',rootExecutionId='execution');child['execution'].update(id='child-execution',taskId='child-task');child['session']['taskId']='child-task';self.commit(reserved,child);self.drain()
        service=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest);exported=service.export(self.token,'w','child-execution')
        self.assertEqual(exported['rootExecutionId'],'execution');self.assertEqual([item['execution']['id'] for item in exported['executions']],['execution','child-execution']);self.assertIsNone(exported['executions'][0]['execution']['rootExecutionId'])

    def test_original_session_dto_uses_captured_nullable_framework_and_explicit_zero_metrics(self):
        from services.storage.compatibility import LegacyTraceReads
        value=self.snapshot(framework=None,tokens=0,latency=0,cost=0.4);receipt=self.commit(self.reserve(framework=None),value);self.drain()
        result=LegacyTraceReads(self.queries,self.authorized).session(self.token,'w',receipt['trace_id'],view='full')
        self.assertIsNone(result['execution']['framework']);self.assertEqual(result['execution']['tokens'],0);self.assertEqual(result['execution']['latency'],0);self.assertEqual(result['execution']['cost'],0.4)

    def test_new_alias_cannot_shadow_an_existing_internal_trace_identity(self):
        AuthorizedStorage(self.iam,self.facts).create_trace(self.token,'w','existing-internal','2026-11-17',source_namespace='ordinary',native_trace_id='b'*32)
        for task,execution in [('new-task','existing-internal'),('existing-internal','new-execution')]:
            with self.subTest(task=task):
                with self.assertRaises(Conflict):self.reserve(task=task,execution=execution)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],1)

    def test_indexed_source_missing_summary_cannot_look_pending_or_empty(self):
        from services.storage.collector_sources import CollectorSourcePending
        receipt=self.commit(self.reserve());self.drain();self.assertEqual(self.service().status(self.api,'w',{'task_id':'task','operation_key':'one'})['state'],'indexed')
        self.facts.summaries.pop(('w',receipt['trace_id']))
        for read in (lambda:self.queries.summary(self.token,'w',receipt['trace_id']),lambda:self.queries.list_traces(self.token,'w')):
            with self.assertRaises(CollectorSourcePending):read()

    def test_source_summary_scope_bucket_and_revision_are_checked_before_returning(self):
        from services.storage.collector_sources import CollectorSourcePending
        receipt=self.commit(self.reserve());self.drain();key=('w',receipt['trace_id']);original=copy.deepcopy(self.facts.summaries[key])
        for changes in ({'workspace_id':'foreign'}, {'trace_bucket':'2026-11-13'}, {'revision':999}, {'source_namespace':'otlp'}, {'native_trace_id':'f'*32}):
            self.facts.summaries[key]={**original,**changes}
            with self.subTest(changes=changes):
                with self.assertRaises(CollectorSourcePending):self.queries.summary(self.token,'w',receipt['trace_id'])
        self.facts.summaries[key]=original

    def test_filtered_source_omission_is_verified_without_reimplementing_ch_filters(self):
        receipt=self.commit(self.reserve());self.drain();original=self.facts._request
        for options,parameter,predicate in [({'status':'done'},'status','execution_status={status:String}'),({'agent':'not-a-match'},'agent','positionCaseInsensitiveUTF8(agent_name,{agent:String})'),({'search':'not-a-match'},'search',"positionCaseInsensitiveUTF8(concat(trace_id,' ',native_trace_id,' ',agent_name),{search:String})")]:
            calls=[]
            def filtered(sql,*,parameters):
                calls.append((sql,copy.deepcopy(parameters)))
                return b'' if parameter in parameters else original(sql,parameters=parameters)
            with patch.object(self.facts,'_request',side_effect=filtered):result=self.queries.list_traces(self.token,'w',**options)
            self.assertEqual(result['items'],[]);self.assertEqual(len(calls),2);self.assertIn(predicate,calls[0][0]);self.assertNotIn(predicate,calls[1][0]);self.assertNotIn(parameter,calls[1][1])
            self.assertEqual(set(value for key,value in calls[1][1].items() if key.startswith('trace_')),{receipt['trace_id']})

    def test_filtered_source_omission_is_not_accepted_when_the_unfiltered_row_is_missing(self):
        from services.storage.collector_sources import CollectorSourcePending
        self.commit(self.reserve());self.drain();self.facts.summaries={};calls=[]
        def omitted(sql,*,parameters):calls.append(copy.deepcopy(parameters));return b''
        with patch.object(self.facts,'_request',side_effect=omitted):
            with self.assertRaises(CollectorSourcePending):self.queries.list_traces(self.token,'w',status='done')
        self.assertEqual(len(calls),2);self.assertNotIn('status',calls[1])

    def test_filtered_presence_probe_rejects_wrong_scope_bucket_and_revision(self):
        from services.storage.collector_sources import CollectorSourcePending
        receipt=self.commit(self.reserve());self.drain();row=copy.deepcopy(self.facts.summaries[('w',receipt['trace_id'])])
        for changes in ({'workspace_id':'foreign'}, {'trace_bucket':'2026-11-13'}, {'revision':999}):
            def wrong(sql,*,parameters):return b'' if 'status' in parameters else json.dumps({**row,**changes}).encode()
            with self.subTest(changes=changes),patch.object(self.facts,'_request',side_effect=wrong):
                with self.assertRaises(CollectorSourcePending):self.queries.list_traces(self.token,'w',status='done')

    def test_source_change_during_presence_probe_discards_the_filtered_result(self):
        self.commit(self.reserve());self.drain();original=self.facts._request;calls=0
        def changed(sql,*,parameters):
            nonlocal calls
            calls+=1
            if 'status' in parameters:return b''
            old=original(sql,parameters=parameters);self.commit(self.reserve('newer-probe',raw={'newer':True}),self.snapshot(query='changed'));self.drain();return old
        with patch.object(self.facts,'_request',side_effect=changed):
            with self.assertRaises(Conflict):self.queries.list_traces(self.token,'w',status='done')
        self.assertEqual(calls,2)

    def test_membership_revocation_during_presence_probe_discards_the_filtered_result(self):
        self.commit(self.reserve());self.drain();original=self.facts._request;calls=0
        def revoked(sql,*,parameters):
            nonlocal calls
            calls+=1
            if 'status' in parameters:return b''
            old=original(sql,parameters=parameters);self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1);return old
        with patch.object(self.facts,'_request',side_effect=revoked):
            with self.assertRaises(Forbidden):self.queries.list_traces(self.token,'w',status='done')
        self.assertEqual(calls,2)

    def test_completion_only_and_uncommitted_first_source_have_no_expected_fact_row(self):
        completion=self.service().complete(self.api,'w',self.body('empty-completion',operation='complete',task='empty-task',execution='empty-execution'))
        reserved=self.reserve('empty-reservation',task='reserved-task',execution='reserved-execution')
        for receipt in (completion,reserved):self.assertEqual(self.queries.summary(self.token,'w',receipt['trace_id']),{'trace':None,'state':'accepted'})
        self.assertEqual(self.queries.list_traces(self.token,'w')['items'],[])

    def test_missing_generic_otlp_summary_keeps_its_existing_read_behavior(self):
        from services.storage.tests.test_observations import packet
        receipt=self.ingest.accept(self.api,'w',packet());self.drain();trace=receipt['trace_ids'][0];self.facts.summaries.pop(('w',trace));calls=[];original=self.facts._request
        def observed(sql,*,parameters):calls.append(copy.deepcopy(parameters));return original(sql,parameters=parameters)
        with patch.object(self.facts,'_request',side_effect=observed):
            self.assertEqual(self.queries.summary(self.token,'w',trace),{'trace':None,'state':'accepted'});self.assertEqual(self.queries.list_traces(self.token,'w',status='done')['items'],[])
        self.assertEqual(len(calls),2)

class CollectorSourceHTTPTests(unittest.TestCase):
    from services.storage.tests.test_trace_service import TraceHTTPTests as _HTTP
    setUp=_HTTP.setUp
    request=_HTTP.request
    def signed(self,value,token=None,principal='alice',workspace='w',purpose='collector-source/v1'):
        import hashlib,hmac
        key=Path(self.temp.name)/'collector-controller';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        digest=hashlib.sha256(json.dumps(value).encode()).hexdigest();proof=hmac.new(bytes.fromhex('a'*64),'\0'.join((purpose,principal,workspace,digest)).encode(),hashlib.sha256).hexdigest()
        return self.request('/v1/compat/collector-source?workspace_id='+workspace,token or self.api,body=value,headers={'x-storage-controller-proof':proof})
    def reservation(self):return {'action':'reserve','operation':'snapshot','operation_key':'one','task_id':'http-task','execution_id':'http-execution','framework':'pi-agent','legacy_username':'legacy-alice','operation_request':{'user':'forged'}}
    def test_private_receipt_requires_exact_controller_purpose_actor_and_body(self):
        value=self.reservation();self.assertEqual(self.request('/v1/compat/collector-source?workspace_id=w',self.api,body=value)[0],403)
        self.assertEqual(self.signed(value,purpose='trace-analytics/v1')[0],403);self.assertEqual(self.signed(value,principal='forged')[0],403)
        status,reply,_=self.signed(value);self.assertEqual(status,200);self.assertEqual(reply['value']['state'],'reserved');self.assertEqual(reply['value']['execution_id'],'http-execution')
        self.assertNotIn(self.api,json.dumps(reply))
    def test_signed_internal_context_and_read_only_capability_are_rejected(self):
        value={**self.reservation(),'context':{'experiment_id':'forged'}};self.assertEqual(self.signed(value)[0],400)
        read=self.iam.issue_api_credential(self.token,'w',['read']);self.assertEqual(self.signed(self.reservation(),token=read)[0],403)
    def test_pending_completion_is_durable_but_does_not_invent_ch_batches(self):
        value=self.reservation();value.update(action='complete',operation='complete',completion_at_ms=1794873600000)
        status,reply,_=self.signed(value);self.assertEqual(status,200);self.assertEqual(reply['value']['state'],'indexed');self.assertEqual(reply['value']['batch_refs'],[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],0)
