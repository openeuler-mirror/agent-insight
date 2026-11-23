"""Inert history authority used by explicit legacy imports and runtime guards."""
import hashlib
import json

from .control import Conflict

INERT_SOURCE = 'legacy-inert-control/v1'
HISTORY_FENCE_VERSION = 1
INERT_CONTROL_KINDS = frozenset({
    'batchEvalTask', 'grayscaleTask', 'skillWorkbenchTask',
    'reliabilityInstallToken', 'reliabilityClient', 'reliabilityClientCredential',
    'reliabilityCommand', 'reliabilityConfigDelivery', 'skillDeployment',
    'faultInjectionTask', 'faultInjectionRun', 'faultInjectionWorker',
})


def control_history_key(kind, identity):
    return hashlib.sha256(json.dumps([kind, identity], ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def is_historical_control(con, workspace, kind, identity):
    return con.execute('SELECT 1 FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',
                       (workspace, INERT_SOURCE, control_history_key(kind, identity))).fetchone() is not None


def assert_control_live(con, workspace, kind, identity):
    if is_historical_control(con, workspace, kind, identity):
        raise Conflict('Imported historical control is inert; create a new live operation')
