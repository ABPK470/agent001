/**
 * AsciiMicroField — tiny drifting ASCII texture for compact controls.
 */

import { useEffect, useRef } from "react"
import { ASCII_MICRO_PALETTE, readCssColorInk, vnoise } from "../lib/ascii-noise"

type ClearRect = { x: number; y: number; w: number; h: number }

interface Props {
  paused?: boolean
  inkOpacity?: number
  /** CSS custom property for glyph ink (default matches Viewing as). */
  inkVar?: `--${string}`
  /** Skip ASCII in a centered rect (CSS px) so crisp overlays stay clean. */
  clearCenter?: { w: number; h: number }
  /**
   * Clear every `[data-ascii-cutout]` under the cutout root.
   * Icons / solid chips sit in the holes.
   */
  cutoutsFromParent?: boolean
  /**
   * Closest ancestor selector used as cutout root + canvas size box.
   * When set, glyphs fill this box even if the canvas is nested in a clip wrapper.
   */
  cutoutRootClosest?: string
  /** Expand measured cutouts by this many CSS px (default 3). */
  cutoutPad?: number
}

const CHAR_W = 5
const LINE_H = 6
const FONT_PX = 7
const TARGET_FPS = 20
const NOISE_T_PER_SEC = 0.72

function glyphForMicro(v: number): string {
  const biased = Math.pow(Math.max(0, v - 0.08), 0.72)
  const idx = Math.min(ASCII_MICRO_PALETTE.length - 1, Math.floor(biased * ASCII_MICRO_PALETTE.length))
  return ASCII_MICRO_PALETTE[idx]!
}

function cellIntersectsRect(
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
  rect: ClearRect,
): boolean {
  return (
    cellX < rect.x + rect.w &&
    cellX + cellW > rect.x &&
    cellY < rect.y + rect.h &&
    cellY + cellH > rect.y
  )
}

function measureParentCutouts(parent: HTMLElement, pad: number): ClearRect[] {
  const origin = parent.getBoundingClientRect()
  const nodes = parent.querySelectorAll("[data-ascii-cutout]")
  const out: ClearRect[] = []
  for (const node of nodes) {
    const r = (node as HTMLElement).getBoundingClientRect()
    out.push({
      x: r.left - origin.left - pad,
      y: r.top - origin.top - pad,
      w: r.width + pad * 2,
      h: r.height + pad * 2,
    })
  }
  return out
}

export function AsciiMicroField({
  paused = false,
  inkOpacity = 1,
  inkVar = "--viewing-as",
  clearCenter,
  cutoutsFromParent = false,
  cutoutRootClosest,
  cutoutPad = 3,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  const clearCenterRef = useRef(clearCenter)
  const cutoutsRef = useRef(cutoutsFromParent)
  const cutoutRootClosestRef = useRef(cutoutRootClosest)
  const cutoutPadRef = useRef(cutoutPad)
  pausedRef.current = paused
  clearCenterRef.current = clearCenter
  cutoutsRef.current = cutoutsFromParent
  cutoutRootClosestRef.current = cutoutRootClosest
  cutoutPadRef.current = cutoutPad

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const fallback = `rgba(123, 111, 199, ${inkOpacity})`

    let cols = 0
    let rows = 0
    let ink = readCssColorInk(inkVar, inkOpacity, fallback)
    let holes: ClearRect[] = []
    let rafId = 0
    let lastFrame = 0
    const startTs = performance.now()

    function sizeRoot(): HTMLElement | null {
      const sel = cutoutRootClosestRef.current
      if (sel) return canvas!.closest(sel)
      return canvas!.parentElement
    }

    function refreshHoles() {
      const root = sizeRoot()
      if (!root) {
        holes = []
        return
      }
      const w = root.clientWidth
      const h = root.clientHeight
      if (cutoutsRef.current) {
        holes = measureParentCutouts(root, cutoutPadRef.current)
        return
      }
      const hole = clearCenterRef.current
      holes = hole
        ? [{
            x: w / 2 - hole.w / 2,
            y: h / 2 - hole.h / 2,
            w: hole.w,
            h: hole.h,
          }]
        : []
    }

    function resize() {
      const root = sizeRoot() ?? canvas!.parentElement
      const w = root?.clientWidth ?? 36
      const h = root?.clientHeight ?? 36
      canvas!.width = Math.max(1, Math.floor(w * dpr))
      canvas!.height = Math.max(1, Math.floor(h * dpr))
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.font = `600 ${FONT_PX}px "JetBrains Mono", "SFMono-Regular", "Consolas", monospace`
      ctx!.textBaseline = "top"
      cols = Math.max(1, Math.ceil(w / CHAR_W))
      rows = Math.max(1, Math.ceil(h / LINE_H))
      ink = readCssColorInk(inkVar, inkOpacity, ink)
      refreshHoles()
      paintFrame((performance.now() - startTs) * 0.001)
    }

    function paintFrame(t: number) {
      const w = canvas!.width / dpr
      const h = canvas!.height / dpr
      ctx!.clearRect(0, 0, w, h)
      ctx!.fillStyle = ink

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellX = c * CHAR_W
          const cellY = r * LINE_H
          let blocked = false
          for (const rect of holes) {
            if (cellIntersectsRect(cellX, cellY, CHAR_W, LINE_H, rect)) {
              blocked = true
              break
            }
          }
          if (blocked) continue
          const v = vnoise(c, r, t * NOISE_T_PER_SEC)
          const ch = glyphForMicro(v)
          ctx!.fillText(ch, cellX, cellY)
        }
      }
    }

    function frame(now: number) {
      rafId = requestAnimationFrame(frame)
      if (pausedRef.current || reduced) return
      if (now - lastFrame < 1000 / TARGET_FPS) return
      lastFrame = now
      ink = readCssColorInk(inkVar, inkOpacity, ink)
      if (cutoutsRef.current) refreshHoles()
      paintFrame((now - startTs) * 0.001)
    }

    resize()
    const ro = new ResizeObserver(resize)
    const observed = sizeRoot() ?? canvas.parentElement
    if (observed) ro.observe(observed)

    if (!reduced) {
      rafId = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [inkOpacity, inkVar, cutoutsFromParent, cutoutRootClosest, cutoutPad, clearCenter?.w, clearCenter?.h])

  return (
    <canvas
      ref={canvasRef}
      className="session-ascii-micro absolute inset-0 h-full w-full pointer-events-none rounded-[inherit]"
      aria-hidden
    />
  )
}
