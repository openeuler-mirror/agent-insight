#!/usr/bin/env python3
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import fcntl
import json
import os
import stat
import sys
import uuid


def main():
    if len(sys.argv) < 3:
        print("Usage: container-runtime.py HOME COMMAND [ARG ...]", file=sys.stderr)
        return 2

    descriptor = None
    try:
        scope = os.path.realpath(sys.argv[1])
        if not os.path.isdir(scope):
            raise OSError("runtime HOME must be an existing directory")
        lock_path = os.path.join(scope, ".runtime-owner.lock")
        descriptor = os.open(
            lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
        )
        held = os.fstat(descriptor)
        if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1:
            raise OSError("runtime lock must be a regular file with one link")
        # Docker Desktop's fakeowner mount can isolate locks on a newly created handle.
        os.close(descriptor)
        descriptor = None
        descriptor = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        reopened = os.fstat(descriptor)
        if (not stat.S_ISREG(reopened.st_mode) or reopened.st_nlink != 1
                or reopened.st_ino != held.st_ino or reopened.st_dev != held.st_dev):
            raise OSError("runtime lock path changed while reopening ownership guard")
        held = reopened
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[container-runtime] runtime HOME is already in use by another service", file=sys.stderr)
            return 1
        current = os.lstat(lock_path)
        if current.st_ino != held.st_ino or current.st_dev != held.st_dev:
            raise OSError("runtime lock path changed while acquiring ownership")

        owner = {"version": 1, "id": str(uuid.uuid4()), "scope": scope}
        payload = json.dumps(owner, separators=(",", ":")).encode("utf-8")
        os.ftruncate(descriptor, 0)
        if os.write(descriptor, payload) != len(payload):
            raise OSError("runtime lock owner could not be written completely")
        os.set_inheritable(descriptor, True)
        environment = os.environ.copy()
        environment["AGENT_INSIGHT_RUNTIME_OWNER"] = json.dumps(
            {**owner, "fd": descriptor}, separators=(",", ":")
        )
        # Keep this inode and descriptor: unlinking the guard would allow two owners.
        os.execvpe(sys.argv[2], sys.argv[2:], environment)
    except OSError as error:
        print(f"[container-runtime] runtime lock unavailable: {error}", file=sys.stderr)
        return 1
    finally:
        if descriptor is not None:
            os.close(descriptor)


if __name__ == "__main__":
    sys.exit(main())
