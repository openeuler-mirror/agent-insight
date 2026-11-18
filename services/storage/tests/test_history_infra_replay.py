import unittest
from services.storage.control import Conflict
from services.storage.legacy_history import INERT_SOURCE, control_history_key, is_historical_control
from services.storage.tests import test_infra as fixtures


class HistoricalInfraReplayTests(unittest.TestCase):
    def test_config_changes_cannot_promote_history_or_accept_new_samples(self):
        fixture=fixtures.InfraTests('runTest');fixture.setUp();self.addCleanup(fixture.doCleanups)
        source=fixture.source();identity=source['id']
        with fixture.control.transaction() as con:con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',('w',INERT_SOURCE,control_history_key('infraSource',identity),'a'*64,fixture.control.clock()))
        changed=fixture.store.ensure_source(fixture.token,'w',{'endpoint':source['endpoint'],'scrapeUrl':'http://changed.invalid/metrics','kind':'pull','model':'updated'})
        self.assertEqual(changed['id'],identity)
        fixture.store.patch_source(fixture.token,'w',identity,{'enabled':True})
        self.assertEqual(fixture.store.ingest_source(fixture.token,'w',source['endpoint'],'updated')['id'],identity)
        with fixture.control.read_transaction() as con:
            self.assertTrue(is_historical_control(con,'w','infraSource',identity))
            before=(con.execute('SELECT COUNT(*) FROM inbox_receipts').fetchone()[0],con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0])
        artifacts=set(fixture.control.artifact_directory.glob('*'))
        with self.assertRaises(Conflict):fixture.store.assert_pollable(fixture.token,'w',identity)
        with self.assertRaises(Conflict):fixture.store.accept_sample(fixture.token,'w',identity,'new-history-sample',fixture.raw())
        with fixture.control.read_transaction() as con:
            self.assertEqual((con.execute('SELECT COUNT(*) FROM inbox_receipts').fetchone()[0],con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0]),before)
        self.assertEqual(set(fixture.control.artifact_directory.glob('*')),artifacts)
        self.assertTrue(fixture.store.get_source(fixture.token,'w',source_id=identity)['enabled'])
        self.assertEqual(fixture.store.list_sources(fixture.token,'w',own_only=True,live_only=True),[])
        live=fixture.store.ensure_source(fixture.token,'w',{'endpoint':'http://new-live.invalid','scrapeUrl':'http://new-live.invalid/metrics','kind':'pull'})
        self.assertNotEqual(live['id'],identity)
        accepted=fixture.store.accept_sample(fixture.token,'w',live['id'],'new-live-sample',fixture.raw())
        self.assertEqual(accepted['state'],'accepted');self.assertTrue(fixture.store.project_once('history-fence-test'))
        self.assertEqual(len(fixture.store.query_samples(fixture.token,'w',live['id'])['rows']),1)
