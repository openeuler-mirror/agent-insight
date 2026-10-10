# coding: utf-8
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
