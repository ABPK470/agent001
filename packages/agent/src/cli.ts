/**
 * CLI entry point — run the agent interactively or with a goal.
 *
 * Usage:
 *   # Interactive mode (type goals, see the agent work)
 *   npm start -w packages/agent
 *
 *   # One-shot mode
 *   npm start -w packages/agent -- "Summarize the README.md in this project"
 *
 * Environment variables:
 *   OPENAI_API_KEY    — use OpenAI (gpt-4o by default)
 *   ANTHROPIC_API_KEY — use Anthropic (claude-sonnet-4-20250514 by default)
 *   MODEL             — override the model name
 */

import { createInterface } from "node:readline"
import { Agent } from "./agent.js"
import { OpenAIClient } from "./llm/openai.js"
import { AnthropicClient } from "./llm/anthropic.js"
import { fetchUrlTool } from "./tools/fetch-url.js"
import { readFileTool, writeFileTool, listDirectoryTool } from "./tools/filesystem.js"
import { shellTool } from "./tools/shell.js"
import { thinkTool } from "./tools/think.js"
import type { LLMClient } from "./types.js"

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

// ── Assemble the agent ───────────────────────────────────────────

function createAgent(): Agent {
  const llm = createLLMClient()

  // These are the agent's tools — what it can DO
  const tools = [
    fetchUrlTool, // browse the web
    readFileTool, // read local files
    writeFileTool, // write local files
    listDirectoryTool, // explore directories
    shellTool, // run shell commands
    thinkTool, // structured reasoning
  ]

  console.log(`🔧 Tools: ${tools.map((t) => t.name).join(", ")}\n`)

  return new Agent(llm, tools)
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const agent = createAgent()

  // One-shot mode: pass the goal as a CLI argument
  const goal = process.argv.slice(2).join(" ")
  if (goal) {
    await agent.run(goal)
    return
  }

  // Interactive mode: REPL
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
        await agent.run(trimmed)
      } catch (err) {
        console.error("💥 Agent error:", err instanceof Error ? err.message : err)
      }

      prompt()
    })
  }

  prompt()
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
