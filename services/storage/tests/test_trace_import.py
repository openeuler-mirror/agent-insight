from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from services.storage.legacy import export_database, inventory_database, LegacyValidationError


class TraceImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'legacy.db';self.export=self.root/'export'
        with closing(sqlite3.connect(self.source)) as con:
            con.execute('CREATE TABLE Session(id TEXT PRIMARY KEY,taskId TEXT,user TEXT,startTime INTEGER,endTime INTEGER,interactions TEXT,query TEXT,langfuseTraceNodes TEXT)')
            con.execute('CREATE TABLE Execution(id TEXT PRIMARY KEY,taskId TEXT,user TEXT,timestamp INTEGER,latency REAL,query TEXT,finalResult TEXT,agentName TEXT,framework TEXT,model TEXT,inputTokens INTEGER,outputTokens INTEGER)')
            con.execute('CREATE TABLE User(id TEXT,username TEXT,apiKey TEXT)')
            con.execute("INSERT INTO User VALUES('u','alice','NEVER-COPY-LEGACY-SECRET')")
            con.commit()
        self.binding={'alice':{'credential':'api_'+'A'*43,'workspace_id':'w'}}

    def api(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.trace_import'),'trace import adapter must exist')
        from services.storage import trace_import
        return trace_import

    def session(self,interactions=None,user='alice',task='task',nodes=None):
        if interactions is None:interactions=[{'role':'assistant','spanId':'1'*16,'model':'model','content':'hello','requestMessages':[{'role':'user','content':'prompt'}],'timestamp':'2026-11-12T00:00:00Z','timeInfo':{'created':'2026-11-12T00:00:00Z','completed':'2026-11-12T00:00:01Z'},'usage':{'input_tokens':3,'output_tokens':4}}]
        with closing(sqlite3.connect(self.source)) as con:
            con.execute('INSERT INTO Session VALUES(?,?,?,?,?,?,?,?)',(task,task,user,1794441600000,1794441601000,json.dumps(interactions),'query',nodes));con.commit()

    def execution(self,task='task',user='alice'):
        with closing(sqlite3.connect(self.source)) as con:
            con.execute('INSERT INTO Execution VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('execution-'+task,task,user,1794441600000,1000,'query','answer','Agent','legacy','model',30,40));con.commit()

    def run_import(self,**kwargs):
        if not self.export.exists():export_database(self.source,self.export)
        return self.api().import_legacy_traces(self.export,self.binding,source_id='legacy-fixture',**kwargs)

    def test_default_dry_run_preserves_source_and_reports_skipped_models_without_secrets(self):
        self.session();before=inventory_database(self.source)['source_content_sha256'];calls=[]
        result=self.run_import(sender=lambda *a,**kw:calls.append(a))
        self.assertEqual(result['status'],'dry_run');self.assertEqual(calls,[])
        self.assertEqual(result['planned_spans'],1);self.assertEqual(result['unsupported_tables'],{'User':1})
        self.assertEqual(result['source_content_sha256'],before)
        self.assertEqual(inventory_database(self.source)['source_content_sha256'],before)
        self.assertNotIn('NEVER-COPY',json.dumps(result));self.assertNotIn(self.binding['alice']['credential'],json.dumps(result))

    def test_session_splits_interactions_and_nested_tools_with_stable_parent_ids(self):
        self.session([{'role':'assistant','spanId':'legacy-message','content':'answer','timestamp':'2026-11-12T00:00:00Z','tool_calls':[{'id':'tool-call','function':{'name':'search','arguments':'query'},'output':'found','timing':{'started_at':'2026-11-12T00:00:00Z','completed_at':'2026-11-12T00:00:01Z'}}]},{'role':'assistant','spanId':'2'*16,'parentSpanId':'legacy-message','content':'done','timestamp':'2026-11-12T00:00:01Z'}]);self.execution()
        calls=[]
        def sender(credential,workspace,body,*,receipt_key):
            calls.append((credential,workspace,body,receipt_key));return {'batch_id':'b'+str(len(calls)),'state':'accepted','duplicate':False}
        result=self.run_import(sender=sender,dry_run=False,max_spans_per_packet=2)
        self.assertEqual(result['status'],'complete');self.assertEqual(result['planned_spans'],3);self.assertEqual(len(calls),2)
        spans=[s for c in calls for r in c[2]['resourceSpans'] for scope in r['scopeSpans'] for s in scope['spans']]
        self.assertEqual(spans[1]['parentSpanId'],spans[0]['spanId']);self.assertEqual(spans[2]['parentSpanId'],spans[0]['spanId'])
        self.assertEqual(result['execution_metadata_rows'],1)
        previous=[c[3] for c in calls];calls.clear();self.run_import(sender=sender,dry_run=False,max_spans_per_packet=2);self.assertEqual([c[3] for c in calls],previous)
        self.assertNotIn('NEVER-COPY',json.dumps(calls));self.assertEqual(calls[0][0],self.binding['alice']['credential']);self.assertEqual(calls[0][1],'w')

    def test_execution_without_session_is_explicit_summary_not_fake_detailed_trace(self):
        self.execution();calls=[]
        self.run_import(sender=lambda c,w,b,**kw:(calls.append(b) or {'batch_id':'b','state':'accepted'}),dry_run=False)
        span=calls[0]['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        attrs={a['key']:a['value'] for a in span['attributes']}
        self.assertEqual(attrs['legacy.summary_only'],{'boolValue':True});self.assertEqual(attrs['gen_ai.usage.input_tokens'],{'intValue':'30'})

    def test_unmapped_users_and_unsupported_tree_are_quarantined_without_sending(self):
        self.session(user='bob');self.session(task='tree',nodes='[{"secret":"unknown-tree"}]');calls=[]
        result=self.run_import(sender=lambda *a,**kw:calls.append(a),dry_run=False)
        self.assertEqual(calls,[]);self.assertEqual(result['status'],'complete_with_quarantine');self.assertEqual(len(result['quarantined']),2)
        self.assertEqual({r['reason'] for r in result['quarantined']},{'unmapped_source_user','unsupported_langfuse_tree'})
        self.assertNotIn('unknown-tree',json.dumps(result))

    def test_corrupt_export_is_rejected_before_any_sender_call(self):
        self.session();export_database(self.source,self.export)
        table=next(t for t in json.loads((self.export/'manifest.json').read_text())['tables'] if t['name']=='Session')
        with (self.export/table['file']).open('ab') as stream:stream.write(b'bad\n')
        calls=[]
        with self.assertRaises(LegacyValidationError):self.run_import(sender=lambda *a,**kw:calls.append(a),dry_run=False)
        self.assertEqual(calls,[])

    def test_sender_failure_is_partial_sanitized_and_stops_remaining_packets(self):
        self.session([{'content':'a','timestamp':'2026-11-12T00:00:00Z'},{'content':'b','timestamp':'2026-11-12T00:00:01Z'}]);calls=[]
        def sender(*a,**kw):
            calls.append(kw['receipt_key'])
            if len(calls)>1:raise RuntimeError('password=DO-NOT-REPORT')
            return {'batch_id':'one','state':'accepted'}
        report=self.root/'report.json';result=self.run_import(sender=sender,dry_run=False,max_spans_per_packet=1,report_path=report)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['accepted_packets'],1);self.assertNotIn('DO-NOT-REPORT',report.read_text());self.assertEqual(report.stat().st_mode & 0o777,0o600)

    def test_invalid_or_oversized_record_is_quarantined_before_any_record_packet_is_sent(self):
        self.session([{'content':'x'*5000,'timestamp':'2026-11-12T00:00:00Z'}]);calls=[]
        result=self.run_import(sender=lambda *a,**kw:calls.append(a),dry_run=False,max_packet_bytes=1024)
        self.assertEqual(calls,[]);self.assertEqual(result['quarantined'][0]['reason'],'packet_too_large')

    def test_more_than_ten_thousand_spans_are_split_into_bounded_packets(self):
        self.session([{'spanId':f'{i:016x}','timestamp':'2026-11-12T00:00:00Z','content':'small'} for i in range(1,10002)])
        result=self.run_import();self.assertEqual(result['planned_spans'],10001);self.assertEqual(result['planned_packets'],40)

    def test_apply_uses_existing_ingest_accept_path_and_retries_receipts_idempotently(self):
        from services.storage.control import SQLiteControlStore
        from services.storage.iam import IAMStore
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_observations import Facts
        self.session();control=SQLiteControlStore(self.root/'target.db');control.initialize();iam=IAMStore(control)
        iam.create_principal('owner','owner','Owner');control.create_workspace('w','W');iam.bind_workspace('w',principal_id='owner')
        self.binding['alice']['credential']=iam.issue_session_for_provisioning('owner')
        facts=Facts();ingest=ObservationIngest(control,facts)
        first=self.run_import(sender=ingest.accept,dry_run=False);second=self.run_import(sender=ingest.accept,dry_run=False)
        self.assertEqual(first['status'],'complete');self.assertEqual(second['duplicate_packets'],1)
        self.assertTrue(ingest.work_once('worker'));self.assertEqual(len(facts.spans),1)
        with control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM iam_principals').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],1)

    def test_unmapped_columns_are_reported_and_credentials_are_not_copied(self):
        self.session()
        with closing(sqlite3.connect(self.source)) as con:
            con.execute('ALTER TABLE Session ADD COLUMN apiKey TEXT')
            con.execute("UPDATE Session SET apiKey='DO-NOT-IMPORT-COLUMN'");con.commit()
        result=self.run_import()
        self.assertIn({'table':'Session','fields':['apiKey'],'scope':'columns'},result['unsupported_fields'])
        self.assertNotIn('DO-NOT-IMPORT-COLUMN',json.dumps(result))

    def test_empty_session_marks_unknown_duration_without_borrowing_execution_duration(self):
        self.session([]);self.execution();calls=[]
        with closing(sqlite3.connect(self.source)) as con:con.execute('UPDATE Session SET endTime=NULL');con.commit()
        self.run_import(sender=lambda c,w,b,**kw:(calls.append(b) or {'batch_id':'b','state':'accepted'}),dry_run=False)
        span=calls[0]['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        attrs={a['key']:a['value'] for a in span['attributes']}
        self.assertEqual(span['startTimeUnixNano'],span['endTimeUnixNano'])
        self.assertEqual(attrs['legacy.timing'],{'stringValue':'unknown_duration'})

    def test_existing_report_cannot_be_overwritten_and_invalid_binding_fails_before_sender(self):
        self.session();report=self.root/'report';report.write_text('keep')
        with self.assertRaises(ValueError):self.run_import(dry_run=False,sender=lambda *a,**kw:self.fail('unexpected sender'),report_path=report)
        self.assertEqual(report.read_text(),'keep')
        self.binding['alice']['credential']='legacy-api-key'
        with self.assertRaises(ValueError):self.run_import()

    def test_otlp_shaped_span_json_is_split_without_replacing_real_timestamps(self):
        self.session([{'traceId':'a'*32,'spanId':'1'*16,'parentSpanId':'2'*16,'name':'raw','kind':3,'startTimeUnixNano':'1794441600000000123','endTimeUnixNano':'1794441600000000456','attributes':[{'key':'gen_ai.input','value':{'stringValue':'raw input'}}]}])
        calls=[];self.run_import(sender=lambda c,w,b,**kw:(calls.append(b) or {'batch_id':'b','state':'accepted'}),dry_run=False)
        span=calls[0]['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        self.assertEqual(span['startTimeUnixNano'],'1794441600000000123');self.assertEqual(span['spanId'],'1'*16)
        self.assertEqual(span['parentSpanId'],'2'*16)

    def test_unknown_interaction_fields_and_bounded_unicode_packets_are_reported(self):
        self.session([{'content':'汉'*200,'timestamp':'2026-11-12T00:00:00Z','futureField':'dropped'} for _ in range(4)])
        calls=[];result=self.run_import(sender=lambda c,w,b,**kw:(calls.append(b) or {'batch_id':'b','state':'accepted'}),dry_run=False,max_packet_bytes=4096)
        self.assertGreater(len(calls),1)
        self.assertTrue(all(len(json.dumps(body,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())<=4096 for body in calls))
        self.assertEqual(result['unsupported_fields'][0]['fields'],['futureField'])

    def test_ambiguous_execution_only_identity_is_not_silently_merged(self):
        self.execution()
        with closing(sqlite3.connect(self.source)) as con:
            con.execute("INSERT INTO Execution(id,taskId,user,timestamp) VALUES('other','task','alice',1794441600000)");con.commit()
        calls=[];result=self.run_import(sender=lambda *a,**kw:calls.append(a),dry_run=False)
        self.assertEqual(calls,[]);self.assertEqual(len(result['quarantined']),2)
        self.assertEqual({r['reason'] for r in result['quarantined']},{'ambiguous_execution_identity'})

    def test_http_sender_uses_same_authenticated_ingest_endpoint_without_url_credentials(self):
        import http.server,threading
        api=self.api();self.assertTrue(callable(getattr(api,'http_sender',None)),'HTTP sender factory must exist')
        seen=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                seen.append((self.path,self.headers.get('Authorization'),self.headers.get('X-Workspace-Id'),self.headers.get('Idempotency-Key'),json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"batch_id":"batch","state":"accepted"}')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);self.addCleanup(server.server_close)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();self.addCleanup(server.shutdown)
        sender=api.http_sender('http://127.0.0.1:'+str(server.server_port))
        self.session();result=self.run_import(sender=sender,dry_run=False)
        self.assertEqual(result['status'],'complete');self.assertEqual(seen[0][0],'/v1/ingest/otlp');self.assertEqual(seen[0][1],'Bearer '+self.binding['alice']['credential']);self.assertEqual(seen[0][2],'w');self.assertTrue(seen[0][3].startswith('legacy:'))
        for origin in ['https://example.com','http://user:pass@localhost:123','http://localhost:123/path','http://localhost:123/?q=x']:
            with self.assertRaises(ValueError):api.http_sender(origin)

    def test_receipt_report_links_source_hash_to_destination_without_copying_row_data(self):
        self.session();result=self.run_import(sender=lambda *a,**kw:{'batch_id':'batch','state':'accepted','trace_ids':['target-trace']},dry_run=False)
        receipt=result['receipts'][0]
        self.assertIn('source_table',receipt)
        self.assertEqual(receipt['source_table'],'Session');self.assertRegex(receipt['source_record_key'],r'^[0-9a-f]{64}$')
        self.assertEqual(receipt['workspace_id'],'w');self.assertEqual(receipt['trace_ids'],['target-trace'])
        self.assertNotIn('hello',json.dumps(result));self.assertNotIn('prompt',json.dumps(result))

    def test_failed_or_malformed_ack_is_not_reported_complete(self):
        self.session()
        for ack in [{'batch_id':'b','state':'failed'},{'batch_id':'b','state':'accepted','trace_ids':'invalid'}]:
            result=self.run_import(sender=lambda *a,**kw:ack,dry_run=False)
            self.assertEqual(result['status'],'partial');self.assertEqual(result['accepted_packets'],0)


if __name__=='__main__':unittest.main()
