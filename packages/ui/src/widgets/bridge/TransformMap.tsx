/**
 * TransformMap — structured Bridge Map editor (Source → Map → Target).
 *
 * Visual form is the only editable source of truth. Advanced JSON is an
 * escape hatch: Apply replaces the draft; Copy updates the textarea from draft.
 */

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react"
import { useState, type JSX, type ReactNode } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { HELP_TEXT, META_TEXT } from "../entity-registry/chrome"
import { FormSectionCard } from "../entity-registry/form-section"
import {
  CAST_OPTIONS,
  FILTER_OPS,
  type ColumnDraft,
  type DefaultDraft,
  type DeriveDraft,
  type FilterDraft,
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

const CAST_LIST: ListboxOption<CastKind | "">[] = CAST_OPTIONS.map((c) => ({
  value: c,
  label: c === "" ? "No cast" : c,
}))

const FILTER_OP_LIST: ListboxOption<TransformFilterOp>[] = FILTER_OPS.map((op) => ({
  value: op,
  label: op,
}))

const inputClass = "input text-sm min-w-0 w-full"
const monoClass = `${inputClass} font-mono`
const rowBtnClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-overlay-2 hover:text-text transition-colors"
const addBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-overlay-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-overlay-2 hover:text-text transition-colors"

export function TransformMap({
  draft,
  onChange,
  sourceColumns,
  onSampleColumns,
  sampling,
}: {
  draft: TransformDraft
  onChange: (next: TransformDraft) => void
  /** Known source field names (from last sample / preview). */
  sourceColumns: readonly string[]
  /** Optional: fetch a source sample and seed identity mappings. */
  onSampleColumns?: () => void
  sampling?: boolean
}): JSX.Element {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [jsonText, setJsonText] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const passThrough = isPassThrough(draft)

  function patchColumns(columns: ColumnDraft[]): void {
    onChange({ ...draft, columns })
  }
  function patchDerive(derive: DeriveDraft[]): void {
    onChange({ ...draft, derive })
  }
  function patchDefaults(defaults: DefaultDraft[]): void {
    onChange({ ...draft, defaults })
  }
  function patchFilters(filters: FilterDraft[]): void {
    onChange({ ...draft, filters })
  }

  function openAdvanced(): void {
    setAdvancedOpen(true)
    setJsonError(null)
    setJsonText(formatTransformJson(draft))
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

  function seedFromKnown(): void {
    onChange(seedIdentityColumns(draft, sourceColumns))
  }

  return (
    <FormSectionCard
      title="Map"
      description={
        passThrough
          ? "Pass-through — rows keep their source shape. Add column mappings to project, rename, or cast."
          : "Applied row-by-row after the source read, before the target write."
      }
      emphasized
    >
      <div className="flex flex-wrap items-center gap-2">
        {onSampleColumns && (
          <button
            type="button"
            className={addBtnClass}
            disabled={sampling}
            onClick={onSampleColumns}
            title="Read a few source rows (no transform) and offer their column names"
          >
            {sampling ? "Sampling…" : "Sample source columns"}
          </button>
        )}
        {sourceColumns.length > 0 && (
          <button
            type="button"
            className={addBtnClass}
            onClick={seedFromKnown}
            title="Add identity mappings for every known source column (only if Map is empty)"
          >
            Map all columns 1∶1
          </button>
        )}
        {sourceColumns.length > 0 && (
          <span className={META_TEXT}>
            Known fields:{" "}
            <span className="font-mono text-text-muted">{sourceColumns.join(", ")}</span>
          </span>
        )}
      </div>

      {/* ── Columns ── */}
      <MapBlock
        title="Columns"
        hint="Project / rename / cast. Leave empty for pass-through. A non-empty list replaces the row with only these fields."
      >
        {draft.columns.length === 0 ? (
          <p className={HELP_TEXT}>No column mappings — source fields pass through as-is.</p>
        ) : (
          <div className="space-y-2">
            <div className="hidden gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wide text-text-faint sm:grid sm:grid-cols-[1fr_1fr_7.5rem_1fr_2rem]">
              <span>From</span>
              <span>To</span>
              <span>Cast</span>
              <span>Default if empty</span>
              <span />
            </div>
            {draft.columns.map((row, index) => (
              <div
                key={row.id}
                className="grid grid-cols-1 gap-2 rounded-md border border-border-subtle/70 bg-base/40 p-2 sm:grid-cols-[1fr_1fr_7.5rem_1fr_2rem] sm:items-center"
              >
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
                    patchColumns(next)
                  }}
                  suggestions={sourceColumns}
                  placeholder="source field"
                  ariaLabel={`Column ${index + 1} from`}
                />
                <input
                  className={monoClass}
                  value={row.to}
                  onChange={(e) => {
                    const next = [...draft.columns]
                    next[index] = { ...next[index]!, to: e.target.value }
                    patchColumns(next)
                  }}
                  placeholder="target field"
                  aria-label={`Column ${index + 1} to`}
                />
                <Listbox
                  value={row.cast}
                  options={CAST_LIST}
                  onChange={(cast) => {
                    const next = [...draft.columns]
                    next[index] = { ...next[index]!, cast }
                    patchColumns(next)
                  }}
                  size="sm"
                  className="w-full"
                  ariaLabel={`Column ${index + 1} cast`}
                />
                <input
                  className={monoClass}
                  value={row.defaultText}
                  onChange={(e) => {
                    const next = [...draft.columns]
                    next[index] = { ...next[index]!, defaultText: e.target.value }
                    patchColumns(next)
                  }}
                  placeholder='e.g. "" or 0 or true'
                  aria-label={`Column ${index + 1} default`}
                />
                <button
                  type="button"
                  className={rowBtnClass}
                  aria-label={`Remove column ${index + 1}`}
                  onClick={() => patchColumns(draft.columns.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className={addBtnClass} onClick={() => patchColumns([...draft.columns, newColumnDraft()])}>
          <Plus size={14} />
          Add column
        </button>
      </MapBlock>

      {/* ── Derive ── */}
      <MapBlock title="Derive" hint='Add fields from templates. Use ${field} — no code eval.'>
        {draft.derive.map((row, index) => (
          <div
            key={row.id}
            className="grid grid-cols-1 gap-2 rounded-md border border-border-subtle/70 bg-base/40 p-2 sm:grid-cols-[1fr_2fr_2rem] sm:items-center"
          >
            <input
              className={monoClass}
              value={row.to}
              onChange={(e) => {
                const next = [...draft.derive]
                next[index] = { ...next[index]!, to: e.target.value }
                patchDerive(next)
              }}
              placeholder="new field"
              aria-label={`Derive ${index + 1} name`}
            />
            <input
              className={monoClass}
              value={row.template}
              onChange={(e) => {
                const next = [...draft.derive]
                next[index] = { ...next[index]!, template: e.target.value }
                patchDerive(next)
              }}
              placeholder={"e.g. row-${id}"}
              aria-label={`Derive ${index + 1} template`}
            />
            <button
              type="button"
              className={rowBtnClass}
              aria-label={`Remove derive ${index + 1}`}
              onClick={() => patchDerive(draft.derive.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className={addBtnClass} onClick={() => patchDerive([...draft.derive, newDeriveDraft()])}>
          <Plus size={14} />
          Add derive
        </button>
      </MapBlock>

      {/* ── Defaults ── */}
      <MapBlock title="Defaults" hint="Fill missing / null / empty after columns and derive.">
        {draft.defaults.map((row, index) => (
          <div
            key={row.id}
            className="grid grid-cols-1 gap-2 rounded-md border border-border-subtle/70 bg-base/40 p-2 sm:grid-cols-[1fr_1fr_2rem] sm:items-center"
          >
            <FieldSuggest
              value={row.column}
              onChange={(column) => {
                const next = [...draft.defaults]
                next[index] = { ...next[index]!, column }
                patchDefaults(next)
              }}
              suggestions={sourceColumns}
              placeholder="field"
              ariaLabel={`Default ${index + 1} column`}
            />
            <input
              className={monoClass}
              value={row.valueText}
              onChange={(e) => {
                const next = [...draft.defaults]
                next[index] = { ...next[index]!, valueText: e.target.value }
                patchDefaults(next)
              }}
              placeholder="value"
              aria-label={`Default ${index + 1} value`}
            />
            <button
              type="button"
              className={rowBtnClass}
              aria-label={`Remove default ${index + 1}`}
              onClick={() => patchDefaults(draft.defaults.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={addBtnClass}
          onClick={() => patchDefaults([...draft.defaults, newDefaultDraft()])}
        >
          <Plus size={14} />
          Add default
        </button>
      </MapBlock>

      {/* ── Filters ── */}
      <MapBlock title="Filters" hint="Keep a row only when every rule passes (AND).">
        {draft.filters.map((row, index) => {
          const needsValue = row.op !== "exists" && row.op !== "empty"
          return (
            <div
              key={row.id}
              className="grid grid-cols-1 gap-2 rounded-md border border-border-subtle/70 bg-base/40 p-2 sm:grid-cols-[1fr_7.5rem_1fr_2rem] sm:items-center"
            >
              <FieldSuggest
                value={row.column}
                onChange={(column) => {
                  const next = [...draft.filters]
                  next[index] = { ...next[index]!, column }
                  patchFilters(next)
                }}
                suggestions={sourceColumns}
                placeholder="field"
                ariaLabel={`Filter ${index + 1} column`}
              />
              <Listbox
                value={row.op}
                options={FILTER_OP_LIST}
                onChange={(op) => {
                  const next = [...draft.filters]
                  next[index] = { ...next[index]!, op }
                  patchFilters(next)
                }}
                size="sm"
                className="w-full"
                ariaLabel={`Filter ${index + 1} op`}
              />
              <input
                className={monoClass}
                value={row.valueText}
                disabled={!needsValue}
                onChange={(e) => {
                  const next = [...draft.filters]
                  next[index] = { ...next[index]!, valueText: e.target.value }
                  patchFilters(next)
                }}
                placeholder={row.op === "in" ? "a, b, c  or  [1,2]" : needsValue ? "value" : "—"}
                aria-label={`Filter ${index + 1} value`}
              />
              <button
                type="button"
                className={rowBtnClass}
                aria-label={`Remove filter ${index + 1}`}
                onClick={() => patchFilters(draft.filters.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}
        <button type="button" className={addBtnClass} onClick={() => patchFilters([...draft.filters, newFilterDraft()])}>
          <Plus size={14} />
          Add filter
        </button>
      </MapBlock>

      {/* ── Advanced JSON ── */}
      <div className="rounded-md border border-border-subtle/70 bg-base/30">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text"
          onClick={() => (advancedOpen ? setAdvancedOpen(false) : openAdvanced())}
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Advanced JSON
        </button>
        {advancedOpen && (
          <div className="space-y-2 border-t border-border-subtle px-3 pb-3 pt-2">
            <p className={HELP_TEXT}>
              Escape hatch for agents and power users. Apply replaces the Map form. Invalid JSON is rejected.
            </p>
            <textarea
              className="input min-h-[8rem] w-full font-mono text-xs leading-relaxed"
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value)
                setJsonError(null)
              }}
              spellCheck={false}
            />
            {jsonError && <p className="text-xs text-rose-400">{jsonError}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={addBtnClass} onClick={applyJson}>
                Apply JSON → Map
              </button>
              <button
                type="button"
                className={addBtnClass}
                onClick={() => {
                  setJsonError(null)
                  setJsonText(formatTransformJson(draft))
                }}
              >
                Copy Map → JSON
              </button>
            </div>
          </div>
        )}
      </div>
    </FormSectionCard>
  )
}

function MapBlock({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h5>
        <p className={`mt-0.5 ${META_TEXT}`}>{hint}</p>
      </div>
      {children}
    </div>
  )
}

/** Free-text field with optional click-to-fill suggestions from known columns. */
function FieldSuggest({
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  suggestions: readonly string[]
  placeholder?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <input
        className={monoClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        list={suggestions.length > 0 ? `${ariaLabel}-list` : undefined}
      />
      {suggestions.length > 0 && (
        <datalist id={`${ariaLabel}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}
