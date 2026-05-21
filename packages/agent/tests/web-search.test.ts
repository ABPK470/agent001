/**
 * web_search adapter dispatch — verifies engine selection, fail-over,
 * and result shape without launching a real browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the browser session module so launchSession returns a fake page
// whose result count we control per-test. Adapters are stubbed too —
// we're testing the dispatch logic, not selector parsing.
vi.mock("../src/tools/browse-web/session.js", () => ({
  launchSession: vi.fn().mockResolvedValue({
    session: { page: {}, browser: { close: vi.fn().mockResolvedValue(undefined) } },
    id: "fake-id",
  }),
  persistSessionState: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(),
  closeAllBrowserSessions: vi.fn(),
}))

// Mock the ddg-lite cheap path so it never returns real results from a
// network fetch. The dispatch logic always tries `fetchDuckDuckGoLite`
// first when engine is "auto" or "ddg" (and pushes "ddg-lite" onto
// `attempted`); these tests exercise the browser-adapter fall-through,
// so we make the cheap path return [] deterministically.
vi.mock("../src/tools/web-search/ddg-fetch.js", () => ({
  fetchDuckDuckGoLite: vi.fn().mockResolvedValue([]),
}))

import { CaptchaBlockedError } from "../src/tools/web-search/types.js"

describe("web_search runWebSearch", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("uses the explicit engine when specified", async () => {
    const ddgSpy = vi.fn().mockResolvedValue([
      { rank: 1, title: "T", url: "https://x", snippet: "s" },
    ])
    vi.doMock("../src/tools/web-search/duckduckgo.js", () => ({
      ddgAdapter: { id: "ddg", label: "DuckDuckGo", search: ddgSpy },
    }))
    vi.doMock("../src/tools/web-search/bing.js", () => ({
      bingAdapter: { id: "bing", label: "Bing", search: vi.fn() },
    }))
    vi.doMock("../src/tools/web-search/google.js", () => ({
      googleAdapter: { id: "google", label: "Google", search: vi.fn() },
    }))

    const { runWebSearch } = await import("../src/tools/web-search/index.js")
    const out = await runWebSearch({ query: "hello", engine: "ddg", limit: 5 })

    expect(out.engine).toBe("ddg")
    expect(out.results.length).toBe(1)
    expect(out.attempted).toEqual(["ddg-lite", "ddg"])
    expect(ddgSpy).toHaveBeenCalledTimes(1)
  })

  it("falls over from CAPTCHA to the next engine in auto mode", async () => {
    const ddgSpy = vi.fn().mockRejectedValue(new CaptchaBlockedError("ddg"))
    const bingSpy = vi.fn().mockResolvedValue([
      { rank: 1, title: "B", url: "https://b", snippet: "bs" },
    ])
    const googleSpy = vi.fn()

    vi.doMock("../src/tools/web-search/duckduckgo.js", () => ({
      ddgAdapter: { id: "ddg", label: "DuckDuckGo", search: ddgSpy },
    }))
    vi.doMock("../src/tools/web-search/bing.js", () => ({
      bingAdapter: { id: "bing", label: "Bing", search: bingSpy },
    }))
    vi.doMock("../src/tools/web-search/google.js", () => ({
      googleAdapter: { id: "google", label: "Google", search: googleSpy },
    }))

    const { runWebSearch } = await import("../src/tools/web-search/index.js")
    const out = await runWebSearch({ query: "test", engine: "auto" })

    expect(out.engine).toBe("bing")
    expect(out.attempted).toEqual(["ddg-lite", "ddg", "bing"])
    expect(googleSpy).not.toHaveBeenCalled()
    expect(out.results[0]?.title).toBe("B")
  })

  it("returns captcha=true and no results when all engines block", async () => {
    const block = vi.fn().mockRejectedValue(new CaptchaBlockedError("x"))
    vi.doMock("../src/tools/web-search/duckduckgo.js", () => ({
      ddgAdapter: { id: "ddg", label: "DuckDuckGo", search: block },
    }))
    vi.doMock("../src/tools/web-search/bing.js", () => ({
      bingAdapter: { id: "bing", label: "Bing", search: block },
    }))
    vi.doMock("../src/tools/web-search/google.js", () => ({
      googleAdapter: { id: "google", label: "Google", search: block },
    }))

    const { runWebSearch } = await import("../src/tools/web-search/index.js")
    const out = await runWebSearch({ query: "blocked" })

    expect(out.engine).toBe("none")
    expect(out.captcha).toBe(true)
    expect(out.results.length).toBe(0)
    expect(out.attempted).toEqual(["ddg-lite", "ddg", "bing", "google"])
  })

  it("rejects unknown engine", async () => {
    const { runWebSearch } = await import("../src/tools/web-search/index.js")
    await expect(
      runWebSearch({ query: "x", engine: "yahoo" as never }),
    ).rejects.toThrow(/unknown search engine/)
  })

  it("clamps limit into 1-25", async () => {
    let captured = -1
    const spy = vi.fn().mockImplementation(async (_p: unknown, _q: string, l: number) => {
      captured = l
      return []
    })
    vi.doMock("../src/tools/web-search/duckduckgo.js", () => ({
      ddgAdapter: { id: "ddg", label: "DuckDuckGo", search: spy },
    }))
    vi.doMock("../src/tools/web-search/bing.js", () => ({
      bingAdapter: { id: "bing", label: "Bing", search: vi.fn().mockResolvedValue([]) },
    }))
    vi.doMock("../src/tools/web-search/google.js", () => ({
      googleAdapter: { id: "google", label: "Google", search: vi.fn().mockResolvedValue([]) },
    }))

    const { runWebSearch } = await import("../src/tools/web-search/index.js")
    await runWebSearch({ query: "x", engine: "ddg", limit: 999 })
    expect(captured).toBe(25)
    await runWebSearch({ query: "x", engine: "ddg", limit: 0 })
    expect(captured).toBe(1)
  })
})
