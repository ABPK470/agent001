/**
 * Audit inspector — transform-only slide-over (Active Users dialect).
 * Forensic before/after via CatalogJsonDiff; version refs resolve only here (never from the table).
 */

import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  PanelLeftClose,
  PanelRightOpen,
  Scale,
  X,
} from "lucide-react"
import type { JSX, PointerEvent as ReactPointerEvent, ReactNode, TransitionEvent } from "react"
import { useEffect, useRef, useState } from "react"
import { api, type AdminAuditItem } from "../../client/index"
import { JsonViewer } from "../../components/JsonViewer"
import { CatalogJsonDiff } from "./CatalogJsonDiff"
import {
  actionVerbClass,
  actionVerbKind,
  auditChangeHints,
  auditDiffSides,
  auditTarget,
  auditValueStacks,
  formatAuditScope,
  formatAuditWhen,
  stringifyAuditJson,
  type AuditVersionRef,
} from "./audit-log-view"

type ResizeDrag = { startX: number; startW: number }

const REF_UNAVAILABLE =
  "Historical version no longer available; showing event detail."

type ResolvedDiff = {
  beforeJson: string | null
  afterJson: string | null
  note?: string
}

type RefResolveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; diff: ResolvedDiff }
  | { status: "unavailable"; message: string }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return target.isContentEditable
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { status?: number }).status === 404)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

async function resolveEntityRef(ref: AuditVersionRef): Promise<ResolvedDiff> {
  if (!ref.id || ref.version == null) throw Object.assign(new Error("missing ref"), { status: 404 })
  const tenant = ref.tenantId
  const after = await api.getEntityRegistry(ref.id, { tenant, version: ref.version })
  const before =
    ref.prevVersion != null
      ? await api.getEntityRegistry(ref.id, { tenant, version: ref.prevVersion })
      : null
  return {
    beforeJson: stringifyAuditJson(asRecord(before)),
    afterJson: stringifyAuditJson(asRecord(after)),
  }
}

async function resolveStrategyRef(ref: AuditVersionRef): Promise<ResolvedDiff> {
  if (!ref.id || ref.version == null) throw Object.assign(new Error("missing ref"), { status: 404 })
  const tenant = ref.tenantId
  const after = await api.getEntityRegistryStrategy(ref.id, { tenant, version: ref.version })
  const before =
    ref.prevVersion != null
      ? await api.getEntityRegistryStrategy(ref.id, { tenant, version: ref.prevVersion })
      : null
  return {
    beforeJson: stringifyAuditJson(asRecord(before)),
    afterJson: stringifyAuditJson(asRecord(after)),
  }
}

async function resolveCatalogRef(ref: AuditVersionRef): Promise<ResolvedDiff> {
  if (ref.catalogVersion == null) throw Object.assign(new Error("missing ref"), { status: 404 })
  const against = ref.againstCatalogVersion ?? "previous"
  const { diff } = await api.getSyncCatalogVersionDiff(ref.catalogVersion, against)
  for (const section of diff.sections) {
    for (const row of [...section.updates, ...section.creates, ...section.deletes]) {
      if (row.beforeJson || row.afterJson) {
        return {
          beforeJson: row.beforeJson,
          afterJson: row.afterJson,
          note: `First changed item in ${section.label} (catalog v${diff.toVersion}${diff.fromVersion != null ? ` ← v${diff.fromVersion}` : ""}). Full tip diff is in Configuration versions.`,
        }
      }
    }
  }
  return {
    beforeJson: null,
    afterJson: JSON.stringify(
      {
        fromVersion: diff.fromVersion,
        toVersion: diff.toVersion,
        changeCount: diff.changeCount,
      },
      null,
      2,
    ) + "\n",
    note: "No item-level JSON in this catalog tip; summary only.",
  }
}

async function resolveVersionRef(ref: AuditVersionRef): Promise<ResolvedDiff> {
  if (ref.kind === "entity_version") return resolveEntityRef(ref)
  if (ref.kind === "strategy_version") return resolveStrategyRef(ref)
  return resolveCatalogRef(ref)
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

function propPlainText(value: ReactNode, copyText?: string): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (copyText) return copyText
  return null
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
  const plain = propPlainText(value, copy?.text)
  const stacked = plain != null && auditValueStacks(plain)
  const useMono = Boolean(mono || stacked)
  const copySpec =
    copy ?? (plain && stacked ? { text: plain, label: label } : undefined)
  const display = value ?? "—"

  if (stacked) {
    return (
      <div className="audit-inspector__prop audit-inspector__prop--stacked">
        <div className="audit-inspector__prop-head">
          <span className="audit-inspector__prop-key">{label}</span>
          {copySpec ? <CopyIconBtn value={copySpec.text} label={copySpec.label} /> : null}
        </div>
        <span
          className={`audit-inspector__prop-val audit-inspector__prop-val--block${
            useMono ? " audit-inspector__prop-val--mono" : ""
          }`}
        >
          <span className="audit-inspector__prop-text" title={plain ?? undefined}>
            {display}
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="audit-inspector__prop">
      <span className="audit-inspector__prop-key">{label}</span>
      <span className={`audit-inspector__prop-val${useMono ? " audit-inspector__prop-val--mono" : ""}`}>
        <span className="audit-inspector__prop-text" title={plain ?? undefined}>
          {display}
        </span>
        {copySpec ? <CopyIconBtn value={copySpec.text} label={copySpec.label} /> : null}
      </span>
    </div>
  )
}

export function AuditInspector({
  entry,
  open,
  wide,
  widthPx,
  onWidthChange,
  onToggleWide,
  onResizingChange,
  onClose,
  onExited,
}: {
  entry: AdminAuditItem
  open: boolean
  wide: boolean
  widthPx: number
  onWidthChange: (px: number) => void
  onToggleWide: () => void
  onResizingChange: (resizing: boolean) => void
  onClose: () => void
  onExited: () => void
}): JSX.Element {
  const [rawOpen, setRawOpen] = useState(false)
  const [refState, setRefState] = useState<RefResolveState>({ status: "idle" })
  const [resizing, setResizing] = useState(false)
  const exitedRef = useRef(false)
  const hasOpenedRef = useRef(false)
  const dragRef = useRef<ResizeDrag | null>(null)
  const actionRef = useRef({
    open,
    onClose,
    onExited,
    widthPx,
    onWidthChange,
    onResizingChange,
  })
  actionRef.current = {
    open,
    onClose,
    onExited,
    widthPx,
    onWidthChange,
    onResizingChange,
  }
  const resolveGenRef = useRef(0)

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: actionRef.current.widthPx }
    setResizing(true)
    actionRef.current.onResizingChange(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.startW + (drag.startX - e.clientX)
    actionRef.current.onWidthChange(next)
  }

  function onResizePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    actionRef.current.onResizingChange(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const sides = auditDiffSides(entry.detail)
  const embeddedDiff: ResolvedDiff | null =
    sides.mode === "embedded"
      ? {
          beforeJson: stringifyAuditJson(sides.before),
          afterJson: stringifyAuditJson(sides.after),
        }
      : null

  useEffect(() => {
    if (!open) return
    exitedRef.current = false
    hasOpenedRef.current = true
  }, [open])

  useEffect(() => {
    setRawOpen(false)
  }, [entry.id])

  useEffect(() => {
    const parsed = auditDiffSides(entry.detail)
    if (parsed.mode !== "ref") {
      setRefState({ status: "idle" })
      return
    }
    const ref = parsed.ref
    const gen = ++resolveGenRef.current
    setRefState({ status: "loading" })
    let cancelled = false
    void resolveVersionRef(ref)
      .then((diff) => {
        if (cancelled || gen !== resolveGenRef.current) return
        setRefState({ status: "ready", diff })
      })
      .catch((err: unknown) => {
        if (cancelled || gen !== resolveGenRef.current) return
        if (isNotFound(err)) {
          setRefState({ status: "unavailable", message: REF_UNAVAILABLE })
          return
        }
        setRefState({
          status: "unavailable",
          message: err instanceof Error ? err.message : REF_UNAVAILABLE,
        })
      })
    return () => {
      cancelled = true
    }
  }, [entry.id, entry.detail])

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
  const showHintsFallback =
    !embeddedDiff && (refState.status === "unavailable" || refState.status === "idle" || sides.mode === "none")

  const activeDiff: ResolvedDiff | null =
    embeddedDiff ?? (refState.status === "ready" ? refState.diff : null)

  return (
    <aside
      className="audit-inspector"
      data-open={open ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
      role="dialog"
      aria-label="Audit entry details"
      aria-hidden={!open}
      onTransitionEnd={onPanelTransitionEnd}
    >
      <div
        className="audit-inspector__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      />
      <div className="audit-inspector__shell">
        <header className="audit-inspector__header">
          <div className="audit-inspector__title">
            <Scale size={15} className="shrink-0 text-text-muted" />
            <div className="min-w-0">
              <h3
                className={`truncate font-mono text-[13px] font-semibold ${verbClass}`}
                title={entry.action}
              >
                {entry.action}
              </h3>
              <p className="truncate text-[11px] text-text-muted" title={formatAuditWhen(entry.timestamp)}>
                {formatAuditWhen(entry.timestamp)}
              </p>
            </div>
          </div>
          <div className="audit-inspector__header-actions">
            <button
              type="button"
              className="audit-inspector__icon-btn"
              onClick={onToggleWide}
              aria-label={wide ? "Narrow inspector" : "Widen inspector"}
              aria-pressed={wide}
              title={wide ? "Narrow drawer" : "Widen drawer"}
            >
              {wide ? <PanelLeftClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
            <button
              type="button"
              className="audit-inspector__icon-btn"
              onClick={onClose}
              aria-label="Close inspector"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>
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
              {entry.run?.goal ? <PropRow label="Goal" value={entry.run.goal} /> : null}
            </div>
          </section>

          {sides.mode === "ref" && refState.status === "loading" ? (
            <section>
              <h4 className="audit-inspector__section-title">Before / after</h4>
              <p className="text-[12px] text-text-muted">Loading historical version…</p>
            </section>
          ) : null}

          {sides.mode === "ref" && refState.status === "unavailable" ? (
            <section>
              <h4 className="audit-inspector__section-title">Before / after</h4>
              <p className="text-[12px] leading-snug text-text-muted">{refState.message}</p>
            </section>
          ) : null}

          {activeDiff ? (
            <section>
              <h4 className="audit-inspector__section-title">Before / after</h4>
              {activeDiff.note ? (
                <p className="mb-2 text-[11px] leading-snug text-text-faint">{activeDiff.note}</p>
              ) : null}
              <CatalogJsonDiff
                beforeJson={activeDiff.beforeJson}
                afterJson={activeDiff.afterJson}
                changesOnly
                className="max-h-[min(40rem,50vh)] overflow-auto rounded-lg border border-border-subtle"
              />
            </section>
          ) : null}

          {/* When before/after (or resolved ref) is on screen, rely on CatalogJsonDiff — no partial Fields list. */}
          {changes.length > 0 && !activeDiff ? (
            <section>
              <h4 className="audit-inspector__section-title">Changes</h4>
              <div className="audit-inspector__props">
                {changes.map((hint) => (
                  <PropRow
                    key={`${hint.label}:${hint.value}`}
                    label={hint.label}
                    value={hint.value}
                    mono
                  />
                ))}
              </div>
              {showHintsFallback ? (
                <p className="mt-2 text-[11px] leading-snug text-text-faint">
                  Structured hints from the event detail
                  {entry.detail.truncated === true ? " (payload size-capped at write)." : "."}
                </p>
              ) : null}
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
