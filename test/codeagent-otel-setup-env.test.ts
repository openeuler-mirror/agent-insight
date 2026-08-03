import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

type SetupRoute = {
  name: string;
  get: (request: Request) => Promise<Response>;
  url: string;
};

const routes: SetupRoute[] = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?key=test-key',
  },
  {
    name: 'auto setup',
    get: getAutoSetup,
    url: 'http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
  },
];

function heredocBody(script: string, opener: string, terminator: string): string {
  const openerIndex = script.indexOf(opener);
  assert.ok(openerIndex >= 0, `heredoc opener should exist: ${opener}`);
  const bodyStart = script.indexOf('\n', openerIndex) + 1;
  const bodyEnd = script.indexOf(`\n${terminator}`, bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, `heredoc should end with ${terminator}`);
  return script.slice(bodyStart, bodyEnd);
}

test('curl setup scripts install a valid CodeAgent Unix PATH shim', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const wrapper = heredocBody(
      script,
      'cat > "$CODEAGENT_WRAPPER_PATH" << \'CODEAGENT_WRAPPER_EOF\'',
      'CODEAGENT_WRAPPER_EOF',
    );
    const envScript = heredocBody(
      script,
      'cat > "$HOME/.agent-insight/codeagent_otel_env.sh" << \'CODEAGENT_OTEL_EOF\'',
      'CODEAGENT_OTEL_EOF',
    );

    assert.equal(response.status, 200, route.name);
    assert.match(script, /CodeAgent[^\n]+codeagent/);
    assert.match(script, /INSTALL_CODEAGENT=false/);
    assert.match(script, /AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=.*otel_data\/codeagent/);
    assert.match(script, /CODEAGENT_WRAPPER_PATH="\$CODEAGENT_WRAPPER_DIR\/codeagent"/);
    assert.match(script, /printf '%s\\n' "\$CODEAGENT_REAL_BIN" > "\$CODEAGENT_REAL_BIN_FILE"/);
    assert.match(script, /chmod 0755 "\$CODEAGENT_WRAPPER_PATH"/);
    assert.match(envScript, /export PATH="\$_agent_insight_codeagent_bin/);
    assert.doesNotMatch(envScript, /codeagent\(\)/);
    assert.match(wrapper, /PATH="\$_clean_path" type -P codeagent/);
    assert.match(wrapper, /codeagent_real_bin/);
    assert.match(wrapper, /CODEAGENT3_ENABLE_TELEMETRY=1/);
    assert.match(wrapper, /OTEL_EXPORTER_OTLP_ENDPOINT="\$_si_host\/api\/ingest\/otel"/);
    assert.match(wrapper, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.match(wrapper, /OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http\/json/);
    assert.match(wrapper, /"\$_real_bin" "\$@"/);
    assert.doesNotMatch(wrapper, /OTEL_(?:TRACES|METRICS)_EXPORTER/);
    assert.doesNotMatch(wrapper, /\n\s*codeagent "\$@"/);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${route.name}: ${syntax.stderr}`);
  }
});

test('Unix PATH shim injects OTel for a non-interactive child script and prefers the current PATH', async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'codeagent-otel-shim-'));
  const currentBinDir = join(homeDir, 'current-bin');
  const fallbackBinDir = join(homeDir, 'fallback-bin');
  const configDir = join(homeDir, '.agent-insight');
  const wrapperDir = join(configDir, 'bin');
  const currentBin = join(currentBinDir, 'codeagent');
  const fallbackBin = join(fallbackBinDir, 'codeagent');
  const driver = join(homeDir, 'driver.sh');

  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(currentBinDir, { recursive: true });
  mkdirSync(fallbackBinDir, { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(configDir, '.env'), 'AGENT_INSIGHT_HOST=collector.example:4318\nAGENT_INSIGHT_API_KEY=runtime-key\n');
  writeFileSync(driver, '#!/usr/bin/env bash\ncodeagent probe\n');
  writeFileSync(currentBin, [
    '#!/usr/bin/env bash',
    'printf "SOURCE=current\\n"',
    'printf "ENABLED=%s\\n" "$CODEAGENT3_ENABLE_TELEMETRY"',
    'printf "ENDPOINT=%s\\n" "$OTEL_EXPORTER_OTLP_ENDPOINT"',
    'printf "HEADERS=%s\\n" "$OTEL_EXPORTER_OTLP_HEADERS"',
    'printf "ARGS=%s\\n" "$*"',
  ].join('\n'));
  writeFileSync(fallbackBin, '#!/usr/bin/env bash\nprintf "SOURCE=fallback\\n"\n');
  chmodSync(driver, 0o755);
  chmodSync(currentBin, 0o755);
  chmodSync(fallbackBin, 0o755);

  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const wrapper = heredocBody(
      script,
      'cat > "$CODEAGENT_WRAPPER_PATH" << \'CODEAGENT_WRAPPER_EOF\'',
      'CODEAGENT_WRAPPER_EOF',
    );
    const envScript = heredocBody(
      script,
      'cat > "$HOME/.agent-insight/codeagent_otel_env.sh" << \'CODEAGENT_OTEL_EOF\'',
      'CODEAGENT_OTEL_EOF',
    );
    const wrapperPath = join(wrapperDir, 'codeagent');
    const envPath = join(configDir, 'codeagent_otel_env.sh');
    writeFileSync(wrapperPath, wrapper);
    writeFileSync(envPath, envScript);
    writeFileSync(join(configDir, 'codeagent_real_bin'), `${fallbackBin}\n`);
    chmodSync(wrapperPath, 0o755);

    const currentProbe = spawnSync('bash', ['-c', [
      'source "$HOME/.agent-insight/codeagent_otel_env.sh"',
      'bash "$HOME/driver.sh"',
      'printf "PARENT=%s\\n" "${CODEAGENT3_ENABLE_TELEMETRY-}"',
    ].join('\n')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${currentBinDir}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(currentProbe.status, 0, `${route.name}: ${currentProbe.stderr}`);
    assert.match(currentProbe.stdout, /SOURCE=current/);
    assert.match(currentProbe.stdout, /ENABLED=1/);
    assert.match(currentProbe.stdout, /ENDPOINT=http:\/\/collector\.example:4318\/api\/ingest\/otel/);
    assert.match(currentProbe.stdout, /HEADERS=x-witty-api-key=runtime-key/);
    assert.match(currentProbe.stdout, /ARGS=probe/);
    assert.match(currentProbe.stdout, /PARENT=$/m);

    const fallbackProbe = spawnSync('bash', ['-c', [
      'source "$HOME/.agent-insight/codeagent_otel_env.sh"',
      'bash "$HOME/driver.sh"',
    ].join('\n')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: '/usr/bin:/bin',
      },
    });

    assert.equal(fallbackProbe.status, 0, `${route.name}: ${fallbackProbe.stderr}`);
    assert.match(fallbackProbe.stdout, /SOURCE=fallback/);
  }
});

function powerShellHereStringBody(script: string, variableName: string): string {
  const opener = `$${variableName} = @'`;
  const openerIndex = script.indexOf(opener);
  assert.ok(openerIndex >= 0, `PowerShell here-string should exist: ${variableName}`);
  const bodyStart = script.indexOf('\n', openerIndex) + 1;
  const bodyEnd = script.indexOf("\n'@", bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, `PowerShell here-string should end: ${variableName}`);
  return script.slice(bodyStart, bodyEnd);
}

function findWindowsPowerShell(): string | null {
  const candidates = process.platform === 'win32'
    ? ['powershell.exe']
    : ['/mnt/c/windows/System32/WindowsPowerShell/v1.0/powershell.exe'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function assertPowerShellSyntax(powerShell: string, source: string, label: string): void {
  const parseCommand = [
    '$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEAGENT_PARSE_SOURCE))',
    '$tokens = $null',
    '$errors = $null',
    '[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null',
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }',
  ].join('; ');
  const syntax = spawnSync(powerShell, ['-NoProfile', '-Command', parseCommand], {
    encoding: 'utf8',
    env: { ...process.env, CODEAGENT_PARSE_SOURCE: Buffer.from(source, 'utf8').toString('base64') },
  });
  assert.equal(syntax.status, 0, `${label}: ${syntax.stderr}`);
}

test('curl setup scripts install a valid CodeAgent Windows PATH shim', async (t) => {
  const powerShell = findWindowsPowerShell();
  if (!powerShell) t.diagnostic('Windows PowerShell unavailable; structural assertions still run');

  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'windows', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const wrapper = powerShellHereStringBody(script, 'codeAgentWrapperScript');
    const cmdScript = powerShellHereStringBody(script, 'codeAgentCmdScript');
    const envScript = powerShellHereStringBody(script, 'codeAgentOtelScript');

    assert.equal(response.status, 200, route.name);
    assert.match(script, /CodeAgent[^\n]+codeagent/);
    assert.match(script, /\$INSTALL_CODEAGENT = \$false/);
    assert.match(script, /AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=.*otel_data\\codeagent/);
    assert.match(script, /\$codeAgentCmdPath = Join-Path \$codeAgentBinDir "codeagent\.cmd"/);
    assert.match(script, /\$codeAgentWrapperPath = Join-Path \$codeAgentBinDir "codeagent-wrapper\.ps1"/);
    assert.match(script, /SetEnvironmentVariable\("Path", \$codeAgentUpdatedUserPath, "User"\)/);
    assert.match(script, /Set-Content -Path \$codeAgentRealBinFile -Value \$codeAgentCommand\.Source/);
    assert.doesNotMatch(script, /Set-Alias codeagent/);
    assert.doesNotMatch(script, /function Invoke-AgentInsightCodeAgent/);

    assert.match(envScript, /Remove-Item Alias:codeagent/);
    assert.match(envScript, /Remove-Item Function:Invoke-AgentInsightCodeAgent/);
    assert.match(envScript, /\$env:PATH = \(@\(\$_agentInsightCodeAgentBin\)/);
    assert.match(cmdScript, /powershell\.exe -NoProfile -ExecutionPolicy Bypass/);
    assert.ok(cmdScript.includes(String.raw`%USERPROFILE%\.agent-insight\bin\codeagent-wrapper.ps1`));
    assert.match(cmdScript, /codeagent-wrapper\.ps1" %\*/);
    assert.match(wrapper, /Get-Command codeagent -CommandType Application, ExternalScript/);
    assert.match(wrapper, /\$env:PATH = \$cleanPath/);
    assert.match(wrapper, /codeagent_real_bin/);
    assert.match(wrapper, /\$env:CODEAGENT3_ENABLE_TELEMETRY = "1"/);
    assert.match(wrapper, /\$env:OTEL_EXPORTER_OTLP_ENDPOINT = "\$siHost\/api\/ingest\/otel"/);
    assert.match(wrapper, /\$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http\/json"/);
    assert.match(wrapper, /\$env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http\/json"/);
    assert.match(wrapper, /& \$realBin @args/);
    assert.doesNotMatch(wrapper, /OTEL_(?:TRACES|METRICS)_EXPORTER/);

    if (powerShell) {
      const blockStart = script.indexOf('# 6.6a Configure CodeAgent OpenTelemetry wrapper');
      const blockEndMarker = '    Write-Host "   CodeAgent may still send traces/metrics; Agent Insight accepts and discards those signals."';
      const blockEnd = script.indexOf(blockEndMarker, blockStart) + blockEndMarker.length + 2;
      assert.ok(blockStart >= 0 && blockEnd > blockStart, `${route.name}: CodeAgent block should be complete`);
      assertPowerShellSyntax(powerShell, script.slice(blockStart, blockEnd), route.name);
    }
  }
});

test('Windows PATH shim injects OTel from CMD and falls back to the recorded binary', async (t) => {
  const powerShell = findWindowsPowerShell();
  if (!powerShell) {
    t.skip('Windows PowerShell unavailable');
    return;
  }

  const response = await routes[0].get(new Request(routes[0].url, {
    headers: { 'x-platform': 'windows', host: 'localhost:3000' },
  }));
  const script = await response.text();
  const wrapper = powerShellHereStringBody(script, 'codeAgentWrapperScript');
  const cmdScript = powerShellHereStringBody(script, 'codeAgentCmdScript');
  const envScript = powerShellHereStringBody(script, 'codeAgentOtelScript');
  const currentBin = [
    '@echo off',
    'echo SOURCE=current',
    'echo ENABLED=%CODEAGENT3_ENABLE_TELEMETRY%',
    'echo ENDPOINT=%OTEL_EXPORTER_OTLP_ENDPOINT%',
    'echo HEADERS=%OTEL_EXPORTER_OTLP_HEADERS%',
    'echo ARGS=%*',
  ].join('\r\n');
  const fallbackBin = ['@echo off', 'echo SOURCE=fallback', 'echo ARGS=%*'].join('\r\n');
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  const harness = [
    '$ErrorActionPreference = "Stop"',
    '$root = Join-Path $env:TEMP ("agent-insight-codeagent-" + [Guid]::NewGuid().ToString("N"))',
    '$originalUserProfile = $env:USERPROFILE',
    '$originalPath = $env:PATH',
    'try {',
    '  $env:USERPROFILE = Join-Path $root "profile"',
    '  $configDir = Join-Path $env:USERPROFILE ".agent-insight"',
    '  $wrapperDir = Join-Path $configDir "bin"',
    '  $currentDir = Join-Path $root "current-bin"',
    '  $fallbackDir = Join-Path $root "fallback-bin"',
    '  New-Item -ItemType Directory -Path $wrapperDir, $currentDir, $fallbackDir -Force | Out-Null',
    `  [IO.File]::WriteAllBytes((Join-Path $wrapperDir "codeagent-wrapper.ps1"), [Convert]::FromBase64String('${encode(wrapper)}'))`,
    `  [IO.File]::WriteAllBytes((Join-Path $wrapperDir "codeagent.cmd"), [Convert]::FromBase64String('${encode(cmdScript)}'))`,
    `  [IO.File]::WriteAllBytes((Join-Path $configDir "codeagent_otel_env.ps1"), [Convert]::FromBase64String('${encode(envScript)}'))`,
    `  [IO.File]::WriteAllBytes((Join-Path $currentDir "codeagent.cmd"), [Convert]::FromBase64String('${encode(currentBin)}'))`,
    `  [IO.File]::WriteAllBytes((Join-Path $fallbackDir "codeagent.cmd"), [Convert]::FromBase64String('${encode(fallbackBin)}'))`,
    '  [IO.File]::WriteAllText((Join-Path $configDir ".env"), "AGENT_INSIGHT_HOST=collector.example:4318`r`nAGENT_INSIGHT_API_KEY=runtime-key`r`n", [Text.Encoding]::ASCII)',
    '  [IO.File]::WriteAllText((Join-Path $configDir "codeagent_real_bin"), (Join-Path $fallbackDir "codeagent.cmd"), [Text.Encoding]::UTF8)',
    '  $system32 = Join-Path $env:SystemRoot "System32"',
    '  $powerShellDir = Join-Path $system32 "WindowsPowerShell\\v1.0"',
    '  $basePath = "$system32;$powerShellDir"',
    '  $env:PATHEXT = ".COM;.EXE;.BAT;.CMD"',
    '  Remove-Item Env:CODEAGENT3_ENABLE_TELEMETRY -ErrorAction SilentlyContinue',
    '  $env:PATH = "$currentDir;$basePath"',
    '  . (Join-Path $configDir "codeagent_otel_env.ps1")',
    '  $currentStdout = Join-Path $root "current.stdout"',
    '  $currentStderr = Join-Path $root "current.stderr"',
    '  $currentProcess = Start-Process -FilePath (Join-Path $system32 "cmd.exe") -ArgumentList @("/d", "/c", "codeagent probe") -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $currentStdout -RedirectStandardError $currentStderr',
    '  Get-Content $currentStdout',
    '  if ($currentProcess.ExitCode -ne 0) { throw ("current CodeAgent probe failed: " + (Get-Content $currentStderr -Raw)) }',
    '  Write-Output "PARENT_CURRENT=$($env:CODEAGENT3_ENABLE_TELEMETRY)"',
    '  Remove-Item Env:CODEAGENT3_ENABLE_TELEMETRY -ErrorAction SilentlyContinue',
    '  $env:PATH = $basePath',
    '  . (Join-Path $configDir "codeagent_otel_env.ps1")',
    '  $fallbackStdout = Join-Path $root "fallback.stdout"',
    '  $fallbackStderr = Join-Path $root "fallback.stderr"',
    '  $fallbackProcess = Start-Process -FilePath (Join-Path $system32 "cmd.exe") -ArgumentList @("/d", "/c", "codeagent fallback") -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $fallbackStdout -RedirectStandardError $fallbackStderr',
    '  Get-Content $fallbackStdout',
    '  if ($fallbackProcess.ExitCode -ne 0) { throw ("fallback CodeAgent probe failed: " + (Get-Content $fallbackStderr -Raw)) }',
    '  Write-Output "PARENT_FALLBACK=$($env:CODEAGENT3_ENABLE_TELEMETRY)"',
    '} finally {',
    '  $env:USERPROFILE = $originalUserProfile',
    '  $env:PATH = $originalPath',
    '  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n');
  const probe = spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', harness], {
    encoding: 'utf8',
  });

  assert.equal(probe.status, 0, `${probe.stderr}\nSTDOUT:\n${probe.stdout}`);
  assert.match(probe.stdout, /SOURCE=current/);
  assert.match(probe.stdout, /ENABLED=1/);
  assert.match(probe.stdout, /ENDPOINT=http:\/\/collector\.example:4318\/api\/ingest\/otel/);
  assert.match(probe.stdout, /HEADERS=x-witty-api-key=runtime-key/);
  assert.match(probe.stdout, /ARGS=probe/);
  assert.match(probe.stdout, /PARENT_CURRENT=$/m);
  assert.match(probe.stdout, /SOURCE=fallback/);
  assert.match(probe.stdout, /ARGS=fallback/);
  assert.match(probe.stdout, /PARENT_FALLBACK=$/m);
});
