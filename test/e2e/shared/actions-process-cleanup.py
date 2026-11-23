import json
import os
import re
import select
import signal
import sys
import time


def exited(fd):
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    return bool(poller.poll(0))


def protected_processes():
    protected = {1}
    current = os.getpid()
    while current > 1 and current not in protected:
        protected.add(current)
        try:
            with open(f'/proc/{current}/stat', encoding='utf8') as stream:
                current = int(stream.read().rsplit(')', 1)[1].split()[1])
        except (FileNotFoundError, ProcessLookupError):
            break
    return protected


def check_support():
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
        with open('/proc/self/environ', 'rb') as stream:
            stream.read()
    finally:
        os.close(fd)


def process_identity(pid):
    with open(f'/proc/{pid}/stat', encoding='utf8') as stream:
        fields = stream.read().rsplit(')', 1)[1].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise ValueError('Unverifiable process identity')
    return pid, fields[19]


def baseline_processes():
    identities = []
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                identities.append(process_identity(int(name)))
            except (FileNotFoundError, ProcessLookupError):
                pass
    return identities


def owned_handles(marker, protected, baseline, unknown):
    for name in os.listdir('/proc'):
        if not name.isdigit() or int(name) in protected:
            continue
        pid, fd = int(name), None
        try:
            # Bind the signal target before inspecting env, so a reused PID cannot redirect it.
            try:
                fd = os.pidfd_open(pid)
            except PermissionError:
                try:
                    identity = process_identity(pid)
                    if identity not in baseline:
                        unknown.add(identity)
                except (FileNotFoundError, ProcessLookupError):
                    pass
                except (OSError, ValueError, IndexError):
                    unknown.add((pid, None))
                continue
            if exited(fd):
                continue
            try:
                identity = process_identity(pid)
            except (FileNotFoundError, ProcessLookupError):
                if not exited(fd):
                    unknown.add((pid, None))
                continue
            except (OSError, ValueError, IndexError):
                unknown.add((pid, None))
                continue
            if identity in baseline:
                continue
            try:
                with open(f'/proc/{pid}/environ', 'rb') as stream:
                    owned = marker in stream.read().split(b'\0')
            except (OSError, ValueError):
                if not exited(fd):
                    unknown.add(identity)
                continue
            if owned and not exited(fd):
                owned_fd, fd = fd, None
                yield pid, owned_fd
        except (FileNotFoundError, ProcessLookupError):
            pass
        finally:
            if fd is not None:
                os.close(fd)


def send(fd, value):
    try:
        signal.pidfd_send_signal(fd, value)
    except ProcessLookupError:
        pass


def cleanup(token, baseline):
    marker = b'E2E_ACTIONS_PROCESS_SCOPE=' + token.encode('ascii')
    protected = protected_processes()
    tracked = {}
    stopped = 0
    deadline = time.monotonic() + 6
    empty_scans = 0
    unknown = set()
    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            unknown = set()
            for pid, fd in owned_handles(marker, protected, baseline, unknown):
                previous = tracked.get(pid)
                if previous is not None and not exited(previous[0]):
                    os.close(fd)
                    continue
                if previous is not None:
                    os.close(previous[0])
                tracked[pid] = (fd, now)
                stopped += 1
                send(fd, signal.SIGTERM)
            alive = [(fd, started) for fd, started in tracked.values() if not exited(fd)]
            for fd, started in alive:
                if now - started >= 1:
                    send(fd, signal.SIGKILL)
            if not alive and not unknown:
                empty_scans += 1
                if empty_scans >= 2:
                    return {'status': 'PASS', 'stopped': stopped, 'remaining': 0}
            else:
                empty_scans = 0
            time.sleep(0.025)
        remaining = len(unknown) + sum(not exited(fd) for fd, _ in tracked.values())
        return {'status': 'BLOCKED', 'stopped': stopped, 'remaining': remaining}
    finally:
        for fd, _ in tracked.values():
            os.close(fd)


def main():
    payload = json.load(sys.stdin)
    check_support()
    if payload == {'operation': 'check'}:
        return {'status': 'PASS', 'baseline': baseline_processes()}
    if payload.get('operation') != 'cleanup' or not re.fullmatch('[a-f0-9]{64}', payload.get('token', '')):
        raise ValueError('Invalid cleanup request')
    rows = payload.get('baseline', [])
    if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], int) or row[0] <= 0 or not isinstance(row[1], str) or not re.fullmatch('[0-9]{1,30}', row[1]) for row in rows):
        raise ValueError('Invalid cleanup baseline')
    return cleanup(payload['token'], {tuple(row) for row in rows})


try:
    result = main()
except Exception:
    result = {'status': 'BLOCKED'}
print(json.dumps(result))
sys.exit(0 if result['status'] == 'PASS' else 1)
