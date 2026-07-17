/**
 * engine.ts — the streaming Bridge engine.
 *
 * `moveData` pulls row batches lazily from the source adapter, applies a
 * declarative transform row-by-row, and pushes batches into the target
 * adapter's writer. Nothing accumulates the full dataset: a 5GB move never
 * holds more than one batch in memory (except formats that inherently buffer,
 * e.g. Parquet / HTTP JSON payloads inside their adapters).
 *
 * Failure semantics:
 *   - The target adapter owns transaction/rollback. `write` returns a
 *     `MoveSummary` whose `status` is `completed`, `partial`, or `failed`.
 *   - On a mid-stream error the engine stops pulling, closes both adapters,
 *     and returns the target's summary (with `failedAtRow` set).
 *   - `stopOnError` (default true) and `signal` are forwarded to the target.
 */

import type {
  ConnectorAdapter,
  MovementError,
  MovementValue,
  MoveSummary,
  ReadSpec,
  Row,
  Transform,
  TransformFilter,
  WriteSpec,
} from "@mia/shared-types"

export interface MoveSource {
  readonly adapter: ConnectorAdapter
  readonly spec: ReadSpec
}

export interface MoveTarget {
  readonly adapter: ConnectorAdapter
  readonly spec: WriteSpec
  /** Forwarded to writers; default true. */
  readonly stopOnError?: boolean
}

export interface MoveOptions {
  readonly transform?: Transform
  readonly signal?: AbortSignal
}

function hasTransformWork(transform: Transform | undefined): boolean {
  if (!transform) return false
  return Boolean(
    transform.columns?.length ||
      transform.derive?.length ||
      transform.defaults?.length ||
      transform.filter?.length,
  )
}

/** Apply a declarative transform to a row-batch stream, lazily. */
export async function* applyTransform(
  rows: AsyncGenerator<Row[]>,
  transform: Transform | undefined,
  signal?: AbortSignal,
): AsyncGenerator<Row[]> {
  if (!hasTransformWork(transform)) {
    for await (const batch of rows) {
      throwIfAborted(signal)
      yield batch
    }
    return
  }
  const cols = transform!.columns ?? []
  const derive = transform!.derive ?? []
  const defaults = transform!.defaults ?? []
  const filters = transform!.filter ?? []
  for await (const batch of rows) {
    throwIfAborted(signal)
    const out: Row[] = []
    for (const row of batch) {
      const mapped: Row = cols.length === 0 ? { ...row } : {}
      for (const c of cols) {
        const raw = isEmpty(row[c.from]) && c.default !== undefined ? c.default : row[c.from]
        mapped[c.to] = c.cast ? castValue(raw, c.cast) : (raw as MovementValue)
      }
      for (const d of derive) mapped[d.to] = interpolate(d.template, { ...row, ...mapped })
      for (const def of defaults) {
        if (isEmpty(mapped[def.column])) mapped[def.column] = def.value
      }
      if (filters.length === 0 || filters.every((f) => matchFilter(mapped, f))) {
        out.push(mapped)
      }
    }
    if (out.length > 0) yield out
  }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === ""
}

function castValue(
  value: unknown,
  cast: "string" | "number" | "boolean" | "date" | "datetime" | "json",
): MovementValue {
  if (value === null || value === undefined) return null
  switch (cast) {
    case "string":
      return typeof value === "string" ? value : String(value)
    case "number": {
      const n = typeof value === "number" ? value : Number(value)
      return Number.isFinite(n) ? n : null
    }
    case "boolean": {
      if (typeof value === "boolean") return value
      const s = String(value).toLowerCase()
      return s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : null
    }
    case "date": {
      const d = toDate(value)
      if (!d) return null
      return d.toISOString().slice(0, 10)
    }
    case "datetime": {
      const d = toDate(value)
      return d ? d.toISOString() : null
    }
    case "json": {
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as MovementValue
        } catch {
          return null
        }
      }
      if (typeof value === "object") return value as MovementValue
      return null
    }
  }
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function interpolate(template: string, row: Row): MovementValue {
  return template.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const v = row[key.trim()]
    return v === null || v === undefined ? "" : String(v)
  })
}

function matchFilter(row: Row, filter: TransformFilter): boolean {
  const left = row[filter.column]
  switch (filter.op) {
    case "exists":
      return !isEmpty(left)
    case "empty":
      return isEmpty(left)
    case "eq":
      return left === filter.value
    case "neq":
      return left !== filter.value
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareOrdered(left, filter.value, filter.op)
    case "in": {
      const list = Array.isArray(filter.value) ? filter.value : []
      return list.some((v) => v === left)
    }
    default:
      return true
  }
}

function compareOrdered(
  left: unknown,
  right: unknown,
  op: "gt" | "gte" | "lt" | "lte",
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false
  const a = typeof left === "number" ? left : Number(left)
  const b = typeof right === "number" ? right : Number(right)
  if (Number.isFinite(a) && Number.isFinite(b)) {
    if (op === "gt") return a > b
    if (op === "gte") return a >= b
    if (op === "lt") return a < b
    return a <= b
  }
  const as = String(left)
  const bs = String(right)
  if (op === "gt") return as > bs
  if (op === "gte") return as >= bs
  if (op === "lt") return as < bs
  return as <= bs
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    throw reason instanceof Error ? reason : new Error("Bridge move aborted")
  }
}

/**
 * Move data from `source` to `target`. Adapters are opened, the stream is
 * piped through the transform, and both adapters are closed at the end
 * (success or failure). The returned summary comes from the target writer.
 */
export async function moveData(
  source: MoveSource,
  target: MoveTarget,
  options: MoveOptions = {},
): Promise<MoveSummary> {
  throwIfAborted(options.signal)
  await source.adapter.open()
  await target.adapter.open()
  try {
    const transformed = applyTransform(
      source.adapter.read(source.spec),
      options.transform,
      options.signal,
    )
    return await target.adapter.write(target.spec, transformed, {
      stopOnError: target.stopOnError ?? true,
      signal: options.signal,
    })
  } finally {
    await source.adapter.close()
    await target.adapter.close()
  }
}

/** Build a `MoveSummary` (used by adapters + tests). */
export function makeSummary(
  status: MoveSummary["status"],
  rowsRead: number,
  rowsWritten: number,
  errors: MovementError[] = [],
  failedAtRow: number | null = null,
): MoveSummary {
  return { status, rowsRead, rowsWritten, errors, failedAtRow }
}
