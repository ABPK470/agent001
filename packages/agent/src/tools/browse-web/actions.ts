/**
 * Per-action handlers for browse_web. Each returns the next page-text
 * (with session header) or a user-readable error string.
 *
 * @module
 */

import { dismissCookieConsent, readPageText } from "./page-helpers.js"
import {
    type BrowserSession,
    deleteSession,
    getSession,
    launchSession,
    withKillGuard,
} from "./session.js"
import { validateUrl } from "./ssrf.js"

interface NavigateArgs {
  url: string
  visible: boolean
  sessionId: string | undefined
  maxLength: number
}

export async function handleNavigate(args: NavigateArgs): Promise<string> {
  const { url, visible, sessionId, maxLength } = args
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
    const result = await launchSession(visible)
    if (typeof result === "string") return result
    session = result.session; id = result.id
  }

  try {
    await withKillGuard(session.page, () =>
      session.page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }),
    )
    session.url = session.page.url()
    await dismissCookieConsent(session.page)
    const text = await readPageText(session.page, maxLength)
    return `[Session: ${id}] [URL: ${session.page.url()}]\n\n${text}`
  } catch (err) {
    return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function handleClick(
  session: BrowserSession,
  sessionId: string,
  selector: string,
  maxLength: number,
): Promise<string> {
  if (!selector) return "Error: 'selector' is required for click action"

  try {
    let clicked = false
    try {
      await withKillGuard(session.page, () =>
        session.page.waitForSelector(selector, { timeout: 3000 }),
      )
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

    await session.page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {})

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
): Promise<string> {
  if (!selector) return "Error: 'selector' is required for type action"
  if (!rawText) return "Error: 'text' is required for type action"

  try {
    await withKillGuard(session.page, () =>
      session.page.waitForSelector(selector, { timeout: 5000 }),
    )
    await session.page.click(selector, { clickCount: 3 }) // select existing content

    // Detect submit intent: literal newline or escaped \n at end
    let typeText = rawText
    let submit = false
    if (typeText.endsWith("\n")) { typeText = typeText.slice(0, -1); submit = true }
    else if (typeText.endsWith("\\n")) { typeText = typeText.slice(0, -2); submit = true }

    await withKillGuard(session.page, () =>
      session.page.type(selector, typeText, { delay: 30 }),
    )

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
  session: BrowserSession,
  sessionId: string,
): Promise<string> {
  try { await session.browser.close() } catch { /* ignore */ }
  deleteSession(sessionId)
  return `Session ${sessionId} closed.`
}
