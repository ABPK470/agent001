/**
 * `list_environments` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import { getEnvironments } from "../../runtime/environments-registry.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

// ── list_environments (helper) ───────────────────────────────────

function buildListEnvironmentsTool(host: SyncRuntimeHost): Tool {
  return {
    name: "list_environments",
    description: "List all configured ABI environments (source/target candidates for sync).",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const envs = getEnvironments(host)
      if (envs.length === 0) return "No environments configured."
      const lines = ["Configured ABI environments:"]
      for (const e of envs) {
        lines.push(`  • ${e.name} — ${e.displayName} (${e.role}, ring ${e.ringOrder})`)
      }
      return lines.join("\n")
    }
  }
}

export const listEnvironmentsToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildListEnvironmentsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const listEnvironmentsTool = listEnvironmentsToolMetadata

export function createListEnvironmentsTool(host: SyncRuntimeHost): ExecutableTool {
  return buildListEnvironmentsTool(host)
}
