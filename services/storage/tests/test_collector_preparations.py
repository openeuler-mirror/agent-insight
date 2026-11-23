import copy
import hashlib
import importlib.util
import json
import unittest

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_collector_sources as source_tests


class CollectorPreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture=source_tests.CollectorSourceTests(methodName='runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        for name in ('control','iam','api','token','facts','ingest','metadata','queries'):setattr(self,name,getattr(self.fixture,name))

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.collector_preparations'),'durable collector preparation service required')
        from services.storage.collector_preparations import CollectorPreparations
        return CollectorPreparations(self.control,self.ingest)

    def begin(self,key='one',operation='snapshot',raw=None,**kwargs):
        body=self.fixture.body(key,operation=operation,raw=raw,**kwargs);request=body.pop('operation_request')
        return self.service().begin_preparation(self.api,'w',{'reservation':body,'operation_request_json':json.dumps(request,ensure_ascii=False,separators=(',',':'))})

    def capture(self,entry,version=0):
        reservation=entry['reservation'];binding={key:reservation[key] for key in ('trace_id','task_id','execution_id','operation_key','input_hash','base_revision')}
        value={'version':1,'actor':{'principal':'alice','workspace':'w','username':'legacy-alice'},'binding':binding,'skills':[{'name':'fixture','version':version}]}
        return self.service().seal_capture(self.api,'w',{'scope_kind':entry['scope_kind'],'scope_key':entry['scope_key'],'operation_key':entry['operation_key'],'context_hash':entry['context_hash'],'capture_json':json.dumps(value,ensure_ascii=False,separators=(',',':'))})

    def plan(self,entry,snapshot=None,session=None,**extra):
        capture=json.loads(entry['capture_json']);snapshot=copy.deepcopy(snapshot if snapshot is not None else self.fixture.snapshot())
        if snapshot is not None:
            snapshot['execution'].update(user='legacy-alice',clientId=None)
            if snapshot['session'] is not None:snapshot['session']['user']='legacy-alice'
        value={'binding':capture['binding'],'snapshot':snapshot,'children':[],'thread':None,'post_hooks':[],**extra}
        if session is not None:value['session']=session
        selected=value.get('session') if value.get('snapshot') is None else value['snapshot']['session']
        value['serialized_session_json']=json.dumps(selected,ensure_ascii=False,separators=(',',':'))
        return self.service().seal_plan(self.api,'w',{'scope_kind':entry['scope_kind'],'scope_key':entry['scope_key'],'operation_key':entry['operation_key'],'capture_hash':entry['capture_hash'],'plan_json':json.dumps(value,ensure_ascii=False,separators=(',',':'))})

    def commit(self,entry):return self.service().commit_prepared(self.api,'w',{'scope_kind':entry['scope_kind'],'scope_key':entry['scope_key'],'operation_key':entry['operation_key'],'plan_hash':entry['plan_hash']})
    def status(self,entry):return self.service().preparation_status(self.api,'w',{key:entry[key] for key in ('scope_kind','scope_key','operation_key')})

    def test_begin_preserves_first_representation_and_capture_across_restart(self):
        raw={'data':{'task_id':'task','interactions':[{'z':0,'a':None,'扩展':0.4}]}}
        first=self.begin(raw=raw);self.assertEqual(json.loads(first['operation_request_json']),raw)
        captured=self.capture(first);again=self.begin(raw={'data':{'interactions':[{'扩展':0.4,'a':None,'z':0}],'task_id':'task'}})
        self.assertEqual(again['operation_request_json'],first['operation_request_json']);self.assertEqual(again['capture_hash'],captured['capture_hash'])
        second=self.capture(again,version=2);self.assertEqual(second['capture_json'],captured['capture_json']);self.assertEqual(second['seal_revision'],2)
        self.assertNotIn(self.api,json.dumps(second));self.assertEqual(second['representation_origin'],'node')

    def test_root_commit_and_replay_use_actual_A_batch_state(self):
        planned=self.plan(self.capture(self.begin()));accepted=self.commit(planned)
        self.assertEqual(accepted['source_state'],'accepted');self.assertFalse(accepted['public_ready']);self.assertTrue(accepted['reservation']['batch_refs'])
        self.fixture.drain();done=self.status(planned);self.assertEqual(done['source_state'],'indexed')
        with self.control.read_transaction() as con:before=con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0]
        self.assertEqual(self.commit(planned)['source_state'],'indexed')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],before)

    def test_latest_applied_session_representation_is_bound_to_source_revision(self):
        snapshot=self.fixture.snapshot(items=[{'z':0,'a':None,'role':'user','content':'question'}]);snapshot['session']['user']='legacy-alice'
        planned=self.plan(self.capture(self.begin()),snapshot);self.commit(planned);self.fixture.drain()
        next_entry=self.begin('two',raw={'next':True});self.assertEqual(next_entry['prior_session_origin'],'node')
        self.assertEqual(next_entry['prior_session_json'],json.loads(planned['plan_json'])['serialized_session_json'])
        plain=self.fixture.service().reserve(self.api,'w',self.fixture.body('two',raw={'next':True}))
        with self.assertRaises(Conflict):self.fixture.service().commit(self.api,'w',{'task_id':'task','operation_key':'two','expected_revision':plain['base_revision'],'snapshot':self.fixture.snapshot()})

    def test_unprepared_later_write_cannot_reuse_older_serialized_session(self):
        planned=self.plan(self.capture(self.begin()),self.fixture.snapshot(items=[{'z':0,'a':None,'role':'user'}]));self.commit(planned);self.fixture.drain()
        raw=self.fixture.reserve('plain',raw={'plain':True});self.fixture.commit(raw);self.fixture.drain()
        next_entry=self.begin('new',raw={'new':True});self.assertEqual(next_entry['prior_session_origin'],'legacy_canonical')
        self.assertNotEqual(next_entry['prior_session_json'],json.loads(planned['plan_json'])['serialized_session_json'])

    def test_annotation_change_does_not_block_message_commit_or_clear_manual_override(self):
        entry=self.plan(self.capture(self.begin()))
        with self.control.transaction() as con:con.execute("UPDATE trace_annotations SET query_override='manual query',revision=revision+1 WHERE workspace_id='w' AND trace_id=?",(entry['reservation']['trace_id'],))
        self.commit(entry);self.fixture.drain()
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT query_override FROM trace_annotations WHERE workspace_id='w' AND trace_id=?",(entry['reservation']['trace_id'],)).fetchone()[0],'manual query')

    def test_complete_first_persists_empty_session_without_fake_fact(self):
        entry=self.capture(self.begin(operation='complete',completion_at_ms=1794873600000))
        first=entry['reservation'];session={'taskId':'task','label':'opencode','query':None,'user':'legacy-alice','model':None,'startTime':'2026-11-17T00:00:00.000Z','endTime':'2026-11-17T00:00:00.000Z','interactions':[]}
        plan={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':None,'session':session,'children':[],'thread':None,'serialized_session_json':json.dumps(session,separators=(',',':'))}
        entry=self.service().seal_plan(self.api,'w',{**{key:entry[key] for key in ('scope_kind','scope_key','operation_key','capture_hash')},'plan_json':json.dumps(plan,separators=(',',':'))});done=self.commit(entry)
        self.assertEqual(done['source_state'],'indexed');self.assertEqual(done['session'],session);self.assertIsNone(done['reservation']['snapshot']);self.assertEqual(self.facts.spans,{})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM obs_entity_heads').fetchone()[0],0)
        self.fixture.now+=1000;next_entry=self.begin('complete-two',operation='complete',completion_at_ms=1794873601000);self.assertEqual(json.loads(next_entry['prior_session_json'])['startTime'],session['startTime'])

    def test_child_or_thread_plan_is_pending_before_any_source_effect(self):
        from services.storage.collector_sources import CollectorSourcePending
        entry=self.plan(self.capture(self.begin()),children=[{'snapshot':self.fixture.snapshot()}])
        with self.assertRaises(CollectorSourcePending):self.commit(entry)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],0)

    def test_same_key_different_subject_is_independent_and_body_change_conflicts(self):
        self.begin()
        other=self.begin(task='other-task',execution='other-execution');self.assertNotEqual(other['scope_key'],self.begin()['scope_key'])
        with self.assertRaises(Conflict):self.begin(raw={'changed':True})

    def test_legacy_A_receipt_is_preserved_and_marked_canonical(self):
        legacy=self.fixture.reserve();self.fixture.commit(legacy);self.fixture.drain()
        with self.control.read_transaction() as con:before=con.execute('SELECT extra_json,revision FROM trace_annotations').fetchone()
        entry=self.begin()
        with self.control.read_transaction() as con:self.assertEqual(tuple(con.execute('SELECT extra_json,revision FROM trace_annotations').fetchone()),tuple(before))
        self.assertEqual(self.fixture.commit(legacy)['state'],'indexed')
        self.assertEqual(entry['source_state'],'indexed');self.assertEqual(entry['representation_origin'],'legacy_canonical');self.assertIsNone(entry['capture_json'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],1)

    def test_receipt_identity_and_sealed_slots_are_retained(self):
        entry=self.plan(self.capture(self.begin()))
        with self.assertRaises(Exception):
            with self.control.transaction() as con:con.execute('DELETE FROM collector_preparation_receipts')
        with self.assertRaises(Exception):
            with self.control.transaction() as con:con.execute("UPDATE collector_preparation_receipts SET plan_hash=?",('b'*64,))
        bob=self.iam.issue_api_credential(self.fixture.tokens['bob'],'w',['write'],ttl_ms=86400000)
        with self.assertRaises(Forbidden):self.service().preparation_status(bob,'w',{key:entry[key] for key in ('scope_kind','scope_key','operation_key')})

    def test_thread_only_is_durable_without_trace_locator(self):
        value={'reservation':{'operation':'thread_only','operation_key':'thread','source_thread_id':'native-thread','framework':'codex','legacy_username':'legacy-alice'},'operation_request_json':'{"data":{"threadOnly":true,"sourceThreadId":"native-thread"}}'}
        first=self.service().begin_preparation(self.api,'w',value)
        self.assertEqual(first['scope_kind'],'thread');self.assertIsNone(first['reservation']['trace_id'])
        self.assertEqual(self.service().begin_preparation(self.api,'w',value)['context_hash'],first['context_hash'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0],0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_preparation_receipts').fetchone()[0],1)

    def test_prepared_completion_cannot_bypass_first_plan(self):
        self.begin(operation='complete')
        with self.assertRaises(Conflict):self.fixture.service().complete(self.api,'w',self.fixture.body(operation='complete'))

    def test_representation_scalar_types_must_match(self):
        entry=self.capture(self.begin());plan={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':None,'session':{'value':True},'serialized_session_json':'{"value":1}'}
        with self.assertRaises(Conflict):self.service().seal_plan(self.api,'w',{**{key:entry[key] for key in ('scope_kind','scope_key','operation_key','capture_hash')},'plan_json':json.dumps(plan)})


    def test_completion_creates_session_for_existing_execution_without_replacing_it(self):
        legacy=self.fixture.reserve('execution-only');snapshot=self.fixture.snapshot();snapshot['session']=None;self.fixture.commit(legacy,snapshot);self.fixture.drain()
        entry=self.capture(self.begin('complete',operation='complete',completion_at_ms=self.fixture.now));previous=entry['reservation']['snapshot']
        session={'taskId':'task','label':'opencode','query':None,'user':'legacy-alice','model':None,'startTime':'2026-11-17T00:00:00.000Z','endTime':'2026-11-17T00:00:00.000Z','interactions':[]}
        entry=self.plan(entry,{'execution':previous['execution'],'session':session});self.commit(entry);self.fixture.drain()
        done=self.status(entry);self.assertEqual(done['session'],session)
        self.assertEqual(self.fixture.read(entry['scope_key'])['session']['interactions'],[])

    def test_016_catalog_and_constraints_match_initialized_sqlite(self):
        from pathlib import Path
        catalog=json.loads((Path(__file__).parents[1]/'schema/collector-preparation-catalog.json').read_text())['tables'][0]
        entry=self.begin()
        with self.control.read_transaction() as con:
            columns=con.execute('PRAGMA table_info(collector_preparation_receipts)').fetchall();self.assertEqual([row['name'] for row in columns],[row['name'] for row in catalog['columns']])
            known_catalogs=[json.loads(path.read_text()) for path in (Path(__file__).parents[1]/'schema').glob('*catalog.json') if path.name not in ('legacy-catalog.json','clickhouse-catalog.json','analytics-clickhouse-catalog.json')]
            expected={table['name'] for item in known_catalogs for table in item.get('tables',[])}
            actual={row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            self.assertEqual(actual,expected)
            self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])
            original=dict(con.execute('SELECT * FROM collector_preparation_receipts').fetchone())
        for changes in ({'scope_kind':'bad'},{'trace_id':None},{'input_text_hash':'G'*64},{'capture_hash':'a'*64},{'seal_revision':1.5},{'updated_at_ms':-1}):
            with self.subTest(changes=changes),self.assertRaises(Exception):
                value={**original,'operation_key':'invalid',**changes}
                with self.control.transaction() as con:con.execute('INSERT INTO collector_preparation_receipts('+','.join(value)+') VALUES('+','.join('?' for _ in value)+')',tuple(value.values()))


    def test_legacy_reserved_snapshot_is_taken_over_before_old_commit_can_bypass_plan(self):
        legacy=self.fixture.reserve();entry=self.plan(self.capture(self.begin()))
        self.assertEqual(entry['representation_origin'],'legacy_canonical')
        changed=self.fixture.snapshot(items=[{'role':'user','content':'unsealed replacement'}])
        with self.assertRaises(Conflict):self.fixture.commit(legacy,changed)
        self.commit(entry);self.fixture.drain()
        expected=json.loads(entry['plan_json'])['snapshot']['session']['interactions']
        self.assertEqual(self.status(entry)['session']['interactions'],expected)
        self.assertEqual([item.get('content') for item in self.fixture.read(entry['scope_key'])['session']['interactions']],[item.get('content') for item in expected])

    def test_legacy_reserved_completion_is_taken_over_and_empty_session_is_not_lost(self):
        self.fixture.reserve(operation='complete');entry=self.capture(self.begin(operation='complete'))
        session={'taskId':'task','label':'opencode','query':None,'user':'legacy-alice','model':None,'startTime':'2026-11-17T00:00:00.000Z','endTime':'2026-11-17T00:00:00.000Z','interactions':[]}
        plan={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':None,'session':session,'children':[],'thread':None,'serialized_session_json':json.dumps(session,separators=(',',':'))}
        entry=self.service().seal_plan(self.api,'w',{**{key:entry[key] for key in ('scope_kind','scope_key','operation_key','capture_hash')},'plan_json':json.dumps(plan,separators=(',',':'))})
        with self.assertRaises(Conflict):self.fixture.service().complete(self.api,'w',self.fixture.body(operation='complete'))
        self.assertEqual(self.commit(entry)['session'],session);self.assertEqual(self.facts.spans,{})

    def test_begin_resume_pending_takes_over_the_returned_legacy_operation(self):
        legacy=self.fixture.reserve('old');entry=self.begin('new',raw={'new':True})
        self.assertEqual(entry['operation_key'],'old');self.assertEqual(entry['representation_origin'],'legacy_canonical')
        with self.assertRaises(Conflict):self.fixture.commit(legacy)
        planned=self.plan(self.capture(entry));self.commit(planned);self.fixture.drain()
        self.assertEqual(self.begin('new',raw={'new':True})['operation_key'],'new')

    def test_existing_preparation_receipt_restores_missing_legacy_takeover_guard(self):
        self.fixture.reserve();entry=self.begin()
        with self.control.transaction() as con:
            source=self.fixture.service();_,_,state=source._state(con,'w',entry['scope_key'])
            from services.storage.collector_sources import _hash
            state['operations'][_hash('one')].pop('preparation_required',None);source._write(con,'w',entry['scope_key'],state)
        restored=self.begin();self.assertEqual(restored['context_hash'],entry['context_hash'])
        with self.assertRaises(Conflict):self.fixture.commit(self.fixture.reserve())

    def test_takeover_failure_rolls_back_guard_and_new_preparation_receipt_together(self):
        from unittest.mock import patch
        from services.storage.collector_preparations import CollectorPreparations
        legacy=self.fixture.reserve()
        with patch.object(CollectorPreparations,'_view',side_effect=RuntimeError('response interrupted before commit')):
            with self.assertRaises(RuntimeError):self.begin()
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_preparation_receipts').fetchone()[0],0)
        self.fixture.commit(legacy);self.fixture.drain()
        replay=self.begin();self.assertEqual(replay['source_state'],'indexed');self.assertEqual(replay['representation_origin'],'legacy_canonical')
        self.assertEqual(self.fixture.commit(legacy)['state'],'indexed')


class CollectorPreparationHTTPTests(unittest.TestCase):
    setUp=source_tests.CollectorSourceHTTPTests.setUp
    request=source_tests.CollectorSourceHTTPTests.request
    signed=source_tests.CollectorSourceHTTPTests.signed

    def test_preparation_is_private_and_round_trips_node_text(self):
        value={'action':'begin_preparation','reservation':{'operation':'complete','operation_key':'http-prepared','task_id':'prepared-task','execution_id':'prepared-execution','legacy_username':'legacy-alice','completion_at_ms':100000},'operation_request_json':'{"data":{"z":0,"a":null,"user":"forged"}}'}
        path='/v1/compat/collector-source?workspace_id=w'
        self.assertEqual(self.request(path,self.api,body=value)[0],403)
        self.assertEqual(self.signed(value,principal='bob')[0],403)
        status,result,_=self.signed(value);self.assertEqual(status,200);entry=result['value']
        self.assertEqual(entry['operation_request_json'],value['operation_request_json'])
        status,reply,_=self.signed({'action':'preparation_status',**{key:entry[key] for key in ('scope_kind','scope_key','operation_key')}})
        self.assertEqual(status,200);self.assertEqual(reply['value']['context_hash'],entry['context_hash'])
        self.assertNotIn(self.api,json.dumps(reply))
