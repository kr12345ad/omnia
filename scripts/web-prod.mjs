// Production web server for the tunnel: serves the bundled web app and
// proxies the API + control plane. The app calls its own origin, so the
// backend must share it: this listens on 4174 (the tunnel's origin).
import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
const DIST = "/home/krishnaa/omnia/packages/app/dist"
const PORT = 4174
const BACKEND = "http://127.0.0.1:4096"
const CP = "https://openfoodpantry.org/test1/omnia"
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" }

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function proxy(req, res, url, target) {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req)
  const r = await fetch(`${target}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "application/json" },
    body,
  })
  const text = await r.text()
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" })
  res.end(text)
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  try {
    if (url.pathname.startsWith("/test1/omnia")) {
      const rest = url.pathname.slice("/test1/omnia".length) + url.search
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req)
      const r = await fetch(`${CP}${rest}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body,
      })
      const text = await r.text()
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" })
      res.end(text)
      return
    }
    const file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname)
    if (existsSync(file)) {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" })
      res.end(readFileSync(file))
      return
    }
    await proxy(req, res, url, BACKEND)
  } catch (e) {
    res.writeHead(502)
    res.end("proxy error: " + e.message)
  }
}).listen(PORT, "127.0.0.1")
console.log(`omnia web on http://127.0.0.1:${PORT} (backend ${BACKEND})`)
