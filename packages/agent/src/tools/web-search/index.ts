/**
 * web_search — engine-agnostic search tool that drives a real browser
 * against the public HTML interface of DuckDuckGo, Bing, or Google.
 *
 * No 3rd-party APIs. No paid services. No shared API keys.
 *
 * Strategy:
 *   - `engine: "auto"` (default): try DDG → Bing → Google in order; the
 *     first adapter that returns at least one result wins. CAPTCHA in
 *     one engine triggers fail-over to the next.
 *   - Explicit engine: only that adapter is used; CAPTCHA bubbles up so
 *     the model can decide to escalate via `browser_human_handoff`.
 *
 * Each call launches an ephemeral browser session via the same
 * machinery as `browse_web` (so it inherits per-tenant fingerprint,
 * persistent cookies, and BYO proxy automatically). The session is
 * closed before returning so search calls don't leak resources.
 *
 * @module
 */

import type { AgentHost } from "../../application/shell/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/agent-types.js"
import { closeAllBrowserSessions, deleteSession, launchSession, persistSessionState } from "../browse-web/session.js"
import { bingAdapter } from "./bing.js"
import { fetchDuckDuckGoLite } from "./ddg-fetch.js"
import { ddgAdapter } from "./duckduckgo.js"
import { googleAdapter } from "./google.js"
import { CaptchaBlockedError, type SearchAdapter, type SearchResult } from "./types.js"

const ADAPTERS: Record<string, SearchAdapter> = {
  ddg: ddgAdapter,
  bing: bingAdapter,
  google: googleAdapter,
}

/** Order tried by `engine: "auto"` — DDG first because it rarely CAPTCHAs. */
const AUTO_ORDER: SearchAdapter[] = [ddgAdapter, bingAdapter, googleAdapter]

export interface WebSearchOptions {
  query: string
  engine?: "auto" | "ddg" | "bing" | "google"
  limit?: number
}

export async function runWebSearch(opts: WebSearchOptions, host: AgentHost): Promise<{
  engine: string
  results: SearchResult[]
  captcha: boolean
  attempted: string[]
}> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25)
  const engine = opts.engine ?? "auto"
  const attempted: string[] = []

  // Cheap path first: if the caller is happy with "auto" or DDG specifically,
  // try a plain fetch against html.duckduckgo.com/lite/. No Playwright, no
  // browser binary, no TLS download — just an HTTP request and a regex parse.
  // This avoids the failure mode where the agent escalates to a full browser
  // stack for a question that a single fetch could have answered.
  if (engine === "auto" || engine === "ddg") {
    attempted.push("ddg-lite")
    try {
      const fetched = await fetchDuckDuckGoLite(opts.query, limit)
      if (fetched.length > 0) {
        return { engine: "ddg-lite", results: fetched, captcha: false, attempted }
      }
    } catch {
      // fall through to browser-based adapters
    }
  }

  const tryAdapter = async (
    adapter: SearchAdapter,
  ): Promise<{ results: SearchResult[]; captcha: boolean }> => {
    attempted.push(adapter.id)
    const launched = await launchSession(host, false, {})
    if (typeof launched === "string") {
      // launchSession returned an error message rather than a session.
      throw new Error(`could not launch browser for ${adapter.id}: ${launched}`)
    }
    const { session, id } = launched
    try {
      const results = await adapter.search(session.page, opts.query, limit)
      await persistSessionState(session)
      return { results, captcha: false }
    } catch (err) {
      // Use a duck-typed check rather than `instanceof` so adapters
      // imported from sibling bundles (or test mocks with reset module
      // graphs) still trigger the CAPTCHA fail-over correctly.
      if (err instanceof CaptchaBlockedError || (err as { name?: string })?.name === "CaptchaBlockedError") {
        return { results: [], captcha: true }
      }
      throw err
    } finally {
      await session.browser.close().catch(() => { /* best-effort */ })
      deleteSession(host, id)
    }
  }

  if (engine !== "auto") {
    const adapter = ADAPTERS[engine]
    if (!adapter) throw new Error(`unknown search engine: ${engine}`)
    const { results, captcha } = await tryAdapter(adapter)
    return { engine: adapter.id, results, captcha, attempted }
  }

  // Auto: walk the chain until something returns results.
  let lastCaptcha = false
  for (const adapter of AUTO_ORDER) {
    const { results, captcha } = await tryAdapter(adapter)
    if (results.length > 0) return { engine: adapter.id, results, captcha: false, attempted }
    if (captcha) lastCaptcha = true
  }
  return { engine: "none", results: [], captcha: lastCaptcha, attempted }
}

const WEB_SEARCH_DESCRIPTION =
    "Search the web via a real browser against DuckDuckGo, Bing, or Google's public HTML " +
    "interface. Returns ranked {title, url, snippet} results. Use 'auto' (default) to try " +
    "engines in order until one succeeds; on CAPTCHA the auto chain falls over to the next " +
    "engine. To follow a result, pass its url to fetch_url or browse_web."

const WEB_SEARCH_PARAMETERS = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string." },
      engine: {
        type: "string",
        enum: ["auto", "ddg", "bing", "google"],
        description: "Which engine to use. Default 'auto'.",
      },
      limit: { type: "number", description: "Max results (1-25). Default 10." },
    },
    required: ["query"],
  } as const

export const webSearchToolMetadata: ToolMetadata = {
  name: "web_search",
  description: WEB_SEARCH_DESCRIPTION,
  parameters: WEB_SEARCH_PARAMETERS,
}

export const webSearchTool = webSearchToolMetadata

export function createWebSearchTool(host: AgentHost): ExecutableTool {
  return {
    ...webSearchToolMetadata,
    async execute(args) {
      const query = String(args["query"] ?? "").trim()
      if (!query) return "web_search requires a non-empty 'query'."
      const engine = (args["engine"] as "auto" | "ddg" | "bing" | "google" | undefined) ?? "auto"
      const limitRaw = args["limit"]
      const limit = typeof limitRaw === "number" ? limitRaw : undefined

      try {
        const out = await runWebSearch({ query, engine, ...(limit !== undefined ? { limit } : {}) }, host)
        if (out.results.length === 0) {
          const reason = out.captcha
            ? "All engines returned a CAPTCHA wall. Consider browser_human_handoff to complete a search interactively."
            : "No results returned (engine returned an empty page)."
          return `web_search ${query} → 0 results (engines tried: ${out.attempted.join(", ")}). ${reason}`
        }
        const lines = out.results.map(
          (r) => `${r.rank}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
        )
        return `web_search via ${out.engine} for "${query}":\n${lines.join("\n")}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Belt-and-braces — make sure we don't leak browser processes.
        try { closeAllBrowserSessions(host) } catch { /* ignore */ }
        return `web_search failed: ${msg}`
      }
    },
  }
}
