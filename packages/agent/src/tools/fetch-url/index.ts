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
import type { RunContext } from "../../application/shell/runtime.js"
import type { Tool } from "../../domain/agent-types.js"
import { checkHostname, checkResolvedIp, fetchWithBrowser } from "./helpers.js"

/** Max response body size (1 MB). */
const MAX_BODY = 1_048_576
/** Max redirect hops. */
const MAX_REDIRECTS = 5

const FETCH_URL_DESCRIPTION =
  "Fetch a URL and return its content as plain text. HTML tags are stripped.\n" +
  "\n" +
  "DO NOT GUESS URLs. If you do not have a real URL that someone has shown you (in the conversation, " +
  "a tool result, or a search result), you MUST search first. Use a search engine URL like:\n" +
  "  https://www.google.com/search?q=<your+query>\n" +
  "  https://duckduckgo.com/?q=<your+query>\n" +
  "  https://html.duckduckgo.com/html/?q=<your+query>\n" +
  "then follow the real result links.\n" +
  "\n" +
  "Inventing a plausible-looking URL (e.g. guessing a docs path on learn.microsoft.com or stackoverflow.com) " +
  "is NOT acceptable — it almost always returns 404."

const FETCH_URL_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch" },
    max_length: {
      type: "number",
      description: "Max characters to return (default 10000)",
    },
  },
  required: ["url"],
} as const

async function executeFetchUrl(args: Record<string, unknown>, run?: RunContext): Promise<string> {
  const url = String(args.url)
  const maxLength = Number(args.max_length ?? 10000)

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Error: Invalid URL "${url}"`
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: Only http/https URLs are supported"
  }

  const hostnameErr = checkHostname(parsed.hostname)
  if (hostnameErr) return hostnameErr

  try {
    const resolved = await lookup(parsed.hostname)
    const ipErr = checkResolvedIp(resolved.address)
    if (ipErr) return ipErr
  } catch {
    return `Error: hostname "${parsed.hostname}" does not resolve (DNS lookup failed). ` +
      `DO NOT guess URLs. Search first via https://www.google.com/search?q=<your+query> ` +
      `or https://duckduckgo.com/?q=<your+query> and follow real result links.`
  }

  let currentUrl = url
  let response: Response | null = null

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const killSignal = run?.signal ?? null
    const signal = killSignal
      ? AbortSignal.any([controller.signal, killSignal])
      : controller.signal

    try {
      response = await fetch(currentUrl, {
        signal,
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
        return "Error: Redirect to non-HTTP protocol blocked"
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

  if (response.status === 403 || response.status === 503) {
    const browserText = await fetchWithBrowser(currentUrl, maxLength)
    if (browserText) return browserText
    return `Error: HTTP ${response.status} ${response.statusText} (browser fallback also failed)`
  }

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      return `Error: HTTP ${response.status} ${response.statusText} for ${currentUrl}. ` +
        `This URL likely does not exist — do NOT guess another similar URL. ` +
        `Search for the topic first via https://www.google.com/search?q=<your+query> ` +
        `or https://duckduckgo.com/?q=<your+query>, then fetch a real result link.`
    }
    return `Error: HTTP ${response.status} ${response.statusText}`
  }

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
}

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description: FETCH_URL_DESCRIPTION,
  parameters: FETCH_URL_PARAMETERS,
  async execute() {
    throw new Error("fetchUrlTool must be built via createFetchUrlTool(run)")
  },
}

export function createFetchUrlTool(run?: RunContext): Tool {
  return {
    name: fetchUrlTool.name,
    description: fetchUrlTool.description,
    parameters: fetchUrlTool.parameters,
    async execute(args) {
      return executeFetchUrl(args, run)
    },
  }
}

