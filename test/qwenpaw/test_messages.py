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

import unittest

from qwenpaw_insight.messages import extract_user_input


class TextBlock:
    def __init__(self, text: str):
        self.text = text


class Message:
    def __init__(self, role: str, content):
        self.role = role
        self.content = content


class MessageExtractionTest(unittest.TestCase):
    def test_extracts_latest_user_textblock_message(self):
        messages = [
            Message("system", [TextBlock("system prompt")]),
            Message("user", [TextBlock("first")]),
            Message("assistant", [TextBlock("answer")]),
            Message("human", [TextBlock("second"), TextBlock("part")]),
        ]

        self.assertEqual(extract_user_input(messages), "second\npart")

    def test_supports_dict_messages(self):
        messages = {
            "messages": [
                {"role": "system", "content": "rules"},
                {"role": "user", "content": [{"type": "text", "text": "question"}]},
            ]
        }

        self.assertEqual(extract_user_input(messages), "question")

    def test_ignores_non_user_messages(self):
        messages = [
            Message("system", [TextBlock("system prompt")]),
            Message("assistant", [TextBlock("assistant history")]),
            {"role": "tool", "content": [{"type": "text", "text": "tool result"}]},
        ]

        self.assertEqual(extract_user_input(messages), "")

    def test_plain_text_requires_explicit_opt_in(self):
        self.assertEqual(extract_user_input("plain prompt"), "")
        self.assertEqual(extract_user_input("plain prompt", allow_plain_text=True), "plain prompt")


if __name__ == "__main__":
    unittest.main()
