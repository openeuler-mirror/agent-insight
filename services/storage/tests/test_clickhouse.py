import importlib
import unittest
from unittest.mock import patch


class ClickHouseValidationTests(unittest.TestCase):
    def client(self):
        try:
            api = importlib.import_module('services.storage.clickhouse')
        except ModuleNotFoundError:
            self.fail('ClickHouse fact adapter must be implemented')
        return api, api.ClickHouseStore('http://127.0.0.1:8123', database='storage_test')

    def test_large_analytics_pages_use_bounded_subqueries_and_report_413_for_adaptive_paging(self):
        import json
        api,client=self.client();error=getattr(api,'ClickHouseResponseTooLarge',None)
        self.assertIsNotNone(error,'analytics page budgets must be distinguishable from transport failures')
        selections=[{'trace_id':'t'+str(index),'trace_bucket':'2026-11-12','boundary':'a'*64,'projection_hash':'b'*64} for index in range(200)]
        sizes=[]
        def response(sql,*,parameters):
            ids=[value for key,value in parameters.items() if key.startswith('trace_id_')]
            if 'AS analytics_bytes' in sql:return b'\n'.join(json.dumps({'trace_id':trace,'trace_bucket':'2026-11-12','boundary':'a'*64,'projection_hash':'b'*64,'analytics_bytes':100*1024}).encode() for trace in ids)
            sizes.append(len(ids)*100*1024)
            return b'\n'.join(json.dumps({'workspace_id':'w','trace_id':trace,'projection_json':'x'*(100*1024)}).encode() for trace in ids)
        with patch.object(client,'_request',side_effect=response):
            with self.assertRaises(error) as raised:client.read_analytics('w',selections)
            self.assertEqual(raised.exception.status,413)
            self.assertEqual(len(client.read_analytics('w',selections[:50])),50)
        self.assertTrue(sizes);self.assertLessEqual(max(sizes),2*1024*1024)

    def test_large_ras_pages_use_bounded_subqueries_and_report_413(self):
        import json
        api,client=self.client();error=getattr(api,'ClickHouseResponseTooLarge',None)
        self.assertIsNotNone(error)
        selections=[{'owner_principal_id':'alice','task_id':'task','event_key':'event'+str(index),'content_hash':'a'*64,'occurred_at_ms':1794441600000} for index in range(200)]
        sizes=[]
        def response(sql,*,parameters):
            ids=[value for key,value in parameters.items() if key.startswith('event_key_')]
            if 'AS analytics_bytes' in sql:return b'\n'.join(json.dumps({'owner_principal_id':'alice','task_id':'task','event_key':identity,'content_hash':'a'*64,'event_bucket':'2026-11-12','analytics_bytes':128*1024}).encode() for identity in ids)
            sizes.append(len(ids)*128*1024)
            return b'\n'.join(json.dumps({'workspace_id':'w','event_key':identity,'event_json':'x'*(128*1024)}).encode() for identity in ids)
        with patch.object(client,'_request',side_effect=response):
            with self.assertRaises(error) as raised:client.read_ras_events('w',selections)
            self.assertEqual(len(client.read_ras_events('w',selections[:40])),40)
        self.assertEqual(raised.exception.status,413);self.assertTrue(sizes);self.assertLessEqual(max(sizes),2*1024*1024)

    def test_escaped_analytics_insert_reports_413_before_transport_budget_is_exceeded(self):
        import json
        api,client=self.client();error=getattr(api,'ClickHouseResponseTooLarge',None);self.assertIsNotNone(error)
        payload=json.dumps({'x':'\\'*((2*1024*1024-8)//2)},separators=(',',':'))
        row={'workspace_id':'w','trace_bucket':'2026-11-12','trace_id':'t','boundary':'a'*64,'parser_version':1,'projection_hash':'b'*64,'projection_json':payload,'retry_version':1}
        with patch.object(client,'_request') as request:
            with self.assertRaises(error) as raised:client.write_analytics(row)
        self.assertEqual(raised.exception.status,413);request.assert_not_called()

    def test_rejects_unsafe_identifiers_and_endpoint(self):
        api, _ = self.client()
        for db in ['a;DROP DATABASE x', '../x', '', 'x y']:
            with self.assertRaises(ValueError):
                api.ClickHouseStore('http://127.0.0.1:8123', database=db)
        with self.assertRaises(ValueError):
            api.ClickHouseStore('http://user:password@localhost:8123', database='x')

    def test_revision_and_column_validation_precedes_network(self):
        _, client = self.client()
        base = {'workspace_id': 'w', 'trace_bucket': '2026-11-11', 'trace_id': 't', 'span_id': 's', 'revision': 1}
        for row in [dict(base, revision=0), dict(base, revision=2**63), dict(base, fake_column='x'), dict(base, trace_bucket='bad')]:
            with self.assertRaises(ValueError):
                client.write_spans([row])

    def test_bound_query_takes_latest_before_status_filter(self):
        _, client = self.client()
        with patch.object(client, '_request', return_value=b'') as request:
            client.read_spans('w', '2026-11-11', "trace' OR 1=1", status='failed', limit=50)
        sql = request.call_args.args[0]
        self.assertIn(' FINAL', sql)
        self.assertNotIn("trace' OR", sql)
        self.assertEqual(request.call_args.kwargs['parameters']['trace_id'], "trace' OR 1=1")
        self.assertIn('is_deleted = 0', sql)

    def test_payload_chunking_keeps_utf8_and_hash(self):
        _, client = self.client()
        text = '中文🙂' * 40000
        with patch.object(client, '_insert') as insert:
            manifest = client.write_payload('w', '2026-11-11', 't', 's', 'input', text)
        rows = [row for call in insert.call_args_list if call.args[0]=='obs_payload_chunks' for row in call.args[1]]
        self.assertEqual(''.join(row['body'] for row in rows), text)
        self.assertGreater(len(rows), 1)
        self.assertTrue(all(len(row['body'].encode()) <= 262144 for row in rows))
        self.assertEqual(manifest['chunk_count'], len(rows))

    def test_partial_or_corrupt_payload_not_reported_complete(self):
        api, client = self.client()
        row = {'chunk_no': 0, 'chunk_count': 2, 'body': 'hello', 'content_hash': 'bad', 'uncompressed_bytes': 5}
        with patch.object(client, '_request', return_value=__import__('json').dumps(row).encode()+b'\n'):
            with self.assertRaises(api.IncompletePayload):
                client.read_payload('w', '2026-11-11', 't', 's', 'rev', 'input')

    def test_bundle_uses_one_revision_for_input_and_output(self):
        _, client = self.client()
        with patch.object(client,'_insert') as insert:
            manifest=client.write_payload_bundle('w','2026-11-11','t','s',{'input':'question','output':'answer'})
        chunks=[row for call in insert.call_args_list if call.args[0]=='obs_payload_chunks' for row in call.args[1]]
        self.assertEqual({row['payload_revision'] for row in chunks},{manifest['payload_revision']})
        self.assertEqual({row['section'] for row in chunks},{'input','output'})
        self.assertEqual(insert.call_args_list[-1].args[0],'obs_payload_manifests')

    def test_absent_payload_section_is_explicitly_unreported(self):
        _,client=self.client()
        import json
        from services.storage.contracts import canonical_json,content_hash
        manifest={'schema_version':1,'sections':{}}
        with patch.object(client,'_request',return_value=json.dumps({'manifest_json':canonical_json(manifest)}).encode()) as request:
            result=client.read_payload('w','2026-11-11','t','s',content_hash(manifest),'input')
        self.assertEqual(result['available'],False)
        self.assertEqual(result['chunks'],[])
        self.assertIsNone(result['next_chunk'])
        self.assertEqual(request.call_count,1)

    def test_oversize_single_fact_is_rejected_before_network(self):
        _,client=self.client()
        base={'workspace_id':'w','trace_bucket':'2026-11-11','trace_id':'t','span_id':'s','revision':1,'attributes_json':'x'*(4*1024*1024)}
        with patch.object(client,'_request') as request:
            with self.assertRaises(ValueError): client.write_spans([base])
            request.assert_not_called()

    def test_single_span_query_is_bound_and_selective(self):
        _,client=self.client()
        with patch.object(client,'_request',return_value=b'') as request:
            self.assertIsNone(client.read_span('w','2026-11-11','t','s'))
        self.assertIn('span_id = {span_id:String}',request.call_args.args[0])
        self.assertEqual(request.call_args.kwargs['parameters']['span_id'],'s')

    def test_future_payload_manifest_is_rejected(self):
        api,client=self.client()
        from services.storage.contracts import canonical_json,content_hash
        import json
        manifest={'schema_version':2,'sections':{'input':{'content_hash':'a'*64,'uncompressed_bytes':0,'chunk_count':1,'chunk_hashes':['a'*64]}}}
        reply=json.dumps({'manifest_json':canonical_json(manifest)}).encode()+b'\n'
        with patch.object(client,'_request',return_value=reply):
            with self.assertRaises(api.IncompletePayload):
                client.read_payload('w','2026-11-11','t','s',content_hash(manifest),'input')

    def test_analytics_has_bounded_explicit_scope_and_latest_state(self):
        _,client=self.client()
        with patch.object(client,'_request',return_value=b'{"span_count":"3","input_tokens_known_sum":"7","output_tokens_known_sum":"9","input_tokens_missing_count":"0","output_tokens_missing_count":"1"}\n') as request:
            result=client.summarize_spans(['w','w2'],'2026-11-11','2026-11-12',trace_ids={'w':['t\'x'],'w2':['t2']})
        self.assertEqual(result['span_count'],3)
        self.assertEqual(result['input_tokens'],7)
        self.assertIsNone(result['output_tokens'])
        sql=request.call_args.args[0]
        self.assertIn(' FINAL',sql)
        self.assertNotIn("t'x",sql)
        self.assertIn('workspace_0',request.call_args.kwargs['parameters'])
        for scope in ([],['w']*1001):
            with self.assertRaises(ValueError): client.summarize_spans(scope,'2026-11-11','2026-11-12')
