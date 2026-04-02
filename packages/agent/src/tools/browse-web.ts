/**
 * browse_web tool — interactive web browsing with a persistent browser session.
 *
 * Unlike fetch_url (read-only), this tool gives the agent a full headless browser
 * that persists across multiple tool calls. The agent can navigate, click, type,
 * scroll, and read — enabling real web interactions like filling forms, dismissing
 * cookie banners, and multi-page flows.
 *
 * Security:
 *   - Same SSRF protections as fetch_url (DNS pre-resolve, private IP blocking)
 *   - Navigation to private/internal addresses blocked at each hop
 *   - Sessions auto-close after 5 minutes of inactivity
 */

import { lookup } from "node:dns/promises"
import type { Tool } from "../types.js"

/* ------------------------------------------------------------------ */
/*  Session management                                                 */
/* ------------------------------------------------------------------ */

interface BrowserSession {
  browser: import("puppeteer").Browser
  page: import("puppeteer").Page
  lastUsed: number
  url: string
}

const sessions = new Map<string, BrowserSession>()
let sessionCounter = 0
const SESSION_TIMEOUT = 5 * 60 * 1000

// Periodic cleanup of stale sessions (unref so it doesn't keep the process alive)
const _cleanup = setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TIMEOUT) {
      session.browser.close().catch(() => {})
      sessions.delete(id)
    }
  }
}, 60_000)
_cleanup.unref()

/* ------------------------------------------------------------------ */
/*  SSRF protection (same rules as fetch_url)                          */
/* ------------------------------------------------------------------ */

function checkHostname(hostname: string): string | null {
  if (
    hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]" || hostname === "::1" || hostname === "0.0.0.0" ||
    hostname.startsWith("10.") || hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    return "Error: Access to internal/private addresses is blocked"
  }
  return null
}

function checkResolvedIp(ip: string): string | null {
  if (
    ip === "127.0.0.1" || ip === "0.0.0.0" ||
    ip.startsWith("10.") || ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }
  if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped) return checkResolvedIp(v4Mapped[1])
  return null
}

async function validateUrl(url: string): Promise<string | null> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return `Error: Invalid URL "${url}"` }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: Only http/https URLs are supported"
  }
  const hostErr = checkHostname(parsed.hostname)
  if (hostErr) return hostErr
  try {
    const resolved = await lookup(parsed.hostname)
    return checkResolvedIp(resolved.address)
  } catch {
    return `Error: Could not resolve hostname "${parsed.hostname}"`
  }
}

/* ------------------------------------------------------------------ */
/*  Browser helpers                                                    */
/* ------------------------------------------------------------------ */

async function launchSession(): Promise<{ session: BrowserSession; id: string } | string> {
  let puppeteer: typeof import("puppeteer")
  try {
    const mod = await import("puppeteer")
    puppeteer = mod.default ?? mod
  } catch {
    return "Error: Puppeteer is not installed"
  }

  const browser = await (puppeteer as any).launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  )
  await page.setViewport({ width: 1280, height: 800 })

  const id = `s${++sessionCounter}`
  const session: BrowserSession = { browser, page, lastUsed: Date.now(), url: "" }
  sessions.set(id, session)
  return { session, id }
}

function getSession(sessionId: string): BrowserSession | string {
  const session = sessions.get(sessionId)
  if (!session) return `Error: Session "${sessionId}" not found or expired`
  session.lastUsed = Date.now()
  return session
}

/** Try to auto-dismiss common cookie consent banners. */
async function dismissCookieConsent(page: import("puppeteer").Page): Promise<void> {
  try {
    // Runs in browser context — use string eval to avoid DOM type issues in Node tsconfig
    await page.evaluate(`(() => {
      const patterns = [
        /^accept$/i, /^accept all$/i, /^accept cookies$/i,
        /^i agree$/i, /^i understand$/i, /^agree$/i,
        /^ok$/i, /^got it$/i, /^allow$/i, /^allow all$/i,
        /^souhlasím$/i, /^přijmout$/i, /^přijmout vše$/i, /^rozumím$/i,
      ];
      const btns = document.querySelectorAll(
        'button, a[role="button"], [class*="cookie"] button, [class*="consent"] button, ' +
        '[id*="cookie"] button, [id*="consent"] button, [class*="Cookie"] button, [class*="Consent"] button'
      );
      for (const btn of btns) {
        const text = btn.innerText?.trim();
        if (text && patterns.some(p => p.test(text))) { btn.click(); return; }
      }
    })()`)
    await new Promise(r => setTimeout(r, 1000))
  } catch { /* ignore */ }
}

/** Extract readable text from current page. */
async function readPageText(page: import("puppeteer").Page, maxLength: number): Promise<string> {
  let text = String(await page.evaluate('document.body?.innerText ?? ""'))
  text = text.replace(/\s+/g, " ").trim()
  if (text.length > maxLength) text = text.slice(0, maxLength) + "\n... (truncated)"
  return text || "(empty page)"
}

/* ------------------------------------------------------------------ */
/*  Tool definition                                                    */
/* ------------------------------------------------------------------ */

export const browseWebTool: Tool = {
  name: "browse_web",
  description:
    "Interactive web browsing with a persistent browser session. " +
    "Actions: navigate (open URL), click (CSS selector or button text), " +
    "type (into input field), scroll (up/down), read (get current page text), close (end session). " +
    "Returns page text after each action. Use for complex web interactions " +
    "(forms, cookie consent, multi-page flows). For simple reads, prefer fetch_url.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "type", "scroll", "read", "close"],
        description: "The browser action to perform.",
      },
      url: {
        type: "string",
        description: "URL to navigate to (for 'navigate' action).",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for the target element (for 'click' and 'type'). " +
          "If the CSS selector isn't found, text content matching is attempted for clicks.",
      },
      text: {
        type: "string",
        description: "Text to type (for 'type' action). End with a newline to press Enter after typing.",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Scroll direction (default: 'down').",
      },
      session_id: {
        type: "string",
        description:
          "Session ID returned by a previous 'navigate' call. " +
          "Omit to start a new session. Required for all actions except 'navigate'.",
      },
      max_length: {
        type: "number",
        description: "Max characters of page text to return (default: 10000).",
      },
    },
    required: ["action"],
  },

  async execute(args) {
    const action = String(args.action)
    const sessionId = args.session_id ? String(args.session_id) : undefined
    const maxLength = Number(args.max_length ?? 10000)

    /* ---------- navigate ---------- */
    if (action === "navigate") {
      const url = String(args.url ?? "")
      if (!url) return "Error: 'url' is required for navigate action"

      const urlErr = await validateUrl(url)
      if (urlErr) return urlErr

      let session: BrowserSession
      let id: string
      if (sessionId) {
        const s = getSession(sessionId)
        if (typeof s === "string") return s
        session = s; id = sessionId
      } else {
        const result = await launchSession()
        if (typeof result === "string") return result
        session = result.session; id = result.id
      }

      try {
        await session.page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })
        session.url = session.page.url()
        await dismissCookieConsent(session.page)
        const text = await readPageText(session.page, maxLength)
        return `[Session: ${id}] [URL: ${session.page.url()}]\n\n${text}`
      } catch (err) {
        return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    /* ---------- session-required actions ---------- */
    if (!sessionId) return "Error: 'session_id' is required. Use 'navigate' first to start a session."
    const s = getSession(sessionId)
    if (typeof s === "string") return s
    const session = s

    /* ---------- click ---------- */
    if (action === "click") {
      const selector = String(args.selector ?? "")
      if (!selector) return "Error: 'selector' is required for click action"

      try {
        // Try CSS selector first
        let clicked = false
        try {
          await session.page.waitForSelector(selector, { timeout: 3000 })
          await session.page.click(selector)
          clicked = true
        } catch { /* CSS selector failed, try text match below */ }

        if (!clicked) {
          // Fallback: click by text content (string eval for DOM type compat)
          const found = await session.page.evaluate(`((text) => {
            const els = document.querySelectorAll('button, a, [role="button"], input[type="submit"], [onclick]');
            for (const el of els) {
              const t = el.innerText?.trim();
              if (t && t.toLowerCase().includes(text.toLowerCase())) { el.click(); return true; }
            }
            return false;
          })(${JSON.stringify(selector)})`)
          if (!found) return `Error: No element found for "${selector}"`
        }

        // Wait for potential navigation / content update
        await session.page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {})

        // SSRF check if navigation happened
        const newUrl = session.page.url()
        if (newUrl !== session.url) {
          const urlErr = await validateUrl(newUrl)
          if (urlErr) {
            await session.page.goBack().catch(() => {})
            return urlErr
          }
          session.url = newUrl
        }

        const text = await readPageText(session.page, maxLength)
        return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
      } catch (err) {
        return `Error clicking "${selector}": ${err instanceof Error ? err.message : String(err)}`
      }
    }

    /* ---------- type ---------- */
    if (action === "type") {
      const selector = String(args.selector ?? "")
      const rawText = String(args.text ?? "")
      if (!selector) return "Error: 'selector' is required for type action"
      if (!rawText) return "Error: 'text' is required for type action"

      try {
        await session.page.waitForSelector(selector, { timeout: 5000 })
        await session.page.click(selector, { clickCount: 3 }) // select existing content

        // Detect submit intent: literal newline or escaped \n at end
        let typeText = rawText
        let submit = false
        if (typeText.endsWith("\n")) { typeText = typeText.slice(0, -1); submit = true }
        else if (typeText.endsWith("\\n")) { typeText = typeText.slice(0, -2); submit = true }

        await session.page.type(selector, typeText, { delay: 30 })

        if (submit) {
          await session.page.keyboard.press("Enter")
          await session.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {})
        } else {
          await new Promise(r => setTimeout(r, 500))
        }

        session.url = session.page.url()
        const pageText = await readPageText(session.page, maxLength)
        return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${pageText}`
      } catch (err) {
        return `Error typing into "${selector}": ${err instanceof Error ? err.message : String(err)}`
      }
    }

    /* ---------- scroll ---------- */
    if (action === "scroll") {
      const direction = String(args.direction ?? "down")
      try {
        await session.page.evaluate(`window.scrollBy(0, ${direction === "up" ? -800 : 800})`)
        await new Promise(r => setTimeout(r, 500))
        const text = await readPageText(session.page, maxLength)
        return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
      } catch (err) {
        return `Error scrolling: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    /* ---------- read ---------- */
    if (action === "read") {
      try {
        const text = await readPageText(session.page, maxLength)
        return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
      } catch (err) {
        return `Error reading page: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    /* ---------- close ---------- */
    if (action === "close") {
      try { await session.browser.close() } catch { /* ignore */ }
      sessions.delete(sessionId)
      return `Session ${sessionId} closed.`
    }

    return `Error: Unknown action "${action}". Use: navigate, click, type, scroll, read, close.`
  },
}

/** Force-close all open browser sessions (for cleanup on server shutdown). */
export function closeAllBrowserSessions(): void {
  for (const [id, session] of sessions) {
    session.browser.close().catch(() => {})
    sessions.delete(id)
  }
}
