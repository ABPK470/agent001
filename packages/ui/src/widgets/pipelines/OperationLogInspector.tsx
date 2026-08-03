import { Loader2, Square } from "lucide-react"
import type { OperationPipeline } from "../../client/index"
import { OperationKind, OperationStatus } from "../../client/index"
import {
  ReviewDetailErrorCallout,
  ReviewDetailHeadline,
  ReviewDetailPane,
} from "../../components/review"
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
      <ReviewDetailPane
        empty
        emptyMessage="Select a pipeline run to inspect"
      />
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
    <ReviewDetailPane
      header={
        <ReviewDetailHeadline
          primary={
            <div className="flex min-w-0 items-center gap-2">
              <h2 className={`min-w-0 flex-1 truncate ${OP_LOG} font-semibold text-text`}>
                {pipeline.title}
              </h2>
              <OpLogStatusPill status={pipeline.status} />
            </div>
          }
          secondary={
            <>
              {subtitle ? (
                <p className={`${OP_LOG_MUTED} truncate text-sm`}>{subtitle}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 review-meta text-text-muted">
                <span>{fmtDuration(pipeline.durationMs)}</span>
                <span>{fmtTime(pipeline.startedAt)}</span>
                <span>
                  {pipeline.activityCount} act · {pipeline.eventCount} ev
                </span>
              </div>
            </>
          }
          actions={
            canCancel ? (
              <button
                type="button"
                title="Stop"
                disabled={cancelling}
                onClick={() => onCancel!(pipeline)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-subtle text-text-muted transition-colors hover:border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-40"
              >
                {cancelling ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Square size={12} />
                )}
              </button>
            ) : null
          }
          error={
            showError && pipeline.error ? (
              <ReviewDetailErrorCallout message={pipeline.error} />
            ) : undefined
          }
        />
      }
      sectionCap="Detail"
    >
      <OperationLogScopeDetail
        pipeline={pipeline}
        selection={selection}
        keyOf={keyOf}
      />
    </ReviewDetailPane>
  )
}
