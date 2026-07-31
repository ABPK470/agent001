/**
 * Maximize/restore performance contracts — snap W/H, FLIP transform motion,
 * cheap solo-hide, Trace overscan. Expanded Trace lag was 260ms W/H ease.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { TRACE_SPINE_OVERSCAN } from "../../../widgets/trace/TraceDag.js"
import { SOLO_FLIP_MS } from "./solo-flip.js"

const here = dirname(fileURLToPath(import.meta.url))

describe("maximize / restore geometry + FLIP", () => {
  const css = readFileSync(join(here, "../../../boot/index.css"), "utf8")
  const canvas = readFileSync(join(here, "GridCanvas.tsx"), "utf8")
  const shell = readFileSync(join(here, "../WidgetShell.tsx"), "utf8")

  it("snaps W/H under geometry-snap; motion is transform FLIP", () => {
    expect(canvas).toContain("workspace-canvas-geometry-snap")
    expect(canvas).toContain("playSoloFlip")
    expect(canvas).toContain("takeSoloFlipFrom")
    expect(canvas).toContain("soloFlipInvertTransform")
    expect(shell).toContain("captureSoloFlipFrom")
    expect(SOLO_FLIP_MS).toBe(260)
    // Restore: snap + flush before readTileRect — else mid-transition
    // getBoundingClientRect still looks like solo and FLIP no-ops.
    const playFn = canvas.slice(canvas.indexOf("function playSoloFlip"))
    const snapAt = playFn.indexOf('classList.add("workspace-canvas-geometry-snap")')
    const flushAt = playFn.indexOf("offsetWidth", snapAt)
    const toAt = playFn.indexOf("readTileRectInCanvas", snapAt)
    expect(snapAt).toBeGreaterThanOrEqual(0)
    expect(flushAt).toBeGreaterThan(snapAt)
    expect(toAt).toBeGreaterThan(flushAt)
    // Snap must not apply to the flipping tile (that killed the ease).
    expect(css).toMatch(
      /\.workspace-canvas-geometry-snap\s+\.workspace-tile:not\(\.workspace-tile-solo-flipping\)\s*\{[^}]*transition:\s*none\s*!important/s,
    )
    expect(css).toMatch(
      /\.workspace-tile-solo:not\(\.workspace-tile-solo-flipping\)\s*\{[^}]*transition:\s*none/s,
    )
    expect(css).toMatch(
      /\.workspace-tile-solo-flipping\s*\{[^}]*transition:\s*transform\s+260ms/s,
    )
    expect(css).toContain("is-solo-flip-arming")
  })

  it("solo-hidden uses content-visibility (not visibility hammer on *)", () => {
    expect(css).toMatch(
      /\.workspace-tile-solo-hidden\s*\{[^}]*content-visibility:\s*hidden/s,
    )
    expect(css).toMatch(/\.workspace-tile-solo-hidden\s*\{[^}]*contain:\s*strict/s)
    expect(css).not.toMatch(
      /\.workspace-tile-solo-hidden\s*,\s*\n?\s*\.workspace-tile-solo-hidden\s+\*\s*\{[^}]*visibility:\s*hidden/s,
    )
  })
})

describe("Trace maximize calm", () => {
  const dag = readFileSync(join(here, "../../../widgets/trace/TraceDag.tsx"), "utf8")
  const inspector = readFileSync(join(here, "../../../widgets/DebugInspector.tsx"), "utf8")

  it("spine overscan stays small for expanded cards", () => {
    expect(TRACE_SPINE_OVERSCAN).toBe(6)
    expect(dag).toContain("overscan={TRACE_SPINE_OVERSCAN}")
    expect(dag).not.toMatch(/overscan=\{24\}/)
  })

  it("pin resize skips unchanged size and solo-hidden / geometry-snap", () => {
    expect(dag).toContain("pinSizeRef")
    expect(dag).toContain("soloHiddenRef")
    expect(dag).toContain("workspace-canvas-geometry-snap")
    expect(dag).toContain("useTilePaint")
  })

  it("DebugInspector freezes DAG rebuild while solo-hidden", () => {
    expect(inspector).toContain("useTilePaint")
    expect(inspector).toContain("soloHidden")
    expect(inspector).toContain("frozenDagRef")
    expect(inspector).toMatch(/if\s*\(\s*soloHidden\s*&&\s*frozenDagRef\.current\s*\)/)
  })
})
