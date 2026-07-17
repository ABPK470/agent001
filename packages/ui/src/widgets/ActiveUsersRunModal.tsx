/**
 * Run detail modal for Active Users — same shell as entity-registry / sync-admin.
 */

import { Activity } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"

import { api } from "../client/index"
import { useStore } from "../state/store"
import type { RunDetail } from "../types"
import { fmtTokens, statusColor } from "../lib/util"
import { DetailField, DetailGrid, DetailSection } from "./entity-registry/DetailField"
import { ModalShell } from "./entity-registry/ModalShell"
import { ModalBtnPrimary, ModalBtnSecondary } from "./sync-admin/chrome"
import { AdminModalCanvas, AdminModalRoot } from "./sync-admin/modal-layout"

export interface RunPreview {
  goal?: string
  status?: string
  model?: string | null
  stepCount?: number
  totalTokens?: number | null
  llmCalls?: number | null
  error?: string | null
  createdAt?: string
  completedAt?: string | null
  durationMs?: number | null
}

function parseUtc(iso: string | null | undefined): number {
  if (!iso) return NaN
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) return Date.parse(iso)
  const normalised = iso.includes("T") ? iso : iso.replace(" ", "T")
  return Date.parse(normalised + "Z")
}

function formatAbsolute(iso: string | null | undefined): string {
  const t = parseUtc(iso)
  if (!Number.isFinite(t)) return "—"
  return new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function runDuration(run: RunDetail | null, preview?: RunPreview): string {
  if (preview?.durationMs != null) return formatDuration(preview.durationMs)
  if (!run?.createdAt) return "—"
  const start = parseUtc(run.createdAt)
  const end = run.completedAt ? parseUtc(run.completedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—"
  return formatDuration(Math.max(0, end - start))
}

export function ActiveUsersRunModal({
  runId,
  preview,
  onClose,
}: {
  runId: string
  preview?: RunPreview
  onClose: () => void
}): JSX.Element {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const openModalWidget = useStore((s) => s.openModalWidget)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.getRun(runId)
      .then((detail) => {
        if (cancelled) return
        setRun(detail)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [runId])

  const status = run?.status ?? preview?.status ?? "—"
  const goal = run?.goal ?? preview?.goal ?? "—"
  const stepCount = run?.stepCount ?? preview?.stepCount
  const totalTokens = run?.totalTokens ?? preview?.totalTokens
  const llmCalls = run?.llmCalls ?? preview?.llmCalls
  const model = preview?.model
  const errText = run?.error ?? preview?.error
  const answer = run?.answer

  const openRunStatus = () => {
    setActiveRun(runId)
    const { views, activeViewId } = useStore.getState()
    const view = views.find((v) => v.id === activeViewId)
    const hasRunStatus = view?.widgets.some((w) => w.type === "run-status")
    if (!hasRunStatus) openModalWidget("run-status", runId)
    onClose()
  }

  return (
    <ModalShell
      title="Run"
      subtitle={runId}
      icon={<Activity size={20} className="text-text-muted" />}
      size="detail"
      onClose={onClose}
      footer={(
        <>
          <ModalBtnSecondary onClick={onClose}>Close</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary onClick={openRunStatus}>Open in Run Status</ModalBtnPrimary>
          </div>
        </>
      )}
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <div className="entity-registry modal-detail-body space-y-5">
            {loading && !run && !error && (
              <p className="text-sm text-text-muted">Loading run details…</p>
            )}
            {error && (
              <p className="text-sm text-error">Failed to load run: {error}</p>
            )}

            <DetailSection title="Overview">
              <DetailGrid>
                <DetailField label="Run ID" value={runId} mono span={2} />
                <DetailField
                  label="Status"
                  value={(
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: statusColor(status) }}
                      />
                      {status}
                    </span>
                  )}
                />
                <DetailField label="Model" value={model} mono />
                {run?.upn != null && <DetailField label="Owner UPN" value={run.upn} mono />}
                {run?.displayName != null && <DetailField label="Owner" value={run.displayName} />}
                {run?.agentId != null && <DetailField label="Agent" value={run.agentId} mono />}
                {run?.threadId != null && <DetailField label="Thread" value={run.threadId} mono span={2} />}
              </DetailGrid>
            </DetailSection>

            <DetailSection title="Goal">
              <p className="text-sm leading-relaxed text-text whitespace-pre-wrap break-words">{goal}</p>
            </DetailSection>

            <DetailSection title="Timing">
              <DetailGrid>
                <DetailField label="Started" value={formatAbsolute(run?.createdAt ?? preview?.createdAt)} />
                <DetailField label="Completed" value={formatAbsolute(run?.completedAt ?? preview?.completedAt)} />
                <DetailField label="Duration" value={runDuration(run, preview)} />
              </DetailGrid>
            </DetailSection>

            <DetailSection title="Usage">
              <DetailGrid>
                <DetailField label="Steps" value={stepCount != null ? String(stepCount) : undefined} />
                <DetailField label="LLM calls" value={llmCalls != null ? String(llmCalls) : undefined} />
                <DetailField
                  label="Tokens"
                  value={totalTokens != null ? fmtTokens(totalTokens) : undefined}
                />
                {run != null && (
                  <>
                    <DetailField label="Prompt tokens" value={fmtTokens(run.promptTokens)} />
                    <DetailField label="Completion tokens" value={fmtTokens(run.completionTokens)} />
                  </>
                )}
                {run?.pendingWorkspaceChanges != null && run.pendingWorkspaceChanges > 0 && (
                  <DetailField label="Pending workspace changes" value={String(run.pendingWorkspaceChanges)} />
                )}
                {run?.hasCheckpoint != null && (
                  <DetailField label="Checkpoint" value={run.hasCheckpoint ? "yes" : "no"} />
                )}
              </DetailGrid>
            </DetailSection>

            {answer && (
              <DetailSection title="Answer">
                <p className="text-sm leading-relaxed text-text-muted whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {answer}
                </p>
              </DetailSection>
            )}

            {errText && (
              <DetailSection title="Error">
                <p className="text-sm leading-relaxed text-error whitespace-pre-wrap break-words">{errText}</p>
              </DetailSection>
            )}

            {run?.audit?.length ? (
              <DetailSection title="Audit">
                <p className="text-sm text-text-muted">{run.audit.length} audit entries</p>
              </DetailSection>
            ) : null}
          </div>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}
