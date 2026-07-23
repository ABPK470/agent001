/**
 * BridgeShell — Source → Map → Target surface.
 *
 * Layout is container-sized (widget bounds), not viewport-sized. Narrow stacks
 * a centered path; wide uses 1fr | map | 1fr with idle pills clustered toward
 * the center. Opening one end keeps Map + the other peer parked at that idle
 * cluster spot; Map stretches only when both ends are open.
 */

import type { ConnectorInfo, MoveSummary, Transform } from "@mia/shared-types"
import { ChevronLeft, ChevronRight, Eye, Play, Shuffle } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { ModalToastStack, useModalToasts } from "../entity-registry/ModalToastStack"
import { WIDGET_ICONS } from "../widget-icons"
import { BridgeEndpointCard } from "./BridgeEndpointPanel"
import { BridgeMapModal } from "./BridgeMapModal"
import { summarizeMap } from "./bridge-summaries"
import { previewPageSlice } from "./preview-page"
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

const STAGE_PREVIEW_MIN_PX = 120
const STAGE_PREVIEW_DEFAULT_PX = 280
const STAGE_PATH_MIN_PX = 96
const STAGE_HANDLE_PX = 8

type StageResizeDrag = {
  pointerId: number
  startY: number
  startPreviewH: number
  stageH: number
}

function clampStagePreviewH(heightPx: number, stageH: number): number {
  const max = Math.max(STAGE_PREVIEW_MIN_PX, stageH - STAGE_PATH_MIN_PX - STAGE_HANDLE_PX)
  return Math.min(max, Math.max(STAGE_PREVIEW_MIN_PX, Math.round(heightPx)))
}

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
  const [stagePreviewH, setStagePreviewH] = useState(STAGE_PREVIEW_DEFAULT_PX)
  const stageRef = useRef<HTMLDivElement>(null)
  const stageResizeDragRef = useRef<StageResizeDrag | null>(null)
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

  function onStageResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const stage = stageRef.current
    if (!stage) return
    event.currentTarget.setPointerCapture(event.pointerId)
    stageResizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPreviewH: stagePreviewH,
      stageH: stage.clientHeight,
    }
  }

  function onStageResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = stageResizeDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    // Path is above preview: drag handle up → taller preview.
    const next = drag.startPreviewH - (event.clientY - drag.startY)
    setStagePreviewH(clampStagePreviewH(next, drag.stageH))
  }

  function onStageResizePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = stageResizeDragRef.current
    if (!drag) return
    stageResizeDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId)
    } catch (err: unknown) { console.error("[mia]", err) }
  }

  function onStageResizePointerCancel(): void {
    stageResizeDragRef.current = null
  }

  function onStageResizeLostPointerCapture(): void {
    if (!stageResizeDragRef.current) return
    stageResizeDragRef.current = null
  }

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
      onSourceSpecChange={(patch) => setSourceSpec((prev) => ({ ...prev, ...patch }))}
      onTargetSpecChange={(patch) => setTargetSpec((prev) => ({ ...prev, ...patch }))}
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
              <div ref={stageRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-5">{path}</div>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize preview"
                  aria-valuenow={stagePreviewH}
                  aria-valuemin={STAGE_PREVIEW_MIN_PX}
                  className="group relative z-10 flex h-2 shrink-0 cursor-row-resize items-center justify-center border-y border-border-subtle bg-panel hover:bg-elevated"
                  onPointerDown={onStageResizePointerDown}
                  onPointerMove={onStageResizePointerMove}
                  onPointerUp={onStageResizePointerUp}
                  onPointerCancel={onStageResizePointerCancel}
                  onLostPointerCapture={onStageResizeLostPointerCapture}
                >
                  <span
                    className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-border-focus"
                    aria-hidden
                  />
                </div>
                <div
                  className="flex shrink-0 flex-col overflow-hidden"
                  style={{ height: stagePreviewH }}
                >
                  {preview ? (
                    <PreviewStage rows={preview.rows} truncated={preview.truncated} />
                  ) : (
                    <SummaryStage summary={summary!} />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 sm:px-5">
                {path}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-border-subtle bg-panel px-3 py-2.5 sm:px-5 sm:py-3">
            <p className={`min-w-0 flex-1 basis-32 truncate ${META_TEXT}`}>
              {source && target
                ? `${source.displayName} → ${target.displayName}`
                : "Pick source and target to continue"}
            </p>
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className={TEXT_BTN}
                disabled={!canPreview}
                onClick={() => void onPreview().catch((err: unknown) => { console.error("[mia]", err) })}
              >
                <Eye size={14} className="mr-1.5 inline-block opacity-70" aria-hidden />
                {busy === "preview" ? "Previewing…" : "Preview"}
              </button>
              <button
                type="button"
                className={TEXT_BTN_PRIMARY}
                disabled={!canRun}
                onClick={() => void onRun().catch((err: unknown) => { console.error("[mia]", err) })}
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
          onSampleColumns={source ? () => void onSampleColumns().catch((err: unknown) => { console.error("[mia]", err) }) : undefined}
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
  onSourceSpecChange: (patch: Record<string, unknown>) => void
  onTargetSpecChange: (patch: Record<string, unknown>) => void
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
        sourceOpen ? "bridge-path--source-open" : "",
        targetOpen ? "bridge-path--target-open" : "",
      ].join(" ")}
    >
      <div
        className={[
          "bridge-path__slot bridge-path__slot--source min-h-0 min-w-0",
          sourceOpen ? "bridge-path__slot--end" : anyOpen ? "bridge-path__slot--peer" : "",
        ].join(" ")}
      >
        {sourceCard}
      </div>
      <div
        className={[
          "bridge-path__slot bridge-path__slot--map min-h-0 min-w-0",
          // Center the path pill (matches idle). Stretch only for the
          // full-height Map column when both endpoints are open.
          bothOpen ? "items-stretch" : "items-center justify-center",
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
          "bridge-path__slot bridge-path__slot--target min-h-0 min-w-0",
          targetOpen ? "bridge-path__slot--end" : anyOpen ? "bridge-path__slot--peer" : "",
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
      className={`group flex ${PATH_PILL_H} w-[min(8.5rem,100%)] max-w-full flex-col items-center justify-center gap-1 rounded-2xl border border-border-subtle bg-overlay-1 px-2 py-2.5 text-center transition-colors hover:border-border hover:bg-overlay-2 sm:px-3 sm:py-3`}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-overlay-2 text-text-muted ring-1 ring-border-subtle/60 group-hover:text-text sm:h-9 sm:w-9">
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
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [rows])

  if (rows.length === 0) {
    return <EmptyState icon={WIDGET_ICONS.bridge} message="Preview returned 0 rows" />
  }

  const slice = previewPageSlice(rows, page)
  const cols = Object.keys(rows[0]!)

  function onPrevPage(): void {
    setPage((p) => Math.max(0, p - 1))
  }

  function onNextPage(): void {
    setPage((p) => Math.min(slice.pageCount - 1, p + 1))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-5 py-4">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-text-muted">
          Preview · {rows.length} row{rows.length === 1 ? "" : "s"}
          {truncated ? " (truncated)" : ""} · nothing written
        </p>
        {slice.pageCount > 1 ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="tabular-nums text-sm text-text-muted">
              {slice.start + 1}–{slice.end} of {rows.length}
            </span>
            <button
              type="button"
              className="rounded p-1 text-text-muted transition-colors hover:bg-overlay-2 hover:text-text disabled:cursor-default disabled:opacity-30"
              disabled={slice.page === 0}
              onClick={onPrevPage}
              aria-label="Previous preview page"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="rounded p-1 text-text-muted transition-colors hover:bg-overlay-2 hover:text-text disabled:cursor-default disabled:opacity-30"
              disabled={slice.page >= slice.pageCount - 1}
              onClick={onNextPage}
              aria-label="Next preview page"
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-subtle">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-[1] border-b border-border-subtle bg-elevated/95 backdrop-blur-sm">
            <tr>
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-text">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.rows.map((row, i) => (
              <tr key={slice.start + i} className="odd:bg-base/25">
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
  const Icon = WIDGET_ICONS.bridge
  const tone =
    summary.status === "completed"
      ? "text-emerald-500"
      : summary.status === "partial"
        ? "text-amber-500"
        : "text-rose-500"
  // Match Pipelines body (`text-sm`) — EmptyState's detail is xs; results need readable type.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <Icon size={20} className="shrink-0 text-text-muted opacity-40" aria-hidden />
      <p className={`text-sm font-medium ${tone}`}>{summary.status}</p>
      <div className="max-w-lg space-y-1.5 text-sm text-text-muted">
        <p>
          Read {summary.rowsRead} · wrote {summary.rowsWritten}
          {summary.failedAtRow !== null ? ` · stopped at row ${summary.failedAtRow}` : ""}
        </p>
        {summary.errors.slice(0, 3).map((e, i) => (
          <p key={i} className="font-mono text-sm leading-snug">
            row {e.row}: {e.message}
          </p>
        ))}
      </div>
    </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
