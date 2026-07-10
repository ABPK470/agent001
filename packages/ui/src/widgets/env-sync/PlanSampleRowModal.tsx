import { ModalShell } from "./chrome"
import { DIFF } from "./constants"
import {
  formatCellFull,
  sampleRowColumns,
  sampleRowDetailSubtitle,
  sampleRowDetailTitle,
  type SampleRowDetail,
} from "./plan-table-values"

export function PlanSampleRowModal({ detail, onClose }: {
  detail: SampleRowDetail
  onClose: () => void
}) {
  const { kind, sample } = detail
  const columns = sampleRowColumns(sample)
  const changed = new Set(sample.changedColumns ?? [])
  const valueColor = kind === "insert" ? DIFF.ins : kind === "delete" ? DIFF.del : undefined

  return (
    <ModalShell
      title={sampleRowDetailTitle(kind)}
      subtitle={sampleRowDetailSubtitle(detail)}
      size="workspace"
      onClose={onClose}
    >
      <div className="px-6 py-4 overflow-y-auto max-h-[min(70vh,42rem)] min-h-0">
        {kind === "update" ? (
          <table className="w-full text-sm font-mono border-separate border-spacing-0">
            <thead>
              <tr className="text-text-muted text-left">
                <th className="pb-2 pr-4 font-normal sticky top-0 bg-surface">Column</th>
                <th className="pb-2 pr-4 font-normal sticky top-0 bg-surface">Current (target)</th>
                <th className="pb-2 font-normal sticky top-0 bg-surface">After sync (source)</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => {
                const isChanged = changed.has(column)
                return (
                  <tr key={column} className="border-t border-border/30 align-top">
                    <td className="py-3 pr-4 text-text font-medium whitespace-nowrap">
                      {column}
                      {isChanged && (
                        <span className="ml-2 text-xs font-normal" style={{ color: DIFF.upd }}>changed</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 min-w-0">
                      <pre
                        className="whitespace-pre-wrap break-all text-text m-0"
                        style={{ color: isChanged ? DIFF.oldRow : undefined, opacity: isChanged ? 1 : 0.7 }}
                      >
                        {formatCellFull(sample.oldValues?.[column])}
                      </pre>
                    </td>
                    <td className="py-3 min-w-0">
                      <pre
                        className="whitespace-pre-wrap break-all text-text m-0"
                        style={{ color: isChanged ? DIFF.upd : undefined, opacity: isChanged ? 1 : 0.7 }}
                      >
                        {formatCellFull(sample.newValues?.[column])}
                      </pre>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm font-mono border-separate border-spacing-0">
            <thead>
              <tr className="text-text-muted text-left">
                <th className="pb-2 pr-4 font-normal sticky top-0 bg-surface">Column</th>
                <th className="pb-2 font-normal sticky top-0 bg-surface">
                  {kind === "insert" ? "Value to insert" : "Value to delete"}
                </th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column} className="border-t border-border/30 align-top">
                  <td className="py-3 pr-4 text-text font-medium whitespace-nowrap">{column}</td>
                  <td className="py-3 min-w-0">
                    <pre
                      className="whitespace-pre-wrap break-all text-text m-0"
                      style={{ color: valueColor }}
                    >
                      {formatCellFull(sample.values?.[column])}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </ModalShell>
  )
}
