import copy
from contextlib import closing
import json
import io
import os
from contextlib import redirect_stdout, redirect_stderr
import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.control import Conflict, SQLiteControlStore, StorageError
from services.storage.iam import Forbidden, Unauthorized
from services.storage.ingest_delivery import IngestDelivery
from services.storage.tests import test_observations as fixtures

Facts, packet = fixtures.Facts, fixtures.packet


class DeliveryTests(unittest.TestCase):
    setUp = fixtures.ObservationTests.setUp
    make_control = fixtures.ObservationTests.make_control
    rows = fixtures.ObservationTests.rows

    def accept(self, trace='a', span='1', owner='alice'):
        return self.service.accept(self.tokens[owner], 'w', packet(trace=trace*32, span=span*16))

    def status(self, receipt, owner='alice'):
        return self.service.batch_status(self.tokens[owner], 'w', receipt['batch_id'])

    def exhaust(self, receipt):
        with patch.object(self.facts, 'write_spans', side_effect=OSError('secret backend URL')):
            for attempt, delay in enumerate((2000, 4000, 8000, 16000, 0), 1):
                self.assertTrue(self.service.work_once('worker'))
                status = self.status(receipt)
                self.assertEqual(status['attempts'], attempt)
                self.assertNotIn('secret', json.dumps(status))
                self.assertEqual(status['next_attempt_at_ms'], self.now+delay if delay else None)
                self.now += delay
        self.assertEqual(self.status(receipt)['error_code'], 'RETRY_EXHAUSTED')

    def test_five_attempts_persist_across_restart_and_duplicate_upload(self):
        receipt = self.accept()
        self.exhaust(receipt)
        frozen = self.rows('ingest_batches')[0]
        self.service = self.cls(self.control, self.facts)
        duplicate = self.accept()
        self.assertEqual(duplicate['batch_id'], receipt['batch_id'])
        self.assertEqual(duplicate['state'], 'failed')
        self.assertFalse(self.service.work_once('new-worker'))
        self.assertEqual(self.status(receipt)['attempts'], 5)
        self.assertEqual(self.rows('ingest_batches')[0], frozen)
        self.assertTrue(Path(frozen['packet_ref']).is_file())
        self.assertTrue(Path(frozen['plan_ref']).is_file())

    def test_other_user_progresses_during_backoff_and_same_trace_waits(self):
        first = self.accept()
        self.facts.fail_summary = True
        self.service.work_once('worker')
        later = self.accept(span='2')
        independent = self.accept(trace='b', owner='bob')
        self.assertTrue(self.service.work_once('worker'))
        self.assertEqual(self.status(independent, 'bob')['state'], 'indexed')
        self.assertEqual(self.status(later)['attempts'], 0)
        self.assertFalse(self.service.work_once('worker'))
        self.now += 2000
        self.service.work_once('worker')
        self.service.work_once('worker')
        self.assertEqual(self.status(first)['state'], 'indexed')
        self.assertEqual(self.status(later)['state'], 'indexed')
        self.assertEqual(self.facts.summaries[-1]['span_count'], 2)

    def test_mixed_batch_preserves_dependencies_for_every_trace(self):
        first = self.accept()
        self.facts.fail_summary = True
        self.service.work_once('worker')
        mixed = packet(span='2'*16)
        mixed['resourceSpans'] += packet(trace='b'*32)['resourceSpans']
        joined = self.service.accept(self.tokens['alice'], 'w', mixed)
        after = self.accept(trace='b', span='3')
        other = self.accept(trace='c', owner='bob')
        self.service.work_once('worker')
        self.assertEqual(self.status(other, 'bob')['state'], 'indexed')
        self.assertEqual(self.status(joined)['attempts'], 0)
        self.assertEqual(self.status(after)['attempts'], 0)
        self.now += 2000
        for receipt in (first, joined, after):
            self.assertTrue(self.service.work_once('worker'))
            self.assertEqual(self.status(receipt)['state'], 'indexed')

    def test_terminal_dependency_and_authorized_idempotent_recovery_keep_plan(self):
        first = self.accept()
        later = self.accept(span='2')
        self.exhaust(first)
        self.service.work_once('worker')
        self.assertEqual(self.status(later)['error_code'], 'DEPENDENCY_FAILED')
        frozen = copy.deepcopy(next(row for row in self.rows('ingest_batches') if row['batch_id'] == first['batch_id']))
        recovery = self.service.delivery.recover
        with self.assertRaises(Forbidden):
            recovery(self.tokens['bob'], 'w', first['batch_id'], 'recover-1')
        with self.assertRaises(Conflict):
            recovery(self.tokens['alice'], 'w', later['batch_id'], 'recover-later')
        result = recovery(self.tokens['alice'], 'w', first['batch_id'], 'recover-1')
        self.assertEqual(result['recovery_generation'], 1)
        self.assertEqual(self.status(first)['attempts'], 0)
        self.assertEqual(self.status(first)['total_attempts'], 5)
        self.assertTrue(recovery(self.tokens['alice'], 'w', first['batch_id'], 'recover-1')['duplicate'])
        with self.assertRaises(Conflict):
            recovery(self.tokens['alice'], 'w', first['batch_id'], 'another-key')
        self.service.work_once('worker')
        current = next(row for row in self.rows('ingest_batches') if row['batch_id'] == first['batch_id'])
        self.assertEqual(current['state'], 'indexed')
        for name in ('plan_ref', 'packet_ref', 'packet_hash'):
            self.assertEqual(current[name], frozen[name])
        self.assertEqual(self.status(first)['total_attempts'], 6)
        recovery(self.tokens['alice'], 'w', later['batch_id'], 'recover-later')
        self.service.work_once('worker')
        self.assertEqual(self.status(later)['state'], 'indexed')
        self.assertEqual(self.facts.summaries[-1]['span_count'], 2)
        self.assertEqual(len(self.rows('ingest_batch_recoveries')), 2)

    def test_crash_leases_count_toward_limit_and_old_worker_cannot_complete(self):
        from services.storage.observations import _LeaseLost
        first = self.accept()
        old = None
        for _ in range(5):
            old = self.service._claim('crashed', 1000)
            self.assertIsNotNone(old)
            self.assertIsNone(self.service._claim('other', 1000))
            self.now += 1001
        independent = self.accept(trace='b', owner='bob')
        self.service.work_once('other')
        self.assertEqual(self.status(first)['error_code'], 'RETRY_EXHAUSTED')
        self.assertEqual(self.status(independent, 'bob')['state'], 'indexed')
        self.service.delivery.recover(self.tokens['alice'], 'w', first['batch_id'], 'recover')
        with self.control.transaction() as con:
            with self.assertRaises(_LeaseLost):
                self.service._owned(con, old)
        event = self.service._claim('new-worker', 1000)
        self.assertEqual(event['attempts'], 6)
        with self.control.transaction() as con:
            with self.assertRaises(_LeaseLost):
                self.service._owned(con, old)

    def test_recovery_respects_capacity_and_current_write_permission(self):
        first = self.accept()
        self.exhaust(first)
        self.control.max_pending_ingest_batches = 1
        self.accept(trace='b', owner='bob')
        with self.assertRaises(Conflict):
            self.service.delivery.recover(self.tokens['alice'], 'w', first['batch_id'], 'capacity')
        self.assertEqual(self.rows('ingest_batch_recoveries'), [])
        self.iam.revoke_credential(self.tokens['alice'])
        with self.assertRaises(Unauthorized):
            self.service.delivery.recover(self.tokens['alice'], 'w', first['batch_id'], 'revoked')
        self.assertEqual(self.rows('ingest_batch_recoveries'), [])

    def test_recovery_cli_checks_private_credentials_and_reports_receipt(self):
        from services.storage.__main__ import main
        from types import SimpleNamespace
        from unittest.mock import Mock
        first=self.accept();self.exhaust(first)
        credential=Path(self.tmp.name)/'credential.txt'
        credential.write_text(self.tokens['alice']);credential.chmod(0o600)
        runtime=SimpleNamespace(ingest=self.service,close=Mock())
        args=['recover-ingest','--config','/private/core.json','--credential-file',str(credential),
              '--workspace','w','--batch',first['batch_id'],'--request-key','cli-recovery']
        output=io.StringIO()
        with patch('services.storage.trace_service.runtime_from_config',return_value=(runtime,{})),redirect_stdout(output):
            self.assertEqual(main(args),0)
            self.assertEqual(main(args),0)
        receipts=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertFalse(receipts[0]['duplicate']);self.assertTrue(receipts[1]['duplicate'])
        self.assertEqual(runtime.close.call_count,2)
        self.assertNotIn(self.tokens['alice'],output.getvalue())
        credential.chmod(0o644)
        with patch('services.storage.trace_service.runtime_from_config') as start,redirect_stderr(io.StringIO()):
            self.assertEqual(main(args),1);start.assert_not_called()

    def test_recovery_rejects_trace_deletion_barrier(self):
        first=self.accept();self.exhaust(first)
        trace=first['trace_ids'][0]
        with self.control.transaction() as con:
            con.execute("INSERT INTO deletion_requests VALUES(?,?,?,?,1,1,'requested','alice',?,?)",('w','deletion','trace',trace,self.now,self.now))
        with self.assertRaises(Conflict):
            self.service.delivery.recover(self.tokens['alice'],'w',first['batch_id'],'after-delete')
        self.assertEqual(self.rows('ingest_batch_recoveries'),[])


@unittest.skipUnless(os.environ.get('STORAGE_OBSERVATIONS_PG_CONFIG'),'optional isolated PostgreSQL configuration required')
class PostgreSQLDeliveryTests(DeliveryTests):
    make_control = fixtures.PostgreSQLObservationTests.make_control


class UpgradeTests(unittest.TestCase):
    setUp = fixtures.ObservationTests.setUp
    make_control = fixtures.ObservationTests.make_control
    def test_previous_sqlite_copy_upgrades_via_cli_and_retains_data(self):
        from services.storage.migrations import load_migrations
        from services.storage.iam import IAMStore
        known = load_migrations('sqlite')
        source = Path(self.tmp.name)/'old.db'
        old = SQLiteControlStore(source, clock=lambda:self.now)
        with patch('services.storage.migrations.load_migrations', return_value=known[:20]):
            old.initialize()
        iam = IAMStore(old)
        iam.create_principal('alice','alice','Alice')
        old.create_workspace('w','Workspace')
        iam.bind_workspace('w',principal_id='alice')
        token = iam.issue_session_for_provisioning('alice')
        legacy = object.__new__(self.cls)
        legacy.control, legacy.iam, legacy.facts = old, iam, Facts()
        receipts = []
        with patch('services.storage.observations.register_delivery'):
            for n in range(5):
                receipts.append(legacy.accept(token,'w',packet(trace=str(n+1)*32)))
        with old.transaction() as con:
            for n, receipt in enumerate(receipts[1:],1):
                event = dict(con.execute('SELECT * FROM outbox_events WHERE aggregate_id=?',(receipt['batch_id'],)).fetchone())
                con.execute("UPDATE outbox_events SET state='dispatching',attempts=1,lease_owner='old-worker',lease_until_ms=? WHERE event_id=?",(self.now+30000,event['event_id']))
                event.update(attempts=1,lease_owner='old-worker')
                # Prepare using a separate transaction after releasing the writer lock.
                receipts[n]['event'] = event
        for n in (1,2):
            legacy._prepare(receipts[n]['event'])
        with old.transaction() as con:
            con.execute("UPDATE ingest_batches SET state='indexed',indexed_at_ms=? WHERE batch_id=?",(self.now,receipts[2]['batch_id']))
            con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL WHERE aggregate_id=?",(receipts[2]['batch_id'],))
            con.execute("UPDATE ingest_batches SET state='failed',error_code='legacy_failure' WHERE batch_id=?",(receipts[3]['batch_id'],))
            con.execute("UPDATE outbox_events SET state='dead',lease_owner=NULL,lease_until_ms=NULL WHERE aggregate_id=?",(receipts[3]['batch_id'],))
            con.execute("UPDATE outbox_events SET attempts=8 WHERE aggregate_id=?",(receipts[4]['batch_id'],))
        with patch('services.storage.observations.register_delivery'):
            successor=legacy.accept(token,'w',packet(trace='4'*32,span='2'*16))
        with old.transaction() as con:
            event=dict(con.execute('SELECT * FROM outbox_events WHERE aggregate_id=?',(successor['batch_id'],)).fetchone())
            con.execute("UPDATE outbox_events SET state='dispatching',attempts=1,lease_owner='old-worker',lease_until_ms=? WHERE event_id=?",(self.now+30000,event['event_id']))
            event.update(attempts=1,lease_owner='old-worker')
        legacy._prepare(event)
        tables=('ingest_batches','outbox_events','obs_entity_heads','trace_locators','iam_resource_access')
        with old.read_transaction() as con:
            before={name:[dict(r) for r in con.execute('SELECT * FROM '+name)] for name in tables}
        preserved=Path(self.tmp.name)/'previous-version.db'
        with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(preserved)) as dst:src.backup(dst)
        target=source
        command=[sys.executable,'-m','services.storage','migrate-sqlite','--database',str(target),'--backup',str(Path(self.tmp.name)/'pre-21.db')]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        upgraded=SQLiteControlStore(target,clock=lambda:self.now)
        with upgraded.read_transaction() as con:
            for name in tables:self.assertEqual([dict(r) for r in con.execute('SELECT * FROM '+name)],before[name])
            self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_deliveries').fetchone()[0],6)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batch_traces').fetchone()[0],6)
            self.assertEqual(list(con.execute('PRAGMA foreign_key_check')),[])
        self.assertEqual(SQLiteControlStore(preserved).migration_plan()['current_version'],20)
        command[-1]=str(Path(self.tmp.name)/'second-backup.db')
        again=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(again.returncode,0,again.stderr)
        self.assertEqual(upgraded.migration_plan()['pending'],[])
        service=self.cls(upgraded,Facts())
        self.assertEqual(service.batch_status(token,'w',receipts[2]['batch_id'])['state'],'indexed')
        self.assertEqual(service.batch_status(token,'w',receipts[4]['batch_id'])['attempts'],8)

        config=Path(self.tmp.name)/'runtime.json'
        config.write_text(json.dumps({'control':{'backend':'sqlite','database':str(target)},'clickhouse':{},'cursor_secret_hex':'ab'*32}))
        config.chmod(0o600)
        from services.storage.trace_service import runtime_from_config
        with patch('services.storage.clickhouse.ClickHouseStore') as backend:
            runtime,_=runtime_from_config(config)
            self.assertEqual(runtime.max_concurrent_requests,64)
            runtime.close()
            runtime,_=runtime_from_config(config)
            runtime.close()
        self.assertTrue(service.work_once('upgrade-worker'))
        self.assertEqual(service.batch_status(token,'w',receipts[0]['batch_id'])['state'],'indexed')

        with upgraded.read_transaction() as con:
            self.assertEqual(con.execute('SELECT blocks_successors FROM ingest_batch_traces WHERE batch_id=?',(receipts[3]['batch_id'],)).fetchone()[0],0)
        with self.assertRaisesRegex(Conflict,'later Trace version'):
            service.delivery.recover(token,'w',receipts[3]['batch_id'],'unsafe-historical-recovery')
        subsequent=service.accept(token,'w',packet(trace='4'*32,span='3'*16))
        self.now+=30001
        for _ in range(8):service.work_once('upgrade-worker')
        self.assertEqual(service.batch_status(token,'w',successor['batch_id'])['state'],'indexed')
        self.assertEqual(service.batch_status(token,'w',subsequent['batch_id'])['state'],'indexed')
        self.assertEqual(service.batch_status(token,'w',receipts[4]['batch_id'])['error_code'],'RETRY_EXHAUSTED')

    def test_migration_rejects_unmapped_batch_atomically(self):
        from services.storage.migrations import load_migrations
        from services.storage.iam import IAMStore
        known=load_migrations('sqlite')
        store=SQLiteControlStore(Path(self.tmp.name)/'unmapped.db',clock=lambda:self.now)
        with patch('services.storage.migrations.load_migrations',return_value=known[:20]):store.initialize()
        iam=IAMStore(store)
        iam.create_principal('alice','alice','Alice')
        store.create_workspace('w','Workspace');iam.bind_workspace('w',principal_id='alice')
        token=iam.issue_session_for_provisioning('alice')
        legacy=object.__new__(self.cls);legacy.control,legacy.iam=store,iam
        with patch('services.storage.observations.register_delivery'):
            legacy.accept(token,'w',packet())
        with store.transaction() as con:con.execute('DELETE FROM outbox_events')
        with self.assertRaises(StorageError):store.migrate(backup_path=Path(self.tmp.name)/'unmapped-backup.db')
        self.assertEqual(store.migration_plan()['current_version'],20)
        with store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM ingest_batches').fetchone()[0],1)
            self.assertIsNone(con.execute("SELECT name FROM sqlite_master WHERE name='ingest_deliveries'").fetchone())

    def test_catalog_matches_migrated_sqlite(self):
        catalog=json.loads((Path(__file__).resolve().parents[1]/'schema/ingest-retry-catalog.json').read_text())
        with self.control.read_transaction() as con:
            for table in catalog['tables']:
                columns=list(con.execute('PRAGMA table_info('+table['name']+')'))
                self.assertEqual([c['name'] for c in table['columns']],[r[1] for r in columns])
                self.assertEqual([c['nullable'] for c in table['columns']],[not bool(r[3]) for r in columns])
                self.assertEqual([c['default'] for c in table['columns']],[r[4] for r in columns])
