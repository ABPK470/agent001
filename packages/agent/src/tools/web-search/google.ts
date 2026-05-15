/**
 * Google adapter — last-resort engine. Google aggressively rate-limits
 * and CAPTCHAs headless browsers, so this is only used when explicitly
 * requested or when DDG + Bing both fail.
 *
 * Uses the no-JS endpoint (`/search?gbv=1`) which renders results
 * without requiring a JavaScript engine and has more stable selectors.
 *
 * @module
 */

import type { Page } from "playwright"

import { CaptchaBlockedError, type SearchAdapter, type SearchResult } from "./types.js"

export const googleAdapter: SearchAdapter = {
  id: "google",
  label: "Google",

  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&gbv=1`
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })

    const bodyText = (await page.textContent("body")) ?? ""
    if (/unusual traffic|detected unusual|please show you'?re not a robot/i.test(bodyText)) {
      throw new CaptchaBlockedError(googleAdapter.id)
    }

    // The classic no-JS Google result block. Each hit is a div.g containing
    // an h3 inside an anchor.
    const raw = await page.$$eval("div.g, div.tF2Cxc", (nodes: unknown[], max: number) => {
      type El = { querySelector(sel: string): { textContent: string | null; href?: string } | null }
      const out: { title: string; url: string; snippet: string }[] = []
      for (const node of nodes) {
        const n = node as El
        if (out.length >= max) break
        const a = n.querySelector("a")
        const h3 = n.querySelector("h3")
        const snippetEl =
          n.querySelector(".VwiC3b") ??
          n.querySelector("[data-sncf]") ??
          n.querySelector("span")
        if (!a || !h3) continue
        out.push({
          title: (h3.textContent ?? "").trim(),
          url: a.href ?? "",
          snippet: (snippetEl?.textContent ?? "").trim(),
        })
      }
      return out
    }, limit)

    return raw.map((r, i): SearchResult => ({ rank: i + 1, ...r }))
  },
}
