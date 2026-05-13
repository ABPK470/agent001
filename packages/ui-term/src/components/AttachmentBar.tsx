/**
 * AttachmentBar — chip strip rendered above the GoalInput.
 *
 * One chip per pending attachment. Each chip shows the normalised name +
 * size; click the × to drop it (also calls the server to soft-delete).
 *
 * Drop targets / pickers live in App.tsx, not here. This component is
 * purely a presentational strip plus an `onRemove` callback so the same
 * shape can be reused if the visual surface ever changes.
 */

export interface PendingAttachment {
  id:        string
  name:      string
  sizeBytes: number
}

interface Props {
  items:     PendingAttachment[]
  onRemove:  (id: string) => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024)              return `${bytes} B`
  if (bytes < 1024 * 1024)       return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AttachmentBar({ items, onRemove }: Props) {
  if (items.length === 0) return null
  return (
    <div
      style={{
        borderTop: "1px solid var(--divider)",
        background: "var(--bg-input)",
        padding: "6px 12px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
      }}
    >
      <span style={{ color: "var(--fg-mute)", letterSpacing: "0.06em", marginRight: 4 }}>
        attached:
      </span>
      {items.map((a) => (
        <span
          key={a.id}
          title={`${a.name} \u2014 ${fmtSize(a.sizeBytes)}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 4px 2px 6px",
            border: "1px solid var(--divider)",
            background: "var(--bg)",
            color: "var(--fg)",
            maxWidth: 240,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.name}
          </span>
          <span style={{ color: "var(--fg-mute)" }}>
            {fmtSize(a.sizeBytes)}
          </span>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            title="Detach"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-mute)",
              cursor: "pointer",
              padding: "0 2px",
              fontFamily: "inherit",
              fontSize: "inherit",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
