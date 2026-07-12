import { Loader2, XCircle } from "lucide-react"

import { DIFF } from "./constants"
import type { EnvSyncPreviewProgress } from "./preview-progress"
import { previewTablesDone, previewTablesFailed } from "./preview-progress"

export function PreviewProgressPanel({ progress }: { progress: EnvSyncPreviewProgress }) {
  const tableNames = Object.keys(progress.tables).sort()
  const done = previewTablesDone(progress)
  const failed = previewTablesFailed(progress)
  const total = progress.tableTotal ?? tableNames.length
  const pct = total > 0 ? Math.min(100, ((done + failed) / total) * 100) : progress.status === "done" ? 100 : 0

  return (
    <div className="mx-4 my-4 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Preview progress
        </span>
        <span className="text-xs font-mono tabular-nums text-text-muted">
          {progress.status === "running" && total > 0 ? `${done + failed}/${total} tables` : progress.status}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </span>
      </div>
      <div className="exec-modal-progress__bar">
        <div
          className="exec-modal-progress__fill"
          style={{
            width: `${pct}%`,
            background: failed > 0 ? DIFF.del : progress.status === "done" ? DIFF.ins : "var(--accent)",
          }}
        />
      </div>
      {progress.message && (
        <p className="text-xs font-mono text-text truncate" title={progress.message}>
          {progress.status === "running" && <span className="text-accent/70">▸ </span>}
          {progress.message}
        </p>
      )}
      {tableNames.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm font-mono">
          {tableNames.map((tableName) => {
            const row = progress.tables[tableName]!
            const short = tableName.split(".").pop() ?? tableName
            return (
              <span key={tableName} className="flex items-center gap-1.5">
                {row.status === "running" && <Loader2 size={11} className="animate-spin text-accent shrink-0" />}
                {row.status === "done" && (
                  <span className="text-[10px] text-text-muted/60 shrink-0">
                    +{row.insert} ~{row.update} -{row.delete}
                  </span>
                )}
                {row.status === "failed" && <XCircle size={11} style={{ color: DIFF.del }} className="shrink-0" />}
                <span
                  className={row.status === "failed" ? "" : row.status === "done" ? "text-text-muted/70" : "text-text"}
                  style={row.status === "failed" ? { color: DIFF.del } : undefined}
                  title={row.error}
                >
                  {short}
                </span>
              </span>
            )
          })}
        </div>
      )}
      {progress.error && (
        <p className="text-xs leading-relaxed" style={{ color: DIFF.del }}>
          {progress.error}
        </p>
      )}
    </div>
  )
}
