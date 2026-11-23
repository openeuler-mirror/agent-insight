import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from services.storage.tests import test_experiments as fixture
from services.storage.experiments import ExperimentStore,Conflict
from services.storage.iam import Forbidden

def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()[:40]

class ExperimentSkillDerivedTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.ExperimentTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        self.store=ExperimentStore(self.base.control,frozen_assets_verifier=lambda *_:True)
        value=fixture.experiment();value.update(scope='skill-workbench',preset='use-case',skillName='checking',skillVersion=1)
        self.call('create',experiment=value,operation_key='create')
        self.scope={'skill_id':'skill','skill_name':'checking','version':1,'source':'dynamic','preset':'use-case','scope':'skill-workbench'}
        self.call('start',experiment_id='exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]},'experiment_skill_scope':self.scope},frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        self.handle=self.call('claim',experiment_id='exp',worker_id='worker')

    def call(self,action,**body):return self.store.dispatch(action,self.base.token,'w',body)
    def result(self):
        h=self.handle;eid='experiment-evaluation-'+digest([h['attempt_id'],h['evaluator_id']]);iid='experiment-issue-'+digest([h['attempt_id'],h['evaluator_id'],0])
        point={'label':'Fix this','skillAttributable':True,'suggestion':'Add guard','severity':'high'}
        evaluation={'id':eid,'type':'dynamic','skillId':'skill','version':1,'executionId':None,'generator':'experiment-skill-issues@1.0','runId':'experiment:exp:'+h['result_id'],'status':'ok'}
        key=hashlib.sha1('dynamic::用例评测::fix this::add guard'.encode()).hexdigest()[:12]
        issue={'id':iid,'evaluationId':eid,'source':'dynamic','skillId':'skill','version':1,'dedupKey':key,'severity':'high','summary':'Fix this','evidence':None,'reasoning':None,'suggestedFix':'Add guard','ruleId':'experiment','dimension':'judge','category':'用例评测','pointIndex':0}
        return {'score':0,'points':[point],'evidence':{'json':{'experimentSkillDerived':{'version':1,'points':[copy.deepcopy(point)],'evaluations':[evaluation],'skillIssues':[issue]}}}}
    def complete(self,result):return self.call('complete',**self.base.handle(self.handle),result=result,operation_key='complete')

    def test_input_only_machine_receipt_has_real_issues_and_nullable_detail_without_old_trace(self):
        result=self.result();self.complete(result)
        issues=self.call('derived_list',kind='issue',skill_id='skill',owned_only=True);self.assertEqual(len(issues),1);self.assertEqual(issues[0]['summary'],'Fix this')
        evaluation=self.call('derived_lookup',kind='evaluation',id=issues[0]['evaluationId']);self.assertIsNone(evaluation['executionId'])
        detail=self.call('derived_detail',id=evaluation['id']);self.assertIsNone(detail['execution']);self.assertIsNone(detail['trace_evidence']);self.assertEqual(len(detail['issues']),1)
        self.assertEqual(self.call('read',experiment_id='exp')['experiment']['cases'][0]['results'][0]['score'],0)
        self.assertEqual(self.complete(result),self.complete(result))

    def test_new_envelope_rejects_point_or_identity_forgery_and_direct_mixing(self):
        changes=[lambda r:r['points'][0].update(suggestion='different'),lambda r:r['evidence']['json']['experimentSkillDerived']['skillIssues'][0].update(suggestedFix='forged'),lambda r:r['evidence']['json']['experimentSkillDerived']['evaluations'][0].update(executionId='old-trace'),lambda r:r['evidence']['json']['experimentSkillDerived']['evaluations'][0].update(version=2),lambda r:r['evidence']['json'].update(directTrajectoryDerived={'evaluations':[],'skillIssues':[]})]
        for change in changes:
            with self.subTest(change=change):
                value=self.result();change(value)
                with self.assertRaises((Conflict,Forbidden,ValueError)):self.complete(value)
        self.assertEqual(self.call('derived_list',kind='issue',skill_id='skill'),[])

    def test_nonowner_input_detail_keeps_gold_redacted_and_cannot_resolve(self):
        self.complete(self.result());evaluation=self.call('derived_list',kind='evaluation',skill_id='skill')[0]
        detail=self.store.dispatch('derived_detail',self.base.admin,'w',{'id':evaluation['id']})
        self.assertTrue(detail['gold_redacted']);self.assertIsNone(detail['execution']);self.assertIsNone(detail['trace_evidence']);self.assertNotIn('summary',detail['issues'][0])

    def test_exact_machine_points_do_not_equate_boolean_flags_with_numbers(self):
        value=self.result();value['evidence']['json']['experimentSkillDerived']['points'][0]['skillAttributable']=1
        with self.assertRaises(Conflict):self.complete(value)

    def test_successful_trigger_with_zero_issues_advances_the_read_only_frontier(self):
        old_evaluation=None
        for exp,has_issue in [('trigger-old',True),('trigger-new',False)]:
            value=fixture.experiment();value.update(id=exp,scope='skill-workbench',preset='trigger',skillName='checking',skillVersion=1);value['cases'][0]['id']=exp+'-case'
            self.call('create',experiment=value,operation_key=exp+':create')
            scope=self.scope|{'source':'trigger','preset':'trigger'}
            self.call('start',experiment_id=exp,config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]},'experiment_skill_scope':scope},frozen_evaluators={'judge':{'id':'judge'}},operation_key=exp+':start')
            handle=self.call('claim',experiment_id=exp,worker_id='worker');self.handle=handle
            result=self.result() if has_issue else {'score':100,'points':[]}
            if has_issue:
                payload=result['evidence']['json']['experimentSkillDerived'];evaluation=payload['evaluations'][0];evaluation.update(type='trigger',runId='experiment:'+exp+':'+handle['result_id']);old_evaluation=evaluation['id']
                issue=payload['skillIssues'][0];issue.update(source='trigger',category='触发评测',dedupKey=hashlib.sha1('trigger::触发评测::fix this::add guard'.encode()).hexdigest()[:12])
            self.call('complete',**(self.base.handle(handle)|{'experiment_id':exp}),result=result,operation_key=exp+':complete');self.base.now+=10
            frontier=self.call('derived_trigger_frontier',skill_id='skill')['versions'];self.assertEqual(len(frontier),1);self.assertEqual(frontier[0]['experiment_id'],exp);self.assertEqual(frontier[0]['evaluation_ids'],[old_evaluation] if has_issue else [])
        self.assertEqual(len(self.call('derived_list',kind='issue',skill_id='skill')),1)
        self.assertEqual(self.store.dispatch('derived_trigger_frontier',self.base.admin,'w',{'skill_id':'skill'})['versions'],[])
        original=self.store._source_assets;changed=False
        def authorize(*args):
            nonlocal changed
            value=original(*args)
            if not changed:changed=True;self.base.iam.set_membership_for_provisioning('group','alice','admin',expected_etag=1)
            return value
        with patch.object(self.store,'_source_assets',authorize),self.assertRaises(Forbidden):self.call('derived_trigger_frontier',skill_id='skill')

    def test_public_business_scope_accepts_real_points_but_cannot_authorize_direct_objects(self):
        value=fixture.experiment();value.update(id='public-exp',scope='skill-workbench',preset='use-case',skillName='checking',skillVersion=1);value['cases'][0]['id']='public-case'
        self.call('create',experiment=value,operation_key='public-create')
        self.call('start',experiment_id='public-exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]},'experiment_skill_scope':self.scope,'derived_public_business_skill_id':'skill'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='public-start')
        self.handle=self.call('claim',experiment_id='public-exp',worker_id='worker');result=self.result();result['evidence']['json']['experimentSkillDerived']['evaluations'][0]['runId']='experiment:public-exp:'+self.handle['result_id']
        self.call('complete',**(self.base.handle(self.handle)|{'experiment_id':'public-exp'}),result=result,operation_key='public-complete');self.assertEqual(len(self.call('derived_list',kind='issue',skill_id='skill')),1)
        from services.storage.tests import test_derived_issue_resolution as derived_fixture
        other=derived_fixture.DerivedIssueResolutionTests();other.setUp();self.addCleanup(other.doCleanups);other.prepare()
        other.call('start',experiment_id='exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]},'derived_public_business_skill_id':'skill'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='public-direct-start')
        handle=other.call('claim',experiment_id='exp',worker_id='worker');work=other.call('load_work',**fixture.ExperimentTests.handle(handle))
        evaluation={'id':'forged-public-direct','type':'dynamic','skillId':'skill','version':1,'executionId':work['frozen_trace_evidence']['execution']['id']}
        with self.assertRaises(Forbidden):other.call('complete',**fixture.ExperimentTests.handle(handle),result={'score':0,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[]}}}},operation_key='public-direct')


if __name__=='__main__':unittest.main()
