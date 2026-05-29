/**
 * Entity overview tab — key facts about an EntityDefinition presented
 * in a grouped definition-list grid. Mirrors EnvSync's information
 * density: dense, scannable, no chrome.
 */

import { Database, GitBranch, Layers, ShieldCheck } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"
import { timeAgo } from "../../util"

export interface EntityOverviewProps {
  def: EntityRegistryDefinition
}

interface Row { label: string; value: React.ReactNode; mono?: boolean }

function Section({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: Row[] }) {
  return (
    <section className="rounded-lg border border-border-subtle bg-panel p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        {icon}
        {title}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-text-muted">{r.label}</dt>
            <dd className={r.mono ? "font-mono text-text" : "text-text"}>{r.value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function EntityOverview({ def }: EntityOverviewProps): JSX.Element {
  // Defensive defaults — older API responses (pre schema enrichment)
  // may omit these arrays; treat absent as empty.
  const tables         = def.tables         ?? []
  const discrepancies  = def.discrepancies  ?? []
  const freezeWindows  = def.policies.freezeWindowIds ?? []

  const identity: Row[] = [
    { label: "ID",           value: def.id,            mono: true },
    { label: "Tenant",       value: def.tenantId,      mono: true },
    { label: "Display name", value: def.displayName },
    { label: "Description",  value: def.description || "—" },
  ]
  const schema: Row[] = [
    { label: "Root table",    value: def.rootTable,    mono: true },
    { label: "ID column",     value: def.idColumn,     mono: true },
    { label: "Label column",  value: def.labelColumn ?? "—", mono: !!def.labelColumn },
    { label: "Self-join",     value: def.selfJoinColumn ?? "—", mono: !!def.selfJoinColumn },
    { label: "Tables",        value: `${tables.length} (${tables.filter((t) => t.verified).length} verified)` },
  ]
  const scd2AndPolicy: Row[] = [
    { label: "SCD2 strategy",    value: `${def.scd2.strategyId} · v${String(def.scd2.strategyVersion)}`, mono: true },
    { label: "Freeze windows",   value: freezeWindows.join(", ") || "—" },
    { label: "Risk multiplier",  value: `${def.policies.riskMultiplier}×` },
  ]
  const provenance: Row[] = [
    { label: "Provenance",       value: def.provenance.kind, mono: true },
    { label: "Source path",      value: def.provenance.sourcePath ?? "—", mono: !!def.provenance.sourcePath },
    { label: "Template",         value: def.provenance.templateId ?? "—", mono: !!def.provenance.templateId },
    { label: "Legacy sproc",     value: def.legacyEntrySproc ?? "—", mono: !!def.legacyEntrySproc },
    { label: "Version",          value: `v${def.version}${def.versionLabel ? ` (${def.versionLabel})` : ""}` },
    { label: "Last edited",      value: `${def.createdBy} · ${timeAgo(def.createdAt)}` },
    { label: "Last reason",      value: def.reason || "—" },
  ]

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Section icon={<Database  className="h-3 w-3" />} title="Identity" rows={identity} />
      <Section icon={<Layers    className="h-3 w-3" />} title="Schema"   rows={schema} />
      <Section icon={<ShieldCheck className="h-3 w-3" />} title="SCD2 & Policies" rows={scd2AndPolicy} />
      <Section icon={<GitBranch className="h-3 w-3" />} title="Provenance" rows={provenance} />
      {discrepancies.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 xl:col-span-2">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-300">
            Discrepancies ({discrepancies.length})
          </div>
          <ul className="space-y-1 text-xs text-text">
            {discrepancies.map((d, i) => <li key={i}>• {d}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}
