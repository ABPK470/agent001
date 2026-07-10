import { SYNC_HTTP_SERVICE_SLOTS } from "@mia/shared-types"
import type { SyncEnvironmentAdmin } from "../../../types"
import { deriveAllowedOperations } from "../../sync-admin/env-access"

export type ServiceUrlEntry = {
  key: string
  label: string
  url: string
}

export type DirectionPolicyMode = "unrestricted" | "restricted" | "blocked"

export type TargetFormSnapshot = {
  name: string
  displayName: string
  color: string
  role: SyncEnvironmentAdmin["role"]
  ringOrder: string
  defaultAccessMode: SyncEnvironmentAdmin["defaultAccessMode"]
  denyDml: boolean
  denyDdl: boolean
  serviceUrls: ServiceUrlEntry[]
  directionPolicy: DirectionPolicyMode
  allowedDirections: string[]
}

export function emptyTargetFormSnapshot(): TargetFormSnapshot {
  return {
    name: "",
    displayName: "",
    color: "slate",
    role: "both",
    ringOrder: "0",
    defaultAccessMode: "read_write",
    denyDml: false,
    denyDdl: false,
    serviceUrls: defaultServiceUrlEntries(),
    directionPolicy: "unrestricted",
    allowedDirections: [],
  }
}

export function defaultServiceUrlEntries(): ServiceUrlEntry[] {
  return SYNC_HTTP_SERVICE_SLOTS.map((slot) => ({
    key: slot.id,
    label: slot.label,
    url: "",
  }))
}

export function targetFormFromEnv(env: SyncEnvironmentAdmin): TargetFormSnapshot {
  const direction = directionPolicyFromEnv(env.allowedSyncTargets)
  return {
    name: env.name,
    displayName: env.displayName,
    color: env.color,
    role: env.role,
    ringOrder: String(env.ringOrder),
    defaultAccessMode: env.defaultAccessMode,
    denyDml: env.denyDml,
    denyDdl: env.denyDdl,
    serviceUrls: serviceUrlEntriesFromEnv(env),
    directionPolicy: direction.mode,
    allowedDirections: direction.allowedDirections,
  }
}

export function cloneTargetFormSnapshot(snapshot: TargetFormSnapshot): TargetFormSnapshot {
  return {
    ...snapshot,
    serviceUrls: snapshot.serviceUrls.map((entry) => ({ ...entry })),
    allowedDirections: [...snapshot.allowedDirections],
  }
}

export function targetFormToPayload(snapshot: TargetFormSnapshot): Record<string, unknown> {
  const name = snapshot.name.trim()
  const defaultAccessMode = snapshot.defaultAccessMode
  const denyDml = snapshot.denyDml
  const denyDdl = snapshot.denyDdl
  const serviceUrlMap = serviceUrlMapFromEntries(snapshot.serviceUrls)

  return {
    name,
    displayName: snapshot.displayName.trim() || name,
    color: snapshot.color.trim() || "slate",
    role: snapshot.role,
    ringOrder: Number(snapshot.ringOrder || 0),
    defaultAccessMode,
    agentServiceBaseUrl: serviceUrlMap.agent ?? null,
    etlServiceBaseUrl: serviceUrlMap.etl ?? null,
    gateServiceBaseUrl: serviceUrlMap.gate ?? null,
    serviceUrls: serviceUrlMap,
    denyDml,
    denyDdl,
    allowedOperations: deriveAllowedOperations(defaultAccessMode, denyDml, denyDdl),
    approvalRequiredOperations: [],
    allowedSyncTargets: allowedSyncTargetsFromForm(snapshot),
  }
}

export function validateTargetForm(snapshot: TargetFormSnapshot): string | null {
  if (!snapshot.name.trim()) return "Target name is required."
  const keys = new Set<string>()
  for (const entry of snapshot.serviceUrls) {
    const key = entry.key.trim().toLowerCase()
    if (!key) return "Each service URL needs a key."
    if (keys.has(key)) return `Duplicate service key "${key}".`
    keys.add(key)
  }
  if (snapshot.directionPolicy === "restricted" && snapshot.allowedDirections.length === 0) {
    return "Pick at least one outgoing direction or set policy to blocked / unrestricted."
  }
  return null
}

function serviceUrlEntriesFromEnv(env: SyncEnvironmentAdmin): ServiceUrlEntry[] {
  const map = env.serviceUrls ?? {}
  const keys = new Set<string>()

  const entries: ServiceUrlEntry[] = []
  for (const slot of SYNC_HTTP_SERVICE_SLOTS) {
    const url =
      (typeof map[slot.id] === "string" ? map[slot.id] : null)
      ?? env[slot.envField]
      ?? ""
    entries.push({ key: slot.id, label: slot.label, url })
    keys.add(slot.id)
  }

  for (const [rawKey, rawUrl] of Object.entries(map)) {
    const key = rawKey.trim().toLowerCase()
    if (!key || keys.has(key)) continue
    entries.push({
      key,
      label: titleCaseKey(key),
      url: typeof rawUrl === "string" ? rawUrl : "",
    })
    keys.add(key)
  }

  return entries.length > 0 ? entries : defaultServiceUrlEntries()
}

function serviceUrlMapFromEntries(entries: ServiceUrlEntry[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const entry of entries) {
    const key = entry.key.trim().toLowerCase()
    if (!key) continue
    const url = entry.url.trim()
    out[key] = url || null
  }
  return out
}

function directionPolicyFromEnv(
  allowedSyncTargets: string[] | null,
): { mode: DirectionPolicyMode; allowedDirections: string[] } {
  if (allowedSyncTargets === null) {
    return { mode: "unrestricted", allowedDirections: [] }
  }
  if (allowedSyncTargets.length === 0) {
    return { mode: "blocked", allowedDirections: [] }
  }
  return { mode: "restricted", allowedDirections: [...allowedSyncTargets] }
}

function allowedSyncTargetsFromForm(snapshot: TargetFormSnapshot): string[] | null {
  if (snapshot.directionPolicy === "unrestricted") return null
  if (snapshot.directionPolicy === "blocked") return []
  return snapshot.allowedDirections.map((name) => name.trim()).filter(Boolean)
}

function titleCaseKey(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
