import copy
import json
import unittest

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_datasets as fixture


def manifest():
    return {'version':1,'kind':'run','skill':{'id':'skill-a','name':'checking','version':0,'content':'---\nname: checking\ndescription: check\n---\nbody'},
            'trigger_set':{'id':'set-a','version':2,'items':[{'id':'positive','query':'check','shouldTrigger':True,'source':'user-added'}]},
            'siblings':[],'history':[],'params':{'runsPerQuery':2,'triggerThreshold':0.5,'timeoutMs':5000,'concurrency':1,'maxTimeoutRetries':1},
            'model_selection':None,'modelId':None,'workspaceRoot':None}


class TriggerTests(unittest.TestCase):
    make_control=fixture.DatasetTests.make_control
    setUp=fixture.DatasetTests.setUp

    def service(self,trusted=True):
        from services.storage.experiments import ExperimentStore
        return ExperimentStore(self.control,frozen_assets_verifier=(lambda *_:True) if trusted else None)

    def invoke(self,action,**body):
        return self.service().dispatch(action,self.token,'w',body)

    def begin(self,key='begin',**changes):
        value=manifest();value.update(changes)
        return self.invoke('trigger_begin',manifest=value,releases={},config={'derived_skill_ids':[value['skill']['id']],'derived_skill_versions':{value['skill']['id']:[value['skill']['version']]}},operation_key=key)

    def test_scope_requires_live_capabilities_before_static_or_model_access(self):
        readonly=self.iam.issue_api_credential(self.token,'w',['read'])
        self.assertTrue(self.service().dispatch('trigger_scope',readonly,'w',{'operation':'read'})['authorized'])
        for operation in ['save','upload','delete','run','draft','cancel']:
            with self.subTest(operation=operation),self.assertRaises(Forbidden):
                self.service().dispatch('trigger_scope',readonly,'w',{'operation':operation})
        no_execute=self.iam.issue_api_credential(self.token,'w',['read','write'])
        self.assertTrue(self.service().dispatch('trigger_scope',no_execute,'w',{'operation':'save'})['authorized'])
        with self.assertRaises(Forbidden):self.service().dispatch('trigger_scope',no_execute,'w',{'operation':'run'})

    def test_begin_is_durable_before_return_and_exact_replay_ignores_new_static_sources(self):
        first=self.begin();self.assertEqual(first['run']['skillVersion'],0);self.assertEqual(first['run']['status'],'running')
        self.assertEqual(first,self.begin())
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM work_items WHERE phase='evaluate' AND status='queued'").fetchone()[0],1)
        value=manifest();value['skill']['content']='changed'
        with self.assertRaises(Conflict):self.invoke('trigger_begin',manifest=value,releases={},config={'derived_skill_ids':['skill-a'],'derived_skill_versions':{'skill-a':[0]}},operation_key='begin')

    def test_different_intent_cannot_create_a_second_active_run_of_the_same_version(self):
        self.begin()
        with self.assertRaises(Conflict):self.begin('other')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],1)

    def test_begin_requires_controller_attestation_and_rejects_forged_generic_creation(self):
        with self.assertRaises(Forbidden):self.service(False).dispatch('trigger_begin',self.token,'w',{'manifest':manifest(),'releases':{},'operation_key':'no-proof'})
        with self.assertRaises(Forbidden):self.invoke('create',experiment={'id':'fake','name':'fake','scope':'skill-trigger-analysis','evaluatorIdsJson':'[]'},operation_key='fake')

    def test_private_history_uses_original_dto_without_frozen_inputs_or_internal_binding(self):
        first=self.begin();run=first['run'];value=self.invoke('trigger_read',run_id=run['id'])
        self.assertEqual(value['run'],run);self.assertEqual(value['run']['triggerSetId'],'set-a')
        self.assertEqual(value['run']['passRate'],0);self.assertIsNone(value['run']['durationMs'])
        self.assertNotIn('core_trigger',json.dumps(value));self.assertNotIn('description: check',json.dumps(value))
        with self.assertRaises(Forbidden):self.service().dispatch('trigger_read',self.bob,'w',{'run_id':run['id']})
        self.assertEqual(self.invoke('trigger_list',skill_name='checking',latest_only=True)['run'],None)

    def test_runplan_keeps_exact_input_and_generic_mutations_cannot_replace_it(self):
        value=self.begin();exp=value['experiment_id']
        loaded=self.invoke('runplan',experiment_id=exp,run_id=value['run_id'])['runplan']
        self.assertEqual(loaded['config']['core_trigger']['skill']['version'],0)
        self.assertEqual(loaded['config']['core_trigger']['trigger_set']['version'],2)
        for action,body in [('update',{'changes':{'name':'fake'}}),('start',{'frozen_evaluators':{}}),('case_upsert',{'case':{'id':'fake','input':'fake'}})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):self.invoke(action,experiment_id=exp,operation_key='fake-'+action,**body)

    def test_internal_trigger_runs_do_not_appear_as_ordinary_experiments(self):
        value=self.begin();exp=value['experiment_id']
        self.assertEqual(self.invoke('list'),[])
        self.assertEqual(self.invoke('read_view')['snapshots'],[])
        self.assertEqual(self.invoke('read_view',experiment_id=exp)['snapshots'],[])
        self.assertEqual(self.invoke('list_view')['snapshots'],[])
        self.assertEqual(self.invoke('list_view',experiment_id=exp)['snapshots'],[])
        self.assertEqual(self.invoke('trigger_read',run_id=exp)['run']['id'],exp)
        ordinary=self.invoke('create',experiment={'name':'ordinary','id':'ordinary'},operation_key='ordinary')
        self.assertEqual(self.invoke('list')[0]['experiment']['id'],'ordinary')
        self.assertEqual(self.invoke('read_view',experiment_id='ordinary')['snapshots'][0]['experiment']['id'],'ordinary')

    def test_expired_attempt_with_unconfirmed_sample_is_not_reclaimed_or_resampled(self):
        value=self.begin();exp=value['experiment_id'];one=self.invoke('claim',experiment_id=exp,worker_id='worker',phase='evaluate')
        handle={key:one[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp}
        self.invoke('checkpoint',**handle,expected_revision=one['checkpoint_revision'],checkpoint={'trigger_samples':{'0:0:0':{'request_hash':'a'*64,'state':'intent'}}},operation_key='intent')
        self.now+=30001
        self.assertIsNone(self.invoke('claim',experiment_id=exp,worker_id='replacement',phase='evaluate'))

    def test_cancelled_physical_attempt_blocks_a_new_run_until_exact_cleanup_is_confirmed(self):
        value=self.begin();exp=value['experiment_id'];one=self.invoke('claim',experiment_id=exp,worker_id='worker',phase='evaluate')
        cancelled=self.invoke('trigger_cancel',run_id=exp,operation_key='cancel')
        self.assertEqual(cancelled['run']['status'],'cancelled');self.assertEqual(cancelled['targets'][0]['attempt_id'],one['attempt_id'])
        with self.assertRaises(Exception) as blocked:self.begin('unsafe-replacement')
        self.assertEqual(blocked.exception.status,503)
        target=cancelled['targets'][0];proof={key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')}|{'transport':'native-worker','cleanup':'confirmed'}
        with self.assertRaises(Conflict):self.invoke('trigger_cleanup',run_id=exp,cancellation_id=cancelled['cancellation_id'],proof=proof|{'attempt_id':'forged'},operation_key='wrong-cleanup')
        self.invoke('trigger_cleanup',run_id=exp,cancellation_id=cancelled['cancellation_id'],proof=proof,operation_key='cleanup')
        self.assertNotEqual(self.begin('safe-replacement')['run']['id'],exp)
        handle={key:one[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp}
        with self.assertRaises(Conflict):self.invoke('complete',**handle,result={'score':100},operation_key='late')

    def test_success_without_real_indexed_sample_receipts_is_rejected(self):
        value=self.begin();exp=value['experiment_id'];one=self.invoke('claim',experiment_id=exp,worker_id='worker',phase='evaluate')
        handle={key:one[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp}
        report={'items':[],'passRate':1,'truePositiveRate':1,'falsePositiveRate':0}
        with self.assertRaises(Conflict):self.invoke('complete',**handle,result={'score':100,'evidence':{'json':{'coreTriggerResult':report}}},operation_key='forged-score')

    def test_real_recorded_samples_complete_and_recover_without_rebinding_their_original_attempt(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.observations import ObservationIngest
        from services.storage.agent_traces import AgentTraceRecorder
        value=self.begin();exp=value['experiment_id'];one=self.invoke('claim',experiment_id=exp,worker_id='worker',phase='evaluate')
        handle={key:one[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp};revision=one['checkpoint_revision'];samples={}
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts);recorder=AgentTraceRecorder(self.control,ingest)
        for index in range(2):
            key=f'0:{index}:0';samples[key]={'request_hash':str(index)*64,'state':'intent'}
            current=self.invoke('checkpoint',**handle,expected_revision=revision,checkpoint={'trigger_samples':copy.deepcopy(samples),'trigger_started_at_ms':self.now},operation_key='intent-'+str(index));revision=current['checkpoint_revision']
            body=snapshot(task='trigger-sample-'+str(index));body['record']['agentName']='skill-trigger-analyzer';body['context']={'experiment_id':exp,'experiment_attempt_id':one['attempt_id'],'experiment_fence':one['fence'],'experiment_lease_owner':one['lease_owner']}
            receipt=recorder.record(self.token,'w',body)
            response={'triggered':index==0,'sessionId':body['record']['task_id'],'endReason':'triggered' if index==0 else 'completed','latencyMs':index+1,'attempts':1,'completionOrder':index}
            samples[key]={'request_hash':str(index)*64,'state':'observed','response':response}
            with self.assertRaises(Conflict):self.invoke('checkpoint',**handle,expected_revision=revision,checkpoint={'trigger_samples':copy.deepcopy(samples)},operation_key='not-indexed-'+str(index))
            while ingest.work_once('worker'):pass
            self.assertEqual(ingest.batch_status(self.token,'w',receipt['batch_refs'][0]['batch_id'])['state'],'indexed')
            current=self.invoke('checkpoint',**handle,expected_revision=revision,checkpoint={'trigger_samples':copy.deepcopy(samples)},operation_key='observed-'+str(index));revision=current['checkpoint_revision']
        report={'items':[{'itemId':'positive','query':'check','shouldTrigger':True,'runsTriggered':1,'runsTotal':2,'triggerRate':.5,'pass':True,'latencyMsAvg':2,'runsCompleted':2,'runsTimedOut':0,'runsErrored':0,'sessionIds':['trigger-sample-0','trigger-sample-1']}],'passRate':1,'truePositiveRate':1,'falsePositiveRate':0}
        result={'score':100,'durationMs':1000,'evidence':{'json':{'coreTriggerResult':report,'coreTriggerDerived':{'version':1,'evaluations':[],'skillIssues':[]}}}}
        with self.assertRaises(Conflict):self.invoke('complete',**handle,result=result,operation_key='missing-physical-exit')
        self.invoke('checkpoint',**handle,expected_revision=revision,checkpoint={'trigger_runtime_closed':True,'trigger_finished_at_ms':self.now+1000},operation_key='physical-exit')
        self.now+=30001;two=self.invoke('claim',experiment_id=exp,worker_id='recovery',phase='evaluate');self.assertNotEqual(two['attempt_id'],one['attempt_id'])
        handle={key:two[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp};loaded=self.invoke('load_work',**handle)
        self.assertEqual(loaded['checkpoint']['trigger_samples'],samples);self.assertTrue(loaded['checkpoint']['trigger_runtime_closed'])
        self.invoke('complete',**handle,result=result,operation_key='complete')
        public=self.invoke('trigger_read',run_id=exp)['run'];self.assertEqual(public['status'],'done');self.assertEqual(public['results'],report['items']);self.assertEqual(public['passRate'],1)
        self.assertEqual(self.invoke('trigger_list',skill_name='checking',latest_only=True)['run']['id'],exp)
        pending=self.begin('newer-pending')['run']['id']
        self.assertEqual(self.invoke('trigger_list',skill_name='checking',latest_only=True)['run']['id'],exp)
        self.invoke('trigger_cancel',run_id=pending,operation_key='cancel-newer')
        self.assertEqual(self.invoke('trigger_list',skill_name='checking',latest_only=True)['run']['id'],exp)
        failed=self.begin('newer-failed')['run']['id'];attempt=self.invoke('claim',experiment_id=failed,worker_id='failed-worker',phase='evaluate')
        self.invoke('fail',experiment_id=failed,**{key:attempt[key] for key in ('attempt_id','fence','lease_owner')},error='actual provider error',operation_key='newer-failed-result')
        self.assertEqual(self.invoke('trigger_list',skill_name='checking',latest_only=True)['run']['id'],exp)
        from services.storage.trace_metadata import TraceMetadata
        TraceMetadata(self.control).delete(self.token,'w',receipt['trace_id'])
        with self.assertRaises(Conflict):self.invoke('trigger_read',run_id=exp)

    def test_controller_skill_scope_must_match_the_entire_frozen_trigger_binding(self):
        with self.assertRaises(Forbidden):self.invoke('trigger_begin',manifest=manifest(),releases={},config={'derived_skill_ids':['another'],'derived_skill_versions':{'another':[0]}},operation_key='wrong-scope')

    def test_failed_physical_cleanup_does_not_allow_a_new_agent_generation(self):
        value=self.begin();exp=value['experiment_id'];one=self.invoke('claim',experiment_id=exp,worker_id='worker',phase='evaluate')
        handle={key:one[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':exp}
        self.invoke('fail',**handle,error={'code':'EVALUATION_CLEANUP_UNCONFIRMED','message':'physical exit unknown'},operation_key='unknown-exit')
        with self.assertRaises(Exception) as blocked:self.begin('must-not-start')
        self.assertEqual(blocked.exception.status,503)

    def test_legacy_display_owner_is_frozen_and_never_used_as_authorization(self):
        value=self.begin(legacy_owner='legacy-alice');self.assertEqual(value['run']['user'],'legacy-alice')
        credential=self.iam.issue_api_credential(self.token,'w',['read'])
        self.assertEqual(self.service().dispatch('trigger_read',credential,'w',{'run_id':value['run']['id']})['run']['user'],'legacy-alice')
        with self.assertRaises(Forbidden):self.service().dispatch('trigger_read',self.bob,'w',{'run_id':value['run']['id']})

    def test_only_head_postflight_changes_have_a_transient_read_code(self):
        from contextlib import contextmanager
        from unittest.mock import patch
        value=self.begin();service=self.service();original=self.control.read_transaction;changed=False
        @contextmanager
        def concurrent_completion():
            nonlocal changed
            with original() as con:yield con
            if not changed:
                changed=True
                with self.control.transaction() as con:con.execute("UPDATE experiment_heads SET revision=revision+1 WHERE experiment_id=?",(value['experiment_id'],))
        with patch.object(self.control,'read_transaction',concurrent_completion),self.assertRaises(Conflict) as caught:service.dispatch('trigger_list',self.token,'w',{'skill_name':'checking'})
        self.assertEqual(getattr(caught.exception,'code',None),'TRIGGER_READ_CHANGED')
