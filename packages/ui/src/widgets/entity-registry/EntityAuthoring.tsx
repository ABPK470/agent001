import { Copy, Download, FileCode2, Loader2, ShieldAlert, UserRound } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"

import { api } from "../../api"
import type {
    EntityRegistryDefinition,
    EntityRegistrySyncDefinitionExportResponse,
    EntityRegistrySyncDefinitionStatusResponse,
    EntityRegistrySyncFlowPreset,
} from "../../types"

export interface EntityAuthoringProps {
  def: EntityRegistryDefinition
  status: EntityRegistrySyncDefinitionStatusResponse | null
  onMessage: (message: { kind: "error" | "success"; text: string }) => void
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

export function EntityAuthoring({ def, status, onMessage }: EntityAuthoringProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<EntityRegistrySyncFlowPreset>(defaultPreset(def.id, status))
  const [draft, setDraft] = useState<EntityRegistrySyncDefinitionExportResponse | null>(null)

  const definitionStatus = useMemo(
    () => status?.definitions.find((entry) => entry.id === def.id) ?? null,
    [status, def.id],
  )

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

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section className="rounded-lg border border-border-subtle bg-panel p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          <FileCode2 className="h-3 w-3" /> Repo Draft Export
        </div>
        <div className="space-y-3 text-xs">
          <p className="text-text-muted">
            Generate the authoritative repo-definition draft for <span className="font-mono text-text">{def.id}</span> directly from the stored Entity Registry record.
          </p>
          <label className="block space-y-1">
            <span className="text-text-muted">Flow preset</span>
            <select
              value={selectedPreset}
              onChange={(event) => setSelectedPreset(event.target.value as EntityRegistrySyncFlowPreset)}
              className="w-full rounded border border-border-subtle bg-canvas px-2 py-1.5 text-text"
            >
              {(status?.draftExport.supportedFlowPresets ?? (Object.keys(FLOW_PRESET_LABELS) as EntityRegistrySyncFlowPreset[])).map((preset) => (
                <option key={preset} value={preset}>{FLOW_PRESET_LABELS[preset] ?? preset}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void generateDraft()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded border border-border-subtle px-3 py-2 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileCode2 className="h-3 w-3" />}
            Generate Draft
          </button>
          <div className="rounded border border-border-subtle bg-canvas px-2 py-2 text-[11px] text-text-muted">
            Output path: <span className="font-mono text-text">{outputPath}</span>
          </div>
          {draft?.warnings.length ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-200">
              {draft.warnings.map((warning) => (
                <div key={warning}>• {warning}</div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border-subtle bg-panel p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          <ShieldAlert className="h-3 w-3" /> Authoring Status
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="rounded border border-border-subtle bg-canvas px-3 py-2 text-xs">
            <div className="text-text-muted">Review status</div>
            <div className="mt-1 text-text">{definitionStatus?.reviewStatus ?? "not yet authored"}</div>
          </div>
          <div className="rounded border border-border-subtle bg-canvas px-3 py-2 text-xs">
            <div className="text-text-muted">Ownership</div>
            <div className="mt-1 flex items-center gap-1 text-text">
              <UserRound className="h-3 w-3 text-text-muted" />
              <span>{definitionStatus ? `${definitionStatus.ownershipTeam}${definitionStatus.ownershipOwner ? ` · ${definitionStatus.ownershipOwner}` : " · unassigned"}` : "unassigned"}</span>
            </div>
          </div>
        </div>
        {definitionStatus?.cleanupWarnings.length ? (
          <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-200">
            {definitionStatus.cleanupWarnings.map((warning) => (
              <div key={warning}>• {warning}</div>
            ))}
          </div>
        ) : null}
        <div className="mb-3 rounded border border-border-subtle bg-canvas px-3 py-2 text-[11px] text-text-muted">
          Remaining non-authoritative compatibility layers:
          <div className="mt-2 space-y-1">
            {(status?.compatibilityLayers ?? []).map((layer) => (
              <div key={layer.id}>• {layer.title}: {layer.description}</div>
            ))}
          </div>
        </div>
        <div className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          <span className="font-medium">Draft JSON</span>
          <button
            type="button"
            onClick={copyDraft}
            disabled={!draft}
            className="ml-auto flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-40"
          >
            <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={downloadDraft}
            disabled={!draft}
            className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-40"
          >
            <Download className="h-3 w-3" /> Download
          </button>
        </div>
        <pre className="max-h-[28rem] overflow-auto rounded border border-border-subtle bg-canvas p-3 font-mono text-[11px] leading-relaxed text-text">{draft ? draftJson() : "Generate a draft to inspect the repo-owned sync definition JSON."}</pre>
      </section>
    </div>
  )
}

function defaultPreset(entityId: string, status: EntityRegistrySyncDefinitionStatusResponse | null): EntityRegistrySyncFlowPreset {
  const presets = status?.draftExport.supportedFlowPresets ?? []
  return (presets.includes(entityId as EntityRegistrySyncFlowPreset) ? entityId : "metadata-only") as EntityRegistrySyncFlowPreset
}