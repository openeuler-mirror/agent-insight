import hashlib
from pathlib import Path
import tempfile
import unittest

class ControllerProtocolTests(unittest.TestCase):
    def test_cross_runtime_proof_binds_actor_workspace_purpose_and_exact_body_digest(self):
        from services.storage.controller_protocol import verify_controller_proof
        with tempfile.TemporaryDirectory() as tmp:
            key=Path(tmp)/'key';key.write_text('a'*64);key.chmod(0o600)
            digest=hashlib.sha256(b'{"action":"cancellation_update","status":"completed"}').hexdigest();proof='d2e14d5bc0653700179888c93846e99fb852325c14c0020b03fde3902cb2309d'
            self.assertTrue(verify_controller_proof(key,'experiment-cancellation/v1','principal','w',digest,proof))
            for purpose,principal,workspace,value in [('experiment-frozen-assets/v1','principal','w',digest),('experiment-cancellation/v1','other','w',digest),('experiment-cancellation/v1','principal','other',digest),('experiment-cancellation/v1','principal','w','b'*64)]:self.assertFalse(verify_controller_proof(key,purpose,principal,workspace,value,proof))
            key.chmod(0o644);self.assertFalse(verify_controller_proof(key,'experiment-cancellation/v1','principal','w',digest,proof));key.chmod(0o600)
            link=Path(tmp)/'link';link.symlink_to(key);self.assertFalse(verify_controller_proof(link,'experiment-cancellation/v1','principal','w',digest,proof))
