/**
 * Canonical sync handler vocabulary — HTTP service slots and custom handler tokens.
 */

export type SyncHttpServiceSlot = "etl" | "agent" | "gate"

export interface SyncHttpServiceSlotDefinition {
  id: SyncHttpServiceSlot
  label: string
  envField: "etlServiceBaseUrl" | "agentServiceBaseUrl" | "gateServiceBaseUrl"
  description: string
}

export const SYNC_HTTP_SERVICE_SLOTS: readonly SyncHttpServiceSlotDefinition[] = [
  {
    id: "etl",
    label: "ETL service",
    envField: "etlServiceBaseUrl",
    description: "MyMI ETL HTTP API (e.g. /dataset/deploy). Configured per environment.",
  },
  {
    id: "agent",
    label: "Agent service",
    envField: "agentServiceBaseUrl",
    description: "MyMI agent HTTP API (e.g. /pipeline/register). Configured per environment.",
  },
  {
    id: "gate",
    label: "Gate service",
    envField: "gateServiceBaseUrl",
    description: "Gate HTTP API (e.g. /api/meta/refresh). Configured per environment.",
  },
] as const

export const SYNC_CUSTOM_HANDLER_TOKENS = [
  { token: "@entityId", description: "Use input slot entityId with planEntityId value source" },
  { token: "@id", description: "Use input slot id with planEntityId value source" },
  { token: "@stepId", description: "Use input slot stepId with currentStepId value source" },
] as const

export function lookupHttpServiceSlot(id: SyncHttpServiceSlot): SyncHttpServiceSlotDefinition {
  const found = SYNC_HTTP_SERVICE_SLOTS.find((entry) => entry.id === id)
  if (!found) throw new Error(`Unknown HTTP service slot "${id}".`)
  return found
}
