import type { SyncEnvironmentAdmin } from "../../../types"
import { deriveAllowedOperations } from "../../sync-admin/env-access"

export type TargetFormSnapshot = {
  name: string
  displayName: string
  color: string
  role: SyncEnvironmentAdmin["role"]
  ringOrder: string
  defaultAccessMode: SyncEnvironmentAdmin["defaultAccessMode"]
  agentServiceBaseUrl: string
  etlServiceBaseUrl: string
  gateServiceBaseUrl: string
  denyDml: boolean
  denyDdl: boolean
  allowedTargetsText: string
  syncAllowlistText: string
}

export function emptyTargetFormSnapshot(): TargetFormSnapshot {
  return {
    name: "",
    displayName: "",
    color: "slate",
    role: "both",
    ringOrder: "0",
    defaultAccessMode: "read_write",
    agentServiceBaseUrl: "",
    etlServiceBaseUrl: "",
    gateServiceBaseUrl: "",
    denyDml: false,
    denyDdl: false,
    allowedTargetsText: "",
    syncAllowlistText: "",
  }
}

export function targetFormFromEnv(env: SyncEnvironmentAdmin): TargetFormSnapshot {
  return {
    name: env.name,
    displayName: env.displayName,
    color: env.color,
    role: env.role,
    ringOrder: String(env.ringOrder),
    defaultAccessMode: env.defaultAccessMode,
    agentServiceBaseUrl: env.agentServiceBaseUrl ?? "",
    etlServiceBaseUrl: env.etlServiceBaseUrl ?? "",
    gateServiceBaseUrl: env.gateServiceBaseUrl ?? "",
    denyDml: env.denyDml,
    denyDdl: env.denyDdl,
    allowedTargetsText: (env.allowedSyncTargets ?? []).join(", "),
    syncAllowlistText: (env.syncAllowlist ?? []).join(", "),
  }
}

export function cloneTargetFormSnapshot(snapshot: TargetFormSnapshot): TargetFormSnapshot {
  return { ...snapshot }
}

function parseCsv(text: string): string[] {
  return text.split(",").map((entry) => entry.trim()).filter(Boolean)
}

export function targetFormToPayload(snapshot: TargetFormSnapshot): Record<string, unknown> {
  const name = snapshot.name.trim()
  const defaultAccessMode = snapshot.defaultAccessMode
  const denyDml = snapshot.denyDml
  const denyDdl = snapshot.denyDdl

  return {
    name,
    displayName: snapshot.displayName.trim() || name,
    color: snapshot.color.trim() || "slate",
    role: snapshot.role,
    ringOrder: Number(snapshot.ringOrder || 0),
    defaultAccessMode,
    agentServiceBaseUrl: snapshot.agentServiceBaseUrl.trim() || null,
    etlServiceBaseUrl: snapshot.etlServiceBaseUrl.trim() || null,
    gateServiceBaseUrl: snapshot.gateServiceBaseUrl.trim() || null,
    denyDml,
    denyDdl,
    allowedOperations: deriveAllowedOperations(defaultAccessMode, denyDml, denyDdl),
    approvalRequiredOperations: [],
    allowedSyncTargets: parseCsv(snapshot.allowedTargetsText),
    syncAllowlist: parseCsv(snapshot.syncAllowlistText),
  }
}

export function validateTargetForm(snapshot: TargetFormSnapshot): string | null {
  if (!snapshot.name.trim()) return "Target name is required."
  return null
}
