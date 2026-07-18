import type {
  CustomValueSourceCatalog,
  CustomValueSourceDefinition,
  SyncFlowKindDefinition,
  SyncFlowKindHandler,
  SyncFlowKindHandlerType,
  SyncProcedureParameter,
  ValueSource,
} from "../../types"
import {
  catalogResolverFamilyLabel,
  formatCatalogResolverRuntimePreview,
  formatHandlerInputPreviewHint,
  formatValueSourcePreview,
  isLiteralHandlerSlot,
  isStepBoundHandlerSlot,
  isSyncStepFieldKey,
  normalizeKindDefinition,
  stepFieldKeysFromHandler,
  valueSourceCatalogId,
} from "../../types"

export const HANDLER_TYPE_OPTIONS: Array<{ value: SyncFlowKindHandlerType; label: string; description: string }> = [
  {
    value: "metadata_sync",
    label: "Metadata sync",
    description:
      "Built-in metadata transaction on target — applies the compiled change set in one SQL transaction.",
  },
  {
    value: "mssql_procedure",
    label: "Stored procedure",
    description: "Execute a SQL Server stored procedure with explicit parameters.",
  },
  {
    value: "http_request",
    label: "HTTP request",
    description: "Call an agent, ETL, or gate HTTP endpoint (method, service, path).",
  },
  {
    value: "custom_sql",
    label: "Custom SQL",
    description:
      "Run a parameterized SQL batch on source or target (not a stored procedure). Gated by sync_custom_sql.",
  },
  {
    value: "custom_shell_script",
    label: "Custom shell script",
    description:
      "Run a shell command on the sync host (Linux, Windows, etc.). Gated by sync_shell_execute.",
  },
]

export const SHELL_PLATFORM_OPTIONS = [
  { value: "any" as const, label: "Any (match sync host)" },
  { value: "linux" as const, label: "Linux" },
  { value: "windows" as const, label: "Windows" },
]

export type ProcedureParamBinding = {
  name: string
  mode: "literal" | "plan" | "flowStep"
  literal?: string
  sourceKey?: string
  sourceLabel?: string
  runtimeHint?: string
}

export const LITERAL_VALUE_SOURCE_OPTION = {
  value: "__literal__",
  label: "Fixed literal",
  hint: "Constant value baked into the kind — numbers, strings, true/false, or null.",
} as const

export type CustomValueSourceUiEntry = {
  label: string
  definition: CustomValueSourceDefinition
}

export type CustomValueSourceUiCatalog = Record<string, CustomValueSourceUiEntry>

/** @deprecated Use CustomValueSourceUiCatalog */
export type SyncPlanBindingSourceUiCatalog = CustomValueSourceUiCatalog

/** @deprecated Use CustomValueSourceUiEntry */
export type SyncPlanBindingSourceUiEntry = CustomValueSourceUiEntry

export function sourcesCatalogListItems(
  sources: ReadonlyArray<{
    id: string
    label: string
    definition: CustomValueSourceDefinition
    builtIn: boolean
  }>,
): Array<{ id: string; label: string; hint?: string; builtIn: boolean }> {
  return sources
    .map((entry) => ({
      id: entry.id,
      label: formatValueSourcePreview(
        { type: "catalog", id: entry.id },
        {
          customCatalog: { [entry.id]: entry.definition },
          customLabels: { [entry.id]: entry.label },
        },
      ),
      hint: catalogResolverFamilyLabel(entry.definition.resolver),
      builtIn: entry.builtIn,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export const PRIOR_STEP_OUTPUT_LISTBOX_VALUE = "__prior_step_output__"

export function customValueSourceRuntimeCatalog(
  catalog: CustomValueSourceUiCatalog,
): CustomValueSourceCatalog {
  return Object.fromEntries(Object.entries(catalog).map(([id, entry]) => [id, entry.definition]))
}

/** @deprecated Use customValueSourceRuntimeCatalog */
export const bindingSourceRuntimeCatalog = customValueSourceRuntimeCatalog

export function customValueSourceCatalogToUi(
  catalog: CustomValueSourceCatalog,
): CustomValueSourceUiCatalog {
  return Object.fromEntries(
    Object.entries(catalog).map(([id, definition]) => [id, { label: id, definition }]),
  )
}

/** @deprecated Use customValueSourceCatalogToUi */
export const bindingCatalogToUi = customValueSourceCatalogToUi

export function builtinCustomValueSourceUiCatalog(): CustomValueSourceUiCatalog {
  return {}
}

/** @deprecated Use builtinCustomValueSourceUiCatalog */
export const builtinBindingSourceUiCatalog = builtinCustomValueSourceUiCatalog

export function valueSourceListboxValue(source: ValueSource | undefined): string {
  if (!source) return ""
  const catalogId = valueSourceCatalogId(source)
  if (catalogId) return `catalog:${catalogId}`
  if (source.type === "priorOutput") return JSON.stringify(source)
  return source.type
}

export function parseValueSourceListboxValue(value: string): ValueSource | undefined {
  if (!value || value === LITERAL_VALUE_SOURCE_OPTION.value || value === PRIOR_STEP_OUTPUT_LISTBOX_VALUE) {
    return undefined
  }
  if (value.startsWith("catalog:")) {
    return { type: "catalog", id: value.slice("catalog:".length) }
  }
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as ValueSource
      if (parsed.type === "priorOutput") return parsed
    } catch {
      return undefined
    }
  }
  return undefined
}

export function handlerInputSourceListValue(source: ValueSource | undefined): string {
  if (!source) return LITERAL_VALUE_SOURCE_OPTION.value
  if (source.type === "priorOutput") return PRIOR_STEP_OUTPUT_LISTBOX_VALUE
  return valueSourceListboxValue(source)
}

function previewOptions(catalog: CustomValueSourceUiCatalog) {
  const runtime = customValueSourceRuntimeCatalog(catalog)
  const labels = Object.fromEntries(Object.entries(catalog).map(([id, entry]) => [id, entry.label]))
  return { customCatalog: runtime, customLabels: labels }
}

function catalogValueSourceListboxOptions(catalog: CustomValueSourceUiCatalog) {
  const options = previewOptions(catalog)
  return Object.entries(catalog).map(([id, entry]) => ({
    value: `catalog:${id}`,
    label: formatValueSourcePreview({ type: "catalog", id }, options),
    hint: catalogResolverFamilyLabel(entry.definition.resolver),
  }))
}

export function bindingSourceListboxOptions(catalog: CustomValueSourceUiCatalog = {}) {
  return [...catalogValueSourceListboxOptions(catalog)].sort((a, b) => a.label.localeCompare(b.label))
}

export function stepFieldListboxOptions(catalog: CustomValueSourceUiCatalog = {}) {
  const options = previewOptions(catalog)
  return Object.entries(catalog)
    .filter(([, entry]) => entry.definition.resolver.kind === "stepField")
    .map(([id, entry]) => ({
      value: `catalog:${id}`,
      label: formatValueSourcePreview({ type: "catalog", id }, options),
      hint: catalogResolverFamilyLabel(entry.definition.resolver),
    }))
}

export function handlerInputSourceListboxOptions(catalog: CustomValueSourceUiCatalog = {}) {
  return bindingSourceListboxOptions(catalog)
}

export function bindingSourceOptions(catalog: CustomValueSourceUiCatalog) {
  return bindingSourceListboxOptions(catalog).map(({ value, label, hint }) => ({
    value,
    label,
    description: hint,
  }))
}

export function bindingRuntimeHint(
  catalog: CustomValueSourceUiCatalog,
  source: ValueSource,
): string {
  const options = previewOptions(catalog)
  const catalogId = valueSourceCatalogId(source)
  if (catalogId) {
    const entry = catalog[catalogId]
    if (!entry) return `Unknown value source "${catalogId}".`
    if (entry.definition.resolver.kind === "targetSql") {
      return `Target SQL → ${entry.definition.resolver.resultColumn.trim() || "?"}`
    }
    return formatValueSourcePreview({ type: "catalog", id: catalogId }, options)
  }
  return formatValueSourcePreview(source, options)
}

/** Short label for Execute preview — not the full runtime resolution chain. */
export function formatProcedureParamPreviewHint(
  param: SyncProcedureParameter,
  customUiCatalog: CustomValueSourceUiCatalog = builtinCustomValueSourceUiCatalog(),
): string {
  return formatHandlerInputPreviewHint(param, previewOptions(customUiCatalog))
}

export function lookupHandlerType(type: SyncFlowKindHandlerType) {
  return HANDLER_TYPE_OPTIONS.find((t) => t.value === type)
}

export function defaultHandlerForType(type: SyncFlowKindHandlerType): SyncFlowKindHandler {
  switch (type) {
    case "metadata_sync":
      return { type, connection: "target" }
    case "http_request":
      return { type, connection: "target", httpMethod: "POST", httpService: "etl", httpPath: "" }
    case "custom_sql":
      return { type, connection: "target", sqlBatch: "" }
    case "custom_shell_script":
      return { type, connection: "target", shellCommand: "", shellPlatform: "any" }
    default:
      return {
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspCustomStep",
        parameters: [{ name: "id", source: { type: "catalog", id: "planEntityId" } }],
      }
  }
}

export function defaultProcedureParameters(): SyncProcedureParameter[] {
  return [{ name: "id", source: { type: "catalog", id: "planEntityId" } }]
}

export function withNormalizedKindDefinition(
  def: SyncFlowKindDefinition,
  kindId?: string,
): SyncFlowKindDefinition {
  return normalizeKindDefinition(def, kindId)
}

export function infersCreatesDatasetLayer(
  def: Pick<SyncFlowKindDefinition, "handler" | "createsDatasetLayer">,
): boolean {
  if (def.createsDatasetLayer) return true
  if (def.handler.type !== "mssql_procedure") return false
  const procedure = def.handler.procedure?.trim().toLowerCase() ?? ""
  return procedure.includes("uspcreatedataset") && !procedure.includes("fk")
}

export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (value === true) return "1"
  if (value === false) return "0"
  if (typeof value === "number") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

export function formatProcedureParamBinding(
  param: SyncProcedureParameter,
  catalog: CustomValueSourceCatalog,
): ProcedureParamBinding {
  const name = param.name.trim() || "param"
  if (isStepBoundHandlerSlot(param)) {
    return {
      name,
      mode: "plan",
      sourceLabel: "Choose on each flow step",
      runtimeHint: "Set on each flow step",
    }
  }
  if (param.source) {
    if (param.source.type === "priorOutput") {
      return {
        name,
        mode: "plan",
        sourceLabel: "Earlier step output",
        runtimeHint: `output "${param.source.output}" from step "${param.source.stepId}"`,
      }
    }
    if (param.source.type === "catalog" && isSyncStepFieldKey(param.source.id)) {
      return {
        name,
        mode: "flowStep",
        sourceLabel: formatValueSourcePreview(param.source),
        runtimeHint: `step.${param.source.id}`,
      }
    }
    if (param.source.type === "catalog") {
      const custom = catalog[param.source.id]
      return {
        name,
        mode: "plan",
        sourceKey: param.source.id,
        sourceLabel: param.source.id,
        runtimeHint: custom
          ? formatCatalogResolverRuntimePreview(custom, param.source.id)
          : `Unknown value source "${param.source.id}".`,
      }
    }
    return {
      name,
      mode: "plan",
      sourceLabel: formatValueSourcePreview(param.source),
      runtimeHint: formatValueSourcePreview(param.source),
    }
  }
  return {
    name,
    mode: "literal",
    literal: "",
  }
}

export function formatProcedureCallPreview(
  handler: SyncFlowKindHandler,
  customUiCatalog: CustomValueSourceUiCatalog = builtinCustomValueSourceUiCatalog(),
): string[] | null {
  if (handler.type !== "mssql_procedure" || !handler.procedure?.trim()) return null
  const connection = handler.connection === "source" ? "source" : "target"
  const procedure = handler.procedure.trim()
  const lines = [`On ${connection}:`, `EXEC ${procedure}`]
  const parameters =
    handler.parameters !== undefined ? handler.parameters : defaultProcedureParameters()
  for (const param of parameters) {
    if (isLiteralHandlerSlot(param)) {
      lines.push(`  @${(param.name.trim() || "param")} = ${formatSqlLiteral(param.source.value)}`)
      continue
    }
    if (isStepBoundHandlerSlot(param) || param.source) {
      const name = param.name.trim() || "param"
      const hint = formatProcedureParamPreviewHint(param, customUiCatalog)
      lines.push(`  @${name} ← ${hint}`)
      continue
    }
    lines.push(`  @${(param.name.trim() || "param")} = NULL`)
  }
  return lines
}

export function formatHttpCallPreview(
  handler: SyncFlowKindHandler,
  customUiCatalog: CustomValueSourceUiCatalog = builtinCustomValueSourceUiCatalog(),
): string[] | null {
  if (handler.type !== "http_request" || !handler.httpPath?.trim()) return null
  const method = handler.httpMethod ?? "POST"
  const service = handler.httpService ?? "etl"
  const path = handler.httpPath.trim()
  const lines = [`${method} ${service}${path}`]
  if (method === "GET") return lines
  for (const slot of handler.httpBody ?? []) {
    if (isLiteralHandlerSlot(slot)) {
      lines.push(`  ${slot.name}: ${formatSqlLiteral(slot.source.value)}`)
      continue
    }
    if (isStepBoundHandlerSlot(slot) || slot.source) {
      const hint = formatProcedureParamPreviewHint(slot, customUiCatalog)
      lines.push(`  ${slot.name} ← ${hint}`)
      continue
    }
    lines.push(`  ${slot.name}: NULL`)
  }
  return lines
}

export function showsSkipWhenDatasetLayerFailed(
  def: Pick<SyncFlowKindDefinition, "handler" | "skipWhenDatasetLayerFailed" | "entityTypes" | "createsDatasetLayer">,
  options?: { editable?: boolean },
): boolean {
  if (def.skipWhenDatasetLayerFailed) return true
  if (!def.entityTypes?.includes("contract")) return false
  if (options?.editable === false) return false
  return def.handler.type === "mssql_procedure" && !infersCreatesDatasetLayer(def)
}

export function handlerBehaviorRows(def: SyncFlowKindDefinition): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  const failure =
    def.failureMode === "fatal" ? "Fatal — stops run" : "Warning — logs and continues"
  rows.push({ label: "Failure mode", value: failure })

  if (infersCreatesDatasetLayer(def)) {
    rows.push({ label: "Dataset layer", value: "Creates contract dataset layer" })
  }
  if (def.skipWhenDatasetLayerFailed) {
    rows.push({
      label: "Skip rule",
      value: "Skip when an earlier contract dataset create failed in the same run",
    })
  }
  return rows
}

/** @deprecated Text summary for legacy list views — prefer structured HandlerConfigPanel. */
export function handlerConfigHighlight(
  def: SyncFlowKindDefinition,
  catalog: CustomValueSourceCatalog = {},
): string | null {
  const handler = def.handler
  const uiCatalog = customValueSourceCatalogToUi(catalog)
  if (handler.type === "mssql_procedure") {
    const lines = formatProcedureCallPreview(handler, uiCatalog)
    return lines ? lines.join("\n") : null
  }
  if (handler.type === "http_request") {
    const lines = formatHttpCallPreview(handler, uiCatalog)
    return lines ? lines.join("\n") : null
  }
  if (handler.type === "custom_sql") {
    return handler.sqlBatch?.trim()
      ? `SQL on ${handler.connection} — @tokens from input slots`
      : null
  }
  if (handler.type === "custom_shell_script") {
    return handler.shellCommand?.trim()
      ? `Shell on sync host (${handler.shellPlatform ?? "any"}) — @tokens from input slots`
      : null
  }
  return null
}

export function formatProcedureSummary(handler: SyncFlowKindHandler): string | null {
  if (handler.type !== "mssql_procedure" || !handler.procedure?.trim()) return null
  const parts = [handler.procedure.trim()]
  const parameters =
    handler.parameters !== undefined ? handler.parameters : defaultProcedureParameters()
  for (const param of parameters) {
    parts.push(
      isLiteralHandlerSlot(param)
        ? `${param.name}=${JSON.stringify(param.source.value)}`
        : `${param.name}←${valueSourceListboxValue(param.source) || "per-step"}`,
    )
  }
  return parts.join(" — ")
}

export function describeHandler(def: SyncFlowKindDefinition): string[] {
  const handler = def.handler
  const lines: string[] = []

  const flowFields = stepFieldKeysFromHandler(handler)
  if (flowFields.length > 0) {
    lines.push(
      `Flow step fields: ${flowFields
        .map((field) => formatValueSourcePreview({ type: "catalog", id: field }))
        .join(", ")}`,
    )
  }

  if (handler.type === "metadata_sync") {
    lines.push("Built-in metadata transaction on target.")
  }

  for (const row of handlerBehaviorRows(def)) {
    if (row.label !== "Failure mode") lines.push(`${row.label}: ${row.value}`)
    else lines.push(`Failure: ${def.failureMode}`)
  }

  return lines
}

export function bindingSourceDescription(
  catalog: CustomValueSourceUiCatalog,
  id: string,
): string {
  const entry = catalog[id]
  if (!entry) {
    return `Unknown custom value source "${id}". Create it under Configuration → Wiring, then pick it here.`
  }
  const detail = entry.definition.description.trim()
  const resolver = entry.definition.resolver
  if (resolver.kind === "targetSql") {
    const query = resolver.query.trim()
    return detail ? `${query}\n\n${detail}` : query || id
  }
  return detail || id
}

export function customValueSourceCatalogFromMetadata(
  sources: ReadonlyArray<{ id: string; label: string; definition: CustomValueSourceDefinition }>,
): CustomValueSourceUiCatalog {
  return Object.fromEntries(
    sources.map((entry) => [entry.id, { label: entry.label, definition: entry.definition }]),
  )
}

/** @deprecated Use customValueSourceCatalogFromMetadata */
export const bindingSourceCatalogFromMetadata = customValueSourceCatalogFromMetadata
