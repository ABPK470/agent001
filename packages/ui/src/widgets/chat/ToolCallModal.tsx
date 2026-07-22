/**
 * Tool I/O detail modal — viewport (portal) or widget-local (anchored) host.
 */

import { Brain, X } from "lucide-react"
import type { RefObject } from "react"
import { createPortal } from "react-dom"
import { CodeBlock } from "../../components/CodeBlock"
import { formatToolIoMeta, type ToolIoDetails } from "./tool-call-io"
import {
  type ModalHost,
  ViewportOverlay,
  WidgetLocalOverlay,
} from "../widget-local-overlay"

export function ToolIoBlock({
  io,
  compact = false,
  maxHeight = 160,
}: {
  io: ToolIoDetails
  compact?: boolean
  maxHeight?: number
}) {
  return (
    <div className={`rounded-md border border-border-subtle overflow-hidden ${compact ? "text-xs" : "text-sm"}`}>
      <div className="px-2.5 py-1.5 border-b border-border-subtle bg-elevated/30 font-mono text-text-muted text-xs">
        {formatToolIoMeta(io)}
      </div>
      {io.inputFormatted && (
        <div className="border-b border-border-subtle">
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-text-muted/60">Input</div>
          <CodeBlock code={io.inputFormatted} lang="json" maxHeight={maxHeight} />
        </div>
      )}
      {io.outputText && io.status === "success" && (
        <div className="border-b border-border-subtle">
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-text-muted/60">Output</div>
          <CodeBlock code={io.outputText} lang="text" maxHeight={maxHeight} />
        </div>
      )}
      {io.error && (
        <div className="px-2.5 py-1.5 text-error text-xs border-t border-border-subtle">{io.error}</div>
      )}
    </div>
  )
}

function ToolCallModalBody({
  io,
  onClose,
  codeMaxHeight,
}: {
  io: ToolIoDetails
  onClose: () => void
  codeMaxHeight: number
}) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Brain size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-medium text-text">{io.tool}</div>
            <div className="truncate font-mono text-xs text-text-muted">{formatToolIoMeta(io)}</div>
          </div>
        </div>
        <button type="button" className="text-text-muted hover:text-text" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {io.inputFormatted ? (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted/70">Input</div>
            <CodeBlock code={io.inputFormatted} lang="json" maxHeight={codeMaxHeight} />
          </div>
        ) : (
          <div className="text-sm italic text-text-muted/60">No input recorded.</div>
        )}
        {io.status === "success" && io.outputText && (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted/70">Output</div>
            <CodeBlock code={io.outputText} lang="text" maxHeight={codeMaxHeight} />
          </div>
        )}
        {io.status === "failed" && io.error && (
          <div className="rounded-md border border-error/30 bg-error-soft px-3 py-2 text-sm break-all text-error">
            {io.error}
          </div>
        )}
        {io.status === "running" && (
          <div className="text-sm italic text-text-muted">Step still running — output not available yet.</div>
        )}
      </div>
    </>
  )
}

export function ToolCallModal({
  io,
  onClose,
  host = "viewport",
  hostRef,
}: {
  io: ToolIoDetails
  onClose: () => void
  /** local = pin to widget hostRef; viewport = full-screen portal */
  host?: ModalHost
  hostRef?: RefObject<HTMLElement | null>
}) {
  if (host === "local") {
    if (!hostRef) {
      console.warn("ToolCallModal host=local requires hostRef")
      return null
    }
    return (
      <WidgetLocalOverlay hostRef={hostRef} onClose={onClose} aria-label="Tool I/O">
        <ToolCallModalBody io={io} onClose={onClose} codeMaxHeight={480} />
      </WidgetLocalOverlay>
    )
  }

  return createPortal(
    <ViewportOverlay onClose={onClose} aria-label="Tool I/O">
      <ToolCallModalBody io={io} onClose={onClose} codeMaxHeight={720} />
    </ViewportOverlay>,
    document.body,
  )
}
