/**
 * Authoring surfaces for `EntityEditModal`:
 *
 *  - `FormSurface` — structured form fields for identity / schema /
 *    SCD2 / policies, plus a JSON textarea for the `tables` array.
 *  - `YamlSurface` — single-textarea editor for the full
 *    EntityDefinition body rendered as YAML.
 *
 * Plus the shared `Section` / `Field` / `AuditSection` layout
 * primitives both surfaces reuse.
 */

import { Info, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { FreezeWindowsSelect } from "./FreezeWindowsSelect"
import { StrategySelect } from "./StrategySelect"

// ── Form ──────────────────────────────────────────────────────────

export interface FormSurfaceProps {
  mode: "new" | "edit"
  id: string;              onId: (v: string) => void
  displayName: string;     onDisplayName: (v: string) => void
  description: string;     onDescription: (v: string) => void
  rootTable: string;       onRootTable: (v: string) => void
  idColumn: string;        onIdColumn: (v: string) => void
  labelColumn: string;     onLabelColumn: (v: string) => void
  selfJoinColumn: string;  onSelfJoinColumn: (v: string) => void
  strategyId: string;      onStrategyId: (v: string) => void
  strategyVersion: number | "latest"; onStrategyVersion: (v: number | "latest") => void
  approvalPolicyId: string | null;    onApprovalPolicyId: (v: string | null) => void
  freezeWindowIds: readonly string[]; onFreezeWindowIds: (v: string[]) => void
  riskMultiplier: string;  onRiskMultiplier: (v: string) => void
  tablesJson: string;      onTablesJson: (v: string) => void
  reason: string;          onReason: (v: string) => void
  versionLabel: string;    onVersionLabel: (v: string) => void
}

export function FormSurface(p: FormSurfaceProps): JSX.Element {
  return (
    <div className="space-y-4 p-5 text-xs">
      <Section title="Identity">
        <Field label="id" required mono>
          <input
            value={p.id}
            onChange={(e) => p.onId(e.target.value)}
            disabled={p.mode === "edit"}
            placeholder="my-entity"
            className="input"
          />
        </Field>
        <Field label="displayName" required>
          <input value={p.displayName} onChange={(e) => p.onDisplayName(e.target.value)} className="input" />
        </Field>
        <Field label="description" wide>
          <textarea value={p.description} onChange={(e) => p.onDescription(e.target.value)} rows={2} className="input font-sans" />
        </Field>
      </Section>

      <Section title="Schema">
        <Field label="rootTable" required mono>
          <input value={p.rootTable} onChange={(e) => p.onRootTable(e.target.value)} placeholder="core.Contract" className="input" />
        </Field>
        <Field label="idColumn" required mono>
          <input value={p.idColumn} onChange={(e) => p.onIdColumn(e.target.value)} placeholder="contractId" className="input" />
        </Field>
        <Field label="labelColumn" mono>
          <input value={p.labelColumn} onChange={(e) => p.onLabelColumn(e.target.value)} placeholder="name" className="input" />
        </Field>
        <Field label="selfJoinColumn" mono>
          <input value={p.selfJoinColumn} onChange={(e) => p.onSelfJoinColumn(e.target.value)} placeholder="(optional)" className="input" />
        </Field>
      </Section>

      <Section title="SCD2 strategy">
        <div className="sm:col-span-2">
          <StrategySelect
            strategyId={p.strategyId}
            strategyVersion={p.strategyVersion}
            onStrategyId={p.onStrategyId}
            onStrategyVersion={p.onStrategyVersion}
          />
        </div>
      </Section>

      <Section title="Policies">
        <Field label="riskMultiplier">
          <input value={p.riskMultiplier} onChange={(e) => p.onRiskMultiplier(e.target.value)} className="input" />
        </Field>
        <Field label="approvalPolicyId (advisory)">
          <input
            value={p.approvalPolicyId ?? ""}
            onChange={(e) => p.onApprovalPolicyId(e.target.value.trim() === "" ? null : e.target.value)}
            placeholder="(leave blank)"
            className="input font-mono"
          />
          <span className="flex items-center gap-1 text-[10px] text-text-faint">
            <Info className="h-3 w-3" /> approvals resolve at sync time by (target env, risk tier); this field is reserved for future policy sets
          </span>
        </Field>
        <Field label="freezeWindowIds" wide>
          <FreezeWindowsSelect
            selected={p.freezeWindowIds}
            onSelected={p.onFreezeWindowIds}
          />
        </Field>
      </Section>

      <Section title="Tables (JSON array)">
        <p className="sm:col-span-2 text-text-muted">Edit the full table array as JSON. Switch to the YAML tab above for the full body editor.</p>
        <div className="sm:col-span-2">
          <textarea
            value={p.tablesJson}
            onChange={(e) => p.onTablesJson(e.target.value)}
            rows={12}
            className="input font-mono text-[11px]"
            spellCheck={false}
          />
        </div>
      </Section>

      <AuditSection
        reason={p.reason} onReason={p.onReason}
        versionLabel={p.versionLabel} onVersionLabel={p.onVersionLabel}
      />
    </div>
  )
}

// ── YAML ──────────────────────────────────────────────────────────

export interface YamlSurfaceProps {
  loading: boolean
  body: string;   onBody: (v: string) => void
  reason: string; onReason: (v: string) => void
}

export function YamlSurface({ loading, body, onBody, reason, onReason }: YamlSurfaceProps): JSX.Element {
  return (
    <div className="space-y-3 p-5 text-xs">
      <div className="flex items-center justify-between">
        <p className="text-text-muted">
          Authoritative body for this entity. Same shape as the YAML tab of an existing entity. Server validates schema on save.
        </p>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
      </div>
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        rows={22}
        spellCheck={false}
        placeholder={"id: my-entity\ntenantId: _default\n..."}
        className="input font-mono text-[11px]"
      />
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          reason <span className="text-rose-400">*</span>
        </span>
        <input value={reason} onChange={(e) => onReason(e.target.value)} placeholder="why this change" className="input" />
      </label>
    </div>
  )
}

// ── Layout primitives ─────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <fieldset className="rounded-lg border border-border-subtle bg-panel p-3">
      <legend className="px-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">{title}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </fieldset>
  )
}

function Field({ label, children, required, mono, wide }: {
  label: string; children: React.ReactNode; required?: boolean; mono?: boolean; wide?: boolean
}): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 ${mono ? "font-mono" : ""} ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}{required && <span className="ml-1 text-rose-400">*</span>}
      </span>
      {children}
    </label>
  )
}

function AuditSection({ reason, onReason, versionLabel, onVersionLabel }: {
  reason: string; onReason: (v: string) => void
  versionLabel: string; onVersionLabel: (v: string) => void
}): JSX.Element {
  return (
    <Section title="Audit">
      <Field label="reason" required>
        <input value={reason} onChange={(e) => onReason(e.target.value)} placeholder="why this change" className="input" />
      </Field>
      <Field label="versionLabel">
        <input value={versionLabel} onChange={(e) => onVersionLabel(e.target.value)} placeholder="(optional, e.g. 'add risk-tier')" className="input" />
      </Field>
    </Section>
  )
}
