import tempfile
import unittest
from pathlib import Path
from services.storage.control import SQLiteControlStore, Conflict
from services.storage.iam import IAMStore, Forbidden

class FaultInjectionCoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1794441600000
        self.control=SQLiteControlStore(Path(self.tmp.name)/'control.db',clock=lambda:self.now);self.control.initialize()
        self.iam=IAMStore(self.control)
        for name in ('alice','bob'):self.iam.create_principal(name,name,name)
        self.control.create_workspace('w','W');self.iam.bind_workspace('w',principal_id='alice')
        self.token=self.iam.issue_session_for_provisioning('alice');self.bob=self.iam.issue_session_for_provisioning('bob')
    def service(self):
        from services.storage.fault_injection import FaultInjection
        return FaultInjection(self.control)
    def call(self,action,payload=None):return self.service().dispatch(self.token,'w',action,payload or {},username='alice')
    def create(self):
        return self.call('create',{'task':{'id':'task-id','taskKey':'task-01234567','name':'T','status':'queued','platform':'opencode','agent':'main','prompt':'p','workspace':'__default__','user':'alice','itemsJson':'[{"run_id":"ras-20261117T000000","fault":"f"}]'},'runs':[{'id':'run-id','runId':'ras-20261117T000000','fiTaskId':'task-id','platform':'opencode','agent':'main','fault':'f','user':'alice','status':'queued','requestJson':'{}'}]})
    def test_claim_is_exclusive_and_stale_result_cannot_overwrite_reclaim(self):
        self.create();self.call('heartbeat',{'workerId':'worker-a','inventory':{'activeRunIds':[]}})
        first=self.call('claim',{'workerId':'worker-a','limit':1})['runs'][0]
        self.assertEqual(self.call('claim',{'workerId':'worker-a','limit':1})['runs'],[])
        self.now+=301000;self.call('sweep',{'claimTimeoutMs':300000});self.call('heartbeat',{'workerId':'worker-a'})
        second=self.call('claim',{'workerId':'worker-a','limit':1})['runs'][0]
        self.assertNotEqual(first['claimToken'],second['claimToken'])
        with self.assertRaises(Conflict):self.call('collect',{'runId':first['runId'],'data':{'status':'completed'}})
        with self.assertRaises(Conflict):self.call('collect',{'runId':first['runId'],'workerId':'worker-a','claimToken':first['claimToken'],'data':{'status':'completed','sessionTaskId':'business'}})
        self.assertEqual(self.call('read_run',{'runKey':first['runId']})['run']['status'],'collecting')
    def test_stop_and_delete_fence_late_collection_and_preserve_owner(self):
        self.create();self.call('heartbeat',{'workerId':'worker-a'});claim=self.call('claim',{'workerId':'worker-a'})['runs'][0]
        self.call('stop',{'taskIds':['task-id']})
        updated=self.call('collect',{'runId':claim['runId'],'workerId':'worker-a','claimToken':claim['claimToken'],'data':{'status':'completed','sessionTaskId':'business'}})['run']
        self.assertEqual(updated['status'],'stopped');self.assertTrue(updated['stopRequested'])
        self.assertEqual(self.call('delete',{'taskIds':['task-id']})['deleted'],1)
        with self.assertRaises((Conflict,Forbidden)):self.call('collect',{'runId':claim['runId'],'workerId':'worker-a','claimToken':claim['claimToken'],'data':{'status':'completed'}})
        with self.assertRaises(Forbidden):self.service().dispatch(self.bob,'w','read_tasks',{},username='bob')
    def test_legacy_first_claim_without_new_token_still_collects(self):
        self.create();self.call('heartbeat',{'workerId':'old-worker'});claim=self.call('claim',{'workerId':'old-worker'})['runs'][0]
        result=self.call('collect',{'runId':claim['runId'],'data':{'status':'completed','sessionTaskId':'business'}})
        self.assertEqual(result['run']['status'],'completed')
    def test_experiment_publication_rechecks_fi_source_stop_task_and_session(self):
        self.create();self.call('heartbeat',{'workerId':'worker-a'});claim=self.call('claim',{'workerId':'worker-a'})['runs'][0]
        self.call('collect',{'runId':claim['runId'],'workerId':'worker-a','claimToken':claim['claimToken'],'data':{'status':'completed','sessionTaskId':'business'}})
        service=self.service();checkpoint={'fi_run_id':claim['runId'],'command_id':'fi:'+claim['runId']}
        with self.control.read_transaction() as con:
            self.assertEqual(service.assert_completion(con,'w','alice',claim['runId'],'task-id','business',checkpoint)['status'],'completed')
            with self.assertRaises(Conflict):service.assert_completion(con,'w','alice',claim['runId'],'different-task','business',checkpoint)
            with self.assertRaises(Conflict):service.assert_completion(con,'w','alice',claim['runId'],'task-id','different-session',checkpoint)
            with self.assertRaises(Conflict):service.assert_completion(con,'w','bob',claim['runId'],'task-id','business',checkpoint)
        self.call('delete',{'taskIds':['task-id']})
        with self.control.read_transaction() as con:
            with self.assertRaises(Conflict):service.assert_completion(con,'w','alice',claim['runId'],'task-id','business',checkpoint)
    def test_task_and_run_business_ids_cannot_be_reused_across_owners_or_after_delete(self):
        saved=self.create();self.call('delete',{'taskIds':['task-id']})
        with self.assertRaises(Conflict):self.create()
        self.control.create_workspace('b','B');self.iam.bind_workspace('b',principal_id='bob')
        task={**saved['task'],'id':'other-task','user':'bob'}
        runs=[{**saved['runs'][0],'id':'other-run','fiTaskId':'other-task','user':'bob'}]
        with self.assertRaises(Conflict):self.service().dispatch(self.bob,'b','create',{'task':task,'runs':runs},username='bob')
    def test_worker_identity_cannot_be_taken_by_another_owner(self):
        self.call('heartbeat',{'workerId':'shared'})
        self.control.create_workspace('b','B');self.iam.bind_workspace('b',principal_id='bob')
        with self.assertRaises(Conflict):self.service().dispatch(self.bob,'b','heartbeat',{'workerId':'shared'},username='bob')
if __name__=='__main__':unittest.main()
