import concurrent.futures
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from services.storage.migrations import load_migrations


class RelationalUnitTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.relational'),'relational control adapters are missing')
        from services.storage import relational
        return relational

    def test_storage_row_supports_sqlite_style_access(self):
        api=self.module()
        row=api.StorageRow(('name','value'),('hello',4))
        self.assertEqual(row[0],'hello')
        self.assertEqual(row['value'],4)
        self.assertEqual(tuple(row),('hello',4))
        self.assertEqual(dict(row),{'name':'hello','value':4})

    def test_qmark_translation_does_not_change_literals(self):
        api=self.module()
        self.assertEqual(api.qmark_sql("SELECT '?',\"?\",? -- ?\n,? /* ? */"),"SELECT '?',\"?\",%s -- ?\n,%s /* ? */")
        self.assertEqual(api.qmark_sql("SELECT '100%',?"),"SELECT '100%%',%s")

    def test_explicit_schema_and_artifact_directory_are_required(self):
        api=self.module()
        for schema in ('public','pg_catalog','information_schema','unsafe;DROP SCHEMA x',''):
            with self.assertRaises(ValueError):
                api.PostgreSQLControlStore(lambda: None,schema=schema,artifact_directory='/tmp/artifacts')

    def test_connect_error_does_not_leak_dsn(self):
        api=self.module()
        def fail(): raise RuntimeError('password=SECRET host=private')
        store=api.PostgreSQLControlStore(fail,schema='storage_test',artifact_directory='/tmp/artifacts')
        from services.storage.control import StorageError
        with self.assertRaises(StorageError) as context:
            store.initialize()
        self.assertNotIn('SECRET',str(context.exception))


class _RelationalControlContracts:
    backend='postgresql'
    dsn_environment='STORAGE_PG_DSN'
    def setUp(self):
        import psycopg2
        from services.storage.relational import PostgreSQLControlStore, OpenGaussControlStore
        self.psycopg2=psycopg2
        self.schema='storage_test_'+uuid.uuid4().hex
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.now=100_000
        self.factory=lambda: psycopg2.connect(os.environ[self.dsn_environment])
        store_class=PostgreSQLControlStore if self.backend=='postgresql' else OpenGaussControlStore
        self.store=store_class(self.factory,schema=self.schema,artifact_directory=Path(self.temp.name)/'artifacts',clock=lambda:self.now)
        self.store.initialize()
        def cleanup():
            con=self.factory()
            try:
                cur=con.cursor();cur.execute('DROP SCHEMA "'+self.schema+'" CASCADE');con.commit();cur.close()
            finally: con.close()
        self.addCleanup(cleanup)
        self.store.create_workspace('w','Workspace')

    def prepare(self):
        self.store.create_identity('w','agent','agent','test-agent')
        self.store.publish_release('w','agent','ar','1',{'runtime':'test'})
        self.store.create_run('w','run',{'agent':'ar'},{'seed':1},expected_case_count=1)
        self.store.enqueue('w','item','run','case')

    def test_real_asset_run_result_outbox_and_fencing(self):
        self.prepare()
        attempt=self.store.claim('w','worker',lease_ms=1000)
        digest,artifact=self.store.persist_artifact({'score':50})
        receipt=self.store.complete('w',attempt['attempt_id'],attempt['fence'],'receipt','result',digest,artifact)
        duplicate=self.store.complete('w',attempt['attempt_id'],attempt['fence'],'receipt','result',digest,artifact)
        self.assertEqual(receipt['receipt_id'],duplicate['receipt_id'])
        with self.store.transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT status FROM work_items').fetchone()[0],'done')

    def test_real_concurrent_claim_has_one_winner(self):
        self.prepare()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            values=list(pool.map(lambda i:self.store.claim('w',f'worker{i}'),range(8)))
        self.assertEqual(sum(v is not None for v in values),1)

    def test_real_read_transaction_is_snapshot_and_does_not_lock_writer(self):
        from services.storage.control import StorageError
        self.assertTrue(callable(getattr(self.store,'read_transaction',None)),'read-only transaction context is missing')
        with self.store.read_transaction() as reader:
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(self.store.create_workspace,'after','After').result(timeout=2)
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)
        with self.store.read_transaction() as reader:
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],2)
        with self.assertRaises(StorageError):
            with self.store.read_transaction() as reader:
                reader.execute("DELETE FROM workspaces WHERE workspace_id='after'")

    def test_source_evidence_binds_database_history_and_table_content(self):
        self.assertTrue(callable(getattr(self.store,'source_evidence',None)),'source evidence is missing')
        first=self.store.source_evidence()
        second=self.store.source_evidence()
        self.assertEqual(first,second)
        self.assertEqual(first['backend'],self.backend)
        self.assertEqual(first['schema'],self.schema)
        self.assertTrue(first['database_identity']['database_name'])
        self.store.create_workspace('changed','Changed')
        self.assertNotEqual(first['content_sha256'],self.store.source_evidence()['content_sha256'])

    def test_server_migration_rejects_wrong_database_or_stale_evidence(self):
        import copy
        import hashlib
        from services.storage.control import StorageError
        self.assertTrue(callable(getattr(self.store,'source_evidence',None)),'source evidence is missing')
        backup=Path(self.temp.name)/'external-backup.dump'
        backup.write_bytes(b'external backup fixture');backup.chmod(0o600)
        manifest={'backend':self.backend,'schema':self.schema,'path':str(backup),'sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),
                  'restore_verified':True,'writers_stopped':True,'operator':'test operator','created_at_ms':100000,
                  'source_evidence':self.store.source_evidence()}
        wrong=copy.deepcopy(manifest)
        wrong['source_evidence']['database_identity']['database_name']='different_database'
        with self.assertRaises(StorageError): self.store.migrate(backup_manifest=wrong)
        self.store.create_workspace('changed','Changed')
        with self.assertRaises(StorageError): self.store.migrate(backup_manifest=manifest)
        manifest['source_evidence']=self.store.source_evidence()
        self.assertEqual(self.store.migrate(backup_manifest=manifest)['current_version'],len(load_migrations(self.backend)))
        missing=copy.deepcopy(manifest); missing.pop('operator')
        with self.assertRaises(StorageError): self.store.migrate(backup_manifest=missing)

    def _external_manifest(self, store=None):
        import hashlib
        store=store or self.store
        backup=Path(self.temp.name)/(store.schema+'.external-evidence.json')
        evidence=store.source_evidence()
        # This is an external-backup guard fixture, not a dump/restore certification.
        import json
        backup.write_text(json.dumps(evidence));backup.chmod(0o600)
        return {'backend':self.backend,'schema':store.schema,'path':str(backup),
                'sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'restore_verified':True,
                'writers_stopped':True,'operator':'integration fixture','created_at_ms':100000,'source_evidence':evidence}

    def test_migration_waiting_for_business_writer_must_see_its_commit(self):
        import threading
        import time
        from services.storage.control import StorageError
        manifest=self._external_manifest()
        writer_ready=threading.Event();release_writer=threading.Event()
        def writer():
            with self.store.transaction() as con:
                con.execute('INSERT INTO workspaces(workspace_id,name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)',('intervening','Intervening',1,1))
                writer_ready.set()
                if not release_writer.wait(10): raise RuntimeError('test coordination timed out')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            writing=pool.submit(writer)
            self.assertTrue(writer_ready.wait(5))
            migrating=pool.submit(lambda:self.store.migrate(backup_manifest=manifest))
            observer=self.factory()
            try:
                deadline=time.monotonic()+5
                waiting=False
                while time.monotonic()<deadline:
                    with observer.cursor() as cursor:
                        cursor.execute("SELECT COUNT(*) FROM pg_locks pending WHERE NOT pending.granted AND pending.pid IN (SELECT owned.pid FROM pg_locks owned JOIN pg_class c ON owned.relation=c.oid JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname=%s AND c.relname='schema_meta')",(self.schema,))
                        waiting=cursor.fetchone()[0]>0
                    if waiting: break
                    time.sleep(0.01)
                self.assertTrue(waiting,'migration did not wait on this schema writer')
            finally:
                release_writer.set();observer.close()
            writing.result(timeout=5)
            with self.assertRaises(StorageError): migrating.result(timeout=5)

    def _baseline_001_store(self, version=1):
        import hashlib
        from services.storage import relational
        schema='storage_old_'+uuid.uuid4().hex
        store_class=relational.PostgreSQLControlStore if self.backend=='postgresql' else relational.OpenGaussControlStore
        store=store_class(self.factory,schema=schema,artifact_directory=Path(self.temp.name)/schema,clock=lambda:self.now)
        migration=Path(relational.__file__).parent/'schema'/self.backend/'001_core.sql'
        raw=self.factory()
        try:
            with raw.cursor() as cursor:
                cursor.execute('CREATE SCHEMA "'+schema+'"')
                cursor.execute('SET search_path TO "'+schema+'"')
                cursor.execute(migration.read_text())
                cursor.execute('INSERT INTO schema_meta VALUES(%s,%s,%s,%s)',(1,'core',hashlib.sha256(migration.read_bytes()).hexdigest(),self.now))
                if version >= 2:
                    iam_migration=migration.parent/'002_iam.sql'
                    cursor.execute(iam_migration.read_text())
                    cursor.execute('INSERT INTO schema_meta VALUES(%s,%s,%s,%s)',(2,'iam',hashlib.sha256(iam_migration.read_bytes()).hexdigest(),self.now))
            raw.commit()
        finally: raw.close()
        def cleanup():
            raw=self.factory()
            try:
                with raw.cursor() as cursor: cursor.execute('DROP SCHEMA "'+schema+'" CASCADE')
                raw.commit()
            finally: raw.close()
        self.addCleanup(cleanup)
        return store

    def test_real_001_to_latest_preserves_workspace_release_and_run(self):
        store=self._baseline_001_store()
        store.create_workspace('preserved','Preserved')
        store.create_identity('preserved','agent','agent','Agent')
        release=store.publish_release('preserved','agent','release','v1',{'prompt':'keep'})
        store.create_run('preserved','run',{'agent':'release'},{'seed':7},expected_case_count=1)
        with store.read_transaction() as con:
            original_marker=tuple(con.execute('SELECT * FROM schema_meta').fetchone())
            original_workspace=tuple(con.execute('SELECT * FROM workspaces').fetchone())
            original_release=tuple(con.execute('SELECT * FROM asset_releases').fetchone())
            original_run=tuple(con.execute('SELECT * FROM runs').fetchone())
        manifest=self._external_manifest(store)
        result=store.migrate(backup_manifest=manifest)
        self.assertEqual(result['current_version'],len(load_migrations(self.backend)))
        with store.read_transaction() as con:
            self.assertEqual(tuple(con.execute('SELECT * FROM schema_meta WHERE version=1').fetchone()),original_marker)
            self.assertEqual(tuple(con.execute('SELECT * FROM workspaces').fetchone()),original_workspace)
            self.assertEqual(tuple(con.execute('SELECT * FROM asset_releases').fetchone()),original_release)
            self.assertEqual(tuple(con.execute('SELECT * FROM runs').fetchone()),original_run)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM iam_principals').fetchone()[0],0)
            self.assertEqual(con.execute("SELECT project_id FROM project_workspaces WHERE workspace_id='preserved'").fetchone()[0],'default')

    def test_real_bad_002_cannot_commit_partial_tables_or_version(self):
        import shutil
        from unittest.mock import patch
        from services.storage import migrations
        from services.storage.control import StorageError
        store=self._baseline_001_store()
        store.create_workspace('preserved','Preserved')
        manifest=self._external_manifest(store)
        root=Path(self.temp.name)/'broken-schema'
        directory=root/self.backend;directory.mkdir(parents=True)
        original=Path(migrations.__file__).parent/'schema'/self.backend
        shutil.copyfile(original/'001_core.sql',directory/'001_core.sql')
        for failure in ('INSERT INTO nonexistent_migration_target VALUES (1);','COMMIT;'):
            bad=(original/'002_iam.sql').read_text()+'\n'+failure
            (directory/'002_iam.sql').write_text(bad)
            with self.subTest(failure=failure),patch.object(migrations,'SCHEMA_ROOT',root):
                with self.assertRaises(StorageError): store.migrate(backup_manifest=manifest)
                self.assertEqual(store.migration_plan()['current_version'],1)
        with store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?',(store.schema,'iam_principals')).fetchone()[0],0)

    def test_real_002_to_003_preserves_credentials_acl_and_previous_markers(self):
        from services.storage.iam import IAMStore
        store=self._baseline_001_store(version=2)
        store.create_workspace('preserved','Preserved')
        store.create_identity('preserved','agent','agent','Agent')
        store.publish_release('preserved','agent','release','v1',{'prompt':'keep'})
        store.create_run('preserved','run',{'agent':'release'},{'seed':8},expected_case_count=1)
        import hashlib,json
        password_hash=hashlib.pbkdf2_hmac('sha256',b'project migration passphrase 2026',bytes(32),600000).hex()
        parameters=json.dumps({'iterations':600000,'salt':'00'*32})
        token='session_'+'A'*43
        with store.transaction() as con:
            con.execute("INSERT INTO iam_principals VALUES(?,?,?,'active',2,?,?)",('owner','owner','Owner',self.now,self.now))
            con.execute('INSERT INTO iam_password_credentials VALUES(?,?,?,?,1,?)',('owner',password_hash,'pbkdf2-sha256',parameters,self.now))
            con.execute("INSERT INTO iam_workspace_bindings VALUES(?,'personal',NULL,?,1,?,?)",('preserved','owner',self.now,self.now))
            con.execute("INSERT INTO iam_resource_access VALUES(?,'trace',?,?,'private',1,?,?)",('preserved','trace','owner',self.now,self.now))
            con.execute('INSERT INTO iam_sessions VALUES(?,?,?,?,?,?,NULL)',('old-session','owner',hashlib.sha256(token.encode()).hexdigest(),2,self.now,self.now+3600000))
        tables=('schema_meta','workspaces','asset_releases','runs','iam_principals','iam_password_credentials','iam_workspace_bindings','iam_resource_access','iam_sessions')
        with store.read_transaction() as con:
            before={name:[tuple(row) for row in con.execute('SELECT * FROM '+name)] for name in tables}
        store.initialize()
        self.assertEqual(store.migration_plan()['current_version'],2)
        self.assertEqual(len(store.source_evidence()['history']),2)
        manifest=self._external_manifest(store)
        self.assertEqual(store.migrate(backup_manifest=manifest)['current_version'],len(load_migrations(self.backend)))
        with store.read_transaction() as con:
            for name,rows in before.items():
                actual=[tuple(row) for row in con.execute('SELECT * FROM '+name)]
                self.assertEqual(actual[:2] if name=='schema_meta' else actual,rows,name)
            self.assertEqual(con.execute("SELECT project_id FROM project_workspaces WHERE workspace_id='preserved'").fetchone()[0],'default')
        self.assertTrue({'projects','project_workspaces'}.issubset({t['name'] for t in store.source_evidence()['tables']}))
        iam=IAMStore(store)
        iam.authorize(token,'preserved','read','trace','trace')
        iam.authorize(iam.login('owner','project migration passphrase 2026'),'preserved','read','trace','trace')

    def test_real_003_failure_rolls_back_default_project_and_backfill(self):
        import shutil
        from unittest.mock import patch
        from services.storage import migrations
        from services.storage.control import StorageError
        store=self._baseline_001_store(version=2);store.create_workspace('preserved','Preserved')
        manifest=self._external_manifest(store)
        root=Path(self.temp.name)/'bad-project-schema';directory=root/self.backend;directory.mkdir(parents=True)
        original=Path(migrations.__file__).parent/'schema'/self.backend
        for filename in ('001_core.sql','002_iam.sql'): shutil.copyfile(original/filename,directory/filename)
        (directory/'003_projects.sql').write_text((original/'003_projects.sql').read_text()+'\nINSERT INTO missing_project_target VALUES(1);')
        with patch.object(migrations,'SCHEMA_ROOT',root):
            with self.assertRaises(StorageError): store.migrate(backup_manifest=manifest)
            self.assertEqual(store.migration_plan()['current_version'],2)
        with store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?)',(store.schema,'projects','project_workspaces')).fetchone()[0],0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)

    def test_real_default_project_mapping_is_atomic_and_must_be_active(self):
        from services.storage.control import StorageError
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute("SELECT project_id FROM project_workspaces WHERE workspace_id='w'").fetchone()[0],'default')
        with self.store.transaction() as con: con.execute("UPDATE projects SET status='disabled' WHERE project_id='default'")
        with self.assertRaises(StorageError): self.store.create_workspace('blocked','Blocked')
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM workspaces WHERE workspace_id='blocked'").fetchone()[0],0)

    def test_real_runtime_missing_003_refuses_reopen_without_changes(self):
        import shutil
        from unittest.mock import patch
        from services.storage import migrations
        from services.storage.control import StorageError
        before=self.store.source_evidence()
        old=Path(self.temp.name)/'old-runtime'/self.backend;old.mkdir(parents=True)
        original=Path(migrations.__file__).parent/'schema'/self.backend
        for filename in ('001_core.sql','002_iam.sql'): shutil.copyfile(original/filename,old/filename)
        with patch.object(migrations,'SCHEMA_ROOT',old.parent):
            with self.assertRaises(StorageError): self.store.initialize()
        self.assertEqual(self.store.source_evidence(),before)

    def test_real_project_backfill_preserves_legacy_workspace_identifier(self):
        from services.storage.control import StorageError
        store=self._baseline_001_store(version=2)
        store.create_workspace(' padded ','Preserve original identifier')
        manifest=self._external_manifest(store)
        self.assertEqual(store.migrate(backup_manifest=manifest)['current_version'],len(load_migrations(self.backend)))
        with store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT workspace_id FROM workspaces').fetchone()[0],' padded ')
            self.assertEqual(tuple(con.execute("SELECT workspace_id,project_id FROM project_workspaces WHERE workspace_id=' padded '").fetchone()),(' padded ','default'))

    def test_real_cancel_and_draft_cas_and_rollback(self):
        from services.storage.control import Conflict
        self.prepare()
        self.store.create_draft('w','draft','agent',{'prompt':'one'})
        self.store.edit_draft('w','draft',{'prompt':'two'},expected_revision=1)
        with self.assertRaises(Conflict): self.store.edit_draft('w','draft',{'prompt':'lost'},expected_revision=1)
        attempt=self.store.claim('w','worker')
        self.assertTrue(self.store.cancel('w','item'))
        with self.assertRaises(Conflict): self.store.renew('w',attempt['attempt_id'],attempt['fence'])
        with self.assertRaises(RuntimeError):
            with self.store.transaction() as con:
                con.execute("INSERT INTO workspaces(workspace_id,name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)",('rollback','test',1,1))
                raise RuntimeError('abort')
        with self.store.transaction() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM workspaces WHERE workspace_id=?",('rollback',)).fetchone()[0],0)




@unittest.skipUnless(os.environ.get('STORAGE_PG_DSN'),'set STORAGE_PG_DSN for explicit PostgreSQL integration')
class PostgreSQLControlTests(_RelationalControlContracts,unittest.TestCase):
    pass


@unittest.skipUnless(os.environ.get('STORAGE_OPENGAUSS_DSN'),'set STORAGE_OPENGAUSS_DSN for explicit openGauss integration')
class OpenGaussControlTests(_RelationalControlContracts,unittest.TestCase):
    backend='opengauss'
    dsn_environment='STORAGE_OPENGAUSS_DSN'


if __name__=='__main__': unittest.main()
