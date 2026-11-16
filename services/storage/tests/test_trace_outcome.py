import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.experiments import ExperimentStore, _hash
from services.storage.iam import Forbidden
from services.storage.tests import test_datasets as dataset_fixture
from services.storage.trace_metadata import TraceMetadata


class OutcomeTests(unittest.TestCase):
    make_control=dataset_fixture.DatasetTests.make_control
    setUp=dataset_fixture.DatasetTests.setUp

    def prepare(self):
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','trace','test','native','2026-11-16',0,0)")
            self.iam._record_resource(con,'w','trace','trace','alice','private',invalidate_policy=False)
        TraceMetadata(self.control).register_aliases_for_provisioning('w','trace',task_id='task',execution_id='execution')
        owner=self
        class Evidence:
            def read(self,*_,**__):
                with owner.control.read_transaction() as con:
                    ann=con.execute("SELECT * FROM trace_annotations WHERE workspace_id='w' AND trace_id='trace'").fetchone()
                    route=con.execute("SELECT * FROM trace_locators WHERE workspace_id='w' AND trace_id='trace'").fetchone()
                execution={'id':'execution','taskId':'task','user':'alice','query':ann['query_override'] if ann and ann['query_override'] is not None else 'Question','finalResult':ann['final_result_override'] if ann else 'Original','framework':'test'}
                session=None if getattr(owner,'no_session',False) else {'taskId':'task','user':'alice','interactions':[{'role':'user','content':'Question'}]}
                value={'format':'agent-insight.trace-evidence','version':1,'manifest':{'workspace_id':'w','trace_id':'trace','owner_principal_id':'alice','incarnation':str(route['incarnation']),'route_epoch':str(route['route_epoch']),'heads':[],'annotation_revision':str(ann['revision'] if ann else 0),'annotation_hash':_hash(dict(ann)) if ann else None,'aliases':{'task_id':'task','execution_id':'execution'},'execution_hash':_hash(execution),'session_hash':_hash(session)},'execution':execution,'session':session}
                value['snapshot_hash']=_hash(value);value['captured_at']='2026-11-16T00:00:00.000Z';return value
        return ExperimentStore(self.control,evidence=Evidence(),frozen_assets_verifier=lambda *_:True)

    def begin(self,service,key='begin',**changes):
        return service.dispatch('outcome_begin',self.token,'w',{'trace_ref':'task','operation_key':key,'config':{'core_outcome':{'version':1,'mode':'rejudge','criteria':{},'model_selection':None}},**changes})

    def test_begin_is_stable_idempotent_and_freezes_real_source(self):
        service=self.prepare();first=self.begin(service);again=self.begin(service)
        self.assertEqual(first,again)
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':first['experiment_id'],'worker_id':'worker'})
        work=service.dispatch('load_work',self.token,'w',handle)
        self.assertEqual(work['frozen_trace_evidence']['execution']['finalResult'],'Original')
        second=self.begin(service,'replace')
        self.assertEqual(second['experiment_id'],first['experiment_id']);self.assertNotEqual(second['run_id'],first['run_id'])
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'late','result':{'score':99}})
        self.assertEqual(service.dispatch('list_view',self.token,'w',{})['snapshots'],[])

    def test_final_result_and_schedule_rollback_together(self):
        service=self.prepare()
        with patch.object(service,'_start',side_effect=RuntimeError('freeze failed')):
            with self.assertRaises(RuntimeError):self.begin(service,final_result='edited',config={'core_outcome':{'version':1,'mode':'edited-final-result','criteria':None,'model_selection':None}})
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['revision'],0)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],0)
        result=self.begin(service,final_result='  edited  ',config={'core_outcome':{'version':1,'mode':'edited-final-result','criteria':None,'model_selection':None}})
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['final_result'],'edited')
        work=service.dispatch('runplan',self.token,'w',{'experiment_id':result['experiment_id']})['runplan']
        source=next(iter(work['frozen_trace_evidence'].values()))
        self.assertEqual(source['execution']['finalResult'],'edited');self.assertEqual(source['manifest']['annotation_revision'],'1')
        self.assertEqual(source['snapshot_hash'],_hash({k:v for k,v in source.items() if k not in {'captured_at','snapshot_hash'}}))

    def test_other_owner_admin_and_readonly_cannot_begin_or_cancel(self):
        service=self.prepare();self.iam.share_resource(self.token,'w','trace','trace','bob')
        read=self.iam.issue_api_credential(self.token,'w',{'read'})
        for token in [self.bob,self.admin,read]:
            for action in ['outcome_begin','outcome_cancel']:
                with self.assertRaises(Forbidden):service.dispatch(action,token,'w',{'trace_ref':'task','operation_key':action,'config':{'core_outcome':{'version':1,'mode':'rejudge','criteria':{}}}})

    def test_lookup_keeps_last_success_by_generation_and_cancel_fences(self):
        service=self.prepare();self.now+=10000;first=self.begin(service)
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':first['experiment_id'],'worker_id':'worker'})
        work=service.dispatch('load_work',self.token,'w',handle);source=work['frozen_trace_evidence']
        outcome={'version':1,'source_snapshot_hash':source['snapshot_hash'],'answer_score':0,'is_answer_correct':False,'judgment_reason':'real zero','failures':[],'skill_issues':None}
        service.dispatch('complete',self.token,'w',{**handle,'operation_key':'complete','result':{'score':0,'evidence':{'json':{'coreOutcome':outcome}}}})
        lookup=lambda:service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(lookup()['outcome']['value']['answer_score'],0);self.assertFalse(lookup()['is_evaluating'])
        self.now+=500;second=self.begin(service,'next')
        self.assertTrue(lookup()['is_evaluating']);self.assertEqual(lookup()['outcome']['run_id'],first['run_id'])
        current=service.dispatch('claim',self.token,'w',{'experiment_id':first['experiment_id'],'worker_id':'next-worker'})
        result=service.dispatch('outcome_cancel',self.token,'w',{'trace_ref':'task','operation_key':'cancel'})
        self.assertTrue(result['cancelled']);self.assertEqual(result['runId'],second['run_id']);self.assertFalse(lookup()['is_evaluating'])
        self.assertEqual(lookup()['outcome']['value']['answer_score'],0)
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**current,'operation_key':'late','result':{'score':100}})

    def test_untrusted_begin_and_changed_operation_input_are_rejected(self):
        service=self.prepare()
        with patch.object(service,'frozen_assets_verifier',None):
            with self.assertRaises(Forbidden):self.begin(service)
        self.begin(service)
        with self.assertRaises(Conflict):self.begin(service,final_result='changed')

    def finish(self,service,started,score=0):
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'worker'})
        work=service.dispatch('load_work',self.token,'w',handle)
        value={'version':1,'source_snapshot_hash':work['frozen_trace_evidence']['snapshot_hash'],'answer_score':score,'is_answer_correct':False,'judgment_reason':'actual result','failures':[],'skill_issues':None}
        service.dispatch('complete',self.token,'w',{**handle,'operation_key':'complete-'+started['run_id'],'result':{'score':score*100 if score is not None else None,'evidence':{'json':{'coreOutcome':value}}}})
        return handle

    def test_success_lookup_is_lightweight_and_live_shared_scope_is_rechecked(self):
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        self.iam.share_resource(self.token,'w','trace','trace','bob')
        with patch.object(service,'_plan',side_effect=AssertionError('Outcome read must not load full RunPlan or Session')):
            own=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
            shared=service.dispatch('outcome_lookup',self.bob,'w',{'trace_ref':'task'})
            admin=service.dispatch('outcome_lookup',self.admin,'w',{'trace_ref':'task'})
        self.assertEqual(own,shared);self.assertEqual(own,admin);self.assertEqual(len(own['selection_hash']),64)
        self.assertEqual(own['outcome']['source']['trace_id'],'trace')
        self.iam.unshare_resource(self.token,'w','trace','trace','bob')
        with self.assertRaises(Forbidden):service.dispatch('outcome_lookup',self.bob,'w',{'trace_ref':'task'})

    def test_worker_restart_reuses_frozen_inputs_and_observed_model_checkpoint(self):
        service=self.prepare();started=self.begin(service,config={'core_outcome':{'version':1,'mode':'rejudge','criteria':{'root_causes':[{'content':'Frozen RC','weight':1}]}}})
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'worker'})
        calls={'0':{'request_hash':'a'*64,'state':'observed','response':{'choices':[{'message':{'content':'real response'}}]}}}
        service.dispatch('checkpoint',self.token,'w',{**handle,'expected_revision':handle['checkpoint_revision'],'checkpoint':{'_flow_model_calls':calls},'operation_key':'checkpoint'})
        self.now+=30001
        recovered=ExperimentStore(self.control,frozen_assets_verifier=lambda *_:True)
        next_handle=recovered.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'new-worker'})
        work=recovered.dispatch('load_work',self.token,'w',next_handle)
        self.assertNotEqual(handle['attempt_id'],next_handle['attempt_id'])
        self.assertEqual(work['checkpoint']['_flow_model_calls'],calls)
        self.assertEqual(work['runplan']['config']['core_outcome']['criteria']['root_causes'][0]['content'],'Frozen RC')
        self.assertEqual(work['frozen_trace_evidence']['execution']['finalResult'],'Original')

    def test_unknown_model_intent_is_not_claimed_again_after_restart(self):
        service=self.prepare();started=self.begin(service)
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'worker'})
        service.dispatch('checkpoint',self.token,'w',{**handle,'expected_revision':handle['checkpoint_revision'],'checkpoint':{'_flow_model_calls':{'0':{'request_hash':'a'*64,'state':'intent'}}},'operation_key':'checkpoint'})
        self.now+=30001;recovered=ExperimentStore(self.control)
        self.assertIsNone(recovered.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'new-worker'}))
        self.assertTrue(service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})['is_evaluating'])

    def test_result_marker_and_private_attestation_are_required(self):
        service=self.prepare();started=self.begin(service)
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'worker'})
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'fake','result':{'score':100}})
        with patch.object(service,'frozen_assets_verifier',None):
            with self.assertRaises(Forbidden):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'fake-private','result':{'score':0,'evidence':{'json':{'coreOutcome':{'version':1}}}}})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_sessionless_edit_and_null_outcome_are_preserved(self):
        service=self.prepare();self.no_session=True
        started=self.begin(service,final_result='',config={'core_outcome':{'version':1,'mode':'edited-final-result','criteria':None}})
        self.finish(service,started,None)
        lookup=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertIsNone(lookup['outcome']['value']['answer_score'])
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['final_result'],'')

    def test_exact_retry_bypasses_new_evidence_and_internal_head_cannot_be_forged(self):
        service=self.prepare();first=self.begin(service)
        with patch.object(service.evidence,'read',side_effect=AssertionError('No recapture after receipt')):
            self.assertEqual(self.begin(service),first)
        with self.assertRaises(Forbidden):service.dispatch('create',self.token,'w',{'operation_key':'forge','experiment':{'name':'x','scope':'trace-outcome'}})
        with self.assertRaises(Forbidden):service.dispatch('update',self.token,'w',{'operation_key':'rewrite','experiment_id':first['experiment_id'],'changes':{'scope':''}})

    def test_edit_freezes_current_previous_outcome_and_detects_selection_race(self):
        service=self.prepare();first=self.begin(service);self.finish(service,first)
        previous=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        prior={'selection_hash':previous['selection_hash'],'failures':previous['outcome']['value']['failures'],'skill_issues':previous['outcome']['value']['skill_issues']}
        manifest={'version':1,'mode':'edited-final-result','criteria':None,'previous_outcome_selection':previous['selection_hash'],'previous_outcome':prior}
        second=self.begin(service,'edit',final_result='edited',config={'core_outcome':manifest})
        work=service.dispatch('runplan',self.token,'w',{'experiment_id':second['experiment_id']})['runplan']
        self.assertEqual(work['config']['core_outcome']['previous_outcome'],prior)
        with self.assertRaises(Conflict):self.begin(service,'edit-stale',final_result='stale',config={'core_outcome':manifest})
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['final_result'],'edited')

    def test_record_projection_is_fenced_to_frozen_real_skill_snapshot(self):
        import copy
        service=self.prepare()
        template={'skills':['actual'],'invokedSkills':[{'name':'actual','version':None}],'skill':'actual','skill_version':None,'is_skill_correct':False,'skill_trigger_rate':None,'routing_evaluation':{'status':'missing'},'outcome_evaluation':{'status':'available','score':None,'is_correct':False,'reason':'Rejudged','skill_breakdown':[{'skill':'actual','score':None,'is_correct':False}]}}
        started=self.begin(service,config={'core_outcome':{'version':1,'mode':'rejudge','criteria':{},'record_projection':template}})
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':started['experiment_id'],'worker_id':'worker'})
        work=service.dispatch('load_work',self.token,'w',handle)
        correct=copy.deepcopy(template);correct['outcome_evaluation'].update(score=0,is_correct=False,reason='real zero');correct['outcome_evaluation']['skill_breakdown'][0].update(score=0,is_correct=False)
        value={'version':1,'source_snapshot_hash':work['frozen_trace_evidence']['snapshot_hash'],'answer_score':0,'is_answer_correct':False,'judgment_reason':'real zero','failures':[],'skill_issues':None,'record_projection':correct}
        wrong=copy.deepcopy(value);wrong['record_projection']['skill_version']=9
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'invent-version','result':{'score':0,'evidence':{'json':{'coreOutcome':wrong}}}})
        service.dispatch('complete',self.token,'w',{**handle,'operation_key':'real-projection','result':{'score':0,'evidence':{'json':{'coreOutcome':value}}}})
        selected=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(selected['outcome']['value']['record_projection'],correct)
        self.assertIsNone(selected['outcome']['value']['record_projection']['skill_version'])

    def query(self,service,value):
        from services.storage.trace_outcome import patch_query
        with self.control.transaction() as con:return patch_query(service,con,self.token,'w','trace',value)

    def test_query_without_outcome_clears_answer_without_creating_work(self):
        service=self.prepare();self.query(service,'  New question  ')
        selected=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertIsNone(selected['outcome']);self.assertFalse(selected['is_evaluating']);self.assertEqual(selected['answer_reset']['through_generation'],0)
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['query'],'New question')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM work_items').fetchone()[0],0)

    def test_query_reset_cancels_old_attempt_retains_failure_and_next_generation_restores_answer(self):
        service=self.prepare();first=self.begin(service);self.finish(service,first)
        pending=self.begin(service,'pending');handle=service.dispatch('claim',self.token,'w',{'experiment_id':pending['experiment_id'],'worker_id':'pending'})
        before=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.query(service,'New question')
        reset=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertFalse(reset['is_evaluating']);self.assertEqual(reset['answer_reset']['through_generation'],2)
        self.assertEqual(reset['outcome']['value']['failures'],before['outcome']['value']['failures'])
        self.assertNotEqual(reset['selection_hash'],before['selection_hash'])
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'late','result':{'score':100}})
        next_run=self.begin(service,'new-question');self.finish(service,next_run,0.5)
        restored=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertNotIn('answer_reset',restored);self.assertEqual(restored['outcome']['value']['answer_score'],0.5)
        self.assertEqual(restored['outcome']['generation'],3)

    def test_query_annotation_and_cancel_fence_roll_back_together(self):
        service=self.prepare();pending=self.begin(service)
        handle=service.dispatch('claim',self.token,'w',{'experiment_id':pending['experiment_id'],'worker_id':'worker'})
        with patch.object(TraceMetadata,'_patch',side_effect=RuntimeError('annotation write failed')):
            with self.assertRaises(RuntimeError):self.query(service,'New question')
        self.assertEqual(service.dispatch('check_work',self.token,'w',handle),{'active':True})
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['revision'],0)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_annotations').fetchone()[0],0)

    def prepared_query(self,service,key='query',value='New question',projection=None):
        evidence=service.evidence.read(self.token,'w',trace_ref='task')
        previous=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        projection=projection or {'is_skill_correct':False,'skill_trigger_rate':0,'routing_evaluation':{'status':'available','matched_config_id':'B','is_correct':False,'trigger_rate':0},'outcome_evaluation':{'status':'pending','score':None,'is_correct':None,'reason':'结果评估中...'}}
        return {'trace_ref':'task','query':value,'source_snapshot_hash':evidence['snapshot_hash'],'previous_outcome_selection':previous['selection_hash'],'query_projection':projection,'operation_key':key,'operation_request':{'method':'PATCH','path':'/api/observe/data','body':{'task_id':'task','query':value}}}

    def test_private_query_projection_is_durable_without_a_run_and_exact_retry_precedes_new_source(self):
        service=self.prepare();body=self.prepared_query(service);first=service.dispatch('outcome_query',self.token,'w',body)
        lookup=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(lookup['answer_reset']['query_projection'],body['query_projection']);self.assertFalse(lookup['is_evaluating'])
        with patch.object(service.evidence,'read',side_effect=AssertionError('Committed query must not recapture latest source')):
            self.assertEqual(service.dispatch('outcome_query',self.token,'w',body),first)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_cases').fetchone()[0],1)
            for table in ('runs','work_items','experiment_result_slots'):self.assertEqual(con.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_operation_receipts WHERE operation_kind='outcome_query'").fetchone()[0],1)
        changed=dict(body);changed['operation_request']={'changed':True}
        with self.assertRaises(Conflict):service.dispatch('outcome_query',self.token,'w',changed)
        self.assertEqual(service.dispatch('list_view',self.token,'w',{})['snapshots'],[])

    def test_private_query_requires_attestation_owner_and_write_scope(self):
        service=self.prepare();body=self.prepared_query(service);self.iam.share_resource(self.token,'w','trace','trace','bob')
        read=self.iam.issue_api_credential(self.token,'w',{'read'})
        for token in [self.bob,self.admin,read]:
            with self.assertRaises(Forbidden):service.dispatch('outcome_query',token,'w',body)
        with patch.object(service,'frozen_assets_verifier',None):
            with self.assertRaises(Forbidden):service.dispatch('outcome_query',self.token,'w',body)
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['revision'],0)

    def test_query_snapshot_and_prior_selection_are_atomic_compare_and_swap(self):
        service=self.prepare();stale=self.prepared_query(service)
        TraceMetadata(self.control).patch(self.token,'w','trace',{'label':'Concurrent label'})
        with self.assertRaises(Conflict):service.dispatch('outcome_query',self.token,'w',stale)
        current=self.prepared_query(service,'selection-race');started=self.begin(service)
        with self.assertRaises(Conflict):service.dispatch('outcome_query',self.token,'w',current)
        self.assertTrue(service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})['is_evaluating'])
        self.assertIsNone(TraceMetadata(self.control).properties(self.token,'w','trace')['query'])

    def test_query_projection_receipt_rolls_back_cancel_annotation_and_first_head(self):
        service=self.prepare();body=self.prepared_query(service)
        with patch('services.storage.trace_outcome._receipt_result',side_effect=RuntimeError('Receipt unavailable')):
            with self.assertRaises(RuntimeError):service.dispatch('outcome_query',self.token,'w',body)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],0)
        pending=self.begin(service);handle=service.dispatch('claim',self.token,'w',{'experiment_id':pending['experiment_id'],'worker_id':'worker'})
        body=self.prepared_query(service,'active')
        with patch('services.storage.trace_outcome._receipt_result',side_effect=RuntimeError('Receipt unavailable')):
            with self.assertRaises(RuntimeError):service.dispatch('outcome_query',self.token,'w',body)
        self.assertEqual(service.dispatch('check_work',self.token,'w',handle),{'active':True})
        self.assertEqual(TraceMetadata(self.control).properties(self.token,'w','trace')['revision'],0)
        service.dispatch('outcome_query',self.token,'w',body)
        with self.assertRaises(Conflict):service.dispatch('complete',self.token,'w',{**handle,'operation_key':'late-query','result':{'score':100}})
        sealed=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(sealed['answer_reset']['query_projection']['skill_trigger_rate'],0)
        self.assertEqual(sealed['answer_reset']['query_projection']['routing_evaluation']['matched_config_id'],'B')

    def test_noop_cancel_receipt_does_not_cancel_a_later_run_on_response_loss_retry(self):
        service=self.prepare();cancel={'trace_ref':'task','operation_key':'cancel-before-any-run'}
        with patch.object(service.evidence,'read',side_effect=AssertionError('A no-op cancel must not read or invent Session evidence')):
            first=service.dispatch('outcome_cancel',self.token,'w',cancel)
        self.assertEqual(first,{'success':True,'cancelled':False})
        started=self.begin(service)
        replay=service.dispatch('outcome_cancel',self.token,'w',cancel)
        self.assertEqual(replay,first)
        lookup=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertTrue(lookup['is_evaluating']);self.assertEqual(lookup['run_id'],started['run_id'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_operation_receipts WHERE operation_kind='outcome_cancel'").fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_cases').fetchone()[0],1)
            self.assertEqual(con.execute("SELECT status FROM work_items").fetchone()[0],'queued')

    def test_noop_cancel_only_creates_its_safe_receipt_head_for_the_owner(self):
        service=self.prepare();self.iam.share_resource(self.token,'w','trace','trace','bob')
        readonly=self.iam.issue_api_credential(self.token,'w',{'read'})
        for token in [self.bob,self.admin,readonly]:
            with self.assertRaises(Forbidden):service.dispatch('outcome_cancel',token,'w',{'trace_ref':'task','operation_key':'cancel'})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],0)
        service.dispatch('outcome_cancel',self.token,'w',{'trace_ref':'task','operation_key':'cancel'})
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],1)
            for table in ('experiment_cases','runs','work_items','experiment_result_slots'):self.assertEqual(con.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)
        self.assertEqual(service.dispatch('list_view',self.token,'w',{})['snapshots'],[])

    def test_publication_delivery_progress_does_not_change_current_outcome_selection_hash(self):
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        snapshots=[]
        for state in ('accepted','indexed','published'):
            with self.control.transaction() as con:con.execute('UPDATE result_receipts SET state=?',(state,))
            snapshots.append(service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'}))
        self.assertEqual(snapshots[0]['outcome'],snapshots[1]['outcome']);self.assertEqual(snapshots[1]['outcome'],snapshots[2]['outcome'])
        self.assertEqual(snapshots[0]['selection_hash'],snapshots[1]['selection_hash']);self.assertEqual(snapshots[1]['selection_hash'],snapshots[2]['selection_hash'])

    def test_publication_progress_between_lookup_capture_and_postflight_preserves_real_result(self):
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        original=service._load;progressed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not progressed[0]:
                progressed[0]=True
                with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='published'")
            return value
        with patch.object(service,'_load',side_effect=load):selected=service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(selected['outcome']['value']['answer_score'],0)

    def test_quarantined_outcome_is_unavailable_before_and_during_postflight(self):
        from services.storage.experiments import ExperimentUnavailable
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='quarantined'")
        with self.assertRaises(ExperimentUnavailable) as denied:service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(denied.exception.status,503)
        with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='accepted'")
        original=service._load;changed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True
                with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='quarantined'")
            return value
        with patch.object(service,'_load',side_effect=load):
            with self.assertRaises(ExperimentUnavailable) as denied:service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})
        self.assertEqual(denied.exception.status,503)

    def test_outcome_content_hash_change_still_rejects_postflight(self):
        import copy
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        original=service._load;changed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True;new=copy.deepcopy(value);new['result']['evidence']['json']['other']='New artifact with the same Outcome DTO'
                digest,ref=service._put(new)
                with self.control.transaction() as con:con.execute('UPDATE result_receipts SET content_hash=?,artifact_ref=?',(digest,ref))
            return value
        with patch.object(service,'_load',side_effect=load):
            with self.assertRaises(Conflict):service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})

    def test_outcome_slot_revision_change_still_rejects_postflight(self):
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        original=service._load;changed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True
                with self.control.transaction() as con:con.execute('UPDATE experiment_result_slots SET revision=revision+1')
            return value
        with patch.object(service,'_load',side_effect=load):
            with self.assertRaises(Conflict):service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})

    def test_outcome_trace_source_lifecycle_change_still_rejects_postflight(self):
        service=self.prepare();started=self.begin(service);self.finish(service,started)
        original=service._load;changed=[False]
        def load(*args,**kwargs):
            value=original(*args,**kwargs)
            if not changed[0]:
                changed[0]=True
                with self.control.transaction() as con:con.execute('UPDATE trace_locators SET route_epoch=route_epoch+1')
            return value
        with patch.object(service,'_load',side_effect=load):
            with self.assertRaises(Conflict):service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task'})

    def test_write_preflight_uses_real_owner_and_credential_capabilities_without_mutating(self):
        service=self.prepare();self.iam.share_resource(self.token,'w','trace','trace','bob')
        readonly=self.iam.issue_api_credential(self.token,'w',{'read'})
        for token in (self.admin,self.bob,readonly):
            self.assertIsNone(service.dispatch('outcome_lookup',token,'w',{'trace_ref':'task'})['outcome'])
            with self.assertRaises(Forbidden):service.dispatch('outcome_lookup',token,'w',{'trace_ref':'task','require_write':True})
        with patch.object(service.evidence,'read',side_effect=AssertionError('Write preflight cannot read Session')):
            self.assertIsNone(service.dispatch('outcome_lookup',self.token,'w',{'trace_ref':'task','require_write':True})['outcome'])
        with self.control.read_transaction() as con:
            for table in ('experiment_heads','trace_annotations','runs','work_items'):self.assertEqual(con.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)


if __name__=='__main__':unittest.main()
