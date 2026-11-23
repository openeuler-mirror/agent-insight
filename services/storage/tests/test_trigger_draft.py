import copy
import hashlib
import unittest
from services.storage.tests import test_trigger as fixture
from services.storage.control import Conflict
from services.storage.iam import Forbidden

class TriggerDraftTests(unittest.TestCase):
    make_control=fixture.TriggerTests.make_control
    setUp=fixture.TriggerTests.setUp
    service=fixture.TriggerTests.service
    invoke=fixture.TriggerTests.invoke

    def begin(self,key='draft'):
        value=fixture.manifest();value.update(kind='draft',legacy_owner='legacy-alice',draft_skill={'description':'tested','body':'frozen','contentHash':hashlib.sha256(fixture.manifest()['skill']['content'].encode()).hexdigest()[:16]},placeholder={'id':'placeholder-'+key,'user':'legacy-alice','skillName':'checking','version':1,'versionSource':'llm-draft','versionNote':None,'description':'','items':[],'draftedFromSkillHash':None,'status':'drafting','createdAt':'2026-11-16T00:00:00Z','updatedAt':'2026-11-16T00:00:00Z'})
        value['trigger_set']={'id':value['placeholder']['id'],'version':1,'items':[]}
        return self.invoke('trigger_begin',manifest=value,releases={},config={'derived_skill_ids':['skill-a'],'derived_skill_versions':{'skill-a':[0]}},operation_key=key)

    def test_draft_begin_is_durable_and_private_and_does_not_pollute_trigger_runs(self):
        one=self.begin();self.assertEqual(one,self.begin())
        self.assertEqual(one['set']['id'],'placeholder-draft')
        self.assertEqual(self.invoke('trigger_list',skill_name='checking')['runs'],[])
        self.assertEqual(self.invoke('list'),[])
        handle=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='worker')
        self.assertEqual(handle['evaluator_id'],'__skill_trigger_draft__')
        with self.assertRaises(Conflict):self.begin('other-intent')

    def test_unknown_direct_call_is_not_reclaimed_or_started_again(self):
        one=self.begin();handle=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='worker')
        bound={'experiment_id':one['experiment_id'],**{key:handle[key] for key in ('attempt_id','fence','lease_owner')}}
        self.invoke('checkpoint',**bound,expected_revision=handle['checkpoint_revision'],checkpoint={'_flow_model_calls':{'0':{'request_hash':'a'*64,'state':'intent'}}},operation_key='intent')
        self.now+=30001
        self.assertIsNone(self.invoke('claim',experiment_id=one['experiment_id'],worker_id='recovery'))

    def test_untrusted_flow_observation_cannot_claim_recorded_success(self):
        one=self.begin();handle=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='worker');bound={'experiment_id':one['experiment_id'],**{key:handle[key] for key in ('attempt_id','fence','lease_owner')}}
        with self.assertRaises((Conflict,Forbidden)):self.invoke('checkpoint',**bound,expected_revision=handle['checkpoint_revision'],checkpoint={'_flow_model_calls':{'0':{'request_hash':'a'*64,'state':'observed','response':{'task_id':'fake','content':'[]'}}}},operation_key='fake-observed')

    def observed(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.observations import ObservationIngest
        from services.storage.agent_traces import AgentTraceRecorder
        one=self.begin();handle=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='worker');bound={'experiment_id':one['experiment_id'],**{key:handle[key] for key in ('attempt_id','fence','lease_owner')}}
        call={'request_hash':'a'*64,'state':'intent'}
        revision=self.invoke('checkpoint',**bound,expected_revision=handle['checkpoint_revision'],checkpoint={'_flow_model_calls':{'0':call}},operation_key='intent')['checkpoint_revision']
        ingest=ObservationIngest(self.control,MemoryFacts());recorder=AgentTraceRecorder(self.control,ingest);packet=snapshot(task='draft-model-response')
        packet['record']['agentName']='skill-trigger-drafter';packet['context']={'experiment_id':one['experiment_id'],'experiment_attempt_id':handle['attempt_id'],'experiment_fence':handle['fence'],'experiment_lease_owner':handle['lease_owner']}
        receipt=recorder.record(self.token,'w',packet);call|={'state':'observed','response':{'task_id':packet['record']['task_id'],'content':'two valid outputs','failure':None}}
        with self.assertRaises(Conflict):self.invoke('checkpoint',**bound,expected_revision=revision,checkpoint={'_flow_model_calls':{'0':copy.deepcopy(call)}},operation_key='not-indexed')
        while ingest.work_once('worker'):pass
        self.invoke('checkpoint',**bound,expected_revision=revision,checkpoint={'_flow_model_calls':{'0':call}},operation_key='indexed')
        plan=self.invoke('load_work',**bound)['runplan']['config']['core_trigger']
        result={'score':None,'points':[],'evidence':{'json':{'coreTriggerDraft':{'version':1,'set_id':one['set']['id'],'items':[{'id':'one','query':'first','shouldTrigger':True,'source':'llm-draft'},{'id':'two','query':'second','shouldTrigger':False,'source':'llm-draft'}],'draftedFromSkillHash':plan['draft_skill']['contentHash'],'skillDescription':plan['draft_skill']['description']}}}}
        return one,handle,bound,result,receipt

    def test_real_indexed_direct_response_recovers_and_completes_without_entering_run_history(self):
        one,handle,bound,result,_=self.observed();self.now+=30001
        recovery=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='recovery');self.assertNotEqual(recovery['attempt_id'],handle['attempt_id'])
        bound|={key:recovery[key] for key in ('attempt_id','fence','lease_owner')}
        self.invoke('complete',**bound,result=result,operation_key='complete')
        value=self.invoke('trigger_draft_read',experiment_id=one['experiment_id']);self.assertEqual(value['status'],'done');self.assertEqual(len(value['result']['items']),2)
        self.assertEqual(self.invoke('trigger_list',skill_name='checking')['runs'],[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_annotations WHERE kind LIKE 'derived-%'").fetchone()[0],0)

    def test_delete_draft_fences_only_draft_and_preserves_existing_sealed_runs(self):
        run=fixture.TriggerTests.begin(self,key='run-history')
        one=self.begin();handle=self.invoke('claim',experiment_id=one['experiment_id'],worker_id='worker');bound={'experiment_id':one['experiment_id'],**{key:handle[key] for key in ('attempt_id','fence','lease_owner')}}
        deleter=self.iam.issue_api_credential(self.token,'w',['read','delete'])
        with self.assertRaises(Forbidden):self.service().dispatch('trigger_delete_draft',deleter,'w',{'run_id':run['experiment_id']})
        cancelled=self.service().dispatch('trigger_delete_draft',deleter,'w',{'run_id':one['experiment_id']})
        self.assertEqual(cancelled['draft']['status'],'cancelled');self.assertEqual(self.invoke('trigger_list',skill_name='checking')['runs'][0]['id'],run['run']['id'])
        with self.assertRaises(Conflict):self.invoke('complete',**bound,result={'score':None},operation_key='late')
        target=cancelled['targets'][0];proof={key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')}|{'transport':'native-worker','cleanup':'confirmed'}
        self.service().dispatch('trigger_delete_draft_cleanup',deleter,'w',{'run_id':one['experiment_id'],'cancellation_id':cancelled['cancellation_id'],'proof':proof})
        self.assertEqual(self.invoke('trigger_read',run_id=run['experiment_id'])['run']['status'],'running')

if __name__=='__main__':unittest.main()
