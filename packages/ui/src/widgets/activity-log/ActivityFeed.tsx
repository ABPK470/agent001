import { useMemo } from "react"
import type { OperationPipeline } from "../../api"
import { dayLabel } from "../../lib/operation-presentation"
import { ActivityLogToolbar, DayGroup } from "./ActivityLogToolbar"
import { IssueList } from "./IssueList"

export function ActivityFeed({
  pipelines,
  selectedId,
  onSelect,
  compact,
  collapsedDays,
  toggleDay,
  onCancelPipeline,
  cancellingId,
}: {
  pipelines: OperationPipeline[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  compact: boolean
  collapsedDays: Set<string>
  toggleDay: (label: string) => void
  onCancelPipeline?: (pipeline: OperationPipeline) => void
  cancellingId?: string | null
}) {
  const byDay = useMemo(() => {
    const groups: Array<{ label: string; items: OperationPipeline[] }> = []
    let cur: { label: string; items: OperationPipeline[] } | null = null
    for (const p of pipelines) {
      const label = dayLabel(p.startedAt)
      if (!cur || cur.label !== label) {
        cur = { label, items: [] }
        groups.push(cur)
      }
      cur.items.push(p)
    }
    return groups
  }, [pipelines])

  return (
    <>
      {byDay.map((group) => (
        <DayGroup
          key={group.label}
          label={group.label}
          count={group.items.length}
          collapsed={collapsedDays.has(group.label)}
          onToggle={() => toggleDay(group.label)}
        >
          <IssueList
            pipelines={group.items}
            selectedId={selectedId}
            onSelect={(id) => onSelect(selectedId === id ? null : id)}
            compact={compact}
            onCancel={onCancelPipeline}
            cancellingId={cancellingId}
          />
        </DayGroup>
      ))}
    </>
  )
}

// re-export toolbar for ActivityLog shell
export { ActivityLogToolbar }
