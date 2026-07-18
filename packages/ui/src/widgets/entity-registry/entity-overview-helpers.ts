import type {
  EntityRegistryDefinition,
  EntityRegistryProvenance,
  EntityRegistryTable,
  EntityRegistryTableScope,
} from "../../types"

export type EntityOverviewSectionId = "identity" | "scd2" | "policies" | "tables" | "flow" | "lineage"

export interface EntityFlowSummary {
  flowId: string
  stepCount: number
}

export interface EntityOverviewSection {
  id: EntityOverviewSectionId
  title: string
  subtitle: string
  badge?: string
}

export function provenanceLabel(provenance: EntityRegistryProvenance): string {
  switch (provenance.kind) {
    case "manual":
      return "Manual"
    case "bundled":
      return "Bundled"
    case "imported":
      return provenance.source ? `Imported · ${provenance.source}` : "Imported"
    case "agent":
      return provenance.runId ? `Agent · ${provenance.runId}` : "Agent"
    case "template":
      return `Template · ${provenance.templateId}`
    case "legacy-migration":
      return provenance.legacyPipelineId != null
        ? `Legacy · ${provenance.legacyPipelineId}`
        : "Legacy migration"
    default:
      return provenance.kind
  }
}

export function scopeSummary(scope: EntityRegistryTableScope): string {
  switch (scope.kind) {
    case "rootPk":
      return `rootPk · ${scope.column}`
    case "sql":
      return "sql scope"
    default:
      return scope.kind
  }
}

export function tableSourceLabel(source: EntityRegistryTable["source"]): string {
  switch (source ?? "manual") {
    case "fk+pipeline":
      return "FK + pipeline"
    case "fk-only":
      return "FK only"
    case "pipeline-only":
      return "Pipeline"
    case "manual":
      return "Manual"
  }
}

export function buildEntityOverviewSections(
  def: EntityRegistryDefinition,
  flow?: EntityFlowSummary | null,
): EntityOverviewSection[] {
  const freezeCount = def.policies.freezeWindowIds.length
  const sections: EntityOverviewSection[] = [
    {
      id: "identity",
      title: def.displayName || def.id,
      subtitle: [def.id, def.rootTable].filter(Boolean).join(" · "),
      badge: def.retiredAt ? "Retired" : `rev ${def.version}`,
    },
    {
      id: "scd2",
      title: "SCD2 strategy",
      subtitle: def.scd2.strategyId,
      badge: def.scd2.strategyVersion === "latest" ? "latest" : `v${def.scd2.strategyVersion}`,
    },
    {
      id: "policies",
      title: "Freeze windows",
      subtitle: freezeCount > 0 ? "Registered windows" : "None",
      badge: freezeCount > 0 ? String(freezeCount) : undefined,
    },
    {
      id: "tables",
      title: "Tables",
      subtitle: def.tables.length === 0 ? "No tables defined" : "Entity tables",
      badge: def.tables.length > 0 ? String(def.tables.length) : undefined,
    },
    {
      id: "flow",
      title: "Flow",
      subtitle: flow ? flow.flowId : "Not configured",
      badge: flow && flow.stepCount > 0 ? String(flow.stepCount) : undefined,
    },
  ]

  if (def.lineageRefs.length > 0) {
    sections.push({
      id: "lineage",
      title: "Lineage",
      subtitle: `${def.lineageRefs.length} reference${def.lineageRefs.length === 1 ? "" : "s"}`,
      badge: String(def.lineageRefs.length),
    })
  }

  return sections
}

export function sortedTables(tables: EntityRegistryTable[]): EntityRegistryTable[] {
  return [...tables].sort((a, b) => a.executionOrder - b.executionOrder)
}
