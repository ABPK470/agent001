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

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border-subtle bg-panel px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              <ShieldAlert className="h-3.5 w-3.5" /> Sync Definition Authoring
            </div>
            <h3 className="text-lg font-semibold text-text">Repo definition authoring for {def.displayName}</h3>
            <p className="max-w-3xl text-sm leading-6 text-text-muted">
              Entity Registry is still a structural workspace. Runtime sync behavior only changes after the repo-owned JSON definition is curated, compiled, and published.
            </p>
          </div>
          <div className="shrink-0 rounded-lg border border-border-subtle bg-canvas px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Publishability posture</div>
            <div className="mt-2 text-sm font-medium text-text">{postureLabel}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-muted">
              <Badge tone="neutral">Runtime authority: repo definition</Badge>
              <Badge tone={publishability === "ready-for-curation" ? "good" : publishability === "cleanup-required" ? "warn" : "neutral"}>
                {authored ? (reviewed ? "Reviewed" : "Review pending") : "Not authored"}
              </Badge>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(21rem,26rem)_minmax(0,1fr)]">
        <section className="rounded-xl border border-border-subtle bg-panel p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-text">
            <FileCode2 className="h-4 w-4 text-text-muted" /> Generate Repo Draft
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3 text-sm leading-6 text-text-muted">
              Generate the repo-owned draft for <span className="font-mono text-text">{def.id}</span> from the current Entity Registry record. This step prepares authored JSON; it does not change runtime behavior by itself.
            </div>

            <div className="space-y-3">
              <StepRow
                step="1"
                title="Runtime authority"
                detail="Published repo JSON under sync-definitions/published remains the live source of truth."
              />
              <StepRow
                step="2"
                title="Current authored state"
                detail={authored
                  ? `${reviewed ? "Reviewed" : "Review pending"} with ${cleanupCount} cleanup warning${cleanupCount === 1 ? "" : "s"}.`
                  : "No repo-owned draft has been authored for this entity yet."}
                tone={publishability === "ready-for-curation" ? "good" : publishability === "cleanup-required" ? "warn" : "neutral"}
              />
              <StepRow
                step="3"
                title="Next boundary"
                detail={authored
                  ? "Curate ownership, provenance, warnings, and flow; then compile and publish."
                  : "Generate a draft, review it in repo, and promote it through compile/publish."}
              />
            </div>

            <label className="block space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Flow preset</span>
              <select
                value={selectedPreset}
                onChange={(event) => setSelectedPreset(event.target.value as EntityRegistrySyncFlowPreset)}
                className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-sm text-text"
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
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3 text-sm font-medium text-text hover:bg-overlay-2 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
              Generate Draft JSON
            </button>

            <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Output path</div>
              <div className="mt-2 break-all font-mono text-sm text-text">{outputPath}</div>
            </div>

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
        </section>

        <section className="space-y-4 rounded-xl border border-border-subtle bg-panel p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-text">
                <ShieldAlert className="h-4 w-4 text-text-muted" /> Authoring Status
              </div>
              <p className="mt-1 text-sm leading-6 text-text-muted">
                Review the structural cleanup work that still stands between the Entity Registry record and a publishable repo definition.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <button
                type="button"
                onClick={copyDraft}
                disabled={!draft}
                className="flex items-center gap-1.5 rounded border border-border-subtle px-3 py-2 hover:bg-overlay-2 hover:text-text disabled:opacity-40"
              >
                <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={downloadDraft}
                disabled={!draft}
                className="flex items-center gap-1.5 rounded border border-border-subtle px-3 py-2 hover:bg-overlay-2 hover:text-text disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <InfoBlock label="Review status" value={definitionStatus?.reviewStatus ?? "not yet authored"} />
            <InfoBlock
              label="Ownership"
              value={definitionStatus ? `${definitionStatus.ownershipTeam}${definitionStatus.ownershipOwner ? ` · ${definitionStatus.ownershipOwner}` : " · unassigned"}` : "unassigned"}
              icon={<UserRound className="h-3.5 w-3.5 text-text-muted" />}
            />
          </div>

          <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">What still needs to happen</div>
            <div className="mt-2 text-sm leading-6 text-text">{postureLabel}</div>
          </div>

          {definitionStatus?.cleanupWarnings.length ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/80">Cleanup blockers</div>
              <div className="mt-2 space-y-2 text-sm leading-6 text-amber-100">
                {definitionStatus.cleanupWarnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm leading-6 text-emerald-100">
              No cleanup warnings are currently attached to this authored definition.
            </div>
          )}

          <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Compatibility layers still in tree</div>
            <div className="mt-3 space-y-3">
              {(status?.compatibilityLayers ?? []).map((layer) => (
                <div key={layer.id} className="rounded-lg border border-border-subtle bg-panel px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{layer.title}</span>
                    <Badge tone={layer.status === "cleanup-required" ? "warn" : "neutral"}>{layer.status}</Badge>
                    <Badge tone={layer.runtimeAuthority ? "good" : "neutral"}>{layer.runtimeAuthority ? "runtime authority" : "non-authoritative"}</Badge>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-text-muted">{layer.description}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-canvas">
            <div className="border-b border-border-subtle px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">Draft JSON</div>
              <div className="mt-1 text-sm text-text-muted">Inspect the generated repo-owned sync definition before curating it in repo.</div>
            </div>
            <pre className="max-h-[34rem] overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-text">{draft ? draftJson() : "Generate a draft to inspect the repo-owned sync definition JSON."}</pre>
          </div>
        </section>
      </div>
    </div>
  )
}

function defaultPreset(entityId: string, status: EntityRegistrySyncDefinitionStatusResponse | null): EntityRegistrySyncFlowPreset {
  const presets = status?.draftExport.supportedFlowPresets ?? []
  return (presets.includes(entityId as EntityRegistrySyncFlowPreset) ? entityId : "metadata-only") as EntityRegistrySyncFlowPreset
}

function StepRow({ step, title, detail, tone = "neutral" }: { step: string; title: string; detail: string; tone?: "neutral" | "good" | "warn" }): JSX.Element {
  const toneCls = tone === "good"
    ? "border-emerald-500/30 bg-emerald-500/5"
    : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-border-subtle bg-canvas"

  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 ${toneCls}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-panel font-mono text-sm text-text">
        {step}
      </div>
      <div>
        <div className="text-sm font-medium text-text">{title}</div>
        <div className="mt-1 text-sm leading-6 text-text-muted">{detail}</div>
      </div>
    </div>
  )
}

function InfoBlock({ label, value, icon }: { label: string; value: string; icon?: JSX.Element }): JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-canvas px-4 py-3">
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
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] ${cls}`}>{children}</span>
}