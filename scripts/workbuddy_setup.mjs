/**
 * WorkBuddy Trace 采集器安装器（Windows）。
 *
 * 目标：装完即用、无需手动启动 —— 通过 Windows 计划任务（Task Scheduler）登录触发 +
 * 失败自动重启，实现开机/登录自动拉起与崩溃自愈。等价于平台在 Linux(systemd --user)/
 * macOS(launchd) 已有、而 Windows 一直缺失的常驻客户端自启动能力。
 *
 * 用法：
 *   node scripts/workbuddy_setup.mjs --host <url> --token <apiKey> [--no-start]
 *   node scripts/workbuddy_setup.mjs --status
 *   node scripts/workbuddy_setup.mjs --uninstall
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
  log(`✓ 采集器已部署到 ${INSTALL_DIR}`);
}

async function writeConfig(endpoint, apiKey) {
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify({ endpoint, apiKey }, null, 2), { encoding: "utf8", mode: 0o600 });
  log(`✓ 配置已写入 ${CONFIG_PATH}`);
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
    "' AgentInsight WorkBuddy Collector 隐藏窗口启动器（安装时生成，路径已写死）",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
    `shell.Run Chr(34) & "${runtimeExe}" & Chr(34) & " " & Chr(34) & "${COLLECTOR_PATH}" & Chr(34), 0, False`,
    "",
  ].join("\r\n");
  await fsp.writeFile(LAUNCHER_PATH, vbs, "utf8");
  log(`✓ 启动器已生成 ${LAUNCHER_PATH}（运行时: ${runtimeExe}）`);
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
  if (!userId) fail("无法确定当前用户（USERNAME 为空）");
  // Task XML 要求 UTF-16。
  const xml = taskXml(userId);
  const xmlPath = path.join(os.tmpdir(), `agent-insight-workbuddy-${process.pid}.xml`);
  await fsp.writeFile(xmlPath, "\uFEFF" + xml, { encoding: "utf16le" });
  try {
    const create = schtasks(["/create", "/tn", TASK_NAME, "/xml", xmlPath, "/f"]);
    if (create.status !== 0) {
      fail("注册计划任务失败", (create.stderr || create.stdout || "").trim());
    }
    log(`✓ 计划任务已注册: ${TASK_NAME}（登录触发 + 失败自动重启）`);
    if (start) {
      const run = schtasks(["/run", "/tn", TASK_NAME]);
      if (run.status !== 0) {
        console.error(`  ⚠ 立即启动失败（下次登录会自动拉起）: ${(run.stderr || run.stdout || "").trim()}`);
      } else {
        log("✓ 采集器已立即启动");
      }
    }
  } finally {
    await fsp.unlink(xmlPath).catch(() => {});
  }
}

function status() {
  const q = schtasks(["/query", "/tn", TASK_NAME, "/v", "/fo", "LIST"]);
  if (q.status !== 0) {
    log(`未注册（无计划任务 ${TASK_NAME}）`);
    return;
  }
  log(q.stdout.trim());
  log(`配置: ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : "（缺失）"}`);
}

async function uninstall() {
  const del = schtasks(["/delete", "/tn", TASK_NAME, "/f"]);
  if (del.status === 0) log(`✓ 已删除计划任务 ${TASK_NAME}`);
  else log(`（计划任务 ${TASK_NAME} 不存在或已删除）`);
  // 结束可能仍在运行的采集器（通过 lock 文件的 PID）。
  try {
    const lockPath = path.join(HOME, ".agent-insight", "otel_data", "workbuddy", "collector.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock?.pid) spawnSync("taskkill", ["/PID", String(lock.pid), "/F"], { stdio: "ignore" });
    fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
  log("  采集器脚本与配置保留；如需彻底清理请手动删除 ~/.agent-insight/packages/workbuddy 与 ~/.agent-insight/otel_data/workbuddy");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(`用法:
  node scripts/workbuddy_setup.mjs --host <url> --token <apiKey> [--no-start]
  node scripts/workbuddy_setup.mjs --status
  node scripts/workbuddy_setup.mjs --uninstall`);
    return;
  }
  if (args.status) return status();
  if (args.uninstall) return uninstall();

  if (process.platform !== "win32") {
    fail(
      "本安装器仅覆盖 Windows（Task Scheduler）",
      "macOS/Linux 版 WorkBuddy 出现后，可复用 scripts/install-ras-client.js 的 systemd/launchd 实现。",
    );
  }
  if (!args.host) fail("缺少 --host", "示例: --host http://localhost:3000");
  if (!args.token) fail("缺少 --token（Agent Insight API Key）");
  if (!detectWorkBuddy()) {
    fail("未检测到 WorkBuddy", "请先安装并至少打开一次 WorkBuddy（需存在 ~/.workbuddy 目录）");
  }

  // 优先用 WorkBuddy 自带的 Electron 当运行时（无需单独装 Node）；找不到才回退到当前解释器。
  const runtimeExe = findWorkBuddyExe() || process.execPath;

  const endpoint = normalizeEndpoint(args.host);
  await stageRuntime();
  await writeConfig(endpoint, args.token);
  await writeLauncher(runtimeExe);
  await installTask(args.start);

  log("");
  log("✓ 安装完成。采集器已作为登录自启动的常驻任务运行，无需手动启动。");
  if (findWorkBuddyExe()) log("  运行时: 复用 WorkBuddy 自带 Electron（ELECTRON_RUN_AS_NODE），无需单独安装 Node.js。");
  log(`  状态: node scripts/workbuddy_setup.mjs --status`);
  log(`  卸载: node scripts/workbuddy_setup.mjs --uninstall`);
}

main().catch((error) => fail(error?.message || String(error)));
