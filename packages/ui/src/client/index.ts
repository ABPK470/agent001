/**
 * API client — HTTP + SSE communication with the server.
 */

import type {
    EntityRegistryDraftSuggestion,
    EntityRegistryTableSuggestion,
    Notification,
    PolicyRule,
    PublishedSyncDefinition,
    PublishSyncDefinitionsResponse,
    RollbackPreview,
    RollbackResult,
    Run,
    RunDetail,
    SavedLayout,
    SseEvent,
    SyncEntityType,
    SyncEnvironment,
    SyncExecuteProgress,
    SyncPlan,
    ToolInfo,
    ViewConfig,
    WorkspaceDiff,
    WorkspaceDiffApplyResult,
} from "../types"
import { OperationKind, OperationStatus } from "@mia/shared-enums"
import { sseStepDedupeToken } from "@mia/shared-types"

export { OperationKind, OperationStatus }

export type SyncRunStatus = "started" | "preview" | "success" | "failed" | "skipped" | "cancelled"

export type SyncHistorySort = "started_desc" | "started_asc" | "finished_desc" | "finished_asc"

export type AdminAuditSort = "timestamp_desc" | "timestamp_asc"

export type UsageSort = "created_desc" | "created_asc" | "tokens_desc" | "tokens_asc"

export interface UsageParams {
  page?: number
  pageSize?: number
  q?: string
  user?: string
  model?: string
  from?: string
  to?: string
  sort?: UsageSort
}

export interface UsageItem {
  runId: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  llmCalls: number
  model: string
  createdAt: string
  user: string | null
  displayName: string | null
  goal: string | null
  status: string | null
  threadId: string | null
  threadTitle: string | null
}

export interface UsageTotalsWire {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  llmCalls: number
  runCount: number
  completedRuns: number
  failedRuns: number
}

export interface UsagePage {
  totals: UsageTotalsWire
  items: UsageItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface UsageFilterOptions {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  models: string[]
}

export interface AdminAuditParams {
  page?: number
  pageSize?: number
  q?: string
  scopeType?: "run" | "admin" | ""
  scopeId?: string
  /** Platform user UPN (run owner or admin actor — same identity). */
  user?: string
  action?: string
  runId?: string
  threadId?: string
  from?: string
  to?: string
  sort?: AdminAuditSort
}

export interface AdminAuditItem {
  id: number
  scopeType: "run" | "admin"
  scopeId: string | null
  runId: string | null
  threadId: string | null
  threadTitle: string | null
  /** Resolved user UPN (run owner or admin actor). */
  user: string | null
  action: string
  detail: Record<string, unknown>
  timestamp: string
  run: {
    goal: string | null
    status: string | null
    upn: string | null
    displayName: string | null
  } | null
}

export interface AdminAuditFilterOptions {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  scopeIds: string[]
  actions: string[]
}

export interface AdminAuditPage {
  items: AdminAuditItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface AboutDossier {
  product: { name: string; version: string }
  runtime: { env: string; node: string }
  viewer: {
    upn: string
    displayName: string
    isAdmin: boolean
    role: "admin" | "operator"
  }
  myUsage: {
    runs: { total: number; completed: number; failed: number }
    tokens: { prompt: number; completion: number; total: number; llmCalls: number }
    syncRuns: { total: number }
  }
  access: {
    directories: { allowed: string[]; denied: string[] }
    tools: string[]
    widgets: string[]
    notes: string[]
  }
  environments: Array<{
    name: string
    displayName: string
    role: string
    ringOrder: number
    allowedSyncEnvironments: string[] | null
  }>
  providers: {
    active: { id: string; model: string; configured: boolean }
    available: Array<{ id: string; defaultModel: string; label: string }>
  }
  workspace: { path: string; mode: "full" | "sandbox" }
  execution: {
    sandboxMode: string
    hostedMode: boolean
    isolatedWorkspace: boolean
    maxConcurrentRuns: number | null
  }
  dataPlane: {
    ready: boolean
    hints: string[]
    mssql: { configured: boolean; connections: string[]; summary: string }
    catalog: { available: boolean; detail: string | null }
    entities: { count: number; valid: boolean; errors: string[] }
    publish: {
      ready: boolean
      publishedAt: string | null
      publishedVersion: string | null
      definitionCount: number
    }
  }
}

export interface SyncRunSummary {
  planId: string
  entityType: string
  entityId: string
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  status: SyncRunStatus
  error: string | null
  previewTotals: { insert: number; update: number; delete: number }
  executeTotals: { insert: number; update: number; delete: number } | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  planAvailable: boolean
}

export interface SyncHistoryParams {
  page?: number
  pageSize?: number
  q?: string
  status?: SyncRunStatus[]
  entityType?: string
  actorUpn?: string
  source?: string
  target?: string
  from?: string
  to?: string
  sort?: SyncHistorySort
}

export interface SyncHistoryPage {
  items: SyncRunSummary[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const BASE = ""

// ── REST API ─────────────────────────────────────────────────────

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...opts?.headers as Record<string, string> }
  if (opts?.body) headers["Content-Type"] = "application/json"
  // credentials: include — sends the session cookie cross-port (UI on 5173, server on 3102 in dev).
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: "include" })
  if (!res.ok) {
    const body = await res.json().catch((err: unknown) => { console.error("[mia]", err) })
    let msg = `HTTP ${res.status}`
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>
      if (record.error === "validation_failed" && record.result && typeof record.result === "object") {
        const result = record.result as { errors?: Array<{ message?: string }> }
        const details = (result.errors ?? [])
          .map((issue) => issue.message)
          .filter((message): message is string => Boolean(message))
        msg = details.length > 0 ? details.join("; ") : "Validation failed"
      } else if (typeof record.message === "string") {
        msg = record.message
      } else if (typeof record.error === "string") {
        msg = record.error
      }
    }
    const err = new Error(msg) as Error & { stderr?: string[]; code?: string; status?: number }
    err.status = res.status
    if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") {
      err.code = (body as { code: string }).code
    }
    if (body && typeof body === "object" && typeof (body as { approvalId?: unknown }).approvalId === "string") {
      ;(err as Error & { approvalId?: string }).approvalId = (body as { approvalId: string }).approvalId
    }
    if (body && typeof body === "object" && typeof (body as { policyName?: unknown }).policyName === "string") {
      ;(err as Error & { policyName?: string }).policyName = (body as { policyName: string }).policyName
    }
    if (body && typeof body === "object" && Array.isArray((body as { stderr?: unknown }).stderr)) {
      err.stderr = (body as { stderr: string[] }).stderr
    }
    throw err
  }
  return res.json() as Promise<T>
}

export const api = {
  // Runs
  listRuns: (opts?: { threadId?: string }) => {
    const params = new URLSearchParams()
    if (opts?.threadId) params.set("threadId", opts.threadId)
    const qs = params.toString()
    return json<Run[]>(`/api/runs${qs ? `?${qs}` : ""}`)
  },
  listThreads: (opts?: { includeArchived?: boolean }) =>
    json<import("@mia/shared-types").Thread[]>(
      `/api/threads${opts?.includeArchived ? "?includeArchived=1" : ""}`
    ),
  createThread: (title?: string) =>
    json<import("@mia/shared-types").Thread>("/api/threads", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),
  updateThread: (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean }
  ) =>
    json<import("@mia/shared-types").Thread>(`/api/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteThread: (id: string) =>
    json<{ ok: boolean; deletedRuns: number }>(`/api/threads/${id}`, {
      method: "DELETE",
    }),
  listThreadRuns: (threadId: string) =>
    json<Run[]>(`/api/threads/${threadId}/runs`),
  getRun: (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun: (
    goal: string,
    attachmentIds: string[] | undefined,
    threadId: string
  ) =>
    json<{ runId: string; attachmentIds?: string[] }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        goal,
        threadId,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      }),
    }),
  cancelRun: (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, {
    method: "POST",
  }),
  resumeRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/resume`, {
    method: "POST",
  }),
  listPendingToolApprovals: () =>
    json<Array<{
      id: string
      runId: string
      stepId: string
      toolName: string
      args: Record<string, unknown>
      reason: string
      policyName: string
      status: string
      requestedAt: string
      resolvedAt: string | null
      resolvedBy: string | null
    }>>("/api/runs/tool-approvals/pending"),
  approveRunToolStep: (approvalId: string) =>
    json<{ ok: true; runId: string; resumedRunId: string | null }>(
      `/api/runs/tool-approvals/${encodeURIComponent(approvalId)}/approve`,
      { method: "POST" },
    ),
  denyRunToolStep: (approvalId: string, reason?: string) =>
    json<{ ok: true; runId: string }>(
      `/api/runs/tool-approvals/${encodeURIComponent(approvalId)}/deny`,
      { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
    ),
  rerunRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/rerun`, {
    method: "POST",
  }),
  respondToRun: (id: string, response: string) => json<{ ok: boolean }>(`/api/runs/${id}/respond`, {
    method: "POST",
    body: JSON.stringify({ response }),
  }),
  killToolCall: (runId: string, toolCallId: string, message: string) => json<{ ok: boolean }>(`/api/runs/${runId}/kill-tool`, {
    method: "POST",
    body: JSON.stringify({ toolCallId, message }),
  }),
  getActiveRuns: () => json<{ runIds: string[] }>("/api/runs/active"),
  getRunTrace: (id: string) => json<Record<string, unknown>[]>(`/api/runs/${id}/trace`),
  listRunArtifacts: (id: string) =>
    json<{ runId: string; files: Array<{ path: string; sizeBytes: number }> }>(
      `/api/runs/${encodeURIComponent(id)}/artifacts`,
    ),
  flagRunFeedback: (id: string, useful: boolean, note?: string) =>
    json<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ useful, note }),
    }),
  getRunWorkspaceDiff: (id: string) => json<WorkspaceDiff>(`/api/runs/${id}/workspace-diff`),
  applyRunWorkspaceDiff: (id: string) => json<WorkspaceDiffApplyResult>(`/api/runs/${id}/workspace-diff/apply`, {
    method: "POST",
  }),

  // Rollback
  previewRollback: (runId: string) =>
    json<RollbackPreview>(`/api/effects/${encodeURIComponent(runId)}/rollback-preview`),
  rollbackRun: (runId: string) =>
    json<RollbackResult>(`/api/effects/${encodeURIComponent(runId)}/rollback`, {
      method: "POST",
    }),

  // Layouts
  listLayouts: () => json<SavedLayout[]>("/api/layouts"),
  saveLayout: (name: string, config: ViewConfig) =>
    json<{ id: string }>("/api/layouts", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    }),
  deleteLayout: (id: string) => json<{ ok: boolean }>(`/api/layouts/${id}`, {
    method: "DELETE",
  }),

  // Dashboard state (auto-save)
  getDashboardState: () => json<{ views: ViewConfig[]; activeViewId: string } | null>("/api/dashboard-state"),
  saveDashboardState: (state: { views: ViewConfig[]; activeViewId: string }) =>
    json<{ ok: boolean }>("/api/dashboard-state", {
      method: "PUT",
      body: JSON.stringify(state),
    }),

  // Health
  health: () => json<{ status: string, active: number }>("/api/health"),

  // Usage — admin token browser (filterable; KPIs match the filter set)
  getUsage: (params: UsageParams = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue
      qs.set(key, String(value))
    }
    const suffix = qs.toString() ? `?${qs}` : ""
    return json<UsagePage>(`/api/usage${suffix}`)
  },
  usageOptions: () => json<UsageFilterOptions>("/api/usage/options"),

  // About — documentary platform dossier (any authenticated user)
  getAbout: () => json<AboutDossier>("/api/about"),

  // Admin audit browser
  listAdminAudit: (params: AdminAuditParams = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue
      qs.set(key, String(value))
    }
    const suffix = qs.toString() ? `?${qs}` : ""
    return json<AdminAuditPage>(`/api/admin/audit${suffix}`)
  },
  adminAuditOptions: () => json<AdminAuditFilterOptions>("/api/admin/audit/options"),
  exportAdminAudit: (params: AdminAuditParams & { format?: "csv" | "json" } = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue
      qs.set(key, String(value))
    }
    if (!qs.has("format")) qs.set("format", "csv")
    const stamp = new Date().toISOString().slice(0, 10)
    const fallback = `mia-audit-${stamp}.${qs.get("format") === "json" ? "json" : "csv"}`
    return import("../lib/userDownload.js").then(({ downloadAuthenticated }) =>
      downloadAuthenticated(`/api/admin/audit/export?${qs}`, fallback),
    )
  },

  // Policies
  listPolicies: () => json<PolicyRule[]>("/api/policies"),
  createPolicy: (rule: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> }) =>
    json<{ ok: boolean }>("/api/policies", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  deletePolicy: (name: string) =>
    json<{ ok: boolean }>(`/api/policies/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  // Sync environments (admin)
  listSyncEnvironments: () => json<import("../types").SyncEnvironmentAdmin[]>("/api/sync-environments"),
  createSyncEnvironment: (fields: Record<string, unknown>) =>
    json<{ ok: boolean }>("/api/sync-environments", {
      method: "POST",
      body: JSON.stringify(fields),
    }),
  updateSyncEnvironment: (name: string, fields: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/api/sync-environments/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),
  deleteSyncEnvironment: (name: string, opts?: { allowBuiltinEdit?: boolean }) =>
    json<{ ok: boolean }>(
      `/api/sync-environments/${encodeURIComponent(name)}${opts?.allowBuiltinEdit ? "?allowBuiltinEdit=1" : ""}`,
      { method: "DELETE" },
    ),

  // Connectors (admin)
  listConnectors: () => json<import("../types").ConnectorAdmin[]>("/api/connectors"),
  listConnectorKinds: () =>
    json<import("../types").ConnectorKind[]>("/api/connectors/kinds"),
  validateConnector: (body: { kind: import("../types").ConnectorKindId; config: Record<string, unknown> }) =>
    json<import("../types").ConnectorConfigValidation>("/api/connectors/validate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createConnector: (fields: Record<string, unknown>) =>
    json<{ ok: boolean; id: string }>("/api/connectors", {
      method: "POST",
      body: JSON.stringify(fields),
    }),
  updateConnector: (id: string, fields: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/api/connectors/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),
  deleteConnector: (id: string) =>
    json<{ ok: boolean }>(`/api/connectors/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  exportConnectors: (opts?: { includeSecrets?: boolean }) =>
    json<{ version: number; connectors: import("../types").Connector[] }>(
      `/api/connectors/export${opts?.includeSecrets ? "?includeSecrets=1" : ""}`,
    ),
  importConnectors: (body: {
    version: number
    connectors: Array<Record<string, unknown>>
    dryRun?: boolean
    reason?: string
  }) =>
    json<import("@mia/shared-types").PlatformImportGateResult>("/api/connectors/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Bridge (admin) — move rows between connectors
  listBridgeConnectors: () =>
    json<{ connectors: import("@mia/shared-types").ConnectorInfo[] }>(
      "/api/bridge/connectors",
    ),
  listBridgeTables: (connectorId: string) =>
    json<{ tables: string[] }>(
      `/api/bridge/connectors/${encodeURIComponent(connectorId)}/tables`,
    ),
  previewBridge: (body: {
    source: { connectorId: string; spec: import("@mia/shared-types").ReadSpec }
    transform?: import("@mia/shared-types").Transform
    limit?: number
  }) =>
    json<{ rows: Record<string, unknown>[]; truncated: boolean }>(
      "/api/bridge/preview",
      { method: "POST", body: JSON.stringify(body) },
    ),
  runBridge: (body: {
    source: { connectorId: string; spec: import("@mia/shared-types").ReadSpec }
    target: { connectorId: string; spec: import("@mia/shared-types").WriteSpec; stopOnError?: boolean }
    transform?: import("@mia/shared-types").Transform
  }) =>
    json<import("@mia/shared-types").MoveSummary>("/api/bridge/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Sync definition config (admin)
  listSyncDefinitionConfigs: () => json<import("../types").SyncDefinitionAdminItem[]>("/api/sync-definition-configs"),
  getSyncPublishStatus: () =>
    json<import("../types").SyncPublishStatus>("/api/sync/definitions/publish-status"),
  getSyncPublishPreview: () =>
    json<import("@mia/shared-types").SyncPublishPreview>("/api/sync/definitions/publish-preview"),
  getSyncDefinitionConfigOptions: () => json<import("../types").SyncDefinitionRuntimeOptions>("/api/sync-definition-config-options"),
  updateSyncDefinitionConfig: (entityId: string, fields: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/api/sync-definition-configs/${encodeURIComponent(entityId)}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),
  resetSyncDefinitionConfig: (entityId: string) =>
    json<{ ok: boolean }>(`/api/sync-definition-configs/${encodeURIComponent(entityId)}`, {
      method: "DELETE",
    }),

  getSyncMetadataCatalog: () =>
    json<import("../types").SyncMetadataCatalogResponse>("/api/sync-metadata"),
  saveSyncMetadataStepType: (body: import("../types").SyncMetadataCatalogActionSaveBody) =>
    json<import("../types").SyncMetadataCatalogResponse>("/api/sync-metadata/actions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSyncMetadataStepType: (id: string) =>
    json<import("../types").SyncMetadataCatalogResponse>(
      `/api/sync-metadata/actions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  saveSyncMetadataCustomValueSource: (body: import("../types").SyncMetadataCatalogValueSourceSaveBody) =>
    json<import("../types").SyncMetadataCatalogResponse>("/api/sync-metadata/value-sources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSyncMetadataCustomValueSource: (id: string) =>
    json<import("../types").SyncMetadataCatalogResponse>(
      `/api/sync-metadata/value-sources/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** @deprecated Use saveSyncMetadataCustomValueSource */
  saveSyncMetadataBindingSource: (body: import("../types").SyncMetadataCatalogValueSourceSaveBody) =>
    json<import("../types").SyncMetadataCatalogResponse>("/api/sync-metadata/value-sources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** @deprecated Use deleteSyncMetadataCustomValueSource */
  deleteSyncMetadataBindingSource: (id: string) =>
    json<import("../types").SyncMetadataCatalogResponse>(
      `/api/sync-metadata/value-sources/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  saveSyncMetadataFlow: (body: {
    id: string
    label: string
    description?: string
    steps?: import("../types").AuthoredSyncFlowStep[]
  }) =>
    json<import("../types").SyncMetadataCatalogResponse>("/api/sync-metadata/flows", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSyncMetadataFlow: (id: string) =>
    json<import("../types").SyncMetadataCatalogResponse>(`/api/sync-metadata/flows/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // Data management
  resetData: () => json<{ ok: boolean }>("/api/data", { method: "DELETE" }),

  // Platform health (read-only readiness + admin actions)
  getPlatformHealth: () => json<PlatformHealth>("/api/platform/health"),
  rebuildPlatformCatalog: () =>
    json<{ ok: boolean; message: string }>("/api/platform/catalog/rebuild", { method: "POST" }),
  refreshPlatformArtifacts: (body: {
    source: "shipped" | "mssql"
    connection?: string
    reseedSqlite?: boolean
  }) =>
    json<PlatformArtifactRefreshResult>("/api/platform/artifacts/refresh", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  downloadPlatformArtifacts: (body?: { includeRetiredEntities?: boolean }) =>
    import("../lib/userDownload.js").then(({ downloadAuthenticated }) =>
      downloadAuthenticated(
        "/api/platform/artifacts/export/download",
        "mia-sync-export.zip",
        { method: "POST", body: JSON.stringify(body ?? {}) },
      ),
    ),
  listSyncCatalogVersions: () =>
    json<{
      ok: boolean
      activeVersion: number | null
      versions: Array<{
        tenantId: string
        version: number
        reason: string
        createdBy: string
        createdAt: string
        isActive: boolean
      }>
    }>("/api/platform/catalog/versions"),
  getSyncCatalogVersion: (version: number) =>
    json<{
      ok: boolean
      detail: {
        tenantId: string
        version: number
        reason: string
        createdBy: string
        createdAt: string
        isActive: boolean
        summary: {
          exportedAt: string
          tenantId: string
          entityIds: string[]
          entityCount: number
          configCount: number
          strategyCount: number
          environmentCount: number
          flowCount: number
          stepTypeCount: number
          customValueSourceCount: number
          entities: Array<{ id: string; displayName: string; rootTable: string }>
        }
      }
    }>(`/api/platform/catalog/versions/${encodeURIComponent(String(version))}`),
  getSyncCatalogVersionDiff: (
    version: number,
    against: "previous" | "active" | number = "previous",
  ) => {
    const p = new URLSearchParams()
    p.set("against", String(against))
    return json<{
      ok: boolean
      diff: {
        fromVersion: number | null
        toVersion: number
        against: "previous" | "active" | "version"
        changeCount: number
        impact: import("@mia/shared-types").PlatformImportImpact
        sections: Array<{
          section: string
          label: string
          creates: Array<{
            id: string
            kind: "create"
            changedPaths: string[]
            beforeJson: string | null
            afterJson: string | null
          }>
          updates: Array<{
            id: string
            kind: "update"
            changedPaths: string[]
            beforeJson: string | null
            afterJson: string | null
          }>
          deletes: Array<{
            id: string
            kind: "delete"
            changedPaths: string[]
            beforeJson: string | null
            afterJson: string | null
          }>
        }>
      }
    }>(`/api/platform/catalog/versions/${encodeURIComponent(String(version))}/diff?${p}`)
  },
  importSyncCatalog: (body: { zipBase64?: string; dryRun?: boolean; reason: string }) =>
    json<import("@mia/shared-types").PlatformImportGateResult>("/api/platform/catalog/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rollbackSyncCatalog: (body: { version: number; dryRun?: boolean; reason?: string }) =>
    json<import("@mia/shared-types").PlatformImportGateResult>("/api/platform/catalog/rollback", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  factoryResetPlatform: (confirm: string) =>
    json<{ ok: boolean; message: string; seeded?: number; entityIds?: string[] }>(
      "/api/platform/factory-reset",
      {
        method: "POST",
        body: JSON.stringify({ confirm }),
      },
    ),
  resetFactoryPolicyDefaults: (confirm: string) =>
    json<{
      ok: boolean
      message: string
      removed?: number
      inserted?: number
      clearedEnvDerived?: number
      seedPath?: string
    }>("/api/platform/policies/reset-defaults", {
      method: "POST",
      body: JSON.stringify({ confirm }),
    }),
  setUserAdmin: (identifier: string, isAdmin: boolean) =>
    json<{ upn: string; displayName: string; isAdmin: boolean }>(
      `/api/admin/users/${encodeURIComponent(identifier)}/admin`,
      { method: "PATCH", body: JSON.stringify({ isAdmin }) },
    ),

  // Workspace
  getWorkspace: () => json<{ path: string }>("/api/workspace"),
  setWorkspace: (path: string) =>
    json<{ ok: boolean; path: string }>("/api/workspace", {
      method: "PUT",
      body: JSON.stringify({ path }),
    }),

  // LLM config
  getLlmConfig: () =>
    json<{
      provider: string
      model: string
      hasApiKey: boolean
      baseUrl: string
      updatedAt: string
      defaults: Record<string, { model: string; baseUrl: string; placeholder: string }>
    }>("/api/llm"),
  setLlmConfig: (cfg: { provider: string; model?: string; apiKey?: string; baseUrl?: string }) =>
    json<{ ok: boolean; provider: string; model: string }>("/api/llm", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  // Tools
  listTools: () => json<ToolInfo[]>("/api/tools"),

  // Notifications
  listNotifications: (limit = 50) => json<Notification[]>(`/api/notifications?limit=${limit}`),
  getUnreadCount: () => json<{ count: number }>("/api/notifications/unread-count"),
  markNotificationRead: (id: string) => json<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => json<{ ok: boolean }>("/api/notifications/read-all", { method: "POST" }),
  executeNotificationAction: (id: string, action: string, data?: Record<string, unknown>) =>
    json<{ ok: boolean; runId?: string }>(`/api/notifications/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, data }),
    }),

  // Trajectory
  getTrajectory: (runId: string) =>
    json<{ runId: string; events: Array<{ seq: number; event: Record<string, unknown>; timestamp: string }> }>(
      `/api/trajectory/${encodeURIComponent(runId)}`,
    ),
  replayTrajectory: (runId: string, mutations?: Array<Record<string, unknown>>) =>
    json<{
      valid: boolean
      violations: Array<{ seq: number; from: string; to: string; message: string }>
      scorecard: Record<string, unknown>
      eventCount: number
    }>(`/api/trajectory/${encodeURIComponent(runId)}/replay`, {
      method: "POST",
      body: JSON.stringify({ mutations }),
    }),
  compareTrajectories: (runIdA: string, runIdB: string) =>
    json<{
      sameGoal: boolean
      goalSimilarity: number
      toolOverlap: number
      toolCallDelta: number
      iterationDelta: number
      errorRateDelta: number
      moreEfficient: "a" | "b" | "equal"
      outcomeA: "answer" | "error" | "incomplete"
      outcomeB: "answer" | "error" | "incomplete"
      summary: string
    }>("/api/trajectory/compare", {
      method: "POST",
      body: JSON.stringify({ runIdA, runIdB }),
    }),
  getTrajectorySummary: (runId: string) =>
    json<{ summary: string }>(`/api/trajectory/${encodeURIComponent(runId)}/summary`),

  // Mymi DB explorer
  mymiListDatabases: () =>
    json<Array<{ name: string; server: string; database: string }>>("/api/mymi/databases"),
  mymiOverview: (db?: string) =>
    json<Array<{ schema: string; tableCount: number; viewCount: number; totalRows: number; totalMb: number }>>(
      `/api/mymi/overview${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiListSchemas: (db?: string) =>
    json<Array<{ name: string; tableCount: number; viewCount: number }>>(
      `/api/mymi/schemas${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiSearch: (q: string, db?: string, schemas?: string[]) =>
    json<Array<{
      schema: string; name: string; type: "table" | "view"
      rowCount: number; matchKind: "object" | "column"
      columnName: string | null; columnType: string | null
    }>>(
      `/api/mymi/search?q=${encodeURIComponent(q)}${db ? `&db=${encodeURIComponent(db)}` : ""}${schemas?.length ? `&schemas=${schemas.map(encodeURIComponent).join(",")}` : ""}`,
    ),
  mymiListObjects: (schema: string, db?: string) =>
    json<Array<{ name: string; type: "table" | "view"; rowCount: number; sizeMb: number; columnCount: number }>>(
      `/api/mymi/schema/${encodeURIComponent(schema)}${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiColumns: (schema: string, table: string, db?: string) =>
    json<Array<{
      ordinal: number; name: string; dataType: string; typeDetail: string | null
      nullable: boolean; identity: boolean; computed: boolean; isPk: boolean
      fkSchema: string | null; fkTable: string | null; fkColumn: string | null
      description: string | null
    }>>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/columns${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiRelations: (schema: string, table: string, db?: string) =>
    json<{
      outbound: Array<{ constraintName: string; localColumn: string; refSchema: string; refTable: string; refColumn: string; refRowCount: number }>
      inbound:  Array<{ constraintName: string; srcSchema: string; srcTable: string; srcColumn: string; localColumn: string; srcRowCount: number }>
    }>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/relations${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiPreview: (schema: string, table: string, db?: string, limit?: number) =>
    json<{ columns: Array<{ name: string; type: string }>; rows: Record<string, unknown>[] }>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/preview?${new URLSearchParams({ ...(db ? { db } : {}), ...(limit ? { limit: String(limit) } : {}) }).toString()}`,
    ),
  mymiDataModel: (db?: string) =>
    json<{
      objects: Array<{ schema: string; name: string; isTable: boolean; rowCount: number; sizeMb: number; columnCount: number; fkOut: number; fkIn: number }>
      relations: Array<{ srcSchema: string; srcTable: string; refSchema: string; refTable: string }>
    }>(`/api/mymi/datamodel${db ? `?db=${encodeURIComponent(db)}` : ""}`),

  // ── ABI Environment Sync ────────────────────────────────────
  syncEnvironments: () => json<SyncEnvironment[]>("/api/sync/environments"),
  syncDefinitions: () => json<PublishedSyncDefinition[]>("/api/sync/definitions"),
  syncPublishedBundleEntry: (entityId: string) =>
    json<{
      bundlePath?: string
      bundlePublishedAt?: string
      bundlePublishedVersion?: string
      definition?: PublishedSyncDefinition
      error?: string
    }>(`/api/sync/definitions/${encodeURIComponent(entityId)}/published-bundle`),
  publishSyncDefinitions: () => json<PublishSyncDefinitionsResponse>("/api/sync/definitions/publish", { method: "POST" }),
  syncSearch: (params: {
    entityType: SyncEntityType
    source: string
    q: string
    limit?: number
    mode?: "name" | "id"
  }) =>
    json<Array<{ id: string | number; name: string | null }>>(
      `/api/sync/search?entityType=${encodeURIComponent(params.entityType)}&source=${encodeURIComponent(params.source)}&q=${encodeURIComponent(params.q)}${params.mode ? `&mode=${encodeURIComponent(params.mode)}` : ""}${params.limit ? `&limit=${params.limit}` : ""}`,
    ),
  syncPreview: (params: { entityType: SyncEntityType; entityId: string | number; source: string; target: string; force?: boolean; enabledOptionalTables?: string[] }) =>
    json<SyncPlan & { error?: string }>("/api/sync/preview", { method: "POST", body: JSON.stringify(params) }),
  syncPlan: (planId: string) => json<SyncPlan & { error?: string }>(`/api/sync/plan/${encodeURIComponent(planId)}`),
  syncExecute: (planId: string) =>
    json<{ planId: string; success: boolean; error?: string }>(
      `/api/sync/execute/${encodeURIComponent(planId)}`,
      { method: "POST" },
    ),
  approveSyncPolicyApproval: (id: string) =>
    json<{ approval: { id: string; status: string } }>(
      `/api/sync/policy-approvals/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
    ),
  denySyncPolicyApproval: (id: string) =>
    json<{ approval: { id: string; status: string } }>(
      `/api/sync/policy-approvals/${encodeURIComponent(id)}/deny`,
      { method: "POST" },
    ),
  cancelSyncExecute: (planId: string) =>
    json<{ cancelled: boolean; planId: string }>(
      `/api/sync/execute/${encodeURIComponent(planId)}/cancel`,
      { method: "POST" },
    ),
  syncHistory: (params: SyncHistoryParams = {}) => {
    const sp = new URLSearchParams()
    sp.set("page", String(params.page ?? 1))
    sp.set("pageSize", String(params.pageSize ?? 25))
    if (params.q?.trim()) sp.set("q", params.q.trim())
    if (params.status?.length) sp.set("status", params.status.join(","))
    if (params.entityType?.trim()) sp.set("entityType", params.entityType.trim())
    if (params.actorUpn?.trim()) sp.set("actorUpn", params.actorUpn.trim())
    if (params.source?.trim()) sp.set("source", params.source.trim())
    if (params.target?.trim()) sp.set("target", params.target.trim())
    if (params.from?.trim()) sp.set("from", params.from.trim())
    if (params.to?.trim()) sp.set("to", params.to.trim())
    if (params.sort) sp.set("sort", params.sort)
    return json<SyncHistoryPage>(`/api/sync/history?${sp}`)
  },
  syncHistoryDetail: (planId: string) =>
    json<{
      run: SyncRunSummary
      audit: Array<{
        action: string
        actor: string
        actorUpn: string | null
        timestamp: string
        detail: unknown
      }>
    }>(`/api/sync/history/${encodeURIComponent(planId)}`),
  syncSqlTrace: (planId: string, opts?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (opts?.limit) sp.set("limit", String(opts.limit))
    if (opts?.offset) sp.set("offset", String(opts.offset))
    const q = sp.toString()
    return json<{
      planId: string
      count: number
      total: number
      items: Array<{
        id: number
        planId: string | null
        previewId: string | null
        eventType: string
        scope: string | null
        label: string
        connection: string
        durationMs: number | null
        rowCount: number | null
        error: string | null
        createdAt: string
        sqlPreview: string
        sqlLength: number
      }>
    }>(`/api/sync/history/${encodeURIComponent(planId)}/sql-trace${q ? `?${q}` : ""}`)
  },
  getSqlLog: (id: number, opts?: { signal?: AbortSignal }) =>
    json<{
      id: number
      planId: string | null
      previewId: string | null
      eventType: string
      scope: string | null
      label: string
      connection: string
      sql: string
      sqlLength: number
      durationMs: number | null
      rowCount: number | null
      error: string | null
      createdAt: string
    }>(`/api/events/sql/${id}`, { signal: opts?.signal }),
  /** Recent sync execution runs — used to restore the EnvSync widget on cold start. */
  syncRuns: (limit = 25) =>
    json<Array<SyncRunSummary & { planAvailable?: boolean }>>(`/api/sync/runs?limit=${limit}`),

  /**
   * Recent persisted events from the unified `event_log` table.
   * Used on cold start to backfill the LiveLogs widget so prior sync /
   * agent / system events survive a server restart.
   */
  /**
   * Event Stream page — cursor + time-bounded query over event_log.
   * Datadog-style: exclude_types=debug.trace, since=ISO, before=older cursor.
   */
  listEvents: (opts: {
    limit?: number
    before?: string
    after?: string
    since?: string
    until?: string
    exclude_types?: string[]
    types?: string[]
  } = {}) => {
    const p = new URLSearchParams()
    p.set("limit", String(opts.limit ?? 500))
    if (opts.before) p.set("before", opts.before)
    if (opts.after) p.set("after", opts.after)
    if (opts.since) p.set("since", opts.since)
    if (opts.until) p.set("until", opts.until)
    if (opts.exclude_types?.length) p.set("exclude_types", opts.exclude_types.join(","))
    if (opts.types?.length) p.set("types", opts.types.join(","))
    return json<{
      events: Array<{ id: number; type: string; data: Record<string, unknown>; timestamp: string }>
      count: number
      oldestTimestamp: string | null
      newestTimestamp: string | null
      hasMore: boolean
    }>(`/api/events?${p}`)
  },

  /** @deprecated Prefer listEvents — kept for any residual callers. */
  recentEvents: (limit = 500) =>
    json<{
      events: Array<{ id: number; type: string; data: Record<string, unknown>; timestamp: string }>
      count: number
      hasMore: boolean
    }>(`/api/events?${new URLSearchParams({
      limit: String(limit),
      exclude_types: "debug.trace",
    })}`),

  /** Full-text search of the persistent event_log table. */
  searchEvents: (
    q: string,
    opts: {
      types?: string[]
      type_patterns?: string[]
      limit?: number
      before?: string
      after?: string
    } = {},
  ) => {
    const p = new URLSearchParams()
    if (q.trim()) p.set("q", q.trim())
    if (opts.types?.length) p.set("type", opts.types.join(","))
    if (opts.type_patterns?.length) p.set("type_patterns", opts.type_patterns.join(","))
    if (opts.limit) p.set("limit", String(opts.limit))
    if (opts.before) p.set("before", opts.before)
    if (opts.after) p.set("after", opts.after)
    return json<{ events: Array<{ id: number; type: string; data: Record<string, unknown>; timestamp: string }>; count: number }>(
      `/api/events/search?${p.toString()}`,
    )
  },

  /**
   * Operation Log — three-level grouped history of pipelines → activities → events.
   * Server bundles related events into pipelines (agent runs, sync, Bridge,
   * sync executes, system minute-buckets) so the UI can render an expandable
   * tree.
   */
  operations: (opts: {
    limit?: number
    before?: string
    search?: string
    kind?: string
    status?: string
    planId?: string
    runId?: string
  } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set("limit", String(opts.limit))
    if (opts.before) params.set("before", opts.before)
    if (opts.search) params.set("search", opts.search)
    if (opts.kind) params.set("kind", opts.kind)
    if (opts.status) params.set("status", opts.status)
    if (opts.planId) params.set("planId", opts.planId)
    if (opts.runId) params.set("runId", opts.runId)
    const qs = params.toString()
    return json<OperationsResponse>(`/api/operations${qs ? `?${qs}` : ""}`)
  },

  /** Full audit tree for one sync plan (no event window cap). */
  operationsForPlan: (planId: string) =>
    json<OperationsResponse>(`/api/operations/plan/${encodeURIComponent(planId)}`),

  /** Full audit tree for one agent run (no event window cap). */
  operationsForRun: (runId: string) =>
    json<OperationsResponse>(`/api/operations/run/${encodeURIComponent(runId)}`),

  // ── Attachments ────────────────────────────────────────────────
  /**
   * Upload a single file as an attachment. Returns the persisted metadata
   * including the new attachment id; pass that id to startRun() via
   * attachmentIds to bind it to the run.
   *
   * The body is JSON+base64 because the server uses the matching JSON
   * route (no multipart plugin). The `FileReader` calls are isolated
   * here so callers never touch raw bytes.
   */
  uploadAttachment: async (file: File, opts?: {
    scope?: "user_draft" | "run" | "workspace_asset"
    runId?: string
    purposeTag?: string
  }): Promise<UploadedAttachment> => {
    const contentBase64 = await fileToBase64(file)
    return json<UploadedAttachment>("/api/attachments", {
      method: "POST",
      body: JSON.stringify({
        name:          file.name,
        mediaType:     file.type || "application/octet-stream",
        contentBase64,
        scope:         opts?.scope ?? "user_draft",
        ...(opts?.runId      ? { runId:      opts.runId }      : {}),
        ...(opts?.purposeTag ? { purposeTag: opts.purposeTag } : {}),
      }),
    })
  },

  listAttachments: (filter?: { scope?: string; runId?: string; q?: string }) => {
    const params = new URLSearchParams()
    if (filter?.scope) params.set("scope", filter.scope)
    if (filter?.runId) params.set("runId", filter.runId)
    if (filter?.q)     params.set("q",     filter.q)
    const qs = params.toString()
    return json<UploadedAttachment[]>(`/api/attachments${qs ? `?${qs}` : ""}`)
  },

  /** Download a promoted/generated attachment to the user's machine. */
  downloadAttachment: (id: string, fallbackName: string) =>
    import("../lib/userDownload.js").then(({ downloadAuthenticated }) =>
      downloadAuthenticated(`/api/attachments/${encodeURIComponent(id)}/content`, fallbackName),
    ),

  deleteAttachment: (id: string) =>
    json<{ ok: boolean }>(`/api/attachments/${id}`, { method: "DELETE" }),

  // ── Entity registry ──────────────────────────────────────────
  listEntityRegistry: (opts?: { tenant?: string; includeRetired?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    if (opts?.includeRetired) p.set("includeRetired", "true")
    const qs = p.toString()
    return json<{ tenantId: string; items: import("../types").EntityRegistryDefinition[] }>(
      `/api/entity-registry/entities${qs ? `?${qs}` : ""}`,
    )
  },
  getEntityRegistry: (id: string, opts?: { tenant?: string; version?: number }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    if (opts?.version !== undefined) p.set("version", String(opts.version))
    const qs = p.toString()
    return json<import("../types").EntityRegistryDefinition>(
      `/api/entity-registry/entities/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
    )
  },
  getEntityRegistryHistory: (id: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistryHistoryEntry[]>(
      `/api/entity-registry/entities/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ""}`,
    )
  },
  getEntityRegistryYaml: async (id: string, opts?: { tenant?: string }): Promise<string> => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    const res = await fetch(`${BASE}/api/entity-registry/entities/${encodeURIComponent(id)}.yaml${qs ? `?${qs}` : ""}`, { credentials: "include" })
    if (!res.ok) throw new Error(await res.text())
    return await res.text()
  },
  getEntityRegistryJson: async (id: string, opts?: { tenant?: string }): Promise<string> => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    const res = await fetch(
      `${BASE}/api/entity-registry/entities/${encodeURIComponent(id)}/registry.json${qs ? `?${qs}` : ""}`,
      { credentials: "include" },
    )
    if (!res.ok) throw new Error(await res.text())
    return await res.text()
  },
  suggestEntityRegistryDraft: (rootTable: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    p.set("rootTable", rootTable)
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<EntityRegistryDraftSuggestion>(
      `/api/entity-registry/suggest-draft?${qs}`,
    )
  },
  suggestEntityRegistryTable: (
    args: { rootTable: string; idColumn: string; tableName: string; executionOrder?: number },
    opts?: { tenant?: string },
  ) => {
    const p = new URLSearchParams()
    p.set("rootTable", args.rootTable)
    p.set("idColumn", args.idColumn)
    p.set("tableName", args.tableName)
    if (args.executionOrder !== undefined) p.set("executionOrder", String(args.executionOrder))
    if (opts?.tenant) p.set("tenant", opts.tenant)
    return json<EntityRegistryTableSuggestion>(`/api/entity-registry/suggest-table?${p.toString()}`)
  },
  saveEntityRegistry: (def: import("../types").EntityRegistryDefinition, reason: string, opts?: { tenant?: string; versionLabel?: string; createOnly?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistrySaveResponse>(
      `/api/entity-registry/entities${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        body:   JSON.stringify({
          def,
          reason,
          versionLabel: opts?.versionLabel ?? null,
          createOnly: opts?.createOnly === true,
        }),
      },
    )
  },
  retireEntityRegistry: (id: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{ retiredAt: string }>(`/api/entity-registry/entities/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, { method: "DELETE" })
  },
  previewEntityRegistryYaml: (
    def: import("../types").EntityRegistryDefinition,
    opts?: { tenant?: string },
  ) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistryPreviewYamlResponse>(
      `/api/entity-registry/entities/preview-yaml${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({ def }),
      },
    )
  },
  previewEntityRegistryJson: (
    def: import("../types").EntityRegistryDefinition,
    opts?: { tenant?: string },
  ) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistryPreviewJsonResponse>(
      `/api/entity-registry/entities/preview-json${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({ def }),
      },
    )
  },
  importEntityRegistryYaml: (yaml: string, reason: string, opts?: { tenant?: string; dryRun?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistryYamlImportResponse>(
      `/api/entity-registry/entities/import-yaml${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        body:   JSON.stringify({ yaml, reason, dryRun: opts?.dryRun ?? false }),
      },
    )
  },
  importEntityRegistryJson: (jsonStr: string, reason: string, opts?: { tenant?: string; dryRun?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").EntityRegistryYamlImportResponse>(
      `/api/entity-registry/entities/import-registry-json${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({ json: jsonStr, reason, dryRun: opts?.dryRun ?? false }),
      },
    )
  },
  listEntityRegistryStrategies: (opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{ tenantId: string; items: import("../types").EntityRegistryStrategy[] }>(
      `/api/entity-registry/strategies${qs ? `?${qs}` : ""}`,
    )
  },
  saveEntityRegistryStrategy: (
    strategy: import("../types").EntityRegistryStrategy,
    reason: string,
    opts?: { tenant?: string },
  ) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{ tenantId: string; id: string; version: number }>(
      `/api/entity-registry/strategies${qs ? `?${qs}` : ""}`,
      { method: "POST", body: JSON.stringify({ strategy, reason }) },
    )
  },
  listEntityRegistryStrategyHistory: (id: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{
      tenantId: string
      id: string
      items: import("../types").EntityRegistryStrategyHistoryEntry[]
    }>(`/api/entity-registry/strategies/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ""}`)
  },
  retireEntityRegistryStrategy: (id: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{ retiredAt: string }>(
      `/api/entity-registry/strategies/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" },
    )
  },

  // ── Freeze windows (governance) ──────────────────────────────
  listFreezeWindows: (opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").FreezeWindowListResponse>(
      `/api/sync/freeze-windows${qs ? `?${qs}` : ""}`,
    )
  },
  upsertFreezeWindow: (
    body: import("../types").FreezeWindowSaveRequest,
    opts?: { tenant?: string },
  ) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<import("../types").FreezeWindow>(
      `/api/sync/freeze-windows${qs ? `?${qs}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    )
  },
  deleteFreezeWindow: (id: string, opts?: { tenant?: string }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    const qs = p.toString()
    return json<{ ok: true }>(
      `/api/sync/freeze-windows/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" },
    )
  },

  // ── F1 — Reconciliation proposer ─────────────────────────────
  listProposerRuns:  (opts?: { tenant?: string; limit?: number }) => {
    const p = new URLSearchParams()
    if (opts?.tenant) p.set("tenant", opts.tenant)
    if (opts?.limit)  p.set("limit", String(opts.limit))
    const qs = p.toString()
    return json<Array<Record<string, unknown>>>(`/api/proposer/runs${qs ? `?${qs}` : ""}`)
  },
  triggerProposerRun: (source: string, target: string, tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<{ accepted: boolean; source: string; target: string; runId: string }>(`/api/proposer/run${qs}`, {
      method: "POST", body: JSON.stringify({ source, target }),
    })
  },
  cancelProposerRun: (runId: string) =>
    json<{ cancelled: boolean; runId: string }>(
      `/api/proposer/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    ),
  listProposals: (opts: {
    tenant?: string; status?: string; riskTier?: string;
    source?: string; target?: string; limit?: number;
  } = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(opts)) if (v != null) p.set(k, String(v))
    const qs = p.toString()
    return json<Array<Record<string, unknown>>>(`/api/proposer/proposals${qs ? `?${qs}` : ""}`)
  },
  getProposal: (id: string) =>
    json<Record<string, unknown>>(`/api/proposer/proposals/${encodeURIComponent(id)}`),
  updateProposalStatus: (id: string, body: { to: string; reason?: string; planId?: string; snoozeUntil?: string; supersededBy?: string }) =>
    json<Record<string, unknown>>(`/api/proposer/proposals/${encodeURIComponent(id)}/status`, {
      method: "POST", body: JSON.stringify(body),
    }),
  listProposerSchedules: (tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<Array<Record<string, unknown>>>(`/api/proposer/schedules${qs}`)
  },
  upsertProposerSchedule: (body: { source: string; target: string; cron: string; enabled?: boolean }, tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<Record<string, unknown>>(`/api/proposer/schedules${qs}`, {
      method: "POST", body: JSON.stringify(body),
    })
  },
  deleteProposerSchedule: (tenant: string, source: string, target: string) =>
    json<{ ok: boolean }>(
      `/api/proposer/schedules/${encodeURIComponent(tenant)}/${encodeURIComponent(source)}/${encodeURIComponent(target)}`,
      { method: "DELETE" },
    ),

  // ── F1 — Approvals ──────────────────────────────────────────
  listApprovals: (opts: { tenant?: string; state?: string; proposalId?: string } = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(opts)) if (v != null) p.set(k, String(v))
    const qs = p.toString()
    return json<Array<Record<string, unknown>>>(`/api/approvals${qs ? `?${qs}` : ""}`)
  },
  getApproval: (id: string) =>
    json<Record<string, unknown>>(`/api/approvals/${encodeURIComponent(id)}`),
  createApproval: (body: { proposalId: string; planId?: string; planHash?: string; ttlMs?: number }) =>
    json<Record<string, unknown>>(`/api/approvals`, { method: "POST", body: JSON.stringify(body) }),
  grantApproval: (id: string, planHashAtGrant?: string) =>
    json<Record<string, unknown>>(`/api/approvals/${encodeURIComponent(id)}/grant`, {
      method: "POST", body: JSON.stringify({ planHashAtGrant }),
    }),
  rejectApproval: (id: string, reason: string) =>
    json<Record<string, unknown>>(`/api/approvals/${encodeURIComponent(id)}/reject`, {
      method: "POST", body: JSON.stringify({ reason }),
    }),
  bypassApproval: (id: string, reason: string) =>
    json<Record<string, unknown>>(`/api/approvals/${encodeURIComponent(id)}/bypass`, {
      method: "POST", body: JSON.stringify({ reason }),
    }),
  listApprovalPolicies: (tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<Array<Record<string, unknown>>>(`/api/approvals/policies${qs}`)
  },
  upsertApprovalPolicy: (body: {
    targetEnv?: string
    riskTier: string
    kind: "none" | "single" | "dual"
    approvers?: string[]
    bypassRole?: string | null
  }, tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<{ ok: boolean }>(`/api/approvals/policies${qs}`, { method: "PUT", body: JSON.stringify(body) })
  },
  deleteApprovalPolicy: (targetEnv: string, riskTier: string, tenant?: string) => {
    const p = new URLSearchParams({ targetEnv, riskTier })
    if (tenant) p.set("tenant", tenant)
    return json<{ ok: boolean }>(`/api/approvals/policies?${p.toString()}`, { method: "DELETE" })
  },

  // ── F1 — Evidence ───────────────────────────────────────────
  listEvidence: (opts: { tenant?: string; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.tenant) p.set("tenant", opts.tenant)
    if (opts.limit)  p.set("limit", String(opts.limit))
    const qs = p.toString()
    return json<Array<Record<string, unknown>>>(`/api/evidence${qs ? `?${qs}` : ""}`)
  },
  getEvidenceByPlan: (planId: string) =>
    json<Record<string, unknown>>(`/api/evidence/by-plan/${encodeURIComponent(planId)}`),
  verifyEvidence: (id: string) =>
    json<Record<string, unknown>>(`/api/evidence/${encodeURIComponent(id)}/verify`, { method: "POST" }),
  evidenceEnvelopeUrl: (id: string) => `/api/evidence/${encodeURIComponent(id)}/envelope.json`,
  evidencePdfUrl:      (id: string) => `/api/evidence/${encodeURIComponent(id)}/evidence.pdf`,

  // ── F1 — Notification routes ────────────────────────────────
  listNotificationRoutes: (tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<Array<Record<string, unknown>>>(`/api/notification-routes${qs}`)
  },
  upsertNotificationRoute: (body: { id?: string; eventType: string; filter: Record<string, unknown>; channel: "email"|"teams"|"slack"; target: string; enabled?: boolean }, tenant?: string) => {
    const qs = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""
    return json<Record<string, unknown>>(`/api/notification-routes${qs}`, { method: "POST", body: JSON.stringify(body) })
  },
  deleteNotificationRoute: (id: string) =>
    json<{ ok: boolean }>(`/api/notification-routes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listNotificationLog: (opts: { status?: "sent"|"retrying"|"dlq"|"suppressed"; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.status) p.set("status", opts.status)
    if (opts.limit)  p.set("limit", String(opts.limit))
    const qs = p.toString()
    return json<Array<Record<string, unknown>>>(`/api/notification-routes/log${qs ? `?${qs}` : ""}`)
  },
}

export interface UploadedAttachment {
  id:             string
  scope:          "run" | "user_draft" | "workspace_asset"
  originalName:   string
  normalizedName: string
  mediaType:      string
  sizeBytes:      number
  contentHash:    string
  ingestionMode:  "text_inline" | "text_retrieval" | "binary_reference" | "provider_file_api"
  uploadedAt:     string
  purposeTag:     string | null
}

/**
 * Read a browser File into a base64 string. Strips the data: URL prefix
 * the FileReader emits so the result matches what the server expects in
 * `contentBase64`.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("unexpected reader result"))
        return
      }
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export interface OperationEvent {
  type: string
  timestamp: string
  data: Record<string, unknown>
}
export interface OperationActivity {
  id: string
  name: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  summary?: string
  details?: Record<string, unknown>
  error?: string
  events: OperationEvent[]
  /** Nested detail rows (e.g. per-table work under metadataSync). */
  children?: OperationActivity[]
}
export interface OperationPipeline {
  id: string
  kind: OperationKind
  /** Sync plan id when kind is sync-preview, sync-execute, or sync-run. */
  planId?: string
  title: string
  subtitle?: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  activityCount: number
  eventCount: number
  error?: string
  activities: OperationActivity[]
}
export interface OperationsResponse {
  operations: OperationPipeline[]
  scannedEvents: number
  oldestTimestamp: string | null
  hasMore: boolean
  mode: "list" | "focus"
}

/** @deprecated Use OperationsResponse — plan/run routes return the same shape. */
export interface OperationAuditResponse extends OperationsResponse {
  operation: OperationPipeline | null
}

/**
 * Open an SSE stream for a sync execution. Returns a `close()` function.
 * `onEvent` is called for each progress event (started → table-* → completed/failed).
 */
export function syncExecuteStream(
  planId: string,
  onEvent: (e: SyncExecuteProgress) => void,
  onError?: (err: string, meta?: { code?: string; approvalId?: string; policyName?: string }) => void,
): { close: () => void } {
  const ctrl = new AbortController()
  const url = `/api/sync/execute/${encodeURIComponent(planId)}/stream`

  void (async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/event-stream" },
        signal: ctrl.signal,
      })
      const contentType = res.headers.get("content-type") ?? ""
      if (!res.ok || contentType.includes("application/json")) {
        const body = (await res.json().catch((err: unknown) => { console.error("[mia]", err) })) as {
          error?: string
          code?: string
          approvalId?: string
          policyName?: string
        } | null
        onError?.(body?.error ?? `Execute failed (${res.status})`, {
          code: body?.code,
          approvalId: body?.approvalId,
          policyName: body?.policyName,
        })
        return
      }
      if (!res.body) {
        onError?.("Empty execute stream")
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))
          if (!dataLine) continue
          try {
            onEvent(JSON.parse(dataLine.slice(6)) as SyncExecuteProgress)
          } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e))
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return
      onError?.(e instanceof Error ? e.message : String(e))
    }
  })()

  return { close: () => ctrl.abort() }
}

// ── Live event stream + cross-tab relay via BroadcastChannel ─────
//
// Transport: Server-Sent Events (HTTP streaming). Works through any HTTP
// reverse proxy without HTTP upgrade support — including the corp
// proxy-https on the Windows host. Auto-reconnects via the browser's
// EventSource implementation.

const BC_CHANNEL = "mia-ws-relay"

export function createEventStream(
  onEvent: (event: SseEvent) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const url = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/events/stream`

  let es: EventSource | null = null
  let alive = true

  // Deduplicate events across stream + BroadcastChannel
  const seen = new Set<string>()
  function eventKey(e: { type: string; timestamp: string; data: Record<string, unknown> }): string {
    // debug.trace events need entry-level uniqueness (kind + seq) since
    // multiple entries can share the same timestamp + runId
    const seq = e.data["seq"] ?? ""
    const kind = e.type === "debug.trace" ? ((e.data["entry"] as Record<string, unknown>)?.["kind"] ?? "") : ""
    return `${e.type}:${e.timestamp}:${e.data["runId"] ?? ""}:${sseStepDedupeToken(e.data)}:${kind}:${seq}`
  }
  function dedupe(event: { type: string; data: Record<string, unknown>; timestamp: string }): boolean {
    const key = eventKey(event)
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 500) {
      const arr = [...seen].slice(-250)
      seen.clear()
      arr.forEach((k) => seen.add(k))
    }
    return true
  }

  // Cross-tab relay: share events between all windows
  const bc = new BroadcastChannel(BC_CHANNEL)
  bc.onmessage = (e) => {
    try {
      if (dedupe(e.data)) onEvent(e.data)
    } catch (err: unknown) { console.error("[mia]", err) }
  }

  function connect() {
    if (!alive) return
    es = new EventSource(url, { withCredentials: true })

    es.onopen = () => onStatus(true)

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string)
        if (dedupe(event)) {
          onEvent(event)
          bc.postMessage(event)
        }
      } catch (err: unknown) { console.error("[mia]", err) }
    }

    es.onerror = () => {
      onStatus(false)
      // EventSource auto-reconnects; nothing else to do unless we've torn down.
      if (!alive) es?.close()
    }
  }

  connect()

  return {
    close() {
      alive = false
      bc.close()
      es?.close()
    },
  }
}

/**
 * Pop-out window event relay — listens via BroadcastChannel only (no SSE).
 * Avoids duplicate connections and prevents SSE replays from clearing live state.
 */
export function createPopoutEventRelay(
  onEvent: (event: SseEvent) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const bc = new BroadcastChannel(BC_CHANNEL)
  onStatus(true) // assume connected — main window manages the SSE
  bc.onmessage = (e) => {
    try { onEvent(e.data) } catch (err: unknown) { console.error("[mia]", err) }
  }
  return { close: () => bc.close() }
}

export interface PlatformHealth {
  ready: boolean
  hints: string[]
  mssql: { configured: boolean; connections: string[]; summary: string }
  catalog: { available: boolean; detail: string | null }
  entities: { count: number; valid: boolean; errors: string[] }
  publish: {
    ready: boolean
    publishedAt: string | null
    publishedVersion: string | null
    definitionCount: number
  }
}

export interface PlatformArtifactRefreshResult {
  ok: boolean
  message: string
  source: "shipped" | "mssql"
  connection?: string
  entities?: string[]
  stepTypes?: number
  flows?: number
  activitySpecs?: number
  reseeded?: { seeded: number; entityIds: string[] }
}
