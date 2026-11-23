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

"""Fault catalog: models, registry, scenarios, capability API."""

from .definition import (
    FaultRegistry,
    add_fault,
    default_skills_root,
    load_fault_definition,
)
from .models import FaultDefinition, InjectionStep
from .presentation import get_fault_ui_catalog, load_fault_ui_catalog

__all__ = [
    "FaultDefinition",
    "FaultRegistry",
    "InjectionStep",
    "add_fault",
    "default_skills_root",
    "get_fault_ui_catalog",
    "load_fault_definition",
    "load_fault_ui_catalog",
]
