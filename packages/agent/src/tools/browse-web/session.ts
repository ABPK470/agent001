/**
 * Browser session lifecycle: launch, lookup, kill-signal handling,
 * idle eviction. Sessions persist across multiple browse_web calls
 * to enable multi-step flows.
 *
 * Uses Playwright (chromium). Per-session state is a Browser + a single
 * BrowserContext + Page; keeping the context isolated paves the way for
 * per-user persistent storage state in a later phase.
 *
 * @module
 */

import type { AgentHost, BrowserContextHandle } from "../../host/index.js"
import { pickFingerprint, type Fingerprint } from "./fingerprint.js"

export interface BrowserSession {
  browser: import("playwright").Browser
  context: import("playwright").BrowserContext
  page: import("playwright").Page
  /** Active iframe — when set, click/type/upload target this frame instead of the top page. */
  frame: import("playwright").Frame | null
  /** URL substrings the session should block via page.route(). Empty = no interception. */
  blockedPatterns: string[]
  lastUsed: number
  url: string
  visible: boolean
  fingerprint: Fingerprint
  /** Persistent-context handle — null for ephemeral (anonymous / no provider). */
  contextHandle: BrowserContextHandle | null
}

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes. Owned by AgentHost (`host.browser.*`).

// Browser sessions live on the active AgentHost (`host.browser.sessions`).
const SESSION_TIMEOUT = 5 * 60 * 1000

export function getKillSignal(signal?: AbortSignal | null): AbortSignal | null {
  return signal ?? null
}

/**
 * Start the periodic cleanup of idle browser sessions on this host.
 * Idempotent — calling twice does nothing. Call once at startup (or
 * lazily on first session launch); pair with `stopBrowseSessionCleanup()`
 * on shutdown so the timer doesn't keep the process alive.
 */
export function startBrowseSessionCleanup(host: AgentHost): void {
  const browser = host.browser
  if (browser.cleanupTimer.value) return
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of browser.sessions) {
      if (now - session.lastUsed > SESSION_TIMEOUT) {
        // Best-effort persistence before close.
        persistSessionState(session)
          .finally(() => session.browser.close().catch(() => {}))
        browser.sessions.delete(id)
      }
    }
  }, 60_000)
  timer.unref()
  browser.cleanupTimer.value = timer
}

/** Stop the periodic cleanup timer. Safe to call when not started. */
export function stopBrowseSessionCleanup(host: AgentHost): void {
  const browser = host.browser
  if (browser.cleanupTimer.value) {
    clearInterval(browser.cleanupTimer.value)
    browser.cleanupTimer.value = null
  }
}

/**
 * Wrap a Playwright operation to abort early when the kill signal fires.
 * Closing the page causes any pending Playwright promise to reject, unblocking
 * the awaiting code so the agent can move on.
 */
export function withKillGuard<T>(
  page: import("playwright").Page,
  fn: () => Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  const sig = getKillSignal(signal)
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

/**
 * Lazily resolve a chromium launcher with stealth applied. Falls back to
 * vanilla playwright if `playwright-extra` / the stealth plugin are missing
 * (e.g. in stripped-down CI). Stealth patches navigator.webdriver, plugin
 * arrays, WebGL vendor strings and a dozen other tells anti-bot fingerprinters
 * key off of.
 */
async function resolveStealthChromium(): Promise<typeof import("playwright").chromium | null> {
  try {
    const extra = (await import("playwright-extra")) as unknown as {
      chromium: typeof import("playwright").chromium & {
        use: (plugin: unknown) => void
      }
    }
    try {
      const stealthMod = (await import("puppeteer-extra-plugin-stealth")) as unknown as {
        default: () => unknown
      }
      extra.chromium.use(stealthMod.default())
    } catch {
      // Stealth plugin missing — proceed without it.
    }
    return extra.chromium
  } catch {
    return null
  }
}

export async function launchSession(
  host: AgentHost,
  visible = false,
  options: { tenantSeed?: string } = {},
): Promise<{ session: BrowserSession; id: string } | string> {
  // Lazily start the per-host idle-session cleanup timer.
  startBrowseSessionCleanup(host)

  let chromium: typeof import("playwright").chromium
  const stealth = await resolveStealthChromium()
  if (stealth) {
    chromium = stealth
  } else {
    try {
      const playwright = await import("playwright")
      chromium = playwright.chromium
    } catch {
      return "Error: Playwright is not installed"
    }
  }

  // Acquire persistent context handle (null for anon / no provider).
  const provider = host.browser.contextReader
  let handle: BrowserContextHandle | null = null
  if (provider) {
    try { handle = await provider.acquire() } catch { handle = null }
  }

  // Fingerprint seed precedence: explicit tenantSeed > handle seed > undefined.
  const seed = options.tenantSeed ?? handle?.fingerprintSeed
  const fingerprint = pickFingerprint(seed)

  const launchOpts: import("playwright").LaunchOptions = {
    headless: !visible,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  }
  if (handle?.proxy?.server) {
    // BYO upstream proxy for this tenant. Playwright accepts http(s) and
    // socks5 URLs in the `server` field. Null/empty = direct.
    launchOpts.proxy = {
      server: handle.proxy.server,
      ...(handle.proxy.bypass ? { bypass: handle.proxy.bypass } : {}),
      ...(handle.proxy.username ? { username: handle.proxy.username } : {}),
      ...(handle.proxy.password ? { password: handle.proxy.password } : {}),
    }
  }
  const browser = await chromium.launch(launchOpts)
  const contextOpts: import("playwright").BrowserContextOptions = {
    userAgent: fingerprint.userAgent,
    viewport: fingerprint.viewport,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezoneId,
  }
  if (handle?.storageState) {
    contextOpts.storageState = handle.storageState as import("playwright").BrowserContextOptions["storageState"]
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()

  const id = `s${++host.browser.idCounter.value}`
  const session: BrowserSession = {
    browser,
    context,
    page,
    frame: null,
    blockedPatterns: [],
    lastUsed: Date.now(),
    url: "",
    visible,
    fingerprint,
    contextHandle: handle,
  }
  host.browser.sessions.set(id, session)
  return { session, id }
}

/**
 * Snapshot the session's storage state and persist it through the
 * context provider. No-op for ephemeral sessions. Errors are swallowed
 * because losing a snapshot must never crash the agent.
 */
export async function persistSessionState(session: BrowserSession): Promise<void> {
  if (!session.contextHandle) return
  try {
    const state = await session.context.storageState()
    await session.contextHandle.save(state)
  } catch {
    // best-effort
  }
}

export function getSession(host: AgentHost, sessionId: string): BrowserSession | string {
  const session = host.browser.sessions.get(sessionId)
  if (!session) return `Error: Session "${sessionId}" not found or expired`
  session.lastUsed = Date.now()
  return session
}

export function deleteSession(host: AgentHost, sessionId: string): void {
  host.browser.sessions.delete(sessionId)
}

/** Force-close all open browser sessions on this host (for cleanup on server shutdown). */
export function closeAllBrowserSessions(host: AgentHost): void {
  for (const [id, session] of host.browser.sessions) {
    persistSessionState(session)
      .finally(() => session.browser.close().catch(() => {}))
    host.browser.sessions.delete(id)
  }
}
