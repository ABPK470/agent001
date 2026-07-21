/**
 * Between-call Work card — tool runs, nudges, sync, human wait.
 * Sits on the spine after a Call so the loop is visible end-to-end.
 */

import type { OpenState } from "./open-state"
import type { TraceWorkNode } from "./build-trace-dag"
import { ToolRow } from "./TraceRows"
import { ScopeRow } from "./TraceScope"
import { ExpandableText } from "./TraceExpandable"

export function WorkOutline({
  work,
  open,
  openState,
  onToggle,
  onToggleTool,
}: {
  work: TraceWorkNode
  open: boolean
  openState: OpenState
  onToggle: () => void
  onToggleTool: (id: string) => void
}) {
  return (
    <article className={`trace-card${open ? " is-open" : ""}`}>
      <ScopeRow
        scopeId={work.id}
        kind="work"
        depth={0}
        open={open}
        onToggle={onToggle}
        leading="Work"
        title={work.title !== "Work" ? work.title : undefined}
        summary={work.summary}
        soft
      />
      {open && (
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
            {work.notes.map((note) => (
              <div
                key={note.id}
                className={`trace-work-note${note.tone === "error" ? " is-error" : ""}`}
              >
                <div className="trace-work-note__label">{note.label}</div>
                <ExpandableText text={note.text} className="trace-body-muted" />
              </div>
            ))}
            {work.tools.length === 0 && work.notes.length === 0 && (
              <span className="trace-empty">No recorded work</span>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
