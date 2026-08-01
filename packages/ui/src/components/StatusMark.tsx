import { statusDotKind, type StatusDotKind } from "../theme/tokens"

export type { StatusDotKind }

/**
 * Shared run/operation status mark — shape dialect (not traffic chroma).
 * Same glyph for the same status string in Pipelines, Threads, Active Users, Sync.
 *
 *   ok   — hollow ring (success / completed)
 *   fail — filled (failed / error)
 *   live — pulse ring (running / pending / planning / waiting)
 *   skip — dashed ring (skipped / cancelled / stopped)
 *   muted — soft fill (unknown)
 */
export function StatusMark({
  status,
  title,
  size = "md",
  className = "",
}: {
  status: string
  title?: string
  /** md = 7px (lists); sm = Threads rail */
  size?: "sm" | "md"
  className?: string
}) {
  const kind = statusDotKind(status)
  return (
    <span
      className={[
        "status-mark",
        `status-mark--${kind}`,
        size === "sm" ? "status-mark--sm" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  )
}
