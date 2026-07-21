import { ListChevronsDownUp, ListChevronsUpDown } from "lucide-react"
import { useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { formatMs } from "../../lib/util"
import {
  messagePreview,
  type TracePromptMessage,
  type TraceSqlQuality,
  type TraceToolCall,
} from "./build-trace-dag"
import { ExpandableText } from "./TraceExpandable"
import { ScopeRow } from "./TraceScope"

export function PromptMessageRow({
  scopeId,
  callIndex,
  msg,
  open,
  onToggle,
}: {
  scopeId: string
  callIndex: number
  msg: TracePromptMessage
  open: boolean
  onToggle: () => void
}) {
  const preview = messagePreview(msg)

  return (
    <div className="trace-msg">
      <ScopeRow
        scopeId={scopeId}
        kind="message"
        callIndex={callIndex}
        depth={3}
        open={open}
        onToggle={onToggle}
        leading={msg.speaker}
        title={msg.detail ?? undefined}
        summary={!open ? preview : (msg.toolCallId ?? undefined)}
      />
      {open && (
        <div className="trace-scope-body">
          {msg.content && (
            <ExpandableText text={msg.content} className="trace-body-muted" />
          )}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="trace-empty">null</span>
          )}
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className="trace-tool-inline">
              <div className="trace-tool-inline__head">
                <span className="font-mono">{tc.name}</span>
                <span className="trace-row__id font-mono" title={tc.id}>
                  {tc.id}
                </span>
              </div>
              <JsonViewer
                value={tc.arguments}
                defaultExpandDepth={0}
                maxHeight={160}
                className="trace-json"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolRow({
  scopeId,
  callIndex,
  tool,
  open,
  onToggle,
}: {
  scopeId: string
  callIndex: number
  tool: TraceToolCall
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="trace-msg">
      <ScopeRow
        scopeId={scopeId}
        kind="tool"
        callIndex={callIndex}
        depth={3}
        open={open}
        onToggle={onToggle}
        leading={tool.name}
        summary={tool.id}
      />
      {open && (
        <div className="trace-scope-body">
          <JsonViewer
            value={tool.arguments}
            defaultExpandDepth={1}
            maxHeight={200}
            className="trace-json"
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
          previewChars={320}
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
  const [descOpen, setDescOpen] = useState(false)
  const previewChars = 400
  const descLong = tool.description.length > previewChars
  const descText =
    !descLong || descOpen
      ? tool.description
      : `${tool.description.slice(0, previewChars)}…`

  function onToggleSchema() {
    setShowSchema((v) => !v)
  }

  function onToggleDesc() {
    setDescOpen((v) => !v)
  }

  return (
    <div className="trace-ctx-item">
      <div className="trace-ctx-item__name font-mono">{tool.name}</div>
      {tool.description ? (
        <pre className="trace-body-muted">{descText}</pre>
      ) : (
        <span className="trace-empty">No description</span>
      )}
      {(descLong || tool.parameters) && (
        <div className="trace-ctx-item__foot">
          {descLong && (
            <button
              type="button"
              className="trace-copy"
              onClick={onToggleDesc}
              aria-expanded={descOpen}
              aria-label={descOpen ? "Show less description" : "Show more description"}
              title={descOpen ? "Show less description" : "Show more description"}
            >
              {descOpen ? (
                <ListChevronsDownUp size={14} strokeWidth={1.75} />
              ) : (
                <ListChevronsUpDown size={14} strokeWidth={1.75} />
              )}
              <span>{descOpen ? "Less" : "More"}</span>
            </button>
          )}
          {tool.parameters && (
            <button
              type="button"
              className="trace-copy"
              onClick={onToggleSchema}
              aria-expanded={showSchema}
              aria-label={showSchema ? "Hide schema" : "Show schema"}
              title={showSchema ? "Hide schema" : "Show schema"}
            >
              <span>{showSchema ? "Hide schema" : "Schema"}</span>
            </button>
          )}
        </div>
      )}
      {showSchema && tool.parameters && (
        <JsonViewer
          value={tool.parameters}
          defaultExpandDepth={1}
          maxHeight={220}
          className="trace-json"
        />
      )}
    </div>
  )
}
