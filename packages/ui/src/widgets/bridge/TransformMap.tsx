/**
 * TransformMap — Map workspace for Bridge.
 *
 * Layout:
 *   toolbar (status + actions + Form|JSON toggle)
 *   form pane: collapsible Columns + collapsible Rules
 *   optional JSON pane (split right when toggle is JSON)
 *
 * JSON is the full transform document — not a peer tab of Rules.
 */

import type { CastKind, TransformFilterOp } from "@mia/shared-types"
import { ArrowLeftRight, ChevronDown, Columns3, Loader2, Plus, Trash2 } from "lucide-react"
import { useMemo, useState, type JSX, type ReactNode } from "react"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { HELP_TEXT, META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { IconButton, TOOLBAR_ICON } from "../entity-registry/IconButton"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import { WIDGET_ICONS } from "../widget-icons"
import {
  CAST_OPTIONS,
  FILTER_OPS,
  formatTransformJson,
  isPassThrough,
  newColumnDraft,
  newDefaultDraft,
  newDeriveDraft,
  newFilterDraft,
  parseTransformJson,
  seedIdentityColumns,
  type TransformDraft,
} from "./transform-draft"

type ViewMode = "form" | "json"

const CAST_LIST: ListboxOption<CastKind | "">[] = CAST_OPTIONS.map((c) => ({
  value: c,
  label: c === "" ? "Keep as-is" : c,
}))

const FILTER_OP_LIST: ListboxOption<TransformFilterOp>[] = FILTER_OPS.map((op) => ({
  value: op,
  label: op,
}))

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
}: {
  draft: TransformDraft
  onChange: (next: TransformDraft) => void
  sourceColumns: readonly string[]
  onSampleColumns?: () => void
  sampling?: boolean
  variant?: "modal" | "inline"
}): JSX.Element {
  const [view, setView] = useState<ViewMode>("form")
  const [columnsOpen, setColumnsOpen] = useState(true)
  const [rulesOpen, setRulesOpen] = useState(true)
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

  function setViewMode(next: ViewMode): void {
    if (next === "json") {
      setJsonError(null)
      setJsonText(formatTransformJson(draft))
    }
    setView(next)
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

  const jsonOpen = view === "json"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <StatusPill
          tone={passThrough ? "neutral" : "accent"}
          label={passThrough ? "Pass-through" : `${mappedCount} column${mappedCount === 1 ? "" : "s"} mapped`}
        />
        {rulesCount > 0 && (
          <StatusPill tone="neutral" label={`${rulesCount} rule${rulesCount === 1 ? "" : "s"}`} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {onSampleColumns && (
            <IconButton label={sampling ? "Sampling…" : "Sample columns"} disabled={sampling} onClick={onSampleColumns}>
              {sampling ? <Loader2 {...TOOLBAR_ICON} className="animate-spin" /> : <Columns3 {...TOOLBAR_ICON} />}
            </IconButton>
          )}
          {sourceColumns.length > 0 && (
            <IconButton
              label="Map all 1∶1"
              onClick={() => onChange(seedIdentityColumns(draft, sourceColumns))}
            >
              <ArrowLeftRight {...TOOLBAR_ICON} />
            </IconButton>
          )}
          <IconButton
            label="Add column"
            variant="primary"
            onClick={() => {
              setColumnsOpen(true)
              setColumns([...draft.columns, newColumnDraft()])
            }}
          >
            <Plus {...TOOLBAR_ICON} />
          </IconButton>
          <SegmentToggle
            value={view}
            options={[
              { value: "form", label: "Form" },
              { value: "json", label: "JSON" },
            ]}
            onChange={setViewMode}
            ariaLabel="Map view"
          />
        </div>
      </div>

      {sourceColumns.length > 0 && (
        <p className={`shrink-0 ${META_TEXT}`}>
          Source fields · <span className="font-mono text-text-secondary">{sourceColumns.join(" · ")}</span>
        </p>
      )}

      {/* Form | optional JSON split */}
      <div
        className={[
          "grid min-h-0 flex-1 gap-3",
          jsonOpen ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1",
        ].join(" ")}
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
          <MapSection
            title="Column mappings"
            summary={
              passThrough
                ? "Pass-through — every source field is kept"
                : `${mappedCount} mapped · only these fields are written`
            }
            open={columnsOpen}
            onToggle={() => setColumnsOpen((v) => !v)}
            grow={columnsOpen}
          >
            {draft.columns.length === 0 ? (
              <EmptyState
                icon={WIDGET_ICONS.bridge}
                message="Pass-through mode"
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[40rem] table-fixed border-collapse text-left">
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
          </MapSection>

          <MapSection
            title="Rules"
            summary={
              rulesCount > 0
                ? `${rulesCount} active · derive, defaults, filters`
                : "Optional · derive, defaults, filters"
            }
            open={rulesOpen}
            onToggle={() => setRulesOpen((v) => !v)}
            grow={rulesOpen}
          >
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
          </MapSection>
        </div>

        {jsonOpen && (
          <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-elevated/20">
            <header className="shrink-0 border-b border-border-subtle px-4 py-3">
              <h3 className="text-sm font-semibold text-text">Transform JSON</h3>
              <p className={`mt-0.5 ${HELP_TEXT}`}>
                Full document — columns, derive, defaults, filters. Apply replaces the form; invalid JSON is rejected.
              </p>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <div className="relative min-h-0 flex-1">
                <textarea
                  className="input absolute inset-0 h-full w-full resize-none overflow-auto font-mono text-xs leading-relaxed"
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value)
                    setJsonError(null)
                  }}
                  spellCheck={false}
                />
              </div>
              {jsonError && <p className="shrink-0 text-xs text-rose-400">{jsonError}</p>}
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
          </aside>
        )}
      </div>
    </div>
  )
}

/** Collapsible row — header toggles; body is the form (no nested collapse). */
function MapSection({
  title,
  summary,
  open,
  onToggle,
  grow,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  grow: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={[
        "flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-elevated/30",
        grow ? "min-h-0 flex-1" : "shrink-0",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3 text-left hover:bg-overlay-1/40"
      >
        <ChevronDown
          size={16}
          className={[
            "shrink-0 text-text-muted transition-transform",
            open ? "" : "-rotate-90",
          ].join(" ")}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text">{title}</span>
          <span className={`block ${META_TEXT}`}>{summary}</span>
        </span>
      </button>
      {open ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div> : null}
    </section>
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
