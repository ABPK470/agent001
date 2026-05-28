/**
 * EnvironmentsPanel — DEV/UAT/PROD + any tenant-defined targets.
 *
 * Environments are file-seeded (`deploy/mssql/sync-environments.json`) and
 * merged with runtime admin overrides exposed via the sync-environments API.
 * This panel is the single sync-facing environment review surface inside Sync Admin.
 */

import { Check, Database, Loader2, Shield, X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import type { EnvOperation, SyncEnvironmentAdmin } from "../../types"
import { Empty, ListItem, PanelChrome, SplitView } from "./shared"

const ALL_OPS: EnvOperation[] = [
  "query_read", "schema_introspect", "sync_preview", "sync_execute", "ddl", "dml",
]

export function EnvironmentsPanel(): JSX.Element {
  const [items,    setItems]    = useState<SyncEnvironmentAdmin[]>([])
  const [busy,     setBusy]     = useState(true)
  const [saving,   setSaving]   = useState<string | null>(null)
  const [err,      setErr]      = useState<string | null>(null)
  const [ok,       setOk]       = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<SyncEnvironmentAdmin | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const r = await api.listSyncEnvironments()
      const sorted = [...r].sort((a, b) => a.name.localeCompare(b.name))
      setItems(sorted)
      if (!selected && sorted[0]) setSelected(sorted[0].name)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function save(name: string, fields: Record<string, unknown>): Promise<void> {
    setSaving(name); setErr(null)
    try {
      await api.updateSyncEnvironment(name, fields)
      await load()
      setOk(`Saved ${name}`)
      setTimeout(() => setOk(null), 1800)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  async function reset(name: string): Promise<void> {
    setSaving(name); setErr(null)
    try {
      await api.resetSyncEnvironment(name)
      await load()
      setOk(`Reset ${name} to baseline`)
      setTimeout(() => setOk(null), 1800)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  const chosen = useMemo(() => items.find((e) => e.name === selected) ?? null, [items, selected])

  return (
    <PanelChrome
      title="Environments"
      subtitle="Source and target databases the sync platform can read or promote to."
      busy={busy} onRefresh={() => void load()} err={err} ok={ok} onClearErr={() => setErr(null)}
    >
      {items.length === 0 ? (
        <Empty title="No environments configured">
          Add entries to <code>deploy/mssql/sync-environments.json</code> to seed environments.
        </Empty>
      ) : (
        <SplitView
          list={items.map((e) => (
            <ListItem key={e.name} active={e.name === selected} onClick={() => setSelected(e.name)}>
              <div className="flex w-full items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: roleColor(e.role) }} />
                  <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text">{primaryEnvLabel(e)}</span>
                </span>
                <RoleBadge role={e.role} />
              </div>
              {secondaryEnvLabel(e) && <span className="font-mono text-[11px] text-text-muted">{secondaryEnvLabel(e)}</span>}
              <span className="text-[10px] text-text-faint">{e.defaultAccessMode === "read_only" ? "read only" : "read / write"} · {directionSummary(e.allowedSyncTargets)}{e.override ? " · override active" : ""}</span>
            </ListItem>
          ))}
          detail={chosen ? <EnvDetail env={chosen} busy={saving === chosen.name} onEdit={() => setEditing(chosen)} onReset={reset} /> : <Empty title="Pick an environment" />}
        />
      )}

      {editing && (
        <EnvEditModal
          env={editing}
          busy={saving === editing.name}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            await save(editing.name, fields)
            setEditing(null)
          }}
        />
      )}
    </PanelChrome>
  )
}

function EnvDetail({ env, busy, onEdit, onReset }: {
  env: SyncEnvironmentAdmin
  busy: boolean
  onEdit: () => void
  onReset: (name: string) => Promise<void>
}): JSX.Element {
  const lockedDown = env.defaultAccessMode === "read_only"

  return (
    <div className="space-y-5 p-5 text-xs">
      <section className="rounded-xl border border-border-subtle bg-panel p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Database className="h-4 w-4 text-text-muted" /> Environment posture
            </h4>
            <p className="mt-1 text-[12px] leading-6 text-text-muted">
              This is the live sync-facing environment policy for {primaryEnvLabel(env)}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <RoleBadge role={env.role} />
            <Pill tone={lockedDown ? "error" : "good"}>{lockedDown ? "read only" : "read / write"}</Pill>
            {env.override && <Pill tone="warn">override active</Pill>}
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border-subtle bg-canvas px-4 py-3 md:grid-cols-2">
          <Info label="stored override" value={env.override ? `${env.override.updatedBy ?? "unknown"} · ${new Date(env.override.updatedAt).toLocaleString()}` : "baseline JSON only"} />
          <Info label="direction policy" value={directionSummary(env.allowedSyncTargets)} />
          <Info label="allow-listed entities now" value={env.syncAllowlist.length > 0 ? env.syncAllowlist.join(", ") : "none"} />
          <Info label="allowed operations" value={env.allowedOperations.join(", ")} />
        </dl>
      </section>

      <section className="rounded-xl border border-border-subtle bg-panel p-4">
        <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text">
          <Shield className="h-4 w-4 text-text-muted" /> What this controls
        </h4>
        <div className="space-y-3 text-[12px] leading-6 text-text-muted">
          <p>
            Environments define direction, write posture, and entity scope for sync itself.
          </p>
          <p>
            Approval decisions belong in <span className="text-text">Sync Admin → Approvals</span> and <span className="text-text">Approval Policies</span>. They are not edited here.
          </p>
          {lockedDown && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-rose-100">
              Read-only mode is active. Write operations stay blocked unless you explicitly widen this environment in the edit modal.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/30"
            >
              Edit sync behavior
            </button>
            {env.override && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onReset(env.name)}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-40"
              >
                Reset to baseline
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="rounded border border-border-subtle bg-panel px-4 py-3 text-[11px] text-text-muted leading-6">
        Changes saved here write runtime overrides immediately. The baseline JSON file is still the seed layer, but Sync Admin is now the one place operators should use to review and change live environment behavior.
      </div>
    </div>
  )
}

function EnvEditModal({
  env,
  busy,
  onClose,
  onSave,
}: {
  env: SyncEnvironmentAdmin
  busy: boolean
  onClose: () => void
  onSave: (fields: Record<string, unknown>) => Promise<void>
}): JSX.Element {
  const [role, setRole] = useState(env.role)
  const [mode, setMode] = useState(env.defaultAccessMode)
  const [denyDml, setDenyDml] = useState(env.denyDml)
  const [denyDdl, setDenyDdl] = useState(env.denyDdl)
  const [allowed, setAllowed] = useState<EnvOperation[]>(env.allowedOperations)
  const [allowedTargetsText, setAllowedTargetsText] = useState((env.allowedSyncTargets ?? []).join(", "))
  const [syncAllowlistText, setSyncAllowlistText] = useState(env.syncAllowlist.join(", "))

  const nextTargets = parseCsv(allowedTargetsText)
  const nextAllowlist = parseCsv(syncAllowlistText)
  const dirty =
    role !== env.role ||
    mode !== env.defaultAccessMode ||
    denyDml !== env.denyDml ||
    denyDdl !== env.denyDdl ||
    JSON.stringify(allowed.slice().sort()) !== JSON.stringify(env.allowedOperations.slice().sort()) ||
    JSON.stringify(nextTargets) !== JSON.stringify((env.allowedSyncTargets ?? []).slice().sort()) ||
    JSON.stringify(nextAllowlist) !== JSON.stringify(env.syncAllowlist.slice().sort())

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-text">Edit sync behavior</h3>
            <p className="text-[11px] text-text-muted">{env.displayName} · {env.name}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-2 hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 overflow-auto px-5 py-5 text-xs">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Sync role" hint="Whether this environment can act as a source, target, or both.">
              <SegmentedRole value={role} onChange={setRole} />
            </Field>
            <Field label="Default access mode" hint="Read-only blocks write tools unless they are explicitly allowed below.">
              <div className="inline-flex rounded-lg border border-border-subtle bg-canvas p-0.5">
                {(["read_only", "read_write"] as const).map((nextMode) => (
                  <button
                    key={nextMode}
                    type="button"
                    onClick={() => setMode(nextMode)}
                    className={`rounded-md px-3 py-1.5 text-[12px] transition-colors ${mode === nextMode ? nextMode === "read_only" ? "bg-rose-500/15 text-rose-200 font-medium" : "bg-emerald-500/15 text-emerald-200 font-medium" : "text-text-muted hover:text-text"}`}
                  >
                    {nextMode === "read_only" ? "Read only" : "Read / write"}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <CheckPill label="Block DML (INSERT / UPDATE / DELETE)" checked={denyDml} onChange={setDenyDml} tone="error" />
            <CheckPill label="Block DDL (CREATE / ALTER / DROP)" checked={denyDdl} onChange={setDenyDdl} tone="error" />
          </div>

          <OpsChipGroup
            label="Allowed operations"
            hint="These are the sync-facing operations this environment permits after access mode and denial flags are applied."
            ops={allowed}
            onToggle={(op) => setAllowed((current) => current.includes(op) ? current.filter((entry) => entry !== op) : [...current, op])}
            tone="good"
          />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Allowed sync targets" hint="Comma-separated environment names. Blank means this environment cannot be used as a sync source.">
              <textarea
                value={allowedTargetsText}
                onChange={(event) => setAllowedTargetsText(event.target.value)}
                rows={3}
                placeholder="dev, uat"
                className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text"
              />
            </Field>
            <Field label="Sync allowlist" hint="Comma-separated entity ids allowed to run in this environment. Blank means no allowlist entries are defined.">
              <textarea
                value={syncAllowlistText}
                onChange={(event) => setSyncAllowlistText(event.target.value)}
                rows={3}
                placeholder="contract, dataset, content"
                className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text"
              />
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-4">
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() => void onSave({
              role,
              defaultAccessMode: mode,
              denyDml,
              denyDdl,
              allowedOperations: allowed,
              allowedSyncTargets: nextTargets,
              syncAllowlist: nextAllowlist,
            })}
            className="flex items-center gap-1.5 rounded-lg bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? "Saving…" : "Save changes"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text">
            Cancel
          </button>
          {!dirty && <span className="text-[11px] text-text-muted">No pending changes.</span>}
        </div>
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: "source" | "target" | "both" }): JSX.Element {
  const cls =
    role === "source" ? "bg-sky-500/15    text-sky-200    border-sky-500/40"
  : role === "target" ? "bg-violet-500/15 text-violet-200 border-violet-500/40"
  :                     "bg-emerald-500/15 text-emerald-200 border-emerald-500/40"
  return <span className={`inline-flex min-h-7 items-center justify-center rounded-md border px-2.5 text-[10px] font-semibold uppercase leading-none tracking-[0.14em] ${cls}`}>{role}</span>
}

function SegmentedRole({ value, onChange }: { value: SyncEnvironmentAdmin["role"]; onChange: (role: SyncEnvironmentAdmin["role"]) => void }): JSX.Element {
  return (
    <div className="inline-flex rounded-lg border border-border-subtle bg-canvas p-0.5">
      {(["source", "target", "both"] as const).map((nextRole) => (
        <button
          key={nextRole}
          type="button"
          onClick={() => onChange(nextRole)}
          className={`rounded-md px-3 py-1.5 text-[12px] transition-colors ${value === nextRole ? "bg-accent/15 text-accent font-medium" : "text-text-muted hover:text-text"}`}
        >
          {nextRole}
        </button>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      {children}
      <div className="mt-1.5 text-[11px] leading-5 text-text-muted">{hint}</div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-[12px] text-text">{value || "—"}</div>
    </div>
  )
}

function Pill({ children, tone }: { children: ReactNode; tone: "good" | "warn" | "error" }): JSX.Element {
  const cls = tone === "good"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
      : "border-rose-500/30 bg-rose-500/10 text-rose-100"
  return <span className={`inline-flex min-h-7 items-center rounded-full border px-3 text-[11px] font-medium leading-none ${cls}`}>{children}</span>
}

function CheckPill({ label, checked, onChange, tone }: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  tone: "error" | "good"
}): JSX.Element {
  const cls = checked
    ? tone === "error"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-border-subtle bg-canvas text-text-muted hover:text-text"

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] transition-colors ${cls}`}
    >
      <span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-current bg-current" : "border-current/40"}`}>
        {checked && <Check className="h-2.5 w-2.5 text-canvas" strokeWidth={3} />}
      </span>
      {label}
    </button>
  )
}

function OpsChipGroup({ label, hint, ops, onToggle, tone }: {
  label: string
  hint: string
  ops: EnvOperation[]
  onToggle: (op: EnvOperation) => void
  tone: "good" | "warn"
}): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {ALL_OPS.map((op) => {
          const on = ops.includes(op)
          const cls = on
            ? tone === "good"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
              : "border-amber-500/30 bg-amber-500/10 text-amber-100"
            : "border-border-subtle bg-canvas text-text-muted hover:text-text"
          return (
            <button
              key={op}
              type="button"
              onClick={() => onToggle(op)}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-mono transition-colors ${cls}`}
            >
              {on && <Check className="mr-1 inline h-2.5 w-2.5 -translate-y-px" strokeWidth={3} />}
              {op}
            </button>
          )
        })}
      </div>
      <div className="mt-1.5 text-[11px] leading-5 text-text-muted">{hint}</div>
    </div>
  )
}

function roleColor(role: SyncEnvironmentAdmin["role"]): string {
  return role === "source" ? "#38bdf8" : role === "target" ? "#c084fc" : "#34d399"
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

function directionSummary(allowedSyncTargets: string[] | null): string {
  if (allowedSyncTargets === null) return "any target"
  if (allowedSyncTargets.length === 0) return "no targets"
  return allowedSyncTargets.join(", ")
}

function primaryEnvLabel(env: Pick<SyncEnvironmentAdmin, "name" | "displayName">): string {
  const display = env.displayName.trim()
  const fallback = env.name.trim()
  return (display || fallback).toUpperCase()
}

function secondaryEnvLabel(env: Pick<SyncEnvironmentAdmin, "name" | "displayName">): string | null {
  const display = env.displayName.trim()
  const name = env.name.trim()
  if (!display || !name) return null
  if (display.localeCompare(name, undefined, { sensitivity: "accent" }) === 0) return null
  if (display.toLowerCase() === name.toLowerCase()) return null
  return name
}
