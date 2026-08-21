import { installCollector } from './configure.mjs';

try {
  console.log(JSON.stringify({ status: 'configured-native-otlp', ...(await installCollector()) }, null, 2));
} catch (error) {
  console.error(`[qwencode-collector] Installation failed: ${error.message}`);
  process.exitCode = 1;
}
