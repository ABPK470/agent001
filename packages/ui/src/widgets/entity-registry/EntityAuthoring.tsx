import { CircleAlert, Copy, Download, FileCode2, Loader2, Settings2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useMemo, useRef, useState } from "react"

import { api } from "../../api"
import { useContainerSize } from "../../hooks/useContainerSize"
import type {
    EntityRegistryDefinition,
    EntityRegistrySyncDefinitionExportResponse,
    EntityRegistrySyncDefinitionStatusResponse,
    EntityRegistrySyncFlowPreset,
} from "../../types"
import { ModalShell } from "./ModalShell"

export interface EntityAuthoringProps {
  def: EntityRegistryDefinition
  status: EntityRegistrySyncDefinitionStatusResponse | null
  readOnly: boolean
  onMessage: (message: { kind: "error" | "success"; text: string }) => void
  onEdit: () => void
}

const FLOW_PRESET_LABELS: Record<EntityRegistrySyncFlowPreset, string> = {
  contract: "Contract",
  dataset: "Dataset",
  rule: "Rule",
  pipelineActivity: "Pipeline Activity",
  gateMetadata: "Gate Metadata",
  content: "Content",
  "metadata-only": "Metadata Only",
}

export function EntityAuthoring({ def, status, readOnly, onMessage, onEdit }: EntityAuthoringProps): JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(layoutRef)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<EntityRegistrySyncFlowPreset>(defaultPreset(def.id, status))
  const [draft, setDraft] = useState<EntityRegistrySyncDefinitionExportResponse | null>(null)
  const [modal, setModal] = useState<null | "settings" | "issues" | "migration">(null)

  const definitionStatus = useMemo(
    () => status?.definitions.find((entry) => entry.id === def.id) ?? null,
    [status, def.id],
  )
  const authored = !!definitionStatus
  const reviewed = definitionStatus?.reviewStatus === "reviewed"
  const cleanupCount = definitionStatus?.cleanupWarnings.length ?? 0
  const publishability = !authored
    ? "draft-required"
    : reviewed && cleanupCount === 0
      ? "ready-for-curation"
      : "cleanup-required"

  async function generateDraft() {
    setBusy(true)
    try {
      const result = await api.exportEntityRegistrySyncDefinition(def.id, { flowPreset: selectedPreset })
      setDraft(result)
      onMessage({ kind: "success", text: `Generated repo-definition draft for ${def.id}` })
    } catch (error) {
      onMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  function draftJson(): string {
    return draft ? `${JSON.stringify(draft.draft, null, 2)}\n` : ""
  }

  function copyDraft() {
    if (!draft) return
    void navigator.clipboard.writeText(draftJson()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  function downloadDraft() {
    if (!draft) return
    const blob = new Blob([draftJson()], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${def.id}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const outputPath = draft?.outputPath ?? `${status?.draftExport.defaultOutputDirectory ?? "sync-definitions/entities"}/${def.id}.json`
  const postureLabel = publishability === "ready-for-curation"
    ? "Ready for compile/publish review"
    : publishability === "cleanup-required"
      ? "Authored, but still needs cleanup"
      : "Draft not created yet"
  const compact = width > 0 && width < 1100
  const ownerLabel = definitionStatus
    ? `${definitionStatus.ownershipTeam}${definitionStatus.ownershipOwner ? ` · ${definitionStatus.ownershipOwner}` : " · unassigned"}`
    : "unassigned"
  const reviewLabel = !definitionStatus
    ? "No draft yet"
    : definitionStatus.reviewStatus === "reviewed"
      ? "Reviewed"
      : "Needs review"
  const blockersLabel = cleanupCount === 0 ? "Ready" : `${cleanupCount} item${cleanupCount === 1 ? "" : "s"} to clean up`
  const hasIssues = cleanupCount > 0 || (draft?.warnings.length ?? 0) > 0

  return (
    <div ref={layoutRef} className="space-y-4">
      <section className="rounded-xl border border-border-subtle bg-panel px-4 py-4">
        {readOnly && (
          <div className="mb-3 rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-sm leading-6 text-text-muted">
            This entity is retired. You can still inspect past data here, but editing and sync JSON export are disabled.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void generateDraft()}
            disabled={busy || readOnly}
            className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
            {draft ? "Regenerate preview" : "Generate preview"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={readOnly}
            className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2"
          >
            Edit source record
          </button>
          <button
            type="button"
            onClick={() => setModal("settings")}
            className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2"
          >
            <Settings2 className="h-4 w-4" /> Export settings
          </button>
          <button
            type="button"
            onClick={() => setModal("issues")}
            className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2"
          >
            <CircleAlert className="h-4 w-4" /> {hasIssues ? `Issues (${cleanupCount + (draft?.warnings.length ?? 0)})` : "Status"}
          </button>
          <button
            type="button"
            onClick={() => setModal("migration")}
            className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2"
          >
            Migration details
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Badge tone={publishability === "ready-for-curation" ? "good" : publishability === "cleanup-required" ? "warn" : "neutral"}>{postureLabel}</Badge>
            <button
              type="button"
              onClick={copyDraft}
              disabled={!draft}
              className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2 disabled:opacity-40"
            >
              <Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy JSON"}
            </button>
            <button
              type="button"
              onClick={downloadDraft}
              disabled={!draft}
              className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text hover:bg-overlay-2 disabled:opacity-40"
            >
              <Download className="h-4 w-4" /> Download JSON
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border-subtle bg-panel overflow-hidden">
        <div className="border-b border-border-subtle px-4 py-3 text-sm text-text-muted">
          {draft ? "Preview only. Nothing here is saved to the repo automatically." : "Generate a preview to inspect the sync JSON. This does not save a file anywhere by itself."}
        </div>
        <pre className="h-[min(58vh,44rem)] overflow-auto bg-canvas px-4 py-4 font-mono text-[12px] leading-6 text-text">{draft ? draftJson() : "No draft generated yet."}</pre>
      </section>

      {modal === "settings" && (
        <ModalShell title="Export settings" subtitle={def.id} onClose={() => setModal(null)} widthClass="max-w-xl" compact>
          <div className="space-y-4 p-5">
            <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Export preset</div>
              <div className="mt-2 text-sm leading-6 text-text-muted">Choose which sync JSON shape to preview.</div>
              <select
                value={selectedPreset}
                onChange={(event) => setSelectedPreset(event.target.value as EntityRegistrySyncFlowPreset)}
                disabled={readOnly}
                className="mt-3 w-full rounded-lg border border-border-subtle bg-panel px-3 py-2 text-sm text-text"
              >
                {(status?.draftExport.supportedFlowPresets ?? (Object.keys(FLOW_PRESET_LABELS) as EntityRegistrySyncFlowPreset[])).map((preset) => (
                  <option key={preset} value={preset}>{FLOW_PRESET_LABELS[preset] ?? preset}</option>
                ))}
              </select>
            </div>
            <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Suggested repo path</div>
              <div className="mt-2 break-all font-mono text-sm text-text">{outputPath}</div>
              <div className="mt-2 text-sm leading-6 text-text-muted">This is only the intended path for a repo file. Generate preview does not write this file.</div>
            </div>
          </div>
        </ModalShell>
      )}

      {modal === "issues" && (
        <ModalShell title="Draft status" subtitle={def.id} onClose={() => setModal(null)} widthClass="max-w-2xl" compact>
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SummaryCard label="Draft" value={reviewLabel} />
              <SummaryCard label="Owner" value={ownerLabel} />
              <SummaryCard label="Cleanup" value={blockersLabel} tone={cleanupCount === 0 ? "good" : "warn"} />
            </div>
            {cleanupCount > 0 ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/80">Needs cleanup before publish</div>
                <div className="mt-2 space-y-2 text-sm leading-6 text-amber-100">
                  {definitionStatus?.cleanupWarnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm leading-6 text-emerald-100">
                No cleanup issues are currently attached to this definition.
              </div>
            )}
            {draft?.warnings.length ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/80">Draft warnings</div>
                <div className="mt-2 space-y-2 text-sm leading-6 text-amber-100">
                  {draft.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </ModalShell>
      )}

      {modal === "migration" && (
        <ModalShell title="Migration details" subtitle={def.id} onClose={() => setModal(null)} widthClass="max-w-2xl" compact>
          <div className="space-y-4 p-5">
            <div className="text-sm leading-6 text-text-muted">
              Older migration outputs may still exist, but they are secondary to the repo draft workflow.
            </div>
            {(status?.compatibilityLayers ?? []).length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3 text-sm leading-6 text-text-muted">
                No legacy outputs are currently registered for this entity.
              </div>
            ) : (
              (status?.compatibilityLayers ?? []).map((layer) => (
                <div key={layer.id} className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{layer.title}</span>
                    <Badge tone={layer.status === "cleanup-required" ? "warn" : "neutral"}>{layerStatusLabel(layer.status)}</Badge>
                    <Badge tone={layer.runtimeAuthority ? "warn" : "neutral"}>{layer.runtimeAuthority ? "still affects runtime" : "not used at runtime"}</Badge>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-text-muted">{layer.description}</div>
                </div>
              ))
            )}
          </div>
        </ModalShell>
      )}
    </div>
  )
}

function defaultPreset(entityId: string, status: EntityRegistrySyncDefinitionStatusResponse | null): EntityRegistrySyncFlowPreset {
  const presets = status?.draftExport.supportedFlowPresets ?? []
  return (presets.includes(entityId as EntityRegistrySyncFlowPreset) ? entityId : "metadata-only") as EntityRegistrySyncFlowPreset
}

function SummaryCard({ label, value, icon, tone = "neutral" }: { label: string; value: string; icon?: ReactNode; tone?: "neutral" | "good" | "warn" }): JSX.Element {
  const toneCls = tone === "good"
    ? "border-emerald-500/30 bg-emerald-500/5"
    : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-border-subtle bg-canvas"

  return (
    <div className={`rounded-lg border px-4 py-3 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</div>
      <div className="mt-2 flex items-center gap-2 text-sm text-text">
        {icon}
        <span>{value}</span>
      </div>
    </div>
  )
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "neutral" | "good" | "warn" }): JSX.Element {
  const cls = tone === "good"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
      : "border-border-subtle bg-panel text-text-muted"
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] ${cls}`}>{children}</span>
}

function layerStatusLabel(status: "migration" | "cleanup-required"): string {
  return status === "migration" ? "migration only" : "still needs cleanup"
}