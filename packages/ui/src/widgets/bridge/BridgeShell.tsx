/**
 * BridgeShell — calm primary surface for Source → Target moves.
 *
 * First principles:
 *   - One composition: path, stage, actions
 *   - Connector brand marks at a readable size on the path
 *   - Specs and Map live in focused modals (progressive disclosure)
 *   - Preview / result occupy the stage; empty state stays centered
 */

import type { ConnectorInfo, MoveSummary, Transform } from "@mia/shared-types"
import { ArrowRight, Eye, Play, Settings2, Shuffle } from "lucide-react"
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
          {/* Path — the whole story in one glance */}
          <div className="shrink-0 border-b border-border-subtle px-5 py-5 sm:px-8">
            <div className="mx-auto flex max-w-3xl flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-center sm:gap-3">
              <EndpointTile
                role="Source"
                connector={source}
                summary={source ? summarizeReadSpec(source.kind, sourceSpec) : "Choose a source"}
                onConfigure={() => setEndpointModal("source")}
              />
              <div className="flex items-center justify-center gap-2 sm:flex-col sm:px-1">
                <ArrowRight size={18} className="rotate-90 text-text-faint sm:rotate-0" aria-hidden />
              </div>
              <EndpointTile
                role="Target"
                connector={target}
                summary={target ? summarizeWriteSpec(target.kind, targetSpec) : "Choose a target"}
                onConfigure={() => setEndpointModal("target")}
              />
            </div>

            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setMapOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-overlay-1 px-3.5 py-1.5 text-sm text-text-secondary transition-colors hover:border-border hover:bg-overlay-2 hover:text-text"
              >
                <Shuffle size={14} className="text-text-muted" aria-hidden />
                <span className="font-medium">Map</span>
                <span className="text-text-faint">·</span>
                <span className="text-text-muted">{mapLabel}</span>
              </button>
            </div>
          </div>

          {/* Stage — preview, result, or ready summary */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {preview ? (
              <PreviewStage rows={preview.rows} truncated={preview.truncated} />
            ) : summary ? (
              <SummaryStage summary={summary} />
            ) : (
              <ReadyStage
                source={source}
                target={target}
                mapLabel={mapLabel}
                sameConnector={Boolean(source && target && source.id === target.id)}
                canPreview={canPreview}
                canRun={canRun}
                busy={busy}
                onPreview={() => void onPreview()}
                onRun={() => void onRun()}
                onOpenMap={() => setMapOpen(true)}
              />
            )}
          </div>

          {/* Sticky actions — always visible */}
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
      <span className="shrink-0 text-xs font-medium text-text-faint group-hover:text-text-muted">
        Edit
      </span>
    </button>
  )
}

function ReadyStage({
  source,
  target,
  mapLabel,
  sameConnector,
  canPreview,
  canRun,
  busy,
  onPreview,
  onRun,
  onOpenMap,
}: {
  source: ConnectorInfo | null
  target: ConnectorInfo | null
  mapLabel: string
  sameConnector: boolean
  canPreview: boolean
  canRun: boolean
  busy: "preview" | "run" | "sample" | null
  onPreview: () => void
  onRun: () => void
  onOpenMap: () => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-8">
      <div className="flex max-w-lg flex-wrap items-center justify-center gap-2.5">
        {source ? (
          <span className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-overlay-1 px-3 py-2">
            <ConnectorKindMark kind={source.kind} size={22} title={source.kind} />
            <span className="text-sm font-medium text-text">{source.displayName}</span>
          </span>
        ) : (
          <span className={`text-sm ${META_TEXT}`}>No source</span>
        )}
        <ArrowRight size={16} className="text-text-faint" aria-hidden />
        <button
          type="button"
          onClick={onOpenMap}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border-subtle bg-overlay-1 px-3 py-2 text-sm text-text-secondary hover:border-border hover:text-text"
        >
          <Shuffle size={14} aria-hidden />
          {mapLabel}
        </button>
        <ArrowRight size={16} className="text-text-faint" aria-hidden />
        {target ? (
          <span className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-overlay-1 px-3 py-2">
            <ConnectorKindMark kind={target.kind} size={22} title={target.kind} />
            <span className="text-sm font-medium text-text">{target.displayName}</span>
          </span>
        ) : (
          <span className={`text-sm ${META_TEXT}`}>No target</span>
        )}
      </div>

      <div className="max-w-md text-center">
        <p className="text-sm font-medium text-text">Ready to move</p>
        <p className={`mt-1 ${META_TEXT}`}>
          {source && target
            ? `Preview a sample, or run the full move${sameConnector ? " (same connector for both ends)" : ""}.`
            : "Open Source and Target to choose connectors — they can be different or the same."}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" className={TEXT_BTN} disabled={!canPreview} onClick={onPreview}>
          <Eye size={14} className="mr-1.5 inline-block opacity-70" aria-hidden />
          {busy === "preview" ? "Previewing…" : "Preview"}
        </button>
        <button type="button" className={TEXT_BTN_PRIMARY} disabled={!canRun} onClick={onRun}>
          <Play size={14} className="mr-1.5 inline-block opacity-80" aria-hidden />
          {busy === "run" ? "Running…" : "Run"}
        </button>
      </div>
    </div>
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
