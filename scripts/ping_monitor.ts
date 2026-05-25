import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface PingTarget {
  host: string;
  label?: string;
  intervalMs: number;
  timeoutMs?: number;
  count?: number;
}

interface PingResult {
  host: string;
  label: string;
  timestamp: string;
  success: boolean;
  latencyMs: number | null;
  lossRate: number | null;
  error?: string;
}

interface MonitorConfig {
  targets: PingTarget[];
  logDir: string;
  alertThreshold?: number;
}

const DEFAULT_CONFIG: MonitorConfig = {
  targets: [
    { host: '114.114.114.114', label: 'DNS-电信', intervalMs: 30000, count: 2 },
    { host: '8.8.8.8', label: 'DNS-Google', intervalMs: 30000, count: 2 },
    { host: 'baidu.com', label: '百度', intervalMs: 60000, count: 3 },
  ],
  logDir: path.resolve(process.cwd(), 'data/ping-logs'),
  alertThreshold: 3,
};

function log(msg: string): void {
  const t = new Date().toISOString();
  console.log(`[${t}] ${msg}`);
}

function runPing(host: string, count: number, timeoutSec: number): PingResult {
  const timestamp = new Date().toISOString();
  const label = host;

  try {
    const out = execSync(`ping -c ${count} -W ${timeoutSec} ${host}`, {
      encoding: 'utf-8',
      timeout: (timeoutSec + 2) * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lossMatch = out.match(/(\d+)% packet loss/);
    const lossRate = lossMatch ? parseInt(lossMatch[1]) : null;

    const rttMatch = out.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)\//);
    const latencyMs = rttMatch ? parseFloat(rttMatch[1]) : null;

    return {
      host,
      label,
      timestamp,
      success: lossRate !== null && lossRate < 100,
      latencyMs,
      lossRate,
    };
  } catch (e: any) {
    return {
      host,
      label,
      timestamp,
      success: false,
      latencyMs: null,
      lossRate: 100,
      error: e.stderr?.trim() || e.message,
    };
  }
}

function appendToCsv(logDir: string, targetLabel: string, result: PingResult): void {
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, `${targetLabel}.csv`);
  const header = 'timestamp,success,latencyMs,lossRate,error\n';
  const escapedError = (result.error ?? '').replace(/,/g, ';');
  const line = `${result.timestamp},${result.success},${result.latencyMs ?? ''},${result.lossRate ?? ''},${escapedError}\n`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header);
  }
  fs.appendFileSync(filePath, line);
}

function writeStatusJson(logDir: string, results: PingResult[]): void {
  const filePath = path.join(logDir, '_latest.json');
  fs.writeFileSync(filePath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
}

function main(): void {
  const configPath = path.resolve(process.cwd(), 'ping-monitor-config.json');
  let config: MonitorConfig = DEFAULT_CONFIG;

  if (fs.existsSync(configPath)) {
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config = { ...DEFAULT_CONFIG, ...userConfig };
  }

  log(`Ping Monitor 启动 — 共 ${config.targets.length} 个目标`);
  config.targets.forEach(t => log(`  ${t.label ?? t.host} (${t.host}) 间隔 ${t.intervalMs}ms`));

  let consecutiveFailures = new Map<string, number>();

  for (const target of config.targets) {
    const label = target.label ?? target.host;
    consecutiveFailures.set(label, 0);
  }

  function tick(): void {
    const results: PingResult[] = [];

    for (const target of config.targets) {
      const timeoutSec = Math.ceil((target.timeoutMs ?? 5000) / 1000);
      const result = runPing(target.host, target.count ?? 2, timeoutSec);
      const label = target.label ?? target.host;

      results.push(result);
      appendToCsv(config.logDir, label, result);

      const key = label;
      if (!result.success) {
        const fails = (consecutiveFailures.get(key) ?? 0) + 1;
        consecutiveFailures.set(key, fails);
        log(`⚠ ${key} 不通 (连续 ${fails} 次) loss=${result.lossRate}% latency=${result.latencyMs ?? '-'}ms`);
        if (fails >= (config.alertThreshold ?? 3)) {
          log(`🚨 [告警] ${key} (${target.host}) 已连续 ${fails} 次不可达!`);
        }
      } else {
        consecutiveFailures.set(key, 0);
        log(`✓ ${key} latency=${result.latencyMs}ms loss=${result.lossRate}%`);
      }
    }

    writeStatusJson(config.logDir, results);
  }

  tick();

  const intervals: ReturnType<typeof setInterval>[] = [];

  const uniqueIntervals = [...new Set(config.targets.map(t => t.intervalMs))];
  for (const ms of uniqueIntervals) {
    const intervalTargets = config.targets.filter(t => t.intervalMs === ms);
    intervals.push(setInterval(() => {
      const results: PingResult[] = [];
      for (const target of intervalTargets) {
        const timeoutSec = Math.ceil((target.timeoutMs ?? 5000) / 1000);
        const result = runPing(target.host, target.count ?? 2, timeoutSec);
        const label = target.label ?? target.host;
        results.push(result);
        appendToCsv(config.logDir, label, result);

        if (!result.success) {
          const fails = (consecutiveFailures.get(label) ?? 0) + 1;
          consecutiveFailures.set(label, fails);
          log(`⚠ ${label} 不通 (连续 ${fails} 次) loss=${result.lossRate}% latency=${result.latencyMs ?? '-'}ms`);
          if (fails >= (config.alertThreshold ?? 3)) {
            log(`🚨 [告警] ${label} (${target.host}) 已连续 ${fails} 次不可达!`);
          }
        } else {
          consecutiveFailures.set(label, 0);
          log(`✓ ${label} latency=${result.latencyMs}ms loss=${result.lossRate}%`);
        }
      }
      writeStatusJson(config.logDir, results);
    }, ms));
  }

  process.on('SIGINT', () => {
    log('收到 SIGINT，停止监控');
    intervals.forEach(i => clearInterval(i));
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('收到 SIGTERM，停止监控');
    intervals.forEach(i => clearInterval(i));
    process.exit(0);
  });

  log(`Ping Monitor 运行中。日志目录: ${config.logDir}`);
}

main();
