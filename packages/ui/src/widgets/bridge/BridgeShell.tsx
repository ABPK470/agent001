/**
 * BridgeShell — calm primary surface for Source → Target moves.
 *
 * Idle: path centered in the viewport (nothing else in the middle).
 * After Preview/Run: path stays top; stage shows results; sticky actions remain.
 */

import type { ConnectorInfo, MoveSummary, Transform } from "@mia/shared-types"
import { Eye, Play, Settings2, Shuffle } from "lucide-react"
import { useEffect, useState, type JSX } from "react"
import { api } from "../../api"
import { EmptyState } from "../../components/EmptyState"
import { META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { ModalToastStack, useModalToasts } from "../entity-registry/ModalToastStack"
import { ConnectorKindMark } from "../connectors/ConnectorKindMark"
import { WIDGET_ICONS } from "../widget-icons"
import { BridgeEndpointModal } from "./BridgeEndpointModal"
import { BridgeMapModal } from "./BridgeMapModal"
import { summarizeMap, summarizeReadSpec, summarizeWriteSpec } from "./bridge-summaries"
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

type EndpointRole = "source" | "target"

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
  const [endpointModal, setEndpointModal] = useState<EndpointRole | null>(null)
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
      if (names.length === 0) pushToast("Sample returned no columns")
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
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
      pushToast(e instanceof Error ? e.message : String(e))
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
      pushToast(`Move ${res.status}: ${res.rowsWritten} rows written`)
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const canPreview = Boolean(source) && busy === null
  const canRun = Boolean(source && target) && busy === null
  const mapLabel = summarizeMap(mapDraft)
  const hasStage = Boolean(preview || summary)

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
          {hasStage ? (
            <>
              <div className="shrink-0 border-b border-border-subtle px-5 py-5 sm:px-8">
                <PathBlock
                  source={source}
                  target={target}
                  sourceSpec={sourceSpec}
                  targetSpec={targetSpec}
                  mapLabel={mapLabel}
                  onEditSource={() => setEndpointModal("source")}
                  onEditTarget={() => setEndpointModal("target")}
                  onOpenMap={() => setMapOpen(true)}
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {preview ? (
                  <PreviewStage rows={preview.rows} truncated={preview.truncated} />
                ) : (
                  <SummaryStage summary={summary!} />
                )}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-8 sm:px-8">
              <PathBlock
                source={source}
                target={target}
                sourceSpec={sourceSpec}
                targetSpec={targetSpec}
                mapLabel={mapLabel}
                onEditSource={() => setEndpointModal("source")}
                onEditTarget={() => setEndpointModal("target")}
                onOpenMap={() => setMapOpen(true)}
              />
            </div>
          )}

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

      {endpointModal === "source" && (
        <BridgeEndpointModal
          role="source"
          connectors={connectors}
          connectorId={sourceId}
          spec={sourceSpec}
          onConnectorChange={selectSource}
          onSpecChange={setSourceSpec}
          onClose={() => setEndpointModal(null)}
        />
      )}
      {endpointModal === "target" && (
        <BridgeEndpointModal
          role="target"
          connectors={connectors}
          connectorId={targetId}
          spec={targetSpec}
          onConnectorChange={selectTarget}
          onSpecChange={setTargetSpec}
          onClose={() => setEndpointModal(null)}
        />
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
  source,
  target,
  sourceSpec,
  targetSpec,
  mapLabel,
  onEditSource,
  onEditTarget,
  onOpenMap,
}: {
  source: ConnectorInfo | null
  target: ConnectorInfo | null
  sourceSpec: Record<string, unknown>
  targetSpec: Record<string, unknown>
  mapLabel: string
  onEditSource: () => void
  onEditTarget: () => void
  onOpenMap: () => void
}): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-stretch gap-3 sm:flex-row sm:items-stretch sm:justify-center sm:gap-2">
      <EndpointTile
        role="Source"
        connector={source}
        summary={source ? summarizeReadSpec(source.kind, sourceSpec) : "Choose a source"}
        onConfigure={onEditSource}
      />
      <button
        type="button"
        onClick={onOpenMap}
        title="Configure column mappings, casts, defaults, and rules"
        className="group flex w-full shrink-0 flex-col items-center justify-center gap-1 self-center rounded-2xl border border-border-subtle bg-overlay-1 px-3 py-3 text-center transition-colors hover:border-border hover:bg-overlay-2 sm:w-[8.5rem]"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-overlay-2 ring-1 ring-border-subtle/60 text-text-muted group-hover:text-text">
          <Shuffle size={16} aria-hidden />
        </span>
        <span className="text-sm font-semibold text-text">Map columns</span>
        <span className={`max-w-full truncate px-0.5 ${META_TEXT}`}>{mapLabel}</span>
      </button>
      <EndpointTile
        role="Target"
        connector={target}
        summary={target ? summarizeWriteSpec(target.kind, targetSpec) : "Choose a target"}
        onConfigure={onEditTarget}
      />
    </div>
  )
}

function EndpointTile({
  role,
  connector,
  summary,
  onConfigure,
}: {
  role: string
  connector: ConnectorInfo | null
  summary: string
  onConfigure: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onConfigure}
      title={`Configure ${role.toLowerCase()}`}
      aria-label={`Configure ${role.toLowerCase()}`}
      className="group flex min-w-0 flex-1 items-center gap-3.5 rounded-2xl border border-border-subtle bg-elevated/40 px-4 py-3.5 text-left transition-colors hover:border-border hover:bg-overlay-1"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-overlay-2 ring-1 ring-border-subtle/60">
        {connector ? (
          <ConnectorKindMark kind={connector.kind} size={28} title={connector.kind} />
        ) : (
          <Settings2 size={22} className="text-text-faint" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-text-faint">{role}</div>
        <div className="truncate text-sm font-semibold text-text">
          {connector?.displayName ?? "Select…"}
        </div>
        <div className={`mt-0.5 truncate ${META_TEXT}`}>{summary}</div>
      </div>
      <Settings2
        size={16}
        className="shrink-0 text-text-faint transition-colors group-hover:text-text-muted"
        aria-hidden
      />
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
