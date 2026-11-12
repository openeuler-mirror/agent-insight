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
        self.assertEqual(self.request('/v1/health')[1]['schema_version'],4)
        self.assertEqual(self.request('/v1/unknown',self.token)[0],404)
        self.assertEqual(self.request('/v1/auth/login',body={'username':'alice','password':'incorrect'},headers={'content-type':'text/plain'})[0],415)
