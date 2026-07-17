import { ExternalLink, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState, type JSX } from "react"

import { ModalShell } from "../ModalShell"
import { FORM_HEADING, ICON_BTN, META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../chrome"
import { FormFieldGroup, FormSectionCard } from "../form-section"
import type { ServiceUrlEntry } from "./environment-form-model"

type DraftRow = ServiceUrlEntry & { rowId: string }

function createDraftRow(entry: ServiceUrlEntry, rowId?: string): DraftRow {
  return {
    ...entry,
    rowId: rowId ?? `svc-${Math.random().toString(36).slice(2, 11)}`,
  }
}

export function ServiceUrlsField({
  entries,
  readOnly,
  stackLevel,
  onChange,
}: {
  entries: ServiceUrlEntry[]
  readOnly?: boolean
  stackLevel: number
  onChange: (next: ServiceUrlEntry[]) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const configuredCount = useMemo(
    () => entries.filter((entry) => entry.url.trim()).length,
    [entries],
  )

  const handleClose = useCallback(() => setOpen(false), [])
  const handleSave = useCallback(
    (next: ServiceUrlEntry[]) => {
      onChange(next)
      setOpen(false)
    },
    [onChange],
  )

  return (
    <>
      <FormSectionCard
        title="Service URLs"
        description="Named HTTP endpoints for post-sync callbacks. Add any service — not limited to agent, ETL, or gate."
      >
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen(true)}
          className={[
            "w-full rounded-lg border border-border-subtle bg-base/30 px-3 py-3 text-left transition-colors",
            readOnly ? "cursor-default opacity-70" : "hover:bg-elevated/50",
          ].join(" ")}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">
                {configuredCount === 0
                  ? "No service URLs configured"
                  : `${configuredCount} service URL${configuredCount === 1 ? "" : "s"} configured`}
              </p>
              <p className={`${META_TEXT} mt-1`}>
                {readOnly
                  ? "View endpoints"
                  : "Opens full editor — then Save the environment to persist"}
              </p>
            </div>
            <ExternalLink size={16} className="shrink-0 text-text-muted" aria-hidden />
          </div>
          {configuredCount > 0 && (
            <ul className={`${META_TEXT} mt-3 space-y-1 font-mono`}>
              {entries
                .filter((entry) => entry.url.trim())
                .slice(0, 3)
                .map((entry) => (
                  <li key={entry.key} className="truncate text-text-faint">
                    {entry.key}: {entry.url}
                  </li>
                ))}
              {configuredCount > 3 && (
                <li className="text-text-faint">+{configuredCount - 3} more</li>
              )}
            </ul>
          )}
        </button>
      </FormSectionCard>

      {open && (
        <ServiceUrlsModal
          entries={entries}
          readOnly={readOnly}
          stackLevel={stackLevel + 1}
          onClose={handleClose}
          onSave={handleSave}
        />
      )}
    </>
  )
}

function ServiceUrlsModal({
  entries,
  readOnly,
  stackLevel,
  onClose,
  onSave,
}: {
  entries: ServiceUrlEntry[]
  readOnly?: boolean
  stackLevel: number
  onClose: () => void
  onSave: (next: ServiceUrlEntry[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState<DraftRow[]>(() =>
    entries.map((entry) => createDraftRow(entry)),
  )
  const [error, setError] = useState<string | null>(null)

  function patchEntry(index: number, fields: Partial<ServiceUrlEntry>): void {
    setDraft((current) =>
      current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...fields } : entry)),
    )
  }

  function addEntry(): void {
    setDraft((current) => [
      ...current,
      createDraftRow({ key: "", label: "", url: "" }),
    ])
  }

  function removeEntry(index: number): void {
    setDraft((current) => current.filter((_, entryIndex) => entryIndex !== index))
  }

  function validate(): string | null {
    const keys = new Set<string>()
    for (const entry of draft) {
      const key = entry.key.trim().toLowerCase()
      if (!key) return "Each row needs a service key."
      if (keys.has(key)) return `Duplicate service key "${key}".`
      keys.add(key)
    }
    return null
  }

  return (
    <ModalShell
      title={readOnly ? "Service URLs" : "Edit service URLs"}
      subtitle="Keys are lowercase identifiers used by sync flow HTTP steps. Done updates this form — Save the environment from the toolbar to persist."
      size="default"
      stackLevel={stackLevel}
      onClose={onClose}
      footer={(
        <div className="ml-auto flex gap-2">
          <button type="button" className={TEXT_BTN} onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button
              type="button"
              className={TEXT_BTN_PRIMARY}
              onClick={() => {
                const validationError = validate()
                if (validationError) {
                  setError(validationError)
                  return
                }
                setError(null)
                onSave(
                  draft.map((entry) => ({
                    key: entry.key.trim().toLowerCase(),
                    label: entry.label.trim() || entry.key.trim(),
                    url: entry.url.trim(),
                  })),
                )
              }}
            >
              Done
            </button>
          )}
        </div>
      )}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-5">
        {error && (
          <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}
        {draft.map((entry, index) => (
          <div
            key={entry.rowId}
            className="rounded-lg border border-border-subtle bg-base/20 p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className={FORM_HEADING}>{entry.label.trim() || entry.key || `Service ${index + 1}`}</h4>
              {!readOnly && (
                <button
                  type="button"
                  className={ICON_BTN}
                  title="Remove service"
                  aria-label="Remove service"
                  onClick={() => removeEntry(index)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Key" hint="Lowercase id referenced by flow HTTP steps">
                <input
                  value={entry.key}
                  disabled={readOnly}
                  onChange={(event) => patchEntry(index, { key: event.target.value })}
                  className="input font-mono text-sm"
                  placeholder="etl"
                />
              </FormFieldGroup>
              <FormFieldGroup label="Label">
                <input
                  value={entry.label}
                  disabled={readOnly}
                  onChange={(event) => patchEntry(index, { label: event.target.value })}
                  className="input text-sm"
                  placeholder="ETL service"
                />
              </FormFieldGroup>
            </div>
            <FormFieldGroup label="Base URL" hint="Full base URL including path prefix if required">
              <textarea
                value={entry.url}
                disabled={readOnly}
                onChange={(event) => patchEntry(index, { url: event.target.value })}
                rows={2}
                className="input w-full font-mono text-sm"
                placeholder="https://host:5005/etl"
              />
            </FormFieldGroup>
          </div>
        ))}

        {!readOnly && (
          <button
            type="button"
            onClick={addEntry}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle px-3 py-2 text-sm text-text-muted hover:bg-elevated/40 hover:text-text"
          >
            <Plus size={14} />
            Add service URL
          </button>
        )}
      </div>
    </ModalShell>
  )
}
