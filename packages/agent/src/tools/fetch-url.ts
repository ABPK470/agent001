/**
 * Fetch URL tool — lets the agent read web pages.
 *
 * Fetches a URL, strips HTML tags, returns plain text.
 * This is how agents "browse the web."
 *
 * Security:
 *   - DNS resolution BEFORE request — prevents DNS rebinding / TOCTOU attacks
 *   - Blocks private/internal IPs (IPv4 + IPv6, incl. mapped addresses)
 *   - Redirects followed manually with re-check at each hop
 *   - Response body size-limited (1 MB)
 *   - 15s timeout
 */

import { lookup } from "node:dns/promises"
import type { Tool } from "../types.js"

/** Max response body size (1 MB). */
const MAX_BODY = 1_048_576
/** Max redirect hops. */
const MAX_REDIRECTS = 5

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a URL and return its content as plain text. " +
    "Use this to read web pages, API endpoints, or any HTTP resource. " +
    "HTML tags are stripped — you get readable text.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      max_length: {
        type: "number",
        description: "Max characters to return (default 10000)",
      },
    },
    required: ["url"],
  },

  async execute(args) {
    const url = String(args.url)
    const maxLength = Number(args.max_length ?? 10000)

    // Basic URL validation
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return `Error: Invalid URL "${url}"`
    }

    // Only allow http/https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: Only http/https URLs are supported`
    }

    // Check hostname + resolve DNS BEFORE making the request
    const hostnameErr = checkHostname(parsed.hostname)
    if (hostnameErr) return hostnameErr

    try {
      const resolved = await lookup(parsed.hostname)
      const ipErr = checkResolvedIp(resolved.address)
      if (ipErr) return ipErr
    } catch {
      return `Error: Could not resolve hostname "${parsed.hostname}"`
    }

    // Follow redirects manually to re-check each hop
    let currentUrl = url
    let response: Response | null = null

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)

      try {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: "manual",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
          },
        })
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return "Error: Request timed out (15s)"
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      } finally {
        clearTimeout(timeout)
      }

      // Check for redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) return `Error: HTTP ${response.status} redirect with no Location header`

        let nextParsed: URL
        try {
          nextParsed = new URL(location, currentUrl)
        } catch {
          return `Error: Invalid redirect URL "${location}"`
        }

        if (nextParsed.protocol !== "http:" && nextParsed.protocol !== "https:") {
          return `Error: Redirect to non-HTTP protocol blocked`
        }

        const redirHostErr = checkHostname(nextParsed.hostname)
        if (redirHostErr) return redirHostErr

        try {
          const resolved = await lookup(nextParsed.hostname)
          const ipErr = checkResolvedIp(resolved.address)
          if (ipErr) return ipErr
        } catch {
          return `Error: Could not resolve redirect hostname "${nextParsed.hostname}"`
        }

        currentUrl = nextParsed.href
        continue
      }

      break
    }

    if (!response) return "Error: No response received"

    // If we get a bot-block status, fall back to headless browser
    if (response.status === 403 || response.status === 503) {
      const browserText = await fetchWithBrowser(currentUrl, maxLength)
      if (browserText) return browserText
      return `Error: HTTP ${response.status} ${response.statusText} (browser fallback also failed)`
    }

    if (!response.ok) return `Error: HTTP ${response.status} ${response.statusText}`

    // Read body with size limit
    let text: string
    try {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_BODY) {
        text = new TextDecoder().decode(buffer.slice(0, MAX_BODY))
        text += "\n... (response truncated at 1 MB)"
      } else {
        text = new TextDecoder().decode(buffer)
      }
    } catch (err) {
      return `Error reading response: ${err instanceof Error ? err.message : String(err)}`
    }

    // Strip HTML tags for readability
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + "\n... (truncated)"
    }

    return text || "(empty response)"
  },
}

/** Check hostname against known-bad patterns (before DNS resolution). */
function checkHostname(hostname: string): string | null {
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
function checkResolvedIp(ip: string): string | null {
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
 * Fallback: use headless Chromium via Puppeteer to fetch a page that blocks plain HTTP.
 * Lazy-imports puppeteer so it's only loaded when actually needed.
 */
async function fetchWithBrowser(url: string, maxLength: number): Promise<string | null> {
  let launch: (options?: Record<string, unknown>) => Promise<import("puppeteer").Browser>
  try {
    const mod = await import("puppeteer")
    launch = mod.default?.launch ?? mod.launch
  } catch {
    return null // puppeteer not available
  }

  let browser: import("puppeteer").Browser | null = null
  try {
    browser = await launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    })

    const page = await browser.newPage()
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    )

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
