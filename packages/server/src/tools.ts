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
    type Tool,
} from "@agent001/agent"

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
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description }))
}

/** Get all registered tools as an array. */
export function getAllTools(): Tool[] {
  return [...ALL_TOOLS]
}
