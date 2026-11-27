import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const home = process.env.AGENT_INSIGHT_RAS_HOME;
const marker = JSON.parse(fs.readFileSync(path.join(home, 'install.json')));
const { createRasClient } = await import(pathToFileURL(path.join(marker.runtimeRoot, 'platform_adapter/common/ras_client.js')));
const { embedInitError } = await import(pathToFileURL(path.join(marker.runtimeRoot, 'platform_adapter/common/python_bridge.js')));
const client = createRasClient();
const ready = await client.ensure();
assert.ok(ready, embedInitError() || 'Embedded Python failed to initialize');
const hello = await client.hello('e2e-preparation-ffi', 'opencode', {});
assert.ok(hello && !hello.error, 'RAS runtime hello failed');
assert.equal(hello.type, 'welcome');
await client.bye('e2e-preparation-ffi');
console.log(JSON.stringify({ inProcessPython: true, hello: true, responseFields: Object.keys(hello) }));
process.exit(0);
