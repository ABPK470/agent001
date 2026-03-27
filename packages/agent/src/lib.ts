/**
 * Agent package barrel export.
 *
 * Everything other packages need to run governed agents.
 */

// Core agent
export { Agent } from "./agent.js"

// Types
export type {
    AgentConfig,
    LLMClient,
    LLMResponse,
    Message,
    Tool,
    ToolCall
} from "./types.js"

// Governance
export {
    createEngineServices, createToolStep, governTool, printGovernanceReport,
    runGoverned
} from "./governance.js"
export type { EngineServices, GovernedResult, RunState } from "./governance.js"

// LLM clients
export { AnthropicClient } from "./llm/anthropic.js"
export { OpenAIClient } from "./llm/openai.js"

// Built-in tools
export { fetchUrlTool } from "./tools/fetch-url.js"
export {
    listDirectoryTool, readFileTool, setBasePath, writeFileTool
} from "./tools/filesystem.js"
export { shellTool } from "./tools/shell.js"
export { thinkTool } from "./tools/think.js"

