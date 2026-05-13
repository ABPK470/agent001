/**
 * Tiny static file server used by browser_check. Extracted from browser-check.ts.
 *
 * @module
 */

import { readFile } from "node:fs/promises"
import { type IncomingMessage, type ServerResponse, createServer } from "node:http"
import { extname, join } from "node:path"

/** MIME types for common web files. */
export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
}

/**
 * Spin up a minimal static file server rooted at `dir`.
 * Returns the server + the URL it's listening on.
 */
export function startStaticServer(dir: string): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const urlPath = decodeURIComponent(req.url?.split("?")[0] ?? "/")
      const relPath = (urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "")) || "index.html"
      const filePath = join(dir, relPath)

      // Prevent path traversal
      if (!filePath.startsWith(dir)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }

      try {
        const content = await readFile(filePath)
        const ext = extname(filePath).toLowerCase()
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
        res.end(content)
      } catch {
        res.writeHead(404)
        res.end("Not found")
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` })
      } else {
        reject(new Error("Failed to start static server"))
      }
    })
    server.on("error", reject)
  })
}
