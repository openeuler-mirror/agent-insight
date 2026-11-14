import importlib.util
import json
import time
import unittest
from unittest.mock import patch

from services.storage.tests import test_trace_transfer as fixture
from services.storage.control import Conflict
from services.storage.iam import Forbidden, Unauthorized


def request_id():
    stamp=f'{time.time_ns()//1000000:012x}'
    return stamp[:8]+'-'+stamp[8:]+'-7000-8000-000000000001'


class DatasetGenerationTests(unittest.TestCase):
    setUp=fixture.TraceTransferTests.setUp
    drain=fixture.TraceTransferTests.drain

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.dataset_generation'),'core generation must not instantiate Prisma')
        from services.storage.datasets import DatasetStore
        from services.storage.dataset_generation import DatasetGeneration
        return DatasetGeneration(self.control,DatasetStore(self.control),self.queries,self.authorized)

    def config(self,**values):
        return dict(name='Generated',description='',platform='opencode',agentKey='legacy:fixture',from_='2026-11-12T00:00:00.000Z',to='2026-11-13T00:00:00.000Z',limit=5,requestId=request_id())|values

    def create(self,service):
        self.seeded()
        config=self.config();config['from']=config.pop('from_')
        config['agentKey']=service.catalog(self.token,'w',config['from'],config['to'],'opencode')['agents'][0]['agentKey']
        return service.create(self.token,'w',config)

    def claimed(self,service,created,owner):
        claim=service.claim(self.token,'w',created['datasetId'],owner)
        for member in service.source_members(self.token,'w',created['jobId'],claim['epoch'],owner)['items']:
            service.source(self.token,'w',created['jobId'],claim['epoch'],owner,member['id'],member['fingerprint'])
        return claim

    def test_job_idempotency_scope_and_lease_fences(self):
        service=self.service();config=self.config();config['from']=config.pop('from_')
        self.seeded();members=service.sources.catalog_rows(self.token,'w')
        with patch.object(service.sources,'members',return_value=members):
            first=service.create(self.token,'w',config);self.assertEqual(service.create(self.token,'w',config),first)
            with self.assertRaises(Conflict):service.create(self.token,'w',dict(config,name='Changed'))
        with self.assertRaises(Forbidden):service.progress(self.bob,'w',first['datasetId'])
        claim=service.claim(self.token,'w',first['datasetId'],'worker-one');self.assertEqual(claim['epoch'],1)
        self.assertIsNone(service.claim(self.token,'w',first['datasetId'],'worker-two'))
        with self.assertRaises(Conflict):service.checkpoint(self.token,'w',first['jobId'],2,'worker-one',stage='read',stageIndex=0)
        with self.assertRaises(Forbidden):service.checkpoint(self.token,'w',first['jobId'],1,'wrong-owner',stage='read',stageIndex=0)
        self.assertNotIn(self.token,json.dumps(service.progress(self.token,'w',first['datasetId'])))

    def test_complete_publishes_dataset_and_job_in_one_transaction(self):
        service=self.service();created=self.create(service);claim=self.claimed(service,created,'worker')
        cases=[{'id':'case','input':'question','expectedOutput':'answer','evaluationFocus':'','tags':[],'trajectory':'','values':{'input':'question','reference_output':'answer'}}]
        result=service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=cases,summary={'version':1})
        self.assertEqual(result['status'],'published')
        saved=service.datasets.get(self.token,'w',created['datasetId'])
        self.assertEqual(saved['dataset']['cases'],cases);self.assertEqual(saved['dataset']['generationStatus'],'published')
        self.assertEqual(service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=cases,summary={'version':1}),result)
        with self.assertRaises(Conflict):service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[dict(cases[0],input='changed')],summary={'version':1})

    def test_cancel_delete_fence_old_workers_and_keep_terminal_receipt(self):
        service=self.service();created=self.create(service);claim=self.claimed(service,created,'worker')
        removed=service.remove(self.token,'w',created['datasetId'],cancel_only=True)
        self.assertEqual(service.deletion(self.token,'w',removed['deletionId'])['status'],'deleted')
        with self.assertRaises(Conflict):service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[],summary={})
        self.assertIsNone(service.remove(self.token,'w',created['datasetId']))

    def test_expired_lease_only_resumes_under_live_same_actor_credential(self):
        service=self.service();created=self.create(service);first=service.claim(self.token,'w',created['datasetId'],'old')
        original=self.control.clock
        with patch.object(self.control,'clock',return_value=original()+120000):
            reopened=self.service();second=reopened.claim(self.token,'w',created['datasetId'],'new')
            self.assertGreater(second['epoch'],first['epoch'])
            with self.assertRaises(Conflict):reopened.checkpoint(self.token,'w',created['jobId'],first['epoch'],'old')
        self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):service.progress(self.token,'w',created['datasetId'])

    def test_complete_failure_rolls_back_published_dataset_and_terminal_job(self):
        service=self.service();created=self.create(service);claim=self.claimed(service,created,'worker')
        original=service.datasets._save_tx
        def explode(*args,**kwargs):
            original(*args,**kwargs);raise RuntimeError('injected atomic failure')
        with patch.object(service.datasets,'_save_tx',side_effect=explode),self.assertRaises(RuntimeError):
            service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[{'id':'c','values':{'input':'q','reference_output':'a'}}],summary={})
        self.assertEqual(service.progress(self.token,'w',created['datasetId'])['status'],'generating')
        self.assertEqual(service.datasets.get(self.token,'w',created['datasetId'])['dataset']['cases'],[])

    def seeded(self,*,tool_body='',client='one',identity='root',task='task'):
        source=fixture.node(identity,task,root=identity,interactions=[{'role':'user','content':'question','timestamp':1794441600000},
            {'role':'assistant','tool_calls':[{'id':'call','function':{'name':'bash','arguments':'{}'},'output':tool_body}],'timestamp':1794441600100},
            {'role':'assistant','content':'answer','timestamp':1794441600200,'timeInfo':{'completed':1794441600300}}])
        source['execution'].update(finalResult='answer',clientId=client)
        source['session']['endTime']='2026-11-12T00:00:01Z'
        transfer=fixture.bundle([source]);transfer['rootExecutionId']=identity
        self.transfer.import_bundle(self.token,'w',transfer);self.drain()
        return source

    def test_frozen_source_projection_keeps_text_tools_and_client_identity_without_large_tool_output(self):
        service=self.service();self.seeded(tool_body='private-large-result'*300000)
        member=service.sources.catalog_rows(self.token,'w')[0]
        projected=service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])
        self.assertEqual(projected['source']['events'][1]['toolNames'],['bash'])
        self.assertEqual(projected['source']['events'][2]['content'],'answer')
        self.assertTrue(projected['source']['completed']);self.assertFalse(projected['source']['failed'])
        self.assertLess(len(json.dumps(projected)),20000);self.assertNotIn('private-large-result',json.dumps(projected))
        self.assertEqual(member['clientId'],'one')
        with self.assertRaises(Forbidden):service.sources.read_source(self.bob,'w',member['id'],member['fingerprint'])
        self.metadata.patch(self.token,'w',member['id'],{'label':'changed'})
        self.assertEqual(service.sources.read_source(self.token,'w',member['id'],member['fingerprint']),{'reason':'SOURCE_CHANGED'})

    def test_catalog_does_not_merge_same_name_different_clients_and_generation_members_are_frozen(self):
        service=self.service();self.seeded(client='one');self.seeded(client='two',identity='root-two',task='task-two')
        config=self.config();config['from']=config.pop('from_')
        options=service.catalog(self.token,'w',config['from'],config['to'],'opencode')
        self.assertEqual(len(options['agents']),2);self.assertEqual(len({row['agentKey'] for row in options['agents']}),2)
        config['agentKey']=options['agents'][0]['agentKey'];created=service.create(self.token,'w',config)
        claim=self.claimed(service,created,'worker')
        members=service.source_members(self.token,'w',created['jobId'],claim['epoch'],'worker')['items'];self.assertEqual(len(members),1)
        with self.assertRaises(Forbidden):service.source(self.token,'w',created['jobId'],claim['epoch'],'worker','arbitrary','f'*64)

    def test_stale_manual_dataset_edit_prevents_generation_complete_and_delete_uses_current_revision(self):
        service=self.service();created=self.create(service);claim=self.claimed(service,created,'worker')
        service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[{'id':'c','values':{'input':'q','reference_output':'a'}}],summary={})
        saved=service.datasets.get(self.token,'w',created['datasetId']);record=saved['dataset'];record['name']='manual edit'
        updated=service.datasets.save(self.token,'w',record,operation_key='manual',expected_revision=int(saved['revision']))
        with self.assertRaises(Conflict):service.remove(self.token,'w',created['datasetId'],expected_revision=saved['revision'])
        removed=service.remove(self.token,'w',created['datasetId'],expected_revision=updated['revision'])
        self.assertEqual(removed['status'],'deleted')

    def test_restarted_epoch_can_restart_algorithm_from_read_and_rejects_late_tail(self):
        service=self.service();created=self.create(service);first=service.claim(self.token,'w',created['datasetId'],'old')
        service.checkpoint(self.token,'w',created['jobId'],first['epoch'],'old',stage='convert',stageIndex=4)
        with patch.object(self.control,'clock',return_value=self.control.clock()+120000):
            second=service.claim(self.token,'w',created['datasetId'],'new')
            self.assertTrue(service.checkpoint(self.token,'w',created['jobId'],second['epoch'],'new',stage='read',stageIndex=0)['renewed'])

    def test_source_rejects_unindexed_status_and_postflight_annotation_change(self):
        service=self.service();self.seeded();member=service.sources.catalog_rows(self.token,'w')[0]
        summary=self.facts.summaries[('w',member['id'])];summary['execution_status']='running'
        from services.storage.trace_evidence import EvidenceUnavailable
        with self.assertRaises(EvidenceUnavailable):service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])
        summary['execution_status']='done';original=service.sources._source;changed=[False]
        def mutate(*args):
            result=original(*args)
            if not changed[0]:changed[0]=True;self.metadata.patch(self.token,'w',member['id'],{'label':'during-read'})
            return result
        with patch.object(service.sources,'_source',side_effect=mutate),self.assertRaises(Conflict):service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])

    def test_captured_source_survives_restart_without_replacing_snapshot_with_new_trace(self):
        service=self.service();created=self.create(service);claim=self.claimed(service,created,'worker')
        member=service.source_members(self.token,'w',created['jobId'],claim['epoch'],'worker')['items'][0]
        first=service.source(self.token,'w',created['jobId'],claim['epoch'],'worker',member['id'],member['fingerprint'])
        self.metadata.patch(self.token,'w',member['id'],{'label':'changed after sealed capture'})
        reopened=self.service()
        second=reopened.source(self.token,'w',created['jobId'],claim['epoch'],'worker',member['id'],member['fingerprint'])
        self.assertEqual(second,first)
        self.assertNotIn(self.token,json.dumps(second));self.assertNotIn(str(self.control.artifact_directory),json.dumps(second))

    def test_unknown_config_fields_never_persist_actor_credentials(self):
        service=self.service();config=self.config();config['from']=config.pop('from_');config.update(user='forged',token=self.token,password='must-not-store')
        self.seeded();members=service.sources.catalog_rows(self.token,'w')
        with patch.object(service.sources,'members',return_value=members):created=service.create(self.token,'w',config)
        with self.control.read_transaction() as con:row=con.execute('SELECT config_ref FROM dataset_generation_jobs WHERE job_id=?',(created['jobId'],)).fetchone()
        body=__import__('pathlib').Path(row[0]).read_text();self.assertFalse(self.token in body,'actor credential must not be persisted');self.assertFalse('must-not-store' in body)

    def test_complete_requires_captured_sources_and_checks_current_source_access(self):
        service=self.service();created=self.create(service);claim=service.claim(self.token,'w',created['datasetId'],'worker')
        with self.assertRaises(Conflict):service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[{'id':'c','values':{'input':'q','reference_output':'a'}}],summary={})
        member=service.source_members(self.token,'w',created['jobId'],claim['epoch'],'worker')['items'][0]
        service.source(self.token,'w',created['jobId'],claim['epoch'],'worker',member['id'],member['fingerprint'])
        self.metadata.delete(self.token,'w',member['id'])
        with self.assertRaises((Conflict,Forbidden)):service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[{'id':'c','values':{'input':'q','reference_output':'a'}}],summary={})

    def test_recovered_tool_error_does_not_become_a_terminal_execution_failure(self):
        service=self.service()
        source=fixture.node(interactions=[{'role':'user','content':'question'},{'role':'assistant','status':'error','tool_calls':[{'id':'c','function':{'name':'bash'},'state':'error'}]},{'role':'assistant','content':'answer'}])
        source['execution'].update(finalResult='answer',failures=[]);source['session']['endTime']='2026-11-12T00:00:01Z'
        self.transfer.import_bundle(self.token,'w',fixture.bundle([source]));self.drain()
        member=service.sources.catalog_rows(self.token,'w')[0]
        result=service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])
        self.assertFalse(result['source']['failed']);self.assertTrue(result['source']['events'][1]['failed'])

    def test_only_one_concurrent_worker_claims_a_job(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        service=self.service();created=self.create(service);barrier=Barrier(2)
        def claim(owner):
            barrier.wait();return self.service().claim(self.token,'w',created['datasetId'],owner)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(claim,['worker-one','worker-two']))
        self.assertEqual(sum(item is not None for item in results),1)

    def test_recovery_exhaustion_becomes_real_failed_dataset_without_invoking_algorithm(self):
        service=self.service();created=self.create(service);service.claim(self.token,'w',created['datasetId'],'first');now=self.control.clock()
        for attempt in range(1,4):
            with patch.object(self.control,'clock',return_value=now+attempt*120000):
                claimed=service.claim(self.token,'w',created['datasetId'],'worker-'+str(attempt))
                if attempt<3:self.assertIsNotNone(claimed)
                else:self.assertIsNone(claimed)
        progress=service.progress(self.token,'w',created['datasetId'])
        self.assertEqual(progress['status'],'failed');self.assertEqual(progress['error']['code'],'WORKER_RECOVERY_EXHAUSTED')
        self.assertEqual(service.datasets.get(self.token,'w',created['datasetId'])['dataset']['generationStatus'],'failed')

    def native_packet(self,input_value='native question'):
        from services.storage.tests.test_observations import packet
        body=packet();rows=body['resourceSpans'][0]['scopeSpans'][0]['spans']
        rows[0]['attributes'][1]['value']['stringValue']=input_value
        rows[0]['attributes'][2]['value']['stringValue']='native answer'
        tool=__import__('copy').deepcopy(rows[0]);tool.update(spanId='2'*16,parentSpanId='1'*16,name='bash',startTimeUnixNano='1794441600100000000',endTimeUnixNano='1794441600900000000')
        tool['attributes']=[{'key':'gen_ai.tool.name','value':{'stringValue':'bash'}},{'key':'gen_ai.output','value':{'stringValue':'private-native-tool'*250000}}]
        rows.append(tool)
        self.ingest.accept_import(self.token,'w',body);self.drain()
        return body

    def test_native_declared_input_output_produces_frozen_request_pair_without_tool_body(self):
        service=self.service();self.native_packet()
        member=service.sources.catalog_rows(self.token,'w')[0];result=service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])
        users=[event for event in result['source']['events'] if event['role']=='user']
        self.assertEqual(len(users),1);self.assertEqual(users[0]['content'],'native question')
        self.assertEqual(users[0]['origin']['kind'],'otlp-declared-input');self.assertEqual(len(users[0]['origin']['section_sha256']),64)
        self.assertEqual(result['source']['events'][-1]['content'],'native answer');self.assertEqual(result['source']['events'][1]['toolNames'],['bash'])
        self.assertLess(len(json.dumps(result)),20000);self.assertNotIn('private-native-tool',json.dumps(result))

    def test_native_system_only_and_historical_input_do_not_invent_standalone_user_turns(self):
        service=self.service();self.native_packet(json.dumps([{'role':'system','content':'system only'}]))
        member=service.sources.catalog_rows(self.token,'w')[0];result=service.sources.read_source(self.token,'w',member['id'],member['fingerprint'])
        self.assertEqual([event for event in result['source']['events'] if event['role']=='user'],[])

    def test_native_core_job_publishes_one_actual_input_output_case_and_preserves_source_hash(self):
        service=self.service();self.native_packet()
        with self.control.read_transaction() as con:before=[dict(row) for row in con.execute('SELECT * FROM obs_entity_heads ORDER BY entity_kind,entity_id')]
        config=self.config(platform='otlp');config['from']=config.pop('from_')
        options=service.catalog(self.token,'w',config['from'],config['to'],'otlp');self.assertEqual(len(options['agents']),1)
        config['agentKey']=options['agents'][0]['agentKey'];created=service.create(self.token,'w',config);claim=self.claimed(service,created,'worker')
        member=service.source_members(self.token,'w',created['jobId'],claim['epoch'],'worker')['items'][0]
        projection=service.source(self.token,'w',created['jobId'],claim['epoch'],'worker',member['id'],member['fingerprint'])
        events=projection['source']['events'];question=next(event['content'] for event in events if event['role']=='user');answer=next(event['content'] for event in events if event['role']=='assistant')
        done=service.complete(self.token,'w',created['jobId'],claim['epoch'],'worker',cases=[{'id':'native-case','values':{'input':question,'reference_output':answer}}],summary={'version':1,'sourceTraces':1})
        self.assertEqual(done['status'],'published')
        saved=service.datasets.get(self.token,'w',created['datasetId'])['dataset'];self.assertEqual(saved['cases'][0]['values'],{'input':'native question','reference_output':'native answer'})
        with self.control.read_transaction() as con:self.assertEqual([dict(row) for row in con.execute('SELECT * FROM obs_entity_heads ORDER BY entity_kind,entity_id')],before)

    def members_after_load(self,service,created,claim,change):
        original=service._load;changed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True;change(value)
            return value
        with patch.object(service,'_load',side_effect=load):
            return service.source_members(self.token,'w',created['jobId'],claim['epoch'],'worker')

    def test_member_page_is_discarded_if_credential_is_revoked_during_artifact_read(self):
        service=self.service();created=self.create(service);claim=service.claim(self.token,'w',created['datasetId'],'worker')
        with self.assertRaises(Unauthorized):
            self.members_after_load(service,created,claim,lambda _:self.iam.revoke_credential(self.token))

    def test_member_page_is_discarded_if_job_is_cancelled_during_artifact_read(self):
        service=self.service();created=self.create(service);claim=service.claim(self.token,'w',created['datasetId'],'worker')
        with self.assertRaises(Conflict):
            self.members_after_load(service,created,claim,lambda _:service.remove(self.token,'w',created['datasetId'],cancel_only=True))

    def test_member_page_is_discarded_if_new_worker_claims_epoch_during_artifact_read(self):
        service=self.service();created=self.create(service);claim=service.claim(self.token,'w',created['datasetId'],'worker')
        def reclaim(_):
            with patch.object(self.control,'clock',return_value=self.control.clock()+60000):
                replacement=service.claim(self.token,'w',created['datasetId'],'replacement')
                self.assertGreater(replacement['epoch'],claim['epoch'])
        with self.assertRaises(Conflict):self.members_after_load(service,created,claim,reclaim)

    def test_member_page_is_discarded_if_source_is_retired_during_artifact_read(self):
        service=self.service();created=self.create(service);claim=service.claim(self.token,'w',created['datasetId'],'worker')
        with self.assertRaises((Conflict,Forbidden)):
            self.members_after_load(service,created,claim,lambda members:self.metadata.delete(self.token,'w',members[0]['id']))
