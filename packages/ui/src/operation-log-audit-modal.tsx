import { Loader2, X } from "lucide-react"
import { createPortal } from "react-dom"
import { useCallback, useEffect, useState, type ComponentType } from "react"
import { api, type OperationPipeline } from "./api"
import type { OperationLogFocus } from "./store"

type PipelineListProps = {
  pipelines: OperationPipeline[]
  compact: boolean
  expanded: Set<string>
  togglePipeline: (id: string) => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  collapsedDays: Set<string>
  toggleDay: (label: string) => void
  onCancelPipeline?: (pipeline: OperationPipeline) => void
  cancellingId?: string | null
}

export function OperationAuditModal({
  focus,
  onClose,
}: {
  focus: OperationLogFocus
  onClose: () => void
}) {
  const [PipelineList, setPipelineList] = useState<ComponentType<PipelineListProps> | null>(null)
  const [pipelines, setPipelines] = useState<OperationPipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [actExpanded, setActExpanded] = useState<Set<string>>(new Set())
  const [evExpanded, setEvExpanded] = useState<Set<string>>(new Set())
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void import("./widgets/OperationLog").then((mod) => {
      if (!cancelled) setPipelineList(() => mod.OperationPipelineList)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const fetch =
      focus.kind === "plan"
        ? api.operationsForPlan(focus.id)
        : api.operationsForRun(focus.id)
    void fetch
      .then((res) => {
        if (cancelled) return
        setPipelines(res.operations)
        const pipeIds = new Set(res.operations.map((p) => p.id))
        const actKeys = new Set<string>()
        for (const pipeline of res.operations) {
          pipeIds.add(pipeline.id)
          const walk = (activities: typeof pipeline.activities) => {
            for (const activity of activities) {
              actKeys.add(`${pipeline.id}|${activity.id}`)
              if (activity.children?.length) walk(activity.children)
            }
          }
          walk(pipeline.activities)
        }
        setExpanded(pipeIds)
        setActExpanded(actKeys)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setPipelines([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [focus.id, focus.kind])

  const togglePipeline = useCallback((id: string) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const toggleActivity = useCallback((key: string) => {
    setActExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])
  const toggleEvent = useCallback((key: string) => {
    setEvExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])
  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((s) => {
      const n = new Set(s)
      if (n.has(label)) n.delete(label)
      else n.add(label)
      return n
    })
  }, [])

  const title =
    focus.label ??
    (focus.kind === "plan" ? `Sync plan ${focus.id}` : `Agent run ${focus.id}`)

  const List = PipelineList

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[min(90dvh,900px)] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle shrink-0">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-text-muted">Operation audit</div>
            <div className="text-sm text-text font-mono break-all">{title}</div>
          </div>
          <button
            type="button"
            className="text-text-muted hover:text-text"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-text-muted text-sm">
              <Loader2 size={16} className="animate-spin" />
              Loading audit…
            </div>
          )}
          {!loading && error && (
            <div className="text-error text-sm text-center py-12 break-all">{error}</div>
          )}
          {!loading && !error && pipelines.length === 0 && (
            <div className="text-text-muted text-sm text-center py-12">No operations found.</div>
          )}
          {!loading && !error && pipelines.length > 0 && List && (
            <List
              pipelines={pipelines}
              compact={false}
              expanded={expanded}
              togglePipeline={togglePipeline}
              actExpanded={actExpanded}
              toggleActivity={toggleActivity}
              evExpanded={evExpanded}
              toggleEvent={toggleEvent}
              collapsedDays={collapsedDays}
              toggleDay={toggleDay}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
