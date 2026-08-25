import asyncio
import unittest

from copaw.middleware import AgentInsightToolMiddleware


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


class MiddlewareTest(unittest.TestCase):
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

    def test_shell_exit_code_is_read_from_legacy_text_response(self):
        """Older QwenPaw releases returned the exit code only in content."""
        collector = _FakeCollector()
        middleware = AgentInsightToolMiddleware(collector)
        asyncio.run(
            _run(
                middleware,
                _tool_call("shell", {"command": "false"}),
                ToolResponse(
                    state="success",
                    content=[{"text": "Command failed with exit code 17."}],
                ),
            ),
        )
        finish = [call for call in collector.calls if call[0] == "finish_tool"][0][1]
        self.assertEqual(finish["exit_code"], 17)

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


if __name__ == "__main__":
    unittest.main()
