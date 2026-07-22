/**
 * transform-draft.ts — Bridge Map editor model.
 *
 * One structured draft is the only source of truth in the UI.
 * `compileTransform` turns it into the wire `Transform` the engine understands.
 * `parseTransform` / `draftFromTransform` go the other way for Advanced JSON.
 *
 * Semantics (must stay aligned with packages/connectors applyTransform):
 *   - empty draft  → undefined transform → pass rows through unchanged
 *   - columns[]    → project/rename/cast (non-empty list replaces the row shape)
 *                    · from + optional default = COALESCE(source, default)
 *                    · empty from + to + default = constant target column
 *   - derive[]     → add computed string columns via ${field} templates
 *   - defaults[]   → fill missing/null/empty after projection + derive
 *   - filter[]     → keep row only when every predicate passes (AND)
 */

import type {
  CastKind,
  MovementValue,
  Transform,
  TransformColumn,
  TransformDefault,
  TransformDerive,
  TransformFilter,
  TransformFilterOp,
} from "@mia/shared-types"

export const CAST_OPTIONS: ReadonlyArray<CastKind | ""> = [
  "",
  "string",
  "number",
  "boolean",
  "date",
  "datetime",
  "json",
]

export const FILTER_OPS: ReadonlyArray<TransformFilterOp> = [
  "exists",
  "empty",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
]

export type ColumnDraft = {
  readonly id: string
  from: string
  to: string
  cast: CastKind | ""
  /** Empty string = no default. Otherwise a JSON literal, or plain text → string. */
  defaultText: string
}

export type DeriveDraft = {
  readonly id: string
  to: string
  template: string
}

export type DefaultDraft = {
  readonly id: string
  column: string
  /** JSON literal or plain text → string. */
  valueText: string
}

export type FilterDraft = {
  readonly id: string
  column: string
  op: TransformFilterOp
  /** Unused for exists/empty. For `in`, comma-separated or JSON array. */
  valueText: string
}

export type TransformDraft = {
  columns: ColumnDraft[]
  derive: DeriveDraft[]
  defaults: DefaultDraft[]
  filters: FilterDraft[]
}

let draftSeq = 0
function nextId(prefix: string): string {
  draftSeq += 1
  return `${prefix}-${draftSeq}`
}

export function emptyTransformDraft(): TransformDraft {
  return { columns: [], derive: [], defaults: [], filters: [] }
}

export function newColumnDraft(partial?: Partial<Omit<ColumnDraft, "id">>): ColumnDraft {
  return {
    id: nextId("col"),
    from: partial?.from ?? "",
    to: partial?.to ?? "",
    cast: partial?.cast ?? "",
    defaultText: partial?.defaultText ?? "",
  }
}

export function newDeriveDraft(partial?: Partial<Omit<DeriveDraft, "id">>): DeriveDraft {
  return {
    id: nextId("der"),
    to: partial?.to ?? "",
    template: partial?.template ?? "",
  }
}

export function newDefaultDraft(partial?: Partial<Omit<DefaultDraft, "id">>): DefaultDraft {
  return {
    id: nextId("def"),
    column: partial?.column ?? "",
    valueText: partial?.valueText ?? "",
  }
}

export function newFilterDraft(partial?: Partial<Omit<FilterDraft, "id">>): FilterDraft {
  return {
    id: nextId("fil"),
    column: partial?.column ?? "",
    op: partial?.op ?? "exists",
    valueText: partial?.valueText ?? "",
  }
}

/** True when the draft would compile to `undefined` (pass-through). */
export function isPassThrough(draft: TransformDraft): boolean {
  return (
    draft.columns.every((c) => !columnDraftHasWork(c)) &&
    draft.derive.every((d) => !d.to.trim()) &&
    draft.defaults.every((d) => !d.column.trim()) &&
    draft.filters.every((f) => !f.column.trim())
  )
}

/** Column row counts toward the map when it has a source and/or a target (+ optional const). */
export function columnDraftHasWork(c: ColumnDraft): boolean {
  if (c.from.trim()) return true
  if (c.to.trim()) return true
  return c.defaultText.trim() !== ""
}

/**
 * Seed identity column mappings from sample row keys (e.g. after a source sample).
 * Does not overwrite an existing non-empty column list.
 */
export function seedIdentityColumns(draft: TransformDraft, columnNames: readonly string[]): TransformDraft {
  if (draft.columns.some((c) => columnDraftHasWork(c)) || columnNames.length === 0) return draft
  return {
    ...draft,
    columns: columnNames.map((name) => newColumnDraft({ from: name, to: name })),
  }
}

/** Collect ordered unique keys from preview/sample rows. */
export function columnNamesFromRows(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        order.push(key)
      }
    }
  }
  return order
}

export type CompileResult =
  | { ok: true; transform: Transform | undefined }
  | { ok: false; error: string }

/** Compile UI draft → engine Transform. Empty → undefined. */
export function compileTransform(draft: TransformDraft): CompileResult {
  try {
    if (isPassThrough(draft)) return { ok: true, transform: undefined }

    const columns: TransformColumn[] = []
    for (const c of draft.columns) {
      const from = c.from.trim()
      const to = c.to.trim() || from
      const defaultText = c.defaultText.trim()
      if (!from) {
        // Constant target column — From empty, To + Default required.
        if (!to && defaultText === "") continue
        if (!to) {
          return { ok: false, error: "A column Default without From needs a To (target column)." }
        }
        if (defaultText === "") {
          return {
            ok: false,
            error: `Column "${to}" has no From — set a Default (constant), or pick a source column.`,
          }
        }
        columns.push({
          from: "",
          to,
          ...(c.cast ? { cast: c.cast } : {}),
          default: parseValueText(c.defaultText),
        })
        continue
      }
      columns.push({
        from,
        to,
        ...(c.cast ? { cast: c.cast } : {}),
        ...(defaultText !== "" ? { default: parseValueText(c.defaultText) } : {}),
      })
    }

    const derive: TransformDerive[] = []
    for (const d of draft.derive) {
      const to = d.to.trim()
      if (!to) continue
      const template = d.template
      if (!template.trim()) {
        return { ok: false, error: `Derive "${to}" needs a template (e.g. row-\${id}).` }
      }
      derive.push({ to, template })
    }

    const defaults: TransformDefault[] = []
    for (const d of draft.defaults) {
      const column = d.column.trim()
      if (!column) continue
      if (d.valueText.trim() === "") {
        return { ok: false, error: `Default for "${column}" needs a value.` }
      }
      defaults.push({ column, value: parseValueText(d.valueText) })
    }

    const filter: TransformFilter[] = []
    for (const f of draft.filters) {
      const column = f.column.trim()
      if (!column) continue
      if (f.op === "exists" || f.op === "empty") {
        filter.push({ column, op: f.op })
        continue
      }
      if (f.valueText.trim() === "") {
        return { ok: false, error: `Filter on "${column}" (${f.op}) needs a value.` }
      }
      if (f.op === "in") {
        filter.push({ column, op: "in", value: parseInList(f.valueText) })
      } else {
        filter.push({ column, op: f.op, value: parseValueText(f.valueText) })
      }
    }

    if (columns.length === 0 && derive.length === 0 && defaults.length === 0 && filter.length === 0) {
      return { ok: true, transform: undefined }
    }

    const transform: Transform = {
      ...(columns.length > 0 ? { columns } : {}),
      ...(derive.length > 0 ? { derive } : {}),
      ...(defaults.length > 0 ? { defaults } : {}),
      ...(filter.length > 0 ? { filter } : {}),
    }
    return { ok: true, transform }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Wire Transform → UI draft (for Advanced JSON apply / load). */
export function draftFromTransform(transform: Transform | undefined | null): TransformDraft {
  if (!transform) return emptyTransformDraft()
  return {
    columns: (transform.columns ?? []).map((c) =>
      newColumnDraft({
        from: c.from,
        to: c.to,
        cast: c.cast ?? "",
        defaultText: c.default === undefined ? "" : valueToText(c.default),
      }),
    ),
    derive: (transform.derive ?? []).map((d) => newDeriveDraft({ to: d.to, template: d.template })),
    defaults: (transform.defaults ?? []).map((d) =>
      newDefaultDraft({ column: d.column, valueText: valueToText(d.value) }),
    ),
    filters: (transform.filter ?? []).map((f) =>
      newFilterDraft({
        column: f.column,
        op: f.op,
        valueText:
          f.value === undefined
            ? ""
            : f.op === "in" && Array.isArray(f.value)
              ? f.value.map(valueToText).join(", ")
              : valueToText(f.value as MovementValue),
      }),
    ),
  }
}

export type ParseJsonResult =
  | { ok: true; draft: TransformDraft }
  | { ok: false; error: string }

/** Parse Advanced JSON text into a draft. Empty text → empty draft. */
export function parseTransformJson(text: string): ParseJsonResult {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, draft: emptyTransformDraft() }
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Transform JSON must be an object." }
    }
    return { ok: true, draft: draftFromTransform(value as Transform) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Pretty-print compiled transform for the Advanced JSON panel. */
export function formatTransformJson(draft: TransformDraft): string {
  const compiled = compileTransform(draft)
  if (!compiled.ok) return ""
  if (!compiled.transform) return ""
  return JSON.stringify(compiled.transform, null, 2)
}

/** Parse a field value: JSON literal if it parses, otherwise raw string. */
export function parseValueText(text: string): MovementValue {
  const trimmed = text.trim()
  if (trimmed === "") return ""
  try {
    return JSON.parse(trimmed) as MovementValue
  } catch {
    return text
  }
}

function parseInList(text: string): MovementValue[] {
  const trimmed = text.trim()
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) throw new Error("`in` value must be a JSON array.")
    return parsed as MovementValue[]
  }
  return trimmed.split(",").map((part) => parseValueText(part.trim())).filter((v) => v !== "")
}

function valueToText(value: MovementValue): string {
  if (typeof value === "string") return value
  return JSON.stringify(value)
}
