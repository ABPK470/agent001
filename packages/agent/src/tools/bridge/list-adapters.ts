/**
 * tools/bridge/list-adapters.ts — the `list_adapters` agent tool.
 *
 * Lists the connectors the agent can move data between, with their
 * capabilities (read/write/query). Read-only; thin wrapper over the
 * `host.connectors.port.value` port.
 */

import type { AgentHost } from "../../runtime/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/models/agent-types.js"
import type { ConnectorInfo } from "@mia/shared-types"

function buildListAdaptersTool(host: AgentHost): ExecutableTool {
  return {
    name: "list_adapters",
    description:
      "List connectors available for bridge_data, with their capabilities (read/write/query) and ids. " +
      "Call this before bridge_data to learn the connector ids and what each one supports. Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute(): Promise<string> {
      const port = host.connectors.port.value
      if (!port) {
        return "list_adapters: connector bridge is not configured on this server (no connectors port wired)."
      }
      const adapters: ConnectorInfo[] = port.listAdapters()
      if (adapters.length === 0) {
        return "list_adapters: no connectors configured. Add one via the platform menu → Connectors."
      }
      const lines = [`list_adapters: ${adapters.length} connector(s)`]
      for (const c of adapters) {
        const caps = [
          c.capabilities.read ? "read" : "",
          c.capabilities.write ? "write" : "",
          c.capabilities.query ? "query" : "",
        ]
          .filter(Boolean)
          .join("/")
        const state = c.enabled ? "enabled" : "disabled"
        lines.push(`  ${c.id} [${c.kind}] ${c.displayName} — ${caps || "no-capabilities"} (${state})`)
      }
      return lines.join("\n")
    },
  }
}

export const listAdaptersToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildListAdaptersTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export function createListAdaptersTool(host: AgentHost): ExecutableTool {
  return buildListAdaptersTool(host)
}
