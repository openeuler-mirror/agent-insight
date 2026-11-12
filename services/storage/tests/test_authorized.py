import importlib
import tempfile
import unittest
from pathlib import Path

from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore, Forbidden


class FactSpy:
    def __init__(self): self.calls=[]
    def read_span(self,*a,**kw): self.calls.append(('span',a,kw)); return {'span_id':a[3]}
    def read_spans(self,*a,**kw): self.calls.append(('spans',a,kw)); return []
    def read_payload(self,*a,**kw): self.calls.append(('payload',a,kw)); return {'chunks':[]}
    def write_spans(self,rows): self.calls.append(('write',rows))
    def write_payload_bundle(self,*a,**kw): self.calls.append(('payload_write',a,kw)); return {}
    def summarize_spans(self,*a,**kw): self.calls.append(('summary',a,kw)); return {'span_count':3}


class AuthorizedTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store=self.make_store()
        self.store.initialize(); self.iam=IAMStore(self.store)
        for p in ('admin','alice','bob'):
            self.iam.create_principal(p,p,p)
        self.iam.create_group('g','team','Team','admin')
        for p in ('alice','bob'): self.iam.set_membership_for_provisioning('g',p,'member')
        for w in ('w','w2','foreign'):
            self.store.create_workspace(w,w)
        self.iam.bind_workspace('w',group_id='g'); self.iam.bind_workspace('w2',group_id='g')
        self.iam.bind_workspace('foreign',principal_id='bob')
        self.tokens={p:self.iam.issue_session_for_provisioning(p) for p in ('admin','alice','bob')}
        self.ch=FactSpy()
        self.api=importlib.import_module('services.storage.authorized')
        self.service=self.api.AuthorizedStorage(self.iam,self.ch)
        self.service.create_trace(self.tokens['alice'],'w','t','2026-11-12',source_namespace='test',native_trace_id='native')
        self.service.create_trace(self.tokens['bob'],'w','b','2026-11-12',source_namespace='test',native_trace_id='other')

    def make_store(self):
        return SQLiteControlStore(Path(self.temp.name)/'db',clock=lambda:100000)

    def test_all_trace_paths_check_same_permission_before_access(self):
        for method,args in [('read_span',('w','2026-11-12','b','s')),('read_spans',('w','2026-11-12','b')),('read_payload',('w','2026-11-12','b','s','a'*64,'output'))]:
            with self.subTest(method=method),self.assertRaises(Forbidden):
                getattr(self.service,method)(self.tokens['alice'],*args)
        self.assertEqual(self.ch.calls,[])
        self.service.read_span(self.tokens['admin'],'w','2026-11-12','b','s')
        self.assertEqual(len(self.ch.calls),1)
        with self.assertRaises(Forbidden): self.service.read_span(self.tokens['admin'],'w','2026-11-11','b','s')
        self.assertEqual(len(self.ch.calls),1)

    def test_mixed_write_batch_is_preflighted_atomically(self):
        rows=[dict(workspace_id='w',trace_bucket='2026-11-12',trace_id=t,span_id='s',revision=1) for t in ('t','b')]
        with self.assertRaises(Forbidden): self.service.write_spans(self.tokens['alice'],rows)
        self.assertEqual(self.ch.calls,[])
        self.service.write_spans(self.tokens['admin'],rows)
        self.assertEqual(len(self.ch.calls),1)

    def test_trace_identity_and_owner_registered_atomically(self):
        with self.assertRaises(Exception): self.service.create_trace(self.tokens['bob'],'w','t','2026-11-12',source_namespace='new',native_trace_id='new')
        with self.store.transaction() as con:
            self.assertEqual(con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE resource_id='t'").fetchone()[0],'alice')
        self.iam.authorize(self.tokens['alice'],'w','read','trace','t')

    def test_aggregate_requires_explicit_nonempty_scope_and_member_roots(self):
        with self.assertRaises(Forbidden): self.service.summarize_spans(self.tokens['admin'],[],'2026-11-12','2026-11-12')
        with self.assertRaises(Forbidden): self.service.summarize_spans(self.tokens['admin'],['foreign'],'2026-11-12','2026-11-12')
        with self.assertRaises(Forbidden): self.service.summarize_spans(self.tokens['alice'],['w'],'2026-11-12','2026-11-12')
        self.service.summarize_spans(self.tokens['alice'],['w'],'2026-11-12','2026-11-12',trace_ids={'w':['t']})
        self.assertEqual(self.ch.calls[-1][2]['trace_ids'],{'w':['t']})
        self.service.summarize_spans(self.tokens['admin'],['w','w2'],'2026-11-12','2026-11-12')
        self.assertEqual(self.ch.calls[-1][1][0],['w','w2'])

    def test_revoked_membership_denies_single_span_and_aggregate(self):
        self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
        with self.assertRaises(Forbidden): self.service.read_span(self.tokens['alice'],'w','2026-11-12','t','s')
        with self.assertRaises(Forbidden): self.service.summarize_spans(self.tokens['alice'],['w'],'2026-11-12','2026-11-12',trace_ids={'w':['t']})
        self.assertEqual(self.ch.calls,[])

    def test_permission_revoked_during_slow_fact_read_is_rechecked(self):
        def revoke(*args,**kwargs):
            self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
            return {'span_id':'s'}
        self.ch.read_span=revoke
        with self.assertRaises(Forbidden): self.service.read_span(self.tokens['alice'],'w','2026-11-12','t','s')

    def test_trace_deletion_state_denies_reads_before_projection_catches_up(self):
        with self.store.transaction() as con: con.execute("UPDATE trace_locators SET state='deleting' WHERE trace_id='t'")
        with self.assertRaises(Forbidden): self.service.read_span(self.tokens['alice'],'w','2026-11-12','t','s')
        self.assertEqual(self.ch.calls,[])
        with self.assertRaises(Forbidden): self.service.read_resource(self.tokens['admin'],'w','trace','t')
        self.assertEqual([r['trace_id'] for r in self.service.list_resources(self.tokens['admin'],'w','trace')['items']],['b'])
        with self.assertRaises(Forbidden): self.service.summarize_spans(self.tokens['alice'],['w'],'2026-11-12','2026-11-12',trace_ids={'w':['t']})
        self.service.summarize_spans(self.tokens['admin'],['w'],'2026-11-12','2026-11-12')
        self.assertEqual(self.ch.calls[-1][2]['excluded_trace_ids'],{'w':['t']})


if __name__=='__main__': unittest.main()
