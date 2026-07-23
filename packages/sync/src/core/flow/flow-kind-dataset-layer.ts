import type { SyncFlowKindDefinition } from "@mia/shared-types"

/** True when this step creates a contract physical dataset layer (fail-fast grouping). */
export function createsDatasetLayer(
  kindDef: Pick<SyncFlowKindDefinition, "handler" | "createsDatasetLayer">,
): boolean {
  if (kindDef.createsDatasetLayer) return true
  if (kindDef.handler.type !== "mssql_procedure") return false
  const procedure = kindDef.handler.procedure?.trim().toLowerCase() ?? ""
  return procedure.includes("uspcreatedataset") && !procedure.includes("fk")
}
