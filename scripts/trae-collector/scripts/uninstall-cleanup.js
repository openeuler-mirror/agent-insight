#!/usr/bin/env node
/**
 * Agent Insight TRAE Collector — Uninstall Cleanup Script
 *
 * When the user uninstalls the extension from the Extensions panel,
 * VS Code executes this script via the __uninstall hook in package.json.
 *
 * Cleans up external files: hook scripts, config, checkpoint, spool data.
 * Uses only Node.js native APIs (no VS Code API available at uninstall time).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const INSIGHT_DIR = process.env.AGENT_INSIGHT_DIR || path.join(HOME, '.agent-insight');
const TRAE_CN_DIR = path.join(HOME, '.trae-cn');

const paths = {
  hookScripts: path.join(INSIGHT_DIR, 'trae-hooks'),
  hooksJson: path.join(TRAE_CN_DIR, 'hooks.json'),
  hooksJsonServer: path.join(TRAE_CN_DIR + '-server', 'hooks.json'),
  checkpoint: path.join(INSIGHT_DIR, 'trae_uploader_checkpoint.json'),
  spoolDir: path.join(INSIGHT_DIR, 'otel_data', 'trae'),
};

let cleaned = 0;

function rmDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('  [DEL] ' + dir);
      cleaned++;
    }
  } catch (e) {
    console.error('  [ERR] ' + dir + ' - ' + e.message);
  }
}

function rmFile(file) {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log('  [DEL] ' + file);
      cleaned++;
    }
  } catch (e) {
    console.error('  [ERR] ' + file + ' - ' + e.message);
  }
}

console.log('');
console.log('Agent Insight TRAE Collector - Uninstall Cleanup');
console.log('===============================================');

// 1. Remove hook scripts directory
console.log('');
console.log('[1/4] Removing hook scripts...');
if (fs.existsSync(paths.hookScripts)) {
  rmDir(paths.hookScripts);
} else {
  console.log('  (not found)');
}

// 2. Remove hooks.json (only if it contains trae-hooks paths)
console.log('');
console.log('[2/4] Removing TRAE hook config...');
let hooksDeleted = false;
for (const hooksFile of [paths.hooksJson, paths.hooksJsonServer]) {
  if (fs.existsSync(hooksFile)) {
    try {
      const content = fs.readFileSync(hooksFile, 'utf8');
      if (content.includes('trae-hooks')) {
        rmFile(hooksFile);
        hooksDeleted = true;
      } else {
        console.log('  [SKIP] ' + hooksFile + ' (not created by this extension)');
      }
    } catch (e) {
      console.error('  [ERR] ' + hooksFile + ' - ' + e.message);
    }
  }
}
if (!hooksDeleted) {
  console.log('  (none found)');
}

// 3. Remove checkpoint
console.log('');
console.log('[3/4] Removing checkpoint...');
if (fs.existsSync(paths.checkpoint)) {
  rmFile(paths.checkpoint);
} else {
  console.log('  (not found)');
}

// 4. Remove spool data
console.log('');
console.log('[4/4] Removing spool data...');
if (fs.existsSync(paths.spoolDir)) {
  rmDir(paths.spoolDir);
} else {
  console.log('  (not found)');
}

// 5. Verify other framework files are intact
console.log('');
console.log('Other framework files (not modified):');
const otherFiles = [
  path.join(INSIGHT_DIR, 'opencode_uploader_client.js'),
  path.join(INSIGHT_DIR, 'start_opencode_uploader.sh'),
  path.join(INSIGHT_DIR, 'otel_data', 'opencode'),
];
for (const f of otherFiles) {
  if (fs.existsSync(f)) {
    console.log('  [KEEP] ' + f);
  }
}

console.log('');
console.log('Cleanup complete. ' + cleaned + ' items removed.');
console.log('');
