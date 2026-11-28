import json

from .contracts import identifier
from .control import Conflict
from .iam import IAMStore, Forbidden


def register_delivery(con, workspace, batch, event, traces):
    con.execute('INSERT INTO ingest_deliveries(workspace_id,batch_id,event_id) VALUES(?,?,?)',
                (workspace, batch, event))
    for trace in sorted(set(traces)):
        con.execute('INSERT INTO ingest_batch_traces(workspace_id,batch_id,trace_id) VALUES(?,?,?)', (workspace, batch, trace))


class IngestDelivery:
    def __init__(self, control):
        self.control = control
        self.iam = IAMStore(control)

    def _predecessors(self, con, event):
        return con.execute('''SELECT 1
            FROM ingest_batch_traces current_trace
            JOIN ingest_batch_traces previous_trace ON previous_trace.workspace_id=current_trace.workspace_id
                AND previous_trace.trace_id=current_trace.trace_id
            JOIN ingest_batches b ON b.workspace_id=previous_trace.workspace_id AND b.batch_id=previous_trace.batch_id
            JOIN ingest_deliveries d ON d.workspace_id=b.workspace_id AND d.batch_id=b.batch_id
            JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id
            WHERE current_trace.workspace_id=? AND current_trace.batch_id=? AND previous_trace.blocks_successors=1 AND b.state<>'indexed'
                AND (e.created_at_ms<? OR (e.created_at_ms=? AND e.event_id<?)) LIMIT 1''',
            (event['workspace_id'], event['aggregate_id'], event['created_at_ms'],
             event['created_at_ms'], event['event_id'])).fetchone()

    def fail(self, con, event, code, message, *, terminal):
        now = self.control.clock()
        ws, batch = event['workspace_id'], event['aggregate_id']
        con.execute('''UPDATE ingest_deliveries SET last_error_code=?,last_error_message=?,last_error_at_ms=?
            WHERE workspace_id=? AND batch_id=?''', (code, message, now, ws, batch))
        if terminal:
            con.execute("UPDATE ingest_batches SET state='failed',error_code=? WHERE workspace_id=? AND batch_id=?",
                        (code, ws, batch))
        attempts = event['attempts'] - event['attempt_base']
        delay = 0 if terminal else min(60000, 1000 * 2 ** min(attempts, 6))
        con.execute('''UPDATE outbox_events SET state=?,lease_owner=NULL,lease_until_ms=NULL,
            next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?''',
            ('dead' if terminal else 'pending', now + delay, now, ws, event['event_id']))

    @staticmethod
    def _eligible(con, now, event=None):
        target = 'e.workspace_id=? AND e.event_id=? AND' if event is not None else ''
        parameters = (event['workspace_id'], event['event_id'], now, now) if event is not None else (now, now)
        return con.execute(f"""SELECT e.*,d.attempt_base,d.attempt_limit
            FROM outbox_events e JOIN ingest_deliveries d
                ON d.workspace_id=e.workspace_id AND d.event_id=e.event_id
            WHERE {target} e.state IN ('pending','dispatching') AND e.next_attempt_at_ms<=?
                AND (e.state='pending' OR e.lease_until_ms IS NULL OR e.lease_until_ms<=?)
                AND NOT EXISTS (
                    SELECT 1 FROM ingest_batch_traces t JOIN ingest_batch_traces p
                        ON p.workspace_id=t.workspace_id AND p.trace_id=t.trace_id
                    JOIN ingest_batches b ON b.workspace_id=p.workspace_id AND b.batch_id=p.batch_id
                    JOIN ingest_deliveries pd ON pd.workspace_id=b.workspace_id AND pd.batch_id=b.batch_id
                    JOIN outbox_events pe ON pe.workspace_id=pd.workspace_id AND pe.event_id=pd.event_id
                    WHERE t.workspace_id=e.workspace_id AND t.batch_id=e.aggregate_id
                        AND p.blocks_successors=1 AND b.state IN ('accepted','prepared')
                        AND (pe.created_at_ms<e.created_at_ms OR (pe.created_at_ms=e.created_at_ms AND pe.event_id<e.event_id)))
            ORDER BY e.created_at_ms,e.event_id LIMIT 1""", parameters).fetchone()

    def claim(self, worker, lease_ms):
        with self.control.transaction(shared=(('ingest',),)) as con:
            for _ in range(64):
                candidate = self._eligible(con, self.control.clock())
                if candidate is None:
                    return None
                self.control.lock_keys(con, ('ingest', candidate['workspace_id'], candidate['aggregate_id']))
                # The lease or a predecessor may have changed while waiting for this batch.
                now = self.control.clock()
                row = self._eligible(con, now, candidate)
                if row is None:
                    continue
                event = dict(row)
                if self._predecessors(con, event):
                    self.fail(con, event, 'DEPENDENCY_FAILED', 'An earlier batch for this Trace failed', terminal=True)
                    continue
                if event['attempts'] - event['attempt_base'] >= event['attempt_limit']:
                    self.fail(con, event, 'RETRY_EXHAUSTED', 'Automatic execution limit reached', terminal=True)
                    continue
                attempt = event['attempts'] + 1
                con.execute('''UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,
                    lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?''',
                    (attempt, worker, now + lease_ms, now, event['workspace_id'], event['event_id']))
                event.update(attempts=attempt, lease_owner=worker, lease_until_ms=now + lease_ms)
                return event
        return None

    def status(self, con, workspace, batch):
        row = con.execute('''SELECT d.*,e.attempts,e.next_attempt_at_ms,e.state AS delivery_state
            FROM ingest_deliveries d JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id
            WHERE d.workspace_id=? AND d.batch_id=?''', (workspace, batch)).fetchone()
        if row is None:
            raise Conflict('Ingest delivery metadata unavailable')
        return dict(attempts=row['attempts'] - row['attempt_base'], total_attempts=row['attempts'],
                    max_attempts=row['attempt_limit'], recovery_generation=row['generation'],
                    next_attempt_at_ms=row['next_attempt_at_ms'] if row['delivery_state']=='pending' else None,
                    last_error_code=row['last_error_code'], last_error_message=row['last_error_message'],
                    last_error_at_ms=row['last_error_at_ms'])

    def recover(self, credential, workspace, batch, request_key):
        for value in (workspace, batch, request_key):
            identifier(value)
        with self.control.transaction(('ingest', workspace), ('trace', workspace)) as con:
            scope = self.iam._scope(con, credential)
            self.iam._workspace(scope, workspace, 'write')
            row = con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',
                              (workspace, batch)).fetchone()
            if row is None:
                raise Forbidden('Batch is not accessible')
            for trace in json.loads(row['trace_ids_json']):
                self.iam._authorize(con, credential, workspace, 'write', 'trace', trace)
                route = con.execute('SELECT state FROM trace_locators WHERE workspace_id=? AND trace_id=?',
                                    (workspace, trace)).fetchone()
                if route is None or route['state'] != 'active':
                    raise Conflict('Trace is not active')
                if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",
                               (workspace, trace)).fetchone():
                    raise Conflict('Trace has a deletion barrier')
            previous = con.execute('''SELECT generation,actor_principal_id FROM ingest_batch_recoveries
                WHERE workspace_id=? AND batch_id=? AND request_key=?''', (workspace, batch, request_key)).fetchone()
            if previous:
                if previous['actor_principal_id'] != scope.principal_id:
                    raise Forbidden('Recovery belongs to another actor')
                return dict(batch_id=batch, recovery_generation=previous['generation'], duplicate=True)
            delivery = con.execute('''SELECT e.*,d.attempt_base,d.generation,d.last_error_message,d.last_error_at_ms
                FROM ingest_deliveries d JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id
                WHERE d.workspace_id=? AND d.batch_id=?''', (workspace, batch)).fetchone()
            if delivery is None or row['state'] != 'failed' or delivery['state'] != 'dead':
                raise Conflict('Only a failed inactive batch can be recovered')
            if self._predecessors(con, delivery):
                raise Conflict('Recover and index earlier batches first')
            later = con.execute('''SELECT 1 FROM ingest_batch_traces t JOIN ingest_batch_traces n
                ON n.workspace_id=t.workspace_id AND n.trace_id=t.trace_id
                JOIN ingest_batches b ON b.workspace_id=n.workspace_id AND b.batch_id=n.batch_id
                JOIN ingest_deliveries d ON d.workspace_id=b.workspace_id AND d.batch_id=b.batch_id
                JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.event_id=d.event_id
                WHERE t.workspace_id=? AND t.batch_id=? AND b.plan_ref IS NOT NULL
                    AND (e.created_at_ms>? OR (e.created_at_ms=? AND e.event_id>?)) LIMIT 1''',
                (workspace, batch, delivery['created_at_ms'], delivery['created_at_ms'], delivery['event_id'])).fetchone()
            if later:
                raise Conflict('A later Trace version was already prepared; automatic recovery is unsafe')
            self.control.require_ingest_capacity(con, workspace)
            generation = delivery['generation'] + 1
            now = self.control.clock()
            con.execute('INSERT INTO ingest_batch_recoveries VALUES(?,?,?,?,?,?,?,?,?,?)',
                        (workspace, batch, request_key, generation, scope.principal_id, delivery['attempts'],
                         row['error_code'], delivery['last_error_message'], delivery['last_error_at_ms'], now))
            con.execute('UPDATE ingest_deliveries SET attempt_base=?,generation=? WHERE workspace_id=? AND batch_id=?',
                        (delivery['attempts'], generation, workspace, batch))
            con.execute('UPDATE ingest_batches SET state=?,error_code=NULL WHERE workspace_id=? AND batch_id=?',
                        ('prepared' if row['plan_ref'] else 'accepted', workspace, batch))
            con.execute("UPDATE outbox_events SET state='pending',next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",
                        (now, now, workspace, delivery['event_id']))
            return dict(batch_id=batch, recovery_generation=generation, duplicate=False)
