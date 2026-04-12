/**
 * Tool registry — single source of truth for all available agent tools.
 *
 * Agent definitions select a subset of these by name.
 * The registry is populated once at startup; the tools themselves
 * are stateless (workspace path is set globally via setBasePath).
 */

import {
    askUserTool,
    browserCheckTool,
    browseWebTool,
    createDelegateTools,
    fetchUrlTool,
    listDirectoryTool,
    mssqlSchemaTool,
    mssqlTool,
    readFileTool,
    replaceInFileTool,
    searchFilesTool,
    shellTool,
    thinkTool,
    writeFileTool,
    type LLMClient,
    type Tool,
} from "@agent001/agent"
import { AgentBus, createBusTools } from "./agent-bus.js"

export { thinkTool }

export interface ToolInfo {
  name: string
  description: string
}

const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  replaceInFileTool,
  listDirectoryTool,
  searchFilesTool,
  shellTool,
  fetchUrlTool,
  browserCheckTool,
  browseWebTool,
  askUserTool,
  mssqlTool,
  mssqlSchemaTool,
]

const toolMap = new Map<string, Tool>(ALL_TOOLS.map((t) => [t.name, t]))
// thinkTool is not in ALL_TOOLS (won't appear in listings) but stays resolvable
// so existing agent definitions that reference it don't crash.
toolMap.set(thinkTool.name, thinkTool)

const catalogLlm: LLMClient = {
  async chat() {
    return {
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }
  },
}

function listRuntimeCatalogTools(): Tool[] {
  const catalog = new Map<string, Tool>()

  for (const tool of toolMap.values()) catalog.set(tool.name, tool)

  const delegateTools = createDelegateTools({
    llm: catalogLlm,
    availableTools: [...ALL_TOOLS],
    depth: 0,
    maxDepth: 1,
    resolveAgent: () => null,
  })
  for (const tool of delegateTools) catalog.set(tool.name, tool)

  const busTools = createBusTools(new AgentBus("catalog"), "catalog", "Catalog Agent")
  for (const tool of busTools) catalog.set(tool.name, tool)

  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Get all registered tools as a Map. */
export function getToolMap(): ReadonlyMap<string, Tool> {
  return toolMap
}

/** Resolve an array of tool names into Tool objects. Throws on unknown names. */
export function resolveTools(names: string[]): Tool[] {
  return names.map((name) => {
    const tool = toolMap.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool
  })
}

/** List all available tool names + descriptions (for API/UI). */
export function listAvailableTools(): ToolInfo[] {
  return listRuntimeCatalogTools().map((t) => ({ name: t.name, description: t.description }))
}

/** Get all registered tools as an array. */
export function getAllTools(): Tool[] {
  return [...ALL_TOOLS]
}
