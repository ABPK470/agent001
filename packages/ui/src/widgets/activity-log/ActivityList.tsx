import { useMemo } from "react"
import type { OperationPipeline } from "../../api"
import { dayLabel } from "../../lib/operation-presentation"
import { DaySection } from "./ActivityLogToolbar"
import { OperationItem } from "./OperationItem"

export function ActivityList({
  pipelines,
  compact,
  expanded,
  togglePipeline,
  actExpanded,
  toggleActivity,
  collapsedDays,
  toggleDay,
  onCancelPipeline,
  cancellingId,
}: {
  pipelines: OperationPipeline[]
  compact: boolean
  expanded: Set<string>
  togglePipeline: (id: string) => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
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
    <div className="pb-2">
      {byDay.map((group) => (
        <DaySection
          key={group.label}
          label={group.label}
          count={group.items.length}
          collapsed={collapsedDays.has(group.label)}
          onToggle={() => toggleDay(group.label)}
        >
          {group.items.map((pipeline) => (
            <OperationItem
              key={pipeline.id}
              pipeline={pipeline}
              compact={compact}
              expanded={expanded.has(pipeline.id)}
              onToggle={() => togglePipeline(pipeline.id)}
              actExpanded={actExpanded}
              toggleActivity={toggleActivity}
              onCancel={onCancelPipeline}
              cancelling={cancellingId === pipeline.id}
            />
          ))}
        </DaySection>
      ))}
    </div>
  )
}
