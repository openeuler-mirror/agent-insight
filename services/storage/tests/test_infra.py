import copy
import importlib
import json
import unittest
from services.storage.tests.test_collector_sources import CollectorSourceTests
from services.storage.iam import Forbidden
from services.storage.control import Conflict

class InfraFacts:
    def __init__(self):self.rows={};self.fail=False
    def write_infra_sample(self,row):
        if self.fail:raise RuntimeError('isolated sink failure')
        self.rows[(row['workspace_id'],row['sample_id'])]=copy.deepcopy(row)
    def read_infra_samples(self,workspace,source,*,limit=512,order='asc',model=None,via=None,from_ms=None,to_ms=None,after=None):
        rows=[copy.deepcopy(r) for (ws,_),r in self.rows.items() if ws==workspace and r['source_id']==source]
        rows=[r for r in rows if (from_ms is None or r['ts_ms']>=from_ms) and (to_ms is None or r['ts_ms']<=to_ms) and (not model or json.loads(r['sample_json'])['model']==model) and (not via or json.loads(r['sample_json'])['via']==via)]
        rows.sort(key=lambda r:(r['ts_ms'],r['sample_id']),reverse=order=='desc')
        if after:rows=[r for r in rows if ((r['ts_ms'],r['sample_id'])>(after['ts_ms'],after['sample_id']) if order=='asc' else (r['ts_ms'],r['sample_id'])<(after['ts_ms'],after['sample_id']))]
        return rows[:limit]

class InfraTests(unittest.TestCase):
    def setUp(self):
        self.fixture=CollectorSourceTests('runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.control=self.fixture.control;self.facts=InfraFacts();module=importlib.import_module('services.storage.infra');self.store=module.InfraStore(self.control,self.facts);self.token=self.fixture.token
    def source(self,**kw):return self.store.ensure_source(self.token,'w',{'endpoint':'http://fixture.invalid:8000','scrapeUrl':'http://fixture.invalid:8000/metrics',**kw})
    def raw(self,**kw):return json.dumps({'tsMs':0.25,'via':'push','model':None,'gauges':'{"zero":0}','counters':'{"total":0}','histograms':'{"h":{"buckets":[{"le":null,"count":0}],"sum":0,"count":0}}','waitingByReason':None,**kw},ensure_ascii=False,separators=(',',':'))
    def test_source_private_owner_admin_and_auth_patch_delete_reregister(self):
        src=self.source(scrapeIntervalMs=-1,authHeaders='{"Authorization":"fixture-secret"}');self.assertEqual(src['authHeaders'],'{"Authorization":"fixture-secret"}');self.assertEqual(src['scrapeIntervalMs'],-1)
        self.assertEqual(self.source()['authHeaders'],src['authHeaders']);self.assertEqual(self.store.patch_source(self.token,'w',src['id'],{'authHeaders':None})['authHeaders'],None)
        self.assertEqual(len(self.store.list_sources(self.fixture.tokens['admin'],'w')),1)
        self.assertEqual(self.store.list_sources(self.fixture.tokens['bob'],'w'),[])
        with self.assertRaises(Forbidden):self.store.get_source(self.fixture.tokens['bob'],'w',source_id=src['id'])
        with self.assertRaises(Forbidden):self.store.patch_source(self.fixture.tokens['admin'],'w',src['id'],{'enabled':False})
        self.assertEqual(self.store.delete_source(self.token,'w',source_id=src['id']),1);self.assertIsNone(self.store.get_source(self.token,'w',source_id=src['id']));self.assertNotEqual(self.source()['id'],src['id'])
    def test_samples_zero_fraction_null_histogram_distinct_accepts_and_lost_ack(self):
        src=self.source();raw=self.raw();one=self.store.accept_sample(self.token,'w',src['id'],'same',raw);self.assertEqual(self.store.accept_sample(self.token,'w',src['id'],'same',raw),one)
        with self.assertRaises(Conflict):self.store.accept_sample(self.token,'w',src['id'],'same',self.raw(model='changed'))
        self.store.accept_sample(self.token,'w',src['id'],'independent',raw);self.assertTrue(self.store.project_once('worker'));self.assertTrue(self.store.project_once('worker'));self.assertFalse(self.store.project_once('worker'))
        rows=self.store.query_samples(self.token,'w',src['id'],from_ms=0,to_ms=1)['rows'];self.assertEqual(len(rows),2);self.assertTrue(all(r['tsMs']==0.25 and r['histograms']==json.loads(raw)['histograms'] for r in rows))
        self.assertEqual(self.store.query_samples(self.token,'w',src['id'],via='push',limit=1,order='desc')['rows'][0]['tsMs'],0.25)
    def test_worker_failure_retains_receipt_then_retries_and_deleted_source_hides_facts(self):
        src=self.source();self.store.accept_sample(self.token,'w',src['id'],'one',self.raw(tsMs=0));self.facts.fail=True;self.assertFalse(self.store.project_once('worker'));self.facts.fail=False;self.fixture.now+=2000;self.assertTrue(self.store.project_once('worker'))
        self.store.delete_source(self.token,'w',source_id=src['id']);self.assertEqual(len(self.facts.rows),1)
        self.assertEqual(self.store.query_samples(self.token,'w',src['id'])['rows'],[])
    def test_links_replace_null_dedupe_and_invalid_source_roll_back(self):
        reserved=self.fixture.reserve();self.fixture.commit(reserved);self.fixture.drain();source=self.source()
        self.store.set_links(self.token,'w','execution',[{'sourceId':source['id'],'model':None},{'sourceId':source['id'],'model':None}]);self.assertEqual(self.store.get_links(self.token,'w','execution'),[{'sourceId':source['id'],'model':None}])
        with self.assertRaises(Forbidden):self.store.set_links(self.token,'w','execution',[{'sourceId':'missing','model':None}])
        self.assertEqual(len(self.store.get_links(self.token,'w','execution')),1);self.store.set_links(self.token,'w','execution',[]);self.assertEqual(self.store.get_links(self.token,'w','execution'),[])
    def test_readonly_capability_cannot_mutate_and_schema_is_append_only(self):
        read=self.fixture.iam.issue_api_credential(self.fixture.token,'w',['read']);src=self.source()
        with self.assertRaises(Forbidden):self.store.accept_sample(read,'w',src['id'],'one',self.raw())
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],18);self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_endpoint_metadata_reads_actual_capsule_with_source_boundary(self):
        from services.storage.infra import InfraStore
        from services.storage.trace_analytics import TraceAnalytics
        receipt=self.fixture.reserve();snapshot=self.fixture.snapshot();snapshot['execution']['endpoint']='http://actual-source.invalid/model-path';self.fixture.commit(receipt,snapshot);self.fixture.drain();trace=receipt['trace_id']
        analytics=TraceAnalytics(self.fixture.queries,self.fixture.authorized)
        with self.control.read_transaction() as con:boundary,_=analytics._boundary(con,self.token,'w',trace)
        store=InfraStore(self.control,self.facts,queries=self.fixture.queries,authorized=self.fixture.authorized);selection=[{'trace_id':trace,'boundary':boundary}]
        self.assertEqual(store.endpoints(self.token,'w',selection)[0]['endpoint'],snapshot['execution']['endpoint'])
        with self.assertRaises(Conflict):store.endpoints(self.token,'w',[{'trace_id':trace,'boundary':'a'*64}])
        with self.assertRaises(Forbidden):store.endpoints(self.fixture.tokens['bob'],'w',selection)

    def test_fact_content_without_matching_durable_acceptance_is_not_returned(self):
        from services.storage.control import StorageError
        src=self.source();self.store.accept_sample(self.token,'w',src['id'],'one',self.raw());self.store.project_once('worker');fact=next(iter(self.facts.rows.values()));fact['sample_json']=self.raw(model='forged')
        with self.assertRaises(StorageError):self.store.query_samples(self.token,'w',src['id'])

    def test_signed_fractional_sample_time_keeps_original_float_storage_semantics(self):
        src=self.source();self.store.accept_sample(self.token,'w',src['id'],'negative',self.raw(tsMs=-0.25));self.assertTrue(self.store.project_once('worker'));rows=self.store.query_samples(self.token,'w',src['id'],from_ms=-1,to_ms=0)['rows'];self.assertEqual(len(rows),1);self.assertEqual(rows[0]['tsMs'],-0.25)
