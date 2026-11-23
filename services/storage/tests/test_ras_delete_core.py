import unittest
from services.storage.tests import test_trace_analytics as fixture
from services.storage.control import Conflict

class RasDeleteTests(unittest.TestCase):
    setUp=fixture.TraceAnalyticsTests.setUp
    make_control=fixture.TraceAnalyticsTests.make_control
    service=fixture.TraceAnalyticsTests.service
    prepare_source=fixture.TraceAnalyticsTests.prepare_source
    drain=fixture.TraceAnalyticsTests.drain
    def event(self,task='ras-only'):
        return {'id':'event-one','taskId':task,'type':'anomaly','deliveryId':'delivery-one','ts':'2026-11-17T00:00:00Z','payloadJson':'{}'}
    def test_ras_only_delete_preserves_receipt_and_rejects_late_ingest(self):
        service=self.service();service.ras_ingest(self.token,'w',[self.event()])
        self.assertEqual(service.ras_delete(self.token,'w',['ras-only']),{'taskIds':['ras-only'],'deleted':{'ras':1,'executions':0,'sessions':0}})
        self.assertEqual(service.ras_read(self.token,'w',['ras-only'])['events'],[])
        with self.assertRaises(Conflict):service.ras_ingest(self.token,'w',[self.event()])
        self.assertEqual(service.ras_delete(self.token,'w',['ras-only'])['taskIds'],[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ras_event_receipts').fetchone()[0],1)
    def test_session_without_execution_is_hidden_and_counted_without_synthesizing_execution(self):
        from services.storage.collector_sources import CollectorSources
        source=CollectorSources(self.control,self.ingest)
        token=self.iam.issue_api_credential(self.token,'w',['read','write','delete'])
        receipt=source.reserve(token,'w',{'operation_key':'session-only','operation':'snapshot','operation_request':{},'task_id':'session-only','legacy_username':'alice','framework':'opencode'})
        with self.control.transaction() as con:
            _,_,state=source._state(con,'w',receipt['trace_id'])
            _,ref=self.ingest._persist({'taskId':'session-only','interactions':[],'startTime':'2026-11-17T00:00:00Z','endTime':None})
            state['session_ref']=ref;source._write(con,'w',receipt['trace_id'],state)
        result=self.service().ras_delete(token,'w',['session-only'])
        self.assertEqual(result['deleted'],{'ras':0,'executions':0,'sessions':1})
        with self.assertRaises(Conflict):source.reserve(token,'w',{'operation_key':'late','operation':'snapshot','operation_request':{},'task_id':'session-only','legacy_username':'alice','framework':'opencode'})
    def test_ras_only_delete_blocks_first_late_collector_reservation(self):
        from services.storage.collector_sources import CollectorSources
        self.service().ras_ingest(self.token,'w',[self.event()]);self.service().ras_delete(self.token,'w',['ras-only'])
        token=self.iam.issue_api_credential(self.token,'w',['read','write','delete'])
        with self.assertRaises(Conflict):CollectorSources(self.control,self.ingest).reserve(token,'w',{'operation_key':'late','operation':'snapshot','operation_request':{},'task_id':'ras-only','legacy_username':'alice','framework':'opencode'})
    def test_delete_foreign_task_is_empty_and_trace_delete_hides_ras(self):
        trace=self.prepare_source();service=self.service();service.ras_ingest(self.token,'w',[self.event('task')])
        result=service.ras_delete(self.token,'w',['task'])
        self.assertEqual(result['deleted'],{'ras':1,'executions':1,'sessions':1})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM trace_locators WHERE trace_id=?',(trace,)).fetchone()[0],'deleting')
        with self.assertRaises(Conflict):service.ras_ingest(self.token,'w',[self.event('task')])
if __name__=='__main__':unittest.main()
