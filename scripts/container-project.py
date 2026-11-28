"""Supervise the production HTTP/WSS gateway and its loopback Storage Core."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request


def main():
    def stop(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    children = []
    config_path = sys.argv[1]
    config_dir = Path(os.environ['AGENT_INSIGHT_HOME']) / 'storage/core'
    core_file = config_dir / 'external-service.json'
    try:
        setup = subprocess.Popen(['node', 'scripts/container-project-config.cjs', config_path])
        children.append(setup)
        if setup.wait():
            return 1
        cfg = json.loads(core_file.read_text())
        origin = f"http://127.0.0.1:{cfg['port']}"
        env = {**os.environ, 'PYTHONPATH': os.getcwd(), 'AGENT_INSIGHT_STORAGE_CORE_URL': origin,
               'AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE': cfg['controller_key_file']}
        core = subprocess.Popen([sys.executable, '-m', 'services.storage.trace_service', '--config', core_file], env=env)
        children.append(core)
        deadline = time.monotonic() + 90
        while core.poll() is None and time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(origin + '/v1/health', timeout=5) as response:
                    if json.load(response)['status'] == 'ready':
                        break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError('Storage Core did not become ready')
        subprocess.run(['node', 'scripts/storage-core-preflight.cjs'], env=env, check=True)
        owner = json.loads(env['AGENT_INSIGHT_RUNTIME_OWNER'])
        web = subprocess.Popen(['node', 'scripts/control-server.js'], env=env, pass_fds=(owner['fd'],))
        children.append(web)
        while core.poll() is None and web.poll() is None:
            time.sleep(0.3)
        return 1
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    sys.exit(main())
