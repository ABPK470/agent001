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
const traceHotkeysPath = join(here, "../widgets/trace/use-trace-zen-hotkeys.ts")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("useWidgetZenHotkeys", () => {
  it("handles Z toggle and Esc exit in the shared hook", () => {
    const src = read(zenHotkeysPath)
    expect(src).toContain('key === "z"')
    expect(src).toContain('event.key === "Escape"')
    expect(src).toContain("onEscapeBeforeExit")
    expect(src).toContain("isEditableKeyboardTarget")
  })

  it("trace zen hotkeys delegate Z to the shared hook and do not steal Tab for view mode", () => {
    const src = read(traceHotkeysPath)
    expect(src).toContain("useWidgetZenHotkeys")
    expect(src).toContain("handleEscape: false")
    expect(src).not.toMatch(/if \(key === "z".*\n[\s\S]*if \(isZen\) onExitZen/m)
    expect(src).not.toMatch(/event\.key === "Tab"/)
  })

  it("shared zen hook can defer Escape to the operator ladder", () => {
    const src = read(zenHotkeysPath)
    expect(src).toContain("handleEscape")
  })

  it("Active Users wires focus mode, zen HUD, and shared hotkeys", () => {
    const src = read(activeUsersPath)
    expect(src).toContain("useWidgetFocus")
    expect(src).toContain("useWidgetZenHotkeys")
    expect(src).toContain("ActiveUsersZenHud")
    expect(src).toContain("active-users-widget--zen")
    expect(src).toContain("onEscapeBeforeExit")
    expect(src).toContain("onExitZen={exitZen}")
  })
})
