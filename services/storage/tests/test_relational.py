from contextlib import contextmanager
import concurrent.futures
import threading
import time
from unittest.mock import patch
from services.storage.tests.test_datasets import record
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
            with self.store.transaction(('workspace', 'intervening')) as con:
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

    def _datasets(self):
        from services.storage.iam import IAMStore
        from services.storage.datasets import DatasetStore
        iam = IAMStore(self.store)
        iam.create_principal('author', 'author', 'Author')
        iam.bind_workspace('w', principal_id='author')
        return DatasetStore(self.store), iam.issue_session_for_provisioning('author')

    @contextmanager
    def _paused_writer(self, operation):
        original = self.store.transaction
        local = threading.local()
        ready, release = threading.Event(), threading.Event()
        held = []

        @contextmanager
        def transaction(*args, **kwargs):
            with original(*args, **kwargs) as con:
                yield con
                if getattr(local, 'pause', False):
                    held.append(con.execute('SELECT pg_backend_pid()').fetchone()[0])
                    ready.set()
                    if not release.wait(30):
                        raise RuntimeError('test writer was not released')

        def writer():
            local.pause = True
            return operation()

        with patch.object(self.store, 'transaction', transaction), concurrent.futures.ThreadPoolExecutor(2) as pool:
            first = pool.submit(writer)
            try:
                if not ready.wait(10):
                    first.result(timeout=0)
                    self.fail('writer did not reach its pre-commit pause')
                yield pool, first, held[0]
            finally:
                release.set()

    def _wait_for_contender(self, holder):
        # Match the held advisory, relation or transaction-ID lock of this writer.
        observer = self.factory()
        try:
            with observer.cursor() as cursor:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    cursor.execute("""SELECT 1 FROM pg_locks a JOIN pg_locks b ON
                        a.locktype=b.locktype AND a.database IS NOT DISTINCT FROM b.database
                        AND a.transactionid IS NOT DISTINCT FROM b.transactionid
                        AND a.page IS NOT DISTINCT FROM b.page AND a.tuple IS NOT DISTINCT FROM b.tuple
                        AND a.relation IS NOT DISTINCT FROM b.relation
                        AND a.classid IS NOT DISTINCT FROM b.classid
                        AND a.objid IS NOT DISTINCT FROM b.objid
                        AND a.objsubid IS NOT DISTINCT FROM b.objsubid
                        WHERE a.pid=%s AND a.granted AND NOT b.granted""", (holder,))
                    if cursor.fetchone():
                        return
                    time.sleep(0.01)
                self.fail('contending writer did not wait on the held lock')
        finally:
            observer.close()

    def test_independent_dataset_saves_commit_before_first_writer_released(self):
        datasets, token = self._datasets()
        for key in ('one', 'two'):
            datasets.save(token, 'w', record(key), operation_key='init-'+key)
        def save(key):
            return datasets.save(token, 'w', record(key, 'updated '+key), operation_key='edit-'+key, expected_revision=1)
        with self._paused_writer(lambda: save('one')) as (pool, first, _):
            self.assertEqual(pool.submit(save, 'two').result(timeout=5)['revision'], '2')
            self.assertFalse(first.done())
        self.assertEqual(first.result()['revision'], '2')
        for key in ('one', 'two'):
            self.assertEqual(datasets.get(token, 'w', key)['revision'], '2')

    def test_concurrent_stale_dataset_save_cannot_fork_release_or_projection(self):
        from services.storage.control import Conflict
        datasets, token = self._datasets()
        datasets.save(token, 'w', record(), operation_key='init')
        def save(key):
            return datasets.save(token, 'w', record(name=key), operation_key=key, expected_revision=1)
        with self._paused_writer(lambda: save('winner')) as (pool, first, holder):
            second = pool.submit(save, 'loser')
            self._wait_for_contender(holder)
        with self.assertRaises(Conflict):
            second.result()
        with self.store.read_transaction() as con:
            release = first.result()['release_id']
            self.assertEqual(tuple(con.execute('SELECT revision,release_id FROM dataset_compat_heads').fetchone()), (2,release))
            self.assertEqual(con.execute("SELECT release_id FROM asset_aliases WHERE alias='latest'").fetchone()[0],release)
            self.assertEqual(con.execute('SELECT count(*) FROM asset_release_seals').fetchone()[0],2)
            self.assertEqual(con.execute('SELECT count(*) FROM dataset_operation_receipts').fetchone()[0],2)
            self.assertEqual(con.execute('SELECT count(*) FROM outbox_events').fetchone()[0],2)

    def test_concurrent_initial_save_replays_and_shared_content_is_unique(self):
        from services.storage.control import Conflict
        datasets, token = self._datasets()
        def save(identity, key, name='Dataset'):
            data = record(identity, name)
            if name == 'shared':
                data['cases'][0]['expectedOutput'] = 'a new shared answer'
            return datasets.save(token, 'w', data, operation_key=key)
        with self._paused_writer(lambda: save('one','same')) as (pool, first, holder):
            second = pool.submit(save,'one','same')
            self._wait_for_contender(holder)
        self.assertEqual(first.result()['release_id'],second.result()['release_id'])
        with self.assertRaises(Conflict):
            save('two','same','other')
        with self._paused_writer(lambda: save('two','second','shared')) as (pool, first, holder):
            third = pool.submit(save,'three','third','shared')
            self._wait_for_contender(holder)
        self.assertEqual(third.result()['revision'], '1')
        with self.store.read_transaction() as con:
            for table in ('dataset_compat_heads','dataset_operation_receipts','asset_release_seals'):
                self.assertEqual(con.execute('SELECT count(*) FROM '+table).fetchone()[0],3)
            self.assertEqual(con.execute("SELECT count(*) FROM artifact_metadata WHERE namespace='dataset.gold'").fetchone()[0],2)

    def test_revoked_credential_cannot_commit_an_already_started_save(self):
        from services.storage.iam import IAMStore, Unauthorized
        datasets, token = self._datasets()
        with self._paused_writer(lambda: IAMStore(self.store).revoke_credential(token)) as (pool, first, holder):
            saving = pool.submit(datasets.save,token,'w',record(),operation_key='stale')
            self._wait_for_contender(holder)
        first.result()
        with self.assertRaises(Unauthorized):
            saving.result()
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT count(*) FROM asset_releases').fetchone()[0],0)

    def test_dataset_failure_after_receipt_rolls_back_all_control_rows(self):
        datasets, token = self._datasets()
        with patch.object(datasets, '_queue_projection_tx', side_effect=RuntimeError('injected')):
            with self.assertRaisesRegex(RuntimeError, 'injected'):
                datasets.save(token,'w',record(),operation_key='retry')
        with self.store.read_transaction() as con:
            for table in ('asset_identities','dataset_compat_heads','asset_release_seals',
                          'asset_aliases','dataset_operation_receipts','artifact_metadata','outbox_events'):
                self.assertEqual(con.execute('SELECT count(*) FROM '+table).fetchone()[0],0,table)
        self.assertEqual(datasets.save(token,'w',record(),operation_key='retry')['revision'],'1')

    def test_business_writer_waits_for_migration_before_writing(self):
        held = self.factory()
        try:
            with held.cursor() as cursor:
                cursor.execute('LOCK TABLE "'+self.schema+'".schema_meta IN EXCLUSIVE MODE')
                cursor.execute('SELECT pg_backend_pid()')
                holder = cursor.fetchone()[0]
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                writing = pool.submit(self.store.create_workspace,'new','New')
                try:
                    self._wait_for_contender(holder)
                finally:
                    held.rollback()
                writing.result(timeout=5)
        finally:
            held.close()

    def test_benchmark_two_experiments_contend_for_last_workspace_slot(self):
        from services.storage.benchmark_core import BenchmarkStore
        from services.storage.tests.test_benchmark_core import BenchmarkCoreTests
        _, token = self._datasets()
        benchmark = BenchmarkStore(self.store, definitions_verifier=lambda *_: True)
        def invoke(action, **body):
            return benchmark.dispatch(action, token, 'w', body)
        invoke('dataset_import', **BenchmarkCoreTests.dataset(self), operation_key='import')
        jobs = []
        for exp in ('alpha','beta'):
            invoke('create', dataset_id='bench', experiment={'id':exp,'name':exp,'scope':'benchmark','evaluatorIdsJson':'["benchmark:fixture"]','cases':[]},
                   selection={'mode':'all'}, run_config={'platform':'opencode','agent':'build','clientId':'client','legacyOwner':'author','timeoutSeconds':30},
                   adapter={'key':'fixture','evaluatorId':'benchmark:fixture','requiredArtifacts':[],
                            'evaluation':{'evaluatorKey':'fixture','defaultTimeoutSeconds':30}}, operation_key='create-'+exp)
            started = invoke('start',experiment_id=exp, scheduler_limits={'maxPendingEvaluations':1,'maxPendingEvaluationsPerUser':2},
                             public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='start-'+exp)
            jobs.append(started['runId'])
        def claim(job):
            return invoke('claim',job_id=job,worker_id='worker-'+job)
        with self._paused_writer(lambda: claim(jobs[0])) as (pool, first, holder):
            second = pool.submit(claim,jobs[1])
            self._wait_for_contender(holder)
        self.assertEqual(first.result()['job_id'],jobs[0])
        self.assertIsNone(second.result())
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute("SELECT count(*) FROM work_attempts WHERE status='running'").fetchone()[0],1)
            self.assertEqual(con.execute("SELECT count(*) FROM benchmark_jobs WHERE protocol_state='preparing'").fetchone()[0],1)

    def test_two_experiments_and_two_trace_workers_can_commit_independently(self):
        from services.storage.experiments import ExperimentStore
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_observations import Facts, packet
        _, token = self._datasets()
        experiments = ExperimentStore(self.store)
        for exp in ('first','second'):
            experiments.dispatch('create',token,'w',{'experiment':{'id':exp,'name':exp},'operation_key':'create-'+exp})
        def update(exp):
            return experiments.dispatch('update',token,'w',{'experiment_id':exp,'changes':{'name':'updated-'+exp},
                                                             'expected_revision':1,'operation_key':'update-'+exp})
        with self._paused_writer(lambda: update('first')) as (pool, first, _):
            self.assertEqual(pool.submit(update,'second').result(timeout=5)['experiment']['name'],'updated-second')
        first.result()

        ingest = ObservationIngest(self.store, Facts())
        one = ingest.accept(token,'w',packet())
        two = ingest.accept(token,'w',packet(trace='b'*32))
        event = ingest.delivery.claim('worker-one',30000)
        with self._paused_writer(lambda: ingest._prepare(event)) as (pool, first, _):
            self.assertTrue(pool.submit(ingest.work_once,'worker-two').result(timeout=5))
            self.assertEqual(ingest.batch_status(token,'w',two['batch_id'])['state'],'indexed')
        first.result()
        self.assertEqual(ingest.batch_status(token,'w',one['batch_id'])['state'],'prepared')

    def test_otlp_and_collector_share_last_ingest_slot(self):
        from services.storage.collector_sources import CollectorSources
        from services.storage.iam import IAMStore
        from services.storage.observations import ObservationIngest
        from services.storage.control import Conflict
        from services.storage.tests.test_collector_sources import CollectorSourceTests, CurrentFacts
        from services.storage.tests.test_observations import packet
        _, token = self._datasets()
        api = IAMStore(self.store).issue_api_credential(token,'w',['read','write'])
        self.store.max_pending_ingest_batches = 1
        ingest = ObservationIngest(self.store,CurrentFacts())
        collector = CollectorSources(self.store,ingest)
        reservation = collector.reserve(api,'w',CollectorSourceTests.body(self))
        commit = dict(task_id='task',operation_key=reservation['operation_key'],expected_revision=reservation['base_revision'],
                      snapshot=CollectorSourceTests.snapshot(self))
        with self._paused_writer(lambda: ingest.accept(token,'w',packet())) as (pool, first, holder):
            second = pool.submit(collector.commit,api,'w',commit)
            self._wait_for_contender(holder)
        with self.assertRaises(Conflict) as failed:
            second.result()
        self.assertEqual(failed.exception.code,'QUEUE_LIMIT')
        self.assertTrue(ingest.work_once('worker'))
        self.assertEqual(ingest.batch_status(token,'w',first.result()['batch_id'])['state'],'indexed')
        self.assertTrue(collector.commit(api,'w',commit)['batch_refs'])
        with self.store.read_transaction() as con:
            queued = [r[0] for r in con.execute('SELECT created_at_ms FROM outbox_events WHERE event_type=? ORDER BY created_at_ms',('observability.otlp.accepted.v1',))]
            self.assertEqual(len(queued),2)
            self.assertLess(queued[0],queued[1])

    def test_interrupted_diagnosis_rejects_late_finish(self):
        from services.storage.authorized import AuthorizedStorage
        from services.storage.control import Conflict
        from services.storage.diagnosis import TraceDiagnosis
        from services.storage.iam import IAMStore
        _, token = self._datasets()
        AuthorizedStorage(IAMStore(self.store),None).create_trace(token,'w','trace','2026-11-12',source_namespace='test',native_trace_id='trace')
        diagnosis = TraceDiagnosis(self.store)
        turn = diagnosis.begin_turn(token,'w','trace',request_key='turn',message='question',evidence_hash='a'*64,lease_owner='worker')
        handle = dict(request_key='turn',lease_owner='worker',turn_fence=turn['turn']['fence'],expected_revision=turn['turn']['revision'])
        def finish(**values):
            return diagnosis.finish_turn(token,'w',turn['session']['id'],**handle,**values)
        with self._paused_writer(lambda: finish(content='partial',state='interrupted',error_code='cancelled')) as (pool, first, holder):
            second = pool.submit(finish,content='late model output')
            self._wait_for_contender(holder)
        first.result()
        with self.assertRaises(Conflict):
            second.result()
        with self.store.read_transaction() as con:
            self.assertEqual(tuple(con.execute("SELECT state,content FROM trace_diagnosis_messages WHERE role='assistant'").fetchone()),('interrupted','partial'))

    @unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'), 'isolated ClickHouse required')
    def test_trace_retired_during_clickhouse_publication_cannot_be_indexed(self):
        from services.storage.clickhouse import ClickHouseStore
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_observations import packet
        from services.storage.trace_metadata import TraceMetadata
        _, token = self._datasets()
        database = 'locks_' + uuid.uuid4().hex
        facts = ClickHouseStore(os.environ['STORAGE_TEST_CLICKHOUSE_URL'], database=database,
                                user=os.environ.get('STORAGE_TEST_CLICKHOUSE_USER','default'),
                                password=os.environ.get('STORAGE_TEST_CLICKHOUSE_PASSWORD',''))
        facts.initialize_new_database()
        self.addCleanup(lambda: facts._request('DROP DATABASE '+database, database='default'))
        ingest = ObservationIngest(self.store, facts)
        first = ingest.accept(token,'w',packet())
        trace = first['trace_ids'][0]
        self.assertTrue(ingest.work_once('first'))
        self.assertEqual(ingest.batch_status(token,'w',first['batch_id'])['state'],'indexed')
        later = ingest.accept(token,'w',packet(span='2'*16))
        written, release = threading.Event(), threading.Event()
        original = facts._insert
        def insert(table, rows):
            original(table, rows)
            if table == 'obs_trace_current':
                written.set()
                if not release.wait(20):
                    raise RuntimeError('publication was not released')
        with patch.object(facts,'_insert',insert), concurrent.futures.ThreadPoolExecutor(1) as pool:
            worker = pool.submit(ingest.work_once,'second')
            try:
                self.assertTrue(written.wait(10))
                self.assertTrue(TraceMetadata(self.store).delete(token,'w',trace))
            finally:
                release.set()
            worker.result(timeout=5)
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM trace_locators WHERE trace_id=?',(trace,)).fetchone()[0],'deleting')
            self.assertEqual(con.execute('SELECT state FROM ingest_batches WHERE batch_id=?',(later['batch_id'],)).fetchone()[0],'failed')
            self.assertEqual(con.execute('SELECT count(*) FROM deletion_requests WHERE resource_id=?',(trace,)).fetchone()[0],1)
        # The slow external write really committed; the control barrier must survive it.
        self.assertEqual(int(facts._request('SELECT count() FROM obs_span_current FINAL FORMAT TabSeparated').strip()),2)

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
