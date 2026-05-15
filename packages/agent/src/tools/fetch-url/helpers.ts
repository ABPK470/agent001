/**
 * Helpers for fetch-url: SSRF guards + Playwright fallback. Extracted from fetch-url.ts.
 *
 * @module
 */

/** Check hostname against known-bad patterns (before DNS resolution). */
export function checkHostname(hostname: string): string | null {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    return `Error: Access to internal/private addresses is blocked`
  }
  return null
}

/** Check a resolved IP address against private/internal ranges. */
export function checkResolvedIp(ip: string): string | null {
  // IPv4 private ranges
  if (
    ip === "127.0.0.1" ||
    ip === "0.0.0.0" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }

  // IPv6 private/loopback
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fc") || // unique local
    ip.startsWith("fd") || // unique local
    ip.startsWith("fe80") // link-local
  ) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1, ::ffff:10.0.0.1)
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped) {
    return checkResolvedIp(v4Mapped[1])
  }

  return null
}

/**
 * Fallback: use headless Chromium via Playwright to fetch a page that blocks plain HTTP.
 * Lazy-imports playwright so it's only loaded when actually needed.
 */
export async function fetchWithBrowser(url: string, maxLength: number): Promise<string | null> {
  let chromium: typeof import("playwright").chromium
  try {
    const mod = await import("playwright")
    chromium = mod.chromium
  } catch {
    return null // playwright not available
  }

  let browser: import("playwright").Browser | null = null
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    })

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    })
    const page = await context.newPage()

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })

    // Wait a short time for JS-rendered content
    await new Promise((r) => setTimeout(r, 2000))

    let text = String(await page.evaluate('document.body?.innerText ?? ""'))
    text = text.replace(/\s+/g, " ").trim()

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + "\n... (truncated)"
    }

    return text || null
  } catch {
    return null
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
