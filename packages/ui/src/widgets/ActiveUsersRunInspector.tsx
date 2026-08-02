/**
 * Run inspector drawer for Active Users — slide-over detail, not a blocking modal.
 * Table stays visible; selection updates the panel in place.
 */

import { Activity, Check, Copy, ExternalLink, X } from "lucide-react"
import type { JSX, ReactNode, TransitionEvent } from "react"
import { useEffect, useRef, useState } from "react"

import { api } from "../client/index"
import { useStore } from "../state/store"
import { useLayoutStore } from "../state/layout-store"
import type { RunDetail } from "../types"
import { fmtTokens, statusColor } from "../lib/util"
import { ModalBtnPrimary } from "./sync-admin/chrome"

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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return target.isContentEditable
}

function CopyIconBtn({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="au-run-inspector__copy"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }).catch((err: unknown) => { console.error("[mia]", err) })
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

function PropRow({
  label,
  value,
  mono,
  copy,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  copy?: { text: string; label: string }
}): JSX.Element {
  return (
    <div className="au-run-inspector__prop">
      <span className="au-run-inspector__prop-key">{label}</span>
      <span className={`au-run-inspector__prop-val${mono ? " au-run-inspector__prop-val--mono" : ""}`}>
        <span className="au-run-inspector__prop-text">{value ?? "—"}</span>
        {copy ? <CopyIconBtn value={copy.text} label={copy.label} /> : null}
      </span>
    </div>
  )
}

export function ActiveUsersRunInspector({
  runId,
  preview,
  open,
  onClose,
  onExited,
}: {
  runId: string
  preview?: RunPreview
  open: boolean
  onClose: () => void
  onExited: () => void
}): JSX.Element {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [jsonCopied, setJsonCopied] = useState(false)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const openModalWidget = useStore((s) => s.openModalWidget)
  const exitedRef = useRef(false)
  const hasOpenedRef = useRef(false)

  const actionRef = useRef({
    runId,
    run: null as RunDetail | null,
    preview: preview as RunPreview | undefined,
    open,
    onClose,
    onExited,
    setActiveRun,
    openModalWidget,
  })
  actionRef.current = {
    runId,
    run,
    preview,
    open,
    onClose,
    onExited,
    setActiveRun,
    openModalWidget,
  }

  useEffect(() => {
    if (!open) return
    exitedRef.current = false
    hasOpenedRef.current = true
  }, [open])

  function finishExit() {
    if (actionRef.current.open || exitedRef.current || !hasOpenedRef.current) return
    exitedRef.current = true
    actionRef.current.onExited()
  }

  function onPanelTransitionEnd(e: TransitionEvent<HTMLElement>) {
    if (e.target !== e.currentTarget) return
    if (actionRef.current.open) return
    if (e.propertyName !== "transform") return
    finishExit()
  }

  // Safety if transitionend is skipped (reduced motion / interrupted).
  useEffect(() => {
    if (open || !hasOpenedRef.current) return
    const timer = window.setTimeout(finishExit, 420)
    return () => window.clearTimeout(timer)
  }, [open])

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

  function openRunStatus() {
    const ctx = actionRef.current
    ctx.setActiveRun(ctx.runId)
    const { views, activeViewId } = useLayoutStore.getState()
    const view = views.find((v) => v.id === activeViewId)
    const hasRunStatus = view?.tiles.some((tile) => tile.type === "run-status")
    if (!hasRunStatus) ctx.openModalWidget("run-status", ctx.runId)
    ctx.onClose()
  }

  function copyRunId() {
    void navigator.clipboard.writeText(actionRef.current.runId).catch((err: unknown) => {
      console.error("[mia]", err)
    })
  }

  function copyJson() {
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

  function onKeyDown(e: KeyboardEvent) {
    if (!actionRef.current.open) return
    if (isTypingTarget(e.target)) return
    if (e.key === "Escape") {
      e.preventDefault()
      actionRef.current.onClose()
      return
    }
    if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      copyRunId()
      return
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      openRunStatus()
    }
  }

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const status = run?.status ?? preview?.status ?? "—"
  const goal = run?.goal ?? preview?.goal ?? "—"
  const stepCount = run?.stepCount ?? preview?.stepCount
  const totalTokens = run?.totalTokens ?? preview?.totalTokens
  const llmCalls = run?.llmCalls ?? preview?.llmCalls
  const model = preview?.model
  const errText = run?.error ?? preview?.error
  const answer = run?.answer
  const duration = runDuration(run, preview)
  const ownerUpn = run?.upn
  const ownerName = run?.displayName
  const threadId = run?.threadId
  const modKey = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl"

  return (
    <aside
      className="au-run-inspector"
      data-open={open ? "true" : "false"}
      role="dialog"
      aria-label="Run details"
      aria-hidden={!open}
      onTransitionEnd={onPanelTransitionEnd}
    >
      {/* Fixed-width shell — outer panel clips/animates width so content doesn't reflow. */}
      <div className="au-run-inspector__shell">
        <header className="au-run-inspector__header">
          <div className="au-run-inspector__title">
            <span
              className="au-run-inspector__status-dot"
              style={{ backgroundColor: statusColor(status) }}
              aria-hidden
            />
            <Activity size={15} className="text-text-muted shrink-0" aria-hidden />
            <h3>Run details</h3>
            <span className="au-run-inspector__status-label">{status}</span>
          </div>
          <div className="au-run-inspector__header-actions">
            <button
              type="button"
              className="au-run-inspector__icon-btn"
              title={`Open in Run Status (${modKey}+Enter)`}
              aria-label="Open in Run Status"
              onClick={openRunStatus}
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className="au-run-inspector__icon-btn"
              title="Close (Esc)"
              aria-label="Close run details"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="au-run-inspector__body">
          {loading && !run && !error && (
            <p className="text-sm text-text-muted px-1">Loading run details…</p>
          )}
          {error && (
            <p className="mia-callout mia-callout--err px-3 py-2 text-sm">Failed to load run: {error}</p>
          )}

          <div className="au-run-inspector__metrics">
            <div className="au-run-inspector__metric">
              <span className="au-run-inspector__metric-label">Duration</span>
              <span className="au-run-inspector__metric-value">{duration}</span>
            </div>
            <div className="au-run-inspector__metric">
              <span className="au-run-inspector__metric-label">Steps</span>
              <span className="au-run-inspector__metric-value">
                {stepCount != null ? String(stepCount) : "—"}
              </span>
            </div>
            <div className="au-run-inspector__metric">
              <span className="au-run-inspector__metric-label">Tokens</span>
              <span className="au-run-inspector__metric-value">
                {totalTokens != null ? fmtTokens(totalTokens) : "—"}
              </span>
            </div>
            <div className="au-run-inspector__metric">
              <span className="au-run-inspector__metric-label">LLM calls</span>
              <span className="au-run-inspector__metric-value">
                {llmCalls != null ? String(llmCalls) : "—"}
              </span>
            </div>
          </div>

          <section className="au-run-inspector__section">
            <h4 className="au-run-inspector__section-title">Goal</h4>
            <p className="au-run-inspector__goal">{goal}</p>
          </section>

          <section className="au-run-inspector__section">
            <h4 className="au-run-inspector__section-title">Metadata</h4>
            <div className="au-run-inspector__props">
              <PropRow label="Run ID" value={runId} mono copy={{ text: runId, label: "run ID" }} />
              {threadId != null && (
                <PropRow
                  label="Thread"
                  value={threadId}
                  mono
                  copy={{ text: threadId, label: "thread ID" }}
                />
              )}
              {ownerUpn != null && <PropRow label="Owner UPN" value={ownerUpn} mono />}
              {ownerName != null && <PropRow label="Owner" value={ownerName} />}
              <PropRow label="Model" value={model ?? "—"} mono />
              <PropRow label="Started" value={formatAbsolute(run?.createdAt ?? preview?.createdAt)} />
              <PropRow label="Completed" value={formatAbsolute(run?.completedAt ?? preview?.completedAt)} />
              {run != null && (
                <>
                  <PropRow label="Prompt tokens" value={fmtTokens(run.promptTokens)} />
                  <PropRow label="Completion tokens" value={fmtTokens(run.completionTokens)} />
                  {run.pendingWorkspaceChanges != null && run.pendingWorkspaceChanges > 0 && (
                    <PropRow label="Pending changes" value={String(run.pendingWorkspaceChanges)} />
                  )}
                  {run.hasCheckpoint != null && (
                    <PropRow label="Checkpoint" value={run.hasCheckpoint ? "yes" : "no"} />
                  )}
                  {run.rollbackAvailable != null && (
                    <PropRow
                      label="Rollback"
                      value={run.rollbackAvailable ? "effects pending" : "nothing to roll back"}
                    />
                  )}
                </>
              )}
            </div>
          </section>

          {answer && (
            <section className="au-run-inspector__section">
              <h4 className="au-run-inspector__section-title">Answer</h4>
              <p className="au-run-inspector__prose au-run-inspector__prose--muted">{answer}</p>
            </section>
          )}

          {errText && (
            <section className="au-run-inspector__section">
              <h4 className="au-run-inspector__section-title">Error</h4>
              <p className="mia-callout mia-callout--err px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
                {errText}
              </p>
            </section>
          )}

          {run?.audit?.length ? (
            <section className="au-run-inspector__section">
              <h4 className="au-run-inspector__section-title">Audit</h4>
              <p className="text-sm text-text-muted">{run.audit.length} audit entries</p>
            </section>
          ) : null}
        </div>

        <footer className="au-run-inspector__footer">
          <button
            type="button"
            className="au-run-inspector__secondary"
            onClick={copyJson}
            title="Copy run JSON"
          >
            {jsonCopied ? <Check size={13} /> : <Copy size={13} />}
            {jsonCopied ? "Copied" : "Copy JSON"}
          </button>
          <ModalBtnPrimary className="au-run-inspector__primary" onClick={openRunStatus}>
            Open in Run Status
            <ExternalLink size={13} aria-hidden />
          </ModalBtnPrimary>
        </footer>
      </div>
    </aside>
  )
}
