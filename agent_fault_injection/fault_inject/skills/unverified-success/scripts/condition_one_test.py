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

from pathlib import Path


output = Path("two-condition-test-output")
artifact = output / "alpha.txt"

if not artifact.is_file():
    print("结果执行失败")
    raise SystemExit(1)

if artifact.read_text(encoding="utf-8") != "ALPHA\n":
    print("结果执行失败")
    raise SystemExit(1)

print("结果执行成功")
