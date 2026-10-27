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

import importlib
import sys
import types
import unittest


class HookInheritanceTest(unittest.TestCase):
    def test_runtime_hooks_inherit_qwenpaw_hookbase(self):
        class HookBase:
            pass

        class HookResult:
            pass

        class Phase:
            PRE_EXECUTE = object()
            FINALLY = object()

        previous = {name: sys.modules.get(name) for name in [
            "qwenpaw",
            "qwenpaw.runtime",
            "qwenpaw.runtime.hooks",
            "qwenpaw.runtime.phases",
            "qwenpaw_insight.hooks",
        ]}
        sys.modules.pop("qwenpaw_insight.hooks", None)
        qwenpaw_mod = types.ModuleType("qwenpaw")
        qwenpaw_mod.__path__ = []
        sys.modules["qwenpaw"] = qwenpaw_mod
        sys.modules["qwenpaw.runtime"] = types.ModuleType("qwenpaw.runtime")
        hooks_mod = types.ModuleType("qwenpaw.runtime.hooks")
        hooks_mod.HookBase = HookBase
        hooks_mod.HookResult = HookResult
        phases_mod = types.ModuleType("qwenpaw.runtime.phases")
        phases_mod.Phase = Phase
        sys.modules["qwenpaw.runtime.hooks"] = hooks_mod
        sys.modules["qwenpaw.runtime.phases"] = phases_mod

        try:
            hooks = importlib.import_module("qwenpaw_insight.hooks")
            root = hooks.AgentInsightRootHook(type("Collector", (), {})())
            cleanup = hooks.AgentInsightCleanupHook(type("Collector", (), {})())
            self.assertIsInstance(root, HookBase)
            self.assertIsInstance(cleanup, HookBase)
            self.assertIs(root.phase, Phase.PRE_EXECUTE)
            self.assertIs(cleanup.phase, Phase.FINALLY)
        finally:
            sys.modules.pop("qwenpaw_insight.hooks", None)
            for name, module in previous.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


if __name__ == "__main__":
    unittest.main()
