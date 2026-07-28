/**
 * Logo — MI:A brand mark.
 *
 * A colon monogram: two rounded blocks on a fixed 24x32 grid.
 * `online` runs a live cycle on every page: brief horizontal
 * "eyes" rotation, then a vertical pinch — same 6.5s loop everywhere.
 *
 * Usage:
 *   <Logo size={32} online />
 *   <Logo size={32} online={false} />
 */

interface Props {
  size?: number
  online?: boolean
  /** Continuous spin — subagent / in-progress work affordance. */
  working?: boolean
  className?: string
}

const VIEWBOX_WIDTH = 24
const VIEWBOX_HEIGHT = 32
/** Centered in the 24-wide grid. */
const BLOCK_X = 7.5
/** Tall rounded lozenges — rectangular, not square pills. */
const BLOCK_WIDTH = 9
const BLOCK_HEIGHT = 13
const BLOCK_GAP = 6
const BLOCK_RX = 3

export function Logo({ size = 32, online = false, working = false, className }: Props) {
  const width = Math.round((size * VIEWBOX_WIDTH) / VIEWBOX_HEIGHT)
  const modeClass = working
    ? "mia-colon-logo--working"
    : online
      ? "mia-colon-logo--online"
      : "mia-colon-logo--offline"

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      width={width}
      height={size}
      aria-label={working ? "MI:A — working" : online ? "MI:A — online" : "MI:A — offline"}
      role="img"
      className={`mia-colon-logo ${modeClass}${className ? ` ${className}` : ""}`}
      style={{ flexShrink: 0, display: "block" }}
    >
      <rect
        className="mia-colon-logo-dot mia-colon-logo-dot--top"
        x={BLOCK_X}
        y={0}
        width={BLOCK_WIDTH}
        height={BLOCK_HEIGHT}
        rx={BLOCK_RX}
      />
      <rect
        className="mia-colon-logo-dot mia-colon-logo-dot--bottom"
        x={BLOCK_X}
        y={BLOCK_HEIGHT + BLOCK_GAP}
        width={BLOCK_WIDTH}
        height={BLOCK_HEIGHT}
        rx={BLOCK_RX}
      />
    </svg>
  )
}
