/**
 * Activity widget — Linear-style issue list + timeline detail panel.
 * Intentionally different from Pipelines (no card rows / nested accordions).
 */

import { Database, Loader2, Square, Wrench } from "lucide-react"
import { useMemo, useState } from "react"
import type { OperationPipeline } from "../../api"
import { OperationKind } from "../../api"
import { CodeBlock } from "../../components/CodeBlock"
import { JsonViewer } from "../../components/JsonViewer"
import { ToolCallModal } from "../../components/ToolCallModal"
import {
  fmtDuration,
  fmtTime,
  formatPipelineSubtitle,
  shortId,
  syncPlanIdFromPipeline,
} from "../../lib/operation-presentation"
import { StatusDot } from "../../operation-log-row"
import { useOpLogOpenSqlTrace } from "../../operation-log-modals"
import {
  buildOperationTimeline,
  KIND_SHORT,
  preflightItemStatus,
  type TimelineNode,
} from "./build-timeline"

const M = "text-sm text-text-muted"
const META = "text-sm tabular-nums text-text-faint"

export function IssueList({
  pipelines,
  selectedId,
  onSelect,
  compact,
  onCancel,
  cancellingId,
}: {
  pipelines: OperationPipeline[]
  selectedId: string | null
  onSelect: (id: string) => void
  compact: boolean
  onCancel?: (pipeline: OperationPipeline) => void
  cancellingId?: string | null
}) {
  return (
    <div className="divide-y divide-border-subtle">
      {pipelines.map((pipeline) => (
        <IssueBlock
          key={pipeline.id}
          pipeline={pipeline}
          open={selectedId === pipeline.id}
          onToggle={() => onSelect(pipeline.id)}
          compact={compact}
          onCancel={onCancel}
          cancelling={cancellingId === pipeline.id}
        />
      ))}
    </div>
  )
}

function IssueBlock({
  pipeline,
  open,
  onToggle,
  compact,
  onCancel,
  cancelling,
}: {
  pipeline: OperationPipeline
  open: boolean
  onToggle: () => void
  compact: boolean
  onCancel?: (pipeline: OperationPipeline) => void
  cancelling?: boolean
}) {
  const planRef = shortId(pipeline.planId ?? syncPlanIdFromPipeline(pipeline))
  const subtitle = pipeline.subtitle ? formatPipelineSubtitle(pipeline.subtitle) : null
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    (pipeline.kind === OperationKind.AgentRun || pipeline.kind === OperationKind.ProposerRun)

  return (
    <section className={open ? "bg-panel/30" : ""}>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-overlay-hover ${open ? "bg-panel/40" : ""}`}
        >
          <StatusDot status={pipeline.status} />
          <span className="shrink-0 font-mono text-xs uppercase tracking-wide text-text-faint">
            {KIND_SHORT[pipeline.kind].slice(0, 3)}-{planRef}
          </span>
          <span className={`min-w-0 flex-1 truncate font-medium ${M}`}>{pipeline.title}</span>
          {!compact && subtitle ? (
            <span className={`hidden max-w-[30%] truncate ${META} lg:inline`}>{subtitle}</span>
          ) : null}
          <span className={`hidden shrink-0 ${META} sm:inline`}>
            {pipeline.activityCount} steps
          </span>
          <span className={`shrink-0 ${META}`}>{fmtDuration(pipeline.durationMs)}</span>
          <span className={`shrink-0 w-16 text-right ${META}`}>{fmtTime(pipeline.startedAt)}</span>
        </button>
        {canCancel && (
          <button
            type="button"
            title="Stop"
            disabled={cancelling}
            onClick={() => onCancel!(pipeline)}
            className="flex w-10 shrink-0 items-center justify-center text-text-faint hover:bg-error/10 hover:text-error disabled:opacity-40"
          >
            {cancelling ? <Loader2 size={16} className="animate-spin" /> : <Square size={14} />}
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-border-subtle bg-canvas/50 px-4 py-4">
          <OperationTimeline pipeline={pipeline} />
        </div>
      )}
    </section>
  )
}

function OperationTimeline({ pipeline }: { pipeline: OperationPipeline }) {
  const nodes = useMemo(() => buildOperationTimeline(pipeline), [pipeline])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleGroup = (id: string) => {
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  if (nodes.length === 0) {
    return <p className={`py-2 ${M}`}>No activity recorded.</p>
  }

  return (
    <div className="relative ml-1">
      <div className="absolute left-[5px] top-3 bottom-3 w-px bg-border-subtle" aria-hidden />
      <ul className="space-y-0">
        {nodes.map((node) => (
          <TimelineNodeView
            key={node.id}
            node={node}
            collapsed={collapsed.has(node.id)}
            onToggleGroup={() => toggleGroup(node.id)}
          />
        ))}
      </ul>
    </div>
  )
}

function TimelineNodeView({
  node,
  collapsed,
  onToggleGroup,
}: {
  node: TimelineNode
  collapsed: boolean
  onToggleGroup: () => void
}) {
  const openSql = useOpLogOpenSqlTrace()
  const [ioOpen, setIoOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const indent = 12 + node.depth * 20

  if (node.kind === "sql-group" && node.sqlLines) {
    return (
      <li className="relative" style={{ paddingLeft: indent }}>
        <div className="flex items-start gap-3 py-2">
          <span className="relative z-10 mt-1.5 shrink-0 rounded-full bg-canvas p-0.5">
            <StatusDot status={node.status} />
          </span>
          <div className="min-w-0 flex-1">
            <button type="button" onClick={onToggleGroup} className={`text-left font-medium ${M}`}>
              {node.title}
              <span className={`ml-2 ${META}`}>
                {collapsed ? "Show" : "Hide"} {node.sqlLines.length} queries
              </span>
            </button>
            {node.detail ? <p className={`mt-0.5 ${META}`}>{node.detail}</p> : null}
            {!collapsed && (
              <ul className="mt-2 space-y-1 border-l border-border-subtle pl-4">
                {node.sqlLines.map((line) => (
                  <TimelineNodeView
                    key={line.id}
                    node={{ ...line, depth: 0 }}
                    collapsed={false}
                    onToggleGroup={() => {}}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </li>
    )
  }

  if (node.kind === "preflight" && node.preflightItems) {
    return (
      <li className="relative" style={{ paddingLeft: indent }}>
        <div className="flex items-start gap-3 py-2">
          <span className="relative z-10 mt-1.5 shrink-0 rounded-full bg-canvas p-0.5">
            <StatusDot status={node.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className={`font-medium ${M}`}>{node.title}</p>
            <ul className="mt-2 space-y-1.5">
              {node.preflightItems.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  <StatusDot status={preflightItemStatus(item)} />
                  <span className={M}>{item.title ?? item.id}</span>
                  {item.summary ? <span className={META}>· {item.summary}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li className="relative" style={{ paddingLeft: indent }}>
      <div className="flex items-start gap-3 py-2">
        <span className="relative z-10 mt-1.5 shrink-0 rounded-full bg-canvas p-0.5">
          <StatusDot status={node.status} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`${node.kind === "step" ? "font-medium" : ""} ${M}`}>{node.title}</p>
          {node.detail ? <p className={`mt-0.5 ${META}`}>{node.detail}</p> : null}
          {jsonOpen && node.jsonPayload != null && (
            <div className="mt-2 rounded-md border border-border-subtle bg-panel/60 p-3">
              {typeof node.jsonPayload === "object" ? (
                <JsonViewer value={node.jsonPayload as Record<string, unknown>} label="data" defaultExpandDepth={2} maxHeight={280} />
              ) : (
                <CodeBlock code={String(node.jsonPayload)} lang="json" maxHeight={240} />
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {node.durationMs != null ? <span className={META}>{fmtDuration(node.durationMs)}</span> : null}
          {node.timestamp ? <span className={`w-14 text-right ${META}`}>{fmtTime(node.timestamp)}</span> : null}
          {node.sqlFields && (
            <button type="button" className="rounded px-2 py-1 text-sm text-text-faint hover:bg-overlay-2 hover:text-text-muted" onClick={() => openSql(node.sqlFields!)}>
              <Database size={14} className="inline" />
            </button>
          )}
          {node.toolIo && (
            <button type="button" className="rounded px-2 py-1 text-sm text-text-faint hover:bg-overlay-2 hover:text-text-muted" onClick={() => setIoOpen(true)}>
              <Wrench size={14} className="inline" />
            </button>
          )}
          {node.jsonPayload != null && !node.sqlFields && (
            <button type="button" className="rounded px-2 py-1 text-sm text-text-faint hover:bg-overlay-2 hover:text-text-muted" onClick={() => setJsonOpen((v) => !v)}>
              {jsonOpen ? "Hide" : "JSON"}
            </button>
          )}
        </div>
      </div>
      {ioOpen && node.toolIo && <ToolCallModal io={node.toolIo} onClose={() => setIoOpen(false)} />}
    </li>
  )
}
