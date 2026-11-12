import os
import unittest
import uuid

from services.storage.clickhouse import ClickHouseStore, ClickHouseError, IncompletePayload


@unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'),'set explicit isolated ClickHouse test origin')
class ClickHouseIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store=ClickHouseStore(os.environ['STORAGE_TEST_CLICKHOUSE_URL'],database='storage_contract_'+uuid.uuid4().hex,
            user=os.environ.get('STORAGE_TEST_CLICKHOUSE_USER','default'),password=os.environ.get('STORAGE_TEST_CLICKHOUSE_PASSWORD',''))
        cls.store.initialize_new_database()

    @classmethod
    def tearDownClass(cls):
        cls.store._request(f'DROP DATABASE {cls.store.database}',database='default')

    def span(self, trace, span, version=1, **fields):
        return dict(workspace_id='w',trace_bucket='2026-11-11',trace_id=trace,span_id=span,revision=version,**fields)

    def test_complete_schema_installs(self):
        rows=self.store._request('SHOW TABLES FORMAT JSONEachRow')
        self.assertEqual(len(rows.splitlines()),13)

    def test_latest_state_precedes_status_filter_and_tenant_scope(self):
        trace=uuid.uuid4().hex
        self.store.write_spans([self.span(trace,'span',1,execution_status='failed',input_tokens=100)])
        self.store.write_spans([self.span(trace,'span',2,execution_status='done',input_tokens=150)])
        self.store.write_spans([self.span(trace,'span',1,execution_status='failed',input_tokens=100)])
        self.assertEqual(self.store.read_spans('w','2026-11-11',trace,status='failed'),[])
        row=self.store.read_span('w','2026-11-11',trace,'span')
        self.assertEqual(int(row['input_tokens']),150)
        self.assertIsNone(self.store.read_span('other','2026-11-11',trace,'span'))
        self.store.write_spans([self.span(trace,'span',3,is_deleted=1)])
        self.assertIsNone(self.store.read_span('w','2026-11-11',trace,'span'))

    def test_bundle_single_span_partial_paging_and_unpublished_rejection(self):
        trace=uuid.uuid4().hex
        text='中文🙂'*70000
        manifest=self.store.write_payload_bundle('w','2026-11-11',trace,'span',{'input':text,'output':'answer'})
        self.store.write_spans([self.span(trace,'span',payload_revision=manifest['payload_revision'])])
        root=self.store.read_span('w','2026-11-11',trace,'span')['payload_revision']
        result=self.store.read_payload('w','2026-11-11',trace,'span',root,'input',limit=1)
        self.assertFalse(result['complete'])
        body=''.join(r['body'] for r in result['chunks'])
        while result['next_chunk'] is not None:
            result=self.store.read_payload('w','2026-11-11',trace,'span',root,'input',after_chunk=result['next_chunk'],limit=1)
            body+=''.join(r['body'] for r in result['chunks'])
        self.assertEqual(body,text)
        self.assertEqual(self.store.read_payload('w','2026-11-11',trace,'span',root,'output')['chunks'][0]['body'],'answer')
        with self.assertRaises(IncompletePayload): self.store.read_payload('other','2026-11-11',trace,'span',root,'output')
        with self.assertRaises(IncompletePayload): self.store.read_payload('w','2026-11-11',trace,'span','0'*64,'input')

    def test_ten_thousand_spans_are_paged_and_single_node_is_selective(self):
        trace=uuid.uuid4().hex
        for start in range(0,10000,1000):
            self.store.write_spans([self.span(trace,f'{i:05d}',model='fixture',input_tokens=1) for i in range(start,start+1000)])
        page=self.store.read_spans('w','2026-11-11',trace,limit=200)
        self.assertEqual(len(page),200)
        self.assertEqual(page[0]['span_id'],'00000')
        self.assertEqual(self.store.read_span('w','2026-11-11',trace,'09999')['span_id'],'09999')
        next_page=self.store.read_spans('w','2026-11-11',trace,after_span_id=page[-1]['span_id'],limit=200)
        self.assertEqual(next_page[0]['span_id'],'00200')

    def test_revision_range_is_enforced_on_actual_engine(self):
        with self.assertRaises(ClickHouseError):
            self.store._insert('obs_span_current',[self.span(uuid.uuid4().hex,'s',2**63)])

    def test_analytics_preserves_unknown_mixed_and_real_zero_token_coverage(self):
        trace=uuid.uuid4().hex
        self.store.write_spans([self.span(trace,'unknown')])
        totals=self.store.summarize_spans(['w'],'2026-11-11','2026-11-11',trace_ids={'w':[trace]})
        self.assertIsNone(totals['input_tokens'])
        self.assertEqual(totals['input_tokens_missing_count'],1)
        self.store.write_spans([self.span(trace,'zero',input_tokens=0)])
        totals=self.store.summarize_spans(['w'],'2026-11-11','2026-11-11',trace_ids={'w':[trace]})
        self.assertIsNone(totals['input_tokens'])
        self.assertEqual(totals['input_tokens_known_sum'],0)
        self.assertEqual(totals['input_tokens_missing_count'],1)
        self.store.write_spans([self.span(trace,'unknown',2,input_tokens=0)])
        totals=self.store.summarize_spans(['w'],'2026-11-11','2026-11-11',trace_ids={'w':[trace]})
        self.assertEqual(totals['input_tokens'],0)
        self.assertEqual(totals['input_tokens_missing_count'],0)
