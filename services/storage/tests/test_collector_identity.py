"""Collector capability preflight uses current IAM without touching source storage."""
import hashlib
import json
import unittest
from services.storage.tests import test_trace_service as trace_tests


class CollectorIdentityHTTPTests(unittest.TestCase):
    setUp=trace_tests.TraceHTTPTests.setUp
    request=trace_tests.TraceHTTPTests.request
    def request_scope(self, token, operation='snapshot', **extra):
        return self.request('/v1/compat/collector-source?workspace_id=w',token,body={'action':'scope','operation':operation,**extra})

    def counts(self):
        with self.control.read_transaction() as con:
            tables=[r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            return {name:sorted(hashlib.sha256(json.dumps(tuple(row),sort_keys=True,default=str).encode()).hexdigest() for row in con.execute('SELECT * FROM "'+name+'"')) for name in tables}

    def test_write_only_api_preflight_is_authoritative_and_does_not_write_source_state(self):
        before=self.counts()
        for operation in ('snapshot','complete'):
            status,value,_=self.request_scope(self.api,operation)
            self.assertEqual(status,200)
            self.assertEqual(value,{'value':{'authorized':True,'operation':operation,'principal_id':'alice','workspace_id':'w'}})
        self.assertEqual(self.counts(),before)

    def test_read_only_api_is_rejected_even_when_profile_reports_personal_writer_role(self):
        token=self.iam.issue_api_credential(self.token,'w',['read'])
        status,profile,_=self.request('/v1/auth/me',token)
        self.assertEqual(status,200);self.assertEqual(profile['workspaces'][0]['role'],'personal')
        self.assertEqual(self.request_scope(token)[0],403)

    def test_revoked_api_and_session_credential_cannot_preflight(self):
        self.assertEqual(self.request_scope(self.token)[0],403)
        self.iam.revoke_credential(self.api)
        self.assertEqual(self.request_scope(self.api)[0],401)

    def test_current_group_role_downgrade_overrides_api_write_capability(self):
        self.iam.create_principal('bob','bob','Bob');self.iam.create_group('g','g','Group','alice')
        self.iam.set_membership_for_provisioning('g','bob','member')
        self.control.create_workspace('group-w','Group workspace');self.iam.bind_workspace('group-w',group_id='g')
        session=self.iam.issue_session_for_provisioning('bob');api=self.iam.issue_api_credential(session,'group-w',['write'])
        url='/v1/compat/collector-source?workspace_id=group-w';body={'action':'scope','operation':'snapshot'}
        self.assertEqual(self.request(url,api,body=body)[0],200)
        self.iam.set_membership_for_provisioning('g','bob','viewer',expected_etag=1)
        self.assertEqual(self.request(url,api,body=body)[0],403)

    def test_scope_request_is_bounded_and_cannot_smuggle_ingest_or_internal_context(self):
        for body in ({'action':'snapshot','operation':'snapshot'}, {'action':'scope','operation':'unknown'}, {'action':'scope','operation':'snapshot','record':{}}, {'action':'scope','operation':'snapshot','context':{'experiment_id':'forged'}}):
            self.assertEqual(self.request('/v1/compat/collector-source?workspace_id=w',self.api,body=body)[0],400)
        self.assertEqual(self.request('/v1/compat/collector-source?workspace_id=w',self.api,body={'action':'scope','operation':'snapshot','data':'x'*5000})[0],413)
        self.assertEqual(self.request('/v1/compat/collector-source?workspace_id=w',self.api)[0],404)
