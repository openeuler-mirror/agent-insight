# Codex Trace collector verification

This suite validates the Codex CLI Hook, native OTel relay, server Adapter, and
VS Code-family extension against the public Codex 0.145.x interfaces.

## Automated tests

```bash
node --import tsx --test \
  test/trace-transport.test.ts \
  test/codex-hook-collector.test.ts \
  test/codex-otel-relay.test.ts \
  test/codex-install.test.ts \
  test/codex-extension-core.test.ts \
  test/codex-adapter.test.ts \
  test/framework-adapter-registry.test.ts \
  test/otel-trace-aggregator.test.ts
```

The tests cover all 11 Hook event names, non-destructive hooks.json merging,
managed OTel block restoration and conflict handling, trust-state boundaries,
Hook/OTel Tool merging, exact native Token and TTFT mapping, real Cloud auth ID
gating, explicit/automatic Skill signals, three-level and five-sibling
SubAgents, raw/canonical JSONL durability, checkpoints, retry, API Key
isolation, active IDE turn attribution, FileEdit minimization, Terminal public
API extraction, VSIX contents, setup asset allowlisting, and uninstall path
safety.

## Source installation

```bash
export AGENT_INSIGHT_API_KEY='<key>'
export AGENT_INSIGHT_BASE_URL='http://127.0.0.1:3000'
node scripts/agent-trace-collectors/codex/install.cjs \
  --source-dir "$PWD/scripts/agent-trace-collectors/codex"
```

After installation, start Codex, run `/hooks`, review the Agent Insight command
path, trust it, restart Codex, and run:

```bash
node ~/.agent-insight/collectors/codex/self-check.cjs
```

The installer never writes Codex's trusted hook hash. If another active OTel
exporter exists, it installs the Hook path but reports `otel_conflict` without
rewriting that exporter.

## VSIX lifecycle

```bash
node scripts/agent-trace-collectors/codex/build-vsix.cjs \
  /tmp/agent-insight-codex-trace-0.1.0.vsix
code --install-extension /tmp/agent-insight-codex-trace-0.1.0.vsix --force
code --list-extensions --show-versions
code --uninstall-extension openeuler.agent-insight-codex-trace
```

Repeat the same install/list/uninstall cycle with `cursor` and `windsurf`.
FileEdit and Terminal events remain unattributed unless the relay reports one
active IDE-originated Codex turn whose `cwd` overlaps the workspace.

For a real VS Code Extension Host check, use an isolated HOME, user-data
directory, extensions directory, and empty workspace. Then launch VS Code with
the source extension and the committed test entry:

```powershell
$testRoot = Join-Path $env:TEMP 'agent-insight-vscode-extension-host'
$env:HOME = Join-Path $testRoot 'home'
$env:USERPROFILE = $env:HOME
$env:AGENT_INSIGHT_VSCODE_RESULT = Join-Path $testRoot 'result.json'
code (Join-Path $testRoot 'workspace') --new-window `
  --user-data-dir (Join-Path $testRoot 'user-data') `
  --extensions-dir (Join-Path $testRoot 'extensions') `
  --extensionDevelopmentPath "$PWD\scripts\agent-trace-collectors\codex\vscode-extension" `
  --extensionTestsPath "$PWD\test\codex-trace\vscode-extension-host.cjs" `
  --disable-workspace-trust
```

VS Code can load the test entry directly. Cursor and Windsurf must use the
committed bridge inside the extension directory so their Extension Host
provides the product-specific `vscode` module before loading the shared test:

```powershell
$bridge = Join-Path $PWD `
  'scripts\agent-trace-collectors\codex\vscode-extension\extension-host-test.cjs'
cursor (Join-Path $testRoot 'workspace') --new-window `
  --user-data-dir (Join-Path $testRoot 'user-data') `
  --extensions-dir (Join-Path $testRoot 'extensions') `
  --extensionDevelopmentPath "$PWD\scripts\agent-trace-collectors\codex\vscode-extension" `
  --extensionTestsPath $bridge `
  --disable-workspace-trust
```

Run the same command with `windsurf` for Windsurf. Keep each product's HOME,
user-data, extensions, workspace, result, and relay directories isolated.

The collector must already be installed under the isolated HOME. The test
activates the extension, checks its commands and Settings, seeds one
IDE-originated turn through the loopback relay, performs a real document edit,
and runs one command through Terminal Shell Execution. Confirm both
`tool.FileEdit` and `tool.Terminal` in the isolated canonical spool.

## Performance and soak

On openEuler 24.03 LTS SP4, provide non-secret command arguments as JSON:

```bash
export CODEX_BASELINE_HOME=/path/to/baseline/.codex
export CODEX_INSTALLED_HOME=/path/to/installed/.codex
export CODEX_STARTUP_ARGS_JSON='["exec","--help"]'
node test/codex-trace/performance.mjs startup

export CODEX_TTFT_ARGS_JSON='[
  "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
  "--disable", "apps", "--disable", "plugins", "-c", "mcp_servers={}",
  "Reply with exactly: TTFT_OK"
]'
node test/codex-trace/performance.mjs ttft

export CODEX_SOAK_COMMAND_JSON='["codex","exec","--json","Run the soak fixture"]'
node test/codex-trace/performance.mjs soak --hours 8
```

The startup harness requires separate baseline and installed `CODEX_HOME`
directories. The TTFT harness alternates both homes and detects the first
assistant output event. The soak harness samples `/proc/<pid>/status`, relay
RSS, spool bytes, and checkpoint bytes every 15 minutes. Raw output is written
under ignored `test/codex-trace/out/`.

## Cleanup

```bash
node ~/.agent-insight/collectors/codex/uninstall.cjs
```

Ordinary uninstall removes only the matching Agent Insight Hook handlers,
restores the managed OTel block, uses standard editor extension uninstall, and
retains spool data. Add `--purge` to remove only the current API Key namespace.
