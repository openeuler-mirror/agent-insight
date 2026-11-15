import json
import unittest
from services.storage.tests import test_experiments as fixture
from services.storage.control import Conflict
from services.storage.experiments import ExperimentNotFound

class WorkbenchExperimentCancellationTests(unittest.TestCase):
    make_control=fixture.ExperimentTests.make_control
    setUp=fixture.ExperimentTests.setUp
    service=fixture.ExperimentTests.service
    call=fixture.ExperimentTests.call
    def source(self):
        value=fixture.experiment();value['scope']='skill-workbench';value['configSnapshotJson']=json.dumps({'datasetId':'dataset','caseIds':['logical','planned']})
        first=value['cases'][0];first['id']='side-a';first['caseValuesJson']=json.dumps({'__agentInsightDatasetCase':{'datasetId':'dataset','caseId':'logical'}})
        value['cases'].append({**first,'id':'side-b'})
        return value
    def test_actual_case_delete_cancels_the_logical_dataset_case_and_both_sides_atomically(self):
        self.call('create',experiment=self.source(),operation_key='create')
        result=self.call('case_remove',experiment_id='exp',case_id='side-a',operation_key='delete')
        self.assertEqual(result['cancellation']['caseKey'],'dataset:logical');self.assertEqual(result['experiment']['cases'],[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_cases WHERE experiment_id='exp' AND state='deleted'").fetchone()[0],2)
    def test_planned_logical_case_delete_is_verified_without_fabricating_an_actual_case(self):
        self.call('create',experiment=self.source(),operation_key='create')
        result=self.call('case_remove',experiment_id='exp',case_id='dataset:planned',operation_key='planned-delete')
        self.assertEqual(result['cancellation']['caseKey'],'dataset:planned');self.assertEqual(len(result['experiment']['cases']),2)
        with self.assertRaises(ExperimentNotFound):self.call('case_remove',experiment_id='exp',case_id='dataset:forged',operation_key='forged-delete')
    def test_deleting_one_planned_case_does_not_cancel_other_unstarted_cases(self):
        value=self.source();value['cases']=[];self.call('create',experiment=value,operation_key='create')
        first=self.call('case_remove',experiment_id='exp',case_id='dataset:logical',operation_key='first-delete')
        self.assertNotEqual(first['experiment']['status'],'cancelled')
        second=self.call('case_remove',experiment_id='exp',case_id='dataset:planned',operation_key='second-delete')
        self.assertEqual(second['experiment']['status'],'cancelled')
    def test_logical_tombstone_blocks_a_new_case_identity_from_readding_deleted_data(self):
        self.call('create',experiment=self.source(),operation_key='create');self.call('case_remove',experiment_id='exp',case_id='side-a',operation_key='delete')
        value=self.source()['cases'][0]|{'id':'different-new-id'}
        with self.assertRaises(Conflict):self.call('case_upsert',experiment_id='exp',case=value,operation_key='rescan')
    def test_non_workbench_case_id_keeps_its_original_individual_scope(self):
        value=self.source();value['scope']='';self.call('create',experiment=value,operation_key='create')
        result=self.call('case_remove',experiment_id='exp',case_id='side-a',operation_key='delete')
        self.assertEqual(result['cancellation']['caseKey'],'side-a');self.assertEqual([row['id'] for row in result['experiment']['cases']],['side-b'])
    def test_logical_removal_keeps_both_real_external_client_targets(self):
        self.call('create',experiment=self.source(),operation_key='create')
        self.call('execute_start',experiment_id='exp',operation_key='execute',execution_request={'workerId':'real-client'},frozen_evaluators={'judge':{'id':'judge'}})
        for case in ('side-a','side-b'):
            claimed=self.call('claim',experiment_id='exp',phase='execute',case_id=case,worker_id='node-lease-'+case)
            handle=fixture.ExperimentTests.handle(claimed)
            self.call('checkpoint',**handle,expected_revision=claimed['checkpoint_revision'],checkpoint={'command_id':'cmd_'+case},operation_key='checkpoint-'+case)
        result=self.call('case_remove',experiment_id='exp',case_id='dataset:logical',operation_key='delete')
        targets=json.loads(result['cancellation']['targetsJson'])
        self.assertEqual({target['runId'] for target in targets},{'cmd_side-a','cmd_side-b'});self.assertEqual({target['clientId'] for target in targets},{'real-client'})
    def test_local_execution_target_is_derived_from_the_actual_attempt(self):
        self.call('create',experiment=self.source(),operation_key='create')
        self.call('execute_start',experiment_id='exp',operation_key='execute',execution_request={'kind':'local'},frozen_evaluators={'judge':{'id':'judge'}})
        claimed=self.call('claim',experiment_id='exp',phase='execute',case_id='side-a',worker_id='node-local')
        handle=fixture.ExperimentTests.handle(claimed)
        self.assertEqual(self.call('read',experiment_id='exp')['experiment']['cases'][0]['traceAttempts'][0]['kind'],'local')
        with self.assertRaises(Conflict):self.call('checkpoint',**handle,expected_revision=claimed['checkpoint_revision'],checkpoint={'command_id':'local:forged'},operation_key='forged-checkpoint')
        self.call('checkpoint',**handle,expected_revision=claimed['checkpoint_revision'],checkpoint={'command_id':'local:'+claimed['attempt_id']},operation_key='checkpoint')
        result=self.call('case_remove',experiment_id='exp',case_id='dataset:logical',operation_key='delete')
        self.assertEqual(json.loads(result['cancellation']['targetsJson']),[{'kind':'local','runId':claimed['attempt_id'],'clientId':None,'confirmed':False}])
    def test_trace_rebind_with_advancing_clock_keeps_slot_timestamps_monotonic(self):
        value=self.source();value['cases']=value['cases'][:1];self.call('create',experiment=value,operation_key='create')
        self.call('start',experiment_id='exp',frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','new-trace','otlp','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','new-trace','alice','private',invalidate_policy=False)
        def ticking():
            self.now+=1
            return self.now
        self.control.clock=ticking
        result=self.call('bind_trace',experiment_id='exp',case_id='side-a',task_id='new-trace',operation_key='bind')
        self.assertEqual(result['experiment']['cases'][0]['taskId'],'new-trace')
        self.assertEqual(result['experiment']['cases'][0]['results'][0]['status'],'pending')
