/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MANIFEST = "installation.json";
const SHARED_ABI = 1;
const UPGRADEABLE = {
  "trace-transport.cjs": new Set([
    "9fd0637399b14ac69810e20e3ec2e8d2aedbb58236b09871d7c158313e26e128",
    "9fda3fa4224105a48a6619f764c7bee04c1bdc0df32a74d880a295a1e5f03da6",
    "f550a10d49e564c9a088bb9a4f295a1a6c3cdb8bd889aa1589b3f1a30743be17",
  ]),
  "install-modules.cjs": new Set([
    "8d54ec546990463477e30c9a20773f2b3c0c9845ee768ea7d8180286b8326e22",
    "52e47d6e3a99a82c5638acad1eeab1194e307831592243d96c191fd6fec39a08",
  ]),
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

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

async function atomicFile(file, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readManifest(directory) {
  const bytes = await readRegularFile(path.join(directory, MANIFEST));
  if (!bytes) return null;
  const value = JSON.parse(bytes);
  if (value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error(`Invalid collector installation manifest at ${directory}`);
  }
  for (const [name, hash] of Object.entries(value.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid collector installation manifest entry at ${directory}`);
    }
  }
  return value;
}

async function checkManifest(directory) {
  const manifest = await readManifest(directory);
  if (!manifest) return { ok: false, buildId: null, reason: "installation_manifest_missing" };
  const changed = [];
  for (const [name, hash] of Object.entries(manifest.files)) {
    const bytes = await readRegularFile(path.join(directory, name));
    if (!bytes || digest(bytes) !== hash) changed.push(name);
  }
  return { ok: changed.length === 0, buildId: manifest.buildId, changed };
}

async function writeManifest(directory, names, extra = {}) {
  const files = {};
  for (const name of [...new Set(names)].sort()) {
    const bytes = await readRegularFile(path.join(directory, name));
    if (!bytes) throw new Error(`Missing installed collector file: ${name}`);
    files[name] = digest(bytes);
  }
  const manifest = { version: 1, ...extra, buildId: digest(JSON.stringify(files)), files };
  await atomicFile(path.join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function validatePackage(sourceDir, targetDir, names) {
  const manifest = await readManifest(targetDir);
  for (const name of names) {
    const incoming = await readRegularFile(path.join(sourceDir, name));
    if (!incoming) throw new Error(`Missing collector package file: ${name}`);
    const current = await readRegularFile(path.join(targetDir, name));
    if (current && !current.equals(incoming) && manifest && manifest.files[name] !== digest(current)) {
      throw new Error(`Refusing to overwrite a locally modified collector file at ${path.join(targetDir, name)}`);
    }
  }
}

async function prepareSharedModules(sourceDir, targetDir, names) {
  const files = [...new Set([...names, "install-modules.cjs"])];
  const manifest = await readManifest(targetDir);
  if (manifest && manifest.sharedAbi !== SHARED_ABI) {
    throw new Error(`Incompatible shared collector ABI at ${targetDir}; upgrade dependent collectors together`);
  }
  for (const [name, hash] of Object.entries(manifest?.files || {})) {
    if (files.includes(name)) continue;
    const current = await readRegularFile(path.join(targetDir, name));
    if (!current || digest(current) !== hash) {
      throw new Error(`Refusing to re-certify a modified shared collector module at ${path.join(targetDir, name)}`);
    }
  }
  const plans = [];
  for (const name of files) {
    const target = path.join(targetDir, name);
    const incoming = await readRegularFile(path.join(sourceDir, name));
    if (!incoming) throw new Error(`Missing shared collector module: ${name}`);
    const current = await readRegularFile(target);
    const hash = current && digest(current);
    if (current && !current.equals(incoming) && manifest?.files[name] !== hash && !UPGRADEABLE[name]?.has(hash)) {
      throw new Error(`Refusing to overwrite a different shared collector module at ${target}; preserve local changes before retrying`);
    }
    plans.push({ target, incoming, current, hash });
  }
  return { plans, files: [...new Set([...Object.keys(manifest?.files || {}), ...files])] };
}

async function withFileRollback(files, operation) {
  const originals = [];
  for (const file of [...new Set(files)]) {
    const bytes = await readRegularFile(file);
    originals.push({ file, bytes, mode: bytes === null ? 0o600 : (await fs.stat(file)).mode & 0o777 });
  }
  try {
    return await operation();
  } catch (error) {
    const failures = [];
    for (const { file, bytes, mode } of originals.reverse()) {
      try {
        if (bytes === null) await fs.rm(file, { force: true });
        else await atomicFile(file, bytes, mode);
      } catch (rollbackError) { failures.push(`${file}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new Error(`${error.message}; rollback failed: ${failures.join("; ")}`);
    throw error;
  }
}

async function installSharedModules(sourceDir, targetDir, names) {
  const { plans, files } = await prepareSharedModules(sourceDir, targetDir, names);
  return withFileRollback([...plans.map(item => item.target), path.join(targetDir, MANIFEST)], async () => {
    for (const { target, incoming, current, hash } of plans) {
      const latest = await readRegularFile(target);
      if (latest?.equals(incoming)) continue;
      if ((current === null) !== (latest === null) || (current && !current.equals(latest))) {
        throw new Error(`Shared collector module changed during installation: ${target}`);
      }
      if (current) {
        await fs.writeFile(`${target}.${hash}.${randomUUID()}.bak`, current, { flag: "wx", mode: 0o600 });
      }
      await atomicFile(target, incoming);
    }
    return writeManifest(targetDir, files, { sharedAbi: SHARED_ABI });
  });
}

module.exports = { MANIFEST, atomicFile, checkManifest, installSharedModules, prepareSharedModules, readRegularFile, validatePackage, withFileRollback, writeManifest };
