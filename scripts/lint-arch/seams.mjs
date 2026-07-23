/**
 * Seams registry — SSOT for product capability ownership.
 * Mirrors docs/doctrine.md. Erased capabilities are DATA here, not special-case
 * rules in product.mjs. Adding a capability = add an active seam (additive).
 * Erasing one = set status erased + fingerprints; the runner stays general.
 *
 * @typedef {"active" | "erased"} SeamStatus
 * @typedef {{
 *   id: string
 *   status: SeamStatus
 *   owner: string
 *   apiSurface?: string
 *   notes?: string
 *   forbidPaths?: string[]
 *   forbidIdentifiers?: { id: string, packages?: string[] }[]
 * }} Seam
 */

/** @type {Seam[]} */
export const SEAMS = [
  // ── Active API surfaces (packages/server/src/api/<surface>) ─────────────
  { id: "admin", status: "active", owner: "packages/server/src/api/admin", apiSurface: "admin" },
  { id: "approvals", status: "active", owner: "packages/server/src/api/approvals", apiSurface: "approvals" },
  { id: "attachments", status: "active", owner: "packages/server/src/api/attachments", apiSurface: "attachments" },
  { id: "auth", status: "active", owner: "packages/server/src/api/auth", apiSurface: "auth" },
  { id: "connectors", status: "active", owner: "packages/server/src/api/connectors", apiSurface: "connectors" },
  { id: "events", status: "active", owner: "packages/server/src/api/events", apiSurface: "events" },
  { id: "evidence", status: "active", owner: "packages/server/src/api/evidence", apiSurface: "evidence" },
  { id: "layouts", status: "active", owner: "packages/server/src/api/layouts", apiSurface: "layouts" },
  { id: "llm", status: "active", owner: "packages/server/src/api/llm", apiSurface: "llm" },
  { id: "memory", status: "active", owner: "packages/server/src/api/memory", apiSurface: "memory" },
  { id: "metrics", status: "active", owner: "packages/server/src/api/metrics", apiSurface: "metrics" },
  {
    id: "warehouse-connector",
    status: "active",
    owner: "packages/server/src/api/mymi",
    apiSurface: "mymi",
    notes: "Branded path debt — rename to domain noun (warehouse/connector); see brandAllowlist",
  },
  { id: "notifications", status: "active", owner: "packages/server/src/api/notifications", apiSurface: "notifications" },
  { id: "operations", status: "active", owner: "packages/server/src/api/operations", apiSurface: "operations" },
  { id: "platform", status: "active", owner: "packages/server/src/api/platform", apiSurface: "platform" },
  { id: "policies", status: "active", owner: "packages/server/src/api/policies", apiSurface: "policies" },
  { id: "profile", status: "active", owner: "packages/server/src/api/profile", apiSurface: "profile" },
  { id: "proposer", status: "active", owner: "packages/server/src/api/proposer", apiSurface: "proposer" },
  { id: "run-lifecycle", status: "active", owner: "packages/server/src/api/runs", apiSurface: "runs" },
  { id: "sync", status: "active", owner: "packages/server/src/api/sync", apiSurface: "sync" },
  { id: "threads", status: "active", owner: "packages/server/src/api/threads", apiSurface: "threads" },
  { id: "tool-cache", status: "active", owner: "packages/server/src/api/tool-cache", apiSurface: "tool-cache" },
  { id: "tools-catalog", status: "active", owner: "packages/server/src/api/tools", apiSurface: "tools" },
  { id: "usage", status: "active", owner: "packages/server/src/api/usage", apiSurface: "usage" },
  { id: "webhooks", status: "active", owner: "packages/server/src/api/webhooks", apiSurface: "webhooks" },

  // ── Erased capabilities (fingerprints = data; runner is general) ────────
  {
    id: "agent-profiles",
    status: "erased",
    owner: "packages/server/src/api/agents",
    apiSurface: "agents",
    notes: "CRUD agent profiles erased — runs use resolved systemPrompt; specialization = planner children",
    forbidPaths: ["packages/server/src/api/agents"],
    forbidIdentifiers: [
      { id: "resolveAgent", packages: ["agent"] },
      { id: "ResolvedAgent", packages: ["agent"] },
      { id: "listAgents", packages: ["ui"] },
      { id: "createAgent", packages: ["ui"] },
      { id: "updateAgent", packages: ["ui"] },
      { id: "deleteAgent", packages: ["ui"] },
      { id: "selectedAgentId", packages: ["ui"] },
      { id: "AgentEditor", packages: ["ui"] },
      { id: "AgentDefinition", packages: ["ui"] },
    ],
  },
  {
    id: "dual-delegate-tools",
    status: "erased",
    owner: "packages/agent/src/tools/delegate-ad-hoc",
    notes: "Ad-hoc delegate/delegate_parallel tools erased — one spawn kernel; planner owns fan-out",
    forbidIdentifiers: [
      { id: "createDelegateTools", packages: ["agent"] },
      { id: "createDelegationTools", packages: ["agent"] },
    ],
  },
]

/**
 * Dialect classes — one home per concept forever.
 * A second implementation outside `owners` fails (unless allowlisted debt).
 *
 * @typedef {{
 *   id: string
 *   owners: string[]
 *   description: string
 * }} DialectClass
 */

/** @type {DialectClass[]} */
export const DIALECT_CLASSES = [
  {
    id: "presentation-labels",
    owners: ["packages/shared-types/src"],
    description: "Tool/event presentation label maps — single SoT in shared-types",
  },
  {
    id: "spawn-kernel",
    owners: ["packages/agent/src/tools/delegate-spawn"],
    description: "Child agent spawn — one kernel under tools/delegate-spawn",
  },
  {
    id: "wire-events",
    owners: [
      "packages/shared-types/src/event-catalog.ts",
      "packages/shared-enums/src/event.ts",
      "packages/ui/src/lib/events",
    ],
    description: "Wire TraceEntry.kind / EventType vocabulary + UI projection",
  },
]

/** Brand tokens that must not appear as apiSurface / owner path (ops variance = data). */
export const BRAND_PATH_PATTERN = /(?:^|\/)(mymi|africaflex)(?:\/|$)/i

/**
 * Framework / transport packages forbidden in core|domain layers (value imports).
 * Elasticity: domain rules must not couple to HTTP, React, or DB drivers.
 */
export const FRAMEWORK_DENYLIST = new Set([
  "express",
  "fastify",
  "@fastify/websocket",
  "react",
  "react-dom",
  "react/jsx-runtime",
  "drizzle-orm",
  "drizzle-kit",
  "node:http",
  "node:http2",
  "http",
  "http2",
  "mssql",
])
