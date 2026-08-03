/**
 * Inline run detail accordion for Active Users — compact panel under the selected row.
 */

import { Check, Copy, ExternalLink } from "lucide-react"
import type { JSX, MouseEvent, ReactNode } from "react"
import { useEffect, useRef, useState } from "react"

import { api } from "../client/index"
import { useStore } from "../state/store"
import { useLayoutStore } from "../state/layout-store"
import type { RunDetail } from "../types"
import { fmtTokens } from "../lib/util"

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

function MetaField({
  label,
  value,
  mono,
  copy,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  copy?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="au-run-accordion__field">
      <span className="au-run-accordion__field-label">{label}</span>
      <span className={`au-run-accordion__field-value${mono ? " au-run-accordion__field-value--mono" : ""}`}>
        {value ?? "—"}
        {copy ? (
          <button
            type="button"
            className="au-run-accordion__field-copy"
            title={`Copy ${label.toLowerCase()}`}
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(copy).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }).catch((err: unknown) => { console.error("[mia]", err) })
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        ) : null}
      </span>
    </div>
  )
}

export function ActiveUsersRunAccordionPanel({
  runId,
  preview,
}: {
  runId: string
  preview?: RunPreview
}): JSX.Element {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [jsonCopied, setJsonCopied] = useState(false)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const openModalWidget = useStore((s) => s.openModalWidget)

  const actionRef = useRef({
    runId,
    run: null as RunDetail | null,
    preview: preview as RunPreview | undefined,
    setActiveRun,
    openModalWidget,
  })
  actionRef.current = {
    runId,
    run,
    preview,
    setActiveRun,
    openModalWidget,
  }

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

  function openRunStatus(e: MouseEvent) {
    e.stopPropagation()
    const ctx = actionRef.current
    ctx.setActiveRun(ctx.runId)
    const { views, activeViewId } = useLayoutStore.getState()
    const view = views.find((v) => v.id === activeViewId)
    const hasRunStatus = view?.tiles.some((tile) => tile.type === "run-status")
    if (!hasRunStatus) ctx.openModalWidget("run-status", ctx.runId)
  }

  function copyJson(e: MouseEvent) {
    e.stopPropagation()
    const ctx = actionRef.current
    const payload = {
      runId: ctx.runId,
      ...(ctx.run ?? {}),
      ...(ctx.preview ?? {}),
    }
    void navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setJsonCopied(true)
      setTimeout(() => setJsonCopied(false), 1400)
    }).catch((err: unknown) => { console.error("[mia]", err) })
  }

  const goal = run?.goal ?? preview?.goal
  const model = run?.model ?? preview?.model
  const errText = run?.error ?? preview?.error
  const answer = run?.answer
  const ownerUpn = run?.upn
  const ownerName = run?.displayName
  const threadId = run?.threadId

  return (
    <div
      className="au-run-accordion"
      role="region"
      aria-label="Run details"
      onClick={(e) => e.stopPropagation()}
    >
      {loading && !run && !error && (
        <p className="au-run-accordion__hint">Loading run details…</p>
      )}
      {error && (
        <p className="mia-callout mia-callout--err px-3 py-2 text-sm">Failed to load run: {error}</p>
      )}

      <div className="au-run-accordion__meta">
        <MetaField label="Run ID" value={runId} mono copy={runId} />
        {threadId != null && <MetaField label="Thread" value={threadId} mono copy={threadId} />}
        {ownerUpn != null && <MetaField label="Owner UPN" value={ownerUpn} mono />}
        {ownerName != null && <MetaField label="Owner" value={ownerName} />}
        <MetaField label="Model" value={model ?? "—"} mono />
        <MetaField label="Started" value={formatAbsolute(run?.createdAt ?? preview?.createdAt)} />
        <MetaField label="Completed" value={formatAbsolute(run?.completedAt ?? preview?.completedAt)} />
        {run != null && (
          <>
            <MetaField label="Prompt tokens" value={fmtTokens(run.promptTokens)} />
            <MetaField label="Completion tokens" value={fmtTokens(run.completionTokens)} />
            {run.pendingWorkspaceChanges != null && run.pendingWorkspaceChanges > 0 && (
              <MetaField label="Pending changes" value={String(run.pendingWorkspaceChanges)} />
            )}
            {run.hasCheckpoint != null && (
              <MetaField label="Checkpoint" value={run.hasCheckpoint ? "yes" : "no"} />
            )}
            {run.rollbackAvailable != null && (
              <MetaField
                label="Rollback"
                value={run.rollbackAvailable ? "effects pending" : "nothing to roll back"}
              />
            )}
          </>
        )}
        {run?.audit?.length ? (
          <MetaField label="Audit" value={`${run.audit.length} entries`} />
        ) : null}
      </div>

      {goal && (
        <div className="au-run-accordion__block">
          <span className="au-run-accordion__block-label">Goal</span>
          <p className="au-run-accordion__prose">{goal}</p>
        </div>
      )}

      {answer && (
        <div className="au-run-accordion__block">
          <span className="au-run-accordion__block-label">Answer</span>
          <p className="au-run-accordion__prose au-run-accordion__prose--muted">{answer}</p>
        </div>
      )}

      {errText && (
        <div className="au-run-accordion__block">
          <span className="au-run-accordion__block-label">Error</span>
          <p className="mia-callout mia-callout--err px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {errText}
          </p>
        </div>
      )}

      <div className="au-run-accordion__actions">
        <button type="button" className="au-run-accordion__action" onClick={copyJson}>
          {jsonCopied ? <Check size={12} /> : <Copy size={12} />}
          {jsonCopied ? "Copied" : "Copy JSON"}
        </button>
        <button type="button" className="au-run-accordion__action au-run-accordion__action--primary" onClick={openRunStatus}>
          Open in Run Status
          <ExternalLink size={12} aria-hidden />
        </button>
      </div>
    </div>
  )
}
