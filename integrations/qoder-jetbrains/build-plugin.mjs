import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import AdmZip from "adm-zip"

const integrationRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(integrationRoot, "..", "..")
const buildRoot = path.join(integrationRoot, "build")
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z")

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function pluginVersion() {
  const properties = fs.readFileSync(path.join(integrationRoot, "gradle.properties"), "utf8")
  const match = properties.match(/^pluginVersion=(.+)$/m)
  if (!match?.[1]?.trim()) throw new Error("pluginVersion is missing from gradle.properties")
  return match[1].trim()
}

function assertWithinBuildRoot(targetPath) {
  const resolvedRoot = `${path.resolve(buildRoot)}${path.sep}`
  const resolvedTarget = path.resolve(targetPath)
  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to clean a path outside the plugin build directory: ${resolvedTarget}`)
  }
  return resolvedTarget
}

function filesUnder(root) {
  const output = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) output.push(...filesUnder(absolute))
    else if (entry.isFile()) output.push(absolute)
  }
  return output.sort()
}

function addFile(zip, entryName, sourcePath) {
  const normalized = entryName.replaceAll("\\", "/")
  zip.addFile(normalized, fs.readFileSync(sourcePath))
  const entry = zip.getEntry(normalized)
  if (entry) entry.header.time = fixedTimestamp
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: integrationRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

function buildWithIde(ideHome, destination, version) {
  const compilerName = process.platform === "win32" ? "javac.exe" : "javac"
  const compiler = path.join(path.resolve(ideHome), "jbr", "bin", compilerName)
  if (!fs.existsSync(compiler)) {
    throw new Error(`The selected IDE does not contain jbr/bin/${compilerName}: ${ideHome}`)
  }

  const classesRoot = assertWithinBuildRoot(path.join(buildRoot, "portable-classes"))
  const jarRoot = assertWithinBuildRoot(path.join(buildRoot, "portable-jar"))
  fs.rmSync(classesRoot, { recursive: true, force: true })
  fs.rmSync(jarRoot, { recursive: true, force: true })
  fs.mkdirSync(classesRoot, { recursive: true })
  fs.mkdirSync(jarRoot, { recursive: true })

  const javaRoot = path.join(integrationRoot, "src", "main", "java")
  const javaSources = filesUnder(javaRoot).filter((file) => file.endsWith(".java"))
  run(compiler, [
    "--release",
    "17",
    "-encoding",
    "UTF-8",
    "-cp",
    path.join(path.resolve(ideHome), "lib", "*"),
    "-d",
    classesRoot,
    ...javaSources,
  ])

  const jar = new AdmZip()
  for (const file of filesUnder(classesRoot)) {
    addFile(jar, path.relative(classesRoot, file), file)
  }
  const resourcesRoot = path.join(integrationRoot, "src", "main", "resources")
  for (const file of filesUnder(resourcesRoot)) {
    if (file.includes(`${path.sep}collector${path.sep}`)) continue
    addFile(jar, path.relative(resourcesRoot, file), file)
  }
  for (const script of [
    "qoder_trace_collector.mjs",
    "qoder_uploader_client.mjs",
    "qoder_setup.mjs",
    "qoder_token_usage_env.mjs",
  ]) {
    addFile(jar, `collector/${script}`, path.join(repositoryRoot, "scripts", script))
  }

  const jarPath = path.join(jarRoot, `agent-insight-qoder-jetbrains-${version}.jar`)
  jar.writeZip(jarPath)

  const plugin = new AdmZip()
  addFile(
    plugin,
    `agent-insight-qoder-jetbrains/lib/agent-insight-qoder-jetbrains-${version}.jar`,
    jarPath,
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  plugin.writeZip(destination)
}

function buildWithGradle(destination, version) {
  const wrapper = path.join(integrationRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew")
  const command = fs.existsSync(wrapper)
    ? wrapper
    : process.platform === "win32"
      ? "gradle.bat"
      : "gradle"
  run(command, ["--no-daemon", "buildPlugin"])

  const gradleOutput = path.join(
    buildRoot,
    "distributions",
    `agent-insight-qoder-jetbrains-${version}.zip`,
  )
  if (!fs.existsSync(gradleOutput)) {
    throw new Error(`Gradle did not produce ${gradleOutput}`)
  }
  if (path.resolve(gradleOutput) !== path.resolve(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(gradleOutput, destination)
  }
}

export function buildJetBrainsPlugin({ ideHome, outputPath } = {}) {
  const version = pluginVersion()
  const destination = path.resolve(
    outputPath || path.join(buildRoot, "distributions", `agent-insight-qoder-jetbrains-${version}.zip`),
  )
  const selectedIde = ideHome || process.env.JETBRAINS_HOME

  if (selectedIde) buildWithIde(selectedIde, destination, version)
  else buildWithGradle(destination, version)

  return destination
}

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Usage: node build-plugin.mjs [--ide-home <JetBrains IDE>] [--output <path>]",
      "",
      "Uses the selected IDE's JBR compiler when --ide-home or JETBRAINS_HOME is set.",
      "Otherwise it runs Gradle buildPlugin with the repository's build.gradle.kts.",
      `Platform: ${os.platform()}`,
      "",
    ].join("\n"),
  )
} else if (
  process.argv[1]
  && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  const destination = buildJetBrainsPlugin({
    ideHome: argumentValue("--ide-home"),
    outputPath: argumentValue("--output"),
  })
  process.stdout.write(`${destination}\n`)
}
