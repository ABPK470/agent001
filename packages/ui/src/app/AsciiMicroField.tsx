/**
 * AsciiMicroField — tiny drifting ASCII texture for compact controls.
 */

import { useEffect, useRef } from "react"
import { ASCII_MICRO_PALETTE, readCssColorInk, vnoise } from "../lib/ascii-noise"

interface Props {
  paused?: boolean
  inkOpacity?: number
  /** Skip ASCII in a centered rect (CSS px) so crisp overlays stay clean. */
  clearCenter?: { w: number; h: number }
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
  rectX: number,
  rectY: number,
  rectW: number,
  rectH: number,
): boolean {
  return (
    cellX < rectX + rectW &&
    cellX + cellW > rectX &&
    cellY < rectY + rectH &&
    cellY + cellH > rectY
  )
}

export function AsciiMicroField({ paused = false, inkOpacity = 1, clearCenter }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  const clearCenterRef = useRef(clearCenter)
  pausedRef.current = paused
  clearCenterRef.current = clearCenter

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    let cols = 0
    let rows = 0
    let ink = readCssColorInk("--logo-mark-live", inkOpacity, `rgba(123, 111, 199, ${inkOpacity})`)
    let rafId = 0
    let lastFrame = 0
    const startTs = performance.now()

    function resize() {
      const parent = canvas!.parentElement
      const w = parent?.clientWidth ?? 36
      const h = parent?.clientHeight ?? 36
      canvas!.width = Math.max(1, Math.floor(w * dpr))
      canvas!.height = Math.max(1, Math.floor(h * dpr))
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.font = `600 ${FONT_PX}px "JetBrains Mono", "SFMono-Regular", "Consolas", monospace`
      ctx!.textBaseline = "top"
      cols = Math.max(1, Math.ceil(w / CHAR_W))
      rows = Math.max(1, Math.ceil(h / LINE_H))
      ink = readCssColorInk("--logo-mark-live", inkOpacity, ink)
      paintFrame((performance.now() - startTs) * 0.001)
    }

    function paintFrame(t: number) {
      const w = canvas!.width / dpr
      const h = canvas!.height / dpr
      ctx!.clearRect(0, 0, w, h)
      ctx!.fillStyle = ink

      const hole = clearCenterRef.current
      const clearRect = hole
        ? {
            x: w / 2 - hole.w / 2,
            y: h / 2 - hole.h / 2,
            w: hole.w,
            h: hole.h,
          }
        : null

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellX = c * CHAR_W
          const cellY = r * LINE_H
          if (
            clearRect &&
            cellIntersectsRect(cellX, cellY, CHAR_W, LINE_H, clearRect.x, clearRect.y, clearRect.w, clearRect.h)
          ) {
            continue
          }
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
      ink = readCssColorInk("--logo-mark-live", inkOpacity, ink)
      paintFrame((now - startTs) * 0.001)
    }

    resize()
    const ro = new ResizeObserver(resize)
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    if (!reduced) {
      rafId = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [inkOpacity, clearCenter?.w, clearCenter?.h])

  return (
    <canvas
      ref={canvasRef}
      className="session-ascii-micro absolute inset-0 h-full w-full pointer-events-none rounded-lg"
      aria-hidden
    />
  )
}
