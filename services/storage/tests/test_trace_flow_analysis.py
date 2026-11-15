import copy
import json
import unittest
from services.storage.tests import test_experiment_source_lifecycle as fixture
from services.storage.experiments import ExperimentStore,Conflict
from services.storage.iam import Forbidden

class TraceFlowAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.ExperimentSourceLifecycleTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        self.control=self.base.control;self.token=self.base.base.token
        self.store=ExperimentStore(self.control,evidence=self.base.store.evidence,frozen_assets_verifier=lambda *_:True)
        evidence=self.store.evidence.read(self.token,'w',trace_ref=self.base.trace)
        self.manifest={'version':1,'mode':'dynamic','request_key':'request','trace_id':evidence['manifest']['trace_id'],'trace_snapshot_hash':evidence['snapshot_hash'],'model_selection':None,'skill':None,'parsed_flow':None}
        self.experiment={'id':'flow','name':'private flow','type':'single','scope':'trace-flow-analysis','evaluatorIdsJson':'["__trace_flow_match__"]','configSnapshotJson':json.dumps({'coreFlowAnalysis':self.manifest}),'cases':[{'id':'flow-case','executionId':evidence['execution']['id'],'taskId':evidence['execution']['taskId'],'input':'','actualOutput':''}]}
        self.call('create',experiment=self.experiment,operation_key='create-flow')

    def call(self,action,**body):return self.store.dispatch(action,self.token,'w',body)
    def start(self,key='flow:start'):
        return self.call('start',experiment_id='flow',config={'core_flow_analysis':self.manifest,'model_selection':None},frozen_evaluators={'__trace_flow_match__':{'card':{'id':'__trace_flow_match__'},'origin':'internal'}},operation_key=key,force_new_trace=key!='flow:start')
    def claim(self):return self.call('claim',experiment_id='flow',worker_id='flow-worker',lease_ms=1000)
    def handle(self,value):return {key:value[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':'flow'}

    def test_flow_recovery_inherits_only_observed_model_calls_for_the_same_work(self):
        self.start();first=self.claim();calls={'0':{'request_hash':'a'*64,'state':'observed','response':{'choices':[{'message':{'content':'observed'}}]}}}
        self.call('checkpoint',**self.handle(first),expected_revision=first['checkpoint_revision'],checkpoint={'_flow_model_calls':calls,'must_not_inherit':'old'},operation_key='checkpoint')
        self.base.base.now+=1001;second=self.claim();work=self.call('load_work',**self.handle(second));self.assertEqual(work['checkpoint'].get('_flow_model_calls'),calls);self.assertNotIn('must_not_inherit',work['checkpoint'])
        self.start('explicit-new-work');third=self.claim();fresh=self.call('load_work',**self.handle(third));self.assertNotIn('_flow_model_calls',fresh['checkpoint'])

    def test_unknown_model_intent_does_not_create_another_attempt_after_lease_expiry(self):
        self.start();first=self.claim();calls={'0':{'request_hash':'a'*64,'state':'intent'}}
        self.call('checkpoint',**self.handle(first),expected_revision=first['checkpoint_revision'],checkpoint={'_flow_model_calls':calls},operation_key='unknown-checkpoint')
        self.base.base.now+=1001
        for _ in range(3):self.assertIsNone(self.claim())
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts WHERE work_item_id=?',(first['work_item_id'],)).fetchone()[0],1)

    def test_observed_response_before_lease_expiry_allows_later_exact_recovery(self):
        self.start();first=self.claim();calls={'0':{'request_hash':'a'*64,'state':'intent'}}
        updated=self.call('checkpoint',**self.handle(first),expected_revision=first['checkpoint_revision'],checkpoint={'_flow_model_calls':calls},operation_key='intent-checkpoint')
        self.base.base.now+=500;calls['0'].update(state='observed',response={'choices':[{'message':{'content':'late but confirmed'}}]})
        self.call('checkpoint',**self.handle(first),expected_revision=updated['checkpoint_revision'],checkpoint={'_flow_model_calls':calls},operation_key='observed-checkpoint')
        self.base.base.now+=501;second=self.claim();self.assertIsNotNone(second);self.assertEqual(self.call('load_work',**self.handle(second))['checkpoint']['_flow_model_calls'],calls)

    def test_internal_flow_is_hidden_from_public_collections_but_recoverable_in_raw_background_list(self):
        self.start()
        self.assertNotIn('flow',[value['experiment']['id'] for value in self.call('list_view')['snapshots']])
        self.assertNotIn('flow',[value['experiment']['id'] for value in self.call('read_view')['snapshots']])
        self.assertIn('flow',[value['experiment']['id'] for value in self.call('list')])

    def test_flow_scope_requires_private_proof_and_exact_frozen_trace_manifest(self):
        plain=ExperimentStore(self.control,evidence=self.base.store.evidence)
        with self.assertRaises(Forbidden):plain.dispatch('start',self.token,'w',{'experiment_id':'flow','config':{'core_flow_analysis':self.manifest,'model_selection':None},'frozen_evaluators':{'__trace_flow_match__':{'card':{'id':'__trace_flow_match__'}}},'operation_key':'public-start'})
        for change in [lambda m:m.update(trace_snapshot_hash='0'*64),lambda m:m.update(mode='compare')]:
            manifest=copy.deepcopy(self.manifest);change(manifest)
            with self.assertRaises(Conflict):self.call('start',experiment_id='flow',config={'core_flow_analysis':manifest,'model_selection':None},frozen_evaluators={'__trace_flow_match__':{'card':{'id':'__trace_flow_match__'}}},operation_key='changed:'+manifest['mode'])

    def test_flow_lookup_uses_only_the_owned_actual_selection_and_live_source(self):
        self.assertIsNone(self.call('flow_lookup',trace_ref=self.manifest['trace_id'])['match'])
        self.start();handle=self.claim();value={'version':1,'mode':'dynamic','matchJson':'{"matches":[]}','dynamicMermaid':'flowchart TD','interactionCount':1}
        self.call('complete',**self.handle(handle),result={'score':None,'evidence':{'json':{'coreFlowMatch':value}}},operation_key='flow-complete')
        selected=self.call('flow_lookup',trace_ref=self.manifest['trace_id']);self.assertEqual(selected['match']['value'],value);self.assertEqual(selected['match']['result_slot_id'],handle['result_id']);self.assertIsNone(selected['attribution'])
        self.assertIsNone(self.store.dispatch('flow_lookup',self.base.base.admin,'w',{'trace_ref':self.manifest['trace_id']})['match'])
        self.base.revoke()
        with self.assertRaises(Forbidden):self.call('flow_lookup',trace_ref=self.manifest['trace_id'])

    def test_attribution_inherits_exact_current_match_evidence_after_the_live_trace_grows(self):
        from services.storage.tests.test_observations import packet
        manifest=self.manifest|{'mode':'compare','skill':{'id':'skill','name':'checking','version':1,'content':'# frozen'}}
        value=copy.deepcopy(self.experiment);value.update(id='compare-flow',evaluatorIdsJson='["__trace_flow_match__","__trace_flow_attribution__"]',configSnapshotJson=json.dumps({'coreFlowAnalysis':manifest}));value['cases'][0]['id']='compare-flow-case'
        self.call('create',experiment=value,operation_key='compare-create')
        config={'core_flow_analysis':manifest,'model_selection':None,'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}}
        frozen={key:{'card':{'id':key},'origin':'internal'} for key in ('__trace_flow_match__','__trace_flow_attribution__')}
        self.call('start',experiment_id='compare-flow',evaluator_ids=['__trace_flow_match__'],config=config,frozen_evaluators=frozen,operation_key='compare-start')
        handle=self.call('claim',experiment_id='compare-flow',worker_id='match-worker');proof={key:handle[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':'compare-flow'}
        self.call('complete',**proof,result={'score':None,'evidence':{'json':{'coreFlowMatch':{'version':1,'mode':'compare','matchJson':'{}','interactionCount':1}}}},operation_key='compare-complete')
        match=self.call('flow_lookup',trace_ref=self.manifest['trace_id'],experiment_id='compare-flow')['match'];source={key:match[key] for key in ('machine_result_id','content_hash','run_id')}
        self.base.ingest.accept(self.base.base.bob,'w',packet(revision=2));self.base.ingest.work_once('live-growth')
        current=self.store.evidence.read(self.token,'w',trace_ref=self.manifest['trace_id']);self.assertNotEqual(current['snapshot_hash'],manifest['trace_snapshot_hash'])
        arguments={'experiment_id':'compare-flow','evaluator_ids':['__trace_flow_attribution__'],'config':config|{'core_flow_match_source':source},'frozen_evaluators':frozen,'operation_key':'attribution-start'}
        self.call('start',**arguments);attribution=self.call('claim',experiment_id='compare-flow',worker_id='attribution-worker');work=self.call('load_work',**({key:attribution[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':'compare-flow'}));self.assertEqual(work['frozen_trace_evidence']['snapshot_hash'],manifest['trace_snapshot_hash'])
        wrong=copy.deepcopy(arguments);wrong['config']['core_flow_match_source']['content_hash']='0'*64;wrong['operation_key']='wrong-parent'
        with self.assertRaises(Conflict):self.call('start',**wrong)
        self.base.revoke()
        with self.assertRaises(Forbidden):self.call('start',**(arguments|{'operation_key':'revoked-parent'}))

if __name__=='__main__':unittest.main()
