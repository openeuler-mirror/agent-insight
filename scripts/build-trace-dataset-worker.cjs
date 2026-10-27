const path = require('node:path');
const fs = require('node:fs');
function buildTraceDatasetWorker() {
  const root = path.resolve(__dirname, '..');
  const outfile = path.join(root, 'generated/trace-datasets/worker.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/server/trace-datasets/worker.ts')], outfile, bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['@prisma/client'], logLevel: 'silent' });
  return outfile;
}
module.exports = { buildTraceDatasetWorker };
if (require.main === module) console.log(buildTraceDatasetWorker());
