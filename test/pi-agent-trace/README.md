# Pi Agent Trace verification

This suite validates the Pi Agent collector against
`@earendil-works/pi-coding-agent` 0.82.x.

## Automated tests

```bash
node --import tsx --test \
  test/trace-transport.test.ts \
  test/pi-agent-collector.test.ts \
  test/pi-agent-adapter.test.ts \
  test/pi-agent-distribution.test.ts
```

The tests cover API Key isolation, redaction, Unicode truncation, torn JSONL
tails, process locking, checkpoint recovery, retry backoff, Agent/LLM/Tool
lifecycle, explicit and automatic Skill invocation, MCP mapping, three-level
SubAgent nesting, five parallel SubAgents, deterministic structure, install
asset allowlisting, and uninstall path safety.

## Real Pi package lifecycle

```bash
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
pi list
pi --list-models
pi remove "$PWD/scripts/agent-trace-collectors/pi-agent"
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
```

`pi --list-models` is used as a no-inference Extension load check. A full trace
run requires a configured Pi provider/model and a reachable Agent Insight
server.

## Failure injection

The transport test injects HTTP 500 before a successful response and asserts
that no checkpoint exists after failure, all events replay after recovery, and
a second flush uploads zero events. For a live endpoint, temporarily route the
collector to an unused loopback port, run one Pi task, restore the endpoint,
and compare the final checkpoint with the server-side interaction count.

## Performance

Run 20 cold starts without and with Extension discovery:

```bash
node test/pi-agent-trace/performance.mjs startup
```

For 30 TTFT samples, configure a real model through the normal Pi provider
mechanism, then provide only non-secret CLI arguments:

```bash
export PI_BENCH_ARGS_JSON='["--mode","json","Reply with OK","--model","<model>","--no-session"]'
node test/pi-agent-trace/performance.mjs ttft
```

Provider credentials remain in the environment and are not written to output.
The harness detects the first non-empty `message_update` delta. Results are
written to the ignored `test/pi-agent-trace/out/` directory.

For an eight-hour RSS/spool soak, provide a long-running Pi command:

```bash
export PI_SOAK_COMMAND_JSON='["pi","--mode","rpc"]'
node test/pi-agent-trace/performance.mjs soak --hours 8
```

The soak harness samples Linux `/proc/<pid>/status` and the Pi spool size every
15 minutes. Stop it earlier with Ctrl+C; the partial report remains valid but
must not be reported as an eight-hour pass.

## Cleanup

```bash
pi remove "$PWD/scripts/agent-trace-collectors/pi-agent"
```

The source checkout uninstall script intentionally refuses to run. Managed
installations use
`~/.agent-insight/collectors/pi-agent/scripts/uninstall.cjs`; ordinary uninstall
retains spool, `--purge` removes only the current key namespace, and
`--purge-all --yes` removes all Pi namespaces.
