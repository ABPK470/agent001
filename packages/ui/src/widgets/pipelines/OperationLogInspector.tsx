import { Loader2, Square } from "lucide-react"
import type { OperationPipeline } from "../../client/index"
import { OperationKind, OperationStatus } from "../../client/index"
import { OpLogStatusPill } from "./OpLogStatusPill"
import {
  OperationLogScopeDetail,
  type OpLogSelection,
} from "./OperationLogScopeDetail"
import {
  OP_LOG,
  OP_LOG_MUTED,
  fmtDuration,
  fmtTime,
  formatPipelineSubtitle,
} from "./operation-log-row"

export function OperationLogInspector({
  pipeline,
  selection,
  keyOf,
  onCancel,
  cancelling,
}: {
  pipeline: OperationPipeline | null
  selection: OpLogSelection | null
  keyOf: (pipelineId: string, activityId: string, parentKey?: string) => string
  onCancel?: (pipeline: OperationPipeline) => void
  cancelling?: boolean
}) {
  if (!pipeline) {
    return (
      <div className="op-log-detail op-log-detail--empty flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <p className="text-sm text-text-muted">Select a pipeline run to inspect</p>
      </div>
    )
  }

  const subtitle = pipeline.subtitle ? formatPipelineSubtitle(pipeline.subtitle) : null
  const showError =
    selection?.kind === "pipeline" &&
    pipeline.error &&
    pipeline.status === OperationStatus.Failed
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    pipeline.kind !== OperationKind.System

  return (
    <div className="op-log-detail flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="op-log-detail__header shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className={`min-w-0 flex-1 truncate ${OP_LOG} font-semibold text-text`}>
                {pipeline.title}
              </h2>
              <OpLogStatusPill status={pipeline.status} />
            </div>
            {subtitle ? (
              <p className={`${OP_LOG_MUTED} mt-0.5 truncate text-sm`}>{subtitle}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canCancel ? (
              <button
                type="button"
                title="Stop"
                disabled={cancelling}
                onClick={() => onCancel!(pipeline)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-subtle text-text-muted transition-colors hover:border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-40"
              >
                {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}
              </button>
            ) : null}
          </div>
        </div>
        {showError && pipeline.error ? (
          <div className="op-log-detail__error-callout mt-3" title={pipeline.error}>
            <span className="op-log-detail__error-label">Error</span>
            <span className="op-log-detail__error-text">{pipeline.error}</span>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 review-meta text-text-muted">
          <span>{fmtDuration(pipeline.durationMs)}</span>
          <span>{fmtTime(pipeline.startedAt)}</span>
          <span>
            {pipeline.activityCount} act · {pipeline.eventCount} ev
          </span>
        </div>
      </div>
      <div className="op-log-detail__scroll min-h-0 flex-1 overflow-y-auto">
        <div className="op-log-detail__section-cap">Detail</div>
        <OperationLogScopeDetail
          pipeline={pipeline}
          selection={selection}
          keyOf={keyOf}
        />
      </div>
    </div>
  )
}
