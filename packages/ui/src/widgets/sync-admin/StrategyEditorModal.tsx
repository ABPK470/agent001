/**
 * StrategyEditorModal — create, fork, or version a tenant SCD2 strategy.
 */

import { FileCode2, FormInput, Loader2, Save } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { EntityRegistryStrategy } from "../../types"
import {
  Err,
  ModalBtnPrimary,
  ModalBtnSecondary,
  ModalShell,
} from "./chrome"
import { TAB_PILL } from "./design"
import {
  AdminModalCanvas,
  AdminModalIntro,
  AdminModalRoot,
  FormFieldGroup,
  FormSectionCard,
} from "./modal-layout"
import {
  forkOfBundled,
  formatColList,
  IDENTITY_OPTIONS,
  strategyFromForm,
} from "./strategy-helpers"

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

type EditorMode = "create" | "fork" | "edit"

export function StrategyEditorModal({ seed, mode, onClose, onSaved }: {
  seed: EntityRegistryStrategy
  mode: EditorMode
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const initial = useMemo<EntityRegistryStrategy>(() => {
    if (mode === "fork") return forkOfBundled(seed)
    if (mode === "create") return seed
    return seed
  }, [seed, mode])

  const [tab, setTab] = useState<"form" | "json">("form")
  const [id, setId] = useState(initial.id)
  const [displayName, setDisplayName] = useState(initial.displayName)
  const [description, setDescription] = useState(initial.description)
  const [validFromCol, setValidFromCol] = useState(initial.validFromCol ?? "")
  const [validToCol, setValidToCol] = useState(initial.validToCol ?? "")
  const [isLockedCol, setIsLockedCol] = useState(initial.isLockedCol ?? "")
  const [syncDateCol, setSyncDateCol] = useState(initial.syncDateCol ?? "")
  const [deployDateCol, setDeployDateCol] = useState(initial.deployDateCol ?? "")
  const [identityHandling, setIdentityHandling] = useState(initial.identityHandling)
  const [excludedFromDiffCols, setExcludedFromDiffCols] = useState(formatColList(initial.excludedFromDiffCols))
  const [onInsertJson, setOnInsertJson] = useState(() => JSON.stringify(initial.onInsert, null, 2))
  const [onUpdateJson, setOnUpdateJson] = useState(() => JSON.stringify(initial.onUpdate, null, 2))
  const [body, setBody] = useState(() => JSON.stringify(initial, null, 2))
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const idLocked = mode === "edit"
  const title =
    mode === "fork" ? `Fork ${seed.id} → custom`
    : mode === "create" ? "New custom strategy"
    : `Edit ${seed.id}`

  const missing: string | null = (() => {
    if (tab === "json") {
      if (!body.trim()) return "Document body is empty"
      if (!reason.trim()) return "Add a reason"
      return null
    }
    if (!ID_RE.test(id)) return "Pick a valid id (kebab-case, starts with a letter)"
    if (!displayName.trim()) return "Add a display name"
    if (!reason.trim()) return "Add a reason"
    return null
  })()

  async function save(): Promise<void> {
    setErr(null)
    if (missing) return setErr(missing)
    let payload: EntityRegistryStrategy
    if (tab === "json") {
      try { payload = JSON.parse(body) as EntityRegistryStrategy }
      catch (e) { return setErr(`Parse error: ${(e as Error).message}`) }
    } else {
      try {
        payload = strategyFromForm({
          initial,
          id,
          displayName,
          description,
          validFromCol,
          validToCol,
          isLockedCol,
          syncDateCol,
          deployDateCol,
          identityHandling,
          excludedFromDiffCols,
          onInsertJson,
          onUpdateJson,
        })
      } catch (e) {
        return setErr((e as Error).message)
      }
    }
    setBusy(true)
    try {
      await api.saveEntityRegistryStrategy(payload, reason)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const identityOptions: ListboxOption<EntityRegistryStrategy["identityHandling"]>[] = IDENTITY_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
  }))

  return (
    <ModalShell
      title={title}
      subtitle={mode === "edit" ? `v${seed.version} → v${seed.version + 1}` : undefined}
      size="focus"
      onClose={onClose}
      footer={
        <>
          <ModalBtnSecondary onClick={onClose} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto flex items-center gap-3">
            {missing && !err && !busy && (
              <span className="text-sm text-text-muted">{missing}</span>
            )}
            <ModalBtnPrimary disabled={busy || missing !== null} onClick={() => void save()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {mode === "edit" ? "Save new version" : "Create custom"}
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        {err && <Err>{err}</Err>}

        <AdminModalIntro>
          <div className="inline-flex items-center gap-1" role="tablist">
            <TabPill active={tab === "form"} onClick={() => setTab("form")} icon={<FormInput size={14} />}>Form</TabPill>
            <TabPill active={tab === "json"} onClick={() => setTab("json")} icon={<FileCode2 size={14} />}>JSON document</TabPill>
          </div>
        </AdminModalIntro>

        {tab === "form" ? (
          <AdminModalCanvas>
            <FormSectionCard title="Strategy identity" emphasized>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormFieldGroup label="Id" hint={idLocked ? "Immutable after first save." : "Kebab-case tenant-private id."}>
                  <input value={id} onChange={(e) => setId(e.target.value)} disabled={idLocked} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
                <FormFieldGroup label="Display name">
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input w-full text-sm" />
                </FormFieldGroup>
              </div>
              <FormFieldGroup label="Description">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input w-full text-sm" />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Validity columns">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormFieldGroup label="validFromCol">
                  <input value={validFromCol} onChange={(e) => setValidFromCol(e.target.value)} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
                <FormFieldGroup label="validToCol">
                  <input value={validToCol} onChange={(e) => setValidToCol(e.target.value)} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
              </div>
            </FormSectionCard>

            <FormSectionCard title="Meta columns">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormFieldGroup label="isLockedCol">
                  <input value={isLockedCol} onChange={(e) => setIsLockedCol(e.target.value)} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
                <FormFieldGroup label="syncDateCol">
                  <input value={syncDateCol} onChange={(e) => setSyncDateCol(e.target.value)} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
                <FormFieldGroup label="deployDateCol">
                  <input value={deployDateCol} onChange={(e) => setDeployDateCol(e.target.value)} className="input w-full font-mono text-sm" />
                </FormFieldGroup>
              </div>
            </FormSectionCard>

            <FormSectionCard title="Behavior">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormFieldGroup label="identityHandling">
                  <Listbox value={identityHandling} onChange={setIdentityHandling} options={identityOptions} size="sm" className="w-full" ariaLabel="Identity handling" />
                </FormFieldGroup>
                <FormFieldGroup label="excludedFromDiffCols" hint="Comma-separated column names.">
                  <input value={excludedFromDiffCols} onChange={(e) => setExcludedFromDiffCols(e.target.value)} placeholder="validFrom, validTo, isLocked" className="input w-full font-mono text-sm" />
                </FormFieldGroup>
              </div>
            </FormSectionCard>

            <FormSectionCard title="Stamp expressions">
              <FormFieldGroup label="onInsert">
                <textarea value={onInsertJson} onChange={(e) => setOnInsertJson(e.target.value)} spellCheck={false} rows={4} className="input w-full resize-y font-mono text-xs" />
              </FormFieldGroup>
              <FormFieldGroup label="onUpdate">
                <textarea value={onUpdateJson} onChange={(e) => setOnUpdateJson(e.target.value)} spellCheck={false} rows={4} className="input w-full resize-y font-mono text-xs" />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Version note">
              <FormFieldGroup label="Reason" hint="Stored in version history — required before save.">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. tenant fork with custom audit columns" className="input w-full text-sm" />
              </FormFieldGroup>
            </FormSectionCard>
          </AdminModalCanvas>
        ) : (
          <AdminModalCanvas>
            <FormSectionCard title="JSON document">
              <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} className="input min-h-[360px] w-full resize-y font-mono text-sm" />
            </FormSectionCard>
            <FormSectionCard title="Version note">
              <FormFieldGroup label="Reason" hint="Stored in version history — required before save.">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. extend onUpdate map" className="input w-full text-sm" />
              </FormFieldGroup>
            </FormSectionCard>
          </AdminModalCanvas>
        )}
      </AdminModalRoot>
    </ModalShell>
  )
}

function TabPill({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: JSX.Element; children: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        TAB_PILL,
        "inline-flex items-center gap-1.5",
        active ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-elevated hover:text-text",
      ].join(" ")}
    >
      {icon} {children}
    </button>
  )
}
