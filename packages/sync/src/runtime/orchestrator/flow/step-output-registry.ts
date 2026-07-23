/**
 * Step output registry — named values published by completed flow steps for later bindings.
 */

export class StepOutputRegistry {
  private readonly byStepId = new Map<string, Readonly<Record<string, unknown>>>()

  publish(stepId: string, outputs: Record<string, unknown>): void {
    const trimmedId = stepId.trim()
    if (!trimmedId) return
    this.byStepId.set(trimmedId, { ...outputs })
  }

  get(stepId: string, key: string): unknown {
    const trimmedId = stepId.trim()
    const trimmedKey = key.trim()
    const bucket = this.byStepId.get(trimmedId)
    if (!bucket) {
      throw new Error(`Step "${trimmedId}" has not run yet — cannot read output "${trimmedKey}".`)
    }
    if (!(trimmedKey in bucket)) {
      const available = Object.keys(bucket)
      throw new Error(
        `Step "${trimmedId}" has no output "${trimmedKey}".` +
          (available.length ? ` Published: ${available.join(", ")}.` : " Published: (none)."),
      )
    }
    return bucket[trimmedKey]
  }

  keysForStep(stepId: string): string[] {
    const bucket = this.byStepId.get(stepId.trim())
    return bucket ? Object.keys(bucket) : []
  }
}

export function flatJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== null && typeof entry === "object") continue
    row[key] = entry
  }
  return Object.keys(row).length > 0 ? row : null
}

export function parseFlatJsonText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return flatJsonObject(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

export function firstSqlResultRow(result: {
  recordsets?: unknown
  recordset?: unknown
}): Record<string, unknown> | null {
  const fromRecordsets = (result.recordsets as Array<Array<Record<string, unknown>>> | undefined)?.[0]?.[0]
  if (fromRecordsets && typeof fromRecordsets === "object") return fromRecordsets
  const fromRecordset = (result.recordset as Array<Record<string, unknown>> | undefined)?.[0]
  if (fromRecordset && typeof fromRecordset === "object") return fromRecordset
  return null
}

/** Echo handler inputs, then merge flat result fields without overwriting inputs. */
export function mergeHandlerResultOutputs(
  resolvedInputs: Record<string, unknown>,
  result:
    | { recordsets?: unknown; recordset?: unknown }
    | Record<string, unknown>
    | null
    | undefined,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = { ...resolvedInputs }
  let row: Record<string, unknown> | null = null
  if (result && typeof result === "object" && ("recordsets" in result || "recordset" in result)) {
    row = firstSqlResultRow(result)
  } else if (result && typeof result === "object") {
    row = flatJsonObject(result)
  }
  if (!row) return outputs
  for (const [column, value] of Object.entries(row)) {
    if (!(column in outputs)) outputs[column] = value
  }
  return outputs
}

export function mergeShellCommandOutputs(
  resolvedInputs: Record<string, unknown>,
  stdout: string,
): Record<string, unknown> {
  const parsedStdout = parseFlatJsonText(stdout)
  const shellResult = parsedStdout ?? (stdout.trim() ? { stdout: stdout.trim() } : null)
  return mergeHandlerResultOutputs(resolvedInputs, shellResult)
}

/** @deprecated Use {@link mergeHandlerResultOutputs}. */
export function mergeProcedureResultOutputs(
  resolvedInputs: Record<string, unknown>,
  result: { recordsets?: unknown },
): Record<string, unknown> {
  return mergeHandlerResultOutputs(resolvedInputs, result)
}
