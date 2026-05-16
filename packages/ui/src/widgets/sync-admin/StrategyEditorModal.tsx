/**
 * StrategyEditorModal — fork-or-edit modal for SCD2 strategies.
 *
 * Two surfaces, like the entity modal:
 *   Form: just the fields a human actually authors — id, display name,
 *         description, and the only two columns the runtime currently
 *         reads (`validFromCol`, `validToCol`).
 *   YAML: the full strategy document for power users / advanced tuning
 *         of the reference-metadata fields.
 *
 * Both paths post via `saveEntityRegistryStrategy`. Forking a bundled
 * strategy auto-prefixes the id with `custom-` so the original stays
 * pristine. A reason is required for the audit trail.
 */

import { FileCode2, FormInput, Loader2, Save } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"
import { api } from "../../api"
import type { EntityRegistryStrategy } from "../../types"
import { ModalShell } from "../entity-registry/ModalShell"

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export function StrategyEditorModal({ seed, onClose, onSaved }: {
  seed: EntityRegistryStrategy
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const bundled = seed.provenance.kind === "bundled"
  const initial = useMemo<EntityRegistryStrategy>(() => (bundled ? forkOf(seed) : seed), [seed, bundled])

  const [tab,           setTab]           = useState<"form" | "yaml">("form")
  const [id,            setId]            = useState(initial.id)
  const [displayName,   setDisplayName]   = useState(initial.displayName)
  const [description,   setDescription]   = useState(initial.description)
  const [validFromCol,  setValidFromCol]  = useState(initial.validFromCol ?? "")
  const [validToCol,    setValidToCol]    = useState(initial.validToCol ?? "")
  const [body,          setBody]          = useState(() => JSON.stringify(initial, null, 2))
  const [reason,        setReason]        = useState("")
  const [busy,          setBusy]          = useState(false)
  const [err,           setErr]           = useState<string | null>(null)

  const missing: string | null = (() => {
    if (tab === "yaml") {
      if (!body.trim())    return "Body is empty"
      if (!reason.trim())  return "Add a reason"
      return null
    }
    if (!ID_RE.test(id))    return "Pick a valid id (kebab-case)"
    if (!displayName.trim())return "Add a display name"
    if (!reason.trim())     return "Add a reason"
    return null
  })()

  async function save(): Promise<void> {
    setErr(null)
    if (missing) return setErr(missing)
    let payload: EntityRegistryStrategy
    if (tab === "yaml") {
      try { payload = JSON.parse(body) as EntityRegistryStrategy }
      catch (e) { return setErr(`Parse error: ${(e as Error).message}`) }
    } else {
      payload = {
        ...initial,
        id, displayName, description,
        validFromCol, validToCol,
      }
    }
    setBusy(true)
    try { await api.saveEntityRegistryStrategy(payload, reason); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <ModalShell
      title={bundled ? `Fork ${seed.id} → custom` : `Edit ${seed.id}`}
      subtitle={bundled ? undefined : `v${seed.version} → v${seed.version + 1}`}
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <>
          {err && <span className="text-[11px] text-rose-300">{err}</span>}
          {missing && !err && !busy && (
            <span className="text-[11px] text-text-faint">{missing}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} disabled={busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text">
              Cancel
            </button>
            <button onClick={() => void save()} disabled={busy || missing !== null}
              title={missing ?? undefined}
              className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {bundled ? "Create custom" : "Save new version"}
            </button>
          </div>
        </>
      }
    >
      <nav className="flex items-center gap-0.5 border-b border-border-subtle bg-panel px-4">
        <Tab active={tab === "form"} onClick={() => setTab("form")} icon={<FormInput className="h-3 w-3" />}>Form</Tab>
        <Tab active={tab === "yaml"} onClick={() => setTab("yaml")} icon={<FileCode2 className="h-3 w-3" />}>YAML body</Tab>
      </nav>

      {tab === "form" ? (
        <div className="space-y-4 p-6 text-xs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="id">
              <input value={id} onChange={(e) => setId(e.target.value)}
                disabled={!bundled} className="input font-mono py-2 text-sm" />
            </Field>
            <Field label="Display name">
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                className="input py-2 text-sm" />
            </Field>
          </div>

          <Field label="Description">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={2} className="input font-sans py-2" />
          </Field>

          <div className="rounded-lg border border-border-subtle bg-panel/60 p-4">
            <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Runtime columns</h4>
            <p className="mb-3 text-[11px] text-text-faint">
              The only strategy fields the sync engine reads today. Leave blank to disable the corresponding stamp.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="validFromCol">
                <input value={validFromCol} onChange={(e) => setValidFromCol(e.target.value)} className="input font-mono" />
              </Field>
              <Field label="validToCol">
                <input value={validToCol} onChange={(e) => setValidToCol(e.target.value)} className="input font-mono" />
              </Field>
            </div>
          </div>

          <Field label="Reason for change">
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. tenant fork to add audit columns" className="input" />
          </Field>
        </div>
      ) : (
        <div className="flex h-full flex-col gap-3 p-6 text-xs">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false}
            className="input flex-1 min-h-[320px] resize-none font-mono text-[11px]" />
          <Field label="Reason for change">
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. extend onUpdate map" className="input" />
          </Field>
        </div>
      )}
    </ModalShell>
  )
}

function Tab({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: JSX.Element; children: string
}): JSX.Element {
  return (
    <button type="button" onClick={onClick}
      className={[
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
        active ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text",
      ].join(" ")}
    >
      {icon} {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  )
}

function forkOf(s: EntityRegistryStrategy): EntityRegistryStrategy {
  return {
    ...s,
    id:           s.id.startsWith("custom-") ? s.id : `custom-${s.id}`,
    displayName:  `${s.displayName} (custom)`,
    provenance:   { kind: "manual" },
    version:      1,
    versionLabel: "fork",
    createdBy:    "",
    createdAt:    new Date().toISOString(),
  }
}
