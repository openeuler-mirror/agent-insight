import unittest

from qwenpaw_insight import otlp


class OtlpTest(unittest.TestCase):
    def test_stable_hex_is_deterministic(self):
        self.assertEqual(otlp.stable_hex("a", 16), otlp.stable_hex("a", 16))
        self.assertEqual(len(otlp.stable_hex("a", 32)), 32)

    def test_limited_text_truncates(self):
        text, truncated, original = otlp.limited_text("x" * 100, 10)
        self.assertEqual(len(text), 10)
        self.assertTrue(truncated)
        self.assertEqual(original, 100)

    def test_attributes_skip_empty(self):
        values = {"keep": "value", "skip": "", "none": None, "zero": 0}
        attrs = otlp.attributes(values)
        keys = {item["key"] for item in attrs}
        self.assertEqual(keys, {"keep", "zero"})

    def test_payload_shape(self):
        span = otlp.new_span(
            name="agent",
            span_id="span1",
            trace_id="trace1",
            parent_span_id=None,
            span_attributes={"gen_ai.span.kind": "AGENT"},
        )
        payload = otlp.otlp_payload("qwenpaw", "session-a", "alice", "0.2.0", [span])
        resource = payload["resourceSpans"][0]["resource"]["attributes"]
        self.assertEqual(otlp.json_text(resource), otlp.json_text(resource))
        self.assertEqual(payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["spanId"], "span1")


if __name__ == "__main__":
    unittest.main()
