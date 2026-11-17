import hashlib
import hmac
import os
from pathlib import Path
import re
import stat

PURPOSES=frozenset({'experiment-cancellation/v1','experiment-frozen-assets/v1','experiment-background/v1','workbench-handoff/v1','experiment-execution/v1','benchmark-device/v1','trace-analytics/v1','collector-source/v1','infra/v1'})

def read_controller_key(file):
    path=Path(file)
    if not path.is_absolute() or path.is_symlink():raise ValueError('Private controller credential required')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_size>1024:raise ValueError('Private controller credential required')
        raw=stream.read(1025).decode('ascii').strip()
    if not re.fullmatch('[a-f0-9]{64}',raw):raise ValueError('Private controller credential required')
    return bytes.fromhex(raw)

def verify_controller_proof(file,purpose,principal,workspace,payload_hash,proof):
    if purpose not in PURPOSES or any(not isinstance(value,str) or not value or len(value)>512 or '\0' in value for value in (principal,workspace)):return False
    if not isinstance(payload_hash,str) or not re.fullmatch('[a-f0-9]{64}',payload_hash) or not isinstance(proof,str) or not re.fullmatch('[a-f0-9]{64}',proof):return False
    try:key=read_controller_key(file)
    except (OSError,ValueError,TypeError,UnicodeError):return False
    expected=hmac.new(key,'\0'.join((purpose,principal,workspace,payload_hash)).encode(),hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected,proof)
