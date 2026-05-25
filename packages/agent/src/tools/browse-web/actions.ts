/**
 * Per-action handlers for browse_web. Each returns the next page-text
 * (with session header) or a user-readable error string.
 *
 * @module
 */

import type { AgentHost } from "../../host/index.js"
import { dismissCookieConsent, readPageText } from "./page-helpers.js"
import { resolveLocator } from "./selectors.js"
import {
  type BrowserSession,
  deleteSession,
  getSession,
  launchSession,
  persistSessionState,
  withKillGuard,
} from "./session.js"
import { validateUrl } from "./ssrf.js"

/**
 * Resolve the active interaction surface for a session. Sessions track the
 * current page (`session.page`) and an optional active frame (`session.frame`)
 * so the agent can drive forms inside iframes without re-selecting every call.
 */
function activeTarget(session: BrowserSession): import("playwright").Page | import("playwright").Frame {
  return session.frame ?? session.page
}

interface NavigateArgs {
  host: AgentHost
  url: string
  visible: boolean
  sessionId: string | undefined
  maxLength: number
  signal?: AbortSignal | null
}

export async function handleNavigate(args: NavigateArgs): Promise<string> {
  const { host, url, visible, sessionId, maxLength } = args
  if (!url) return "Error: 'url' is required for navigate action"

  const urlErr = await validateUrl(url)
  if (urlErr) return urlErr

  let session: BrowserSession
  let id: string
  if (sessionId) {
    const s = getSession(host, sessionId)
    if (typeof s === "string") return s
    session = s; id = sessionId
  } else {
    const result = await launchSession(host, visible)
    if (typeof result === "string") return result
    session = result.session; id = result.id
  }

  try {
    // Compliance hook — host-installed guard may deny or rate-limit.
    const guard = session.contextHandle?.guard
    if (guard) {
      const decision = await guard.checkUrl(url)
      if (!decision.allow) {
        const retry = decision.retryAfterMs ? ` (retry after ~${Math.ceil(decision.retryAfterMs / 1000)}s)` : ""
        return `Navigation refused: ${decision.reason}${retry}`
      }
    }
    await withKillGuard(session.page, () =>
      // `domcontentloaded` (not `networkidle`) is the right wait condition for
      // commerce sites: alza.cz, amazon, etc. continually poll trackers and
      // ads, so the network is NEVER idle. We just need the HTML + scripts
      // parsed; subsequent reads happen against the live page anyway.
      session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }),
    , args.signal)
    session.url = session.page.url()
    await dismissCookieConsent(session.page)
    const interstitial = await detectInterstitial(session.page)
    const text = await readPageText(session.page, maxLength)
    if (guard) {
      // Best-effort audit of the navigation.
      void guard.recordAction({ action: "browse_web.navigate", url: session.page.url() })
    }
    if (interstitial) {
      return `[Session: ${id}] [URL: ${session.page.url()}]\n\n` +
        `⚠️  ${interstitial} interstitial detected. The page below is the challenge wall, NOT the requested content. ` +
        `If \`visible: true\`, ask the user to solve the challenge in the open browser window, then call \`browse_web action=read sessionId=${id}\` to re-read the page once they're through. ` +
        `If headless, call \`browser_human_handoff\` to hand control over.\n\n${text}`
    }
    return `[Session: ${id}] [URL: ${session.page.url()}]\n\n${text}`
  } catch (err) {
    // On timeout we may STILL have a usable page (commerce sites, Cloudflare
    // interstitials, etc. fire DOMContentLoaded fine but never reach idle).
    // Try to extract whatever's there before giving up.
    if (err instanceof Error && /Timeout|timeout/.test(err.message)) {
      try {
        const currentUrl   = session.page.url()
        const interstitial = await detectInterstitial(session.page)
        const text         = await readPageText(session.page, maxLength)
        if (text.trim().length > 0) {
          session.url = currentUrl
          const banner = interstitial
            ? `⚠️  Navigation timed out AND a ${interstitial} challenge is on screen. If \`visible: true\`, ask the user to solve it in the browser window, then call \`browse_web action=read sessionId=${id}\`. Otherwise call \`browser_human_handoff\`.`
            : `⚠️  Navigation didn't finish loading within 60s but the page has content (likely heavy trackers prevent network-idle). Continuing with what loaded.`
          return `[Session: ${id}] [URL: ${currentUrl}]\n\n${banner}\n\n${text}`
        }
      } catch { /* fall through to generic error */ }
    }
    return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Detect common bot-protection interstitials so the agent stops trying to
 * scrape and either asks the user to solve the challenge (visible mode) or
 * calls `browser_human_handoff` (headless). Returns the provider name or null.
 */
async function detectInterstitial(page: import("playwright").Page): Promise<string | null> {
  try {
    const sample = (await page.title().catch(() => "")).toLowerCase()
      + " "
      + ((await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")) ?? "").slice(0, 4000).toLowerCase()
    if (/just a moment|checking your browser|cloudflare/.test(sample))         return "Cloudflare"
    if (/cf-turnstile|turnstile/.test(sample))                                  return "Cloudflare Turnstile"
    if (/are you a robot|please verify you are human|hcaptcha/.test(sample))    return "hCaptcha"
    if (/recaptcha|i'?m not a robot/.test(sample))                              return "reCAPTCHA"
    if (/access denied|unusual traffic|automated requests/.test(sample))        return "Anti-bot"
    // DOM-level check for Turnstile widget which renders even without text.
    const hasTurnstile = await page.locator(".cf-turnstile, iframe[src*='challenges.cloudflare.com']").count().catch(() => 0)
    if (hasTurnstile > 0) return "Cloudflare Turnstile"
    return null
  } catch {
    return null
  }
}

export async function handleClick(
  session: BrowserSession,
  sessionId: string,
  selector: string,
  maxLength: number,
  signal?: AbortSignal | null,
): Promise<string> {
  if (!selector) return "Error: 'selector' is required for click action"

  try {
    const target = activeTarget(session)
    let clicked = false
    try {
      const loc = resolveLocator(target, selector)
      await withKillGuard(session.page, () => loc.first().waitFor({ timeout: 3000 }), signal)
      await loc.first().click()
      clicked = true
    } catch { /* primary selector failed, try text-content fallback below */ }

    if (!clicked) {
      // Fallback: click by text content on the active page (string eval for DOM type compat).
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

    await session.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {})

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

export async function handleType(
  session: BrowserSession,
  sessionId: string,
  selector: string,
  rawText: string,
  maxLength: number,
  signal?: AbortSignal | null,
): Promise<string> {
  if (!selector) return "Error: 'selector' is required for type action"
  if (!rawText) return "Error: 'text' is required for type action"

  try {
    const target = activeTarget(session)
    const loc = resolveLocator(target, selector)
    await withKillGuard(session.page, () => loc.first().waitFor({ timeout: 5000 }), signal)
    await loc.first().click({ clickCount: 3 }) // select existing content

    // Detect submit intent: literal newline or escaped \n at end
    let typeText = rawText
    let submit = false
    if (typeText.endsWith("\n")) { typeText = typeText.slice(0, -1); submit = true }
    else if (typeText.endsWith("\\n")) { typeText = typeText.slice(0, -2); submit = true }

    await withKillGuard(session.page, () => loc.first().pressSequentially(typeText, { delay: 30 }), signal)

    if (submit) {
      await session.page.keyboard.press("Enter")
      await session.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
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

export async function handleScroll(
  session: BrowserSession,
  sessionId: string,
  direction: string,
  maxLength: number,
): Promise<string> {
  try {
    await session.page.evaluate(`window.scrollBy(0, ${direction === "up" ? -800 : 800})`)
    await new Promise(r => setTimeout(r, 500))
    const text = await readPageText(session.page, maxLength)
    return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
  } catch (err) {
    return `Error scrolling: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function handleRead(
  session: BrowserSession,
  sessionId: string,
  maxLength: number,
): Promise<string> {
  try {
    const text = await readPageText(session.page, maxLength)
    return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
  } catch (err) {
    return `Error reading page: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function handleClose(
  host: AgentHost,
  session: BrowserSession,
  sessionId: string,
): Promise<string> {
  await persistSessionState(session)
  try { await session.browser.close() } catch { /* ignore */ }
  deleteSession(host, sessionId)
  return `Session ${sessionId} closed.`
}

// ── Phase 4 capabilities ─────────────────────────────────────────

/**
 * Upload one or more files into a `<input type=file>` element. The agent
 * must pass a path that resolves *inside* the runtime workspace root —
 * arbitrary filesystem reads are refused. Use the `import_attachment` tool
 * first to bring user uploads into the sandbox.
 */
export async function handleUpload(
  session: BrowserSession,
  sessionId: string,
  selector: string,
  filePath: string,
  workspaceRoot: string,
  maxLength: number,
): Promise<string> {
  if (!selector) return "Error: 'selector' is required for upload action"
  if (!filePath) return "Error: 'file_path' is required for upload action"

  const { resolve, isAbsolute, relative } = await import("node:path")
  const abs = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
  const rel = relative(workspaceRoot, abs)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return `Error: file_path "${filePath}" escapes workspace root`
  }
  const { existsSync } = await import("node:fs")
  if (!existsSync(abs)) return `Error: file not found: ${filePath}`

  try {
    const target = activeTarget(session)
    const loc = resolveLocator(target, selector)
    await loc.first().setInputFiles(abs)
    await new Promise(r => setTimeout(r, 250))
    const text = await readPageText(session.page, maxLength)
    return `[Session: ${sessionId}] [URL: ${session.page.url()}]\nUploaded "${rel}".\n\n${text}`
  } catch (err) {
    return `Error uploading to "${selector}": ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Tab management. Sub-actions: list | switch | new | close.
 *   - list:   returns "[index] [active?] url"
 *   - switch: makes pages[index] the active page
 *   - new:    opens a blank tab and switches to it
 *   - close:  closes pages[index] (cannot close the last remaining tab)
 */
export async function handleTabs(
  session: BrowserSession,
  sessionId: string,
  sub: string,
  index: number | undefined,
  url: string | undefined,
  maxLength: number,
): Promise<string> {
  const pages = session.context.pages()
  if (sub === "list") {
    const lines = pages.map((p, i) =>
      `[${i}]${p === session.page ? "*" : " "} ${p.url() || "about:blank"}`,
    )
    return `[Session: ${sessionId}] tabs:\n${lines.join("\n")}`
  }
  if (sub === "switch") {
    if (index === undefined || index < 0 || index >= pages.length) {
      return `Error: invalid tab index ${index}`
    }
    session.page = pages[index]!
    session.frame = null
    session.url = session.page.url()
    const text = await readPageText(session.page, maxLength)
    return `[Session: ${sessionId}] [URL: ${session.page.url()}]\n\n${text}`
  }
  if (sub === "new") {
    const target = url ?? "about:blank"
    if (target !== "about:blank") {
      const urlErr = await validateUrl(target)
      if (urlErr) return urlErr
    }
    const newPage = await session.context.newPage()
    if (target !== "about:blank") {
      await newPage.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
    }
    session.page = newPage
    session.frame = null
    session.url = newPage.url()
    const text = await readPageText(newPage, maxLength)
    return `[Session: ${sessionId}] [URL: ${newPage.url()}]\n\n${text}`
  }
  if (sub === "close") {
    if (pages.length <= 1) return "Error: cannot close the last tab — use action=close instead"
    if (index === undefined || index < 0 || index >= pages.length) {
      return `Error: invalid tab index ${index}`
    }
    const closing = pages[index]!
    const wasActive = closing === session.page
    await closing.close().catch(() => {})
    if (wasActive) {
      const remaining = session.context.pages()
      session.page = remaining[remaining.length - 1]!
      session.frame = null
      session.url = session.page.url()
    }
    return `[Session: ${sessionId}] closed tab ${index}`
  }
  return `Error: unknown tabs sub-action "${sub}". Use list|switch|new|close.`
}

/**
 * Frame management. Sub-actions:
 *   - list:    enumerates all frames on the active page (index, name, url)
 *   - switch:  binds session.frame to frames[index] (use 0 to detach)
 *   - top:     resets session.frame to null (drives the top page again)
 */
export async function handleFrame(
  session: BrowserSession,
  sessionId: string,
  sub: string,
  index: number | undefined,
): Promise<string> {
  if (sub === "top") {
    session.frame = null
    return `[Session: ${sessionId}] frame: top page`
  }
  const frames = session.page.frames()
  if (sub === "list") {
    const lines = frames.map((f, i) => `[${i}] name="${f.name()}" url=${f.url() || "(blank)"}`)
    return `[Session: ${sessionId}] frames:\n${lines.join("\n")}`
  }
  if (sub === "switch") {
    if (index === undefined || index < 0 || index >= frames.length) {
      return `Error: invalid frame index ${index}`
    }
    session.frame = frames[index]!
    return `[Session: ${sessionId}] frame: [${index}] ${session.frame.url()}`
  }
  return `Error: unknown frame sub-action "${sub}". Use list|switch|top.`
}

/**
 * Request interception. Mode set | clear:
 *   - set:   patterns is an array of URL substrings to BLOCK. Replaces
 *            any prior list. Useful for stripping ads / trackers / heavy
 *            assets without paid services.
 *   - clear: removes all blocks.
 *
 * Implementation detail: a single page.route() handler is registered the
 * first time a non-empty list is set; subsequent updates only mutate the
 * patterns list to avoid Playwright's "duplicate route" complexity.
 */
export async function handleIntercept(
  session: BrowserSession,
  sessionId: string,
  mode: string,
  patterns: string[],
): Promise<string> {
  if (mode === "clear") {
    session.blockedPatterns = []
    await session.page.unroute("**/*").catch(() => {})
    return `[Session: ${sessionId}] interception cleared`
  }
  if (mode === "set") {
    const wasEmpty = session.blockedPatterns.length === 0
    session.blockedPatterns = patterns.filter(p => p && p.length > 0)
    if (wasEmpty && session.blockedPatterns.length > 0) {
      await session.page.route("**/*", (route) => {
        const url = route.request().url()
        for (const p of session.blockedPatterns) {
          if (url.includes(p)) { route.abort().catch(() => {}); return }
        }
        route.continue().catch(() => {})
      })
    }
    return `[Session: ${sessionId}] blocking ${session.blockedPatterns.length} pattern(s): ${session.blockedPatterns.join(", ") || "(none)"}`
  }
  return `Error: unknown intercept mode "${mode}". Use set|clear.`
}
