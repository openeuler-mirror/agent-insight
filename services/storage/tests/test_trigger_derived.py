import copy
import unittest
from unittest.mock import patch
from services.storage.tests import test_trigger as fixture
from services.storage.control import Conflict
from services.storage.iam import Forbidden

class TriggerDerivedTests(unittest.TestCase):
    make_control=fixture.TriggerTests.make_control
    setUp=fixture.TriggerTests.setUp
    service=fixture.TriggerTests.service
    invoke=fixture.TriggerTests.invoke
    begin=fixture.TriggerTests.begin

    def prepared(self,key='run',*,hit=False,competitor=False):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.observations import ObservationIngest
        from services.storage.agent_traces import AgentTraceRecorder
        params=fixture.manifest()['params']|{'runsPerQuery':1}
        value=self.begin(key,params=params,legacy_owner='legacy-alice');exp=value['experiment_id'];attempt=self.invoke('claim',experiment_id=exp,worker_id='worker')
        handle={'experiment_id':exp,**{key:attempt[key] for key in ('attempt_id','fence','lease_owner')}}
        sample={'request_hash':'a'*64,'state':'intent'}
        one=self.invoke('checkpoint',**handle,checkpoint={'trigger_started_at_ms':self.now,'trigger_samples':{'0:0:0':sample}},expected_revision=attempt['checkpoint_revision'],operation_key=key+':intent')
        ingest=ObservationIngest(self.control,MemoryFacts());recorder=AgentTraceRecorder(self.control,ingest);packet=snapshot(task=exp+'-sample')
        packet['record']['agentName']='skill-trigger-analyzer';packet['context']={'experiment_id':exp,'experiment_attempt_id':attempt['attempt_id'],'experiment_fence':attempt['fence'],'experiment_lease_owner':attempt['lease_owner']}
        receipt=recorder.record(self.token,'w',packet)
        while ingest.work_once('worker'):pass
        response={'triggered':hit,'sessionId':packet['record']['task_id'],'endReason':'triggered' if hit else 'completed','latencyMs':0,'attempts':1,'completionOrder':0}
        if competitor:response['competingSkill']='other'
        sample|={'state':'observed','response':response}
        one=self.invoke('checkpoint',**handle,checkpoint={'trigger_samples':{'0:0:0':sample}},expected_revision=one['checkpoint_revision'],operation_key=key+':observed')
        self.invoke('checkpoint',**handle,checkpoint={'trigger_runtime_closed':True,'trigger_finished_at_ms':self.now+1},expected_revision=one['checkpoint_revision'],operation_key=key+':closed')
        item={'itemId':'positive','query':'check','shouldTrigger':True,'runsTriggered':int(hit),'runsTotal':1,'triggerRate':int(hit),'pass':hit,'latencyMsAvg':0,'runsCompleted':1,'runsTimedOut':0,'runsErrored':0,'sessionIds':[packet['record']['task_id']]}
        if competitor:item['competingSkill']='other'
        report={'items':[item],'passRate':int(hit),'truePositiveRate':int(hit),'falsePositiveRate':0}
        evaluation={'id':'trigger-evaluation-'+exp,'type':'trigger','skillId':'skill-a','version':0,'user':'legacy-alice','executionId':None,'generator':'trigger-evaluator@1.0','runId':exp,'status':'ok'}
        issue={'id':'trigger-issue-'+exp,'evaluationId':evaluation['id'],'source':'trigger','skillId':'skill-a','version':0,'user':'legacy-alice','dedupKey':'trigger:checking','severity':'low' if hit else 'high','summary':'触发评测通过率 '+('100%（抢路由 1）' if hit else '0%（漏 1'+(' · 抢路由 1' if competitor else '')+'）'),'evidence':'actual aggregate proof','suggestedFix':'full tested description and frozen other-version history','reasoning':None,'ruleId':None,'dimension':None,'category':'触发评测'}
        derived={'version':1,'evaluations':[evaluation] if not hit or competitor else [],'skillIssues':[issue] if not hit or competitor else []}
        result={'score':100 if hit else 0,'points':[],'durationMs':1,'evidence':{'json':{'coreTriggerResult':report,'coreTriggerDerived':derived}}}
        return value,handle,result,receipt

    def complete(self,handle,result,key='complete'):
        return self.invoke('complete',**handle,result=result,operation_key=key)

    def test_aggregate_issue_is_original_dto_and_auto_resolution_is_a_real_same_transaction_receipt(self):
        first,h1,r1,_=self.prepared();self.complete(h1,r1)
        old=self.invoke('derived_list',kind='issue',skill_id='skill-a')[0]
        self.assertEqual(old['dedupKey'],'trigger:checking');self.assertEqual(old['user'],'legacy-alice');self.assertIsNone(old['resolvedAt'])
        detail=self.invoke('derived_detail',id=old['evaluationId']);self.assertEqual(detail['evaluation']['runId'],first['run']['id']);self.assertEqual(detail['evaluation']['generator'],'trigger-evaluator@1.0')
        self.assertEqual(detail['skill']['content'],fixture.manifest()['skill']['content'])
        self.now+=10
        second,h2,r2,_=self.prepared('clean',hit=True);self.complete(h2,r2,'clean-complete')
        rows=self.invoke('derived_list',kind='issue',skill_id='skill-a');self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['resolvedRunId'],second['run']['id']);self.assertIsNotNone(rows[0]['resolvedAt'])
        self.assertEqual(self.invoke('derived_trigger_frontier',skill_id='skill-a')['versions'][0]['evaluation_ids'],[])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],1)
            row=con.execute("SELECT * FROM experiment_operation_receipts WHERE operation_kind='derived_issue_resolve'").fetchone();self.assertIsNotNone(row)
        self.assertEqual(self.complete(h2,r2,'clean-complete'),self.complete(h2,r2,'clean-complete'))

    def test_all_pass_with_competitor_still_creates_one_low_issue(self):
        _,handle,result,_=self.prepared(hit=True,competitor=True);self.complete(handle,result)
        issues=self.invoke('derived_list',kind='issue',skill_id='skill-a');self.assertEqual(len(issues),1);self.assertEqual(issues[0]['severity'],'low')

    def test_binding_null_field_and_envelope_forgery_is_rejected(self):
        _,handle,result,_=self.prepared()
        mutations=[lambda r:r['evidence']['json']['coreTriggerDerived']['skillIssues'][0].update(dedupKey='wrong'),lambda r:r['evidence']['json']['coreTriggerDerived']['skillIssues'][0].update(ruleId='experiment'),lambda r:r['evidence']['json']['coreTriggerDerived']['evaluations'][0].update(runId='other'),lambda r:r['evidence']['json']['coreTriggerDerived']['evaluations'][0].update(user='bob'),lambda r:r['evidence']['json'].update(experimentSkillDerived={'version':1})]
        for mutate in mutations:
            value=copy.deepcopy(result);mutate(value)
            with self.subTest(mutate=mutate),self.assertRaises((Conflict,Forbidden,ValueError)):self.complete(handle,value,'forged')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_annotations WHERE kind LIKE 'derived-%'").fetchone()[0],0)

    def test_derived_reads_and_manual_resolution_revalidate_actual_sample_sources(self):
        _,handle,result,receipt=self.prepared();self.complete(handle,result)
        issue=self.invoke('derived_list',kind='issue',skill_id='skill-a')[0]
        self.invoke('derived_issue_resolve',issue_ids=[issue['id']],resolved_run_id=None,operation_key='manual')
        self.assertIsNone(self.invoke('derived_lookup',kind='issue',id=issue['id'])['resolvedRunId'])
        from services.storage.trace_metadata import TraceMetadata
        TraceMetadata(self.control).delete(self.token,'w',receipt['trace_id'])
        for action,body in [('derived_lookup',{'kind':'issue','id':issue['id']}),('derived_list',{'kind':'issue','skill_id':'skill-a'}),('derived_detail',{'id':issue['evaluationId']}),('derived_trigger_frontier',{'skill_id':'skill-a'}),('derived_issue_resolve',{'issue_ids':[issue['id']],'resolved_run_id':None,'operation_key':'manual-replay'})]:
            with self.subTest(action=action),self.assertRaises((Conflict,Forbidden)):self.invoke(action,**body)

    def test_derived_postflight_rejects_revocation_during_source_validation(self):
        _,handle,result,_=self.prepared();self.complete(handle,result)
        service=self.service();original=service._derived_source_guard;changed=False
        def revoke(*args):
            nonlocal changed
            value=original(*args)
            if not changed:
                changed=True;self.iam.set_membership_for_provisioning('group','alice','admin',expected_etag=1)
            return value
        with patch.object(service,'_derived_source_guard',revoke),self.assertRaises(Forbidden):service.dispatch('derived_list',self.token,'w',{'kind':'issue','skill_id':'skill-a'})

    def test_generic_work_cannot_spoof_a_private_aggregate_marker(self):
        from services.storage.tests.test_experiment_skill_derived import ExperimentSkillDerivedTests
        other=ExperimentSkillDerivedTests();other.setUp();self.addCleanup(other.doCleanups)
        result=other.result();result['evidence']['json']['coreTriggerDerived']={'version':1,'evaluations':[],'skillIssues':[]}
        with self.assertRaises(Forbidden):other.complete(result)

    def test_failed_or_cancelled_work_cannot_resolve_or_publish_aggregate_issues(self):
        _,h1,r1,_=self.prepared();self.complete(h1,r1)
        old=self.invoke('derived_list',kind='issue',skill_id='skill-a')[0]
        self.now+=10
        _,h2,r2,_=self.prepared('failed')
        with self.assertRaises(Conflict):self.invoke('fail',**h2,result=r2,error='provider failed',operation_key='forged-failure-derived')
        self.invoke('fail',**h2,error='provider failed',operation_key='failure')
        self.assertIsNone(self.invoke('derived_lookup',kind='issue',id=old['id'])['resolvedAt'])
        self.now+=10
        value,h3,r3,_=self.prepared('cancelled')
        self.invoke('trigger_cancel',run_id=value['experiment_id'],operation_key='cancel')
        with self.assertRaises(Conflict):self.complete(h3,r3,'late-complete')
        self.assertIsNone(self.invoke('derived_lookup',kind='issue',id=old['id'])['resolvedAt'])

    def test_auto_resolution_and_new_issue_roll_back_with_a_failed_machine_completion(self):
        _,h1,r1,_=self.prepared();self.complete(h1,r1)
        old=self.invoke('derived_list',kind='issue',skill_id='skill-a')[0]
        self.now+=10
        value,h2,r2,_=self.prepared('second-miss')
        service=self.service();original=service._put
        def fail_after_resolution(packet,*args):
            if isinstance(packet,dict) and packet.get('id')=='trigger-issue-'+value['experiment_id']:raise RuntimeError('new annotation storage unavailable')
            return original(packet,*args)
        with patch.object(service,'_put',fail_after_resolution),self.assertRaises(RuntimeError):service.dispatch('complete',self.token,'w',dict(h2,result=r2,operation_key='second-complete'))
        self.assertIsNone(self.invoke('derived_lookup',kind='issue',id=old['id'])['resolvedAt'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_operation_receipts WHERE operation_kind='derived_issue_resolve'").fetchone()[0],0)
        self.complete(h2,r2,'second-complete')
        self.assertEqual(len(self.invoke('derived_list',kind='issue',skill_id='skill-a')),2)

if __name__=='__main__':unittest.main()
