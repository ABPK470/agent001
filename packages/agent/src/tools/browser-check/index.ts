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
 * Optional executor injected by the host for sandboxed browser checks.
 * When host.browserCheck.mode is "sandbox", the browser runs inside a container
 * with Chromium + its own sandbox and this executor must be present.
 */
export type BrowserCheckExecutor = (
  htmlPath: string,
  clicks: string[],
  waitMs: number,
  cwd: string
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
      description: "Path to the HTML file to check, relative to workspace root (e.g., 'tmp/game/index.html')."
    },
    click: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional CSS selectors to click, in order (e.g., ['#startBtn', '.play-button']). " +
        "Each click waits 500ms for any resulting errors."
    },
    wait: {
      type: "number",
      description: "Milliseconds to wait after page load before collecting errors (default: 1000)."
    }
  },
  required: ["path"]
} as const

export const browserCheckToolMetadata: ToolMetadata = {
  name: "browser_check",
  description: BROWSER_CHECK_DESCRIPTION,
  parameters: BROWSER_CHECK_PARAMETERS
}

export const browserCheckTool = browserCheckToolMetadata

/** Factory variant bound to `host.browserCheck.{mode,cwd,client}`. */
export function createBrowserCheckTool(host: AgentHost): ExecutableTool {
  return {
    ...browserCheckToolMetadata,
    async execute(args) {
      return runBrowserCheck(args, {
        mode: host.browserCheck.mode,
        cwd: host.browserCheck.cwd,
        executor: host.browserCheck.client
      })
    }
  }
}

// ── Shared body ──────────────────────────────────────────────────

interface BrowserCheckCtx {
  mode: AgentHost["browserCheck"]["mode"]
  cwd: string
  executor: BrowserCheckExecutor | null
}

async function runBrowserCheck(args: Record<string, unknown>, ctx: BrowserCheckCtx): Promise<string> {
  const relPath = String(args.path)
  const clicks = Array.isArray(args.click) ? args.click.map(String) : []
  const waitMs = Math.min(Number(args.wait ?? 1000), 10000)

  const fullPath = join(ctx.cwd, relPath)
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
  const fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1)

  try {
    await stat(fullPath)
  } catch {
    return `Error: File not found: ${relPath}`
  }

  if (ctx.mode === "disabled") {
    return "Error: browser_check is disabled in this deployment."
  }

  if (ctx.mode === "sandbox") {
    if (!ctx.executor) {
      return "Error: browser_check sandbox mode is enabled but no sandbox browser client is configured."
    }
    try {
      const result = await ctx.executor(relPath, clicks, waitMs, ctx.cwd)
      return result.report
    } catch (err) {
      return `Error running sandboxed browser check: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Host mode: run Playwright locally.
  let launchBrowser: (opts: Record<string, unknown>) => Promise<import("playwright").Browser>
  try {
    const pw = await import("playwright")
    launchBrowser = (opts) => pw.chromium.launch(opts as never)
  } catch {
    return "Error: Playwright is not installed. Run: npm install playwright && npx playwright install chromium"
  }

  const { server, url } = await startStaticServer(dir)
  const consoleErrors: string[] = []
  const consoleWarnings: string[] = []
  const networkErrors: string[] = []
  const uncaughtErrors: string[] = []

  let browser: import("playwright").Browser | undefined
  try {
    browser = await launchBrowser({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    })
    const page = await browser.newPage()

    page.on("console", (msg) => {
      const type = msg.type()
      const text = msg.text()
      if (type === "error") {
        const location = msg.location()
        const errUrl = location?.url ?? ""
        if (text.includes("Failed to load resource") && /favicon|apple-touch-icon/i.test(errUrl)) {
          return
        }
        if (text.includes("Failed to load resource") && errUrl) {
          consoleErrors.push(`${text} — URL: ${errUrl}`)
          return
        }
        consoleErrors.push(text)
      } else if (type === "warning") {
        consoleWarnings.push(text)
      }
    })

    page.on("pageerror", (err: unknown) => {
      uncaughtErrors.push(err instanceof Error ? err.message : String(err))
    })

    page.on("requestfailed", (req) => {
      const reqUrl = req.url()
      if (/favicon|apple-touch-icon/i.test(reqUrl)) return
      networkErrors.push(`${req.failure()?.errorText ?? "failed"}: ${reqUrl}`)
    })

    const pageUrl = `${url}/${fileName}`
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 })

    if (!response || !response.ok()) {
      const status = response?.status() ?? "unknown"
      return `Error: Page returned HTTP ${status} for ${pageUrl}`
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs))

    for (const selector of clicks) {
      try {
        await page.click(selector)
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (err) {
        consoleErrors.push(
          `Click failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const lines: string[] = []
    const totalErrors = consoleErrors.length + uncaughtErrors.length + networkErrors.length

    if (totalErrors === 0 && consoleWarnings.length === 0) {
      lines.push("✓ No errors or warnings detected.")
    } else {
      if (uncaughtErrors.length > 0) {
        lines.push(`## Uncaught Exceptions (${uncaughtErrors.length})`)
        for (const err of uncaughtErrors) lines.push(`  - ${err}`)
      }
      if (consoleErrors.length > 0) {
        lines.push(`## Console Errors (${consoleErrors.length})`)
        for (const err of consoleErrors) lines.push(`  - ${err}`)
      }
      if (networkErrors.length > 0) {
        lines.push(`## Network Failures (${networkErrors.length})`)
        for (const err of networkErrors) lines.push(`  - ${err}`)
      }
      if (consoleWarnings.length > 0) {
        lines.push(`## Warnings (${consoleWarnings.length})`)
        for (const warning of consoleWarnings) lines.push(`  - ${warning}`)
      }

      const has404 =
        consoleErrors.some((err) => err.includes("404")) ||
        networkErrors.some((err) => err.includes("ERR_ABORTED") || err.includes("404"))
      if (has404) {
        lines.push("")
        lines.push("## Path Resolution")
        lines.push(`  Static server root: ${dir}/`)
        lines.push(
          "  All <script src>, <link href>, and other references in the HTML are resolved relative to this directory."
        )
        lines.push(`  To fix 404s: ensure the referenced files exist under ${dir}/ with matching paths.`)
        lines.push(
          "  Use list_directory to verify the file structure, then either move the files or fix the HTML references."
        )
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
