/**
 * Authoring surfaces for `EntityEditModal`.
 *
 * The Form surface is built around a single principle: humans should
 * not type identifiers. The operator picks a real-world root table,
 * and we silently derive `id`, `displayName`, and `idColumn` from it.
 * Those derived fields live inside the *Identifiers* disclosure for
 * power users who need to override them — the day-one user never
 * sees them.
 *
 * Required-ness is communicated by the disabled Save button (which
 * names what's missing) rather than red asterisks on every label.
 */

import { ChevronDown, FileCode2, Loader2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useState } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { EntityRegistrySyncFlowPreset } from "../../types"
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
  flowPreset: EntityRegistrySyncFlowPreset; onFlowPreset: (v: EntityRegistrySyncFlowPreset) => void
  flowPresetOptions: ListboxOption<EntityRegistrySyncFlowPreset>[]
  serviceProfileRef: string; onServiceProfileRef: (v: string) => void
  serviceProfileOptions: ListboxOption<string>[]
  environmentPolicyRef: string; onEnvironmentPolicyRef: (v: string) => void
  environmentPolicyOptions: ListboxOption<string>[]
  runtimeLoading: boolean
  reason: string;          onReason: (v: string) => void
  versionLabel: string;    onVersionLabel: (v: string) => void
}

export function FormSurface(p: FormSurfaceProps): JSX.Element {
  return (
    <div className="space-y-4 p-6 text-xs">
      {/* ── Basics ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BigField label="Root table">
          <input
            value={p.rootTable}
            onChange={(e) => p.onRootTable(e.target.value)}
            placeholder="schema.TableName"
            className="input font-mono text-sm py-2.5"
            autoFocus={p.mode === "new"}
          />
        </BigField>

        <BigField label="Display name">
          <input
            value={p.displayName}
            onChange={(e) => p.onDisplayName(e.target.value)}
            placeholder=""
            className="input py-2.5"
          />
        </BigField>
      </div>

      <BigField label="Description">
        <textarea
          value={p.description}
          onChange={(e) => p.onDescription(e.target.value)}
          rows={2}
          placeholder=""
          className="input font-sans py-2"
        />
      </BigField>

      {/* ── Advanced disclosures ───────────────────────────────── */}
      <Disclosure
        title="Identifiers"
        summary={summary([
          ["id",       p.id || "—"],
          ["idColumn", p.idColumn || "—"],
          p.labelColumn ? ["labelColumn", p.labelColumn] : null,
        ])}
        defaultOpen={p.mode === "edit"}
      >
        <Grid2>
          <Field label="id" mono>
            <input
              value={p.id}
              onChange={(e) => p.onId(e.target.value)}
              disabled={p.mode === "edit"}
              className="input"
            />
          </Field>
          <Field label="idColumn" mono>
            <input value={p.idColumn} onChange={(e) => p.onIdColumn(e.target.value)} className="input" />
          </Field>
          <Field label="labelColumn" mono>
            <input value={p.labelColumn} onChange={(e) => p.onLabelColumn(e.target.value)} placeholder="optional" className="input" />
          </Field>
          <Field label="selfJoinColumn" mono>
            <input value={p.selfJoinColumn} onChange={(e) => p.onSelfJoinColumn(e.target.value)} placeholder="optional" className="input" />
          </Field>
        </Grid2>
      </Disclosure>

      <Disclosure
        title="SCD2 strategy"
        summary={`${p.strategyId} · ${p.strategyVersion === "latest" ? "latest" : `v${p.strategyVersion}`}`}
      >
        <StrategySelect
          strategyId={p.strategyId}
          strategyVersion={p.strategyVersion}
          onStrategyId={p.onStrategyId}
          onStrategyVersion={p.onStrategyVersion}
        />
      </Disclosure>

      <Disclosure
        title="Sync behavior"
        summary={summary([
          ["mode", p.flowPreset],
          ["service", p.serviceProfileRef || "default"],
          ["env", p.environmentPolicyRef || "default"],
        ])}
        defaultOpen
      >
        {p.runtimeLoading ? (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> loading current runtime config…
          </div>
        ) : (
          <Grid2>
            <Field label="Sync behavior">
              <Listbox value={p.flowPreset} options={p.flowPresetOptions} onChange={p.onFlowPreset} className="w-full" ariaLabel="Sync behavior" />
            </Field>
            <Field label="Service profile">
              <Listbox value={p.serviceProfileRef} options={p.serviceProfileOptions} onChange={p.onServiceProfileRef} className="w-full" ariaLabel="Service profile" />
            </Field>
            <Field label="Environment rules">
              <Listbox value={p.environmentPolicyRef} options={p.environmentPolicyOptions} onChange={p.onEnvironmentPolicyRef} className="w-full" ariaLabel="Environment rules" />
            </Field>
          </Grid2>
        )}
      </Disclosure>

      <Disclosure
        title="Sync policies"
        summary={summary([
          ["risk×",         p.riskMultiplier],
          p.approvalPolicyId ? ["approval", p.approvalPolicyId] : null,
          p.freezeWindowIds.length ? ["freezes", `${p.freezeWindowIds.length}`] : null,
        ])}
      >
        <Grid2>
          <Field label="Risk multiplier">
            <input value={p.riskMultiplier} onChange={(e) => p.onRiskMultiplier(e.target.value)} className="input" />
          </Field>
          <Field label="Approval policy id">
            <input
              value={p.approvalPolicyId ?? ""}
              onChange={(e) => p.onApprovalPolicyId(e.target.value.trim() === "" ? null : e.target.value)}
              placeholder="(leave blank)"
              className="input font-mono"
            />
          </Field>
        </Grid2>
        <div className="mt-3">
          <FieldLabel label="Freeze windows" />
          <FreezeWindowsSelect
            selected={p.freezeWindowIds}
            onSelected={p.onFreezeWindowIds}
          />
        </div>
      </Disclosure>

      <Disclosure
        title="Tables (advanced JSON)"
        summary={tablesSummary(p.tablesJson)}
        icon={<FileCode2 className="h-3 w-3 text-text-faint" />}
      >
        <textarea
          value={p.tablesJson}
          onChange={(e) => p.onTablesJson(e.target.value)}
          rows={10}
          className="input font-mono text-[11px]"
          spellCheck={false}
        />
      </Disclosure>

      {/* ── Audit ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border-subtle bg-panel/60 p-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Reason for change">
          <input
            value={p.reason}
            onChange={(e) => p.onReason(e.target.value)}
            placeholder="e.g. add risk-tier column"
            className="input"
          />
        </Field>
        <Field label="Version label">
          <input
            value={p.versionLabel}
            onChange={(e) => p.onVersionLabel(e.target.value)}
            placeholder="optional"
            className="input"
          />
        </Field>
      </div>
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
    <div className="flex h-full flex-col gap-3 p-6 text-xs">
      {loading && (
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> loading…
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        spellCheck={false}
        placeholder={"id: my-entity\ntenantId: _default\n..."}
        className="input flex-1 min-h-0 resize-none font-mono text-[11px]"
      />
      <Field label="Reason for change">
        <input value={reason} onChange={(e) => onReason(e.target.value)} placeholder="e.g. backfill schema" className="input" />
      </Field>
    </div>
  )
}

// ── Layout primitives ─────────────────────────────────────────────

function BigField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text">{label}</span>
      {children}
    </label>
  )
}

function Disclosure({ title, summary, defaultOpen, icon, children }: {
  title: string; summary: string; defaultOpen?: boolean; icon?: ReactNode; children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <section className="rounded-lg border border-border-subtle bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-overlay-2/40"
      >
        <span className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-xs font-medium text-text">{title}</span>
          <span className="truncate text-[11px] text-text-faint">· {summary}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-border-subtle p-4">{children}</div>}
    </section>
  )
}

function Grid2({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
}

function FieldLabel({ label }: { label: string }): JSX.Element {
  return (
    <span className="mb-1 block text-[10px] uppercase tracking-wider text-text-muted">
      {label}
    </span>
  )
}

function Field({ label, children, mono }: {
  label: string; children: ReactNode; mono?: boolean
}): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 ${mono ? "font-mono" : ""}`}>
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

// ── Summary helpers ───────────────────────────────────────────────

function summary(pairs: ([string, string] | null)[]): string {
  const live = pairs.filter((p): p is [string, string] => p !== null && p[1] !== "")
  return live.length === 0 ? "defaults" : live.map(([k, v]) => `${k}: ${v}`).join(" · ")
}

function tablesSummary(json: string): string {
  try {
    const arr = JSON.parse(json) as unknown
    return Array.isArray(arr) ? `${arr.length} table${arr.length === 1 ? "" : "s"}` : "invalid JSON"
  } catch { return "invalid JSON" }
}
