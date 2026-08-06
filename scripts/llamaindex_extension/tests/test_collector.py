from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from llama_index.core import Document, VectorStoreIndex
from llama_index.core.agent.workflow import AgentWorkflow, ReActAgent
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.llms import MockLLM
from llama_index.core.tools import FunctionTool, QueryEngineTool
from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step
from llama_index.observability.otel.base import OTelCompatibleSpanHandler
from llama_index.tools.mcp import McpToolSpec
from llama_index_instrumentation import get_dispatcher
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from opentelemetry import trace as otel_trace
from pydantic import PrivateAttr
from pytest import MonkeyPatch

import agent_insight_llamaindex as collector
from agent_insight_llamaindex import cli
from agent_insight_llamaindex.config import CollectorConfig
from agent_insight_llamaindex.event_handler import LlamaIndexEventHandler
from agent_insight_llamaindex.model import SpanRecord
from agent_insight_llamaindex.otel_integration import AgentInsightOpenTelemetry
from agent_insight_llamaindex.otlp import encode_batch
from agent_insight_llamaindex.serialization import extract_usage, safe_json_value, safe_value
from agent_insight_llamaindex.span_handler import LlamaIndexSpanHandler
from agent_insight_llamaindex.spool import Spool
from agent_insight_llamaindex.uploader import CollectorRuntime


def config(tmp_path: Path, **overrides: object) -> CollectorConfig:
    return CollectorConfig(
        endpoint="http://localhost:3000",
        api_key="secret",
        user="test-user",
        spool_dir=tmp_path / "llamaindex-spool",
        config_path=tmp_path / "llamaindex.json",
        **overrides,
    )


def bound(**kwargs: object) -> inspect.BoundArguments:
    signature = inspect.Signature(
        inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY) for name in kwargs
    )
    return signature.bind(**kwargs)


def test_config_normalizes_endpoint_and_writes_private_file(tmp_path: Path) -> None:
    value = config(tmp_path)
    value.write()
    assert value.endpoint == "http://localhost:3000/api/ingest/otel/v1/traces"
    assert json.loads(value.config_path.read_text())["api_key"] == "secret"
    if os.name != "nt":
        assert value.config_path.stat().st_mode & 0o777 == 0o600


def test_config_file_values_are_not_overridden_by_absent_environment(tmp_path: Path) -> None:
    value = config(tmp_path, capture_content=False, batch_size=7)
    value.write()
    loaded = CollectorConfig.load(config_path=value.config_path)
    assert loaded.capture_content is False
    assert loaded.batch_size == 7


def test_default_user_is_not_anonymous(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_INSIGHT_USER", raising=False)
    assert CollectorConfig().user not in {"", "anonymous"}


def test_setup_is_one_line_instrumentation_alias() -> None:
    assert collector.setup is collector.instrument


def test_collector_reuses_official_otel_without_replacing_global_provider(
    tmp_path: Path,
) -> None:
    value = config(tmp_path)
    runtime = CollectorRuntime(value)
    global_provider = otel_trace.get_tracer_provider()
    instrumentor = AgentInsightOpenTelemetry(value, runtime)
    instrumentor.start_registering()
    try:
        assert isinstance(instrumentor.span_handler, OTelCompatibleSpanHandler)
        assert otel_trace.get_tracer_provider() is global_provider
    finally:
        instrumentor.unregister()


def test_default_spool_is_isolated_by_api_key(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENT_INSIGHT_HOME", str(tmp_path))
    monkeypatch.delenv("AGENT_INSIGHT_LLAMA_SPOOL_DIR", raising=False)
    first = CollectorConfig.load(
        endpoint="http://localhost:3000", api_key="account-one"
    )
    first.write()
    second = CollectorConfig.load(
        config_path=first.config_path,
        endpoint="http://localhost:3000",
        api_key="account-two",
    )
    assert first.spool_dir != second.spool_dir
    assert first.spool_dir.parent.parent == tmp_path / "otel_data" / "llamaindex"
    assert second.spool_dir.parent.parent == tmp_path / "otel_data" / "llamaindex"
    assert "account-one" not in str(first.spool_dir)
    assert "account-two" not in str(second.spool_dir)
    Spool(first)
    assert first.spool_dir.is_dir()


def test_default_spool_is_isolated_by_endpoint(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENT_INSIGHT_HOME", str(tmp_path))
    monkeypatch.delenv("AGENT_INSIGHT_LLAMA_SPOOL_DIR", raising=False)
    first = CollectorConfig.load(endpoint="https://one.example", api_key="shared-key")
    second = CollectorConfig.load(endpoint="https://two.example", api_key="shared-key")
    assert first.spool_dir != second.spool_dir


def test_default_content_limit_is_2000_characters() -> None:
    value, truncated, original = safe_value("x" * 2001, CollectorConfig())
    assert truncated is True
    assert original == 2001
    assert value.startswith("x" * 2000)


def test_safe_value_redacts_secrets_and_truncates(tmp_path: Path) -> None:
    value, truncated, original = safe_value(
        {"api_key": "hidden", "value": "abcdefgh"}, config(tmp_path, max_content_chars=30)
    )
    assert "hidden" not in value
    assert "REDACTED" in value
    assert truncated
    assert original and original > 30


def test_safe_value_redacts_url_and_header_secrets(tmp_path: Path) -> None:
    value, _, _ = safe_value(
        {
            "url": "https://example.test/query?q=x&api_key=hidden-url-secret",
            "headers": [["Authorization", "Bearer hidden-header-secret"]],
            "note": "authorization: Basic hidden-inline-secret",
        },
        config(tmp_path),
    )
    assert "hidden-url-secret" not in value
    assert "hidden-header-secret" not in value
    assert "hidden-inline-secret" not in value
    assert value.count("REDACTED") >= 3


def test_safe_json_value_keeps_truncated_retrieval_nodes_valid(tmp_path: Path) -> None:
    nodes = [
        {"source": f"doc-{index}.md", "score": 1 - index / 10, "content": "x" * 600}
        for index in range(5)
    ]
    value, truncated, original = safe_json_value(nodes, config(tmp_path))
    decoded = json.loads(value)
    assert truncated is True
    assert original and original > 2_000
    assert decoded
    assert all("source" in node and "score" in node for node in decoded)
    assert len(value) <= 2_000


def test_usage_accepts_openai_and_llamaindex_shapes() -> None:
    assert extract_usage({"usage": {"prompt_tokens": 2, "completion_tokens": 3}}) == {
        "input_tokens": 2,
        "output_tokens": 3,
        "total_tokens": 5,
    }
    response = SimpleNamespace(additional_kwargs={"usage": {"input_tokens": 4, "output_tokens": 5}})
    assert extract_usage(response)["total_tokens"] == 9


def test_span_handler_preserves_parentage_across_concurrent_roots(tmp_path: Path) -> None:
    emitted: list[SpanRecord] = []
    handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    root_a = handler.new_span("Workflow.run-aabbccdd", bound(), SimpleNamespace())
    root_b = handler.new_span("Workflow.run-bbccddee", bound(), SimpleNamespace())
    child_a = handler.new_span("OpenAI.chat-11223344", bound(), SimpleNamespace(), root_a.id_)
    child_b = handler.new_span("OpenAI.chat-22334455", bound(), SimpleNamespace(), root_b.id_)
    assert child_a.trace_id == root_a.trace_id
    assert child_b.trace_id == root_b.trace_id
    assert child_a.trace_id != child_b.trace_id
    assert child_a.otel_parent_span_id == root_a.otel_span_id
    assert child_b.otel_parent_span_id == root_b.otel_span_id


def test_event_enrichment_collects_llm_usage_and_content(tmp_path: Path) -> None:
    handler = LlamaIndexSpanHandler(config=config(tmp_path), emit=lambda _: True)
    span = handler.new_span("OpenAILike.chat-aabbccdd", bound(), SimpleNamespace())
    handler.open_spans[span.id_] = span
    event = SimpleNamespace(
        span_id=span.id_,
        class_name=lambda: "LLMChatEndEvent",
        model_dict={"model": "deepseek-v4-pro", "provider": "deepseek"},
        messages=[{"role": "user", "content": "hello"}],
        response={"content": "world", "usage": {"prompt_tokens": 3, "completion_tokens": 4}},
    )
    handler.enrich(span.id_, event)
    assert span.kind == "llm"
    assert span.attributes["gen_ai.request.model"] == "deepseek-v4-pro"
    assert span.attributes["gen_ai.usage.total_tokens"] == 7
    assert "hello" in span.attributes["input.value"]


def test_tool_span_captures_arguments_result_and_error(tmp_path: Path) -> None:
    emitted: list[SpanRecord] = []
    handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event = SimpleNamespace(tool_name="lookup", tool_kwargs={"q": "x"})
    args = bound(ev=event)
    span = handler.new_span("AgentWorkflow.call_tool-aabbccdd", args, SimpleNamespace())
    handler.open_spans[span.id_] = span
    output = SimpleNamespace(tool_output=SimpleNamespace(is_error=False, content="answer"))
    handler.prepare_to_exit_span(span.id_, args, result=output)
    assert emitted[0].kind == "tool"
    assert emitted[0].attributes["tool.name"] == "lookup"
    assert "answer" in emitted[0].attributes["tool.output"]


def test_tool_span_unwraps_runtime_output_for_skill_body(tmp_path: Path) -> None:
    emitted: list[SpanRecord] = []
    handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event = SimpleNamespace(
        tool_name="skill",
        tool_kwargs={"name": "coordinator-routing", "version": 1},
    )
    args = bound(ev=event)
    span = handler.new_span("AgentWorkflow.call_tool-aabbccdd", args, SimpleNamespace())
    handler.open_spans[span.id_] = span
    body = (
        "Skill: coordinator-routing\n"
        "Base directory: /tmp/skills/coordinator-routing\n\n"
        "# Coordinator Routing\n\nDelegate research to the Researcher agent."
    )
    tool_output = SimpleNamespace(
        blocks=[SimpleNamespace(block_type="text", text=body)],
        tool_name="skill",
        raw_input={"name": "coordinator-routing", "version": 1},
        raw_output=body,
        content=body,
        is_error=False,
    )
    handler.prepare_to_exit_span(
        span.id_, args, result=SimpleNamespace(tool_output=tool_output)
    )

    attributes = emitted[0].attributes
    assert attributes["tool.output"] == body
    assert attributes["tool.status"] == "success"
    assert '"raw_input"' not in attributes["tool.output"]
    assert '"raw_output"' not in attributes["tool.output"]


def test_span_handler_releases_completed_and_dropped_identities(tmp_path: Path) -> None:
    handler = LlamaIndexSpanHandler(config=config(tmp_path), emit=lambda _: True)
    args = bound()
    completed = handler.new_span("MockLLM.complete-aabbccdd", args, SimpleNamespace())
    handler.open_spans[completed.id_] = completed
    handler.prepare_to_exit_span(completed.id_, args, result="ok")
    assert completed.id_ not in handler.identities

    dropped = handler.new_span("MockLLM.complete-bbccddee", args, SimpleNamespace())
    handler.open_spans[dropped.id_] = dropped
    handler.prepare_to_drop_span(dropped.id_, args, err=RuntimeError("failed"))
    assert dropped.id_ not in handler.identities


def test_span_handler_close_releases_unfinished_content(tmp_path: Path) -> None:
    handler = LlamaIndexSpanHandler(config=config(tmp_path), emit=lambda _: True)
    args = bound(prompt="x" * 1000)
    handler.span_enter("MockLLM.complete-aabbccdd", args, SimpleNamespace())
    assert handler.open_spans
    assert handler.identities
    handler.close()
    assert not handler.open_spans
    assert not handler.identities
    assert not handler.current_span_ids


def test_span_handler_bounds_orphaned_open_spans(tmp_path: Path) -> None:
    handler = LlamaIndexSpanHandler(
        config=config(tmp_path, max_open_spans=16), emit=lambda _: True
    )
    args = bound(prompt="x" * 2000)
    for index in range(17):
        handler.span_enter(
            f"MockLLM.complete-{index:08d}", args, SimpleNamespace()
        )
    assert len(handler.open_spans) == 16
    assert len(handler.identities) == 16
    assert handler.dropped_open_spans == 1


def test_agent_instance_identity_uses_workflow_context_not_display_name(tmp_path: Path) -> None:
    handler = LlamaIndexSpanHandler(config=config(tmp_path), emit=lambda _: True)
    event = SimpleNamespace(current_agent_name="Researcher", input=["task"])
    first_context = object()
    second_context = object()
    root = handler.new_span("AgentWorkflow.run-11223344", bound(), SimpleNamespace())
    first = handler.new_span(
        "AgentWorkflow.run_agent_step-aabbccdd",
        bound(ev=event, ctx=first_context),
        SimpleNamespace(),
        root.id_,
    )
    continued = handler.new_span(
        "AgentWorkflow.parse_agent_output-bbccddee",
        bound(ev=event, ctx=first_context),
        SimpleNamespace(),
        root.id_,
    )
    concurrent = handler.new_span(
        "AgentWorkflow.run_agent_step-ccddee11",
        bound(ev=event, ctx=second_context),
        SimpleNamespace(),
        root.id_,
    )
    assert first.attributes["agent.instance.id"] == continued.attributes["agent.instance.id"]
    assert first.attributes["agent.instance.id"] != concurrent.attributes["agent.instance.id"]
    assert "task" in first.attributes["agent.task"]


def test_spool_batch_is_atomic_and_restart_discoverable(tmp_path: Path) -> None:
    spool = Spool(config(tmp_path))
    ready = spool.write({"resourceSpans": []})
    assert ready and ready.suffix == ".ready"
    assert not list(spool.directory.glob("*.tmp"))
    assert Spool(config(tmp_path)).pending() == [ready]
    spool.acknowledge(ready)
    assert not spool.pending()


def test_spool_capacity_drops_new_batch_without_corrupting_existing(tmp_path: Path) -> None:
    value = config(tmp_path, spool_max_bytes=1024 * 1024)
    spool = Spool(value)
    assert spool.write({"value": "x" * 700_000})
    assert spool.write({"value": "y" * 700_000}) is None
    assert len(spool.pending()) == 1


def test_rejected_batches_are_reclaimed_before_dropping_new_telemetry(tmp_path: Path) -> None:
    spool = Spool(config(tmp_path, spool_max_bytes=1024 * 1024))
    assert spool.write({"value": "x" * 700_000})
    claimed = spool.claim_next()
    assert claimed is not None
    spool.reject(claimed)
    assert spool.write({"value": "y" * 700_000}) is not None
    assert not list(spool.directory.glob("*.rejected"))


def test_runtime_close_stops_threads_and_rejects_late_submissions(tmp_path: Path) -> None:
    runtime = CollectorRuntime(config(tmp_path))
    runtime.start()
    runtime.close(1)
    assert not runtime._writer.is_alive()
    assert not runtime._uploader.is_alive()
    record = SpanRecord(
        trace_id="1" * 32,
        span_id="2" * 16,
        parent_span_id=None,
        session_id="closed-runtime",
        name="MockLLM.complete",
        kind="llm",
        start_time_ns=1,
        end_time_ns=2,
        status="success",
    )
    assert runtime.submit(record) is False


def test_agent_root_completion_triggers_immediate_spool_write(tmp_path: Path) -> None:
    runtime = CollectorRuntime(config(tmp_path, batch_size=64, flush_interval_seconds=10))
    written = threading.Event()
    payloads: list[dict[str, object]] = []

    def write(payload: dict[str, object]) -> Path:
        payloads.append(payload)
        written.set()
        return tmp_path / "accepted.ready"

    runtime.spool.write = write  # type: ignore[method-assign]
    runtime.start()
    record = SpanRecord(
        trace_id="1" * 32,
        span_id="2" * 16,
        parent_span_id=None,
        session_id="completed-agent",
        name="AgentWorkflow.run",
        kind="agent",
        start_time_ns=1,
        end_time_ns=2,
        status="success",
    )
    try:
        assert runtime.submit(record)
        assert written.wait(1)
        assert len(payloads) == 1
    finally:
        runtime.close(1)


def test_retry_becomes_exponential_after_three_failures(tmp_path: Path) -> None:
    runtime = CollectorRuntime(
        config(tmp_path, retry_base_seconds=1, retry_max_seconds=60)
    )
    assert [runtime._retry_delay(attempt) for attempt in range(1, 7)] == [
        1,
        1,
        1,
        2,
        4,
        8,
    ]


def test_spool_claim_is_atomic_across_runtime_instances(tmp_path: Path) -> None:
    value = config(tmp_path)
    writer = Spool(value)
    assert writer.write({"resourceSpans": []})
    first = Spool(value)
    claimed = first.claim_next()
    assert claimed and ".uploading-" in claimed.name
    second = Spool(value)
    assert second.claim_next() is None
    restored = first.release(claimed)
    assert restored and restored.suffix == ".ready"
    assert second.claim_next() is not None


def test_spool_recovers_only_expired_upload_claims(tmp_path: Path) -> None:
    value = config(tmp_path, spool_claim_timeout_seconds=1)
    spool = Spool(value)
    assert spool.write({"resourceSpans": []})
    claimed = spool.claim_next()
    assert claimed
    os.utime(claimed, (0, 0))
    recovered = Spool(value)
    assert len(recovered.pending()) == 1


def test_otlp_encoder_keeps_ids_semantics_and_auth_out_of_payload(tmp_path: Path) -> None:
    record = SpanRecord(
        trace_id="1" * 32,
        span_id="2" * 16,
        parent_span_id="3" * 16,
        session_id="session-a",
        name="OpenAI.chat",
        kind="llm",
        start_time_ns=1,
        end_time_ns=2,
        attributes={"gen_ai.request.model": "model-a"},
    )
    payload = encode_batch([record], config(tmp_path))
    encoded = json.dumps(payload)
    span = payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert span["traceId"] == "1" * 32
    assert span["parentSpanId"] == "3" * 16
    assert "secret" not in encoded
    assert "llamaindex" in encoded


def test_runtime_retries_spooled_batch_and_acknowledges_only_after_success(
    tmp_path: Path,
) -> None:
    value = config(
        tmp_path,
        batch_size=1,
        retry_base_seconds=0.001,
        retry_max_seconds=0.002,
    )
    runtime = CollectorRuntime(value)
    attempts = 0

    def upload(_: Path) -> tuple[bool, bool, str | None]:
        nonlocal attempts
        attempts += 1
        return (attempts >= 3, False, None if attempts >= 3 else "temporary")

    runtime._upload = upload  # type: ignore[method-assign]
    runtime.start()
    runtime.submit(
        SpanRecord(
            trace_id="1" * 32,
            span_id="2" * 16,
            parent_span_id=None,
            session_id="retry-session",
            name="MockLLM.complete",
            kind="llm",
            start_time_ns=1,
            end_time_ns=2,
            attributes={},
        )
    )
    assert runtime.flush(2)
    runtime.close(1)
    assert attempts == 3
    assert runtime.uploaded_batches == 1
    assert not runtime.spool.pending()


def test_cli_run_bootstraps_only_the_child_process(monkeypatch: MonkeyPatch) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []
    monkeypatch.setattr(
        cli.subprocess, "call", lambda command, env: calls.append((command, env)) or 0
    )
    result = cli._run(argparse.Namespace(command=["--", "python", "app.py"]))
    assert result == 0
    command, environment = calls[0]
    assert command == ["python", "app.py"]
    assert environment["AGENT_INSIGHT_LLAMAINDEX_AUTOSTART"] == "1"
    assert environment["PYTHONPATH"].split(os.pathsep)[0].endswith("bootstrap")
    assert "AGENT_INSIGHT_LLAMAINDEX_AUTOSTART" not in os.environ


def test_cli_loads_model_env_without_overwriting_process_values(tmp_path: Path) -> None:
    model_env = tmp_path / "llamaindex.env"
    model_env.write_text(
        "OPENAI_API_KEY=file-key\nOPENAI_BASE_URL='https://example.test/v1'\n",
        encoding="utf-8",
    )
    environment = {
        "AGENT_INSIGHT_LLAMA_MODEL_ENV": str(model_env),
        "OPENAI_API_KEY": "process-key",
    }
    cli._load_model_environment(environment)
    assert environment["OPENAI_API_KEY"] == "process-key"
    assert environment["OPENAI_BASE_URL"] == "https://example.test/v1"


def test_cli_configure_reads_secret_from_environment(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENT_INSIGHT_HOME", str(tmp_path))
    monkeypatch.setenv("AGENT_INSIGHT_HOST", "https://collector.example")
    monkeypatch.setenv("AGENT_INSIGHT_API_KEY", "environment-secret")
    args = argparse.Namespace(
        endpoint=None,
        api_key=None,
        user="tester",
        no_content=False,
        max_content_chars=20_000,
    )
    assert cli._configure(args) == 0
    stored = json.loads((tmp_path / "llamaindex.json").read_text(encoding="utf-8"))
    assert stored["endpoint"] == "https://collector.example/api/ingest/otel/v1/traces"
    assert stored["api_key"] == "environment-secret"
    assert Path(stored["spool_dir"]).is_dir()


def test_cli_purge_removes_all_llamaindex_accounts_only(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENT_INSIGHT_HOME", str(tmp_path))
    monkeypatch.delenv("AGENT_INSIGHT_LLAMA_SPOOL_DIR", raising=False)
    first = CollectorConfig.load(endpoint="http://localhost:3000", api_key="first")
    first.write()
    assert Spool(first).write({"account": 1})
    second = CollectorConfig.load(
        config_path=first.config_path,
        endpoint="http://localhost:3000",
        api_key="second",
    )
    second.write()
    assert Spool(second).write({"account": 2})
    other_framework = tmp_path / "otel_data" / "opencode" / "keep.ready"
    other_framework.parent.mkdir(parents=True)
    other_framework.write_text("keep", encoding="utf-8")
    model_env = tmp_path / "llamaindex.env"
    model_env.write_text("DEEPSEEK_API_KEY=secret\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_INSIGHT_LLAMA_MODEL_ENV", str(model_env))

    assert cli._purge(argparse.Namespace(yes=True)) == 0
    assert not first.spool_dir.exists()
    assert not second.spool_dir.exists()
    assert not second.config_path.exists()
    assert not model_env.exists()
    assert other_framework.read_text(encoding="utf-8") == "keep"


def test_child_bootstrap_cli_captures_real_llamaindex_call(tmp_path: Path) -> None:
    received: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            received.append(json.loads(self.rfile.read(length)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = os.environ.copy()
    environment.update(
        {
            "AGENT_INSIGHT_HOST": f"http://127.0.0.1:{server.server_port}",
            "AGENT_INSIGHT_API_KEY": "test-key",
            "AGENT_INSIGHT_LLAMA_SPOOL_DIR": str(tmp_path / "auto-spool"),
            "AGENT_INSIGHT_LLAMA_BATCH_SIZE": "1",
        }
    )
    code = (
        "from llama_index.core.llms import MockLLM; "
        "MockLLM(max_tokens=1).complete('probe')"
    )
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "agent_insight_llamaindex.cli",
                "run",
                "--",
                sys.executable,
                "-c",
                code,
            ],
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert completed.returncode == 0, completed.stderr
    assert received
    spans = received[0]["resourceSpans"][0]["scopeSpans"][0]["spans"]  # type: ignore[index]
    assert spans


def test_real_react_agent_workflow_keeps_one_stable_agent_instance(tmp_path: Path) -> None:
    class FinalAnswerLLM(MockLLM):
        def _generate_text(self, length: int) -> str:
            return "Thought: complete\nAnswer: final answer"

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> object:
        agent = ReActAgent(
            name="Researcher",
            description="Research the answer",
            llm=FinalAnswerLLM(max_tokens=1),
            streaming=False,
        )
        workflow = AgentWorkflow(agents=[agent], root_agent="Researcher", timeout=10)
        return await workflow.run(user_msg="hello")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "final answer"
    agent_instances = {
        item.attributes["agent.instance.id"]
        for item in emitted
        if item.attributes.get("agent.name") == "Researcher"
    }
    assert len(agent_instances) == 1
    assert {"workflow_step", "llm"}.issubset({item.kind for item in emitted})
    assert not span_handler.identities
    assert not span_handler.all_spans
    assert not span_handler.completed_spans
    assert not span_handler.dropped_spans


def test_same_agent_task_three_times_has_consistent_trace_structure(tmp_path: Path) -> None:
    class FinalAnswerLLM(MockLLM):
        def _generate_text(self, length: int) -> str:
            return "Thought: complete\nAnswer: stable"

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> None:
        for index in range(3):
            agent = ReActAgent(
                name="Researcher",
                description="Research the answer",
                llm=FinalAnswerLLM(max_tokens=1),
                streaming=False,
            )
            workflow = AgentWorkflow(
                agents=[agent], root_agent="Researcher", timeout=10
            )
            with collector.trace_context(
                session_id=f"repeat-{index}", query="same task"
            ):
                assert str(await workflow.run(user_msg="same task")) == "stable"

    try:
        asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    snapshots: list[list[tuple[object, ...]]] = []
    for index in range(3):
        records = [item for item in emitted if item.session_id == f"repeat-{index}"]
        labels = {item.span_id: (item.kind, item.name) for item in records}
        snapshots.append(
            sorted(
                (
                    item.kind,
                    item.name,
                    labels.get(item.parent_span_id or ""),
                    item.status,
                    tuple(sorted(item.attributes)),
                )
                for item in records
            )
        )
    assert snapshots[0]
    assert snapshots[0] == snapshots[1] == snapshots[2]
    assert not span_handler.identities


def test_real_rag_pipeline_captures_retrieval_synthesis_and_llm(tmp_path: Path) -> None:
    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)
    try:
        index = VectorStoreIndex.from_documents(
            [Document(text="Agent Insight observes LlamaIndex traces.")],
            embed_model=MockEmbedding(embed_dim=8),
        )
        query_engine = index.as_query_engine(llm=MockLLM(max_tokens=2))
        response = query_engine.query("What does Agent Insight observe?")
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(response)
    kinds = {item.kind for item in emitted}
    assert {"retriever", "synthesizer", "llm"}.issubset(kinds)
    retrieval = next(item for item in emitted if item.kind == "retriever")
    assert "Agent Insight" in retrieval.attributes["retrieval.nodes"]
    assert json.loads(retrieval.attributes["retrieval.nodes"])
    assert retrieval.attributes["retrieval.document_count"] == 1


def test_workflow_step_name_does_not_get_reclassified_as_retriever(
    tmp_path: Path,
) -> None:
    class RetrieveWorkflow(Workflow):
        def __init__(self, retriever: object) -> None:
            super().__init__(timeout=10)
            self.retriever = retriever

        @step
        async def retrieve_documents(self, ev: StartEvent) -> StopEvent:
            nodes = await self.retriever.aretrieve(str(ev.get("query") or ""))
            return StopEvent(result=len(nodes))

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)
    index = VectorStoreIndex.from_documents(
        [Document(text="Agent Insight observes workflow retrieval.")],
        embed_model=MockEmbedding(embed_dim=8),
    )

    async def run() -> object:
        return await RetrieveWorkflow(index.as_retriever()).run(
            query="workflow retrieval"
        )

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert result == 1
    step_span = next(
        item for item in emitted if item.name.endswith(".retrieve_documents")
    )
    assert step_span.kind == "workflow_step"
    assert step_span.attributes["workflow.step.name"] == "retrieve_documents"
    assert any(
        item.kind == "retriever" and "VectorIndexRetriever" in item.name
        for item in emitted
    )


def test_real_react_function_tool_captures_arguments_output_and_status(tmp_path: Path) -> None:
    class ToolThenAnswerLLM(MockLLM):
        _calls: int = PrivateAttr(default=0)

        def _generate_text(self, length: int) -> str:
            self._calls += 1
            if self._calls == 1:
                return (
                    "Thought: calculate\nAction: add\n"
                    'Action Input: {"a": 1, "b": 2}'
                )
            return "Thought: complete\nAnswer: 3"

    def add(a: int, b: int) -> int:
        return a + b

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> object:
        agent = ReActAgent(
            name="Calculator",
            description="Calculate values",
            tools=[FunctionTool.from_defaults(fn=add)],
            llm=ToolThenAnswerLLM(max_tokens=1),
            streaming=False,
        )
        return await AgentWorkflow(
            agents=[agent], root_agent="Calculator", timeout=10
        ).run(user_msg="Add 1 and 2")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "3"
    tool = next(item for item in emitted if item.kind == "tool")
    assert tool.attributes["tool.name"] == "add"
    assert '"a":1' in tool.attributes["tool.arguments"].replace(" ", "")
    assert "3" in tool.attributes["tool.output"]
    assert tool.attributes["tool.status"] == "success"


def test_real_multi_agent_handoff_keeps_agent_instances_and_parent_trace(tmp_path: Path) -> None:
    class HandoffLLM(MockLLM):
        def _generate_text(self, length: int) -> str:
            return (
                "Thought: delegate\nAction: handoff\n"
                'Action Input: {"to_agent": "Researcher", "reason": "research"}'
            )

    class ResearcherLLM(MockLLM):
        def _generate_text(self, length: int) -> str:
            return "Thought: complete\nAnswer: researched"

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> object:
        coordinator = ReActAgent(
            name="Coordinator",
            description="Delegate research",
            can_handoff_to=["Researcher"],
            llm=HandoffLLM(max_tokens=1),
            streaming=False,
        )
        researcher = ReActAgent(
            name="Researcher",
            description="Research the answer",
            can_handoff_to=[],
            llm=ResearcherLLM(max_tokens=1),
            streaming=False,
        )
        workflow = AgentWorkflow(
            agents=[coordinator, researcher], root_agent="Coordinator", timeout=10
        )
        return await workflow.run(user_msg="research this")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "researched"
    named = [item for item in emitted if item.attributes.get("agent.name")]
    assert {item.attributes["agent.name"] for item in named} == {
        "Coordinator",
        "Researcher",
    }
    assert len({item.attributes["agent.instance.id"] for item in named}) == 2
    assert len({item.trace_id for item in named}) == 1


def test_real_query_engine_tool_captures_tool_and_rag_children(tmp_path: Path) -> None:
    class QueryThenAnswerLLM(MockLLM):
        _calls: int = PrivateAttr(default=0)

        def _generate_text(self, length: int) -> str:
            self._calls += 1
            if self._calls == 1:
                return (
                    "Thought: search\nAction: knowledge_search\n"
                    'Action Input: {"input": "What does Agent Insight observe?"}'
                )
            return "Thought: complete\nAnswer: LlamaIndex traces"

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> object:
        index = VectorStoreIndex.from_documents(
            [Document(text="Agent Insight observes LlamaIndex traces.")],
            embed_model=MockEmbedding(embed_dim=8),
        )
        query_tool = QueryEngineTool.from_defaults(
            query_engine=index.as_query_engine(llm=MockLLM(max_tokens=2)),
            name="knowledge_search",
            description="Search the local knowledge base",
        )
        agent = ReActAgent(
            name="QueryAgent",
            description="Answer with retrieval",
            tools=[query_tool],
            llm=QueryThenAnswerLLM(max_tokens=1),
            streaming=False,
        )
        return await AgentWorkflow(
            agents=[agent], root_agent="QueryAgent", timeout=10
        ).run(user_msg="What does Agent Insight observe?")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "LlamaIndex traces"
    kinds = {item.kind for item in emitted}
    assert {"tool", "retriever", "synthesizer", "llm"}.issubset(kinds)
    tool = next(item for item in emitted if item.kind == "tool")
    assert tool.attributes["tool.name"] == "knowledge_search"
    descendant_ids = {tool.span_id}
    descendants: list[SpanRecord] = []
    while True:
        children = [
            item
            for item in emitted
            if item.parent_span_id in descendant_ids and item not in descendants
        ]
        if not children:
            break
        descendants.extend(children)
        descendant_ids.update(item.span_id for item in children)
    assert {"retriever", "synthesizer"}.issubset({item.kind for item in descendants})
    assert {item.trace_id for item in [tool, *descendants]} == {tool.trace_id}


def test_real_mcp_tool_spec_captures_name_arguments_and_result(tmp_path: Path) -> None:
    class MemoryMCPClient:
        async def list_tools(self) -> ListToolsResult:
            return ListToolsResult(
                tools=[
                    Tool(
                        name="mcp_echo",
                        description="Echo text through MCP",
                        inputSchema={
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                            "required": ["text"],
                        },
                    )
                ]
            )

        async def call_tool(self, name: str, arguments: dict[str, object]) -> CallToolResult:
            return CallToolResult(
                content=[TextContent(type="text", text=f"echo:{arguments['text']}")]
            )

    class MCPThenAnswerLLM(MockLLM):
        _calls: int = PrivateAttr(default=0)

        def _generate_text(self, length: int) -> str:
            self._calls += 1
            if self._calls == 1:
                return (
                    "Thought: call MCP\nAction: mcp_echo\n"
                    'Action Input: {"text": "hello"}'
                )
            return "Thought: complete\nAnswer: echo:hello"

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)

    async def run() -> object:
        tools = await McpToolSpec(MemoryMCPClient()).to_tool_list_async()  # type: ignore[arg-type]
        agent = ReActAgent(
            name="MCPAgent",
            description="Call MCP tools",
            tools=tools,
            llm=MCPThenAnswerLLM(max_tokens=1),
            streaming=False,
        )
        return await AgentWorkflow(
            agents=[agent], root_agent="MCPAgent", timeout=10
        ).run(user_msg="Echo hello")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "echo:hello"
    tool = next(item for item in emitted if item.kind == "tool")
    assert tool.attributes["tool.name"] == "mcp_echo"
    assert "hello" in tool.attributes["tool.arguments"]
    assert "echo:hello" in tool.attributes["tool.output"]
    assert tool.attributes["tool.status"] == "success"


def test_real_nested_workflow_preserves_parent_child_trace(tmp_path: Path) -> None:
    class InnerWorkflow(Workflow):
        @step
        async def inner(self, ev: StartEvent) -> StopEvent:
            return StopEvent(result=f"inner:{ev.value}")

    class OuterWorkflow(Workflow):
        @step
        async def outer(self, ev: StartEvent) -> StopEvent:
            inner_result = await InnerWorkflow(timeout=5).run(value=ev.value)
            return StopEvent(result=f"outer:{inner_result}")

    emitted: list[SpanRecord] = []
    span_handler = LlamaIndexSpanHandler(
        config=config(tmp_path), emit=lambda item: not emitted.append(item)
    )
    event_handler = LlamaIndexEventHandler(span_handler=span_handler)
    dispatcher = get_dispatcher()
    dispatcher.add_span_handler(span_handler)
    dispatcher.add_event_handler(event_handler)
    async def run() -> object:
        return await OuterWorkflow(timeout=10).run(value="value")

    try:
        result = asyncio.run(run())
    finally:
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not event_handler
        ]

    assert str(result) == "outer:inner:value"
    workflows = [item for item in emitted if item.kind == "workflow"]
    assert len(workflows) == 2
    outer = next(item for item in workflows if item.name.startswith("OuterWorkflow.run"))
    inner = next(item for item in workflows if item.name.startswith("InnerWorkflow.run"))
    assert outer.name == "OuterWorkflow.run"
    assert inner.name == "InnerWorkflow.run"
    assert inner.trace_id == outer.trace_id
    by_span_id = {item.span_id: item for item in emitted}
    ancestor_id = inner.parent_span_id
    ancestor_ids: set[str] = set()
    while ancestor_id:
        ancestor_ids.add(ancestor_id)
        ancestor = by_span_id.get(ancestor_id)
        ancestor_id = ancestor.parent_span_id if ancestor else None
    assert outer.span_id in ancestor_ids
    assert {item.status for item in emitted} == {"success"}
