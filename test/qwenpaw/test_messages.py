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
