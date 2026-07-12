import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, GitBranch, ListChecks, Loader2, XCircle } from "lucide-react"
import { useMemo, useState } from "react"

import type { SyncPlan, SyncPlanTable } from "../../types"
import { movementOfTable, tableMovementTotal } from "../../types"
import { timeAgo } from "../../util"
import { DIFF } from "./constants"
import { formatPlanEntityLabel } from "./workflow"
import { buildExecTableStatus } from "./exec-status"
import { PlanSampleRowModal } from "./PlanSampleRowModal"
import { formatCellPreview, type SampleRowDetail } from "./plan-table-values"
import type { ExecState } from "./types"

export function PlanView({ plan, expanded, setExpanded, exec }: {
  plan: SyncPlan
  expanded: Set<string>
  setExpanded: (s: Set<string>) => void
  exec: ExecState
}) {
  const totals = plan.totals
  const hasConflicts = (totals.conflicts ?? 0) > 0
  const expired = (Date.now() - plan.createdAtMs) > 3600_000
  const sorted = useMemo(() => [...plan.tables].sort((a, b) => net(b) - net(a)), [plan])

  const execStatus = useMemo(() => buildExecTableStatus(exec), [exec])

  const warnings = [...plan.preflight.issues, ...plan.warnings]
  const decisionLog = plan.decisionLog ?? []
  const flowSteps = plan.executionContract.flow.steps ?? []

  return (
    <>
      <div className="rounded-lg border border-border-subtle overflow-hidden shrink-0">
        <div className="px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-text truncate">
                {formatPlanEntityLabel(plan)}
              </h3>
              <div className="flex items-center gap-2 mt-1 text-sm text-text-muted">
                <span className="text-text-muted/60 font-mono text-xs">{plan.source} → {plan.target}</span>
                <span className="text-text-muted/30">·</span>
                <span className="flex items-center gap-1 text-text-muted/60">
                  <Clock size={11} />{timeAgo(new Date(plan.createdAtMs).toISOString())}
                </span>
                {expired && <span className="text-warning font-medium text-xs px-1.5 py-0.5 rounded bg-warning/10">expired</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-3 font-mono text-sm tabular-nums">
              {totals.insert > 0 && <span style={{ color: DIFF.ins }}><span className="text-lg font-semibold">{totals.insert}</span> <span className="text-xs">ins</span></span>}
              {totals.update > 0 && <span style={{ color: DIFF.upd }}><span className="text-lg font-semibold">{totals.update}</span> <span className="text-xs">upd</span></span>}
              {totals.delete > 0 && <span style={{ color: DIFF.del }}><span className="text-lg font-semibold">{totals.delete}</span> <span className="text-xs">del</span></span>}
              {hasConflicts && <span className="text-warning font-semibold">{totals.conflicts} conflict{totals.conflicts === 1 ? "" : "s"}</span>}
              {totals.unchanged > 0 && <span className="text-text-muted"><span className="text-lg font-semibold">{totals.unchanged}</span> <span className="text-xs">eq</span></span>}
            </div>
            <span className="text-text-muted/30">·</span>
            <span className="text-sm text-text-muted">{totals.tablesCount} tables w/ changes</span>
            {flowSteps.length > 0 && (
              <>
                <span className="text-text-muted/30">·</span>
                <span className="text-sm text-text-muted">{flowSteps.length} execute steps</span>
              </>
            )}
          </div>
        </div>
      </div>

      {(decisionLog.length > 0 || flowSteps.length > 0) && (
        <PlanInsights decisionLog={decisionLog} flowSteps={flowSteps} />
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-2.5 flex items-start gap-2 text-sm text-warning shrink-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div className="space-y-0.5 font-mono">
            {warnings.map((warning, index) => <div key={index}>{warning}</div>)}
          </div>
        </div>
      )}

      <div className="rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="flex-1 overflow-y-auto min-h-0">
          {sorted.map((row) => {
            const isOpen = expanded.has(row.table)
            const status = execStatus.get(row.table)
            return (
              <div key={row.table}>
                <button
                  onClick={() => {
                    const next = new Set(expanded)
                    isOpen ? next.delete(row.table) : next.add(row.table)
                    setExpanded(next)
                  }}
                  className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors"
                >
                  {isOpen ? <ChevronDown size={13} className="text-text-muted shrink-0" /> : <ChevronRight size={13} className="text-text-muted shrink-0" />}
                  <span className="text-sm font-mono text-text flex-1 truncate">{row.table}</span>
                  {status === "running" && <Loader2 size={13} className="animate-spin text-accent shrink-0" />}
                  {status === "done" && <CheckCircle2 size={13} className="shrink-0" style={{ color: DIFF.ins }} />}
                  {status === "failed" && <XCircle size={13} className="shrink-0" style={{ color: DIFF.del }} />}
                  {status === "cancelled" && <XCircle size={13} className="shrink-0 text-text-muted/50" title="Cancelled" />}
                  <Ct n={movementOfTable(row).insert} color={DIFF.ins} label="ins" />
                  <Ct n={movementOfTable(row).update} color={DIFF.upd} label="upd" />
                  <Ct n={movementOfTable(row).delete} color={DIFF.del} label="del" />
                  {row.conflicts.length > 0 && <Ct n={row.conflicts.length} color="var(--color-warning)" label="conflict" />}
                  <Ct n={row.stats.unchanged} color={DIFF.eqDim} label="eq" dim />
                </button>
                {isOpen && <Detail row={row} />}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

export function HistoryPlanTables({ plan }: { plan: SyncPlan }) {
  const sorted = [...plan.tables].sort((a, b) => net(b) - net(a))

  return (
    <div className="divide-y divide-border/30">
      {sorted.map((row) => (
        <div key={row.table} className="px-4 py-3 bg-base/20 space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-mono text-text flex-1 truncate">{row.table}</span>
            <Ct n={movementOfTable(row).insert} color={DIFF.ins} label="ins" />
            <Ct n={movementOfTable(row).update} color={DIFF.upd} label="upd" />
            <Ct n={movementOfTable(row).delete} color={DIFF.del} label="del" />
            {row.conflicts.length > 0 && <Ct n={row.conflicts.length} color="var(--color-warning)" label="conflict" />}
            <Ct n={row.stats.unchanged} color={DIFF.eqDim} label="eq" dim />
          </div>
          <Detail row={row} />
        </div>
      ))}
    </div>
  )
}

export function net(table: SyncPlanTable): number {
  return tableMovementTotal(table)
}

function PlanInsights({
  decisionLog,
  flowSteps,
}: {
  decisionLog: NonNullable<SyncPlan["decisionLog"]>
  flowSteps: SyncPlan["executionContract"]["flow"]["steps"]
}) {
  const [decisionsOpen, setDecisionsOpen] = useState(decisionLog.some((d) => d.severity !== "info"))
  const [flowOpen, setFlowOpen] = useState(false)

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden shrink-0 divide-y divide-border-subtle">
      {decisionLog.length > 0 && (
        <div>
          <button
            onClick={() => setDecisionsOpen((open) => !open)}
            className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-elevated/30 transition-colors text-left"
          >
            {decisionsOpen ? <ChevronDown size={13} className="text-text-muted shrink-0" /> : <ChevronRight size={13} className="text-text-muted shrink-0" />}
            <ListChecks size={14} className="text-text-muted/70 shrink-0" />
            <span className="text-sm font-medium text-text">Preview decisions</span>
            <span className="text-xs text-text-muted ml-1">({decisionLog.length})</span>
          </button>
          {decisionsOpen && (
            <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto">
              {decisionLog.map((decision) => (
                <div
                  key={decision.id}
                  className={`rounded border px-3 py-2 text-sm ${
                    decision.severity === "error"
                      ? "border-error/30 bg-error-soft/30"
                      : decision.severity === "warning"
                        ? "border-warning/30 bg-warning/5"
                        : "border-border-subtle bg-base/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-text-muted">{decision.category}</span>
                    <span className="font-medium text-text">{decision.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-muted leading-relaxed">{decision.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {flowSteps.length > 0 && (
        <div>
          <button
            onClick={() => setFlowOpen((open) => !open)}
            className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-elevated/30 transition-colors text-left"
          >
            {flowOpen ? <ChevronDown size={13} className="text-text-muted shrink-0" /> : <ChevronRight size={13} className="text-text-muted shrink-0" />}
            <GitBranch size={14} className="text-text-muted/70 shrink-0" />
            <span className="text-sm font-medium text-text">Execution flow</span>
            <span className="text-xs text-text-muted ml-1">({flowSteps.length} steps)</span>
          </button>
          {flowOpen && (
            <ol className="px-4 pb-3 space-y-1 max-h-48 overflow-y-auto list-none">
              {flowSteps.map((step, index) => (
                <li key={step.id} className="flex items-start gap-2 text-sm font-mono">
                  <span className="text-text-muted/40 tabular-nums w-5 shrink-0 text-right">{index + 1}.</span>
                  <div className="min-w-0">
                    <span className="text-text">{step.title || step.kind}</span>
                    {step.description && (
                      <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{step.description}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

function Ct({ n, color, label, dim }: { n: number; color: string; label: string; dim?: boolean }) {
  if (n <= 0) return null
  return (
    <span className="text-sm font-mono tabular-nums shrink-0" style={{ color, opacity: dim ? 0.4 : 1 }}>
      {n.toLocaleString()} <span className="opacity-60">{label}</span>
    </span>
  )
}

function Detail({ row }: { row: SyncPlanTable }) {
  return (
    <div className="px-4 py-3 bg-base/30 space-y-2 text-sm border-t border-border/30">
      <div className="flex items-center gap-2 text-text-muted font-mono">
        <span className="text-text-muted/50">scope</span>
        <span className="break-all">{row.scopePredicate}</span>
      </div>
      {row.warnings.length > 0 && row.warnings.map((warning, index) => (
        <div key={index} className="flex items-start gap-1.5 text-warning font-mono">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{warning}
        </div>
      ))}
      {(row.conflicts ?? []).length > 0 && (
        <div className="border border-warning/40 rounded overflow-hidden">
          <div className="px-3 py-1.5 bg-warning/5 border-b border-warning/20 flex justify-between items-center">
            <span className="text-warning font-medium">scope misattribution — blocks execute</span>
            <span className="font-mono tabular-nums text-text-muted">{row.conflicts.length.toLocaleString()} conflict(s)</span>
          </div>
          <div className="px-3 py-2 space-y-1.5 font-mono leading-relaxed text-text">
            {row.conflicts.slice(0, 10).map((conflict, index) => (
              <div key={index} className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <span className="break-all">{conflict.summary}</span>
              </div>
            ))}
            {row.conflicts.length > 10 && (
              <div className="text-text-muted">… and {row.conflicts.length - 10} more</div>
            )}
          </div>
        </div>
      )}
      {(["insert", "update", "delete"] as const).map((kind) => {
        const samples = row.samples[kind]
        if (!samples.length) return null
        const color = kind === "insert" ? DIFF.ins : kind === "update" ? DIFF.upd : DIFF.del
        const total = movementOfTable(row)[kind]
        return (
          <SampleSection key={kind} kind={kind} samples={samples} total={total} color={color} table={row.table} />
        )
      })}
      <div className="text-sm text-text-muted/40 text-right tabular-nums font-mono">{row.diffDurationMs}ms</div>
    </div>
  )
}

const INITIAL_ROWS = 5

function SampleSection({ kind, samples, total, color, table }: {
  kind: "insert" | "update" | "delete"
  samples: SyncPlanTable["samples"]["insert"]
  total: number
  color: string
  table: string
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? samples : samples.slice(0, INITIAL_ROWS)
  const canExpand = samples.length > INITIAL_ROWS

  return (
    <div className="border border-border/40 rounded overflow-hidden">
      <div className="px-3 py-1.5 bg-surface/40 border-b border-border/30 flex justify-between items-center">
        <span className="font-medium" style={{ color }}>{kind}</span>
        <div className="flex items-center gap-2">
          {canExpand && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-text-muted/50 hover:text-text transition-colors"
            >
              {showAll ? `show ${INITIAL_ROWS}` : `show all ${samples.length}`}
            </button>
          )}
          <span className="font-mono tabular-nums text-text-muted">{samples.length}/{total.toLocaleString()}</span>
        </div>
      </div>
      <div className="overflow-x-auto show-scrollbar">
        <SampleTbl kind={kind} samples={visible} table={table} />
      </div>
    </div>
  )
}

function SampleTbl({ kind, samples, table }: {
  kind: "insert" | "update" | "delete"
  samples: SyncPlanTable["samples"]["insert"]
  table: string
}) {
  const [detail, setDetail] = useState<SampleRowDetail | null>(null)
  const maxCols = 12
  const cols = useMemo(() => {
    const all: string[] = []
    const seen = new Set<string>()
    const add = (key: string) => { if (!seen.has(key)) { seen.add(key); all.push(key) } }
    for (const row of samples) {
      for (const key of Object.keys(row.values ?? {})) add(key)
      for (const key of Object.keys(row.newValues ?? {})) add(key)
      for (const key of Object.keys(row.oldValues ?? {})) add(key)
    }
    if (kind !== "update") return all.slice(0, maxCols)
    const changed = new Set<string>()
    for (const row of samples) for (const column of row.changedColumns ?? []) changed.add(column)
    if (changed.size === 0) return all.slice(0, maxCols)
    const changedFirst = all.filter((column) => changed.has(column))
    const rest = all.filter((column) => !changed.has(column))
    const head = changedFirst.slice(0, Math.max(maxCols, changedFirst.length))
    const tailBudget = Math.max(0, maxCols - head.length)
    return [...head, ...rest.slice(0, tailBudget)]
  }, [samples, kind])

  return (
    <>
      <table className="w-auto text-sm font-mono border-separate border-spacing-0">
        <thead>
          <tr className="text-text-muted">
            {cols.map((column) => (
              <th
                key={column}
                className="text-left px-2.5 py-1.5 font-normal whitespace-nowrap border-b border-border/30 bg-surface/30 sticky top-0"
              >{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {samples.map((sample, index) => {
            const openRow = () => setDetail({ table, kind, rowIndex: index, sample })
            if (kind === "update") {
              const changed = new Set(sample.changedColumns ?? [])
              return (
                <tr
                  key={index}
                  className="border-b border-border/20 cursor-pointer hover:bg-elevated/20 transition-colors"
                  onClick={openRow}
                  title="View full row"
                >
                  {cols.map((column) => (
                    <td key={column} className="px-2.5 py-1 align-top whitespace-nowrap border-b border-border/20">
                      {changed.has(column)
                        ? (
                          <>
                            <div className="line-through max-w-xs truncate" style={{ color: DIFF.oldRow }}>
                              {formatCellPreview(sample.oldValues?.[column])}
                            </div>
                            <div className="max-w-xs truncate" style={{ color: DIFF.upd, fontWeight: 500 }}>
                              {formatCellPreview(sample.newValues?.[column])}
                            </div>
                          </>
                        )
                        : (
                          <span className="text-text max-w-xs truncate block">
                            {formatCellPreview(sample.newValues?.[column])}
                          </span>
                        )}
                    </td>
                  ))}
                </tr>
              )
            }
            return (
              <tr
                key={index}
                className="cursor-pointer hover:bg-elevated/20 transition-colors"
                onClick={openRow}
                title="View full row"
              >
                {cols.map((column) => (
                  <td key={column} className="px-2.5 py-1 text-text whitespace-nowrap border-b border-border/20">
                    <span className="max-w-xs truncate block">
                      {formatCellPreview(sample.values?.[column])}
                    </span>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {detail && <PlanSampleRowModal detail={detail} onClose={() => setDetail(null)} />}
    </>
  )
}