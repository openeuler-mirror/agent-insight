#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const [action, value] = process.argv.slice(2);
if (!['catalog', 'create', 'run', 'report', 'cancel'].includes(action)) {
  console.error('用法：node scripts/evaluation-harness-cli.mjs catalog | create config.json | run ID | report ID | cancel ID');
  process.exitCode = 1;
} else {
  try {
    const base = process.env.AGENT_INSIGHT_URL || 'http://127.0.0.1:3000';
    const key = process.env.AGENT_INSIGHT_API_KEY;
    if (!key) throw new Error('需要 AGENT_INSIGHT_API_KEY 环境变量');
    const body = action === 'create' ? {
      action,
      config: JSON.parse(await readFile(value, 'utf8'))
    } : ['run', 'cancel'].includes(action) ? {
      action,
      id: value
    } : undefined;
    const url = base.replace(/\/$/, '') + '/api/evaluation-harness' + (action === 'report' ? '?experimentId=' + encodeURIComponent(value) : '');
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'x-witty-api-key': key,
        'content-type': 'application/json'
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: 'error'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || String(response.status));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
