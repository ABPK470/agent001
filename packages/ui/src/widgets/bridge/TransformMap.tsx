/**
 * TransformMap — production Map workspace for Bridge.
 *
 * Layout:
 *   toolbar → Columns table (primary) → Rules | JSON tabs (secondary)
 *
 * Column headers must NOT use `.field-label` (display:block breaks <th>).
 */

import { Plus, Trash2 } from "lucide-react"
import { useMemo, useState, type JSX, type ReactNode } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { HELP_TEXT, META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import {
  CAST_OPTIONS,
  FILTER_OPS,
  type TransformDraft,
  formatTransformJson,
  isPassThrough,
  newColumnDraft,
  newDefaultDraft,
  newDeriveDraft,
  newFilterDraft,
  parseTransformJson,
  seedIdentityColumns,
} from "./transform-draft"
import type { CastKind, TransformFilterOp } from "@mia/shared-types"

type SecondaryTab = "rules" | "json"

const CAST_LIST: ListboxOption<CastKind | "">[] = CAST_OPTIONS.map((c) => ({
  value: c,
  label: c === "" ? "Keep as-is" : c,
}))

const FILTER_OP_LIST: ListboxOption<TransformFilterOp>[] = FILTER_OPS.map((op) => ({
  value: op,
  label: op,
}))

/** Table header cell — never use .field-label here (it forces display:block). */
const thClass =
  "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted"

const cellInput =
  "w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-sm text-text outline-none placeholder:text-text-faint focus:border-border-subtle focus:bg-base/50"

export function TransformMap({
  draft,
  onChange,
  sourceColumns,
  onSampleColumns,
  sampling,
  sourceName = null,
  targetName = null,
}: {
  draft: TransformDraft
  onChange: (next: TransformDraft) => void
  sourceColumns: readonly string[]
  onSampleColumns?: () => void
  sampling?: boolean
  sourceName?: string | null
  targetName?: string | null
  variant?: "modal" | "inline"
}): JSX.Element {
  const [tab, setTab] = useState<SecondaryTab>("rules")
  const [jsonText, setJsonText] = useState(() => formatTransformJson(draft))
  const [jsonError, setJsonError] = useState<string | null>(null)

  const passThrough = isPassThrough(draft)
  const mappedCount = draft.columns.filter((c) => c.from.trim()).length
  const rulesCount = useMemo(() => {
    return (
      draft.derive.filter((d) => d.to.trim()).length +
      draft.defaults.filter((d) => d.column.trim()).length +
      draft.filters.filter((f) => f.column.trim()).length
    )
  }, [draft])

  function setColumns(columns: TransformDraft["columns"]): void {
    onChange({ ...draft, columns })
  }

  function applyJson(): void {
    const parsed = parseTransformJson(jsonText)
    if (!parsed.ok) {
      setJsonError(parsed.error)
      return
    }
    setJsonError(null)
    onChange(parsed.draft)
  }

  const fromHint = sourceName ? `Field name on ${sourceName}` : "Field name on the source"
  const toHint = targetName ? `Field name written to ${targetName}` : "Field name written to the target"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <StatusPill
          tone={passThrough ? "neutral" : "accent"}
          label={passThrough ? "Pass-through" : `${mappedCount} column${mappedCount === 1 ? "" : "s"} mapped`}
        />
        {rulesCount > 0 && (
          <StatusPill tone="neutral" label={`${rulesCount} rule${rulesCount === 1 ? "" : "s"}`} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onSampleColumns && (
            <button type="button" className={TEXT_BTN} disabled={sampling} onClick={onSampleColumns}>
              {sampling ? "Sampling…" : "Sample columns"}
            </button>
          )}
          {sourceColumns.length > 0 && (
            <button
              type="button"
              className={TEXT_BTN}
              onClick={() => onChange(seedIdentityColumns(draft, sourceColumns))}
            >
              Map all 1∶1
            </button>
          )}
          <button
            type="button"
            className={TEXT_BTN_PRIMARY}
            onClick={() => setColumns([...draft.columns, newColumnDraft()])}
          >
            <Plus size={14} />
            Add column
          </button>
        </div>
      </div>

      {sourceColumns.length > 0 && (
        <p className={`shrink-0 ${META_TEXT}`}>
          Source fields · <span className="font-mono text-text-secondary">{sourceColumns.join(" · ")}</span>
        </p>
      )}

      {/* Columns */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-subtle bg-elevated/30">
        <header className="shrink-0 border-b border-border-subtle px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Column mappings</h3>
            <span className={META_TEXT}>
              {passThrough
                ? "No rows below → every source field is kept"
                : "Only the rows below are written to the target"}
            </span>
          </div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] text-text-muted sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="font-semibold text-text-secondary">From</dt>
              <dd>{fromHint}</dd>
            </div>
            <div>
              <dt className="font-semibold text-text-secondary">To</dt>
              <dd>{toHint}</dd>
            </div>
            <div>
              <dt className="font-semibold text-text-secondary">Cast</dt>
              <dd>Convert type (string, number, date…)</dd>
            </div>
            <div>
              <dt className="font-semibold text-text-secondary">Default</dt>
              <dd>Used when From is null or empty</dd>
            </div>
          </dl>
        </header>

        {draft.columns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">Pass-through mode</p>
            <p className={`max-w-md ${HELP_TEXT}`}>
              Nothing to map yet — source fields flow through unchanged. Sample columns to map 1∶1, or add a row to rename, cast, or set a default.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {onSampleColumns && (
                <button type="button" className={TEXT_BTN} disabled={sampling} onClick={onSampleColumns}>
                  {sampling ? "Sampling…" : "Sample source columns"}
                </button>
              )}
              <button
                type="button"
                className={TEXT_BTN_PRIMARY}
                onClick={() => setColumns([newColumnDraft()])}
              >
                <Plus size={14} />
                Add mapping
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[44rem] table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[26%]" />
                <col className="w-[18%]" />
                <col className="w-[24%]" />
                <col className="w-10" />
              </colgroup>
              <thead className="sticky top-0 z-[1] bg-elevated/95 backdrop-blur-sm">
                <tr className="border-b border-border-subtle">
                  <th className={thClass}>From</th>
                  <th className={thClass}>To</th>
                  <th className={thClass}>Cast</th>
                  <th className={thClass}>Default</th>
                  <th className="w-10 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {draft.columns.map((row, index) => (
                  <tr
                    key={row.id}
                    className="border-b border-border-subtle/70 last:border-0 hover:bg-overlay-1/40"
                  >
                    <td className="px-1.5 py-1 align-middle">
                      <FieldSuggest
                        value={row.from}
                        onChange={(from) => {
                          const next = [...draft.columns]
                          const cur = next[index]!
                          next[index] = {
                            ...cur,
                            from,
                            to: cur.to.trim() === "" || cur.to === cur.from ? from : cur.to,
                          }
                          setColumns(next)
                        }}
                        suggestions={sourceColumns}
                        placeholder="e.g. customer_id"
                        ariaLabel={`From ${index + 1}`}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <input
                        className={cellInput}
                        value={row.to}
                        onChange={(e) => {
                          const next = [...draft.columns]
                          next[index] = { ...next[index]!, to: e.target.value }
                          setColumns(next)
                        }}
                        placeholder="e.g. cust_id"
                        aria-label={`To ${index + 1}`}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <Listbox
                        value={row.cast}
                        options={CAST_LIST}
                        onChange={(cast) => {
                          const next = [...draft.columns]
                          next[index] = { ...next[index]!, cast }
                          setColumns(next)
                        }}
                        size="sm"
                        className="w-full"
                        ariaLabel={`Cast ${index + 1}`}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-middle">
                      <input
                        className={cellInput}
                        value={row.defaultText}
                        onChange={(e) => {
                          const next = [...draft.columns]
                          next[index] = { ...next[index]!, defaultText: e.target.value }
                          setColumns(next)
                        }}
                        placeholder='e.g. 0 or ""'
                        aria-label={`Default ${index + 1}`}
                      />
                    </td>
                    <td className="px-1 py-1 align-middle">
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-overlay-2 hover:text-text"
                        aria-label={`Remove mapping ${index + 1}`}
                        onClick={() => setColumns(draft.columns.filter((_, i) => i !== index))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Secondary tabs — actions stay inside the panel, above the modal footer */}
      <section className="flex max-h-[min(38vh,20rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-elevated/20">
        <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
          <TabButton active={tab === "rules"} onClick={() => setTab("rules")}>
            Rules{rulesCount > 0 ? ` · ${rulesCount}` : ""}
          </TabButton>
          <TabButton
            active={tab === "json"}
            onClick={() => {
              setTab("json")
              setJsonError(null)
              setJsonText(formatTransformJson(draft))
            }}
          >
            JSON
          </TabButton>
        </div>

        {tab === "rules" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid gap-6 lg:grid-cols-3">
              <RuleGroup
                title="Derive"
                hint="Build a new field from ${other_fields}"
                onAdd={() => onChange({ ...draft, derive: [...draft.derive, newDeriveDraft()] })}
                addLabel="Add"
              >
                {draft.derive.length === 0 ? (
                  <p className={META_TEXT}>None</p>
                ) : (
                  draft.derive.map((row, index) => (
                    <div key={row.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-1.5">
                      <input
                        className={`${cellInput} border-border-subtle/80 bg-base/40`}
                        value={row.to}
                        onChange={(e) => {
                          const next = [...draft.derive]
                          next[index] = { ...next[index]!, to: e.target.value }
                          onChange({ ...draft, derive: next })
                        }}
                        placeholder="new name"
                      />
                      <input
                        className={`${cellInput} border-border-subtle/80 bg-base/40`}
                        value={row.template}
                        onChange={(e) => {
                          const next = [...draft.derive]
                          next[index] = { ...next[index]!, template: e.target.value }
                          onChange({ ...draft, derive: next })
                        }}
                        placeholder={"row-${id}"}
                      />
                      <IconRemove
                        onClick={() =>
                          onChange({ ...draft, derive: draft.derive.filter((_, i) => i !== index) })
                        }
                      />
                    </div>
                  ))
                )}
              </RuleGroup>

              <RuleGroup
                title="Defaults"
                hint="Fill a field after mapping if still empty"
                onAdd={() => onChange({ ...draft, defaults: [...draft.defaults, newDefaultDraft()] })}
                addLabel="Add"
              >
                {draft.defaults.length === 0 ? (
                  <p className={META_TEXT}>None</p>
                ) : (
                  draft.defaults.map((row, index) => (
                    <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                      <FieldSuggest
                        value={row.column}
                        onChange={(column) => {
                          const next = [...draft.defaults]
                          next[index] = { ...next[index]!, column }
                          onChange({ ...draft, defaults: next })
                        }}
                        suggestions={sourceColumns}
                        placeholder="field"
                        bordered
                      />
                      <input
                        className={`${cellInput} border-border-subtle/80 bg-base/40`}
                        value={row.valueText}
                        onChange={(e) => {
                          const next = [...draft.defaults]
                          next[index] = { ...next[index]!, valueText: e.target.value }
                          onChange({ ...draft, defaults: next })
                        }}
                        placeholder="value"
                      />
                      <IconRemove
                        onClick={() =>
                          onChange({
                            ...draft,
                            defaults: draft.defaults.filter((_, i) => i !== index),
                          })
                        }
                      />
                    </div>
                  ))
                )}
              </RuleGroup>

              <RuleGroup
                title="Filters"
                hint="Keep a row only if every rule passes"
                onAdd={() => onChange({ ...draft, filters: [...draft.filters, newFilterDraft()] })}
                addLabel="Add"
              >
                {draft.filters.length === 0 ? (
                  <p className={META_TEXT}>None</p>
                ) : (
                  draft.filters.map((row, index) => {
                    const needsValue = row.op !== "exists" && row.op !== "empty"
                    return (
                      <div key={row.id} className="grid grid-cols-[1fr_5.5rem_1fr_auto] gap-1.5">
                        <FieldSuggest
                          value={row.column}
                          onChange={(column) => {
                            const next = [...draft.filters]
                            next[index] = { ...next[index]!, column }
                            onChange({ ...draft, filters: next })
                          }}
                          suggestions={sourceColumns}
                          placeholder="field"
                          bordered
                        />
                        <Listbox
                          value={row.op}
                          options={FILTER_OP_LIST}
                          onChange={(op) => {
                            const next = [...draft.filters]
                            next[index] = { ...next[index]!, op }
                            onChange({ ...draft, filters: next })
                          }}
                          size="sm"
                          className="w-full"
                          ariaLabel={`Filter op ${index + 1}`}
                        />
                        <input
                          className={`${cellInput} border-border-subtle/80 bg-base/40`}
                          value={row.valueText}
                          disabled={!needsValue}
                          onChange={(e) => {
                            const next = [...draft.filters]
                            next[index] = { ...next[index]!, valueText: e.target.value }
                            onChange({ ...draft, filters: next })
                          }}
                          placeholder={needsValue ? "value" : "—"}
                        />
                        <IconRemove
                          onClick={() =>
                            onChange({
                              ...draft,
                              filters: draft.filters.filter((_, i) => i !== index),
                            })
                          }
                        />
                      </div>
                    )
                  })
                )}
              </RuleGroup>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
              <p className={`mb-2 ${HELP_TEXT}`}>
                For agents and scripts. Apply replaces the Map form; invalid JSON is rejected.
              </p>
              <textarea
                className="input mb-3 min-h-[9rem] w-full font-mono text-xs leading-relaxed"
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value)
                  setJsonError(null)
                }}
                spellCheck={false}
              />
              {jsonError && <p className="mb-2 text-xs text-rose-400">{jsonError}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t border-border-subtle bg-elevated/40 px-4 py-3">
              <button type="button" className={TEXT_BTN_PRIMARY} onClick={applyJson}>
                Apply JSON
              </button>
              <button
                type="button"
                className={TEXT_BTN}
                onClick={() => {
                  setJsonError(null)
                  setJsonText(formatTransformJson(draft))
                }}
              >
                Refresh from Map
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: "neutral" | "accent"
}): JSX.Element {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "accent" ? "bg-accent/12 text-accent" : "bg-overlay-2 text-text-secondary",
      ].join(" ")}
    >
      {label}
    </span>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-overlay-2 text-text" : "text-text-muted hover:bg-overlay-1 hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

function RuleGroup({
  title,
  hint,
  onAdd,
  addLabel,
  children,
}: {
  title: string
  hint: string
  onAdd: () => void
  addLabel: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-text">{title}</h4>
          <p className={META_TEXT}>{hint}</p>
        </div>
        <button type="button" className={TEXT_BTN} onClick={onAdd}>
          <Plus size={13} />
          {addLabel}
        </button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function IconRemove({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-overlay-2 hover:text-text"
      onClick={onClick}
      aria-label="Remove"
    >
      <Trash2 size={14} />
    </button>
  )
}

function FieldSuggest({
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
  bordered,
}: {
  value: string
  onChange: (v: string) => void
  suggestions: readonly string[]
  placeholder?: string
  ariaLabel?: string
  bordered?: boolean
}): JSX.Element {
  const listId = ariaLabel ? `${ariaLabel.replace(/\s+/g, "-")}-list` : undefined
  return (
    <>
      <input
        className={bordered ? `${cellInput} border-border-subtle/80 bg-base/40` : cellInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        list={suggestions.length > 0 ? listId : undefined}
      />
      {suggestions.length > 0 && listId && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  )
}
