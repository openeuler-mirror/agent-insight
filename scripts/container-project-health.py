import json
import os
from pathlib import Path
from urllib.request import urlopen

config = json.loads((Path(os.environ['AGENT_INSIGHT_HOME']) / 'storage/core/external-service.json').read_text())
with urlopen(f"http://127.0.0.1:{config['port']}/v1/health", timeout=3) as response:
    if json.load(response)['status'] != 'ready':
        raise SystemExit(1)
with urlopen(f"http://127.0.0.1:{os.environ.get('PORT', '3000')}/login", timeout=3) as response:
    if response.status != 200:
        raise SystemExit(1)
