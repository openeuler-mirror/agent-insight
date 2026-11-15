import copy
import importlib.util
import json
import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_datasets as dataset_fixture


def experiment():
    return {'id':'exp','name':'实验','type':'single','scope':'','evaluatorIdsJson':'["judge"]',
            'evaluatorConfigsJson':'{}','configSnapshotJson':'{}','groups':[],
            'cases':[{'id':'case','input':'问题','actualOutput':'实际','referenceOutput':'答案',
                      'taskId':None,'executionId':None,'caseValuesJson':'{"分数":1.25}'}]}


class ExperimentTests(unittest.TestCase):
    make_control=dataset_fixture.DatasetTests.make_control
    setUp=dataset_fixture.DatasetTests.setUp

    @staticmethod
    def not_found():
        from services.storage.experiments import ExperimentNotFound
        return ExperimentNotFound

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.experiments'),'Experiment core domain must exist')
        from services.storage.experiments import ExperimentStore
        return ExperimentStore(self.control)

    def call(self,action,**body):
        return self.service().dispatch(action,self.token,'w',body)

    def create(self): return self.call('create',experiment=experiment(),operation_key='create')
    def start(self,**kw):
        return self.call('start',experiment_id='exp',operation_key='start',frozen_evaluators={'judge':{'id':'judge','name':'Frozen judge','prompt':'规则'}},**kw)
    def claim(self): return self.call('claim',experiment_id='exp',worker_id='worker')
    @staticmethod
    def handle(item): return {k:item[k] for k in ('attempt_id','fence','lease_owner')}|{'experiment_id':'exp'}

    def test_create_preserves_dto_owner_and_exact_retry(self):
        value=experiment(); value['user']='bob'; first=self.call('create',experiment=value,operation_key='create')
        self.assertEqual(first['experiment']['user'],'alice');self.assertEqual(first['experiment']['cases'][0]['referenceOutput'],'答案')
        self.assertEqual(first,self.call('create',experiment=value,operation_key='create'));self.assertEqual(first['revision'],'1')
        value['name']='different'
        with self.assertRaises(Conflict):self.call('create',experiment=value,operation_key='create')

    def test_lookup_operation_is_exact_actor_scoped_and_returns_original_receipt(self):
        request={'method':'POST','path':'/api/experiments','body':{'name':'实验'}}
        first=self.call('create',experiment=experiment(),operation_key='receipt',operation_request=request)
        lookup={'operation_kind':'create','operation_key':'receipt','operation_request':request}
        self.assertEqual(self.call('lookup_operation',**lookup),{'found':True,'result':first})
        self.assertEqual(self.service().dispatch('lookup_operation',self.bob,'w',lookup),{'found':False})
        with self.assertRaises(Conflict):self.call('lookup_operation',**(lookup|{'operation_request':{'changed':True}}))
        with self.assertRaises(ValueError):self.call('lookup_operation',**(lookup|{'operation_kind':'read'}))
        self.call('update',experiment_id='exp',changes={'name':'new'},operation_key='edit')
        self.assertEqual(self.call('lookup_operation',**lookup)['result'],first)
        self.call('remove',experiment_id='exp',operation_key='delete')
        with self.assertRaises(self.not_found()):self.call('lookup_operation',**lookup)

    def test_private_live_acl_shared_read_never_write_or_claim(self):
        self.create()
        with self.assertRaises(Forbidden):self.service().dispatch('read',self.bob,'w',{'experiment_id':'exp'})
        self.iam.share_resource(self.token,'w','run','exp','bob')
        self.assertEqual(self.service().dispatch('read',self.bob,'w',{'experiment_id':'exp'})['experiment']['id'],'exp')
        with self.assertRaises(Forbidden):self.service().dispatch('update',self.bob,'w',{'experiment_id':'exp','changes':{'name':'x'},'operation_key':'x'})
        with self.assertRaises(Forbidden):self.service().dispatch('claim',self.bob,'w',{'experiment_id':'exp','worker_id':'w'})

    def test_plan_frozen_config_case_and_replay_start_once(self):
        self.create();one=self.start();self.assertEqual(one,self.start())
        self.call('case_upsert',experiment_id='exp',case={'id':'case','referenceOutput':'新答案'},operation_key='case-edit')
        item=self.claim();work=self.call('load_work',**self.handle(item))
        self.assertEqual(work['raw_case']['referenceOutput'],'答案');self.assertEqual(work['frozen_evaluator']['prompt'],'规则')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)

    def test_complete_atomic_machine_receipt_selection_outbox_and_old_result_id(self):
        self.create();self.start();item=self.claim();body=self.handle(item)|{'operation_key':'complete','result':{'score':91.25,'verdict':'pass','points':[{'中文':False}],'evidence':{'json':{'full':'原始'}}}}
        done=self.call('complete',**body);self.assertEqual(done,self.call('complete',**body))
        result=done['experiment']['cases'][0]['results'][0];self.assertEqual(result['id'],item['result_id']);self.assertEqual(result['score'],91.25)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_selections').fetchone()[0],1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],1)

    def test_expired_claim_renew_and_old_fence_cannot_finish(self):
        self.create();self.start();one=self.claim();self.now+=30001;two=self.claim();self.assertNotEqual(one['attempt_id'],two['attempt_id'])
        with self.assertRaises(Conflict):self.call('complete',**self.handle(one),result={'score':99},operation_key='stale')
        with self.assertRaises(Conflict):self.call('renew',**self.handle(one))
        self.call('renew',**self.handle(two))

    def test_wrong_owner_checkpoint_conflict_and_retry_durable(self):
        self.create();self.start();one=self.claim();body=self.handle(one)|{'checkpoint':{'stage':'running','partial':'完整中文'},'expected_revision':'1','operation_key':'cp'}
        saved=self.call('checkpoint',**body);self.assertEqual(saved,self.call('checkpoint',**body))
        with self.assertRaises(Conflict):self.call('checkpoint',**(body|{'checkpoint':{'stage':'other'},'operation_key':'cp2'}))
        with self.assertRaises(Conflict):self.call('renew',**(self.handle(one)|{'lease_owner':'other'}))
        self.assertEqual(self.call('load_work',**self.handle(one))['checkpoint']['partial'],'完整中文')

    def test_retry_keeps_old_machine_and_clears_only_current_review(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':20},operation_key='done')
        self.call('review',experiment_id='exp',result_id=one['result_id'],human_score=80,human_reason='核验',operation_key='review')
        again=self.call('retry',experiment_id='exp',result_id=one['result_id'],operation_key='retry');two=self.claim()
        self.assertEqual(one['result_id'],two['result_id']);self.assertGreater(int(two['fence']),int(one['fence']))
        self.call('complete',**self.handle(two),result={'score':50},operation_key='done2')
        current=self.call('read',experiment_id='exp')['experiment']['cases'][0]['results'][0]
        self.assertEqual(current['score'],50);self.assertIsNone(current['humanScore'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],2)

    def test_cancel_delete_prevent_stale_callbacks_and_unauthorized_delete(self):
        self.create();self.start();one=self.claim();self.call('remove',experiment_id='exp',operation_key='delete')
        with self.assertRaises((Conflict,self.not_found())):self.call('complete',**self.handle(one),result={'score':1},operation_key='late')
        self.assertEqual(self.call('list'),[])
        with self.assertRaises(Forbidden):self.service().dispatch('read',self.bob,'w',{'experiment_id':'exp'})

    def test_comments_review_do_not_mutate_machine_and_foreign_target_rejected(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':30},operation_key='done')
        comment=self.call('comment',experiment_id='exp',case_id='case',result_id=one['result_id'],body='意见',operation_key='comment')
        self.assertEqual(len(self.call('comments',experiment_id='exp')),1)
        self.call('review',experiment_id='exp',result_id=one['result_id'],human_score=0,human_reason='真实0',operation_key='review')
        result=self.call('read',experiment_id='exp')['experiment']['cases'][0]['results'][0];self.assertEqual(result['score'],30);self.assertEqual(result['humanScore'],0)
        with self.assertRaises((Conflict,ValueError,self.not_found())):self.call('comment',experiment_id='exp',case_id='other',body='x',operation_key='wrong')
        self.call('comment_remove',experiment_id='exp',comment_id=comment['id'],operation_key='removecomment');self.assertEqual(self.call('comments',experiment_id='exp'),[])

    def test_restricted_write_token_cannot_read_gold_through_receipt(self):
        self.create();token=self.iam.issue_api_credential(self.token,'w',{'write'})
        with self.assertRaises(Forbidden):self.service().dispatch('create',token,'w',{'experiment':experiment(),'operation_key':'create'})

    def test_source_namespaces_and_tables_catalog_agree(self):
        self.create()
        from pathlib import Path
        root=Path(__file__).resolve().parents[1]/'schema';catalog=json.loads((root/'experiment-catalog.json').read_text())
        self.assertEqual(catalog['version'],10);self.assertEqual(len(catalog['tables']),8)
        with self.control.read_transaction() as con:
            for table in catalog['tables']:
                columns=[row[0] for row in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))] if hasattr(self.control,'schema') else [row[1] for row in con.execute('PRAGMA table_info('+table['name']+')')]
                self.assertEqual(columns,[c['name'] for c in table['columns']])

    def test_live_check_work_is_read_only_no_artifact_or_renew(self):
        self.create();self.start();one=self.claim();before=one['lease_until_ms']
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('no artifact for check')):
            self.assertEqual(self.call('check_work',**self.handle(one)),{'active':True})
        self.assertEqual(self.call('load_work',**self.handle(one))['handle']['lease_until_ms'],before)

    def test_nonowner_gold_is_redacted_and_cannot_claim(self):
        self.create();self.start();self.iam.share_resource(self.token,'w','run','exp','bob')
        for token in (self.bob,self.admin):
            result=self.service().dispatch('read',token,'w',{'experiment_id':'exp'})
            self.assertIsNone(result['experiment']['cases'][0]['referenceOutput'])
            self.assertTrue(result['gold_redacted'])
            with self.assertRaises(Forbidden):self.service().dispatch('runplan',token,'w',{'experiment_id':'exp'})
            with self.assertRaises(Forbidden):self.service().dispatch('claim',token,'w',{'experiment_id':'exp','worker_id':'w'})
        self.assertEqual(self.call('read',experiment_id='exp')['coverage'],'complete')

    def test_judge_trace_registration_is_atomic_actor_fenced_and_idempotent(self):
        self.create();self.start();one=self.claim();service=self.service();handle=self.handle(one)
        proof=service.authorize_recording(self.token,'w',handle);self.assertEqual(proof['owner_principal_id'],'alice')
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','judge-trace','judge','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','judge-trace','alice','private',invalidate_policy=False)
            service.register_judge_trace_tx(con,self.token,'w',handle,'judge-trace')
            service.register_judge_trace_tx(con,self.token,'w',handle,'judge-trace')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_judge_traces').fetchone()[0],1)
        self.call('cancel',experiment_id='exp',operation_key='cancel')
        with self.assertRaises(Conflict):service.authorize_recording(self.token,'w',handle)

    def test_projection_partial_retry_replays_same_rows_and_publishes_last(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':0,'verdict':'fail','metrics':[{'key':'custom','value':1.25}]},operation_key='done')
        class Facts:
            def __init__(self):self.calls=[];self.fail=True
            def _insert(self,table,rows):
                self.calls.append((table,copy.deepcopy(rows)))
                if table=='eval_metric_facts' and self.fail:self.fail=False;raise OSError('sink unavailable')
        facts=Facts();service=self.service();self.assertTrue(service.project_once(facts,'worker'))
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'accepted')
        self.now+=10000;self.assertTrue(service.project_once(facts,'worker'))
        self.assertEqual(facts.calls[0],facts.calls[2]);self.assertEqual(facts.calls[-1][0],'eval_publication_members')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'published')

    def test_read_view_has_complete_cases_and_cancel_intent_is_not_faked_empty(self):
        self.create();self.start();one=self.claim();self.call('cancel',experiment_id='exp',operation_key='cancel')
        view=self.call('read_view');self.assertEqual(view['coverage'],'complete');snapshot=view['snapshots'][0]
        self.assertEqual(snapshot['coverage'],'complete');self.assertEqual(len(snapshot['experiment']['cases']),1)
        self.assertEqual(len(snapshot['experiment']['cancellations']),1)
        self.assertEqual(snapshot['experiment']['cancellations'][0]['status'],'completed')

    def test_claim_requested_result_does_not_consume_another_slot(self):
        value=experiment();value['evaluatorIdsJson']='["first","second"]';self.call('create',experiment=value,operation_key='create')
        self.call('start',experiment_id='exp',operation_key='start',frozen_evaluators={'first':{'id':'first'},'second':{'id':'second'}})
        slots=self.call('read',experiment_id='exp')['experiment']['cases'][0]['results'];target=next(v['id'] for v in slots if v['evaluatorId']=='second')
        item=self.call('claim',experiment_id='exp',worker_id='worker',result_id=target);self.assertEqual(item['result_id'],target)
        self.assertIsNone(self.call('claim',experiment_id='exp',worker_id='worker',result_id=target))

    def test_admin_write_response_and_owner_receipt_replay_stay_gold_redacted(self):
        self.create();result=self.service().dispatch('update',self.admin,'w',{'experiment_id':'exp','changes':{'name':'admin edit'},'operation_key':'update'})
        self.assertIsNone(result['experiment']['cases'][0]['referenceOutput'])
        self.assertEqual(result,self.service().dispatch('update',self.admin,'w',{'experiment_id':'exp','changes':{'name':'admin edit'},'operation_key':'update'}))

    def test_read_view_count_budget_is_explicit_not_silent_truncation(self):
        self.create();value=experiment();value.update(id='exp2',cases=[]);self.call('create',experiment=value,operation_key='create2')
        from services.storage.experiments import ExperimentTooLarge
        with patch('services.storage.experiments.MAX_ITEMS',1):
            with self.assertRaises(ExperimentTooLarge):self.call('read_view')

    def test_retry_uses_new_immutable_plan_and_preserves_previous_selection(self):
        self.create();start=self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':1},operation_key='one')
        old_plan=self.call('runplan',experiment_id='exp')['runplan'];again=self.call('retry',experiment_id='exp',result_id=one['result_id'],operation_key='retry')
        self.assertNotEqual(start['current_run_id'],again['current_run_id'])
        plan=self.call('runplan',experiment_id='exp')['runplan'];self.assertEqual(plan['cases'],old_plan['cases'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_selections').fetchone()[0],1)

    def test_stale_read_authorization_postflight_rejects_body(self):
        self.create();service=self.service();original=service._load;changed=[False]
        def load(*args,**kwargs):
            result=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True
                with self.control.transaction() as con:con.execute("UPDATE iam_group_memberships SET status='disabled',etag=etag+1,updated_at_ms=? WHERE group_id='group' AND principal_id='alice'",(self.now,))
            return result
        with patch.object(service,'_load',side_effect=load):
            with self.assertRaises(Forbidden):service.dispatch('read',self.token,'w',{'experiment_id':'exp'})

    def test_bound_trace_without_evidence_does_not_fall_back_to_legacy(self):
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','trace','otlp','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','trace','alice','private',invalidate_policy=False)
        value=experiment();value['cases'][0]['taskId']='trace';self.call('create',experiment=value,operation_key='create')
        from services.storage.experiments import ExperimentUnavailable
        with self.assertRaises(ExperimentUnavailable):self.start()
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],0)

    def test_result_lookup_authorizes_parent_and_does_not_claim(self):
        self.create();self.start();slot=self.call('read',experiment_id='exp')['experiment']['cases'][0]['results'][0]
        lookup=self.call('result_lookup',result_id=slot['id']);self.assertEqual(lookup['experiment_id'],'exp')
        with self.assertRaises(Forbidden):self.service().dispatch('result_lookup',self.bob,'w',{'result_id':slot['id']})
        self.assertEqual(self.claim()['result_id'],slot['id'])

    def test_review_projection_keeps_machine_metric_and_indexes_explicit_zero_override(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':30},operation_key='done')
        self.call('review',experiment_id='exp',result_id=one['result_id'],human_score=0,human_reason='人工核验',operation_key='review')
        class Facts:
            def __init__(self):self.calls=[]
            def _insert(self,table,rows):self.calls.append((table,copy.deepcopy(rows)))
        facts=Facts();service=self.service();self.assertTrue(service.project_once(facts,'worker'));self.assertTrue(service.project_once(facts,'worker'))
        metrics=[r for table,rows in facts.calls if table=='eval_metric_facts' for r in rows]
        self.assertEqual(next(r['value_int'] for r in metrics if r['metric_key']=='score'),30)
        self.assertEqual(next(r['value_int'] for r in metrics if r['metric_key']=='human_score'),0)
        selections=[r for table,rows in facts.calls if table=='eval_result_selection_current' for r in rows]
        self.assertTrue(selections[-1]['review_decision_id']);self.assertGreater(selections[-1]['selection_revision'],selections[0]['selection_revision'])

    def test_single_experiment_read_byte_budget_counts_comments_incrementally(self):
        self.create()
        for index in range(3):self.call('comment',experiment_id='exp',body='x'*1000,operation_key='comment'+str(index))
        from services.storage.experiments import ExperimentTooLarge
        with patch('services.storage.experiments.MAX_BYTES',1500):
            with self.assertRaises(ExperimentTooLarge):self.call('read',experiment_id='exp')

    def test_judge_registration_rejects_another_owner_trace_even_if_shared(self):
        self.create();self.start();one=self.claim()
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','bob-trace','otlp','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','bob-trace','bob','group')
        with self.assertRaises(Forbidden):
            with self.control.transaction() as con:self.service().register_judge_trace_tx(con,self.token,'w',self.handle(one),'bob-trace')

    def test_corrupt_durable_machine_artifact_is_quarantined_not_indexed(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':1},operation_key='done')
        from pathlib import Path
        with self.control.read_transaction() as con:ref=con.execute('SELECT artifact_ref FROM result_receipts').fetchone()[0]
        Path(ref).write_text('corrupt')
        class Facts:
            def _insert(self,*args):raise AssertionError('corrupt artifact must not reach facts')
        self.assertTrue(self.service().project_once(Facts(),'worker'))
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'quarantined')
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'dead')

    def test_current_run_cannot_reference_an_unrelated_or_missing_plan(self):
        self.create()
        with self.assertRaises(Conflict):
            with self.control.transaction() as con:con.execute("UPDATE experiment_heads SET current_run_id='missing',revision=revision+1 WHERE workspace_id='w' AND experiment_id='exp'")

    def test_human_score_rounding_matches_original_positive_half_up(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':1},operation_key='done')
        result=self.call('review',experiment_id='exp',result_id=one['result_id'],human_score=75.25,human_reason='核验',operation_key='review')
        self.assertEqual(result['experiment']['cases'][0]['results'][0]['humanScore'],75.3)

    def test_case_delete_before_projection_blocks_stale_sink_publication(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':1},operation_key='done')
        self.call('case_remove',experiment_id='exp',case_id='case',operation_key='remove-case')
        class Facts:
            def _insert(self,*args):raise AssertionError('deleted Case cannot publish facts')
        self.assertTrue(self.service().project_once(Facts(),'worker'))
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],'dead')

    def test_trace_rebinding_clears_current_machine_selection_but_keeps_history(self):
        self.create();self.start();one=self.claim();self.call('complete',**self.handle(one),result={'score':1},operation_key='done')
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','new-trace','otlp','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','new-trace','alice','private',invalidate_policy=False)
        changed=self.call('bind_trace',experiment_id='exp',case_id='case',task_id='new-trace',operation_key='bind')
        self.assertIsNone(changed['experiment']['cases'][0]['results'][0]['score'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)

    def execution_start(self):
        return self.call('execute_start',experiment_id='exp',execution_request={'workerId':'client','platform':'opencode','agent':'agent'},frozen_evaluators={'judge':{'card':{'id':'judge','prompt':'frozen rule'}}},operation_key='execute-start')

    def test_execute_phase_is_separate_public_and_cannot_be_claimed_by_scoring(self):
        self.create();start=self.execution_start();self.assertIsNone(self.claim())
        one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker');self.assertEqual(one['phase'],'execute')
        work=self.call('load_work',**self.handle(one));self.assertNotIn('referenceOutput',work['raw_case']);self.assertNotIn('frozen_evaluators',work['runplan'])
        self.assertEqual(work['execution_request']['workerId'],'client');self.assertEqual(start['run_id'],one['run_id'])

    def test_execute_takeover_preserves_command_until_cleanup_then_allows_new_command(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'command-one'},operation_key='checkpoint1')
        self.now+=30001;two=self.call('claim',experiment_id='exp',phase='execute',worker_id='successor')
        work=self.call('load_work',**self.handle(two));self.assertEqual(work['checkpoint']['command_id'],'command-one');self.assertTrue(work['checkpoint']['cleanup_required'])
        with self.assertRaises(Conflict):self.call('checkpoint',**self.handle(two),expected_revision='1',checkpoint={'command_id':'command-two'},operation_key='bad')
        self.call('checkpoint',**self.handle(two),expected_revision='1',checkpoint={'command_id':'command-one','cleanup_confirmed':True},operation_key='clean')
        self.call('checkpoint',**self.handle(two),expected_revision='2',checkpoint={'command_id':'command-two'},operation_key='new')

    def test_execute_retryable_failure_has_bounded_backoff_and_preserves_attempt(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('execute_fail',**self.handle(one),error={'code':'CLIENT_EXECUTION_FAILED','message':'失败'},retryable=True,cleanup_confirmed=True,operation_key='failed')
        self.assertIsNone(self.call('claim',experiment_id='exp',phase='execute',worker_id='worker'))
        self.now+=5000;two=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker');self.assertNotEqual(one['attempt_id'],two['attempt_id'])
        with self.assertRaises(Conflict):self.call('execute_fail',**self.handle(one),error='late',operation_key='late')

    def test_cancellation_lookup_after_delete_and_verified_update_cas(self):
        self.create();self.start();one=self.claim();self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'external'},operation_key='checkpoint')
        removed=self.call('remove',experiment_id='exp',operation_key='remove');identity=removed['cancellation_id']
        current=self.call('cancellation_lookup',cancellation_id=identity);self.assertEqual(current['status'],'pending')
        request={'cancellation_id':identity,'expected_revision':current['revision'],'targets':[{**target,'confirmed':True} for target in json.loads(current['targetsJson'])],'status':'completed','operation_key':'cancel-done'}
        with self.assertRaises(Forbidden):self.call('cancellation_update',**request)
        from services.storage.experiments import ExperimentStore
        service=ExperimentStore(self.control,cancellation_verifier=lambda token,ws,current,requested:True)
        updated=service.dispatch('cancellation_update',self.token,'w',request);self.assertEqual(updated['status'],'completed')
        self.assertEqual(updated,service.dispatch('cancellation_update',self.token,'w',request))

    def test_execute_complete_requires_real_indexed_trace_and_freezes_score_child(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_observations import packet
        from services.storage.observations import ObservationIngest
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.experiments import ExperimentStore
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts)
        evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'experiment-test-cursor-private'),AuthorizedStorage(self.iam,facts))
        service=ExperimentStore(self.control,evidence=evidence)
        self.create();parent=self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        accepted=ingest.accept(self.token,'w',packet());trace=accepted['trace_ids'][0]
        from services.storage.trace_evidence import EvidenceUnavailable
        with self.assertRaises(EvidenceUnavailable):service.dispatch('execute_complete',self.token,'w',self.handle(one)|{'trace_id':trace,'operation_key':'complete'})
        self.assertTrue(ingest.work_once('ingest-worker'))
        result=service.dispatch('execute_complete',self.token,'w',self.handle(one)|{'trace_id':trace,'operation_key':'complete'})
        self.assertNotEqual(parent['run_id'],result['current_run_id'])
        score=self.claim();work=service.dispatch('load_work',self.token,'w',self.handle(score))
        self.assertEqual(work['raw_case']['referenceOutput'],'答案');self.assertEqual(work['raw_case']['actualOutput'],'world')
        self.assertEqual(work['frozen_evaluator']['card']['prompt'],'frozen rule')
        self.assertEqual(work['frozen_trace_evidence']['manifest']['trace_id'],trace)
        self.assertEqual(result,service.dispatch('execute_complete',self.token,'w',self.handle(one)|{'trace_id':trace,'operation_key':'complete'}))

    def test_execution_progress_has_real_attempt_and_waiting_trace_phase(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.assertEqual(one['attempt_no'],1)
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'stage':'waiting_trace','status':'waiting_trace','command_id':'command','observed_trace_id':'not-indexed-yet'},operation_key='cp')
        progress=self.call('read',experiment_id='exp')['experiment']['cases'][0]['executionSnapshot']['progress']
        self.assertEqual(progress['stage'],2);self.assertEqual(progress['label'],'等待 Trace 入库')
        with self.assertRaises(Conflict):self.call('complete',**self.handle(one),result={'score':100},operation_key='not-score')

    def test_cancel_updates_are_folded_by_revision_not_random_uuid(self):
        self.create();cancelled=self.call('cancel',experiment_id='exp',operation_key='cancel');identity=cancelled['cancellation_id']
        from services.storage.experiments import ExperimentStore
        service=ExperimentStore(self.control,cancellation_verifier=lambda *args:True)
        with patch('services.storage.experiments._id',return_value='000-update'):
            service.dispatch('cancellation_update',self.token,'w',{'cancellation_id':identity,'expected_revision':'1','targets':[],'status':'completed','operation_key':'update'})
        self.assertEqual(self.call('cancellation_lookup',cancellation_id=identity)['revision'],'2')

    def test_case_lookup_by_fi_run_is_scoped_and_uses_indexed_checkpoint(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'fi:run','fi_run_id':'run','fi_task_key':'task'},operation_key='checkpoint')
        found=self.call('case_lookup',fi_run_id='run');self.assertEqual(found['experiment_id'],'exp');self.assertEqual(found['case_id'],'case')
        self.assertNotIn('referenceOutput',found['case'])
        with self.assertRaises(Forbidden):self.service().dispatch('case_lookup',self.bob,'w',{'fi_run_id':'run'})

    def test_ensure_is_actor_scoped_atomic_and_recreates_deleted_container(self):
        first=self.call('ensure',experiment=experiment(),operation_key='ensure')
        changed=experiment();changed.pop('id');changed['cases']=[];second=self.call('ensure',experiment=changed,operation_key='ensure2')
        self.assertEqual(first['experiment']['id'],second['experiment']['id'])
        self.call('remove',experiment_id=first['experiment']['id'],operation_key='remove')
        recreated=self.call('ensure',experiment=changed,operation_key='ensure3');self.assertNotEqual(first['experiment']['id'],recreated['experiment']['id'])

    def test_start_subset_does_not_cancel_unrelated_evaluator_and_reuses_active(self):
        value=experiment();value['evaluatorIdsJson']='["first","second"]';self.call('create',experiment=value,operation_key='create')
        frozen={'first':{'id':'first'},'second':{'id':'second'}}
        first=self.call('start',experiment_id='exp',evaluator_ids=['first'],frozen_evaluators=frozen,operation_key='first')
        one=self.call('claim',experiment_id='exp',worker_id='worker');self.assertEqual(one['evaluator_id'],'first')
        second=self.call('start',experiment_id='exp',evaluator_ids=['second'],frozen_evaluators=frozen,operation_key='second')
        self.assertTrue(self.call('check_work',**self.handle(one))['active'])
        reused=self.call('start',experiment_id='exp',evaluator_ids=['second'],frozen_evaluators=frozen,operation_key='again');self.assertTrue(reused['alreadyRunning'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],2)

    def test_execute_retry_new_run_requires_cleanup_of_prior_command(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'first-command'},operation_key='cp')
        self.call('execute_fail',**self.handle(one),error='unknown cleanup',cleanup_confirmed=False,operation_key='fail')
        self.call('execute_start',experiment_id='exp',execution_request={'workerId':'client'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='retry-new')
        two=self.call('claim',experiment_id='exp',phase='execute',worker_id='successor')
        work=self.call('load_work',**self.handle(two));self.assertTrue(work['checkpoint']['cleanup_required']);self.assertEqual(work['checkpoint']['command_id'],'first-command')

    def test_only_if_new_deduplicates_trace_aliases_per_group_without_overwrite(self):
        self.create()
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','trace','otlp','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','trace','alice','private',invalidate_policy=False)
        one=self.call('case_upsert',experiment_id='exp',case={'id':'one','taskId':'trace','groupId':'A','referenceOutput':'完整gold'},only_if_new=True,operation_key='one')
        two=self.call('case_upsert',experiment_id='exp',case={'id':'two','executionId':'trace','groupId':'A','referenceOutput':None},only_if_new=True,operation_key='two')
        self.assertEqual(two['case_id'],'one');self.assertTrue(two['reused'])
        self.assertEqual(next(c for c in two['experiment']['cases'] if c['id']=='one')['referenceOutput'],'完整gold')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_cases').fetchone()[0],2)

    def test_trace_ingest_timeout_can_reconcile_current_observed_trace_without_reexecution(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_observations import packet
        from services.storage.observations import ObservationIngest
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.experiments import ExperimentStore
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts)
        evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'experiment-late-cursor-private'),AuthorizedStorage(self.iam,facts));service=ExperimentStore(self.control,evidence=evidence)
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'command','observed_trace_id':'a'*32},operation_key='cp')
        self.call('execute_fail',**self.handle(one),error={'code':'TRACE_INGEST_TIMEOUT','message':'late ingest'},cleanup_confirmed=True,operation_key='fail')
        ingest.accept(self.token,'w',packet());self.assertTrue(ingest.work_once('ingest-worker'))
        result=service.dispatch('execute_reconcile',self.token,'w',{'case_id':'case','min_attempt_no':1,'operation_key':'late'})
        self.assertTrue(result['reconciled']);self.assertEqual(result['experiment']['cases'][0]['taskId'],'a'*32)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts').fetchone()[0],1)
        self.assertEqual(result,service.dispatch('execute_reconcile',self.token,'w',{'case_id':'case','min_attempt_no':1,'operation_key':'late'}))

    def test_new_execution_run_has_its_own_three_attempt_retry_budget(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('execute_fail',**self.handle(one),error='x',retryable=True,cleanup_confirmed=True,operation_key='fail1');self.now+=5000
        two=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker');self.call('execute_fail',**self.handle(two),error='x',cleanup_confirmed=True,operation_key='fail2')
        self.call('execute_start',experiment_id='exp',execution_request={},frozen_evaluators={'judge':{'id':'judge'}},operation_key='new')
        three=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker');self.assertEqual(three['attempt_no'],3)
        self.call('execute_fail',**self.handle(three),error='x',retryable=True,cleanup_confirmed=True,operation_key='fail3');self.now+=5000
        self.assertIsNotNone(self.call('claim',experiment_id='exp',phase='execute',worker_id='worker'))

    def test_derived_objects_require_frozen_skill_scope_and_do_not_commit_bad_result(self):
        self.create();self.start();one=self.claim()
        with self.assertRaises((ValueError,Conflict)):
            self.call('complete',**self.handle(one),result={'score':1,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[{'id':'derived','skillId':'other','executionId':'other','user':'bob'}],'skillIssues':[]}}}},operation_key='bad-derived')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_derived_lookup_current_list_and_history_are_real_receipt_bound(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_observations import packet
        from services.storage.observations import ObservationIngest
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.experiments import ExperimentStore
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts);ingest.accept(self.token,'w',packet());ingest.work_once('worker')
        evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'derived-private-cursor-secret'),AuthorizedStorage(self.iam,facts));service=ExperimentStore(self.control,evidence=evidence,frozen_assets_verifier=lambda *args:True)
        value=experiment();value['configSnapshotJson']=json.dumps({'coreDirectSkills':[{'id':'skill','name':'Frozen Skill','user':'alice','activeVersion':1,'versions':[{'version':1,'content':'version one'}],'parsedFlows':[{'version':1,'user':'alice','steps':[]}]}]});value['cases'][0]['taskId']='a'*32;service.dispatch('create',self.token,'w',{'experiment':value,'operation_key':'create'})
        service.dispatch('start',self.token,'w',{'experiment_id':'exp','config':{'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}},'frozen_evaluators':{'judge':{'id':'judge'}},'operation_key':'start'})
        one=self.claim();evaluation={'id':'derived-one','type':'dynamic','skillId':'skill','version':1,'executionId':'a'*32,'user':'bob','status':'ok','generator':'trajectory-evaluator@1.0'}
        issue={'id':'issue-one','evaluationId':'derived-one','skillId':'skill','version':1,'user':'bob','summary':'真实问题','evidence':'private evidence'}
        result={'score':90,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[issue]}}}}
        invalid=copy.deepcopy(result);invalid['evidence']['json']['directTrajectoryDerived']['evaluations'][0]['version']=2;invalid['evidence']['json']['directTrajectoryDerived']['skillIssues'][0]['version']=2
        with self.assertRaises(Forbidden):service.dispatch('complete',self.token,'w',self.handle(one)|{'result':invalid,'operation_key':'wrong-version'})
        service.dispatch('complete',self.token,'w',self.handle(one)|{'result':result,'operation_key':'complete'})
        found=service.dispatch('derived_lookup',self.token,'w',{'kind':'evaluation','id':'derived-one'});self.assertEqual(found['user'],'alice');self.assertEqual(found['ranAt'],__import__('services.storage.experiments',fromlist=['_iso'])._iso(self.now));self.assertIsNone(found['l2ScoresJson'])
        self.assertEqual(len(service.dispatch('derived_list',self.token,'w',{'kind':'issue','skill_id':'skill','task_id':'a'*32})),1)
        detail=service.dispatch('derived_detail',self.token,'w',{'id':'derived-one'});self.assertEqual(detail['skill']['name'],'Frozen Skill');self.assertEqual(detail['execution']['id'],'a'*32);self.assertEqual(len(detail['issues']),1);self.assertEqual(detail['provenance']['result_slot_id'],one['result_id'])
        self.assertEqual(detail['trace_evidence']['execution']['id'],'a'*32)
        admin_detail=service.dispatch('derived_detail',self.admin,'w',{'id':'derived-one'});self.assertTrue(admin_detail['gold_redacted']);self.assertIsNone(admin_detail['trace_evidence']);self.assertIsNone(admin_detail['execution']['query'])
        service.dispatch('retry',self.token,'w',{'experiment_id':'exp','result_id':one['result_id'],'operation_key':'retry'})
        self.assertEqual(service.dispatch('derived_list',self.token,'w',{'kind':'evaluation'}),[])
        self.assertEqual(len(service.dispatch('derived_list',self.token,'w',{'kind':'issue','evaluation_id':'derived-one','include_historical':True})),1)
        self.assertEqual(service.dispatch('derived_detail',self.token,'w',{'id':'derived-one'})['evaluation']['id'],'derived-one')
        self.assertEqual(service.dispatch('derived_lookup',self.token,'w',{'kind':'evaluation','id':'derived-one'})['id'],'derived-one')
        with self.assertRaises(Forbidden):service.dispatch('derived_lookup',self.bob,'w',{'kind':'issue','id':'issue-one'})
        self.assertEqual(service.dispatch('derived_counts',self.token,'w',{'experiment_id':'exp'}),{'evaluations':1,'skill_issues':1})
        removed=service.dispatch('remove',self.token,'w',{'experiment_id':'exp','operation_key':'remove'})
        self.assertEqual(removed['deleted_evaluations'],1);self.assertEqual(removed['deleted_skill_issues'],1)
        with self.assertRaises(self.not_found()):service.dispatch('derived_lookup',self.token,'w',{'kind':'evaluation','id':'derived-one'})

    def test_unattested_derived_skill_scope_is_rejected_before_any_run(self):
        self.create()
        with self.assertRaises(Forbidden):self.start(config={'derived_skill_ids':['someone-elses-skill']})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],0)

    def test_ensure_lookup_reads_only_actor_owned_metadata_without_freezing_new_assets(self):
        self.create()
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('lookup cannot freeze or write')):
            found=self.call('ensure_lookup',name='实验',scope='',agent_name='',skill_name='')
        self.assertEqual(found['experiment']['id'],'exp')
        self.assertIsNone(self.service().dispatch('ensure_lookup',self.bob,'w',{'name':'实验','scope':'','agent_name':'','skill_name':''}))

    def test_subset_snapshot_does_not_claim_complete_global_coverage(self):
        self.create();snapshot=self.call('read',experiment_id='exp',case_ids=['case'])
        self.assertEqual(snapshot['coverage'],'subset')

    def test_groupadmin_frozen_sessions_mark_body_redacted_with_explicit_null(self):
        self.create();self.start()
        service=self.service();snapshot={'_owner_principal_id':'alice','experiment':{'cases':[]},'sessions':[{'taskId':'task','interactions':[{'role':'assistant'}],'langfuseTraceNodes':[{}]}]}
        result=service._redact(snapshot,'admin')
        self.assertIsNone(result['sessions'][0]['interactions']);self.assertIsNone(result['sessions'][0]['langfuseTraceNodes'])

    def test_cancel_target_uses_real_client_not_lease_worker(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='trace:lease')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'command'},operation_key='cp')
        result=self.call('cancel',experiment_id='exp',operation_key='cancel');target=json.loads(result['cancellation']['targetsJson'])[0]
        self.assertEqual(target['clientId'],'client');self.assertEqual(target['kind'],'ordinary');self.assertEqual(target['runId'],'command')
        attempt=result['experiment']['cases'][0]['traceAttempts'][0];self.assertEqual(attempt['workerId'],'client');self.assertEqual(attempt['runId'],one['run_id']);self.assertEqual(attempt['status'],'cancelled')

    def test_fi_cancellation_target_preserves_business_run_and_task(self):
        self.create();self.call('execute_start',experiment_id='exp',execution_request={'kind':'fi','targetWorkerId':'fi-client'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        one=self.call('claim',experiment_id='exp',phase='execute',worker_id='fi:lease')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'fi:business-run','fi_run_id':'business-run','fi_task_key':'task-key'},operation_key='cp')
        result=self.call('cancel',experiment_id='exp',operation_key='cancel');target=json.loads(result['cancellation']['targetsJson'])[0]
        self.assertEqual(target,{'kind':'fi','runId':'business-run','clientId':'fi-client','fiTaskKey':'task-key','confirmed':False})

    def test_cancel_omits_confirmed_old_command_after_replacement_and_orders_latest_attempt(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='lease1')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'old-command'},operation_key='old')
        self.now+=30001;two=self.call('claim',experiment_id='exp',phase='execute',worker_id='lease2')
        work=self.call('load_work',**self.handle(two));self.assertTrue(work['cleanup_required']);self.assertEqual(work['cleanup_target']['clientId'],'client')
        self.call('checkpoint',**self.handle(two),expected_revision='1',checkpoint={'command_id':'old-command','cleanup_confirmed':True},operation_key='clean')
        self.call('checkpoint',**self.handle(two),expected_revision='2',checkpoint={'command_id':'new-command'},operation_key='new')
        result=self.call('cancel',experiment_id='exp',operation_key='cancel');targets=json.loads(result['cancellation']['targetsJson'])
        self.assertEqual([row['runId'] for row in targets],['new-command'])
        self.assertEqual(result['experiment']['cases'][0]['traceAttempts'][0]['id'],two['attempt_id'])

    def test_draft_only_compensation_cannot_delete_started_experiment(self):
        self.create();self.start()
        with self.assertRaises(Conflict):self.call('remove',experiment_id='exp',draft_only=True,operation_key='compensate')
        self.assertEqual(self.call('read',experiment_id='exp')['experiment']['status'],'running')

    def test_pending_cancellations_list_survives_head_delete_and_respects_acl(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('checkpoint',**self.handle(one),expected_revision='1',checkpoint={'command_id':'command'},operation_key='cp')
        removed=self.call('remove',experiment_id='exp',operation_key='remove')
        rows=self.call('cancellations');self.assertEqual([row['id'] for row in rows],[removed['cancellation_id']])
        self.assertEqual(self.service().dispatch('cancellations',self.bob,'w',{}),[])

    def test_case_upsert_many_is_atomic_group_scoped_and_cannot_change_active_case_input(self):
        value=experiment();value['groups']=[{'id':'A','key':'A','variableValue':'first'},{'id':'B','key':'B','variableValue':'second'}];self.call('create',experiment=value,operation_key='create')
        with self.assertRaises((ValueError,Conflict)):
            self.call('case_upsert_many',experiment_id='exp',cases=[{'id':'left','groupId':'A','input':'left'},{'id':'right','groupId':'foreign','input':'right'}],operation_key='invalid')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_cases').fetchone()[0],1)
        self.start();one=self.claim()
        with self.assertRaises(Conflict):self.call('case_upsert_many',experiment_id='exp',cases=[{'id':'case','input':'changed'}],operation_key='active')
        body={'experiment_id':'exp','cases':[{'id':'left','groupId':'A','input':'left'},{'id':'right','groupId':'B','input':'right'}],'operation_key':'pair'}
        first=self.call('case_upsert_many',**body);self.assertEqual(first,self.call('case_upsert_many',**body));self.assertEqual(first['case_ids'],['left','right'])
        self.assertTrue(self.call('check_work',**self.handle(one))['active'])
        self.call('case_remove',experiment_id='exp',case_id='left',operation_key='remove-left')
        with self.assertRaises(Conflict):self.call('case_upsert_many',experiment_id='exp',cases=[{'id':'left','groupId':'A','input':'left'}],operation_key='deleted-default')
        skipped=self.call('case_upsert_many',experiment_id='exp',cases=[{'id':'left','groupId':'A','input':'left'},{'id':'right','groupId':'B','input':'right'}],skip_deleted=True,operation_key='rescan')
        self.assertEqual(skipped['case_ids'],['right']);self.assertEqual(skipped['skipped_deleted_ids'],['left'])

    def test_read_view_projects_all_legacy_scalar_defaults_from_schema(self):
        self.create();self.start();snapshot=self.call('read_view')['snapshots'][0];head=snapshot['experiment'];case=head['cases'][0];result=case['results'][0]
        for name in ('skillVersion','preset','skillContextJson','sourceExperimentId','optimizationRecordId'):self.assertIn(name,head)
        for name in ('executionId','taskId','datasetInput','evaluatorContextJson','groupId','faultInjectionType','fiTaskId','fiRunId','traceGenerationCommandId','traceGenerationError'):self.assertIn(name,case)
        self.assertIsNone(head['skillVersion']);self.assertIsNone(case['executionId']);self.assertIsNone(result['score'])

    def test_watch_create_records_actual_enable_time_and_empty_case_delete_tombstones_parent(self):
        value=experiment();value['watchMode']=True;first=self.call('create',experiment=value,operation_key='create')
        self.assertEqual(first['experiment']['watchEnabledAt'],first['experiment']['createdAt'])
        removed=self.call('case_remove',experiment_id='exp',case_id='case',operation_key='case-remove')
        self.assertTrue(removed['removed']);self.assertIsNotNone(removed['experiment']['deletedAt'])
        self.assertEqual(self.call('list'),[]);self.assertEqual(len(removed['experiment']['cancellations']),1)
        skill=experiment();skill.update(id='skill-exp',scope='skill-workbench');skill['cases'][0]['id']='skill-case'
        self.call('create',experiment=skill,operation_key='skill-create')
        kept=self.call('case_remove',experiment_id='skill-exp',case_id='skill-case',operation_key='skill-remove')
        self.assertFalse(kept.get('removed',False));self.assertIsNone(kept['experiment']['deletedAt'])

    def test_execution_retry_reservation_is_cas_on_previous_attempt_not_latest_head_revision(self):
        self.create();self.execution_start();one=self.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        self.call('execute_fail',**self.handle(one),error='failed',cleanup_confirmed=True,operation_key='fail')
        payload={'experiment_id':'exp','execution_request':{'workerId':'client'},'frozen_evaluators':{'judge':{'id':'judge'}},'force_new_trace':True,'retry_from_attempt_id':one['attempt_id']}
        self.call('execute_start',**payload,operation_key='reserve1')
        with self.assertRaises(Conflict):self.call('execute_start',**payload,operation_key='reserve2')


    def test_two_case_reviews_publish_without_waiting_on_each_others_publication(self):
        value=experiment();value['cases'].append({**value['cases'][0],'id':'case2'})
        self.call('create',experiment=value,operation_key='create');self.start();handles=[]
        for index in range(2):
            handle=self.claim();handles.append(handle)
            self.call('complete',**self.handle(handle),result={'score':80},operation_key='complete:'+str(index))
        class Sink:
            def __init__(self):self.metrics=[];self.members=[]
            def _insert(self,table,rows):
                if table=='eval_metric_facts':self.metrics.extend(rows)
                if table=='eval_publication_members':self.members.extend(rows)
        sink=Sink();store=self.service()
        for _ in range(20):store.project_once(sink,'worker');self.now+=1000
        for index,handle in enumerate(handles):
            self.call('review',experiment_id='exp',result_id=handle['result_id'],human_score=70+index,human_reason='verified',operation_key='review:'+str(index))
        for _ in range(200):store.project_once(sink,'worker');self.now+=1000
        with self.control.read_transaction() as con:
            rows=con.execute("SELECT state FROM outbox_events WHERE aggregate_id IN (SELECT annotation_id FROM experiment_annotations WHERE kind='review')").fetchall()
        self.assertEqual([row[0] for row in rows],['sent','sent'])
        self.assertEqual(len([row for row in sink.metrics if row['metric_key']=='human_score']),2)
        self.assertEqual({row['review_decision_id'] for row in sink.members[-2:]},{row['dimension_key'] for row in sink.metrics if row['metric_key']=='human_score'})


    def test_cancellation_route_metadata_preserves_ordinary_capabilities_without_private_payloads(self):
        self.create();token=self.iam.issue_api_credential(self.token,'w',['read','write','execute']);store=self.service()
        self.assertEqual(store.dispatch('cancellation_route',token,'w',{'experiment_id':'exp','mode':'cancel'}),{'kind':'ordinary'})
        with self.assertRaises(Forbidden):store.dispatch('cancellation_route',token,'w',{'experiment_id':'exp','mode':'remove'})
        cancelled=store.dispatch('cancel',token,'w',{'experiment_id':'exp','operation_key':'cancel'})['cancellation']
        self.assertEqual(store.dispatch('cancellation_route',token,'w',{'cancellation_id':cancelled['id']}),{'kind':'ordinary'})
        with self.assertRaises(Forbidden):store.dispatch('cancellation_route',self.bob,'w',{'experiment_id':'exp','mode':'cancel'})


    def test_unconfirmed_evaluator_cleanup_is_retained_in_the_real_failed_receipt(self):
        self.create();self.start();handle=self.claim();self.call('fail',**self.handle(handle),error={'code':'EVALUATION_CLEANUP_UNCONFIRMED','message':'process cleanup not confirmed'},operation_key='failed-unknown-cleanup')
        with self.control.read_transaction() as con:
            attempt=con.execute('SELECT error_code FROM work_attempts WHERE attempt_id=?',(handle['attempt_id'],)).fetchone()[0];receipt=con.execute('SELECT content_hash,artifact_ref FROM result_receipts WHERE attempt_id=?',(handle['attempt_id'],)).fetchone()
        self.assertEqual(attempt,'EVALUATION_CLEANUP_UNCONFIRMED');result=self.service()._load(receipt['content_hash'],receipt['artifact_ref'])['result'];self.assertEqual(result['status'],'failed');self.assertTrue(result['cleanupUnconfirmed']);self.assertIsNone(result['score'])
