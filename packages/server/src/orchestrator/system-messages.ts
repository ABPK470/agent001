import type { Message, Tool } from "@agent001/agent"
import { DEFAULT_SYSTEM_PROMPT } from "@agent001/agent"
import { buildEnvironmentContext, buildToolContext, getWorkspaceContext } from "../prompt-builder.js"
import type { RunWorkspaceContext } from "../run-workspace.js"

// ── System message construction ───────────────────────────────────

/**
 * Build the structured multi-message system prompt.
 * Each section gets its own system message with a budget section tag,
 * enabling intelligent truncation when approaching token limits.
 */
export async function buildSystemMessages(opts: {
  goal: string
  systemPrompt: string | undefined
  allTools: Tool[]
  runWorkspace: RunWorkspaceContext
  perTier: { working: string; episodic: string; semantic: string }
  runId: string
}): Promise<Message[]> {
  const { goal: _goal, systemPrompt, allTools, runWorkspace, perTier } = opts

  const systemMessages: Message[] = []

  // Section 1: system_anchor — base prompt + environment (NEVER dropped)
  const basePrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const envBlock = buildEnvironmentContext()
  systemMessages.push({
    role: "system",
    content: `${basePrompt}\n${envBlock}`,
    section: "system_anchor",
  })

  // Section 2: system_runtime — tool capabilities (droppable)
  const toolCtx = buildToolContext(allTools)
  if (toolCtx) {
    systemMessages.push({
      role: "system",
      content: toolCtx.trim(),
      section: "system_runtime",
    })
  }

  // Section 3: system_runtime — workspace context (droppable)
  if (runWorkspace.executionRoot) {
    const wsContext = await getWorkspaceContext(runWorkspace.executionRoot)
    systemMessages.push({
      role: "system",
      content: [`Workspace: ${runWorkspace.executionRoot}`, wsContext, ""].join("\n"),
      section: "system_runtime",
    })
  }

  // Sections 4–6: memory tiers (each independent for fine-grained truncation)
  if (perTier.working) {
    systemMessages.push({
      role: "system",
      content: `<working_memory>\n${perTier.working}\n</working_memory>`,
      section: "memory_working",
    })
  }

  if (perTier.episodic) {
    // Only fire the SKIP-DISCOVERY directive when the episodic entry is genuinely
    // successful. A failed planner run stores "Status: completed" but with an answer
    // that starts with "Task FAILED" — following that as positive evidence would
    // cause the agent to reproduce the failure. Exclude those entries.
    const episodicHasCompletedEntry =
      perTier.episodic.includes("Status: completed") &&
      !perTier.episodic.includes("Answer: Task FAILED")
    const episodicContent = episodicHasCompletedEntry
      ? [
          "⚠️ MEMORY HIT — prior completed run found for this goal.",
          "REQUIRED ACTION: Extract the confirmed tables/columns/approach from the",
          "episodic_memory Answer section below and use them directly in your first tool call.",
          "DO NOT call search_catalog or explore_mssql_schema for tables already listed there.",
          "The 'NEVER skip search_catalog' rule is satisfied — memory IS the prior evidence.",
          "Only use discovery tools for information that is genuinely absent from memory.",
          "",
          perTier.episodic,
        ].join("\n")
      : perTier.episodic
    systemMessages.push({
      role: "system",
      content: `<episodic_memory>\n${episodicContent}\n</episodic_memory>`,
      section: "memory_episodic",
    })
  }

  if (perTier.semantic) {
    systemMessages.push({
      role: "system",
      content: `<semantic_memory>\n${perTier.semantic}\n</semantic_memory>`,
      section: "memory_semantic",
    })
  }

  return systemMessages
}
