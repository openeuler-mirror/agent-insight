import copy
import json
import unittest
from unittest.mock import patch
from services.storage.tests import test_collector_preparations as preparation_tests
from services.storage.control import Conflict
from services.storage.collector_sources import CollectorSourcePending


class CollectorGraphTests(unittest.TestCase):
    def setUp(self):
        self.prep=preparation_tests.CollectorPreparationTests('runTest');self.prep.setUp();self.addCleanup(self.prep.doCleanups)
        self.fixture=self.prep.fixture;self.control=self.prep.control;self.api=self.prep.api;self.ingest=self.prep.ingest
    def service(self):return self.prep.service()
    def ref(self,entry):return {key:entry[key] for key in ('scope_kind','scope_key','operation_key')}
    def child(self,task='child',parent='execution'):
        value=self.fixture.snapshot();value['execution'].update(id=parent+'__sub__'+task,taskId=task,isSubagent=True,parentExecutionId=parent,rootExecutionId='execution',user='legacy-alice',clientId=None)
        value['session'].update(taskId=task,user='legacy-alice');return value
    def graph_capture(self,entry,children=(),thread=None,sweep=True):
        self.assertTrue(callable(getattr(self.service(),'capture_graph_context',None)),'typed graph context is required before sealing')
        context=self.service().capture_graph_context(self.api,'w',{**self.ref(entry),'context_hash':entry['context_hash'],'children':[{'execution_id':child['execution']['id'],'task_id':child['execution']['taskId']} for child in children],'thread':thread,'sweep':entry['scope_kind']=='source' and sweep})
        binding={key:entry['reservation'][key] for key in ('trace_id','task_id','execution_id','operation_key','input_hash','base_revision')}
        value={'version':1,'actor':{'principal':'alice','workspace':'w','username':'legacy-alice'},'binding':binding,'graph_context':context}
        return self.service().seal_capture(self.api,'w',{**self.ref(entry),'context_hash':entry['context_hash'],'capture_json':json.dumps(value,separators=(',',':'))})
    def graph_plan(self,entry,children=(),thread=None,sweep=True,snapshot=None):
        snapshot=copy.deepcopy(snapshot if snapshot is not None else self.fixture.snapshot());snapshot['execution'].update(user='legacy-alice',clientId=None);snapshot['session']['user']='legacy-alice'
        value={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':snapshot,'children':[{'snapshot':child,'skills':[],'serialized_session_json':json.dumps(child['session'],separators=(',',':'))} for child in children],'thread':thread,'root_skills':[],'retire_missing_children':sweep,'serialized_session_json':json.dumps(snapshot['session'],separators=(',',':'))}
        return self.service().seal_plan(self.api,'w',{**self.ref(entry),'capture_hash':entry['capture_hash'],'plan_json':json.dumps(value,separators=(',',':'))})
    def thread_plan(self,key='one',events=None):
        return {'thread':{'id':'thread-one','framework':'codex','sourceThreadId':'native-thread','user':'legacy-alice'},'create':{'framework':'codex','sourceThreadId':'native-thread','user':'legacy-alice','sourceKind':'codex-session','startedAt':None,'updatedAt':None,'metadataJson':'{"z":0,"a":null}'},'update':{},'events':events or [{'eventKey':'scoped:'+key,'kind':'turn','sourceTurnId':'turn-one','startedAt':'2026-11-17T00:00:00.000Z','payloadJson':'{"z":0,"a":null}'}]}
    def test_thread_only_applies_once_without_trace_or_fact(self):
        request={'reservation':{'operation':'thread_only','operation_key':'thread','source_thread_id':'native-thread','framework':'codex','legacy_username':'legacy-alice'},'operation_request_json':'{"data":{"threadOnly":true,"framework":"codex","traceThread":{"sourceThreadId":"native-thread"}}}'}
        entry=self.service().begin_preparation(self.api,'w',request);entry=self.graph_capture(entry,thread={'framework':'codex','source_thread_id':'native-thread'})
        value={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':None,'session':None,'children':[],'thread':self.thread_plan(),'serialized_session_json':'null'}
        entry=self.service().seal_plan(self.api,'w',{**self.ref(entry),'capture_hash':entry['capture_hash'],'plan_json':json.dumps(value)})
        self.assertEqual(self.prep.commit(entry)['source_state'],'indexed');self.prep.commit(entry)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],0);self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_threads').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_thread_events').fetchone()[0],1);self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_thread_executions').fetchone()[0],0)
            self.assertEqual(con.execute('SELECT metadata_json FROM collector_trace_threads').fetchone()[0],'{"z":0,"a":null}')
        self.assertEqual(self.fixture.facts.spans,{})
    def test_root_child_commit_has_one_atomic_indexed_vector_and_replay(self):
        child=self.child();entry=self.graph_plan(self.graph_capture(self.prep.begin(),[child]),[child]);accepted=self.prep.commit(entry);self.assertEqual(accepted['source_state'],'accepted')
        self.assertTrue(self.ingest.work_once('graph-root-only'))
        self.assertNotEqual(self.prep.status(entry)['source_state'],'indexed')
        with self.assertRaises(CollectorSourcePending):self.fixture.queries.summary(self.fixture.token,'w',entry['scope_key'])
        self.fixture.drain();self.assertEqual(self.prep.status(entry)['source_state'],'indexed')
        with self.control.read_transaction() as con:before=con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0]
        self.prep.commit(entry)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],before)
    def test_child_failure_rolls_back_root_thread_and_all_batches(self):
        child=self.child();child['execution']['user']='forged';entry=self.graph_plan(self.graph_capture(self.prep.begin(),[child]),[child],self.thread_plan())
        with self.assertRaises((Conflict,ValueError)):self.prep.commit(entry)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],0);self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_threads').fetchone()[0],0)
        self.assertEqual(self.prep.status(entry)['source_state'],'reserved')
    def test_sweep_retires_execution_and_keeps_original_child_session_and_artifact(self):
        child=self.child();first=self.graph_plan(self.graph_capture(self.prep.begin(),[child]),[child]);self.prep.commit(first);self.fixture.drain()
        with self.control.read_transaction() as con:trace=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE alias_kind='execution' AND alias_id=?",(child['execution']['id'],)).fetchone()[0]
        before=copy.deepcopy(child['session'])
        second=self.graph_plan(self.graph_capture(self.prep.begin('sweep',raw={'sweep':True})),[]);self.prep.commit(second);self.fixture.drain()
        with self.control.read_transaction() as con:
            _,_,state=self.service().sources._state(con,'w',trace);self.assertTrue(state['execution_retired']);self.assertIsNone(state['snapshot_ref']);self.assertEqual(self.ingest._load(state['session_ref']),before)
            self.assertIsNotNone(con.execute('SELECT 1 FROM trace_locators WHERE trace_id=?',(trace,)).fetchone())
        self.assertIsNone(self.fixture.queries.summary(self.fixture.token,'w',trace)['trace'])
    def test_child_public_preparation_cannot_adopt_root_reserved_derived_intent(self):
        child=self.child();entry=self.graph_capture(self.prep.begin(),[child])
        body=self.fixture.body('independent',task='child',execution=child['execution']['id'],raw={'data':{'task_id':'child','interactions':[]}})
        raw=body.pop('operation_request')
        with self.assertRaises(CollectorSourcePending):self.service().begin_preparation(self.api,'w',{'reservation':body,'operation_request_json':json.dumps(raw)})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_preparation_receipts').fetchone()[0],1)
        self.prep.commit(self.graph_plan(entry,[child]));self.fixture.drain()
        self.assertEqual(self.service().begin_preparation(self.api,'w',{'reservation':body,'operation_request_json':json.dumps(raw)})['reservation']['operation_key'],'independent')

    def test_capture_response_failure_rolls_back_new_child_reservation_and_capture_together(self):
        entry=self.prep.begin();service=self.service();context=service.capture_graph_context(self.api,'w',{**self.ref(entry),'context_hash':entry['context_hash'],'children':[{'execution_id':'execution__sub__child','task_id':'child'}],'thread':None,'sweep':True})
        binding={key:entry['reservation'][key] for key in ('trace_id','task_id','execution_id','operation_key','input_hash','base_revision')};capture={'version':1,'actor':{'principal':'alice','workspace':'w','username':'legacy-alice'},'binding':binding,'graph_context':context}
        with patch.object(service,'_persist_text',side_effect=RuntimeError('own fixture artifact failure')):
            with self.assertRaises(RuntimeError):service.seal_capture(self.api,'w',{**self.ref(entry),'context_hash':entry['context_hash'],'capture_json':json.dumps(capture)})
        with self.control.read_transaction() as con:self.assertIsNone(con.execute("SELECT 1 FROM trace_legacy_ids WHERE alias_kind='task' AND alias_id='child'").fetchone())
        self.assertIsNone(self.prep.status(entry)['capture_json'])

    def test_child_raw_session_representation_is_not_parent_session_and_old_ack_stays_indexed(self):
        child=self.child();child['session']['interactions']=[{'z':0,'a':None,'role':'assistant','content':'child order'}]
        first=self.graph_plan(self.graph_capture(self.prep.begin(),[child]),[child]);self.prep.commit(first);self.fixture.drain()
        entry=self.prep.begin('child-independent',task='child',execution=child['execution']['id'],raw={'data':{'task_id':'child'}})
        self.assertEqual(entry['prior_session_origin'],'node');self.assertEqual(entry['prior_session_json'],json.loads(first['plan_json'])['children'][0]['serialized_session_json'])
        self.assertNotEqual(entry['prior_session_json'],json.loads(first['plan_json'])['serialized_session_json'])
        entry=self.prep.plan(self.prep.capture(entry),child);self.prep.commit(entry);self.fixture.drain()
        self.assertEqual(self.prep.status(first)['source_state'],'indexed')

    def test_original_thread_member_and_later_source_turn_reconcile(self):
        thread=self.thread_plan();thread['events'][0].update(executionId='execution',payloadJson='{"relatedSourceExecutionId":"turn-two"}')
        first_snapshot=self.fixture.snapshot(framework='codex',traceThreadId='thread-one',sourceExecutionId='turn-one')
        first=self.graph_plan(self.graph_capture(self.prep.begin(framework='codex'),thread={'framework':'codex','source_thread_id':'native-thread'}),thread=thread,snapshot=first_snapshot)
        self.prep.commit(first);self.fixture.drain()
        other=self.fixture.snapshot(id='other-execution',taskId='other-task',framework='codex',traceThreadId='thread-one',sourceExecutionId='turn-two');other['session']['taskId']='other-task'
        later_thread=self.thread_plan('two',events=[{'eventKey':'scoped:two','kind':'turn','sourceTurnId':'turn-two','startedAt':'2026-11-17T00:00:01.000Z','payloadJson':'{"previousSourceExecutionId":"turn-one"}'}])
        later=self.graph_plan(self.graph_capture(self.prep.begin('other',task='other-task',execution='other-execution',framework='codex'),thread={'framework':'codex','source_thread_id':'native-thread'}),thread=later_thread,snapshot=other)
        self.prep.commit(later);self.fixture.drain()
        with self.control.read_transaction() as con:
            rows={row['event_key']:dict(row) for row in con.execute('SELECT * FROM collector_trace_thread_events')}
            self.assertEqual(rows['scoped:one']['execution_trace_id'],first['scope_key']);self.assertEqual(rows['scoped:one']['related_trace_id'],later['scope_key']);self.assertEqual(rows['scoped:two']['execution_trace_id'],later['scope_key'])
            self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_thread_executions').fetchone()[0],2)

    def test_thread_before_guard_has_event_reference_without_changing_old_root_membership(self):
        old=self.fixture.snapshot(framework='generic',traceThreadId=None)
        first=self.graph_plan(self.graph_capture(self.prep.begin(framework='generic')),snapshot=old);self.prep.commit(first);self.fixture.drain()
        thread=self.thread_plan();thread['thread']['framework']='generic';thread['create']['framework']='generic';thread['events'][0]['executionId']='execution'
        second=self.graph_plan(self.graph_capture(self.prep.begin('guard',framework='generic',raw={'smaller':True}),thread={'framework':'generic','source_thread_id':'native-thread'},sweep=False),thread=thread,sweep=False,snapshot=old)
        self.prep.commit(second);self.fixture.drain()
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT execution_trace_id FROM collector_trace_thread_events').fetchone()[0],first['scope_key']);self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_thread_executions').fetchone()[0],0)
            _,_,state=self.service().sources._state(con,'w',first['scope_key']);self.assertIsNone(self.ingest._load(state['snapshot_ref'])['execution']['traceThreadId'])

    def test_017_catalog_and_preserved_receipts(self):
        from pathlib import Path
        path=Path(__file__).parents[1]/'schema/collector-graph-catalog.json';self.assertTrue(path.is_file(),'017 Thread catalog is required');catalog=json.loads(path.read_text())
        with self.control.read_transaction() as con:
            self.assertIsNotNone(con.execute('SELECT version FROM schema_meta WHERE version=17').fetchone())
            for table in catalog['tables']:self.assertEqual([r['name'] for r in con.execute('PRAGMA table_info('+table['name']+')')],[r['name'] for r in table['columns']])
            self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])
