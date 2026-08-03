import { AlertTriangle } from "lucide-react"
import { ReviewTreeItem } from "../../components/ReviewTree"
import { truncateOpLogText } from "./op-log-text"

/** Full-width error banner — inner tint bar (used inside {@link OpLogErrorTreeRow}). */
export function OpLogErrorBanner({ message }: { message: string }) {
  return (
    <div className="op-log-error-row__banner" title={message}>
      <AlertTriangle size={12} className="op-log-error-row__icon shrink-0" aria-hidden />
      <span className="op-log-error-row__text">{truncateOpLogText(message, 120)}</span>
    </div>
  )
}

/**
 * Error preview as a dedicated tree peer — keeps parent row height fixed so
 * connectors do not overshoot into blank space.
 */
export function OpLogErrorTreeRow({
  message,
  depth = 0,
}: {
  message: string
  depth?: number
}) {
  const gridStyle = { ["--op-log-depth" as string]: depth }
  return (
    <ReviewTreeItem>
      <div className="review-tree__row op-log-error-row">
        <div className="op-log-row-grid op-log-row-grid--no-icon" style={gridStyle}>
          <span className="op-log-row-grid__chev review-chevron-slot" aria-hidden>
            <span className="op-log-row-grid__chev-spacer" />
          </span>
          <span className="op-log-row-grid__icon" aria-hidden />
          <OpLogErrorBanner message={message} />
        </div>
      </div>
    </ReviewTreeItem>
  )
}

/** @deprecated Use {@link OpLogErrorTreeRow} inside LogNest. */
export function OpLogErrorCallout({ message }: { message: string }) {
  return <OpLogErrorBanner message={message} />
}
