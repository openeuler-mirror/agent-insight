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

"""Unit tests for PlatformAdapterRegistry."""

from __future__ import annotations

from unittest import TestCase

from agent_fault_injection.pipeline.exceptions import PlatformNotFoundError
from agent_fault_injection.platform_adapters.base import PlatformAdapter
from agent_fault_injection.platform_adapters.registry import PlatformAdapterRegistry


class _StubAdapter(PlatformAdapter):
    name = "stub"

    def install_fault_assets(self, ctx):  # noqa: ANN001
        return None

    def merge_platform_env(self, ctx, base_env):  # noqa: ANN001
        return dict(base_env)

    async def run_platform_session(self, ctx, environment):  # noqa: ANN001
        raise NotImplementedError

    def map_trajectory(self, request, fault, artifacts):  # noqa: ANN001
        raise NotImplementedError


class PlatformAdapterRegistryTests(TestCase):
    def test_builtins_include_opencode_and_xiaoo(self) -> None:
        registry = PlatformAdapterRegistry()
        self.assertEqual(registry.names(), ("opencode", "xiaoo"))
        adapter = registry.get("OpenCode")
        self.assertEqual(adapter.name, "opencode")
        self.assertEqual(registry.get("xiaoo").name, "xiaoo")

    def test_register_mock_without_builtins(self) -> None:
        registry = PlatformAdapterRegistry(load_builtins=False)
        self.assertEqual(registry.names(), ())
        registry.register("mock", _StubAdapter)
        self.assertEqual(registry.names(), ("mock",))
        self.assertIsInstance(registry.get("mock"), _StubAdapter)

    def test_unknown_platform_raises(self) -> None:
        registry = PlatformAdapterRegistry(load_builtins=False)
        with self.assertRaises(PlatformNotFoundError):
            registry.get("missing")

    def test_get_caches_singleton(self) -> None:
        registry = PlatformAdapterRegistry(load_builtins=False)
        registry.register("mock", _StubAdapter)
        first = registry.get("mock")
        second = registry.get("mock")
        self.assertIs(first, second)
