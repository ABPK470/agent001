/**
 * Browser check tool — opens HTML in headless Chrome and reports errors.
 *
 * This is the agent's "eyes" for web development. Instead of blindly
 * creating HTML/JS/CSS and hoping it works, the agent can:
 *
 *   1. Open the page in a real browser
 *   2. See all console errors, warnings, and network failures
 *   3. Optionally click elements to test interactions
 *   4. Get a structured report to act on
 *
 * Uses Puppeteer with a temporary static file server. The server is
 * spun up on a random port, the page is loaded, errors are collected,
 * and everything is torn down cleanly.
 */

import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join } from "node:path"
import type { Tool } from "../types.js"

/** Workspace directory — browser_check serves files from here. */
let _browserCheckCwd = process.cwd()

export function setBrowserCheckCwd(cwd: string): void {
  _browserCheckCwd = cwd
}

/** MIME types for common web files. */
const MIME: Record<string, string> = {
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
function startStaticServer(dir: string): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const urlPath = decodeURIComponent(req.url?.split("?")[0] ?? "/")
      const filePath = join(dir, urlPath === "/" ? "index.html" : urlPath)

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

export const browserCheckTool: Tool = {
  name: "browser_check",
  description:
    "Open an HTML file in a headless browser and report all errors. " +
    "Returns console errors, warnings, network failures, and uncaught exceptions. " +
    "Use this AFTER creating or modifying web projects (HTML/JS/CSS) to verify " +
    "they actually work. Optionally click elements to test interactions. " +
    "The file is served via a local HTTP server so relative paths work correctly.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the HTML file to check, relative to workspace root (e.g., 'tmp/game/index.html').",
      },
      click: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional CSS selectors to click, in order (e.g., ['#startBtn', '.play-button']). " +
          "Each click waits 500ms for any resulting errors.",
      },
      wait: {
        type: "number",
        description: "Milliseconds to wait after page load before collecting errors (default: 1000).",
      },
    },
    required: ["path"],
  },

  async execute(args) {
    const relPath = String(args.path)
    const clicks = Array.isArray(args.click) ? args.click.map(String) : []
    const waitMs = Math.min(Number(args.wait ?? 1000), 10000)

    // Resolve paths
    const fullPath = join(_browserCheckCwd, relPath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
    const fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1)

    // Verify the file exists
    try {
      await stat(fullPath)
    } catch {
      return `Error: File not found: ${relPath}`
    }

    // Dynamically import puppeteer (it's a heavy dep, only load when needed)
    let launchBrowser: (opts: Record<string, unknown>) => Promise<import("puppeteer").Browser>
    try {
      const pup = await import("puppeteer")
      launchBrowser = (opts) => pup.default.launch(opts as never)
    } catch {
      return "Error: Puppeteer is not installed. Run: npm install puppeteer"
    }

    // Start static file server
    const { server, url } = await startStaticServer(dir)

    // Collect errors
    const consoleErrors: string[] = []
    const consoleWarnings: string[] = []
    const networkErrors: string[] = []
    const uncaughtErrors: string[] = []

    let browser: import("puppeteer").Browser | undefined
    try {
      browser = await launchBrowser({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      const page = await browser.newPage()

      // Collect console messages
      page.on("console", (msg) => {
        const type = msg.type()
        const text = msg.text()
        if (type === "error") consoleErrors.push(text)
        else if (type === "warn") consoleWarnings.push(text)
      })

      // Collect uncaught exceptions
      page.on("pageerror", (err: unknown) => {
        uncaughtErrors.push(err instanceof Error ? err.message : String(err))
      })

      // Collect failed network requests
      page.on("requestfailed", (req) => {
        networkErrors.push(`${req.failure()?.errorText ?? "failed"}: ${req.url()}`)
      })

      // Navigate to the page
      const pageUrl = `${url}/${fileName}`
      const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 })

      if (!response || !response.ok()) {
        const status = response?.status() ?? "unknown"
        return `Error: Page returned HTTP ${status}`
      }

      // Wait for any async errors
      await new Promise((r) => setTimeout(r, waitMs))

      // Perform clicks if requested
      for (const selector of clicks) {
        try {
          await page.click(selector)
          // Wait for click-triggered errors to surface
          await new Promise((r) => setTimeout(r, 500))
        } catch (err) {
          consoleErrors.push(`Click failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Build report
      const lines: string[] = []
      const totalErrors = consoleErrors.length + uncaughtErrors.length + networkErrors.length

      if (totalErrors === 0 && consoleWarnings.length === 0) {
        lines.push("✓ No errors or warnings detected.")
      } else {
        if (uncaughtErrors.length > 0) {
          lines.push(`## Uncaught Exceptions (${uncaughtErrors.length})`)
          for (const e of uncaughtErrors) lines.push(`  - ${e}`)
        }
        if (consoleErrors.length > 0) {
          lines.push(`## Console Errors (${consoleErrors.length})`)
          for (const e of consoleErrors) lines.push(`  - ${e}`)
        }
        if (networkErrors.length > 0) {
          lines.push(`## Network Failures (${networkErrors.length})`)
          for (const e of networkErrors) lines.push(`  - ${e}`)
        }
        if (consoleWarnings.length > 0) {
          lines.push(`## Warnings (${consoleWarnings.length})`)
          for (const w of consoleWarnings) lines.push(`  - ${w}`)
        }
        lines.push("")
        lines.push(`Total: ${totalErrors} error(s), ${consoleWarnings.length} warning(s)`)
      }

      return lines.join("\n")
    } catch (err) {
      return `Error running browser check: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      await browser?.close().catch(() => {})
      server.close()
    }
  },
}
