import json
import unittest
from unittest.mock import patch

from services.storage.authorized import AuthorizedStorage
from services.storage.control import Conflict
from services.storage.experiments import ExperimentStore
from services.storage.iam import Forbidden
from services.storage.observations import ObservationIngest
from services.storage.tests import test_experiments as fixture
from services.storage.tests.test_observations import packet
from services.storage.tests.test_trace_transfer import MemoryFacts
from services.storage.trace_evidence import TraceEvidence
from services.storage.trace_service import TraceQueries


class ExperimentSourceLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.ExperimentTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        self.control=self.base.control;self.facts=MemoryFacts();self.ingest=ObservationIngest(self.control,self.facts)
        accepted=self.ingest.accept(self.base.bob,'w',packet());self.ingest.work_once('ingest-worker');self.trace=accepted['trace_ids'][0]
        self.base.iam.share_resource(self.base.bob,'w','trace',self.trace,'alice')
        evidence=TraceEvidence(TraceQueries(self.control,self.facts,cursor_secret=b'experiment-source-lifecycle-cursor'),AuthorizedStorage(self.base.iam,self.facts))
        self.store=ExperimentStore(self.control,evidence=evidence)
        value=fixture.experiment();value['cases'][0]['executionId']=self.trace
        self.call('create',experiment=value,operation_key='create')
        self.call('start',experiment_id='exp',frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')

    def call(self,action,**body):return self.store.dispatch(action,self.base.token,'w',body)
    def revoke(self):self.base.iam.unshare_resource(self.base.bob,'w','trace',self.trace,'alice')
    def claim(self):return self.call('claim',experiment_id='exp',worker_id='worker')

    def test_revoke_blocks_private_reads_and_claim_but_metadata_list_survives(self):
        self.revoke()
        for action in ('read','runplan','read_view'):
            with self.subTest(action=action),self.assertRaises(Forbidden):self.call(action,experiment_id='exp')
        with self.assertRaises(Forbidden):self.claim()
        values=self.call('list');self.assertEqual(values[0]['experiment']['id'],'exp');self.assertEqual(values[0]['sessions'],[])

    def test_revoked_active_attempt_cannot_load_renew_or_accept_cached_result(self):
        item=self.claim();self.revoke();handle=self.base.handle(item)
        for action,extra in [('load_work',{}),('renew',{}),('complete',{'result':{'score':80},'operation_key':'done'})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):self.call(action,**handle,**extra)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_precise_completion_lookup_checks_live_source_acl_after_receipt_commit(self):
        item=self.claim();request=self.base.handle(item)|{'result':{'score':80}}
        accepted=self.call('complete',**request,operation_key='done',operation_request=request)
        lookup={'operation_kind':'complete','operation_key':'done','operation_request':request}
        self.assertEqual(self.call('lookup_operation',**lookup)['result'],accepted)
        self.revoke()
        with self.assertRaises(Forbidden):self.call('lookup_operation',**lookup)

    def test_route_epoch_change_blocks_cached_completion_and_load(self):
        item=self.claim()
        with self.control.transaction() as con:con.execute('UPDATE trace_locators SET route_epoch=route_epoch+1 WHERE workspace_id=? AND trace_id=?',('w',self.trace))
        for action,extra in [('load_work',{}),('complete',{'result':{'score':80},'operation_key':'done'})]:
            with self.subTest(action=action),self.assertRaises(Conflict):self.call(action,**self.base.handle(item),**extra)

    def test_incarnation_and_deletion_barrier_are_independent_source_guards(self):
        with self.control.read_transaction() as con,self.assertRaises(Conflict):
            self.store._source_route(con,self.base.iam._scope(con,self.base.token),'w',{'trace_id':self.trace,'incarnation':'2','route_epoch':'1'})
        with self.control.transaction() as con:
            con.execute("INSERT INTO deletion_requests VALUES('w','delete','trace',?,1,2,'requested','bob',?,?)",(self.trace,self.base.now,self.base.now))
        with self.assertRaises(Conflict):self.call('read',experiment_id='exp')

    def test_source_content_update_preserves_frozen_body_and_scoring(self):
        before=self.call('read',experiment_id='exp')['sessions'];item=self.claim()
        self.ingest.accept(self.base.bob,'w',packet(revision=2,tokens=999));self.ingest.work_once('ingest-worker')
        self.assertEqual(self.call('read',experiment_id='exp')['sessions'],before)
        self.call('complete',**self.base.handle(item),result={'score':80},operation_key='done')

    def test_source_revoke_during_snapshot_read_is_checked_before_response(self):
        original=self.store._snapshot
        def snapshot(*args,**kwargs):
            result=original(*args,**kwargs);self.revoke();return result
        with patch.object(self.store,'_snapshot',side_effect=snapshot),self.assertRaises(Forbidden):self.call('read',experiment_id='exp')

    def test_projection_rechecks_source_without_discarding_accepted_receipt(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='done');self.revoke()
        class Sink:
            def __init__(self):self.calls=[]
            def _insert(self,*args):self.calls.append(args)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.calls,[])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'accepted')
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'pending')

    def test_revoked_delivery_credential_retains_receipt_and_never_reruns_model(self):
        item=self.claim();body=self.base.handle(item)|{'result':{'score':80},'operation_key':'done'};self.call('complete',**body)
        self.base.iam.revoke_credential(self.base.token)
        class Sink:
            def __init__(self):self.calls=[]
            def _insert(self,*args):self.calls.append(args)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.calls,[])
        self.base.token=self.base.iam.issue_session_for_provisioning('alice')
        replay=self.call('complete',**body);self.assertEqual(replay['experiment']['cases'][0]['results'][0]['score'],80)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM work_attempts WHERE status='done'").fetchone()[0],1)
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'pending')

    def test_revocation_during_sink_insert_stops_selection_and_publication(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='done')
        owner=self
        class Sink:
            def __init__(self):self.tables=[]
            def _insert(self,table,rows):self.tables.append(table);owner.revoke()
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.tables,['eval_result_facts'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'accepted')
            self.assertEqual(con.execute("SELECT COUNT(*) FROM result_receipts WHERE state='published'").fetchone()[0],0)

    def test_derived_and_receipt_replay_recheck_source_while_metadata_is_available(self):
        self.store.frozen_assets_verifier=lambda *args:True
        skills={'coreDirectSkills':[{'id':'skill','name':'Frozen Skill','user':'alice','versions':[{'version':1,'content':'frozen'}]}]}
        self.call('update',experiment_id='exp',changes={'configSnapshotJson':json.dumps(skills)},operation_key='skill')
        self.call('cancel',experiment_id='exp',operation_key='cancel-first')
        started=self.call('start',experiment_id='exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}},frozen_evaluators={'judge':{'id':'judge'}},operation_key='derived-start')
        item=self.call('claim',experiment_id='exp',run_id=started['current_run_id'],worker_id='worker')
        source=self.call('load_work',**self.base.handle(item))['frozen_trace_evidence']
        evaluation={'id':'derived','type':'dynamic','skillId':'skill','version':1,'executionId':source['execution']['id'],'status':'ok'}
        body=self.base.handle(item)|{'result':{'score':80,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[]}}}},'operation_key':'done'}
        self.call('complete',**body);self.revoke()
        for action,request in [('derived_detail',{'id':'derived'}),('derived_lookup',{'id':'derived','kind':'evaluation'}),('complete',body),('ensure_lookup',{'name':'实验','scope':''})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):self.call(action,**request)
        self.assertEqual(self.call('derived_counts',experiment_id='exp')['evaluations'],1)

    def test_scoped_read_view_never_loads_unrelated_artifact(self):
        value=fixture.experiment();value.update(id='other',name='other');value['cases'][0]['id']='other-case'
        other=self.call('create',experiment=value,operation_key='other')
        with self.control.read_transaction() as con:bad=con.execute("SELECT metadata_hash FROM experiment_heads WHERE experiment_id='other'").fetchone()[0]
        original=self.store._load
        def load(digest,*args,**kwargs):
            if digest==bad:raise AssertionError('Unrelated experiment artifact was loaded')
            return original(digest,*args,**kwargs)
        with patch.object(self.store,'_load',side_effect=load):view=self.call('read_view',experiment_id='exp')
        self.assertEqual([v['experiment']['id'] for v in view['snapshots']],['exp']);self.assertEqual(view['coverage'],'complete')

    def test_baseline_view_is_lean_complete_and_skips_revoked_history(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='done')
        value=fixture.experiment();value.update(id='current',name='current');value['cases'][0]['id']='current-case'
        self.call('create',experiment=value,operation_key='current');self.revoke()
        view=self.call('baseline_view',experiment_id='current')
        self.assertEqual(view['coverage'],'complete');self.assertEqual([v['experiment']['id'] for v in view['snapshots']],['current'])
        self.assertEqual(view['snapshots'][0]['sessions'],[])

    def test_baseline_preserves_contract_fields_scores_and_source_body_stays_omitted(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80,'summary':'private judgement'},operation_key='done')
        self.call('review',experiment_id='exp',result_id=item['result_id'],human_score=0,human_reason='override',operation_key='review')
        self.base.now+=1
        value=fixture.experiment();value.update(id='current',name='current');value['cases'][0]['id']='current-case'
        self.call('create',experiment=value,operation_key='current')
        view=self.call('baseline_view',experiment_id='current')
        self.assertEqual([v['experiment']['id'] for v in view['snapshots']],['current','exp'])
        prior=view['snapshots'][1];self.assertEqual(prior['coverage'],'complete');self.assertEqual(prior['sessions'],[]);self.assertEqual(prior['executions'],[])
        case=prior['experiment']['cases'][0];self.assertEqual(case['referenceOutput'],'答案');self.assertEqual(case['caseValuesJson'],'{"分数":1.25}')
        result=case['results'][0];self.assertEqual(result['score'],80);self.assertEqual(result['humanScore'],0);self.assertNotIn('summary',result)


    def test_benchmark_fact_projection_checks_public_frozen_sources_before_any_sink_write(self):
        import sys,types
        value=fixture.experiment();value.update(id='bench',scope='benchmark');value['cases'][0].update(id='bench-case',executionId=self.trace)
        self.call('create',experiment=value,operation_key='bench-create')
        started=self.call('start',experiment_id='bench',frozen_evaluators={'judge':{'id':'judge'}},operation_key='bench-start')
        item=self.call('claim',experiment_id='bench',worker_id='bench-worker')
        handle={key:item[key] for key in ('attempt_id','fence','lease_owner')}
        self.call('complete',experiment_id='bench',**handle,result={'score':80},operation_key='bench-complete')
        calls=[]
        class Benchmark:
            def __init__(self,*args,**kwargs):pass
            def _source_acl(self,con,scope,ws,exp,run):
                calls.append((ws,exp,run));raise Forbidden('Public Benchmark dataset access revoked')
        class Sink:
            def __init__(self):self.tables=[]
            def _insert(self,table,rows):self.tables.append(table)
        sink=Sink()
        with patch.dict(sys.modules,{'services.storage.benchmark_core':types.SimpleNamespace(BenchmarkStore=Benchmark)}):self.assertTrue(self.store.project_once(sink,'projection-worker'))
        self.assertEqual(sink.tables,[]);self.assertEqual(calls,[('w','bench',started['current_run_id'])])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'accepted')


    def test_quarantined_machine_receipt_cannot_be_presented_as_a_valid_detail(self):
        from services.storage.experiments import ExperimentUnavailable
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='complete')
        with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='quarantined'")
        for action in ('read','read_view'):
            with self.subTest(action=action),self.assertRaises(ExperimentUnavailable):self.call(action,experiment_id='exp')


    def test_quarantined_receipt_never_reaches_facts_or_selection_projection(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='complete')
        with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='quarantined'")
        class Sink:
            def __init__(self):self.tables=[]
            def _insert(self,table,rows):self.tables.append(table)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.tables,[])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'quarantined')
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'dead')


    def test_restart_with_advancing_clock_keeps_slot_timestamps_monotonic(self):
        def ticking():
            self.base.now+=1
            return self.base.now
        self.control.clock=ticking
        second=self.call('start',experiment_id='exp',frozen_evaluators={'judge':{'id':'judge'}},operation_key='second-start',force_new_trace=True)
        self.assertEqual(second['experiment']['status'],'running')
        with self.control.read_transaction() as con:
            slot=con.execute("SELECT * FROM experiment_result_slots WHERE experiment_id='exp'").fetchone()
            self.assertGreaterEqual(slot['updated_at_ms'],slot['created_at_ms']);self.assertEqual(slot['status'],'pending')


    def test_global_cancel_is_current_plan_scoped_even_when_no_case_exists(self):
        value=fixture.experiment();value.update(id='empty',scope='skill-workbench',cases=[])
        self.call('create',experiment=value,operation_key='empty-create')
        cancelled=self.call('cancel',experiment_id='empty',operation_key='empty-cancel')
        self.assertEqual(cancelled['experiment']['status'],'cancelled')
        cancellation=cancelled['cancellation']['id']
        self.assertIn(cancellation,cancelled['experiment']['coreActiveCancellationIds'])
        settled=self.call('reconcile',experiment_id='empty');self.assertEqual(settled['experiment']['status'],'cancelled')
        self.call('case_upsert',experiment_id='empty',case={'id':'new-case','input':'new intent'},operation_key='new-case')
        started=self.call('start',experiment_id='empty',frozen_evaluators={'judge':{'id':'judge'}},operation_key='explicit-new-start')
        self.assertEqual(started['experiment']['status'],'running');self.assertNotIn(cancellation,started['experiment']['coreActiveCancellationIds'])
        self.assertEqual(len(started['experiment']['cancellations']),1)


    def test_publication_waits_for_transport_but_contains_only_scoring_members(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='complete')
        now=self.control.clock()
        with self.control.transaction() as con:
            con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES('w','transport',?,'case','execute','__execution__','done',?,?)",(item['run_id'],now,now))
        class Sink:
            def __init__(self):self.members=[]
            def _insert(self,table,rows):
                if table=='eval_publication_members':self.members.extend(rows)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'))
        self.assertEqual(len(sink.members),1);self.assertEqual(sink.members[0]['evaluator_slot'],'judge')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'published')


    def test_publication_is_retried_after_a_later_transport_terminal_without_new_score(self):
        item=self.claim();self.call('complete',**self.base.handle(item),result={'score':80},operation_key='complete')
        now=self.control.clock()
        with self.control.transaction() as con:con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES('w','transport',?,'case','execute','__execution__','running',?,?)",(item['run_id'],now,now))
        class Sink:
            def __init__(self):self.members=[]
            def _insert(self,table,rows):
                if table=='eval_publication_members':self.members.extend(rows)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.members,[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'pending')
        self.base.now+=2001
        with self.control.transaction() as con:con.execute("UPDATE work_items SET status='failed',updated_at_ms=? WHERE work_item_id='transport'",(self.base.now,))
        self.call('reconcile',experiment_id='exp');self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(len(sink.members),1)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'published')
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'sent')


if __name__=='__main__':unittest.main()

