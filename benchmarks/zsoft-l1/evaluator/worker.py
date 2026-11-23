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

from __future__ import annotations

import json
import sys
from pathlib import Path

from zsoft_poc.runner import EvaluationRunner

config = json.loads(Path(sys.argv[1]).read_text())
runner = EvaluationRunner(Path(config["tasksDir"]), Path(config["runsDir"]), Path(config["stateDir"]))
record = runner.evaluate_file(config["taskId"], Path(config["submissionPath"]), phase="final", submission_kind="final")
Path(config["recordPath"]).write_text(record.model_dump_json())
