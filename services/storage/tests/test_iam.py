import concurrent.futures
import hashlib
import importlib
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from services.storage.control import SQLiteControlStore, Conflict

PASSWORD = 'a long test passphrase 2026'


class IAMTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 100_000
        self.store = self.make_store()
        self.store.initialize()
        self.api = importlib.import_module('services.storage.iam')
        self.iam = self.api.IAMStore(self.store)
        for p in ('owner','admin','alice','bob','viewer','outsider'):
            self.iam.create_principal(p,p,p)
        self.iam.set_password('alice', PASSWORD)
        self.iam.create_group('g','team','Team','owner')
        for p,role in [('admin','admin'),('alice','member'),('bob','member'),('viewer','viewer')]:
            self.iam.set_membership_for_provisioning('g',p,role)
        for w in ('w','w2','foreign','unbound'):
            self.store.create_workspace(w,w)
        self.iam.bind_workspace('w',group_id='g')
        self.iam.bind_workspace('w2',group_id='g')
        self.iam.bind_workspace('foreign',principal_id='outsider')
        self.tokens = {p:self.iam.issue_session_for_provisioning(p) for p in ('owner','admin','alice','bob','viewer','outsider')}
        self.iam.record_resource_for_provisioning('w','trace','alice-trace','alice')
        self.iam.record_resource_for_provisioning('w','trace','bob-trace','bob')

    def make_store(self):
        return SQLiteControlStore(Path(self.temp.name)/'core.db', clock=lambda: self.now)

    def test_password_login_normalization_and_no_plaintext(self):
        token=self.iam.login(' ALICE ',PASSWORD)
        self.assertEqual(self.iam.scope(token).principal_id,'alice')
        with self.assertRaises(self.api.Unauthorized): self.iam.login('alice','wrong')
        with self.assertRaises(self.api.Unauthorized): self.iam.login('missing','wrong')
        with self.store.transaction() as db:
            row=db.execute("SELECT * FROM iam_password_credentials WHERE principal_id='alice'").fetchone()
            self.assertNotIn(PASSWORD,str(dict(row)))
            self.assertEqual(row['scheme'],'pbkdf2-sha256')
            self.assertGreaterEqual(json.loads(row['parameters_json'])['iterations'],600000)
            hashes=[r[0] for r in db.execute('SELECT session_token_hash FROM iam_sessions')]
            self.assertNotIn(token,hashes)
            self.assertIn(hashlib.sha256(token.encode()).hexdigest(),hashes)

    def test_admin_cross_workspace_member_ownership_and_empty_deny(self):
        admin=self.tokens['admin']; alice=self.tokens['alice']
        self.assertEqual(set(self.iam.scope(admin).allowed_workspace_ids),{'w','w2'})
        self.iam.authorize(admin,'w','read','trace','bob-trace')
        self.iam.authorize(alice,'w','read','trace','alice-trace')
        for token,ws,rid in [(alice,'w','bob-trace'),(admin,'foreign','x'),(admin,'unbound','x')]:
            with self.assertRaises(self.api.Forbidden): self.iam.authorize(token,ws,'read','trace',rid)
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(admin,'w','read','trace','missing')
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(self.iam.scope(admin))

    def test_explicit_share_viewer_and_write_separate_from_read(self):
        self.iam.share_resource(self.tokens['alice'],'w','trace','alice-trace','viewer')
        self.iam.authorize(self.tokens['viewer'],'w','read','trace','alice-trace')
        for token,cap in [(self.tokens['viewer'],'write'),(self.tokens['bob'],'write')]:
            with self.assertRaises(self.api.Forbidden): self.iam.authorize(token,'w',cap,'trace','alice-trace')
        with self.assertRaises(self.api.Forbidden):
            self.iam.share_resource(self.tokens['alice'],'w','trace','alice-trace','outsider')

    def test_explicit_share_revocation_changes_scope_and_denies_next_read(self):
        self.iam.share_resource(self.tokens['alice'],'w','trace','alice-trace','bob')
        before=self.iam.scope(self.tokens['bob']).fingerprint
        self.iam.authorize(self.tokens['bob'],'w','read','trace','alice-trace')
        self.iam.unshare_resource(self.tokens['alice'],'w','trace','alice-trace','bob')
        self.assertNotEqual(before,self.iam.scope(self.tokens['bob']).fingerprint)
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(self.tokens['bob'],'w','read','trace','alice-trace')

    def test_password_change_race_cannot_issue_session_from_stale_hash(self):
        original=hashlib.pbkdf2_hmac
        def disable(*args,**kwargs):
            result=original(*args,**kwargs)
            self.iam.set_principal_status('alice','disabled')
            return result
        with patch('services.storage.iam.hashlib.pbkdf2_hmac',side_effect=disable):
            with self.assertRaises(self.api.Unauthorized): self.iam.login('alice',PASSWORD)

    def test_revocation_password_change_disable_and_rejoin(self):
        alice=self.tokens['alice']
        before=self.iam.scope(alice).fingerprint
        self.iam.set_membership(self.tokens['owner'],'g','alice','member',status='disabled',expected_etag=1)
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(alice,'w','read','trace','alice-trace')
        self.iam.set_membership(self.tokens['owner'],'g','alice','member',expected_etag=2)
        self.assertNotEqual(before,self.iam.scope(alice).fingerprint)
        self.iam.set_password('alice',PASSWORD+' changed')
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(alice)
        new=self.iam.login('alice',PASSWORD+' changed')
        self.iam.set_principal_status('alice','disabled')
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(new)

    def test_api_key_bound_capabilities_expiry_and_revocation(self):
        key=self.iam.issue_api_credential(self.tokens['alice'],'w',{'read'},ttl_ms=1000)
        self.iam.authorize(key,'w','read','trace','alice-trace')
        self.assertEqual(self.iam.scope(key).allowed_workspace_ids,('w',))
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(key,'w','write','trace','alice-trace')
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(key,'w2','read','trace','x')
        self.iam.revoke_credential(key)
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(key)
        expiring=self.iam.issue_api_credential(self.tokens['alice'],'w',{'read'},ttl_ms=1000)
        self.now+=1000
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(expiring)

    def test_leaving_group_permanently_revokes_existing_group_api_key(self):
        key=self.iam.issue_api_credential(self.tokens['alice'],'w',{'read'})
        self.iam.set_membership(self.tokens['owner'],'g','alice','member',status='disabled',expected_etag=1)
        self.iam.set_membership(self.tokens['owner'],'g','alice','member',expected_etag=2)
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(key)

    def test_clock_regression_does_not_block_membership_revocation(self):
        self.now+=1
        key=self.iam.issue_api_credential(self.tokens['alice'],'w',{'read'})
        self.now-=1
        self.iam.set_membership(self.tokens['owner'],'g','alice','member',status='disabled',expected_etag=1)
        self.now+=1
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(key)

    def test_cas_last_owner_and_admin_cannot_escalate(self):
        with self.assertRaises(self.api.Forbidden): self.iam.set_membership(self.tokens['admin'],'g','bob','owner',expected_etag=1)
        with self.assertRaises(Conflict): self.iam.set_membership(self.tokens['owner'],'g','owner','member',expected_etag=1)
        self.iam.set_membership(self.tokens['owner'],'g','bob','admin',expected_etag=1)
        with self.assertRaises(Conflict): self.iam.set_membership(self.tokens['owner'],'g','bob','viewer',expected_etag=1)

    def test_logout_and_scope_fingerprint_includes_credential_limit(self):
        session=self.tokens['alice']
        key=self.iam.issue_api_credential(session,'w',{'read'})
        self.assertNotEqual(self.iam.scope(session).fingerprint,self.iam.scope(key).fingerprint)
        self.iam.revoke_credential(session)
        with self.assertRaises(self.api.Unauthorized): self.iam.scope(session)

    def test_personal_space_not_inferred_from_shared_membership(self):
        self.iam.record_resource_for_provisioning('foreign','trace','personal','outsider')
        self.iam.authorize(self.tokens['outsider'],'foreign','read','trace','personal')
        self.assertNotIn('foreign',self.iam.scope(self.tokens['owner']).allowed_workspace_ids)
        with self.assertRaises(self.api.Forbidden): self.iam.authorize(self.tokens['owner'],'foreign','read','trace','personal')


if __name__ == '__main__': unittest.main()
