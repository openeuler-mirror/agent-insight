import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

from services.storage.authorized import AuthorizedStorage
from services.storage.clickhouse import ClickHouseStore
from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore, Forbidden, Unauthorized
from services.storage.tests.test_backend_authorization import RelationalFixture


class EndToEndFixture:
    @classmethod
    def setUpClass(cls):
        cls.facts=ClickHouseStore(os.environ['STORAGE_TEST_CLICKHOUSE_URL'],database='iam_e2e_'+uuid.uuid4().hex,
                                 user=os.environ.get('STORAGE_TEST_CLICKHOUSE_USER','default'),password=os.environ.get('STORAGE_TEST_CLICKHOUSE_PASSWORD',''))
        cls.facts.initialize_new_database()

    @classmethod
    def tearDownClass(cls):
        cls.facts._request('DROP DATABASE '+cls.facts.database,database='default')

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=self.make_store();self.store.initialize();self.iam=IAMStore(self.store)
        for p in ('owner','alice','bob'):
            self.iam.create_principal(p,p,p)
        self.iam.set_password('alice','a long integration test password')
        self.iam.create_group('team','team','Team','owner')
        for p in ('alice','bob'): self.iam.set_membership_for_provisioning('team',p,'member')
        for ws in ('w','w2','foreign'):
            self.store.create_workspace(ws,ws)
        self.iam.bind_workspace('w',group_id='team');self.iam.bind_workspace('w2',group_id='team')
        self.iam.bind_workspace('foreign',principal_id='bob')
        self.owner=self.iam.issue_session_for_provisioning('owner')
        self.alice=self.iam.login('ALICE','a long integration test password')
        self.bob=self.iam.issue_session_for_provisioning('bob')
        self.service=AuthorizedStorage(self.iam,self.facts)

    def test_ten_thousand_spans_login_group_analysis_payload_and_revocation(self):
        service=self.service
        trace=uuid.uuid4().hex;other=uuid.uuid4().hex
        service.create_trace(self.alice,'w',trace,'2026-11-12',source_namespace='fixture',native_trace_id=trace)
        service.create_trace(self.bob,'w2',other,'2026-11-12',source_namespace='fixture',native_trace_id=other)
        payload=service.write_payload_bundle(self.alice,'w','2026-11-12',trace,'09999',{'input':'中文🙂'*70000,'output':'answer'})
        for start in range(0,10000,1000):
            service.write_spans(self.alice,[dict(workspace_id='w',trace_bucket='2026-11-12',trace_id=trace,span_id=f'{i:05d}',revision=1,input_tokens=1) for i in range(start,start+1000)])
        service.write_spans(self.alice,[dict(workspace_id='w',trace_bucket='2026-11-12',trace_id=trace,span_id='09999',revision=2,input_tokens=3,payload_revision=payload['payload_revision'])])
        service.write_spans(self.bob,[dict(workspace_id='w2',trace_bucket='2026-11-12',trace_id=other,span_id='s',revision=1,input_tokens=10)])
        detail=service.read_span(self.owner,'w','2026-11-12',trace,'09999')
        self.assertEqual(int(detail['input_tokens']),3)
        self.assertEqual(len(service.read_spans(self.alice,'w','2026-11-12',trace,limit=200)),200)
        text=service.read_payload(self.alice,'w','2026-11-12',trace,'09999',detail['payload_revision'],'output')
        self.assertEqual(text['chunks'][0]['body'],'answer')
        total=service.summarize_spans(self.owner,['w','w2'],'2026-11-12','2026-11-12')
        self.assertEqual(total['span_count'],10001)
        self.assertEqual(total['input_tokens'],10012)
        self.assertIsNone(total['output_tokens'])
        self.assertEqual(total['output_tokens_missing_count'],10001)
        own=service.summarize_spans(self.alice,['w'],'2026-11-12','2026-11-12',trace_ids={'w':[trace]})
        self.assertEqual(own['span_count'],10000)
        with self.assertRaises(Forbidden): service.read_span(self.bob,'w','2026-11-12',trace,'09999')
        with self.assertRaises(Forbidden): service.summarize_spans(self.owner,['foreign'],'2026-11-12','2026-11-12')
        key=self.iam.issue_api_credential(self.alice,'w',{'read'})
        self.iam.set_membership(self.owner,'team','alice','member',status='disabled',expected_etag=1)
        with self.assertRaises(Forbidden): service.read_payload(self.alice,'w','2026-11-12',trace,'09999',detail['payload_revision'],'output')
        with self.assertRaises(Unauthorized): service.read_span(key,'w','2026-11-12',trace,'09999')
        self.assertIsNotNone(service.read_span(self.owner,'w','2026-11-12',trace,'09999'))
        with self.store.transaction() as con:
            con.execute("UPDATE trace_locators SET state='deleting' WHERE workspace_id='w' AND trace_id=?",(trace,))
        self.assertEqual(service.summarize_spans(self.owner,['w','w2'],'2026-11-12','2026-11-12')['span_count'],1)

    def test_download_and_metadata_list_apply_resource_scope_and_private_gold(self):
        digest,ref=self.store.persist_artifact({'score':10})
        size=Path(ref).stat().st_size
        with self.store.transaction() as con:
            for artifact,namespace in [('result','result'),('gold','private-gold')]:
                con.execute("INSERT INTO artifact_metadata VALUES('w',?,?,?,?,?,?,'published',0,0)",(artifact,namespace,ref,digest,size,'application/json'))
        for artifact in ('result','gold'):
            self.iam.record_resource_for_provisioning('w','artifact',artifact,'alice')
        self.assertEqual(json.loads(self.service.read_artifact(self.alice,'w','result')),{'score':10})
        with self.assertRaises(Forbidden): self.service.read_artifact(self.bob,'w','result')
        with self.assertRaises(Forbidden): self.service.read_artifact(self.owner,'w','gold')
        self.assertEqual([r['artifact_id'] for r in self.service.list_resources(self.owner,'w','artifact')['items']],['result'])
        self.iam.share_resource(self.alice,'w','artifact','result','bob')
        self.assertEqual(json.loads(self.service.read_artifact(self.bob,'w','result')),{'score':10})


    def test_download_rechecks_revocation_after_artifact_io(self):
        from unittest.mock import patch
        digest,ref=self.store.persist_artifact({'secret':'business evidence'})
        with self.store.transaction() as con:
            con.execute("INSERT INTO artifact_metadata VALUES('w','result','result',?,?,?,'application/json','published',0,0)",(ref,digest,Path(ref).stat().st_size))
        self.iam.record_resource_for_provisioning('w','artifact','result','alice')
        verify=self.store._verify_artifact
        def revoke(*args):
            verify(*args)
            self.iam.set_membership(self.owner,'team','alice','member',status='disabled',expected_etag=1)
        with patch.object(self.store,'_verify_artifact',side_effect=revoke):
            with self.assertRaises(Forbidden): self.service.read_artifact(self.alice,'w','result')


@unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'),'set explicit isolated ClickHouse test origin')
class SQLiteEndToEndTests(EndToEndFixture,unittest.TestCase):
    def make_store(self):
        return SQLiteControlStore(Path(self.temp.name)/'core.db',clock=lambda:100000)


@unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL') and os.environ.get('STORAGE_TEST_PG_CONFIG'),'set isolated ClickHouse and PG configuration')
class PostgreSQLEndToEndTests(RelationalFixture,EndToEndFixture,unittest.TestCase):
    pass


@unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL') and os.environ.get('STORAGE_TEST_OPENGAUSS_CONFIG'),'set isolated ClickHouse and openGauss configuration')
class OpenGaussEndToEndTests(RelationalFixture,EndToEndFixture,unittest.TestCase):
    backend='opengauss'
    environment='STORAGE_TEST_OPENGAUSS_CONFIG'
