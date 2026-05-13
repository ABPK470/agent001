/**
 * AttachmentChips — compact strip of pending uploaded attachments.
 *
 * Rendered inside the TermChat input bar, above the textarea, so the user
 * always sees what they've attached *with* the goal they're typing. Each
 * chip is a self-contained badge with the file name, size, and a
 * dismiss × that calls `onRemove`. Purely presentational; no fetching
 * or state of its own.
 */

import { Paperclip, X } from "lucide-react"

export interface PendingAttachment {
  id:        string
  name:      string
  sizeBytes: number
  mediaType?: string
}

function fmtSize(bytes: number): string {
  if (bytes < 1024)              return `${bytes} B`
  if (bytes < 1024 * 1024)       return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AttachmentChips({
  items,
  onRemove,
}: {
  items:    PendingAttachment[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 -mt-1">
      {items.map((a) => (
        <span
          key={a.id}
          title={`${a.name} — ${fmtSize(a.sizeBytes)}`}
          className="inline-flex items-center gap-1.5 max-w-[260px] pl-2 pr-1 py-1 rounded-md bg-overlay-1 border border-border-subtle text-[12px] text-text leading-none"
        >
          <Paperclip size={11} className="shrink-0 text-text-faint" />
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 text-text-faint">{fmtSize(a.sizeBytes)}</span>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            title="Remove attachment"
            aria-label={`Remove ${a.name}`}
            className="shrink-0 ml-0.5 p-0.5 rounded text-text-faint hover:text-text hover:bg-overlay-2 transition-colors"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}
