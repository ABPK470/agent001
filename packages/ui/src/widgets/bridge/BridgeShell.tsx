/**
 * BridgeShell — Source → Map → Target surface.
 *
 * Stable grid: 1fr | 9rem map | 1fr. An expanded end always fills its half at
 * full height — opening/closing the peer never changes that size. Collapsed
 * pills keep fixed default chrome and stay parked toward the center. Tall Map
 * chip only when both ends are open (same column width either way).
 */

import type { ConnectorInfo, MoveSummary, Transform } from "@mia/shared-types"
import { Eye, Play, Shuffle } from "lucide-react"
import { useEffect, useState, type JSX } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { ModalToastStack, useModalToasts } from "../entity-registry/ModalToastStack"
import { WIDGET_ICONS } from "../widget-icons"
import { BridgeEndpointCard } from "./BridgeEndpointPanel"
import { BridgeMapModal } from "./BridgeMapModal"
import { summarizeMap } from "./bridge-summaries"
import {
  buildReadSpec,
  buildWriteSpec,
  emptyReadSpec,
  emptyWriteSpec,
} from "./spec-forms"
import {
  columnNamesFromRows,
  compileTransform,
  emptyTransformDraft,
  seedIdentityColumns,
  type TransformDraft,
} from "./transform-draft"

/** Idle path chips — Source, Map, and Target share this height. */
const PATH_PILL_H = "h-[6.75rem]"

export function BridgeShell(): JSX.Element {
  const { toasts, pushToast, dismissToast } = useModalToasts()
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sourceId, setSourceId] = useState("")
  const [targetId, setTargetId] = useState("")
  const [sourceSpec, setSourceSpec] = useState<Record<string, unknown>>({})
  const [targetSpec, setTargetSpec] = useState<Record<string, unknown>>({})
  const [mapDraft, setMapDraft] = useState<TransformDraft>(() => emptyTransformDraft())
  const [sourceColumns, setSourceColumns] = useState<string[]>([])
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; truncated: boolean } | null>(null)
  const [summary, setSummary] = useState<MoveSummary | null>(null)
  const [busy, setBusy] = useState<"preview" | "run" | "sample" | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [targetOpen, setTargetOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listBridgeConnectors()
      .then((res) => {
        if (cancelled) return
        const enabled = res.connectors.filter((c) => c.enabled)
        setConnectors(enabled)
        const firstRead = enabled.find((c) => c.capabilities.read)
        const firstWrite = enabled.find((c) => c.capabilities.write)
        if (firstRead) {
          setSourceId(firstRead.id)
          setSourceSpec(emptyReadSpec(firstRead.kind))
        }
        if (firstWrite) {
          setTargetId(firstWrite.id)
          setTargetSpec(emptyWriteSpec(firstWrite.kind))
        }
      })
      .catch((e) => pushToast(`Failed to load connectors: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [pushToast])

  const source = connectors.find((c) => c.id === sourceId) ?? null
  const target = connectors.find((c) => c.id === targetId) ?? null

  function selectSource(id: string): void {
    const c = connectors.find((x) => x.id === id)
    if (!c?.capabilities.read) return
    setSourceId(id)
    setSourceSpec(emptyReadSpec(c.kind))
    setPreview(null)
    setSourceColumns([])
    setMapDraft(emptyTransformDraft())
  }

  function selectTarget(id: string): void {
    const c = connectors.find((x) => x.id === id)
    if (!c?.capabilities.write) return
    setTargetId(id)
    setTargetSpec(emptyWriteSpec(c.kind))
    setSummary(null)
  }

  function resolveTransform(): Transform | undefined {
    const compiled = compileTransform(mapDraft)
    if (!compiled.ok) throw new Error(compiled.error)
    return compiled.transform
  }

  async function onSampleColumns(): Promise<void> {
    if (!source) return
    setBusy("sample")
    try {
      const res = await api.previewBridge({
        source: { connectorId: sourceId, spec: buildReadSpec(source.kind, sourceSpec) },
        limit: 20,
      })
      const names = columnNamesFromRows(res.rows)
      setSourceColumns(names)
      setMapDraft((prev) => seedIdentityColumns(prev, names))
      if (names.length === 0) pushToast("Sample returned no columns", "info")
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "err")
    } finally {
      setBusy(null)
    }
  }

  async function onPreview(): Promise<void> {
    if (!source) return
    setBusy("preview")
    setPreview(null)
    setSummary(null)
    try {
      const transform = resolveTransform()
      const res = await api.previewBridge({
        source: { connectorId: sourceId, spec: buildReadSpec(source.kind, sourceSpec) },
        ...(transform ? { transform } : {}),
        limit: 50,
      })
      setPreview(res)
      if (!transform) setSourceColumns(columnNamesFromRows(res.rows))
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "err")
    } finally {
      setBusy(null)
    }
  }

  async function onRun(): Promise<void> {
    if (!source || !target) return
    setBusy("run")
    setSummary(null)
    try {
      const transform = resolveTransform()
      const res = await api.runBridge({
        source: { connectorId: sourceId, spec: buildReadSpec(source.kind, sourceSpec) },
        target: { connectorId: targetId, spec: buildWriteSpec(target.kind, targetSpec) },
        ...(transform ? { transform } : {}),
      })
      setSummary(res)
      const kind =
        res.status === "failed" ? "err" : res.status === "partial" ? "info" : "ok"
      pushToast(`Move ${res.status}: ${res.rowsWritten} rows written`, kind)
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "err")
    } finally {
      setBusy(null)
    }
  }

  const canPreview = Boolean(source) && busy === null
  const canRun = Boolean(source && target) && busy === null
  const mapLabel = summarizeMap(mapDraft)
  const hasStage = Boolean(preview || summary)

  const path = (
    <PathBlock
      connectors={connectors}
      sourceId={sourceId}
      targetId={targetId}
      sourceSpec={sourceSpec}
      targetSpec={targetSpec}
      mapLabel={mapLabel}
      sourceOpen={sourceOpen}
      targetOpen={targetOpen}
      onToggleSource={() => setSourceOpen((v) => !v)}
      onToggleTarget={() => setTargetOpen((v) => !v)}
      onSourceConnectorChange={selectSource}
      onTargetConnectorChange={selectTarget}
      onSourceSpecChange={setSourceSpec}
      onTargetSpecChange={setTargetSpec}
      onOpenMap={() => setMapOpen(true)}
    />
  )

  return (
    <div className="bridge flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <ModalToastStack toasts={toasts} onDismiss={dismissToast} />

      {!loaded ? (
        <EmptyState icon={WIDGET_ICONS.bridge} message="Loading connectors…" />
      ) : connectors.length === 0 ? (
        <EmptyState
          icon={WIDGET_ICONS.bridge}
          message="No connectors yet"
          detail="Add one from the platform menu → Connectors."
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {hasStage ? (
              <>
                <div className="shrink-0 border-b border-border-subtle px-4 py-3 sm:px-5">{path}</div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {preview ? (
                    <PreviewStage rows={preview.rows} truncated={preview.truncated} />
                  ) : (
                    <SummaryStage summary={summary!} />
                  )}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 sm:px-5">
                {path}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle bg-panel px-5 py-3">
            <p className={`hidden min-w-0 truncate sm:block ${META_TEXT}`}>
              {source && target
                ? `${source.displayName} → ${target.displayName}`
                : "Pick source and target to continue"}
            </p>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className={TEXT_BTN}
                disabled={!canPreview}
                onClick={() => void onPreview()}
              >
                <Eye size={14} className="mr-1.5 inline-block opacity-70" aria-hidden />
                {busy === "preview" ? "Previewing…" : "Preview"}
              </button>
              <button
                type="button"
                className={TEXT_BTN_PRIMARY}
                disabled={!canRun}
                onClick={() => void onRun()}
              >
                <Play size={14} className="mr-1.5 inline-block opacity-80" aria-hidden />
                {busy === "run" ? "Running…" : "Run"}
              </button>
            </div>
          </div>
        </>
      )}

      {mapOpen && (
        <BridgeMapModal
          draft={mapDraft}
          onChange={setMapDraft}
          sourceColumns={sourceColumns}
          onSampleColumns={source ? () => void onSampleColumns() : undefined}
          sampling={busy === "sample"}
          source={source}
          target={target}
          onClose={() => setMapOpen(false)}
        />
      )}
    </div>
  )
}

function PathBlock({
  connectors,
  sourceId,
  targetId,
  sourceSpec,
  targetSpec,
  mapLabel,
  sourceOpen,
  targetOpen,
  onToggleSource,
  onToggleTarget,
  onSourceConnectorChange,
  onTargetConnectorChange,
  onSourceSpecChange,
  onTargetSpecChange,
  onOpenMap,
}: {
  connectors: ConnectorInfo[]
  sourceId: string
  targetId: string
  sourceSpec: Record<string, unknown>
  targetSpec: Record<string, unknown>
  mapLabel: string
  sourceOpen: boolean
  targetOpen: boolean
  onToggleSource: () => void
  onToggleTarget: () => void
  onSourceConnectorChange: (id: string) => void
  onTargetConnectorChange: (id: string) => void
  onSourceSpecChange: (next: Record<string, unknown>) => void
  onTargetSpecChange: (next: Record<string, unknown>) => void
  onOpenMap: () => void
}): JSX.Element {
  const sourceCard = (
    <BridgeEndpointCard
      role="source"
      connectors={connectors}
      connectorId={sourceId}
      spec={sourceSpec}
      expanded={sourceOpen}
      onToggle={onToggleSource}
      onConnectorChange={onSourceConnectorChange}
      onSpecChange={onSourceSpecChange}
      pathPillClassName={PATH_PILL_H}
    />
  )
  const targetCard = (
    <BridgeEndpointCard
      role="target"
      connectors={connectors}
      connectorId={targetId}
      spec={targetSpec}
      expanded={targetOpen}
      onToggle={onToggleTarget}
      onConnectorChange={onTargetConnectorChange}
      onSpecChange={onTargetSpecChange}
      pathPillClassName={PATH_PILL_H}
    />
  )

  const anyOpen = sourceOpen || targetOpen
  const bothOpen = sourceOpen && targetOpen

  return (
    <div
      className={[
        "bridge-path h-full min-h-0 w-full flex-1",
        anyOpen ? "bridge-path--open" : "bridge-path--idle",
      ].join(" ")}
    >
      <div
        className={[
          "flex min-h-0 min-w-0",
          sourceOpen ? "h-full min-h-0 flex-col" : anyOpen ? "items-center justify-end" : "justify-end",
        ].join(" ")}
      >
        {sourceCard}
      </div>
      <div
        className={[
          "flex min-h-0 w-full min-w-0 justify-center",
          bothOpen ? "h-full items-stretch" : "items-center",
        ].join(" ")}
      >
        <MapChip
          mapLabel={mapLabel}
          onOpenMap={onOpenMap}
          variant={bothOpen ? "center" : "path"}
        />
      </div>
      <div
        className={[
          "flex min-h-0 min-w-0",
          targetOpen ? "h-full min-h-0 flex-col" : anyOpen ? "items-center justify-start" : "justify-start",
        ].join(" ")}
      >
        {targetCard}
      </div>
    </div>
  )
}

function MapChip({
  mapLabel,
  onOpenMap,
  variant,
}: {
  mapLabel: string
  onOpenMap: () => void
  variant: "path" | "center"
}): JSX.Element {
  if (variant === "center") {
    return (
      <button
        type="button"
        onClick={onOpenMap}
        title="Configure column mappings, casts, defaults, and rules"
        className="group flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-border-subtle bg-overlay-1 px-2 py-3 text-center transition-colors hover:border-border hover:bg-overlay-2"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-overlay-2 text-text-muted ring-1 ring-border-subtle/60 group-hover:text-text">
          <Shuffle size={16} aria-hidden />
        </span>
        <span className="text-sm font-semibold text-text">Map</span>
        <span className={`max-w-full truncate px-0.5 ${META_TEXT}`}>{mapLabel}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpenMap}
      title="Configure column mappings, casts, defaults, and rules"
      className={`group flex ${PATH_PILL_H} w-[min(8.5rem,100%)] max-w-full flex-col items-center justify-center gap-1 rounded-2xl border border-border-subtle bg-overlay-1 px-3 py-3 text-center transition-colors hover:border-border hover:bg-overlay-2`}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-overlay-2 text-text-muted ring-1 ring-border-subtle/60 group-hover:text-text">
        <Shuffle size={16} aria-hidden />
      </span>
      <span className="text-sm font-semibold text-text">Map columns</span>
      <span className={`max-w-full truncate px-0.5 ${META_TEXT}`}>{mapLabel}</span>
    </button>
  )
}

function PreviewStage({
  rows,
  truncated,
}: {
  rows: Record<string, unknown>[]
  truncated: boolean
}): JSX.Element {
  if (rows.length === 0) {
    return <EmptyState icon={WIDGET_ICONS.bridge} message="Preview returned 0 rows" />
  }
  const cols = Object.keys(rows[0]!)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">
      <div className={`mb-2 shrink-0 ${META_TEXT}`}>
        Preview · {rows.length} row{rows.length === 1 ? "" : "s"}
        {truncated ? " (truncated)" : ""} · nothing written
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-subtle">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-elevated/90 backdrop-blur-sm">
            <tr>
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-text">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="odd:bg-base/25">
                {cols.map((c) => (
                  <td key={c} className="whitespace-nowrap px-3 py-1.5 font-mono text-text-muted">
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SummaryStage({ summary }: { summary: MoveSummary }): JSX.Element {
  const tone =
    summary.status === "completed"
      ? "text-emerald-500"
      : summary.status === "partial"
        ? "text-amber-500"
        : "text-rose-500"
  return (
    <EmptyState
      icon={WIDGET_ICONS.bridge}
      message={<span className={tone}>{summary.status}</span>}
      detail={
        <div className="space-y-1">
          <p>
            Read {summary.rowsRead} · wrote {summary.rowsWritten}
            {summary.failedAtRow !== null ? ` · stopped at row ${summary.failedAtRow}` : ""}
          </p>
          {summary.errors.slice(0, 3).map((e, i) => (
            <p key={i} className="font-mono text-[11px]">
              row {e.row}: {e.message}
            </p>
          ))}
        </div>
      }
    />
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
