/**
 * Leaf rows inside Sent / Received — not sticky-scroll scopes.
 * Collapsed row: speaker · detail · preview (one flowing line, no far-right gap).
 */

import { ChevronDown, ChevronRight, ListChevronsDownUp, ListChevronsUpDown } from "lucide-react"
import { useRef, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { preserveScrollAnchor } from "../../lib/chatScroll"
import { formatMs } from "../../lib/util"
import {
  messagePreview,
  type TracePromptMessage,
  type TraceSqlQuality,
  type TraceToolCall,
} from "./build-trace-dag"
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
  const isSystem = msg.role === "system" || msg.speaker === "System"
  const hasBody =
    Boolean(msg.content) || msg.toolCalls.length > 0 || Boolean(msg.toolCallId)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (!hasBody && !preview) {
    return (
      <div className={`trace-msg${isSystem ? " is-system" : ""}`}>
        <span className="trace-scope__chevslot" aria-hidden />
        <span className={isUserAnswer ? "trace-row__speaker is-em" : "trace-row__speaker"}>
          {msg.speaker}
        </span>
        <span className="trace-empty">empty</span>
      </div>
    )
  }

  function onClick() {
    preserveScrollAnchor(buttonRef.current, onToggle)
  }

  return (
    <div className={`trace-msg${isSystem ? " is-system" : ""}${open ? " is-open" : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="trace-msg__btn"
        onClick={onClick}
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
        {msg.detail && <span className="trace-msg__detail">{msg.detail}</span>}
        {!open && preview && <span className="trace-msg__preview">{preview}</span>}
      </button>
      {open && (
        <div className="trace-msg__body">
          {msg.toolCallId && (
            <div className="trace-msg__meta font-mono" title={msg.toolCallId}>
              {msg.toolCallId}
            </div>
          )}
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
                <span className="trace-msg__meta font-mono" title={tc.id}>
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
  tool,
  open,
  onToggle,
}: {
  tool: TraceToolCall
  open: boolean
  onToggle: () => void
}) {
  const statusClass =
    tool.status === "error" ? " is-error" : tool.status === "done" ? " is-done" : ""
  const resultPeek =
    tool.resultText && !open
      ? tool.resultText.replace(/\s+/g, " ").trim().slice(0, 72)
      : null
  const buttonRef = useRef<HTMLButtonElement>(null)

  function onClick() {
    preserveScrollAnchor(buttonRef.current, onToggle)
  }

  return (
    <div className={`trace-msg${statusClass}${open ? " is-open" : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="trace-msg__btn"
        onClick={onClick}
        aria-expanded={open}
      >
        <span className="trace-scope__chevslot" aria-hidden>
          {open ? (
            <ChevronDown size={12} className="trace-scope__chev" />
          ) : (
            <ChevronRight size={12} className="trace-scope__chev" />
          )}
        </span>
        <span className="font-mono trace-msg__tool">{tool.name}</span>
        {tool.status === "error" && <span className="trace-msg__detail is-error">failed</span>}
        {tool.status === "done" && <span className="trace-msg__detail">done</span>}
        {tool.status === "running" && <span className="trace-msg__detail">running</span>}
        {!open && resultPeek && (
          <span className="trace-msg__preview">
            {resultPeek.length >= 72 ? `${resultPeek.slice(0, 71)}…` : resultPeek}
          </span>
        )}
      </button>
      {open && (
        <div className="trace-msg__body">
          <div className="trace-msg__meta font-mono" title={tool.id}>
            {tool.id}
          </div>
          <JsonViewer
            value={tool.arguments}
            defaultExpandDepth={1}
            maxHeight={200}
            className="trace-json"
          />
          {tool.resultText != null && tool.resultText !== "" && (
            <div className="trace-tool-result">
              <div className="trace-next__label">
                {tool.status === "error" ? "Error" : "Result"}
              </div>
              <ExpandableText text={tool.resultText} className="trace-body-muted" />
            </div>
          )}
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
  const descBtnRef = useRef<HTMLButtonElement>(null)
  const schemaBtnRef = useRef<HTMLButtonElement>(null)
  const previewChars = 400
  const descLong = tool.description.length > previewChars
  const descText =
    !descLong || descOpen
      ? tool.description
      : `${tool.description.slice(0, previewChars)}…`

  function onToggleSchema() {
    preserveScrollAnchor(schemaBtnRef.current, () => setShowSchema((v) => !v))
  }

  function onToggleDesc() {
    preserveScrollAnchor(descBtnRef.current, () => setDescOpen((v) => !v))
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
              ref={descBtnRef}
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
              ref={schemaBtnRef}
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
