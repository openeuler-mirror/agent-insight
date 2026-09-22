/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

// Only the unmodified pre-AGENT_INSIGHT_HOME release may be migrated automatically.
const UPGRADEABLE = {
  "trace-transport.cjs": new Set(["9fd0637399b14ac69810e20e3ec2e8d2aedbb58236b09871d7c158313e26e128"]),
};

async function readRegularFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`Refusing non-regular shared collector module at ${file}`);
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function installSharedModules(sourceDir, targetDir, names) {
  const files = [...new Set([...names, "install-modules.cjs"])];
  const plans = [];
  for (const name of files) {
    const target = path.join(targetDir, name);
    const incoming = await readRegularFile(path.join(sourceDir, name));
    if (!incoming) throw new Error(`Missing shared collector module: ${name}`);
    const current = await readRegularFile(target);
    if (current?.equals(incoming)) continue;
    const hash = current && createHash("sha256").update(current).digest("hex");
    if (current && !UPGRADEABLE[name]?.has(hash)) {
      throw new Error(`Refusing to overwrite a different shared collector module at ${target}`);
    }
    plans.push({ target, incoming, current, hash });
  }

  // Validate every shared dependency before touching the installed package or configuration.
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const { target, incoming, current, hash } of plans) {
    const latest = await readRegularFile(target);
    if (latest?.equals(incoming)) continue;
    if ((current === null) !== (latest === null) || (current && !current.equals(latest))) {
      throw new Error(`Shared collector module changed during installation: ${target}`);
    }
    if (current) {
      await fs.writeFile(`${target}.${hash}.${randomUUID()}.bak`, current, { flag: "wx", mode: 0o600 });
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, incoming, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

module.exports = { installSharedModules };
