/**
 * Zen session seams — allowlist, persist shape, Summon routing.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { widgetSupportsFocusMode } from "./widget-focus"
import { canJoinZenSession, isZenViewId, ZEN_VIEW_ID_PREFIX } from "./zen-session"

const here = dirname(fileURLToPath(import.meta.url))

describe("zen session architecture", () => {
  it("allowlists Event Stream + Pipelines with Trace / Active Users", () => {
    expect(widgetSupportsFocusMode("live-logs")).toBe(true)
    expect(widgetSupportsFocusMode("operation-log")).toBe(true)
    expect(canJoinZenSession("debug-inspector")).toBe(true)
    expect(canJoinZenSession("term-chat")).toBe(false)
  })

  it("layout persist partialize keeps zen session ephemeral", () => {
    const store = readFileSync(join(here, "../state/layout-store.ts"), "utf8")
    const partial = store.match(/partialize:\s*\(state\)\s*=>\s*\(\{[\s\S]*?\}\)/)?.[0]
    expect(partial).toBeTruthy()
    expect(partial).toContain("views: state.views")
    expect(partial).toContain("activeViewId: state.activeViewId")
    expect(partial).not.toContain("zenActive")
    expect(partial).not.toContain("zenSet")
    expect(store).toContain("emptyZenSession")
    expect(store).toContain("isZenViewId")
  })

  it("Summon Keep while zen routes through zenKeepWidget", () => {
    const summon = readFileSync(
      join(here, "../app/workspace/SummonPalette.tsx"),
      "utf8",
    )
    expect(summon).toContain("zenKeepWidget")
    expect(summon).toContain("zenActive")
  })

  it("zen view ids use the zen: family", () => {
    expect(ZEN_VIEW_ID_PREFIX).toBe("zen:")
    expect(isZenViewId("zen:abc")).toBe(true)
  })

  it("tab reorder defers Zen Space Call so chrome-off cannot kill the drag", () => {
    const reorder = readFileSync(
      join(here, "../hooks/useViewTabReorder.ts"),
      "utf8",
    )
    expect(reorder).toContain("isZenViewId")
    expect(reorder).toMatch(/if\s*\(\s*!isZenViewId\(viewId\)\s*\)/)
    expect(reorder).toMatch(
      /if\s*\(\s*isZenViewId\(viewId\)\s*\)\s*activateViewIfNeeded\(viewId\)/,
    )
  })
})
