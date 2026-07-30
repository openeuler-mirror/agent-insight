import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import AdmZip from "adm-zip"

const integrationRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(integrationRoot, "..", "..")
const defaultOutputRoot = path.join(integrationRoot, "build", "distributions")
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z")

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function addBuffer(zip, entryName, content) {
  zip.addFile(entryName.replaceAll("\\", "/"), Buffer.from(content))
  const entry = zip.getEntry(entryName.replaceAll("\\", "/"))
  if (entry) entry.header.time = fixedTimestamp
}

function addFile(zip, entryName, sourcePath) {
  addBuffer(zip, entryName, fs.readFileSync(sourcePath))
}

function packageManifest(extensionPackage) {
  const engine = extensionPackage.engines?.vscode || "*"
  const repository = extensionPackage.repository?.url || ""
  const extensionKind = Array.isArray(extensionPackage.extensionKind)
    ? extensionPackage.extensionKind.join(",")
    : extensionPackage.extensionKind || ""
  const categories = Array.isArray(extensionPackage.categories)
    ? extensionPackage.categories.join(",")
    : extensionPackage.categories || ""

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(extensionPackage.name)}" Version="${xmlEscape(extensionPackage.version)}" Publisher="${xmlEscape(extensionPackage.publisher)}" />
    <DisplayName>${xmlEscape(extensionPackage.displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(extensionPackage.description)}</Description>
    <Categories>${xmlEscape(categories)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xmlEscape(extensionKind)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape(repository)}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Repository" Value="${xmlEscape(repository)}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

export function buildDesktopVsix(outputPath) {
  const extensionPackagePath = path.join(integrationRoot, "package.json")
  const extensionPackage = JSON.parse(fs.readFileSync(extensionPackagePath, "utf8"))
  const destination = path.resolve(
    outputPath || path.join(defaultOutputRoot, `agent-insight-qoder-desktop-${extensionPackage.version}.vsix`),
  )
  const zip = new AdmZip()

  addBuffer(zip, "extension.vsixmanifest", packageManifest(extensionPackage))
  addBuffer(
    zip,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".mjs" ContentType="application/javascript" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`,
  )
  addFile(zip, "extension/package.json", extensionPackagePath)
  addFile(zip, "extension/extension.js", path.join(integrationRoot, "extension.js"))
  addFile(zip, "extension/uninstall-watcher.mjs", path.join(integrationRoot, "uninstall-watcher.mjs"))
  addFile(zip, "extension/LICENSE.txt", path.join(repositoryRoot, "LICENSE"))

  for (const script of [
    "qoder_trace_collector.mjs",
    "qoder_uploader_client.mjs",
    "qoder_setup.mjs",
    "qoder_token_usage_env.mjs",
  ]) {
    addFile(zip, `extension/collector/${script}`, path.join(repositoryRoot, "scripts", script))
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  zip.writeZip(destination)
  return destination
}

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: node build-vsix.mjs [--output <path>]\n")
} else if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${buildDesktopVsix(argumentValue("--output"))}\n`)
}
