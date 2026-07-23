/**
 * Seams registry — product capability ownership rows (DATA only).
 * Runners in rules/seams.mjs are general: active | erased | owner uniqueness.
 */

/** @typedef {"active" | "erased"} SeamStatus */
/** @typedef {{
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
    notes: "Branded path debt — rename to domain noun; see brandAllowlist",
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

  {
    id: "agent-profiles",
    status: "erased",
    owner: "packages/server/src/api/agents",
    apiSurface: "agents",
    notes: "Erased capability — specialization is planner children + spawn kernel",
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
      { id: "agentId", packages: ["agent", "ui", "server", "sync"] },
    ],
  },
  {
    id: "dual-delegate-tools",
    status: "erased",
    owner: "packages/agent/src/tools/delegate-ad-hoc",
    notes: "Erased second spawn dialect — one spawn kernel",
    forbidIdentifiers: [
      { id: "createDelegateTools", packages: ["agent"] },
      { id: "createDelegationTools", packages: ["agent"] },
    ],
  },
]
