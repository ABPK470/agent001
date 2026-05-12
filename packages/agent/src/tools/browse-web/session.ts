/**
 * Browser session lifecycle: launch, lookup, kill-signal handling,
 * idle eviction. Sessions persist across multiple browse_web calls
 * to enable multi-step flows.
 *
 * @module
 */

import { currentRuntime } from "../../agent-runtime.js"

export interface BrowserSession {
  browser: import("puppeteer").Browser
  page: import("puppeteer").Page
  lastUsed: number
  url: string
  visible: boolean
}

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes. Owned by AgentRuntime in future.

// Browser sessions live on the active AgentRuntime
// (`currentRuntime().browseWeb.sessions`).
const SESSION_TIMEOUT = 5 * 60 * 1000

/** Set by the orchestrator when a per-tool kill is registered/cleared. */
export function setBrowseKillSignal(signal: AbortSignal | null): void {
  currentRuntime().browseWeb.killSignal = signal
}

export function getKillSignal(): AbortSignal | null {
  return currentRuntime().browseWeb.killSignal
}

/**
 * Start the periodic cleanup of idle browser currentRuntime().browseWeb.sessions. Idempotent — calling
 * twice does nothing. Call once at startup; pair with `stopBrowseSessionCleanup()`
 * on shutdown so the timer doesn't keep the process alive.
 */
export function startBrowseSessionCleanup(): void {
  const browseWeb = currentRuntime().browseWeb
  if (browseWeb.cleanupTimer) return
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of browseWeb.sessions) {
      if (now - session.lastUsed > SESSION_TIMEOUT) {
        session.browser.close().catch(() => {})
        browseWeb.sessions.delete(id)
      }
    }
  }, 60_000)
  timer.unref()
  browseWeb.cleanupTimer = timer
}

/** Stop the periodic cleanup timer. Safe to call when not started. */
export function stopBrowseSessionCleanup(): void {
  const browseWeb = currentRuntime().browseWeb
  if (browseWeb.cleanupTimer) {
    clearInterval(browseWeb.cleanupTimer)
    browseWeb.cleanupTimer = null
  }
}

// Auto-start preserves prior behaviour for existing call sites.
startBrowseSessionCleanup()

/**
 * Wrap a Puppeteer operation to abort early when the kill signal fires.
 * Closing the page causes any pending Puppeteer promise to reject, unblocking
 * the awaiting code so the agent can move on.
 */
export function withKillGuard<T>(page: import("puppeteer").Page, fn: () => Promise<T>): Promise<T> {
  const sig = currentRuntime().browseWeb.killSignal
  if (!sig) return fn()
  if (sig.aborted) return Promise.reject(new Error("Tool execution cancelled"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      page.close().catch(() => {})
      reject(new Error("Tool execution cancelled"))
    }
    sig.addEventListener("abort", onAbort, { once: true })
    fn().then(
      (v) => { sig.removeEventListener("abort", onAbort); resolve(v) },
      (e) => { sig.removeEventListener("abort", onAbort); reject(e) },
    )
  })
}

export async function launchSession(visible = false): Promise<{ session: BrowserSession; id: string } | string> {
  let puppeteer: typeof import("puppeteer")
  try {
    const mod = await import("puppeteer")
    puppeteer = mod.default ?? mod
  } catch {
    return "Error: Puppeteer is not installed"
  }

  const browser = await (puppeteer as any).launch({
    headless: !visible,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  )
  await page.setViewport({ width: 1280, height: 800 })

  const id = `s${++currentRuntime().browseWeb.counter}`
  const session: BrowserSession = { browser, page, lastUsed: Date.now(), url: "", visible }
  currentRuntime().browseWeb.sessions.set(id, session)
  return { session, id }
}

export function getSession(sessionId: string): BrowserSession | string {
  const session = currentRuntime().browseWeb.sessions.get(sessionId)
  if (!session) return `Error: Session "${sessionId}" not found or expired`
  session.lastUsed = Date.now()
  return session
}

export function deleteSession(sessionId: string): void {
  currentRuntime().browseWeb.sessions.delete(sessionId)
}

/** Force-close all open browser currentRuntime().browseWeb.sessions (for cleanup on server shutdown). */
export function closeAllBrowserSessions(): void {
  for (const [id, session] of currentRuntime().browseWeb.sessions) {
    session.browser.close().catch(() => {})
    currentRuntime().browseWeb.sessions.delete(id)
  }
}
