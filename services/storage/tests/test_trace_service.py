import base64
import json
import tempfile
import unittest
from pathlib import Path

from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore, Forbidden
from services.storage.authorized import AuthorizedStorage


class QueryFacts:
    def __init__(self):self.rows=[];self.calls=[];self.before_return=None
    def _request(self,sql,*,parameters):
        self.calls.append((sql,parameters))
        selected={v for k,v in parameters.items() if k.startswith('trace_')}
        rows=[r for r in self.rows if r['trace_id'] in selected and r['workspace_id']==parameters['workspace_id']]
        if parameters.get('status'):rows=[r for r in rows if r['execution_status']==parameters['status']]
        if self.before_return:self.before_return()
        return b'\n'.join(json.dumps(r).encode() for r in rows)


class TraceQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=SQLiteControlStore(Path(self.temp.name)/'core.db',clock=lambda:100000)
        self.store.initialize();self.iam=IAMStore(self.store)
        for p in ('admin','alice','bob'):
            self.iam.create_principal(p,p,p)
        self.iam.create_group('g','team','Team','admin')
        for p in ('alice','bob'):self.iam.set_membership_for_provisioning('g',p,'member')
        self.store.create_workspace('w','Workspace');self.iam.bind_workspace('w',group_id='g')
        self.tokens={p:self.iam.issue_session_for_provisioning(p) for p in ('admin','alice','bob')}
        self.facts=QueryFacts();service=AuthorizedStorage(self.iam,self.facts)
        for name,owner in [('a','alice'),('b','bob'),('c','alice')]:
            service.create_trace(self.tokens[owner],'w',name,'2026-11-12',source_namespace='fixture',native_trace_id=name)
            self.facts.rows.append(dict(workspace_id='w',trace_bucket='2026-11-12',trace_id=name,agent_name='fixture',execution_status='failed' if name=='b' else 'done',span_count='1'))
        from services.storage.trace_service import TraceQueries
        self.queries=TraceQueries(self.store,self.facts,cursor_secret=b'unit-test-secret-not-for-deployment')

    def test_acl_scopes_before_query_and_owner_metadata_is_authoritative(self):
        own=self.queries.list_traces(self.tokens['alice'],'w')
        self.assertEqual([r['trace_id'] for r in own['items']],['c','a'])
        admin=self.queries.list_traces(self.tokens['admin'],'w')
        self.assertEqual({r['trace_id'] for r in admin['items']},{'a','b','c'})
        self.assertEqual(own['project_id'],'default')
        self.assertEqual({r['owner_principal_id'] for r in own['items']},{'alice'})
        sql,params=self.facts.calls[-1]
        self.assertIn(' FINAL',sql)
        self.assertNotIn('fixture\' OR 1=1',sql)

    def test_signed_cursor_is_scope_and_filter_bound(self):
        from services.storage.trace_service import CursorExpired
        page=self.queries.list_traces(self.tokens['admin'],'w',limit=1)
        self.assertEqual(len(page['items']),1);self.assertTrue(page['next_cursor'])
        second=self.queries.list_traces(self.tokens['admin'],'w',limit=1,cursor=page['next_cursor'])
        self.assertNotEqual(page['items'][0]['trace_id'],second['items'][0]['trace_id'])
        for token,options in [(self.tokens['alice'],{}),(self.tokens['admin'],{'status':'failed'})]:
            with self.assertRaises(CursorExpired):self.queries.list_traces(token,'w',cursor=page['next_cursor'],**options)
        tampered=page['next_cursor'][:-1]+('a' if page['next_cursor'][-1]!='a' else 'b')
        with self.assertRaises(CursorExpired):self.queries.list_traces(self.tokens['admin'],'w',cursor=tampered)

    def test_status_filters_latest_state_and_deletion_barrier(self):
        rows=self.queries.list_traces(self.tokens['admin'],'w',status='failed')['items']
        self.assertEqual([r['trace_id'] for r in rows],['b'])
        with self.store.transaction() as con:con.execute("UPDATE trace_locators SET state='deleting' WHERE trace_id='b'")
        self.assertEqual(self.queries.list_traces(self.tokens['admin'],'w',status='failed')['items'],[])

    def test_revocation_during_query_discards_result(self):
        self.facts.before_return=lambda:self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
        with self.assertRaises(Forbidden):self.queries.list_traces(self.tokens['alice'],'w')

    def test_invalid_pagination_or_status_never_queries_facts(self):
        for options in ({'limit':0},{'limit':1001},{'status':'invented'}):
            with self.assertRaises(ValueError):self.queries.list_traces(self.tokens['alice'],'w',**options)
        self.assertEqual(self.facts.calls,[])


class TraceQueryPostflightTests(unittest.TestCase):
    setUp = TraceQueryTests.setUp

    def test_remaining_page_probe_cannot_return_a_trace_after_its_share_is_revoked(self):
        from unittest.mock import patch
        from services.storage.contracts import content_hash
        from services.storage.trace_service import CursorExpired
        self.iam.share_resource(self.tokens['bob'],'w','trace','b','alice')
        scope=self.iam.scope(self.tokens['alice'])
        cursor=self.queries._encode({'version':1,'scope':scope.fingerprint,
            'query':content_hash({'workspace_id':'w','status':'','agent':'','search':''}),
            'created_at_ms':100000,'trace_id':'c'})
        candidates=self.queries._candidates
        calls=0
        def revoke_before_remaining_probe(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls==3:
                self.iam.unshare_resource(self.tokens['bob'],'w','trace','b','alice')
            return candidates(*args,**kwargs)
        with patch.object(self.queries,'_candidates',side_effect=revoke_before_remaining_probe):
            with self.assertRaises((Forbidden,CursorExpired)):
                self.queries.list_traces(self.tokens['alice'],'w',limit=1,cursor=cursor)
        self.assertEqual(calls,3)

    def test_summary_owner_lookup_rechecks_access_in_its_final_read_transaction(self):
        import inspect
        from unittest.mock import patch
        self.iam.share_resource(self.tokens['bob'],'w','trace','b','alice')
        read_transaction=self.store.read_transaction
        revoked=False
        def revoke_before_summary_metadata_transaction():
            nonlocal revoked
            caller=inspect.currentframe().f_back.f_code.co_name
            if caller=='summary' and not revoked:
                revoked=True
                self.iam.unshare_resource(self.tokens['bob'],'w','trace','b','alice')
            return read_transaction()
        with patch.object(self.store,'read_transaction',new=revoke_before_summary_metadata_transaction):
            try:
                with self.assertRaises(Forbidden):
                    self.queries.summary(self.tokens['alice'],'w','b')
            finally:
                self.assertTrue(revoked)


class TraceHTTPTests(unittest.TestCase):
    def setUp(self):
        import threading
        from services.storage.trace_service import TraceRuntime, create_server
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.control=SQLiteControlStore(Path(self.temp.name)/'core.db');self.control.initialize()
        self.iam=IAMStore(self.control);self.iam.create_principal('alice','alice','Alice')
        self.iam.set_password('alice','isolated-test-password-123')
        self.control.create_workspace('w','Workspace');self.iam.bind_workspace('w',principal_id='alice')
        self.token=self.iam.issue_session_for_provisioning('alice')
        self.api=self.iam.issue_api_credential(self.token,'w',['write'])
        self.runtime=TraceRuntime(self.control,QueryFacts(),cursor_secret=b'private-unit-test-cursor-secret',default_workspace='w')
        self.server=create_server(self.runtime,port=0);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.origin='http://127.0.0.1:'+str(self.server.server_port)

    def request(self,path,token=None,body=None,headers=None,method=None):
        import urllib.request,urllib.error
        data=json.dumps(body).encode() if body is not None else None
        request=urllib.request.Request(self.origin+path,data=data,method=method,headers={'content-type':'application/json',**({'Authorization':'Bearer '+token} if token else {}),**(headers or {})})
        try:response=urllib.request.urlopen(request,timeout=5)
        except urllib.error.HTTPError as exc:response=exc
        with response:return response.status,json.loads(response.read()),dict(response.headers)

    def test_password_profile_cookie_bridge_contract_and_logout(self):
        status,result,_=self.request('/v1/auth/login',body={'username':'alice','password':'isolated-test-password-123'})
        self.assertEqual(status,200);self.assertTrue(result['session_token'].startswith('session_'))
        profile=result['profile'];self.assertEqual(profile['workspace_id'],'w');self.assertEqual(profile['workspaces'][0]['role'],'personal')
        token=result['session_token'];self.assertEqual(self.request('/v1/auth/me',token)[1],profile)
        self.assertEqual(self.request('/v1/auth/logout',token,body={})[0],200)
        self.assertEqual(self.request('/v1/auth/me',token)[0],401)
        self.assertEqual(self.request('/v1/auth/login',body={'username':'alice','password':'incorrect'})[0],401)

    def test_collection_requires_api_and_durable_receipt_has_no_secrets(self):
        payload={'resourceSpans':[{'resource':{'attributes':[{'key':'service.name','value':{'stringValue':'http-fixture'}}]},'scopeSpans':[{'spans':[{'traceId':'1'*32,'spanId':'2'*16,'name':'one','startTimeUnixNano':'1794441600000000000','endTimeUnixNano':'1794441600001000000'}]}]}]}
        self.assertEqual(self.request('/v1/ingest/otlp',self.token,body=payload)[0],403)
        status,receipt,_=self.request('/v1/ingest/otlp',self.api,body=payload,headers={'Idempotency-Key':'once'})
        self.assertEqual(status,200);self.assertEqual(receipt['state'],'accepted')
        self.assertEqual(self.request('/v1/ingest/otlp',self.api,body=payload,headers={'Idempotency-Key':'once'})[1]['batch_id'],receipt['batch_id'])
        self.assertEqual(self.request('/v1/batches/'+receipt['batch_id']+'?workspace_id=w',self.api)[1]['state'],'accepted')
        self.assertNotIn(self.api,json.dumps(receipt))
        self.assertEqual(self.request('/v1/traces?workspace_id=w&user=admin',self.api)[0],403)
        self.assertEqual(self.request('/v1/traces?workspace_id=w&user=admin')[0],401)

    def test_server_bounds_and_scope_validation(self):
        self.assertEqual(self.request('/v1/traces?workspace_id=other',self.token)[0],403)
        self.assertEqual(self.request('/v1/traces?workspace_id=w&limit=10000',self.token)[0],400)
        self.assertEqual(self.request('/v1/traces?workspace_id=w&workspace_id=other',self.token)[0],400)
        from services.storage.migrations import load_migrations
        self.assertEqual(self.request('/v1/health')[1]['schema_version'],len(load_migrations('sqlite')))
        self.assertEqual(self.request('/v1/unknown',self.token)[0],404)
        self.assertEqual(self.request('/v1/auth/login',body={'username':'alice','password':'incorrect'},headers={'content-type':'text/plain'})[0],415)


class CompatibilityHTTPTests(TraceHTTPTests):
    def test_existing_page_receives_records_stats_and_facets(self):
        status,data,_=self.request('/v1/compat/observe/data?workspace_id=w&paginated=1&databasePagination=1&listPart=records',self.token)
        self.assertEqual(status,200);self.assertEqual(data['value']['records'],[])
        self.assertFalse(data['value']['hasMore']);self.assertFalse(data['value']['canViewAllTraces'])
        status,data,_=self.request('/v1/compat/observe/data?workspace_id=w&paginated=1&databasePagination=1&listPart=stats',self.token)
        self.assertEqual(status,200);self.assertEqual(data['value']['stats']['total'],0)
        self.assertEqual(self.request('/v1/compat/observe/data?workspace_id=w&facet=values&column=framework',self.token)[1]['value'],[])

    def test_tags_are_persisted_through_the_existing_methods(self):
        status,tag,_=self.request('/v1/compat/tags?workspace_id=w',self.token,body={'user':'spoofed','name':'release-a','kind':'version','color':'#123456'})
        self.assertEqual(status,201);tag=tag['value'];self.assertEqual(tag['name'],'release-a')
        self.assertEqual(self.request('/v1/compat/tags?workspace_id=w',self.token)[1]['value'][0]['id'],tag['id'])
        status,result,_=self.request('/v1/compat/tags/'+tag['id']+'?workspace_id=w',self.token,body={'name':'release-b'},method='PUT')
        self.assertEqual(status,200);self.assertEqual(result['value']['name'],'release-b')
        self.assertEqual(self.request('/v1/compat/tags/'+tag['id']+'?workspace_id=w',self.token,method='DELETE')[0],200)

    def test_original_import_returns_only_after_indexing_and_export_keeps_bundle(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts,bundle
        from services.storage.trace_service import TraceQueries
        from services.storage.observations import ObservationIngest
        self.runtime.facts=MemoryFacts()
        self.runtime.authorized=AuthorizedStorage(self.runtime.iam,self.runtime.facts)
        self.runtime.queries=TraceQueries(self.control,self.runtime.facts,cursor_secret=b'isolated-transfer-http-cursor')
        self.runtime.ingest=ObservationIngest(self.control,self.runtime.facts)
        self.runtime.start_worker();self.addCleanup(self.runtime.close)
        source=bundle()
        status,result,_=self.request('/v1/compat/observe/traces/import?workspace_id=w',self.token,body={'bundle':source,'fileName':'original.json','user':'forged'})
        self.assertEqual(status,200);result=result['value']
        self.assertTrue(result['success']);self.assertEqual(result['fileName'],'original.json')
        self.assertNotIn('batch_refs',result);self.assertEqual(result['rootExecutionId'],'root')
        self.assertEqual(len(self.runtime.facts.spans),1)
        status,exported,_=self.request('/v1/compat/observe/traces/export?workspace_id=w&executionId=root',self.token)
        self.assertEqual(status,200);self.assertEqual(exported['value']['executions'],source['executions'])

class DatasetCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def test_dataset_crud_and_read_only_profile_use_live_asset_authorization(self):
        record={'id':'dataset','user':'forged','name':'评测集','description':'','targetAgent':'','targetSkill':'','tags':[],
            'fields':[],'cases':[],'datasetKind':'ideal_output','createdAt':'2026-11-13T00:00:00Z','updatedAt':'2026-11-13T00:00:00Z'}
        path='/v1/compat/datasets?workspace_id=w'
        status,body,_=self.request(path,self.token,{'action':'save','record':record,'operation_key':'create','operation_kind':'create'})
        self.assertEqual(status,200,body);saved=body['value'];self.assertEqual(saved['dataset']['user'],'alice')
        reader=self.iam.issue_api_credential(self.token,'w',['read'])
        status,body,_=self.request(path,reader,{'action':'list','view':'summary','include_metadata':True})
        self.assertEqual(status,200,body);self.assertEqual(body['value'][0]['id'],'dataset');self.assertIn('_storageEtag',body['value'][0])
        status,body,_=self.request(path,reader,{'action':'save','record':record,'operation_key':'deny','operation_kind':'save','expected_revision':saved['revision']})
        self.assertEqual(status,403)

    def test_generation_rpc_forwards_action_without_requiring_write_for_catalog(self):
        from unittest.mock import patch
        reader=self.iam.issue_api_credential(self.token,'w',['read'])
        with patch('services.storage.dataset_generation.DatasetGeneration.dispatch',return_value={'platforms':[],'agents':[]}) as dispatch:
            status,body,_=self.request('/v1/compat/datasets/generation?workspace_id=w',reader,{'action':'catalog','from':'2026-11-01','to':'2026-11-13'})
        self.assertEqual(status,200,body);self.assertEqual(body['value']['platforms'],[])
        self.assertEqual(dispatch.call_args.args[:3],(reader,'w','catalog'))

    def test_runtime_worker_also_services_dataset_projection_events(self):
        import threading
        from unittest.mock import patch
        reached=threading.Event()
        def project(*args,**kwargs):
            reached.set();return False
        with patch('services.storage.datasets.DatasetStore.project_once',side_effect=project,create=True):
            try:
                self.runtime.start_worker()
                self.assertTrue(reached.wait(1),'Dataset outbox must be serviced by the running materializer')
            finally:self.runtime.close()

    def test_generation_safe_error_status_and_code_keep_original_contract(self):
        from unittest.mock import patch
        from services.storage.dataset_generation import GenerationRequestExpired,GenerationQueueFull,GenerationSourceUnavailable
        for kind,status,code in [(GenerationRequestExpired,410,'REQUEST_EXPIRED'),(GenerationQueueFull,429,'QUEUE_LIMIT'),(GenerationSourceUnavailable,422,'SOURCE_NOT_AVAILABLE')]:
            with self.subTest(code=code),patch('services.storage.dataset_generation.DatasetGeneration.dispatch',side_effect=kind('private diagnostic detail')):
                actual,value,_=self.request('/v1/compat/datasets/generation?workspace_id=w',self.token,{'action':'create'})
            self.assertEqual(actual,status,value);self.assertEqual(value.get('code'),code)
            self.assertNotIn('private diagnostic detail',json.dumps(value))


class DiagnosisCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request
    def test_core_conversation_checkpoint_finish_and_original_history_shape(self):
        from services.storage.trace_metadata import TraceMetadata
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.trace_service import TraceQueries
        from services.storage.observations import ObservationIngest
        self.runtime.facts=MemoryFacts();self.runtime.authorized=AuthorizedStorage(self.runtime.iam,self.runtime.facts)
        self.runtime.queries=TraceQueries(self.control,self.runtime.facts,cursor_secret=b'isolated-diagnosis-http-cursor')
        self.runtime.ingest=ObservationIngest(self.control,self.runtime.facts);self.runtime.start_worker();self.addCleanup(self.runtime.close)
        self.runtime.authorized.create_trace(self.token,'w','diagnosed','2026-11-13',source_namespace='fixture',native_trace_id='fixture')
        TraceMetadata(self.control).register_aliases_for_provisioning('w','diagnosed',task_id='original-task',execution_id='original-execution')
        base='/v1/compat/fault/diagnosis/'
        status,data,_=self.request(base+'session?workspace_id=w&executionId=original-task',self.token)
        self.assertEqual(status,200);self.assertEqual(data['value'],dict(session=None,messages=[]))
        status,started,_=self.request(base+'begin?workspace_id=w',self.token,body=dict(executionId='original-task',request_key='request',message='Why?',evidence_hash='a'*64,lease_owner='worker',opencode_session_id=None))
        self.assertEqual(status,200);started=started['value'];sid=started['session']['id']
        handle=dict(session_id=sid,request_key='request',lease_owner='worker',turn_fence=started['turn']['fence'])
        status,saved,_=self.request(base+'checkpoint?workspace_id=w',self.token,body=dict(handle,expected_revision=1,content='完整回答'))
        self.assertEqual(status,200);rev=saved['value']['turn']['revision']
        terminal=dict(handle,expected_revision=rev,content='完整回答',state='done',opencode_session_id='provider-session')
        self.assertEqual(self.request(base+'finish?workspace_id=w',self.token,body=terminal)[0],409)
        own=snapshot(task='unrelated')
        _,unrelated,_=self.request('/v1/compat/observe/agent-traces?workspace_id=w',self.token,body=own)
        self.assertEqual(self.request(base+'finish?workspace_id=w',self.token,body=dict(terminal,trace_receipt=unrelated['value']))[0],409)
        body=snapshot();body['context']=dict(parent_trace_id='diagnosed',diagnosis_session_id=sid,request_key='request',lease_owner='worker',turn_fence=handle['turn_fence'])
        status,recorded,_=self.request('/v1/compat/observe/agent-traces?workspace_id=w',self.token,body=body)
        self.assertEqual(status,200);terminal['trace_receipt']=recorded['value']
        status,done,_=self.request(base+'finish?workspace_id=w',self.token,body=terminal)
        self.assertEqual(status,200);self.assertEqual(done['value']['turn']['state'],'done')
        status,history,_=self.request(base+'session?workspace_id=w&executionId=original-execution',self.token)
        self.assertEqual(status,200);self.assertEqual([m['content'] for m in history['value']['messages']],['Why?','完整回答'])
        self.assertEqual(history['value']['session']['opencodeSessionId'],'provider-session')
        self.assertEqual(self.request(base+'session?workspace_id=w&executionId=original-task')[0],401)
        status,_,_=self.request(base+'session?workspace_id=w',self.token,body=dict(executionId='original-task',opencodeSessionId='unknown'))
        self.assertEqual(status,409)
    def test_report_reservation_publication_and_deleted_head_fence(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts,bundle
        from services.storage.trace_service import TraceQueries
        from services.storage.observations import ObservationIngest
        self.runtime.facts=MemoryFacts();self.runtime.authorized=AuthorizedStorage(self.runtime.iam,self.runtime.facts)
        self.runtime.queries=TraceQueries(self.control,self.runtime.facts,cursor_secret=b'isolated-report-http-cursor')
        self.runtime.ingest=ObservationIngest(self.control,self.runtime.facts);self.runtime.start_worker();self.addCleanup(self.runtime.close)
        self.assertEqual(self.request('/v1/compat/observe/traces/import?workspace_id=w',self.token,body={'bundle':bundle()})[0],200)
        status,evidence,_=self.request('/v1/compat/observe/evidence?workspace_id=w&traceRef=task',self.token)
        self.assertEqual(status,200)
        base='/v1/compat/observe/reports/agent-debug'
        self.assertEqual(self.request(base+'?workspace_id=w&executionId=root',self.token)[0],200)
        reservation=dict(executionId='root',expectedSnapshotHash=evidence['value']['snapshot_hash'],interactionsHash='a'*64,generator='fixture',requestKey='run',leaseToken='L'*43)
        status,started,_=self.request(base+'?workspace_id=w',self.token,body=reservation)
        self.assertEqual(status,200);started=started['value'];row=started['row']
        self.assertEqual(started['leaseToken'],'L'*43)
        status,replayed,_=self.request(base+'?workspace_id=w',self.token,body=reservation)
        self.assertEqual(status,200);self.assertEqual(replayed['value']['row']['id'],row['id']);self.assertEqual(replayed['value']['leaseToken'],started['leaseToken'])
        path=base+'/'+row['id']+'?workspace_id=w'
        status,_,_=self.request(path,self.token,method='PATCH',body=dict(revision=row['revision'],leaseToken='bad',status='done',payload={'summary':'forged'}))
        self.assertEqual(status,403)
        status,done,_=self.request(path,self.token,method='PATCH',body=dict(revision=row['revision'],leaseToken=started['leaseToken'],status='done',payload={'summary':'完整报告'},requestKey='publish'))
        self.assertEqual(status,200);self.assertEqual(done['value']['payload']['summary'],'完整报告')
        status,repeated,_=self.request(path,self.token,method='PATCH',body=dict(revision=row['revision'],leaseToken=started['leaseToken'],status='done',payload={'summary':'完整报告'},requestKey='publish'))
        self.assertEqual(status,200);self.assertEqual(repeated['value']['row']['revision'],done['value']['row']['revision']);self.assertIsNone(repeated['value']['progress'])
        self.assertEqual(self.request(base+'?workspace_id=w&executionId=task',self.token,method='DELETE')[0],200)
        self.assertIsNone(self.request(base+'?workspace_id=w&executionId=root',self.token)[1]['value']['row'])
    def test_agent_snapshot_returns_indexed_receipt_and_preserves_original_provider_id(self):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.trace_service import TraceQueries
        from services.storage.observations import ObservationIngest
        self.runtime.facts=MemoryFacts();self.runtime.authorized=AuthorizedStorage(self.runtime.iam,self.runtime.facts)
        self.runtime.queries=TraceQueries(self.control,self.runtime.facts,cursor_secret=b'isolated-agent-http-cursor')
        self.runtime.ingest=ObservationIngest(self.control,self.runtime.facts);self.runtime.start_worker();self.addCleanup(self.runtime.close)
        body=snapshot();base='/v1/compat/observe/agent-traces?workspace_id=w'
        status,recorded,_=self.request(base,self.token,body=body)
        self.assertEqual(status,200);recorded=recorded['value'];self.assertEqual(recorded['task_id'],'provider-session');self.assertEqual(recorded['state'],'indexed')
        self.assertTrue(recorded['batch_refs']);self.assertTrue(self.request(base,self.token,body=body)[1]['value']['duplicate'])
        status,evidence,_=self.request('/v1/compat/observe/evidence?workspace_id=w&traceRef=provider-session',self.token)
        self.assertEqual(status,200);self.assertEqual(evidence['value']['session']['interactions'][1]['_providerMessage'],body['rawMessages'][1])
    def test_expanded_agent_snapshot_budget_is_413_instead_of_invalid_input(self):
        from unittest.mock import patch
        from services.storage.agent_traces import AgentTraceLimit
        with patch('services.storage.agent_traces.AgentTraceRecorder.record',side_effect=AgentTraceLimit('expanded snapshot too large')):
            self.assertEqual(self.request('/v1/compat/observe/agent-traces?workspace_id=w',self.token,body={'record':{},'rawMessages':[]})[0],413)

class ExperimentCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def test_experiment_domain_dispatch_keeps_actor_workspace_and_exact_operation(self):
        import sys,types
        from unittest.mock import patch
        calls=[]
        class Store:
            def __init__(self,control,**kwargs):self.control=control
            def dispatch(self,action,token,workspace,body):
                calls.append((action,token,workspace,body));return {'experiment':{'id':'one','name':'原实验'},'revision':'1'}
        payload={'action':'create','experiment':{'name':'原实验','user':'forged'},'operation_key':'once','operation_request':{'name':'原实验'}}
        with patch.dict(sys.modules,{'services.storage.experiments':types.SimpleNamespace(ExperimentStore=Store)}):
            status,value,_=self.request('/v1/compat/experiments?workspace_id=w',self.token,body=payload)
        self.assertEqual(status,200);self.assertEqual(value['value']['experiment']['name'],'原实验')
        self.assertEqual(calls,[('create',self.token,'w',payload)])

    def test_read_only_experiment_domain_request_is_not_rejected_as_a_write(self):
        import sys,types
        from unittest.mock import patch
        read=self.iam.issue_api_credential(self.token,'w',['read']);calls=[]
        class Store:
            def __init__(self,*args,**kwargs):pass
            def dispatch(self,action,token,workspace,body):calls.append(action);return {'items':[]}
        with patch.dict(sys.modules,{'services.storage.experiments':types.SimpleNamespace(ExperimentStore=Store)}):
            status,_,_=self.request('/v1/compat/experiments?workspace_id=w',read,body={'action':'list'})
            self.assertEqual(status,200)
            self.assertEqual(self.request('/v1/compat/experiments?workspace_id=other',read,body={'action':'list'})[0],403)
            self.assertEqual(self.request('/v1/compat/experiments?workspace_id=w',body={'action':'list'})[0],401)
        self.assertEqual(calls,['list'])

    def test_live_materializer_services_experiment_outbox_even_while_observation_work_progresses(self):
        import threading
        from unittest.mock import patch
        reached=threading.Event();self.addCleanup(self.runtime.close)
        with patch.object(self.runtime.ingest,'work_once',return_value=True),patch('services.storage.experiments.ExperimentStore.project_once',side_effect=lambda *args:reached.set() or False):
            self.runtime.start_worker();self.assertTrue(reached.wait(1),'Experiment outbox must receive worker turns')

class EvaluatorCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def test_evaluator_version_assets_use_the_existing_actor_and_freeze_a_safe_definition(self):
        path='/v1/compat/evaluators?workspace_id=w'
        status,read,_=self.request(path,self.token,body={'action':'read'});self.assertEqual(status,200);snapshot=read['value']
        cards=[{'id':'custom-http','name':'原评估器','source':'custom','apiKey':'private-authoring-secret','extra':{'中文':0.25}}]
        status,saved,_=self.request(path,self.token,body={'action':'save','evaluators':cards,'expected_etag':snapshot['etag'],'operation_key':'save-http'})
        self.assertEqual(status,200);self.assertEqual(saved['value']['evaluators'],cards)
        status,frozen,_=self.request(path,self.token,body={'action':'freeze','evaluator_ids':['custom-http']});self.assertEqual(status,200);value=frozen['value'];self.assertEqual(value['cards']['custom-http']['extra'],{'中文':0.25});self.assertNotIn('private-authoring-secret',json.dumps(value))
        self.assertEqual(self.request(path,self.token,body={'action':'save','evaluators':cards,'expected_etag':snapshot['etag'],'operation_key':'stale-http'})[0],409)

class ControllerCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def test_asset_scope_attestation_requires_a_private_proof_bound_to_the_real_actor_and_body(self):
        import hashlib,hmac,sys,types
        from unittest.mock import patch
        key=Path(self.temp.name)/'controller-key';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        calls=[]
        class Store:
            def __init__(self,control,**kwargs):self.verifier=kwargs.get('frozen_assets_verifier')
            def dispatch(self,action,token,workspace,body):calls.append(action);return {'verified':bool(self.verifier and self.verifier(token,workspace,body))}
        value={'action':'start','experiment_id':'exp','config':{'derived_skill_ids':['skill']}}
        digest=hashlib.sha256(json.dumps(value).encode()).hexdigest();proof=hmac.new(bytes.fromhex('a'*64),'\0'.join(('experiment-frozen-assets/v1','alice','w',digest)).encode(),hashlib.sha256).hexdigest()
        path='/v1/compat/experiments?workspace_id=w'
        with patch.dict(sys.modules,{'services.storage.experiments':types.SimpleNamespace(ExperimentStore=Store)}):
            self.assertEqual(self.request(path,self.token,body=value)[0],403)
            status,data,_=self.request(path,self.token,body=value,headers={'x-storage-controller-proof':proof});self.assertEqual(status,200);self.assertEqual(data['value'],{'verified':True})
            self.assertEqual(self.request(path,self.token,body={**value,'experiment_id':'another'},headers={'x-storage-controller-proof':proof})[0],403)
        self.assertEqual(calls,['start'])

class DiagnosisRunCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def test_diagnosis_dispatch_requires_controller_freeze_proof_and_preserves_read_only_reads(self):
        import hashlib,hmac,sys,types
        from unittest.mock import patch
        key=Path(self.temp.name)/'diagnosis-controller-key';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        calls=[]
        class Store:
            def __init__(self,control,**kwargs):self.verifier=kwargs.get('frozen_assets_verifier');self.reports=kwargs.get('trace_reports')
            def dispatch(self,action,token,workspace,body):
                calls.append((action,token,workspace));return {'verified':bool(self.verifier and self.verifier(token,workspace,body)),'reports':self.reports is not None}
        value={'action':'preview','experiment_id':'exp','case_id':'case'}
        digest=hashlib.sha256(json.dumps(value).encode()).hexdigest();proof=hmac.new(bytes.fromhex('a'*64),'\0'.join(('experiment-frozen-assets/v1','alice','w',digest)).encode(),hashlib.sha256).hexdigest()
        path='/v1/compat/diagnosis-runs?workspace_id=w';read=self.iam.issue_api_credential(self.token,'w',['read'])
        with patch.dict(sys.modules,{'services.storage.diagnosis_runs':types.SimpleNamespace(DiagnosisRuns=Store)}):
            self.assertEqual(self.request(path,self.token,body=value)[0],403)
            status,data,_=self.request(path,self.token,body=value,headers={'x-storage-controller-proof':proof});self.assertEqual(status,200);self.assertTrue(data['value']['verified']);self.assertTrue(data['value']['reports'])
            self.assertEqual(self.request(path,self.token,body={**value,'case_id':'another'},headers={'x-storage-controller-proof':proof})[0],403)
            self.assertEqual(self.request(path,read,body={'action':'read','diagnosis_id':'one'})[0],200)
        self.assertEqual([v[0] for v in calls],['preview','read'])

class ExperimentExecutionControllerHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request
    def test_execution_and_cleanup_facts_require_body_bound_private_controller_proof(self):
        import hashlib,hmac,sys,types
        from unittest.mock import patch
        key=Path(self.temp.name)/'execution-controller';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        class Store:
            def __init__(self,*args,**kwargs):pass
            def dispatch(self,*args):return {'accepted':True}
        with patch.dict(sys.modules,{'services.storage.experiments':types.SimpleNamespace(ExperimentStore=Store)}):
            for value in ({'action':'execute_start'},{'action':'execute_complete','trigger_decision':{'triggered':True}},{'action':'execute_fail','cleanup_confirmed':True},{'action':'checkpoint','checkpoint':{'cleanup_confirmed':True}}):
                digest=hashlib.sha256(json.dumps(value).encode()).hexdigest();proof=hmac.new(bytes.fromhex('a'*64),'\0'.join(('experiment-execution/v1','alice','w',digest)).encode(),hashlib.sha256).hexdigest();path='/v1/compat/experiments?workspace_id=w'
                self.assertEqual(self.request(path,self.token,body=value)[0],403)
                self.assertEqual(self.request(path,self.token,body=value,headers={'x-storage-controller-proof':proof})[0],200)
                self.assertEqual(self.request(path,self.token,body={**value,'forged':True},headers={'x-storage-controller-proof':proof})[0],403)

class BenchmarkCompatibilityHTTPTests(unittest.TestCase):
    setUp=TraceHTTPTests.setUp
    request=TraceHTTPTests.request

    def proof(self,purpose,value):
        import hashlib,hmac
        key=Path(self.temp.name)/'benchmark-controller';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        digest=hashlib.sha256(json.dumps(value).encode()).hexdigest()
        return hmac.new(bytes.fromhex('a'*64),'\0'.join((purpose,'alice','w',digest)).encode(),hashlib.sha256).hexdigest()

    def test_definition_dispatch_is_actor_and_body_bound(self):
        import sys,types
        from unittest.mock import patch
        class Store:
            def __init__(self,*args,**kwargs):self.verifier=kwargs.get('definitions_verifier')
            def dispatch(self,action,token,workspace,value):return {'verified':bool(self.verifier and self.verifier(token,workspace,value)),'workspace':workspace}
        value={'action':'start','experiment_id':'one'};proof=self.proof('experiment-frozen-assets/v1',value)
        with patch.dict(sys.modules,{'services.storage.benchmark_core':types.SimpleNamespace(BenchmarkStore=Store)}):
            path='/v1/compat/benchmarks?workspace_id=w'
            self.assertEqual(self.request(path,self.token,body=value)[0],403)
            status,data,_=self.request(path,self.token,body=value,headers={'x-storage-controller-proof':proof});self.assertEqual(status,200);self.assertTrue(data['value']['verified'])
            self.assertEqual(self.request(path,self.token,body={**value,'experiment_id':'two'},headers={'x-storage-controller-proof':proof})[0],403)
            for action in ('load_work','load_dispatch','resume_work'):
                self.assertEqual(self.request(path,self.token,body={'action':action})[0],403)

    def test_delete_only_benchmark_cleanup_reaches_its_domain_without_read_authority(self):
        import sys,types
        from unittest.mock import patch
        runtime=self.runtime
        class Store:
            def __init__(self,*args,**kwargs):self.verifier=kwargs.get('definitions_verifier')
            def dispatch(self,action,token,workspace,value):
                scope=runtime.iam.scope(token);runtime.iam._workspace(scope,workspace,'delete' if action=='cancel_request' else 'read')
                return {'verified':bool(self.verifier and self.verifier(token,workspace,value))}
        token=self.iam.issue_api_credential(self.token,'w',['delete']);value={'action':'cancel_request','experiment_id':'one','mode':'remove'};proof=self.proof('experiment-frozen-assets/v1',value)
        with patch.dict(sys.modules,{'services.storage.benchmark_core':types.SimpleNamespace(BenchmarkStore=Store)}):
            path='/v1/compat/benchmarks?workspace_id=w'
            self.assertEqual(self.request(path,token,body=value)[0],403)
            status,result,_=self.request(path,token,body=value,headers={'x-storage-controller-proof':proof});self.assertEqual(status,200);self.assertTrue(result['value']['verified'])
            self.assertEqual(self.request(path,token,body={'action':'read','experiment_id':'one'})[0],403)
            self.assertEqual(self.request('/v1/compat/benchmarks?workspace_id=foreign',token,body=value,headers={'x-storage-controller-proof':proof})[0],403)

    def test_capability_callback_has_no_bearer_fallback_and_binds_actual_device_in_signed_body(self):
        import sys,types
        from unittest.mock import patch
        capability='bcap_'+base64.urlsafe_b64encode(json.dumps({'principal_id':'alice','workspace_id':'w'}).encode()).decode().rstrip('=')+'.'+'b'*64
        class Store:
            def __init__(self,*args,**kwargs):self.verifier=kwargs.get('device_verifier')
            def callback(self,action,token,value,*,verified_device_client_id=None):return {'client':verified_device_client_id,'verified':bool(self.verifier and self.verifier(verified_device_client_id,{}))}
        value={'action':'complete','job_id':'job','verified_device_client_id':'device'}
        proof=self.proof('benchmark-device/v1',value);headers={'x-agent-insight-callback-token':capability,'x-benchmark-device-client':'device','x-storage-benchmark-device-proof':proof}
        with patch.dict(sys.modules,{'services.storage.benchmark_core':types.SimpleNamespace(BenchmarkStore=Store)}):
            path='/v1/compat/benchmark-callback'
            self.assertEqual(self.request(path,self.token,body=value)[0],401)
            status,data,_=self.request(path,body=value,headers=headers);self.assertEqual(status,200);self.assertEqual(data['value'],{'client':'device','verified':True})
            self.assertEqual(self.request(path,body={**value,'verified_device_client_id':'forged'},headers=headers)[0],403)
            self.assertEqual(self.request(path,body=value,headers={**headers,'x-benchmark-device-client':'forged'})[0],403)
