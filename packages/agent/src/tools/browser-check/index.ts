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
 * Uses Playwright with a temporary static file server. The server is
 * spun up on a random port, the page is loaded, errors are collected,
 * and everything is torn down cleanly.
 */

import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { AgentHost } from "../../application/shell/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/agent-types.js"
import { startStaticServer } from "./static-server.js"

/** Result from a sandboxed browser check. */
export interface BrowserCheckResult {
  /** Structured report text. */
  report: string
  /** Whether the check ran in Docker or on host. */
  sandboxed: boolean
}

/**
 * Optional executor injected by the host for Docker-sandboxed browser checks.
 * When present (host.browserCheck.client), the browser runs inside a container
 * with Chromium + its own sandbox. No ambient `setBrowserCheckExecutor` setter
 * exists — wire the client via `configureAgent({ browserCheckClient })` in the
 * server boot.
 */
export type BrowserCheckExecutor = (
  htmlPath: string,
  clicks: string[],
  waitMs: number,
  cwd: string,
) => Promise<BrowserCheckResult>

// ── Constants (hoisted so const-tool initializers don't trip TDZ) ─

const BROWSER_CHECK_DESCRIPTION =
  "Open an HTML file in a headless browser and report all errors. " +
  "Returns console errors, warnings, network failures, and uncaught exceptions. " +
  "Use this AFTER creating or modifying web projects (HTML/JS/CSS) to verify " +
  "they actually work. Optionally click elements to test interactions. " +
  "IMPORTANT: The file is served via a local HTTP server rooted at the HTML file's " +
  "parent directory. All CSS/JS/image references in the HTML must be relative to " +
  "that directory. If your HTML is at tmp/game/index.html, references like " +
  "'css/styles.css' resolve to tmp/game/css/styles.css. Place ALL project assets " +
  "(CSS, JS, images) under the same directory as the HTML file."

const BROWSER_CHECK_PARAMETERS = {
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
} as const

export const browserCheckToolMetadata: ToolMetadata = {
  name: "browser_check",
  description: BROWSER_CHECK_DESCRIPTION,
  parameters: BROWSER_CHECK_PARAMETERS,
}

export const browserCheckTool = browserCheckToolMetadata

/** Factory variant bound to `host.browserCheck.{cwd,client}`. */
export function createBrowserCheckTool(host: AgentHost): ExecutableTool {
  return {
    ...browserCheckToolMetadata,
    async execute(args) {
      return runBrowserCheck(args, {
        cwd: host.browserCheck.cwd,
        executor: host.browserCheck.client,
      })
    },
  }
}

// ── Shared body ──────────────────────────────────────────────────

interface BrowserCheckCtx {
  cwd: string
  executor: BrowserCheckExecutor | null
}

async function runBrowserCheck(
  args: Record<string, unknown>,
  ctx: BrowserCheckCtx,
): Promise<string> {
    const relPath = String(args.path)
    const clicks = Array.isArray(args.click) ? args.click.map(String) : []
    const waitMs = Math.min(Number(args.wait ?? 1000), 10000)

    // Resolve paths
    const fullPath = join(ctx.cwd, relPath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
    const fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1)

    // Verify the file exists
    try {
      await stat(fullPath)
    } catch {
      return `Error: File not found: ${relPath}`
    }

    // Route through Docker sandbox if executor is available
    if (ctx.executor) {
      try {
        const result = await ctx.executor(relPath, clicks, waitMs, ctx.cwd)
        return result.report
      } catch (err) {
        return `Error running sandboxed browser check: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Fallback: run Playwright on host

    // Dynamically import playwright (it's a heavy dep, only load when needed)
    let launchBrowser: (opts: Record<string, unknown>) => Promise<import("playwright").Browser>
    try {
      const pw = await import("playwright")
      launchBrowser = (opts) => pw.chromium.launch(opts as never)
    } catch {
      return "Error: Playwright is not installed. Run: npm install playwright && npx playwright install chromium"
    }

    // Start static file server
    const { server, url } = await startStaticServer(dir)

    // Collect errors
    const consoleErrors: string[] = []
    const consoleWarnings: string[] = []
    const networkErrors: string[] = []
    const uncaughtErrors: string[] = []

    let browser: import("playwright").Browser | undefined
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
        if (type === "error") {
          // Enrich generic "Failed to load resource" with the actual URL
          const location = msg.location()
          const errUrl = location?.url ?? ""
          // Skip non-critical missing resources (favicon, apple-touch-icon, etc.)
          if (text.includes("Failed to load resource") && /favicon|apple-touch-icon/i.test(errUrl)) {
            // Ignore — these are browser-initiated requests, not project bugs
          } else if (text.includes("Failed to load resource") && errUrl) {
            consoleErrors.push(`${text} — URL: ${errUrl}`)
          } else {
            consoleErrors.push(text)
          }
        } else if (type === "warning") consoleWarnings.push(text)
      })

      // Collect uncaught exceptions
      page.on("pageerror", (err: unknown) => {
        uncaughtErrors.push(err instanceof Error ? err.message : String(err))
      })

      // Collect failed network requests (skip non-critical assets)
      page.on("requestfailed", (req) => {
        const reqUrl = req.url()
        if (/favicon|apple-touch-icon/i.test(reqUrl)) return
        networkErrors.push(`${req.failure()?.errorText ?? "failed"}: ${reqUrl}`)
      })

      // Navigate to the page
      const pageUrl = `${url}/${fileName}`
      const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 })

      if (!response || !response.ok()) {
        const status = response?.status() ?? "unknown"
        return `Error: Page returned HTTP ${status} for ${pageUrl}`
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

        // If there are 404s, add actionable context about the server root
        const has404 = consoleErrors.some((e) => e.includes("404")) || networkErrors.some((e) => e.includes("ERR_ABORTED") || e.includes("404"))
        if (has404) {
          lines.push("")
          lines.push(`## Path Resolution`)
          lines.push(`  Static server root: ${dir}/`)
          lines.push(`  All <script src>, <link href>, and other references in the HTML are resolved relative to this directory.`)
          lines.push(`  To fix 404s: ensure the referenced files exist under ${dir}/ with matching paths.`)
          lines.push(`  Use list_directory to verify the file structure, then either move the files or fix the HTML references.`)
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
}
