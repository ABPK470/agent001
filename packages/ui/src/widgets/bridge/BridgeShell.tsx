/**
 * BridgeShell — move rows between connectors (source → transform → target).
 *
 * Separate from sync: this is the generic bridge surface backed by the
 * @mia/connectors engine. The agent `bridge_data` tool and the
 * `/api/bridge` REST routes share the same server port.
 */

import type {
  ConnectorInfo,
  MoveSummary,
  Transform,
} from "@mia/shared-types"
import { ArrowRight, Eye, Play } from "lucide-react"
import { useEffect, useMemo, useState, type JSX } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import {
  FORM_HEADING,
  HELP_TEXT,
  ICON_BTN,
  ICON_BTN_PRIMARY,
  META_TEXT,
  WIDGET_ENVELOPE
} from "../entity-registry/chrome"
import { ConnectorKindMark } from "../connectors/ConnectorKindMark"
import { FormFieldGroup, FormSectionCard } from "../entity-registry/form-section"
import { ModalToastStack, useModalToasts } from "../entity-registry/ModalToastStack"
import {
  ReadSpecForm,
  WriteSpecForm,
  buildReadSpec,
  buildWriteSpec,
  emptyReadSpec,
  emptyWriteSpec,
  parseJsonOpt,
} from "./spec-forms"

export function BridgeShell(): JSX.Element {
  const { toasts, pushToast, dismissToast } = useModalToasts()
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sourceId, setSourceId] = useState<string>("")
  const [targetId, setTargetId] = useState<string>("")
  const [sourceSpec, setSourceSpec] = useState<Record<string, unknown>>({})
  const [targetSpec, setTargetSpec] = useState<Record<string, unknown>>({})
  const [transformText, setTransformText] = useState("")
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; truncated: boolean } | null>(null)
  const [summary, setSummary] = useState<MoveSummary | null>(null)
  const [busy, setBusy] = useState<"preview" | "run" | null>(null)

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

  const sourceOptions: ListboxOption<string>[] = useMemo(
    () =>
      connectors
        .filter((c) => c.capabilities.read)
        .map((c) => ({ value: c.id, label: c.displayName, hint: c.kind })),
    [connectors],
  )
  const targetOptions: ListboxOption<string>[] = useMemo(
    () =>
      connectors
        .filter((c) => c.capabilities.write)
        .map((c) => ({ value: c.id, label: c.displayName, hint: c.kind })),
    [connectors],
  )

  const source = connectors.find((c) => c.id === sourceId) ?? null
  const target = connectors.find((c) => c.id === targetId) ?? null

  function onSourceChange(id: string): void {
    const c = connectors.find((x) => x.id === id)
    setSourceId(id)
    setSourceSpec(c ? emptyReadSpec(c.kind) : {})
    setPreview(null)
  }
  function onTargetChange(id: string): void {
    const c = connectors.find((x) => x.id === id)
    setTargetId(id)
    setTargetSpec(c ? emptyWriteSpec(c.kind) : {})
    setSummary(null)
  }

  function buildTransform(): Transform | undefined {
    const parsed = parseJsonOpt(transformText)
    if ("error" in parsed) {
      throw new Error(`Transform JSON: ${parsed.error}`)
    }
    return parsed.value === undefined ? undefined : (parsed.value as Transform)
  }

  async function onPreview(): Promise<void> {
    if (!source) return
    setBusy("preview")
    setPreview(null)
    try {
      const transform = buildTransform()
      const res = await api.previewBridge({
        source: { connectorId: sourceId, spec: buildReadSpec(source.kind, sourceSpec) },
        ...(transform ? { transform } : {}),
        limit: 50,
      })
      setPreview(res)
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
      const transform = buildTransform()
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

  const canMove = Boolean(source && target) && busy === null

  return (
    <div className="bridge flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel p-3">
      <div className={WIDGET_ENVELOPE}>
        <ModalToastStack toasts={toasts} onDismiss={dismissToast} />
        <div className="shrink-0 border-b border-border-subtle px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={FORM_HEADING}>Move data between connectors</h3>
              <p className={`${META_TEXT} mt-1 max-w-3xl leading-relaxed text-text-faint`}>
                Stream rows from a source connector through an optional declarative transform into a target connector.
                Preview reads up to 50 rows without writing; Run executes the full move.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void onPreview()}
                  disabled={!canMove || busy === "preview"}
                  className={ICON_BTN}
                  title="Preview up to 50 rows (no write)"
                  aria-label="Preview"
                >
                  <Eye size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => void onRun()}
                  disabled={!canMove || busy === "run"}
                  className={ICON_BTN_PRIMARY}
                  title="Run the full move"
                  aria-label="Run move"
                >
                  <Play size={16} />
                </button>
              </div>
              {source && target && (
                <div
                  className="inline-flex max-w-[16rem] items-center gap-2 rounded-lg border border-border-subtle bg-elevated/40 px-2.5 py-1.5"
                  title={`${source.displayName} → ${target.displayName}`}
                >
                  <ConnectorKindMark kind={source.kind} size={14} title={source.kind} />
                  <span className="min-w-0 truncate text-xs font-medium text-text">{source.displayName}</span>
                  <ArrowRight size={12} className="shrink-0 text-accent" aria-hidden />
                  <ConnectorKindMark kind={target.kind} size={14} title={target.kind} />
                  <span className="min-w-0 truncate text-xs font-medium text-text">{target.displayName}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-base/20 p-5">
          {!loaded ? (
            <p className={HELP_TEXT}>Loading connectors…</p>
          ) : connectors.length === 0 ? (
            <p className={HELP_TEXT}>
              No connectors configured. Add one from the platform menu → Connectors.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <FormSectionCard title="Source" description="Where rows come from." emphasized>
                  <FormFieldGroup label="Connector">
                    <Listbox
                      value={sourceId}
                      options={sourceOptions}
                      onChange={onSourceChange}
                      size="sm"
                      className="w-full"
                      ariaLabel="Source connector"
                      placeholder="Select a source…"
                    />
                  </FormFieldGroup>
                  {source && (
                    <ReadSpecForm
                      kind={source.kind}
                      spec={sourceSpec}
                      onPatch={(p) => setSourceSpec(p)}
                    />
                  )}
                </FormSectionCard>

                <FormSectionCard title="Target" description="Where rows go." emphasized>
                  <FormFieldGroup label="Connector">
                    <Listbox
                      value={targetId}
                      options={targetOptions}
                      onChange={onTargetChange}
                      size="sm"
                      className="w-full"
                      ariaLabel="Target connector"
                      placeholder="Select a target…"
                    />
                  </FormFieldGroup>
                  {target && (
                    <WriteSpecForm
                      kind={target.kind}
                      spec={targetSpec}
                      onPatch={(p) => setTargetSpec(p)}
                    />
                  )}
                </FormSectionCard>
              </div>

              <FormSectionCard
                title="Transform (optional)"
                description="Rename or cast columns, then add computed fields — applied row-by-row after the source read."
              >
                <textarea
                  value={transformText}
                  onChange={(e) => setTransformText(e.target.value)}
                  rows={4}
                  placeholder={'{\n  "columns": [{ "from": "id", "to": "key" }],\n  "derive": [{ "to": "label", "template": "row-${id}" }]\n}'}
                  className="input text-sm font-mono leading-relaxed"
                />
              </FormSectionCard>

              {preview && <PreviewTable rows={preview.rows} truncated={preview.truncated} />}
              {summary && <SummaryCard summary={summary} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewTable({
  rows,
  truncated,
}: {
  rows: Record<string, unknown>[]
  truncated: boolean
}): JSX.Element {
  if (rows.length === 0) {
    return <p className={HELP_TEXT}>Preview returned 0 rows.</p>
  }
  const cols = Object.keys(rows[0]!)
  return (
    <FormSectionCard
      title={`Preview · ${rows.length} row${rows.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`}
      description="First 50 rows from the source after the transform — nothing written."
    >
      <div className="overflow-auto rounded-md border border-border-subtle">
        <table className="min-w-full text-xs">
          <thead className="bg-elevated/60">
            <tr>
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-text">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="odd:bg-base/30">
                {cols.map((c) => (
                  <td key={c} className="whitespace-nowrap px-2.5 py-1.5 font-mono text-text-muted">
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormSectionCard>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

function SummaryCard({ summary }: { summary: MoveSummary }): JSX.Element {
  const tone =
    summary.status === "completed"
      ? "text-emerald-400"
      : summary.status === "partial"
        ? "text-amber-400"
        : "text-rose-400"
  return (
    <FormSectionCard title="Move result" description="Summary returned by the target adapter.">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`font-semibold ${tone}`}>{summary.status}</span>
        <span className={META_TEXT}>
          rows read: <span className="font-mono text-text">{summary.rowsRead}</span>
        </span>
        <span className={META_TEXT}>
          rows written: <span className="font-mono text-text">{summary.rowsWritten}</span>
        </span>
        {summary.failedAtRow !== null && (
          <span className={META_TEXT}>
            stopped at row <span className="font-mono text-text">{summary.failedAtRow}</span>
          </span>
        )}
        {summary.errors.length > 0 && (
          <span className={META_TEXT}>
            errors: <span className="font-mono text-text">{summary.errors.length}</span>
          </span>
        )}
      </div>
      {summary.errors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-text-muted">
          {summary.errors.slice(0, 10).map((e, i) => (
            <li key={i} className="font-mono">
              row {e.row}: {e.message}
            </li>
          ))}
          {summary.errors.length > 10 && (
            <li className="text-text-faint">… +{summary.errors.length - 10} more</li>
          )}
        </ul>
      )}
    </FormSectionCard>
  )
}



