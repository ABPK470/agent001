/**
 * Search-engine adapter contract — kept narrow so we can swap engines
 * (and add new ones) without touching the tool surface.
 *
 * Adapters MUST NOT use any 3rd-party API (no SerpAPI, no paid
 * services). They drive a Playwright Page against the engine's public
 * HTML interface and parse results from the DOM.
 *
 * @module
 */

import type { Page } from "playwright"

export interface SearchResult {
  rank: number
  title: string
  url: string
  snippet: string
}

export interface SearchAdapter {
  /** Engine slug — `"ddg"`, `"google"`, `"bing"`. */
  readonly id: string
  /** Human label used in error messages. */
  readonly label: string
  /**
   * Drive `page` to the engine's results page for `query`, parse, and
   * return up to `limit` results. Throw a `CaptchaBlockedError` if the
   * engine puts up a CAPTCHA / "unusual traffic" wall — the caller will
   * fail over or escalate via {@link browser_human_handoff}.
   */
  search(page: Page, query: string, limit: number): Promise<SearchResult[]>
}

export class CaptchaBlockedError extends Error {
  constructor(public readonly engine: string) {
    super(`${engine} blocked the request with a CAPTCHA / bot wall`)
    this.name = "CaptchaBlockedError"
  }
}
