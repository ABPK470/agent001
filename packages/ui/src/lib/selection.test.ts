import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CONTROL_IDLE,
  CONTROL_PRESSED,
  CONTROL_READY,
  LIST_ROW_ACTIVE,
  LIST_ROW_IDLE,
  PLACE_TAB_ACTIVE,
  PLACE_TAB_IDLE,
  SELECT_ACTIVE,
  SELECT_IDLE,
  SELECT_TRACK,
} from "./selection"
import { TAB_PILL_ACTIVE, TAB_PILL_IDLE, TAB_SEGMENT_TRACK } from "../widgets/entity-registry/chrome"
import { iconButtonClass } from "../widgets/entity-registry/IconButton"

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../boot/index.css"),
  "utf8",
)

describe("selection dialect — place / mode / control", () => {
  it("PLACE tabs are quiet shade + weight — never underline", () => {
    expect(PLACE_TAB_ACTIVE).toContain("font-semibold")
    expect(PLACE_TAB_ACTIVE).toContain("bg-[var(--select-fill)]")
    expect(PLACE_TAB_ACTIVE).not.toContain("border-b-2")
    expect(PLACE_TAB_IDLE).toContain("hover:bg-[var(--hover-fill)]")
    expect(TAB_PILL_ACTIVE).toBe(PLACE_TAB_ACTIVE)
    expect(TAB_PILL_IDLE).toBe(PLACE_TAB_IDLE)
  })

  it("MODE active/hover are shade fills — never screaming outline", () => {
    expect(SELECT_ACTIVE).toContain("bg-[var(--select-fill)]")
    expect(SELECT_ACTIVE).not.toContain("border-text")
    expect(SELECT_IDLE).toContain("hover:bg-[var(--hover-fill)]")
    expect(TAB_SEGMENT_TRACK).toBe(SELECT_TRACK)
  })

  it("list rows use shade fill + Threads radius — never a left-rule tick", () => {
    expect(LIST_ROW_ACTIVE).toContain("bg-[var(--select-fill)]")
    expect(LIST_ROW_ACTIVE).toContain("rounded-[var(--list-row-radius)]")
    expect(LIST_ROW_ACTIVE).not.toContain("before:")
    expect(LIST_ROW_IDLE).toContain("hover:bg-[var(--hover-fill)]")
    expect(css).toMatch(/--list-row-radius:\s*0\.65rem/)
    expect(css).toMatch(
      /\.thread-rail-item-row\s*\{[^}]*border-radius:\s*var\(--list-row-radius\)/s,
    )
    expect(css).toMatch(
      /\.entity-rail-item-row\s*\{[^}]*border-radius:\s*var\(--list-row-radius\)/s,
    )
    expect(css).toMatch(
      /\.trace-scope\s*\{[^}]*border-radius:\s*var\(--list-row-radius\)/s,
    )
  })

  it("controls keep the frame and fill bg on hover/press", () => {
    expect(CONTROL_IDLE).toContain("hover:bg-[var(--hover-fill)]")
    expect(CONTROL_PRESSED).toContain("bg-[var(--select-fill)]")
  })

  it("go-to CONTROL_READY is ink fill — not select-fill mode", () => {
    expect(CONTROL_READY).toBe("mia-control--ready")
    expect(CONTROL_READY).not.toContain("select-fill")
    expect(css).toMatch(
      /\.mia-control\.mia-control--ready\s*,\s*\n\s*\.mia-control\.mia-control--ready:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--text\)/s,
    )
    expect(iconButtonClass({ ready: true })).toContain("mia-control--ready")
    expect(iconButtonClass({ ready: true, active: true })).toContain("mia-control--ready")
  })

  it("IconButton active is shaded", () => {
    expect(iconButtonClass({ active: true })).toContain("bg-[var(--select-fill)]")
    expect(iconButtonClass({ variant: "track", active: true })).toContain("bg-[var(--select-fill)]")
  })

  it("layout view-tabs match bordered ops control height — inset in taller header", () => {
    expect(css).toMatch(
      /\.view-tab\s*\{[^}]*height:\s*var\(--shell-chrome-row-h\)/s,
    )
    expect(css).toMatch(
      /\.view-tab\s*\{[^}]*border-radius:\s*var\(--view-chip-radius\)/s,
    )
    expect(css).toMatch(
      /\.view-tab\s*\{[^}]*align-self:\s*center/s,
    )
    expect(css).toMatch(
      /\.toolbar-ops-btn\s*\{[^}]*height:\s*var\(--shell-chrome-row-h\)/s,
    )
    expect(css).toMatch(
      /\.view-tab--active\s*\{[^}]*background:\s*var\(--select-fill\)/s,
    )
    expect(css).not.toMatch(
      /\.view-tab--active\s*\{[^}]*border-bottom-color:\s*var\(--text\)/s,
    )
  })

  it("light Trace hover beats idle transparent (specificity restated)", () => {
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.trace-scope:hover[\s\S]*?background:\s*var\(--hover-fill\)/,
    )
  })
})
