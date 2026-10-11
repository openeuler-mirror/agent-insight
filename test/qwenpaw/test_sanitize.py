"""AC12: sensitive-information masking tests."""

import unittest

from qwenpaw_insight import sanitize


class SanitizeTest(unittest.TestCase):
    def test_sensitive_dict_keys_are_masked(self):
        value = {
            "api_key": "wi_abcdef123456",
            "model": "qwen3",
            "headers": {"Authorization": "Bearer sk-test1234"},
            "args": ["--api-key", "wi_abc123456789"],
        }
        clean = sanitize.sanitize_value(value)
        self.assertEqual(clean["api_key"], "***")
        self.assertEqual(clean["model"], "qwen3")
        self.assertEqual(clean["headers"]["Authorization"], "***")
        self.assertEqual(clean["args"][1], "***")

    def test_plain_text_value_patterns(self):
        text = "call with sk-abcdefghij123456 and Bearer abc.def-ghi plus AKIA1234567890ABCDEF"
        clean = sanitize.sanitize_text(text)
        self.assertNotIn("sk-abcdefghij123456", clean)
        self.assertNotIn("abc.def-ghi", clean)
        self.assertNotIn("AKIA1234567890ABCDEF", clean)

    def test_key_value_assignment_pattern(self):
        text = '{"api_key": "sk-1234abcd5678", "url": "https://x.example/api"}'
        clean = sanitize.sanitize_text(text)
        self.assertNotIn("sk-1234abcd5678", clean)
        self.assertIn("https://x.example/api", clean)
        self.assertIn("***", clean)

    def test_non_sensitive_text_unchanged(self):
        text = "please summarize the quarterly report and save it to reports/q3.md"
        self.assertEqual(sanitize.sanitize_text(text), text)

    def test_nested_structures(self):
        value = {
            "config": [{"secret": "s3cr3t", "keep": "visible"}],
            "plain": "hello",
        }
        clean = sanitize.sanitize_value(value)
        self.assertEqual(clean["config"][0]["secret"], "***")
        self.assertEqual(clean["config"][0]["keep"], "visible")
        self.assertEqual(clean["plain"], "hello")


if __name__ == "__main__":
    unittest.main()

