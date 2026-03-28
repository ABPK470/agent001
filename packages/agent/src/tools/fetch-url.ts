/**
 * Fetch URL tool — lets the agent read web pages.
 *
 * Fetches a URL, strips HTML tags, returns plain text.
 * This is how agents "browse the web."
 */

import type { Tool } from "../types.js"

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

    // Block internal/private IPs (SSRF protection)
    const hostname = parsed.hostname
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return `Error: Access to internal/private addresses is blocked`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "agent001/0.1",
          Accept: "text/html,application/json,text/plain",
        },
      })

      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText}`
      }

      let text = await res.text()

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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Request timed out (15s)"
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      clearTimeout(timeout)
    }
  },
}
