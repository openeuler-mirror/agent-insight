import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

test("standalone control server reuses serialized config without compiling next.config.ts", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/control-server.js"),
    "utf8",
  )

  assert.match(source, /required-server-files\.json/)
  assert.match(source, /__NEXT_PRIVATE_STANDALONE_CONFIG/)
  assert.match(source, /conf: requiredServerFiles\.config/)
})

test("standalone control server exposes the npm package root before changing cwd", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/control-server.js"),
    "utf8",
  )

  const packageRootAt = source.indexOf("AGENT_INSIGHT_PACKAGE_ROOT")
  const chdirAt = source.indexOf("process.chdir(STANDALONE_ROOT)")
  assert.ok(packageRootAt >= 0)
  assert.ok(chdirAt >= 0)
  assert.ok(packageRootAt < chdirAt)
})

test("npm packaging removes nested tarballs from standalone", () => {
  const nextConfig = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8")
  const prepare = fs.readFileSync(
    path.join(process.cwd(), "scripts/prepare-npm-package.js"),
    "utf8",
  )

  assert.match(nextConfig, /['"]\*\.tgz['"]/)
  assert.match(prepare, /entry\.name\.endsWith\(['"]\.tgz['"]\)/)
})
