/**
 * Logo — MI:A brand mark.
 *
 * Eyes glow purple when online (slow blink), disappear when offline.
 *
 * Usage:
 *   <Logo size={32} online />
 *   <Logo size={32} online={false} />
 */

interface Props {
  size?: number
  online?: boolean
  className?: string
}

const EYE_ONLINE  = "var(--color-success)"
const EYE_OFFLINE = "var(--color-error)"
const BODY        = "var(--color-accent)"

export function Logo({ size = 32, online = true, className }: Props) {
  const eye = online ? EYE_ONLINE : EYE_OFFLINE

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 14"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-label={online ? "MI:A — online" : "MI:A — offline"}
      role="img"
      className={className}
      style={{ flexShrink: 0, display: "block" }}
    >
      {/* Body with eye holes punched out */}
      <path
        fill={BODY}
        fillRule="evenodd"
        d="M3 0 H17 V3 H20 V11 H17 V14 H3 V11 H0 V3 H3 Z
           M3 5 H7 V9 H3 Z
           M13 5 H17 V9 H13 Z"
      />
      {/* Eyes — slow blink when online, invisible when offline */}
      <rect x="3"  y="5" width="4" height="4" fill={eye} className={online ? "eye-online" : "eye-offline"} />
      <rect x="13" y="5" width="4" height="4" fill={eye} className={online ? "eye-online" : "eye-offline"} />
    </svg>
  )
}

