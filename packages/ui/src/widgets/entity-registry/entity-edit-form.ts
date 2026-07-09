import type { EntityRegistryDefinition, EntityRegistryTable, EntityRegistryTableScope } from "../../types"
import { renumberEntityRegistryTables } from "../../types"

export type EntityEditSectionId =
  | "identity"
  | "scd2"
  | "policies"
  | "tables"
  | "run"
  | "yaml"

export interface EntityEditSection {
  id: EntityEditSectionId
  label: string
  hint: string
  badge?: string
}

export interface EntityEditFormState {
  id: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string
  selfJoinColumn: string
  strategyId: string
  strategyVersion: number | "latest"
  freezeWindowIds: string[]
  tables: EntityRegistryTable[]
  flowTemplateId: string
  serviceProfileRef: string
  environmentPolicyRef: string
  reason: string
  versionLabel: string
  yamlBody: string
}

export function defToFormState(
  def: EntityRegistryDefinition,
  run?: {
    flowTemplateId: string
    serviceProfileRef: string
    environmentPolicyRef: string
  } | null,
): EntityEditFormState {
  return {
    id: def.id,
    displayName: def.displayName,
    description: def.description,
    rootTable: def.rootTable,
    idColumn: def.idColumn,
    labelColumn: def.labelColumn ?? "",
    selfJoinColumn: def.selfJoinColumn ?? "",
    strategyId: def.scd2.strategyId,
    strategyVersion: def.scd2.strategyVersion,
    freezeWindowIds: [...def.policies.freezeWindowIds],
    tables: renumberEntityRegistryTables(
      def.tables.map((table) => ({ ...table, scope: cloneScope(table.scope) })),
    ),
    flowTemplateId: run?.flowTemplateId ?? "metadataOnly",
    serviceProfileRef: run?.serviceProfileRef ?? "default",
    environmentPolicyRef: run?.environmentPolicyRef ?? "default",
    reason: "",
    versionLabel: "",
    yamlBody: "",
  }
}

export function formStateToDefinition(
  base: EntityRegistryDefinition,
  form: EntityEditFormState,
): EntityRegistryDefinition {
  return {
    ...base,
    id: form.id.trim(),
    displayName: form.displayName.trim(),
    description: form.description,
    rootTable: form.rootTable.trim(),
    idColumn: form.idColumn.trim(),
    labelColumn: form.labelColumn.trim() || null,
    selfJoinColumn: form.selfJoinColumn.trim() || null,
    tables: renumberEntityRegistryTables(form.tables.map(normalizeEntityTable)),
    policies: {
      freezeWindowIds: [...form.freezeWindowIds],
    },
    scd2: {
      strategyId: form.strategyId,
      strategyVersion: form.strategyVersion,
      entityOverride: base.scd2.entityOverride,
    },
  }
}

export function validateEntityEditForm(
  form: EntityEditFormState,
  mode: "new" | "edit",
  reservedIds: ReadonlySet<string>,
  yamlError?: string | null,
): string | null {
  if (yamlError) return yamlError
  if (!form.rootTable.trim()) return "Root table is required"
  if (!form.idColumn.trim()) return "ID column is required"
  if (mode === "new" && !form.id.trim()) return "Entity id is required"
  if (mode === "new" && reservedIds.has(form.id.trim())) return "Entity id already exists"
  if (!form.displayName.trim()) return "Display name is required"
  if (!form.reason.trim()) return "Add a reason for change"
  return null
}

export function runYamlToFormRun(run: {
  template: string
  service: string
  environment: string
}): Pick<EntityEditFormState, "flowTemplateId" | "serviceProfileRef" | "environmentPolicyRef"> {
  return {
    flowTemplateId: run.template,
    serviceProfileRef: run.service,
    environmentPolicyRef: run.environment,
  }
}

export function applyYamlPreviewToForm(
  form: EntityEditFormState,
  def: EntityRegistryDefinition,
  run: Pick<EntityEditFormState, "flowTemplateId" | "serviceProfileRef" | "environmentPolicyRef"> | null,
  mode: "new" | "edit",
): EntityEditFormState {
  return {
    ...form,
    id: mode === "edit" ? form.id : def.id,
    displayName: def.displayName,
    description: def.description,
    rootTable: def.rootTable,
    idColumn: def.idColumn,
    labelColumn: def.labelColumn ?? "",
    selfJoinColumn: def.selfJoinColumn ?? "",
    strategyId: def.scd2.strategyId,
    strategyVersion: def.scd2.strategyVersion,
    freezeWindowIds: [...def.policies.freezeWindowIds],
    tables: renumberEntityRegistryTables(
      def.tables.map((table) => ({ ...table, scope: cloneScope(table.scope) })),
    ),
    flowTemplateId: run?.flowTemplateId ?? form.flowTemplateId,
    serviceProfileRef: run?.serviceProfileRef ?? form.serviceProfileRef,
    environmentPolicyRef: run?.environmentPolicyRef ?? form.environmentPolicyRef,
  }
}

export function formatYamlImportError(error: { id: string | null; error: unknown }): string {
  const where = error.id ?? "yaml"
  if (typeof error.error === "string") return `${where}: ${error.error}`
  return `${where}: ${JSON.stringify(error.error)}`
}

export function buildEntityEditSections(
  form: EntityEditFormState,
  options?: {
    flowStepCount?: number
    entityVersion?: number | null
  },
): EntityEditSection[] {
  const flowStepCount = options?.flowStepCount
  const strategyVersionLabel =
    form.strategyVersion === "latest" ? "latest" : `v${form.strategyVersion}`
  const freezeHint =
    form.freezeWindowIds.length === 0 ? "None" : "Registered windows"
  return [
    {
      id: "identity",
      label: "Identity",
      hint: [form.displayName || form.id || "—", form.rootTable || "no root table"].join(" · "),
      badge:
        options?.entityVersion != null ? `rev ${options.entityVersion}` : undefined,
    },
    {
      id: "scd2",
      label: "SCD2 strategy",
      hint: form.strategyId || "—",
      badge: strategyVersionLabel,
    },
    {
      id: "policies",
      label: "Freeze windows",
      hint: freezeHint,
      badge:
        form.freezeWindowIds.length > 0 ? String(form.freezeWindowIds.length) : undefined,
    },
    {
      id: "tables",
      label: "Tables",
      hint: form.tables.length === 0 ? "No tables" : "Entity tables",
      badge: form.tables.length > 0 ? String(form.tables.length) : undefined,
    },
    {
      id: "run",
      label: "Run",
      hint: form.flowTemplateId || "—",
      badge:
        flowStepCount != null && flowStepCount > 0 ? String(flowStepCount) : undefined,
    },
    {
      id: "yaml",
      label: "Source",
      hint: form.yamlBody.trim() ? "Synced with sections" : "Paste or edit entity YAML",
    },
  ]
}

export function newEntityTable(order: number): EntityRegistryTable {
  return {
    name: "",
    scope: { kind: "rootPk", column: "" },
    executionOrder: order,
    scd2Override: null,
    verified: false,
    archiveTable: null,
    note: null,
    provenance: { kind: "manual" },
    scopeColumn: null,
    source: "manual",
    groundedByPipeline: null,
    enabledByDefault: true,
    userControllable: null,
  }
}

export function effectiveTableSource(source: EntityRegistryTable["source"]): NonNullable<EntityRegistryTable["source"]> {
  return source ?? "manual"
}

export function normalizeEntityTable(table: EntityRegistryTable): EntityRegistryTable {
  return {
    ...table,
    name: table.name.trim(),
    source: effectiveTableSource(table.source),
  }
}

/** Client-side gate before applying a table row to the entity draft. */
export function validateEntityTableDraft(table: EntityRegistryTable): string | null {
  if (!table.name.trim()) return "Table name is required"
  if (table.scope.kind === "rootPk" && !table.scope.column.trim()) return "Root PK column is required"
  if (table.scope.kind === "sql" && !table.scope.predicate.trim()) return "SQL scope is required"
  return null
}

function cloneScope(scope: EntityRegistryTableScope): EntityRegistryTableScope {
  if (scope.kind === "sql") {
    return { kind: "sql", predicate: scope.predicate }
  }
  return { kind: "rootPk", column: scope.column }
}

export function cloneEntityTable(table: EntityRegistryTable): EntityRegistryTable {
  return {
    ...table,
    scope: cloneScope(table.scope),
    scd2Override: table.scd2Override ? { ...table.scd2Override } : null,
  }
}

export const NEW_ENTITY_YAML_TEMPLATE = `id: my-entity
tenantId: _default
displayName: My Entity
description: ""
rootTable: schema.MyTable
idColumn: myEntityId
scd2:
  strategyId: mymi-scd2
  strategyVersion: latest
tables: []
policies:
  freezeWindowIds: []
run:
  template: metadataOnly
  service: default
  environment: default
provenance:
  kind: manual
`

export function defaultNewFormState(): EntityEditFormState {
  return {
    id: "",
    displayName: "",
    description: "",
    rootTable: "",
    idColumn: "",
    labelColumn: "",
    selfJoinColumn: "",
    strategyId: "mymi-scd2",
    strategyVersion: "latest",
    freezeWindowIds: [],
    tables: [],
    flowTemplateId: "metadataOnly",
    serviceProfileRef: "default",
    environmentPolicyRef: "default",
    reason: "",
    versionLabel: "",
    yamlBody: NEW_ENTITY_YAML_TEMPLATE,
  }
}

export function mergeDraftSuggestion(
  form: EntityEditFormState,
  suggestion: EntityDraftSuggestionLike,
  options: { touchedFields: ReadonlySet<string>; tablesUserEdited: boolean },
): EntityEditFormState {
  const { touchedFields, tablesUserEdited } = options
  const pick = (field: keyof EntityEditFormState, suggested: string): string =>
    touchedFields.has(field) ? String(form[field]) : suggested

  return {
    ...form,
    id: pick("id", suggestion.identity.id),
    displayName: pick("displayName", suggestion.identity.displayName),
    description: pick("description", suggestion.identity.description),
    idColumn: pick("idColumn", suggestion.identity.idColumn),
    labelColumn: pick("labelColumn", suggestion.identity.labelColumn ?? ""),
    selfJoinColumn: pick("selfJoinColumn", suggestion.identity.selfJoinColumn ?? ""),
    tables: tablesUserEdited
      ? form.tables
      : suggestion.tables.map((table) => ({ ...table, scope: cloneScope(table.scope) })),
    flowTemplateId:
      touchedFields.has("flowTemplateId") || form.flowTemplateId !== "metadataOnly"
        ? form.flowTemplateId
        : suggestion.flowTemplateId ?? form.flowTemplateId,
  }
}

/** True when a suggest-table response carries scope/source data worth merging into the form. */
export function tableSuggestionIsActionable(suggested: EntityRegistryTable): boolean {
  if (suggested.scope.kind === "sql" && suggested.scope.predicate.trim()) return true
  if (suggested.scope.kind === "rootPk" && suggested.scope.column.trim()) return true
  if (suggested.scopeColumn?.trim()) return true
  if (suggested.source && suggested.source !== "manual") return true
  return false
}

export function mergeTableSuggestion(
  current: EntityRegistryTable,
  suggested: EntityRegistryTable,
  touched: ReadonlySet<string>,
): EntityRegistryTable {
  const pick = <K extends keyof EntityRegistryTable>(field: K, value: EntityRegistryTable[K]): EntityRegistryTable[K] =>
    touched.has(field) ? current[field] : value

  return {
    ...current,
    scope: pick("scope", cloneScope(suggested.scope)),
    scopeColumn: pick("scopeColumn", suggested.scopeColumn),
    source: pick("source", suggested.source ?? current.source ?? "manual"),
    note: pick("note", suggested.note),
    enabledByDefault: pick("enabledByDefault", suggested.enabledByDefault),
    userControllable: pick("userControllable", suggested.userControllable),
    groundedByPipeline: pick("groundedByPipeline", suggested.groundedByPipeline),
    provenance: pick("provenance", suggested.provenance),
    archiveTable: pick("archiveTable", suggested.archiveTable),
  }
}
