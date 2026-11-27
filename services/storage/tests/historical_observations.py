"""Populate pre-021 migration fixtures using the outbox present in those schemas."""
from contextlib import contextmanager
from unittest.mock import patch

from services.storage import observations
from services.storage.iam import IAMStore


class _HistoricalDelivery:
    def __init__(self, control):
        self.control = control

    def claim(self, worker, lease_ms):
        with self.control.transaction() as con:
            now = self.control.clock()
            row = con.execute("""SELECT * FROM outbox_events WHERE event_type=? AND state='pending'
                ORDER BY created_at_ms,event_id LIMIT 1""", (observations.EVENT_TYPE,)).fetchone()
            if row is None:
                return None
            attempt = row['attempts'] + 1
            con.execute("""UPDATE outbox_events SET state='dispatching', attempts=?, lease_owner=?,
                lease_until_ms=?, updated_at_ms=? WHERE workspace_id=? AND event_id=?""",
                (attempt, worker, now+lease_ms, now, row['workspace_id'], row['event_id']))
            return dict(row, attempts=attempt, lease_owner=worker, lease_until_ms=now+lease_ms)

    def status(self, con, workspace, batch):
        return {}


@contextmanager
def pre021_ingest_fixture():
    def initialize(ingest, control, facts):
        with control.read_transaction() as con:
            version = con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0]
            if version not in (13, 14, 15):
                raise AssertionError('historical ingestion requires the original migration fixture schema')
        ingest.control, ingest.facts, ingest.iam = control, facts, IAMStore(control)
        ingest.delivery = _HistoricalDelivery(control)

    # Version 021 added a delivery ledger. The historical writer only recorded
    # the batch and outbox, which the original migration snapshots must retain.
    with patch.object(observations.ObservationIngest, '__init__', initialize), patch.object(observations, 'register_delivery', return_value=None):
        yield
