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
  STRATEGY_PRESETS,
  strategyFromForm,
} from "./strategy-helpers"

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

/** Keep Chrome / password managers from treating config fields as personal data. */
const NO_BROWSER_AUTOFILL = {
  autoComplete: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-form-type": "other",
} as const

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
  const [identityHandling, setIdentityHandling] = useState(initial.identityHandling)
  const [excludeFromDiff, setExcludeFromDiff] = useState(formatColList(initial.excludeFromDiff))
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

  const identityHint = IDENTITY_OPTIONS.find((o) => o.value === identityHandling)?.hint

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

  function applyPreset(presetId: string): void {
    const preset = STRATEGY_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    setExcludeFromDiff(formatColList(preset.strategy.excludeFromDiff))
    setOnInsertJson(JSON.stringify(preset.strategy.onInsert, null, 2))
    setOnUpdateJson(JSON.stringify(preset.strategy.onUpdate, null, 2))
    setIdentityHandling(preset.strategy.identityHandling)
  }

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
          identityHandling,
          excludeFromDiff,
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
            <form
              autoComplete="off"
              onSubmit={(e) => e.preventDefault()}
              className="contents"
            >
            <FormSectionCard title="Strategy identity" emphasized>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormFieldGroup label="Strategy id" hint={idLocked ? "Immutable after first save." : "Kebab-case tenant-private id."}>
                  <input
                    {...NO_BROWSER_AUTOFILL}
                    name="scd2-strategy-id"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    disabled={idLocked}
                    className="input w-full font-mono text-sm"
                  />
                </FormFieldGroup>
                <FormFieldGroup label="Display name">
                  <input
                    {...NO_BROWSER_AUTOFILL}
                    name="scd2-strategy-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="input w-full text-sm"
                  />
                </FormFieldGroup>
              </div>
              <FormFieldGroup label="Description">
                <textarea
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-strategy-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="input w-full text-sm"
                />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Start from preset" hint="Optional — fills the policy fields below. Edit freely after applying.">
              <div className="flex flex-wrap gap-2">
                {STRATEGY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="rounded-md border border-border-subtle px-2.5 py-1.5 text-left text-sm hover:bg-elevated"
                    onClick={() => applyPreset(p.id)}
                    title={p.description}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </FormSectionCard>

            <FormSectionCard title="Diff policy" hint="Columns listed here are excluded from row-hash comparison and not copied from source on update.">
              <FormFieldGroup label="Exclude from diff" hint="Comma-separated column names.">
                <input
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-exclude-from-diff"
                  value={excludeFromDiff}
                  onChange={(e) => setExcludeFromDiff(e.target.value)}
                  placeholder="validFrom, validTo, isLocked"
                  className="input w-full font-mono text-sm"
                />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Stamp expressions" hint="Target-dialect SQL evaluated at MERGE time. Keys are column names; values are expressions (not source bindings).">
              <FormFieldGroup label="On insert">
                <textarea
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-on-insert"
                  value={onInsertJson}
                  onChange={(e) => setOnInsertJson(e.target.value)}
                  spellCheck={false}
                  rows={4}
                  className="input w-full resize-y font-mono text-xs"
                />
              </FormFieldGroup>
              <FormFieldGroup label="On update">
                <textarea
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-on-update"
                  value={onUpdateJson}
                  onChange={(e) => setOnUpdateJson(e.target.value)}
                  spellCheck={false}
                  rows={4}
                  className="input w-full resize-y font-mono text-xs"
                />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Primary key on merge" hint="How the target identity / PK column is handled during MERGE insert.">
              <FormFieldGroup label="PK handling" hint={identityHint}>
                <Listbox value={identityHandling} onChange={setIdentityHandling} options={identityOptions} size="sm" className="w-full" ariaLabel="Primary key handling during merge" />
              </FormFieldGroup>
            </FormSectionCard>

            <FormSectionCard title="Version note">
              <FormFieldGroup label="Reason" hint="Stored in version history — required before save.">
                <input
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-version-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. tenant fork with custom audit columns"
                  className="input w-full text-sm"
                />
              </FormFieldGroup>
            </FormSectionCard>
            </form>
          </AdminModalCanvas>
        ) : (
          <AdminModalCanvas>
            <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="contents">
            <FormSectionCard title="JSON document">
              <textarea
                {...NO_BROWSER_AUTOFILL}
                name="scd2-strategy-json"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                className="input min-h-[360px] w-full resize-y font-mono text-sm"
              />
            </FormSectionCard>
            <FormSectionCard title="Version note">
              <FormFieldGroup label="Reason" hint="Stored in version history — required before save.">
                <input
                  {...NO_BROWSER_AUTOFILL}
                  name="scd2-version-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. extend onUpdate map"
                  className="input w-full text-sm"
                />
              </FormFieldGroup>
            </FormSectionCard>
            </form>
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
