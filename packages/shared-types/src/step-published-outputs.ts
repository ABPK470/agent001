/**
 * Step published outputs — keys for earlier-step bindings and step output preview.
 *
 * Runtime always publishes a flat `Record<string, unknown>` (not arbitrary nested JSON).
 * Keys are merged from catalog `publishedOutputs`, handler input slots, and procedure
 * parameter names. Result columns from SQL procedures appear when declared in catalog.
 */

import type { AuthoredSyncFlowStep, SyncFlowKindDefinition, SyncFlowKindHandler } from "./index.js"
import { handlerInputSlots } from "./handler-input.js"

/** Procedure parameter names always echoed in handler outputs at runtime. */
export function procedureParameterOutputKeys(
  handler: Extract<SyncFlowKindHandler, { type: "mssql_procedure" }>,
): readonly string[] {
  return [
    ...new Set(
      (handler.parameters ?? [])
        .map((slot) => slot.name.trim())
        .filter(Boolean),
    ),
  ].sort()
}

/** Handler input names always echoed in HTTP / custom SQL / shell handler outputs. */
export function guaranteedHandlerInputOutputKeys(handler: SyncFlowKindHandler): readonly string[] {
  return [
    ...new Set(
      handlerInputSlots(handler)
        .map((slot) => slot.name.trim())
        .filter(Boolean),
    ),
  ].sort()
}

/**
 * Derive publishable keys from handler wiring when the catalog omits `publishedOutputs`.
 * Applies only where runtime publishes resolved inputs exactly — never guesses SQL columns.
 */
export function derivePublishedOutputsFromHandler(kind: SyncFlowKindDefinition): readonly string[] {
  switch (kind.handler.type) {
    case "http_request":
    case "custom_sql":
    case "custom_shell_script":
      return guaranteedHandlerInputOutputKeys(kind.handler)
    default:
      return []
  }
}

export function normalizePublishedOutputKeys(keys: readonly string[] | undefined): string[] {
  return [...new Set(keys?.map((key) => key.trim()).filter(Boolean) ?? [])].sort()
}

/** Catalog-declared keys only — used for runtime validation after a step runs. */
export function declaredPublishedOutputKeysForKind(
  _kindId: string | undefined,
  kind: SyncFlowKindDefinition,
): readonly string[] {
  return normalizePublishedOutputKeys(kind.publishedOutputs)
}

export function handlerInputOutputKeys(kind: SyncFlowKindDefinition): readonly string[] {
  if (kind.handler.type === "mssql_procedure") {
    return procedureParameterOutputKeys(kind.handler)
  }
  return derivePublishedOutputsFromHandler(kind)
}

/** Drop abandoned param-name experiments left in publishedOutputs (e.g. id → id2 → id23). */
export function pruneStaleResultColumnKeys(
  resultColumns: readonly string[],
  inputKeys: readonly string[],
): readonly string[] {
  const inputSet = new Set(inputKeys)
  const hasIdStyleInput = inputKeys.some((key) => /^id\d*$/i.test(key))
  return resultColumns.filter((key) => {
    if (inputKeys.some((input) => input !== key && input.startsWith(key))) return false
    if (resultColumns.some((other) => other !== key && other.startsWith(key))) return false
    if (!hasIdStyleInput && /^id\d*$/i.test(key)) return false
    if (key.length <= 1 && !inputSet.has(key)) return false
    return true
  })
}

/** Fresh publishedOutputs: current handler inputs plus real result columns from catalog. */
export function computePublishedOutputsForKind(
  _kindId: string | undefined,
  kind: SyncFlowKindDefinition,
): readonly string[] {
  const inputKeys = handlerInputOutputKeys(kind)
  const inputSet = new Set(inputKeys)
  const declared = normalizePublishedOutputKeys(kind.publishedOutputs)
  const resultColumns = pruneStaleResultColumnKeys(
    declared.filter((key) => !inputSet.has(key)),
    inputKeys,
  )
  return [...new Set([...inputKeys, ...resultColumns])].sort()
}

/** Published keys for an action — current inputs plus catalog result columns. */
export function publishedOutputKeysForKind(
  kindId: string | undefined,
  kind: SyncFlowKindDefinition,
): readonly string[] {
  return computePublishedOutputsForKind(kindId, kind)
}

export interface StepOutputPreview {
  keys: readonly string[]
  example: Record<string, string>
  note: string
}

/** Example JSON shape for the flat map a step publishes at runtime. */
export function stepOutputPreview(
  kindId: string | undefined,
  kind: SyncFlowKindDefinition,
): StepOutputPreview {
  const inputKeys = handlerInputOutputKeys(kind)
  const inputSet = new Set(inputKeys)
  const resultKeys = publishedOutputKeysForKind(kindId, kind).filter((key) => !inputSet.has(key))

  const example: Record<string, string> = {}
  for (const key of inputKeys) example[key] = "<echoed input>"
  for (const key of resultKeys) example[key] = "<from handler result>"

  const note =
    kind.handler.type === "mssql_procedure"
      ? "After this step runs, a flat map is stored: parameter values echoed, plus columns from the first row of the procedure result."
      : kind.handler.type === "http_request"
        ? "After this step runs, request body fields are echoed, plus top-level JSON fields from the HTTP response (when the response body is flat JSON)."
        : kind.handler.type === "custom_sql"
          ? "After this step runs, input slots are echoed, plus columns from the first row of the SQL result set."
          : kind.handler.type === "custom_shell_script"
            ? "After this step runs, input slots are echoed, plus flat JSON printed to stdout (or a stdout field when output is not JSON)."
            : "After this step runs, a flat map of named values is stored for downstream Earlier step output bindings."

  return { keys: [...inputKeys, ...resultKeys], example, note }
}

export function formatStepOutputPreviewJson(preview: Pick<StepOutputPreview, "example" | "keys">): string {
  if (preview.keys.length === 0) return "{}"
  return JSON.stringify(preview.example, null, 2)
}

/** Output keys for the earlier-step picker once a prior step id is selected. */
export function publishedOutputKeysForStep(
  stepId: string,
  steps: readonly AuthoredSyncFlowStep[],
  resolveKind: (kindId: string) => SyncFlowKindDefinition | undefined,
): readonly string[] {
  const step = steps.find((entry) => entry.id.trim() === stepId.trim())
  if (!step) return []
  const kind = resolveKind(step.kind)
  if (!kind) return []
  return publishedOutputKeysForKind(step.kind, kind)
}

/** @deprecated Use {@link publishedOutputKeysForStep}. */
export function suggestPriorStepOutputKeys(
  stepId: string,
  steps: readonly AuthoredSyncFlowStep[],
  resolveKind: (kindId: string) => SyncFlowKindDefinition | undefined,
): string[] {
  return [...publishedOutputKeysForStep(stepId, steps, resolveKind)]
}

export function assertPublishedOutputsPresent(
  kindId: string,
  kind: SyncFlowKindDefinition,
  outputs: Record<string, unknown>,
): void {
  const expected = declaredPublishedOutputKeysForKind(kindId, kind)
  if (expected.length === 0) return
  for (const key of expected) {
    if (!(key in outputs)) {
      const available = Object.keys(outputs)
      throw new Error(
        `Step kind "${kindId}" publishes "${key}" but the handler result did not include it.` +
          (available.length ? ` Got: ${available.join(", ")}.` : " Got: (none)."),
      )
    }
  }
}
