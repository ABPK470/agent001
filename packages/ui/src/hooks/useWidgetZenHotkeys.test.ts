/**
 * Widget zen hotkeys — wiring contracts for focus-capable widgets.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const activeUsersPath = join(here, "../widgets/ActiveUsers.tsx")
const zenHotkeysPath = join(here, "useWidgetZenHotkeys.ts")
const rootPath = join(here, "useOperatorKeyboardRoot.ts")
const traceOperatorPath = join(here, "../widgets/trace/use-trace-operator-keyboard.ts")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("useWidgetZenHotkeys", () => {
  it("claims a surface and handles Z / Esc without a window listener", () => {
    const src = read(zenHotkeysPath)
    expect(src).toContain('key === "z"')
    expect(src).toContain('event.key === "Escape"')
    expect(src).toContain("onEscapeBeforeExit")
    expect(src).toContain("useClaimOperatorSurface")
    expect(src).toContain("handleEscape")
    expect(src).not.toContain("window.addEventListener")
  })

  it("Trace owns Z on the review surface (not a parallel zen window listener)", () => {
    const src = read(traceOperatorPath)
    expect(src).toContain('key === "z"')
    expect(src).toContain("useReviewOperatorKeyboard")
    expect(src).not.toContain("useWidgetZenHotkeys")
    expect(src).not.toContain("window.addEventListener")
  })

  it("composition root owns the single capture-phase keydown", () => {
    const src = read(rootPath)
    expect(src).toContain('addEventListener("keydown", onKeyDown, true)')
    expect(src).toContain("getActiveOperatorSurface")
    expect(src).toContain("resolveOperatorSession")
  })

  it("Active Users wires focus mode, zen HUD, and claimed zen surface", () => {
    const src = read(activeUsersPath)
    expect(src).toContain("useWidgetFocus")
    expect(src).toContain("useWidgetZenHotkeys")
    expect(src).toContain('surfaceId: "active-users"')
    expect(src).toContain("ActiveUsersZenHud")
    expect(src).toContain("active-users-widget--zen")
    expect(src).toContain("onEscapeBeforeExit")
    expect(src).toContain("onExitZen={exitZen}")
  })
})
