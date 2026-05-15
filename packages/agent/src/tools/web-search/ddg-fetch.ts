/**
 * ddg-fetch — zero-dependency search via DuckDuckGo's lite HTML endpoint.
 *
 * Used as the FIRST attempt by `web_search` so we don't pay the cost of
 * spawning a Playwright browser when a plain HTTP GET answers the question.
 *
 * The lite endpoint (`https://lite.duckduckgo.com/lite/`) renders results as
 * a simple `<table>` with no JavaScript and rarely shows a CAPTCHA. We POST
 * the query (the lite UI uses a form), then walk the result rows.
 *
 * If the endpoint is blocked, returns 0 results and the caller falls back to
 * the Playwright-based adapters.
 *
 * @module
 */

import type { SearchResult } from "./types.js"

const ENDPOINT = "https://lite.duckduckgo.com/lite/"
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"

export async function fetchDuckDuckGoLite(query: string, limit: number): Promise<SearchResult[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)

  let html: string
  try {
    const res = await fetch(ENDPOINT, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   UA,
        "Accept":       "text/html",
      },
      body:   new URLSearchParams({ q: query, kl: "us-en" }).toString(),
      signal: ctl.signal,
    })
    if (!res.ok) return []
    html = await res.text()
  } finally {
    clearTimeout(timer)
  }

  if (/anomaly|unusual traffic|please verify/i.test(html)) return []

  return parseLiteHtml(html, limit)
}

/**
 * The lite layout repeats this 4-row pattern per result:
 *   <tr><td>N.</td><td><a class="result-link" href="...">TITLE</a></td></tr>
 *   <tr><td></td><td class="result-snippet">SNIPPET</td></tr>
 *   <tr><td></td><td class="link-text">DISPLAY URL</td></tr>
 *   <tr></tr>  ← spacer
 *
 * We extract `<a class="result-link">` for the link + title, then look for the
 * next `<td class="result-snippet">` for the snippet.
 */
function parseLiteHtml(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = []
  const linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi

  const links: Array<{ url: string; title: string; offset: number }> = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html))) {
    links.push({
      url:    decodeDdgRedirect(m[1] ?? ""),
      title:  stripTags(m[2] ?? "").trim(),
      offset: m.index,
    })
    if (links.length >= limit * 2) break  // generous cap; we trim later
  }

  // Pre-collect snippet positions so we can pair each link with the *next* snippet.
  const snippets: Array<{ text: string; offset: number }> = []
  while ((m = snippetRe.exec(html))) {
    snippets.push({ text: stripTags(m[1] ?? "").trim(), offset: m.index })
  }

  for (let i = 0; i < links.length && out.length < limit; i++) {
    const link = links[i]
    if (!link) continue
    const next = snippets.find((s) => s.offset > link.offset)
    if (!link.url || !link.title) continue
    out.push({
      rank:    out.length + 1,
      title:   link.title,
      url:     link.url,
      snippet: next?.text ?? "",
    })
  }

  return out
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
}

/** DDG wraps outbound links in /l/?uddg=<encoded> — unwrap them. */
function decodeDdgRedirect(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com")
    const real = u.searchParams.get("uddg")
    if (real) return decodeURIComponent(real)
    return href.startsWith("//") ? `https:${href}` : href
  } catch {
    return href
  }
}
