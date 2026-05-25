import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const port = Number(process.env.OTEL_CAPTURE_PORT || 4318)
const outPath =
  process.env.OTEL_CAPTURE_PATH ||
  path.join(os.homedir(), ".opencode", "witty_otel_capture.jsonl")

fs.mkdirSync(path.dirname(outPath), { recursive: true })

function redactHeaders(headers) {
  const out = {}
  for (const [k0, v] of Object.entries(headers || {})) {
    const k = String(k0).toLowerCase()
    if (k === "authorization") continue
    if (k === "proxy-authorization") continue
    if (k === "cookie") continue
    if (k === "set-cookie") continue
    if (k.startsWith("x-") && k.includes("key")) continue
    if (k.startsWith("x-") && k.includes("token")) continue
    out[k] = v
  }
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET"
    const url = req.url || "/"

    if (method !== "POST") {
      res.statusCode = 405
      res.end()
      return
    }

    if (!(url === "/v1/traces" || url === "/v1/metrics" || url === "/v1/logs")) {
      res.statusCode = 404
      res.end()
      return
    }

    const body = await readBody(req)
    const line = {
      ts: new Date().toISOString(),
      path: url,
      headers: redactHeaders(req.headers),
      bytes: body.length,
      body_base64: body.toString("base64"),
    }
    fs.appendFileSync(outPath, JSON.stringify(line) + "\n", "utf8")

    res.statusCode = 200
    res.setHeader("content-type", "text/plain")
    res.end("ok")
  } catch (e) {
    res.statusCode = 500
    res.end()
  }
})

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`OTLP http/protobuf collector listening on http://127.0.0.1:${port}\n`)
  process.stdout.write(`Writing JSONL to ${outPath}\n`)
})

