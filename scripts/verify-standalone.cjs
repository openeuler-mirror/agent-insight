const fs = require('node:fs');
const path = require('node:path');

function verifyStandalone(root) {
  const required = [
    'server.js', '.next/BUILD_ID', '.next/required-server-files.json',
    '.next/server/app-paths-manifest.json', '.next/server/pages-manifest.json',
  ];
  const check = (relative) => {
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Incomplete standalone build: missing ${relative}. Stop the running server before rebuilding.`);
    }
  };
  required.forEach(check);
  const appPaths = JSON.parse(fs.readFileSync(path.join(root, '.next/server/app-paths-manifest.json'), 'utf8'));
  for (const file of Object.values(appPaths)) {
    check(`.next/server/${file}`);
    if (file.endsWith('/page.js')) check(`.next/server/${file.replace(/\.js$/, '_client-reference-manifest.js')}`);
  }
  const pages = JSON.parse(fs.readFileSync(path.join(root, '.next/server/pages-manifest.json'), 'utf8'));
  for (const file of Object.values(pages)) check(`.next/server/${file}`);
}

if (require.main === module) {
  try {
    verifyStandalone(process.argv[2] || '.next/standalone');
    console.log('Standalone page manifests verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyStandalone };
