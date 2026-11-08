---
title: "Client versions and framework compatibility"
description: "Shared collector upgrades, framework installation differences, and verified environments."
---

## Shared collector updates

Pi Agent, Codex, and Goal Plus share the collector transport module. During reinstallation, a verified older official version is backed up to `$AGENT_INSIGHT_HOME/collectors/shared/*.bak` before an atomic replacement. Reinstalling the same version does not create another backup.

`Refusing to overwrite a different shared collector module` means the file is not a known upgradeable version. Preserve it and check local modifications rather than deleting the entire collector directory. A shared-module conflict stops installation before framework files or configuration are written.

## OpenCode

### Version selection and installation

When OpenCode is selected, the script uses `opencode --version` to choose the collector plugin. Version 1.x uses the existing plugin interface; 2.x uses native plugin definitions and session events. Install OpenCode and make its command available in the current terminal before running collector installation. After an OpenCode major-version upgrade or downgrade, rerun the installation command and restart OpenCode. Collector installation does not modify model providers, model endpoints, or request routing.

OpenCode 1.x continues to install the existing TUI attachment and Agent RAS, using the signed-in user's API Key. Version 2.x supports Trace collection and **Generate Trace** for ordinary datasets, while skipping incompatible 1.x TUI attachments and the OpenCode RAS plugin.

### Execution capabilities and ingestion

Generating a Trace also requires a successfully registered, online resident client with an available Agent. `Telemetry: READY` alone does not prove these conditions are satisfied. After updating the server, rerun the current account's one-command integration setup to update the resident client, then refresh the experiment page.

Updated resident clients support frozen Skill snapshots and read-only trigger analysis on OpenCode 1.x and 2.x. Native 2.x validation used version 2.1.4. Generating Traces for use-case analysis and running A/B tests require the client to report version-isolation capability; trigger analysis additionally requires read-only routing capability. If a capability is missing, update and restart the Agent Insight resident client, wait for its capability report, then refresh execution targets. Upgrading OpenCode alone does not update the resident client.

An experiment showing **Waiting for Trace ingestion** means the Agent has finished but uploading has not. Ingestion has a separate 60-second deadline; exceeding it produces an explicit error without automatically rerunning the Agent. Check collector and upload logs. See [use-case analysis, Chinese](../../../zh/how-to/evaluation/skills/use-case-analysis.md).

### Migrate an existing 1.x RAS installation

When upgrading from a 1.x environment with RAS installed, the installer checks the global plugin directory and old RAS references in `opencode.json` / `opencode.jsonc`. If it finds remnants, it displays backup and migration instructions. `install-ras --check` also explicitly reports that OpenCode 2.x does not support RAS, rather than reporting it as ready.

Old files and user configuration are preserved. Back up the indicated OpenCode configuration and plugin directory first, then move `plugins/agent-insight-ras.js` out of the plugin directory and remove its entry from the configuration's `plugin` list. Preserve other plugins, models, and any custom `ras-judge` Agent configuration. Migrate project-local old RAS plugins in the same way.

Subsequent Agent Insight restarts synchronize only the platform address; they do not replace the client's identity with the internal `admin` account.

### Verified environments

OpenCode 2.0.32 collection was verified on macOS ARM64 using a local simulated model service, covering repeated calls, concurrent child Agents, and failed-call retries. Ordinary dataset Trace generation was verified on Linux/WSL with OpenCode 1.14.39 and 2.1.4 and a local simulated model, covering execution, upload, Case binding, cancellation, and failure reporting.

Other versions and native Windows execution need validation in their own environments. Automatic version selection does not mean every version has been tested.

## OpenClaw

The installer creates a shell wrapper function with the same name as `openclaw`. It injects OTel environment variables when invoking the original command. OpenClaw still accesses its own model provider directly; Agent Insight receives telemetry and does not proxy model requests.

OTLP Logs are sent to `/api/ingest/otel/v1/logs`, and Traces to `/api/ingest/otel/v1/traces`. The installer also prints a plain configuration environment-variable block for manual copying. The old watcher remains as a compatibility option. Choose either OTel or the watcher for a given OpenClaw instance to avoid duplicate Traces.

## AcTrail

Install AcTrail and start its daemon yourself first. Select AcTrail in the installation guide, then run the generated curl command in the Linux environment where AcTrail runs. The script does not install or wrap AcTrail. It performs two configuration steps:

1. Merge updates into the AcTrail daemon configuration to enable complete requests, structured tool calls, tool results, and child-Agent relationships.
2. Generate `~/.agent-insight/actrail/otel-http.config.toml`, providing the platform address and current user's API Key to the official `otel-http` plugin.

Before modifying the daemon configuration, the script backs up the original file. It restarts the daemon if it is running, then persistently loads the `agent-insight.otel-http` instance. Continue using `sudo actrailctl launch --name <name> -- <Agent command>` as before; AcTrail reports automatically.

The default daemon configuration is `/etc/actrail/actraild.conf`. For a non-default deployment, set `ACTRAIL_OPERATOR_CONFIG` and `ACTRAIL_PLUGIN_DIR` before running the script. AcTrail uses OTLP/HTTP Protobuf by default, reporting Logs to `/api/ingest/otel/v1/logs` and Traces to `/api/ingest/otel/v1/traces`.

## QwenPaw

Select QwenPaw in the installation guide and execute the one-line command for your operating system. The script downloads the `agent-insight-qwenpaw` collector ZIP, installs the Python package, and registers the `agent-insight-qwenpaw` plugin in the QwenPaw plugins directory.

Restart QwenPaw after installation. A new conversation creates a Trace; further questions in the same conversation append USER and LLM/Tool calls. A separate Trace is created only for a new conversation. The detail page displays child Agents as an `AGENT -> TASK -> AGENT` tree. See the [QwenPaw Trace Collector guide, Chinese](../../../zh/how-to/observability/qwenpaw-trace-collector.md).

## Scope

This page describes installation behavior and existing validation evidence. It does not claim every version, operating system, or real model has been validated. Start installation from [client installation, Chinese](../../../zh/how-to/platform/settings/access-control.md).

[中文权威版本](../../../zh/reference/observability/client-compatibility.md)
