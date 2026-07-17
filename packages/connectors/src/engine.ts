/**
 * engine.ts — the streaming data-movement engine.
 *
 * `moveData` pulls row batches lazily from the source adapter, applies a
 * declarative transform row-by-row, and pushes batches into the target
 * adapter's writer. Nothing accumulates the full dataset: a 5GB move never
 * holds more than one batch in memory.
 *
 * Failure semantics (see plan):
 *   - The target adapter owns transaction/rollback. `write` returns a
 *     `MoveSummary` whose `status` is `completed`, `partial`, or `failed`.
 *   - On a mid-stream error the engine stops pulling, closes both adapters,
 *     and returns the target's summary (with `failedAtRow` set).
 *   - `stopOnError` (default true) is forwarded to the target so append-mode
 *     writers can decide whether to continue past a bad batch.
 */

import type {
  ConnectorAdapter,
  MovementError,
  MovementValue,
  MoveSummary,
  ReadSpec,
  Row,
  Transform,
  WriteSpec,
} from "@mia/shared-types"

export interface MoveSource {
  readonly adapter: ConnectorAdapter
  readonly spec: ReadSpec
}

export interface MoveTarget {
  readonly adapter: ConnectorAdapter
  readonly spec: WriteSpec
  /** Forwarded to append-mode writers; default true. */
  readonly stopOnError?: boolean
}

export interface MoveOptions {
  readonly transform?: Transform
  readonly signal?: AbortSignal
}

/** Apply a declarative transform to a row-batch stream, lazily. */
export async function* applyTransform(
  rows: AsyncGenerator<Row[]>,
  transform: Transform | undefined,
): AsyncGenerator<Row[]> {
  if (!transform || (!transform.columns?.length && !transform.derive?.length)) {
    yield* rows
    return
  }
  const cols = transform.columns ?? []
  const derive = transform.derive ?? []
  for await (const batch of rows) {
    const out: Row[] = []
    for (const row of batch) {
      const mapped: Row = cols.length === 0 ? { ...row } : {}
      for (const c of cols) {
        mapped[c.to] = c.cast ? castValue(row[c.from], c.cast) : row[c.from]
      }
      for (const d of derive) mapped[d.to] = interpolate(d.template, row)
      out.push(mapped)
    }
    yield out
  }
}

function castValue(value: unknown, cast: "string" | "number" | "boolean"): MovementValue {
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
  }
}

function interpolate(template: string, row: Row): MovementValue {
  return template.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const v = row[key.trim()]
    return v === null || v === undefined ? "" : String(v)
  })
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
  await source.adapter.open()
  await target.adapter.open()
  try {
    const transformed = applyTransform(source.adapter.read(source.spec), options.transform)
    return await target.adapter.write(target.spec, transformed)
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
