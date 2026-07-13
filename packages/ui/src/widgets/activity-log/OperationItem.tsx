import { ChevronRight, Loader2, Square } from "lucide-react"
import type { OperationPipeline } from "../../api"
import { OperationKind } from "../../api"
import {
  fmtDuration,
  fmtTime,
  formatPipelineSubtitle,
  pipelineActivityKey,
  shortId,
  syncPlanIdFromPipeline,
} from "../../lib/operation-presentation"
import { StepItem } from "./StepItem"
import { KindBadge, RowMeta, StatusIcon } from "./primitives"
import { AL, KIND_META } from "./tokens"

export function OperationItem({
  pipeline,
  expanded,
  onToggle,
  actExpanded,
  toggleActivity,
  compact,
  onCancel,
  cancelling,
}: {
  pipeline: OperationPipeline
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  compact: boolean
  onCancel?: (pipeline: OperationPipeline) => void
  cancelling?: boolean
}) {
  const km = KIND_META[pipeline.kind]
  const planRef = pipeline.planId ?? syncPlanIdFromPipeline(pipeline)
  const subtitle = pipeline.subtitle ? formatPipelineSubtitle(pipeline.subtitle) : null
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    (pipeline.kind === OperationKind.AgentRun || pipeline.kind === OperationKind.ProposerRun)

  return (
    <article className={AL.divider}>
      <div className="flex items-stretch">
        <button type="button" className={`${AL.rowButton} min-w-0 flex-1`} onClick={onToggle}>
          <ChevronRight
            size={14}
            className={`shrink-0 text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <StatusIcon status={pipeline.status} />
          <KindBadge abbrev={km.abbrev} color={km.color} />
          <span className={AL.identifier}>{shortId(planRef)}</span>
          <span className={`min-w-0 flex-1 truncate ${AL.title}`}>{pipeline.title}</span>
          {!compact && subtitle ? (
            <span className={`hidden min-w-0 max-w-[35%] truncate ${AL.subtitle} xl:inline`}>
              {subtitle}
            </span>
          ) : null}
          <RowMeta duration={fmtDuration(pipeline.durationMs)} time={fmtTime(pipeline.startedAt)} />
        </button>
        {canCancel && (
          <button
            type="button"
            title="Stop run"
            disabled={cancelling}
            onClick={() => onCancel!(pipeline)}
            className="flex w-9 shrink-0 items-center justify-center text-text-faint transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
          >
            {cancelling ? <Loader2 size={14} className="animate-spin" /> : <Square size={12} />}
          </button>
        )}
      </div>

      {expanded && (
        <div className={`pb-1 ${AL.nest}`}>
          {pipeline.error && (
            <div className={`${AL.panel} text-error`}>{pipeline.error}</div>
          )}
          {pipeline.activities.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-text-muted">No steps recorded.</p>
          )}
          {pipeline.activities.map((activity) => {
            const key = pipelineActivityKey(pipeline.id, activity.id)
            return (
              <StepItem
                key={key}
                activity={activity}
                pipelineKind={pipeline.kind}
                pipelineId={pipeline.id}
                pipelineStatus={pipeline.status}
                pipelineError={pipeline.error}
                depth={0}
                expanded={actExpanded.has(key)}
                onToggle={() => toggleActivity(key)}
                actExpanded={actExpanded}
                toggleActivity={toggleActivity}
              />
            )
          })}
        </div>
      )}
    </article>
  )
}
