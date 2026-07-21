import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { formatMs } from "../../lib/util"
import {
  messagePreview,
  type TracePromptMessage,
  type TraceSqlQuality,
  type TraceToolCall,
} from "./build-trace-dag"
import { IdChip } from "./TraceCopy"
import { ExpandableText } from "./TraceExpandable"

export function PromptMessageRow({
  msg,
  open,
  onToggle,
}: {
  msg: TracePromptMessage
  open: boolean
  onToggle: () => void
}) {
  const preview = messagePreview(msg)
  const isUserAnswer = msg.speaker === "User answer"

  return (
    <div className="trace-row">
      <button
        type="button"
        className="trace-row__btn"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-scope__chevslot" aria-hidden>
          {open ? (
            <ChevronDown size={12} className="trace-scope__chev" />
          ) : (
            <ChevronRight size={12} className="trace-scope__chev" />
          )}
        </span>
        <span className={isUserAnswer ? "trace-row__speaker is-em" : "trace-row__speaker"}>
          {msg.speaker}
        </span>
        {msg.detail && <span className="trace-row__detail">{msg.detail}</span>}
        {!open && <span className="trace-row__preview">{preview}</span>}
      </button>
      {open && (
        <div className="trace-row__body">
          {msg.toolCallId && <IdChip label="tool call" value={msg.toolCallId} />}
          {msg.content && (
            <ExpandableText text={msg.content} className="trace-body-muted" />
          )}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="trace-empty">null</span>
          )}
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className="trace-tool-inline">
              <span className="font-mono">{tc.name}</span>
              <IdChip label="tool call" value={tc.id} />
              <JsonViewer
                value={tc.arguments}
                label="arguments"
                defaultExpandDepth={0}
                maxHeight={160}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolRow({
  tool,
  open,
  onToggle,
}: {
  tool: TraceToolCall
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="trace-row">
      <button
        type="button"
        className="trace-row__btn"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-scope__chevslot" aria-hidden>
          {open ? (
            <ChevronDown size={12} className="trace-scope__chev" />
          ) : (
            <ChevronRight size={12} className="trace-scope__chev" />
          )}
        </span>
        <span className="font-mono">{tool.name}</span>
        {!open && (
          <span className="trace-row__preview font-mono">{tool.id.slice(0, 12)}</span>
        )}
      </button>
      {open && (
        <div className="trace-row__body">
          <IdChip label="tool call" value={tool.id} />
          <JsonViewer
            value={tool.arguments}
            label="arguments"
            defaultExpandDepth={1}
            maxHeight={200}
          />
        </div>
      )}
    </div>
  )
}

/** Per-call SQL validation telemetry — not part of the system prompt. */
export function SqlQualityRow({ entry }: { entry: TraceSqlQuality }) {
  const phaseClass =
    entry.phase === "blocked"
      ? "is-blocked"
      : entry.phase === "failed"
        ? "is-failed"
        : "is-ok"
  return (
    <div className={`trace-sql-check ${phaseClass}`}>
      <div className="trace-sql-check__head">
        <span className="trace-sql-check__badge">{entry.phase}</span>
        <span className="font-mono">{entry.toolName}</span>
        {entry.validationCode && (
          <span className="trace-sql-check__code">{entry.validationCode}</span>
        )}
        {entry.durationMs != null && (
          <span className="trace-row__detail ml-auto">{formatMs(entry.durationMs)}</span>
        )}
      </div>
      {entry.missingPersistedMirrorCandidates.length > 0 && (
        <div className="trace-row__detail">
          missing mirror: {entry.missingPersistedMirrorCandidates.join(", ")}
        </div>
      )}
      {entry.sqlPreview && (
        <ExpandableText
          text={entry.sqlPreview}
          className="code-pre"
          previewChars={180}
        />
      )}
    </div>
  )
}

export function ToolDef({
  tool,
}: {
  tool: { name: string; description: string; parameters?: Record<string, unknown> }
}) {
  const [showSchema, setShowSchema] = useState(false)

  function onToggleSchema() {
    setShowSchema((v) => !v)
  }

  return (
    <div className="trace-ctx-item">
      <div className="trace-ctx-item__head">
        <span className="font-mono">{tool.name}</span>
      </div>
      <ExpandableText
        text={tool.description}
        className="trace-body-muted"
        previewChars={120}
      />
      {tool.parameters && (
        <>
          <button
            type="button"
            className="trace-more"
            onClick={onToggleSchema}
            aria-expanded={showSchema}
          >
            {showSchema ? "Hide schema" : "Show schema"}
          </button>
          {showSchema && (
            <JsonViewer
              value={tool.parameters}
              label="schema"
              defaultExpandDepth={1}
              maxHeight={180}
            />
          )}
        </>
      )}
    </div>
  )
}
