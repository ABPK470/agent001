/**
 * Bing adapter — public web search HTML interface.
 *
 * Bing tolerates headless browsers far better than Google. Used as the
 * second-tier fallback when DuckDuckGo blocks or returns nothing.
 *
 * @module
 */

import type { Page } from "playwright"

import { CaptchaBlockedError, type SearchAdapter, type SearchResult } from "./types.js"

export const bingAdapter: SearchAdapter = {
  id: "bing",
  label: "Bing",

  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })

    const bodyText = (await page.textContent("body")) ?? ""
    if (/verify you are a human|captcha/i.test(bodyText)) {
      throw new CaptchaBlockedError(bingAdapter.id)
    }

    const raw = await page.$$eval(
      "#b_results > li.b_algo",
      (nodes: unknown[], max: number) => {
        type El = { querySelector(sel: string): { textContent: string | null; href?: string } | null }
        const out: { title: string; url: string; snippet: string }[] = []
        for (const node of nodes) {
          const n = node as El
          if (out.length >= max) break
          const a = n.querySelector("h2 a")
          const snippetEl = n.querySelector(".b_caption p") ?? n.querySelector("p")
          if (!a) continue
          out.push({
            title: (a.textContent ?? "").trim(),
            url: a.href ?? "",
            snippet: (snippetEl?.textContent ?? "").trim()
          })
        }
        return out
      },
      limit
    )

    return raw.map((r, i): SearchResult => ({ rank: i + 1, ...r }))
  }
}
