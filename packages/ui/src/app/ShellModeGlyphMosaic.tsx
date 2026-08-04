import { useId, useMemo } from "react"
import { IntroAsciiField } from "./home/IntroAsciiField"
import {
  buildShellMosaicCells,
  SHELL_MOSAIC_COLS,
  SHELL_MOSAIC_ROWS,
  SHELL_MOSAIC_SNAP_MS,
  shellMosaicCoverDelayMs,
  shellMosaicRevealDelayMs,
} from "./shell-mode-mosaic"
import type { AppShellMode } from "./types"

export type ShellMosaicPhase = "cover" | "reveal"

interface Props {
  to: AppShellMode
  phase: ShellMosaicPhase
}

/**
 * Cover → commit → reveal.
 *
 * Logic: paint the real chat ASCII matrix once; the mosaic mask crumbles
 * it into view cell-by-cell (and peels it away). The wall is never faded
 * in as a separate full-screen flash.
 */
export function ShellModeGlyphMosaic({ to, phase }: Props) {
  const cells = useMemo(() => buildShellMosaicCells(), [])
  const maskId = useId().replace(/:/g, "")
  const direction = to === "workspace" ? "to-workspace" : "to-chat"
  const maskUrl = `url(#${maskId})`

  return (
    <div
      className={`shell-mode-mosaic shell-mode-mosaic--${direction} shell-mode-mosaic--${phase}`}
      aria-hidden="true"
    >
      <svg className="shell-mode-mosaic-mask-svg" aria-hidden="true">
        <defs>
          <mask
            id={maskId}
            maskUnits="objectBoundingBox"
            maskContentUnits="objectBoundingBox"
          >
            <rect width="1" height="1" fill="black" />
            {cells.map((cell, i) => {
              const delay =
                phase === "cover"
                  ? shellMosaicCoverDelayMs(cell.dist, cell.phase)
                  : shellMosaicRevealDelayMs(cell.dist, cell.phase)
              return (
                <rect
                  key={i}
                  className="shell-mode-mosaic-mask-cell"
                  x={cell.c / SHELL_MOSAIC_COLS}
                  y={cell.r / SHELL_MOSAIC_ROWS}
                  width={1 / SHELL_MOSAIC_COLS}
                  height={1 / SHELL_MOSAIC_ROWS}
                  fill="white"
                  style={{
                    animationDuration: `${SHELL_MOSAIC_SNAP_MS}ms`,
                    animationDelay: `${delay}ms`,
                  }}
                />
              )
            })}
          </mask>
        </defs>
      </svg>

      <div
        className="shell-mode-mosaic-matrix"
        style={{
          maskImage: maskUrl,
          WebkitMaskImage: maskUrl,
        }}
      >
        <IntroAsciiField surface="home" boost />
      </div>
    </div>
  )
}
