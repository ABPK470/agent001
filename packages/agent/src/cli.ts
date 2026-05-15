/**
 * CLI entry point — run the agent interactively or with a goal.
 *
 * Usage:
 *   # Interactive mode (governed — with audit + policies)
 *   npm start -w packages/agent
 *
 *   # One-shot mode
 *   npm start -w packages/agent -- "Summarize the README.md in this project"
 *
 *   # Raw mode (no governance, no audit — bare agent loop)
 *   AGENT_MODE=raw npm start -w packages/agent
 *
 * Environment variables (point at any OpenAI-compatible endpoint):
 *   LLM_BASE_URL   — base URL (e.g. http://localhost:11434/v1 for Ollama)
 *   LLM_API_KEY    — API key (most local servers ignore it; defaults to "local")
 *   MODEL          — model name (default: llama3 — set to whatever your local server serves)
 *   AGENT_MODE     — "governed" (default) or "raw"
 *
 * Production deployments should use the server (`packages/server`) instead of
 * this CLI — the server handles Copilot Chat / Databricks auth, multi-tenancy,
 * and the full REST/SSE surface.
 */

import { createInterface } from "node:readline"
import { Agent } from "./agent/index.js"
import {
    createEngineServices,
    printGovernanceReport,
    runGoverned,
    type EngineServices,
} from "./governance/index.js"
import { OpenAICompatibleClient } from "./llm/index.js"
import { appendFileTool, fetchUrlTool, listDirectoryTool, readFileTool, replaceInFileTool, shellTool, thinkTool, writeFileTool } from "./tools/index.js"
import type { LLMClient, Tool } from "./types.js"

// ── Create LLM client from env ──────────────────────────────────

function createLLMClient(): LLMClient {
  const baseUrl = process.env["LLM_BASE_URL"] ?? "http://localhost:11434/v1"
  const apiKey  = process.env["LLM_API_KEY"]  ?? "local"
  const model   = process.env["MODEL"]        ?? "llama3"
  console.log(`🧠 Using OpenAI-compatible endpoint at ${baseUrl} (model=${model})`)
  return new OpenAICompatibleClient({ apiKey, model, baseUrl })
}

// ── All available tools ──────────────────────────────────────────

function allTools(): Tool[] {
  return [
    fetchUrlTool,
    readFileTool,
    writeFileTool,
    appendFileTool,
    replaceInFileTool,
    listDirectoryTool,
    shellTool,
    thinkTool,
  ]
}

// ── Setup default policies ───────────────────────────────────────

function setupDefaultPolicies(services: EngineServices): void {
  // Example: require approval for shell commands
  // Uncomment to activate:
  // services.policyEvaluator.addRule({
  //   name: "approve_shell",
  //   effect: PolicyEffect.RequireApproval,
  //   condition: "action:run_command",
  //   parameters: {},
  // })

  // Example: deny web access entirely
  // services.policyEvaluator.addRule({
  //   name: "no_web",
  //   effect: PolicyEffect.Deny,
  //   condition: "action:fetch_url",
  //   parameters: {},
  // })
}

// ── Raw mode (no governance) ─────────────────────────────────────

async function runRaw(llm: LLMClient, goal: string): Promise<void> {
  const tools = allTools()
  console.log(`🔧 Tools: ${tools.map((t) => t.name).join(", ")}`)
  console.log("⚠️  Raw mode — no audit, no policies, no tracking\n")
  const agent = new Agent(llm, tools)
  await agent.run(goal)
}

async function replRaw(llm: LLMClient): Promise<void> {
  const tools = allTools()
  console.log(`🔧 Tools: ${tools.map((t) => t.name).join(", ")}`)
  console.log("⚠️  Raw mode — no audit, no policies, no tracking\n")
  console.log("Type a goal for the agent (or 'exit' to quit):\n")

  const agent = new Agent(llm, tools)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const prompt = (): void => {
    rl.question("🎯 > ", async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        rl.close()
        return
      }
      try {
        await agent.run(trimmed)
      } catch (err) {
        console.error("💥 Agent error:", err instanceof Error ? err.message : err)
      }
      prompt()
    })
  }
  prompt()
}

// ── Governed mode (with engine substrate) ────────────────────────

async function runGovernedMode(llm: LLMClient, goal: string): Promise<void> {
  const tools = allTools()
  const services = createEngineServices()
  setupDefaultPolicies(services)

  console.log(`🔧 Tools: ${tools.map((t) => t.name).join(", ")}`)
  console.log("🛡️  Governed mode — audit trail + policies + run tracking\n")

  const result = await runGoverned(goal, llm, tools, services)
  printGovernanceReport(result)
}

async function replGoverned(llm: LLMClient): Promise<void> {
  const tools = allTools()
  const services = createEngineServices()
  setupDefaultPolicies(services)

  console.log(`🔧 Tools: ${tools.map((t) => t.name).join(", ")}`)
  console.log("🛡️  Governed mode — audit trail + policies + run tracking")
  console.log("Type a goal for the agent (or 'exit' to quit):\n")

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const prompt = (): void => {
    rl.question("🎯 > ", async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        rl.close()
        return
      }
      try {
        const result = await runGoverned(trimmed, llm, tools, services)
        printGovernanceReport(result)
      } catch (err) {
        console.error("💥 Agent error:", err instanceof Error ? err.message : err)
      }
      prompt()
    })
  }
  prompt()
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const llm = createLLMClient()
  const mode = process.env["AGENT_MODE"] ?? "governed"
  const goal = process.argv.slice(2).join(" ")

  if (mode === "raw") {
    if (goal) await runRaw(llm, goal)
    else await replRaw(llm)
  } else {
    if (goal) await runGovernedMode(llm, goal)
    else await replGoverned(llm)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
