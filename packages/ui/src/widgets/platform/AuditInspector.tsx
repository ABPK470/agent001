/**
 * Audit inspector — transform-only slide-over (Active Users dialect).
 * List stays put; selection updates the panel in place.
 */

import { Check, ChevronDown, ChevronRight, Copy, Scale, X } from "lucide-react"
import type { JSX, ReactNode, TransitionEvent } from "react"
import { useEffect, useRef, useState } from "react"
import type { AdminAuditItem } from "../../client/index"
import { JsonViewer } from "../../components/JsonViewer"
import {
  actionVerbClass,
  actionVerbKind,
  auditChangeHints,
  auditTarget,
  formatAuditScope,
  formatAuditWhen,
} from "./audit-log-view"

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
      className="audit-inspector__copy"
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
    <div className="audit-inspector__prop">
      <span className="audit-inspector__prop-key">{label}</span>
      <span className={`audit-inspector__prop-val${mono ? " audit-inspector__prop-val--mono" : ""}`}>
        <span className="audit-inspector__prop-text">{value ?? "—"}</span>
        {copy ? <CopyIconBtn value={copy.text} label={copy.label} /> : null}
      </span>
    </div>
  )
}

export function AuditInspector({
  entry,
  open,
  onClose,
  onExited,
}: {
  entry: AdminAuditItem
  open: boolean
  onClose: () => void
  onExited: () => void
}): JSX.Element {
  const [rawOpen, setRawOpen] = useState(false)
  const exitedRef = useRef(false)
  const hasOpenedRef = useRef(false)
  const actionRef = useRef({ open, onClose, onExited })
  actionRef.current = { open, onClose, onExited }

  useEffect(() => {
    if (!open) return
    exitedRef.current = false
    hasOpenedRef.current = true
  }, [open])

  useEffect(() => {
    setRawOpen(false)
  }, [entry.id])

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

  useEffect(() => {
    if (open || !hasOpenedRef.current) return
    const timer = window.setTimeout(finishExit, 420)
    return () => window.clearTimeout(timer)
  }, [open])

  function onKeyDown(e: KeyboardEvent) {
    if (!actionRef.current.open) return
    if (isTypingTarget(e.target)) return
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      actionRef.current.onClose()
    }
  }

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  const kind = actionVerbKind(entry.action)
  const verbClass = actionVerbClass(kind)
  const target = auditTarget(entry)
  const changes = auditChangeHints(entry.detail)
  const hasDetail = Object.keys(entry.detail).length > 0

  return (
    <aside
      className="audit-inspector"
      data-open={open ? "true" : "false"}
      role="dialog"
      aria-label="Audit entry details"
      aria-hidden={!open}
      onTransitionEnd={onPanelTransitionEnd}
    >
      <div className="audit-inspector__shell">
        <header className="audit-inspector__header">
          <div className="audit-inspector__title">
            <Scale size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <h3 className={`truncate font-mono text-[13px] font-semibold ${verbClass}`}>
                {entry.action}
              </h3>
              <p className="truncate text-[11px] text-text-muted">
                {formatAuditWhen(entry.timestamp)}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="audit-inspector__icon-btn"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </header>

        <div className="audit-inspector__body show-scrollbar">
          <section>
            <h4 className="audit-inspector__section-title">Metadata</h4>
            <div className="audit-inspector__props">
              <PropRow
                label="Actor"
                value={entry.user ?? "—"}
                copy={entry.user ? { text: entry.user, label: "actor" } : undefined}
              />
              <PropRow label="Scope" value={formatAuditScope(entry)} mono />
              <PropRow
                label="Target"
                value={target}
                mono
                copy={target !== "—" ? { text: target, label: "target" } : undefined}
              />
              {entry.runId ? (
                <PropRow
                  label="Run"
                  value={entry.runId}
                  mono
                  copy={{ text: entry.runId, label: "run id" }}
                />
              ) : null}
              {entry.threadId ? (
                <PropRow
                  label="Thread"
                  value={entry.threadTitle ? `${entry.threadTitle}` : entry.threadId}
                  mono
                  copy={{ text: entry.threadId, label: "thread id" }}
                />
              ) : null}
              {entry.run?.goal ? (
                <PropRow label="Goal" value={entry.run.goal} />
              ) : null}
            </div>
          </section>

          {changes.length > 0 ? (
            <section>
              <h4 className="audit-inspector__section-title">Changes</h4>
              <div className="audit-inspector__props">
                {changes.map((hint) => (
                  <PropRow key={`${hint.label}:${hint.value}`} label={hint.label} value={hint.value} mono />
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-text-faint">
                Snapshot from the audit detail blob — before/after diffs are not stored yet.
              </p>
            </section>
          ) : null}

          {hasDetail ? (
            <section>
              <button
                type="button"
                className="audit-inspector__raw-toggle"
                onClick={() => setRawOpen((v) => !v)}
                aria-expanded={rawOpen}
              >
                {rawOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Raw JSON payload
              </button>
              {rawOpen ? (
                <div className="mt-2 min-w-0">
                  <JsonViewer value={entry.detail} embedded defaultExpandDepth={2} maxHeight={320} />
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
