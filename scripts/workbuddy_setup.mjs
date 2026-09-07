/**
 * WorkBuddy Trace 采集器安装器（Windows）。
 *
 * 目标：装完即用、无需手动启动 —— 通过 Windows 计划任务（Task Scheduler）登录触发 +
 * 失败自动重启，实现开机/登录自动拉起与崩溃自愈。等价于平台在 Linux(systemd --user)/
 * macOS(launchd) 已有、而 Windows 一直缺失的常驻客户端自启动能力。
 *
 * 用法（有 Node 时）：
 *   node scripts/workbuddy_setup.mjs --host <url> --token <apiKey> [--no-start]
 *   node scripts/workbuddy_setup.mjs --status
 *   node scripts/workbuddy_setup.mjs --uninstall
 * 无 Node 时用 WorkBuddy 自带运行时（ELECTRON_RUN_AS_NODE=1 + WorkBuddy.exe）安装；
 * 状态/卸载改用 schtasks（见 --help）。
 *
 * 设计要点：
 *   - 用任务定义 XML 注册（命令行 /create 参数不支持「失败后自动重启」）。
 *   - 任务动作指向 wscript.exe + 隐藏窗口 .vbs 启动器，登录时不闪黑框。
 *   - /f 覆盖同名任务，重复安装/升级幂等。
 *   - 采集器自身带单实例锁，重复触发不会双开。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TASK_NAME = "AgentInsight-WorkBuddyCollector";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME = os.homedir();
const PACKAGES_DIR = path.join(HOME, ".agent-insight", "packages");
const INSTALL_DIR = path.join(PACKAGES_DIR, "workbuddy");
const SHARED_SRC = path.join(__dirname, "agent-trace-collectors", "shared", "trace-transport.cjs");
const SHARED_DST_DIR = path.join(PACKAGES_DIR, "agent-trace-collectors", "shared");
const COLLECTOR_SRC_DIR = path.join(__dirname, "workbuddy-collector");
const CONFIG_PATH = path.join(HOME, ".agent-insight", "otel_data", "workbuddy", "config.json");
const LAUNCHER_PATH = path.join(INSTALL_DIR, "collector-launcher.vbs");
const COLLECTOR_PATH = path.join(INSTALL_DIR, "collector.mjs");

function log(msg) { console.log(msg); }
function fail(msg, hint) {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { start: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--status") args.status = true;
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--no-start") args.start = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--host") args.host = argv[++i];
    else if (a.startsWith("--host=")) args.host = a.slice("--host=".length);
    else if (a === "--token" || a === "--api-key") args.token = argv[++i];
    else if (a.startsWith("--token=")) args.token = a.slice("--token=".length);
    else if (a.startsWith("--api-key=")) args.token = a.slice("--api-key=".length);
  }
  return args;
}

function normalizeEndpoint(host) {
  let base = String(host || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  if (/\/api\/ingest\/otel\/v1\/traces$/.test(base)) return base;
  return `${base}/api/ingest/otel/v1/traces`;
}

function detectWorkBuddy() {
  const candidates = [
    path.join(HOME, ".workbuddy"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy"),
  ];
  return candidates.some((p) => p && fs.existsSync(p));
}

async function copyFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

async function stageRuntime() {
  await fsp.mkdir(INSTALL_DIR, { recursive: true });
  for (const name of ["collector.mjs", "session-registry.mjs", "mapper.cjs"]) {
    await copyFile(path.join(COLLECTOR_SRC_DIR, name), path.join(INSTALL_DIR, name));
  }
  // 保持相对 require（collector.mjs 里 ../agent-trace-collectors/shared/trace-transport.cjs）成立。
  await copyFile(SHARED_SRC, path.join(SHARED_DST_DIR, "trace-transport.cjs"));
  log(`[OK] Collector deployed to ${INSTALL_DIR}`);
}

async function writeConfig(endpoint, apiKey) {
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify({ endpoint, apiKey }, null, 2), { encoding: "utf8", mode: 0o600 });
  log(`[OK] Config written to ${CONFIG_PATH}`);
}

/**
 * 定位 WorkBuddy 自带的 Electron 可执行文件，用作采集器的 Node 运行时
 * （ELECTRON_RUN_AS_NODE=1 时 WorkBuddy.exe 等价于 node）。这样用户无需单独安装
 * Node.js，大幅降低接入门槛。找不到时回退到 process.execPath。
 */
function findWorkBuddyExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "WorkBuddy.exe"),
    path.join(process.env.PROGRAMFILES || "", "WorkBuddy", "WorkBuddy.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function writeLauncher(runtimeExe) {
  // 用 WScript.Shell 隐藏窗口启动，并在进程环境里设 ELECTRON_RUN_AS_NODE=1，
  // 让 WorkBuddy.exe 以纯 Node 模式运行 collector.mjs（对真实 node.exe 无副作用）。
  // 路径用 Chr(34) 拼引号，避免转义歧义。
  const vbs = [
    "' AgentInsight WorkBuddy Collector hidden-window launcher (generated at install, paths baked in)",
    "' Runs hidden (window style 0) and WAITS for the collector (bWaitOnReturn=True) so Task",
    "' Scheduler sees the task as Running while the collector lives, and RestartOnFailure can",
    "' revive it on crash. WScript.Quit propagates the collector's exit code to the scheduler.",
    "Dim shell, code",
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
    `code = shell.Run(Chr(34) & "${runtimeExe}" & Chr(34) & " " & Chr(34) & "${COLLECTOR_PATH}" & Chr(34), 0, True)`,
    "WScript.Quit(code)",
    "",
  ].join("\r\n");
  await fsp.writeFile(LAUNCHER_PATH, vbs, "utf8");
  log(`[OK] Launcher generated at ${LAUNCHER_PATH} (runtime: ${runtimeExe})`);
}

function taskXml(userId) {
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent Insight WorkBuddy trace collector (auto-start on logon).</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escape(wscript)}</Command>
      <Arguments>"${escape(LAUNCHER_PATH)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function currentUserId() {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  if (domain && user) return `${domain}\\${user}`;
  return user || "";
}

function schtasks(args) {
  return spawnSync("schtasks.exe", args, { encoding: "utf8", stdio: "pipe" });
}

async function installTask(start) {
  const userId = currentUserId();
  if (!userId) fail("Cannot determine current user (USERNAME is empty)");
  // Task XML 要求 UTF-16。
  const xml = taskXml(userId);
  const xmlPath = path.join(os.tmpdir(), `agent-insight-workbuddy-${process.pid}.xml`);
  await fsp.writeFile(xmlPath, "\uFEFF" + xml, { encoding: "utf16le" });
  try {
    const create = schtasks(["/create", "/tn", TASK_NAME, "/xml", xmlPath, "/f"]);
    if (create.status !== 0) {
      fail("Failed to register scheduled task", (create.stderr || create.stdout || "").trim());
    }
    log(`[OK] Scheduled task registered: ${TASK_NAME} (logon trigger + restart on failure)`);
    if (start) {
      const run = schtasks(["/run", "/tn", TASK_NAME]);
      if (run.status !== 0) {
        console.error(`  [WARN] Immediate start failed (will auto-start on next logon): ${(run.stderr || run.stdout || "").trim()}`);
      } else {
        log("[OK] Collector started");
      }
    }
  } finally {
    await fsp.unlink(xmlPath).catch(() => {});
  }
}

function status() {
  const q = schtasks(["/query", "/tn", TASK_NAME, "/v", "/fo", "LIST"]);
  if (q.status !== 0) {
    log(`Not installed (no scheduled task ${TASK_NAME})`);
    return;
  }
  log(q.stdout.trim());
  log(`Config: ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : "(missing)"}`);
}

async function uninstall() {
  // End the running task instance first (launcher now waits on the collector),
  // then remove the task definition.
  schtasks(["/end", "/tn", TASK_NAME]);
  const del = schtasks(["/delete", "/tn", TASK_NAME, "/f"]);
  if (del.status === 0) log(`[OK] Scheduled task deleted: ${TASK_NAME}`);
  else log(`(Scheduled task ${TASK_NAME} not present or already deleted)`);
  // Kill any still-running collector via the lock file's PID.
  try {
    const lockPath = path.join(HOME, ".agent-insight", "otel_data", "workbuddy", "collector.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock?.pid) spawnSync("taskkill", ["/PID", String(lock.pid), "/F"], { stdio: "ignore" });
    fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
  log("  Collector scripts and config are kept; to fully remove, delete ~/.agent-insight/packages/workbuddy and ~/.agent-insight/otel_data/workbuddy");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(`Usage (with Node):
  node scripts/workbuddy_setup.mjs --host <url> --token <apiKey> [--no-start]
  node scripts/workbuddy_setup.mjs --status
  node scripts/workbuddy_setup.mjs --uninstall

Without Node (reuse WorkBuddy's bundled runtime to install; use schtasks for status/uninstall):
  $env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\\Programs\\WorkBuddy\\WorkBuddy.exe" <this script path> --host <url> --token <apiKey>
  Status:    schtasks /query /tn ${TASK_NAME}
  Uninstall: schtasks /delete /tn ${TASK_NAME} /f`);
    return;
  }
  if (args.status) return status();
  if (args.uninstall) return uninstall();

  if (process.platform !== "win32") {
    fail(
      "This installer only covers Windows (Task Scheduler)",
      "When a macOS/Linux WorkBuddy exists, reuse the systemd/launchd path in scripts/install-ras-client.js.",
    );
  }
  if (!args.host) fail("Missing --host", "Example: --host http://localhost:3000");
  if (!args.token) fail("Missing --token (Agent Insight API Key)");
  if (!detectWorkBuddy()) {
    fail("WorkBuddy not detected", "Install and open WorkBuddy at least once first (~/.workbuddy must exist)");
  }

  // Prefer WorkBuddy's bundled Electron as the runtime (no separate Node needed); else fall back to the current interpreter.
  const runtimeExe = findWorkBuddyExe() || process.execPath;

  const endpoint = normalizeEndpoint(args.host);
  await stageRuntime();
  await writeConfig(endpoint, args.token);
  await writeLauncher(runtimeExe);
  await installTask(args.start);

  log("");
  log("[OK] Installation complete. The collector runs as a logon auto-start scheduled task; no manual start needed.");
  if (findWorkBuddyExe()) log("  Runtime: reuses WorkBuddy's bundled Electron (ELECTRON_RUN_AS_NODE); no separate Node.js required.");
  // Print copy-paste management commands (PowerShell, Node-free — this machine may have no standalone node).
  const collectorMatch = "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | Where-Object { $_.CommandLine -like '*collector.mjs*' }";
  log("");
  log("Manage the collector (copy into PowerShell; no Node needed):");
  log(`  Start:     schtasks /run /tn "${TASK_NAME}"`);
  log(`  Stop:      schtasks /end /tn "${TASK_NAME}"`);
  log(`  Status:    schtasks /query /tn "${TASK_NAME}" /v /fo LIST`);
  log(`  Running?:  ${collectorMatch} | Select-Object ProcessId,CreationDate`);
  log(`  Uninstall: schtasks /end /tn "${TASK_NAME}"; schtasks /delete /tn "${TASK_NAME}" /f`);
}

main().catch((error) => fail(error?.message || String(error)));
