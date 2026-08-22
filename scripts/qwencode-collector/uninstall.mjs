import { uninstallCollector } from './configure.mjs';

try {
  console.log(JSON.stringify({ status: 'unconfigured-native-otlp', ...(await uninstallCollector()) }, null, 2));
} catch (error) {
  console.error(`[qwencode-collector] Uninstall failed: ${error.message}`);
  process.exitCode = 1;
}
