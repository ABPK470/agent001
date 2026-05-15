/**
 * DuckDuckGo adapter — uses the lightweight HTML endpoint
 * (`html.duckduckgo.com/html/`) which renders results without
 * requiring JavaScript and rarely shows CAPTCHAs.
 *
 * Default + most-reliable engine for headless scraping; the dispatcher
 * tries it first.
 *
 * @module
 */

import type { Page } from "playwright"

import { CaptchaBlockedError, type SearchAdapter, type SearchResult } from "./types.js"

export const ddgAdapter: SearchAdapter = {
  id: "ddg",
  label: "DuckDuckGo",

  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })

    // CAPTCHA / anomaly check before extraction.
    const bodyText = (await page.textContent("body")) ?? ""
    if (/anomaly|unusual traffic|please verify/i.test(bodyText)) {
      throw new CaptchaBlockedError(ddgAdapter.id)
    }

    const raw = await page.$$eval(".result", (nodes: unknown[], max: number) => {
      const out: { title: string; url: string; snippet: string }[] = []
      for (const node of nodes) {
        const n = node as { querySelector(sel: string): { textContent: string | null; getAttribute(name: string): string | null } | null }
        if (out.length >= max) break
        const a = n.querySelector("a.result__a")
        const snippetEl = n.querySelector(".result__snippet")
        if (!a) continue
        const href = a.getAttribute("href") ?? ""
        let url = href
        try {
          const u = new URL(href, "https://duckduckgo.com")
          const real = u.searchParams.get("uddg")
          if (real) url = decodeURIComponent(real)
        } catch { /* keep raw href */ }
        out.push({
          title: (a.textContent ?? "").trim(),
          url,
          snippet: (snippetEl?.textContent ?? "").trim(),
        })
      }
      return out
    }, limit)

    return raw.map((r, i): SearchResult => ({ rank: i + 1, ...r }))
  },
}
