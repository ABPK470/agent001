import { Brain, X } from "lucide-react"
import { CodeBlock } from "../../components/CodeBlock"
import { formatToolIoMeta, type ToolIoDetails } from "./tool-call-io"

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

export function ToolCallModal({
  io,
  onClose,
}: {
  io: ToolIoDetails
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[min(96vh,calc(100dvh-1rem))] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
          <div className="min-w-0 flex items-center gap-2">
            <Brain size={16} className="shrink-0 text-accent" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-text truncate font-mono">{io.tool}</div>
              <div className="text-xs font-mono text-text-muted truncate">{formatToolIoMeta(io)}</div>
            </div>
          </div>
          <button type="button" className="text-text-muted hover:text-text" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          {io.inputFormatted ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-text-muted/70 mb-1">Input</div>
              <CodeBlock code={io.inputFormatted} lang="json" maxHeight={9999} />
            </div>
          ) : (
            <div className="text-sm text-text-muted/60 italic">No input recorded.</div>
          )}
          {io.status === "success" && io.outputText && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-text-muted/70 mb-1">Output</div>
              <CodeBlock code={io.outputText} lang="text" maxHeight={9999} />
            </div>
          )}
          {io.status === "failed" && io.error && (
            <div className="rounded-md border border-error/30 bg-error-soft px-3 py-2 text-sm text-error break-all">
              {io.error}
            </div>
          )}
          {io.status === "running" && (
            <div className="text-sm text-text-muted italic">Step still running — output not available yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
