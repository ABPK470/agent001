/**
 * EntityEditModal — admin-only New/Edit form for an EntityDefinition.
 *
 * Modes:
 *  - "new":  empty starting state, id field editable
 *  - "edit": pre-populated from an existing definition, id locked
 *
 * Covers the core identity fields + SCD2 strategy ref + policies +
 * YAML editor for the tables array (full structural authoring of the
 * tables list is heavy enough that a YAML pane is the cleanest UX
 * for now; later we can layer a per-table form on top).
 *
 * Every save requires a `reason` string. The server stamps the version,
 * `createdBy`, and `createdAt`.
 */

import { AlertTriangle, Loader2, Save } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"
import { api } from "../../api"
import type { EntityRegistryDefinition } from "../../types"
import { ModalShell } from "./ModalShell"

export interface EntityEditModalProps {
  mode: "new" | "edit"
  initial: EntityRegistryDefinition | null
  onClose: () => void
  onSaved: (id: string, version: number) => void
}

function emptyDef(): EntityRegistryDefinition {
  return {
    id:             "",
    tenantId:       "_default",
    displayName:    "",
    description:    "",
    rootTable:      "",
    idColumn:       "",
    labelColumn:    null,
    selfJoinColumn: null,
    tables:         [],
    policies:       { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1.0 },
    scd2:           { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
    lineageRefs:    [],
    provenance:     { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder:   [],
    discrepancies:  [],
    version:        0,
    versionLabel:   null,
    createdBy:      "",
    reason:         "",
    createdAt:      "",
    retiredAt:      null,
  }
}

export function EntityEditModal({ mode, initial, onClose, onSaved }: EntityEditModalProps): JSX.Element {
  const seed = useMemo<EntityRegistryDefinition>(() => initial ?? emptyDef(), [initial])

  const [id,            setId]            = useState(seed.id)
  const [displayName,   setDisplayName]   = useState(seed.displayName)
  const [description,   setDescription]   = useState(seed.description)
  const [rootTable,     setRootTable]     = useState(seed.rootTable)
  const [idColumn,      setIdColumn]      = useState(seed.idColumn)
  const [labelColumn,   setLabelColumn]   = useState(seed.labelColumn ?? "")
  const [selfJoinColumn,setSelfJoinColumn]= useState(seed.selfJoinColumn ?? "")
  const [strategyId,    setStrategyId]    = useState(seed.scd2.strategyId)
  const [riskMultiplier,setRiskMultiplier]= useState(String(seed.policies.riskMultiplier))
  const [tablesJson,    setTablesJson]    = useState(JSON.stringify(seed.tables, null, 2))
  const [reason,        setReason]        = useState("")
  const [versionLabel,  setVersionLabel]  = useState("")
  const [busy,          setBusy]          = useState(false)
  const [err,           setErr]           = useState<string | null>(null)

  async function doSave() {
    setErr(null)
    if (!id.trim()        || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) return setErr("id: lower-snake-case, 1–64 chars, must start with a letter")
    if (!displayName.trim()) return setErr("displayName is required")
    if (!rootTable.trim())   return setErr("rootTable is required (schema-qualified, e.g. core.Contract)")
    if (!idColumn.trim())    return setErr("idColumn is required")
    if (!reason.trim())      return setErr("reason is required (saved with the audit trail)")

    let tables: EntityRegistryDefinition["tables"]
    try { tables = JSON.parse(tablesJson) }
    catch (e) { return setErr(`tables JSON parse error: ${(e as Error).message}`) }
    if (!Array.isArray(tables)) return setErr("tables must be a JSON array")

    const riskNum = Number(riskMultiplier)
    if (!Number.isFinite(riskNum) || riskNum <= 0) return setErr("riskMultiplier must be a positive number")

    const def: EntityRegistryDefinition = {
      ...seed,
      id,
      displayName,
      description,
      rootTable,
      idColumn,
      labelColumn:    labelColumn.trim()    || null,
      selfJoinColumn: selfJoinColumn.trim() || null,
      tables,
      policies: { ...seed.policies, riskMultiplier: riskNum },
      scd2:     { ...seed.scd2, strategyId },
    }

    setBusy(true)
    try {
      const r = await api.saveEntityRegistry(def, reason, versionLabel.trim() ? { versionLabel } : undefined)
      onSaved(r.id, r.version)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title={mode === "new" ? "New entity" : `Edit entity · ${seed.id}`}
      subtitle={mode === "edit" ? `v${seed.version} → v${seed.version + 1}` : undefined}
      onClose={onClose}
      widthClass="max-w-4xl"
      footer={
        <>
          {err && (
            <div className="flex items-center gap-2 text-xs text-rose-300">
              <AlertTriangle className="h-3 w-3" /> {err}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
            >Cancel</button>
            <button
              type="button"
              onClick={() => void doSave()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {mode === "new" ? "Create" : "Save new version"}
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-4 p-5 text-xs">
        <Section title="Identity">
          <Field label="id" required mono>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={mode === "edit"}
              placeholder="my-entity"
              className="input"
            />
          </Field>
          <Field label="displayName" required>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
          </Field>
          <Field label="description">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input font-sans" />
          </Field>
        </Section>

        <Section title="Schema">
          <Field label="rootTable" required mono><input value={rootTable} onChange={(e) => setRootTable(e.target.value)} placeholder="core.Contract" className="input" /></Field>
          <Field label="idColumn" required mono><input value={idColumn} onChange={(e) => setIdColumn(e.target.value)} placeholder="contractId" className="input" /></Field>
          <Field label="labelColumn" mono><input value={labelColumn} onChange={(e) => setLabelColumn(e.target.value)} placeholder="name" className="input" /></Field>
          <Field label="selfJoinColumn" mono><input value={selfJoinColumn} onChange={(e) => setSelfJoinColumn(e.target.value)} placeholder="(optional)" className="input" /></Field>
        </Section>

        <Section title="SCD2 & Policies">
          <Field label="scd2.strategyId" mono><input value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className="input" /></Field>
          <Field label="riskMultiplier"><input value={riskMultiplier} onChange={(e) => setRiskMultiplier(e.target.value)} className="input" /></Field>
        </Section>

        <Section title="Tables (JSON array)">
          <p className="text-text-muted">Edit the full table array as JSON. The server validates schema on save.</p>
          <textarea
            value={tablesJson}
            onChange={(e) => setTablesJson(e.target.value)}
            rows={14}
            className="input font-mono text-[11px]"
            spellCheck={false}
          />
        </Section>

        <Section title="Audit">
          <Field label="reason" required>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this change" className="input" />
          </Field>
          <Field label="versionLabel">
            <input value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} placeholder="(optional, e.g. 'add risk-tier')" className="input" />
          </Field>
        </Section>
      </div>
    </ModalShell>
  )
}

// ── Layout primitives ────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-border-subtle bg-panel p-3">
      <legend className="px-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">{title}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </fieldset>
  )
}

function Field({ label, children, required, mono }: {
  label: string; children: React.ReactNode; required?: boolean; mono?: boolean
}) {
  return (
    <label className={`flex flex-col gap-1 ${mono ? "font-mono" : ""} ${label === "description" || label === "Tables (JSON array)" ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}{required && <span className="ml-1 text-rose-400">*</span>}
      </span>
      {children}
    </label>
  )
}
