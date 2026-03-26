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
 * Environment variables:
 *   OPENAI_API_KEY    — use OpenAI (gpt-4o by default)
 *   ANTHROPIC_API_KEY — use Anthropic (claude-sonnet-4-20250514 by default)
 *   MODEL             — override the model name
 *   AGENT_MODE        — "governed" (default) or "raw"
 */

import { createInterface } from "node:readline"
import { Agent } from "./agent.js"
import {
    createEngineServices,
    printGovernanceReport,
    runGoverned,
    type EngineServices,
} from "./governance.js"
import { AnthropicClient } from "./llm/anthropic.js"
import { OpenAIClient } from "./llm/openai.js"
import { fetchUrlTool } from "./tools/fetch-url.js"
import { listDirectoryTool, readFileTool, writeFileTool } from "./tools/filesystem.js"
import { shellTool } from "./tools/shell.js"
import { thinkTool } from "./tools/think.js"
import type { LLMClient, Tool } from "./types.js"

// ── Create LLM client from env ──────────────────────────────────

function createLLMClient(): LLMClient {
  const model = process.env["MODEL"]

  const anthropicKey = process.env["ANTHROPIC_API_KEY"]
  if (anthropicKey) {
    console.log(`🧠 Using Anthropic (${model ?? "claude-sonnet-4-20250514"})`)
    return new AnthropicClient({ apiKey: anthropicKey, model })
  }

  const openaiKey = process.env["OPENAI_API_KEY"]
  if (openaiKey) {
    console.log(`🧠 Using OpenAI (${model ?? "gpt-4o"})`)
    return new OpenAIClient({ apiKey: openaiKey, model })
  }

  console.error(
    "❌ No API key found.\n\n" +
      "Set one of these environment variables:\n" +
      "  export OPENAI_API_KEY=sk-...\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n",
  )
  process.exit(1)
}

// ── All available tools ──────────────────────────────────────────

function allTools(): Tool[] {
  return [
    fetchUrlTool,
    readFileTool,
    writeFileTool,
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
