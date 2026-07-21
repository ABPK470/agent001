/**
 * Between-call Work card — tool runs, SQL validation, nudges, sync, human wait.
 * Sits on the spine after a Call so the loop is visible end-to-end:
 *   Call (Sent → Received / proposed tools) → Work (execute + validate).
 */

import type { OpenState } from "./open-state"
import type { TraceWorkNode } from "./build-trace-dag"
import { SqlQualityRow, ToolRow } from "./TraceRows"
import { traceScopeDepth } from "./trace-pin"
import { ScopeRow } from "./TraceScope"
import { ExpandableText } from "./TraceExpandable"

export function WorkOutline({
  work,
  open,
  openState,
  onToggle,
  onToggleTool,
  nested = false,
}: {
  work: TraceWorkNode
  open: boolean
  openState: OpenState
  onToggle: () => void
  onToggleTool: (id: string) => void
  /** True when this work sits under a step / subagent phase. */
  nested?: boolean
}) {
  const expandable =
    work.tools.length > 0 || work.notes.length > 0 || work.sqlQuality.length > 0

  return (
    <article className={`trace-card${open && expandable ? " is-open" : ""}${nested ? " is-nested" : ""}`}>
      <ScopeRow
        scopeId={work.id}
        kind="work"
        depth={traceScopeDepth("work", nested)}
        open={open && expandable}
        onToggle={onToggle}
        leading="Work"
        title={work.title !== "Work" ? work.title : undefined}
        summary={work.summary}
        soft
        expandable={expandable}
      />
      {open && expandable && (
        <div className="trace-card__body">
          <div className="trace-scope-body">
            {work.tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                open={openState.tools.has(tool.id)}
                onToggle={() => onToggleTool(tool.id)}
              />
            ))}
            {work.sqlQuality.length > 0 && (
              <div className="trace-sql-block">
                <div className="trace-next__label is-sql">
                  SQL check
                  <span className="trace-next__hint">validation · not in the prompt</span>
                </div>
                {work.sqlQuality.map((entry, i) => (
                  <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
                ))}
              </div>
            )}
            {work.notes.map((note) => (
              <div
                key={note.id}
                className={`trace-work-note${note.tone === "error" ? " is-error" : ""}`}
              >
                <div className="trace-work-note__label">{note.label}</div>
                <ExpandableText text={note.text} className="trace-body-muted" />
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}
