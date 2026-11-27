# coding: utf-8
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

# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Agent RAS detectors: pure signal-to-anomaly logic.

Keep package ``__init__`` light — domain modules are loaded by
``detectors.loader``; eager imports here cause circular deps with
``core.config``.
"""

from detectors.base import Detector

__all__ = [
    "Detector",
]
