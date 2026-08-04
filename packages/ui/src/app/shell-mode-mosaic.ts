/**
 * Shell mode mosaic — same process as logout outro (WelcomeFlowLegacy):
 * Chebyshev + noise wave of hard-snapping cells. Cover, commit, reveal.
 */

import { ASCII_MICRO_PALETTE, hash2 } from "../lib/ascii-noise"
import type { AppShellMode } from "./types"

export const SHELL_MOSAIC_COLS = 60
export const SHELL_MOSAIC_ROWS = 34

/** Wave envelope — snappier than logout; still reads as a crumb cover. */
export const SHELL_MOSAIC_WAVE_MS = 360
export const SHELL_MOSAIC_PHASE_MS = 24
export const SHELL_MOSAIC_SNAP_MS = 48
/** Brief hold at full cover so the swap never flashes. */
export const SHELL_MOSAIC_HOLD_MS = 28

export type ShellMosaicCell = {
  c: number
  r: number
  dist: number
  phase: number
  glyph: string
}

export function shellMosaicCoverMs(): number {
  return SHELL_MOSAIC_WAVE_MS + SHELL_MOSAIC_PHASE_MS + SHELL_MOSAIC_SNAP_MS
}

export function shellMosaicRevealMs(): number {
  return SHELL_MOSAIC_WAVE_MS + SHELL_MOSAIC_PHASE_MS + SHELL_MOSAIC_SNAP_MS
}

export function shellMosaicTotalMs(): number {
  return shellMosaicCoverMs() + SHELL_MOSAIC_HOLD_MS + shellMosaicRevealMs()
}

export function buildShellMosaicCells(): ShellMosaicCell[] {
  const cx = (SHELL_MOSAIC_COLS - 1) / 2
  const cy = (SHELL_MOSAIC_ROWS - 1) / 2
  const maxCheb = Math.max(cx, cy) || 1
  const n = SHELL_MOSAIC_COLS * SHELL_MOSAIC_ROWS
  const cells: ShellMosaicCell[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = i % SHELL_MOSAIC_COLS
    const r = (i / SHELL_MOSAIC_COLS) | 0
    const cheb = Math.max(Math.abs(c - cx), Math.abs(r - cy)) / maxCheb
    const phase = hash2(c + 3, r + 11)
    const dist = cheb * 0.8 + phase * 0.2
    const g = ASCII_MICRO_PALETTE[(hash2(c + 41, r + 7) * ASCII_MICRO_PALETTE.length) | 0]!
    cells[i] = { c, r, dist, phase, glyph: g }
  }
  return cells
}

/** Edge → center (eats the current view). */
export function shellMosaicCoverDelayMs(dist: number, phase: number): number {
  return (1 - dist) * SHELL_MOSAIC_WAVE_MS + phase * SHELL_MOSAIC_PHASE_MS
}

/** Center → edge (peels open onto the destination). */
export function shellMosaicRevealDelayMs(dist: number, phase: number): number {
  return dist * SHELL_MOSAIC_WAVE_MS + phase * SHELL_MOSAIC_PHASE_MS
}

export function prefersReducedShellMotion(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function shellModeTransitionMs(_to: AppShellMode): number {
  if (prefersReducedShellMotion()) return 0
  return shellMosaicTotalMs()
}
