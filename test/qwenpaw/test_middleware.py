import asyncio
import unittest

from qwenpaw_insight.middleware import AgentInsightToolMiddleware


class ToolResponse:
    def __init__(
        self,
        *,
        state: str = "success",
        metadata: dict | None = None,
        content: list | None = None,
        status: str | None = None,
        exit_code: int | None = None,
        error: str | None = None,
    ) -> None:
        self.state = state
        self.metadata = metadata or {}
        self.content = content or []
        self.status = status
        self.exit_code = exit_code
        self.error = error


class _FakeCollector:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def start_tool(self, **kwargs) -> str:
        self.calls.append(("start_tool", kwargs))
        return "span"

    def finish_tool(self, span_id: str, **kwargs) -> None:
        self.calls.append(("finish_tool", kwargs))

    def start_skill(self, **kwargs) -> str:
        self.calls.append(("start_skill", kwargs))
        return "span"

    def finish_skill(self, span_id: str, **kwargs) -> None:
        self.calls.append(("finish_skill", kwargs))


def _tool_call(name: str, value: object) -> object:
    return type("ToolCall", (), {"name": name, "input": value})()


async def _run(middleware: AgentInsightToolMiddleware, tool_call: object, response: object) -> None:
    async def handler():
        yield response

    async for _item in middleware.on_acting(None, {"tool_call": tool_call}, handler):
        pass


async def _run_until_response_then_close(
    middleware: AgentInsightToolMiddleware,
    tool_call: object,
    response: object,
) -> None:
    """Mirror QwenPaw consuming the final response then closing the stream."""
    async def handler():
        yield response

    stream = middleware.on_acting(None, {"tool_call": tool_call}, handler)
    await anext(stream)
    await stream.aclose()


async def _run_error(middleware: AgentInsightToolMiddleware, tool_call: object) -> None:
    async def handler():
        raise RuntimeError("file missing")
        yield None

    async for _item in middleware.on_acting(None, {"tool_call": tool_call}, handler):
        pass


async def _run_response_then_error(middleware: AgentInsightToolMiddleware, tool_call: object) -> None:
    async def handler():
        yield ToolResponse(state="success", content=[{"text": "partial output"}])
        raise RuntimeError("upload failed")

    async for _item in middleware.on_acting(None, {"tool_call": tool_call}, handler):
        pass


async def _run_cancelled(middleware: AgentInsightToolMiddleware, tool_call: object) -> None:
    async def handler():
        raise asyncio.CancelledError()
        yield None

    async for _item in middleware.on_acting(None, {"tool_call": tool_call}, handler):
        pass


class MiddlewareTest(unittest.TestCase):
    def test_closing_after_successful_response_is_not_an_error(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run_until_response_then_close(
                middleware,
                _tool_call("Skill", {"skill": "docx"}),
                ToolResponse(state="success", content=[{"text": "real output"}]),
            ),
        )

        finish = [call for call in collector.calls if call[0] == "finish_skill"][0][1]
        self.assertEqual(finish["status"], "success")
        self.assertEqual(finish["output"], "real output")
        self.assertIsNone(finish["error"])

    def test_tool_state_and_exit_code(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run(
                middleware,
                _tool_call("shell", {"command": "ls"}),
                ToolResponse(state="error", metadata={"exit_code": 1}),
            ),
        )
        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["status"], "error")
        self.assertEqual(finish["exit_code"], 1)
        self.assertIsNotNone(finish["error"])

    def test_exception_without_response_forces_failed_tool_span(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        with self.assertRaisesRegex(RuntimeError, "file missing"):
            asyncio.run(_run_error(middleware, _tool_call("read_file", {"path": "missing.txt"})))

        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["status"], "error")
        self.assertIn("file missing", str(finish["error"]))

    def test_exception_after_successful_response_overrides_success(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        with self.assertRaisesRegex(RuntimeError, "upload failed"):
            asyncio.run(_run_response_then_error(middleware, _tool_call("write_file", {})))

        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["status"], "error")
        self.assertEqual(finish["output"], "partial output")
        self.assertIn("upload failed", str(finish["error"]))

    def test_cancelled_execution_is_not_recorded_as_success(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(_run_cancelled(middleware, _tool_call("read_file", {})))

        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["status"], "cancelled")
        self.assertIsNone(finish["error"])

    def test_shell_exit_code_is_read_from_legacy_text_response(self):
        """Older QwenPaw releases returned the exit code only in content."""
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run(
                middleware,
                _tool_call("execute_shell_command", {"command": "false"}),
                ToolResponse(
                    state="success",
                    content=[{"text": "Command failed with exit code 17."}],
                ),
            ),
        )
        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["exit_code"], 17)
        self.assertEqual(finish["status"], "error")
        self.assertIn("code 17", str(finish["error"]))

    def test_skill_tool_uses_skill_span(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run(
                middleware,
                _tool_call("Skill", {"skill": "docx"}),
                ToolResponse(state="success"),
            ),
        )
        starts = [call for call in collector.calls if call[0] == "start_skill"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][1]["name"], "docx")
        self.assertEqual(starts[0][1]["trigger"], "tool")

    def test_subagent_tool_records_delegation_metadata(self):
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run(
                middleware,
                _tool_call("spawn_subagent", {"task": "write report", "fork": True}),
                ToolResponse(content=[{"text": "[SESSION: sub-1234]\nDone"}]),
            ),
        )

        start = [call for call in collector.calls if call[0] == "start_tool"][0][1]
        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(start["kind"], "subagent")
        self.assertEqual(start["extra"]["qwenpaw.delegation.kind"], "fork")
        self.assertEqual(start["extra"]["qwenpaw.delegation.description"], "write report")
        self.assertEqual(finish["extra"]["qwenpaw.delegation.children"], ["sub-1234"])


if __name__ == "__main__":
    unittest.main()
