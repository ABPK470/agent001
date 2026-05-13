import type { Message, Tool } from "@agent001/agent"
import { ABI_SYNC_SECTION, DEFAULT_SYSTEM_PROMPT } from "@agent001/agent"
import { getAttachment, type AttachmentRow } from "../attachments/index.js"
import { buildEnvironmentContext, buildHostedRuntimeContext, buildToolContext, getWorkspaceContext } from "../prompt-builder.js"
import type { RunWorkspaceContext } from "../run-workspace.js"

// ── Sync goal detection ───────────────────────────────────────────

/**
 * Returns true when the goal is related to ABI environment sync / data sync
 * operations. Only in these cases is the full ABI_SYNC_SECTION injected into
 * the system prompt. For all other goals the section is omitted entirely —
 * it's 3-5K tokens of context that is irrelevant for coding, analysis, etc.
 */
function isSyncRelatedGoal(goal: string): boolean {
  return /\bsync\b.*\benviron|\benviron.*\bsync\b|\babi.sync\b|\bsync.preview\b|\bsync.execute\b|\blist.environments\b|\bcompare.catalog|\buspSync|\bmymi\b|\bpipelineActivity\b|\bgateMetadata\b|\bsync.contract\b|\bcontract.sync\b|\bsync.recipe\b|\bsync.entity\b|\benv.sync\b/i.test(goal)
}

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
  attachmentIds?: string[]
}): Promise<Message[]> {
  const { goal, systemPrompt, allTools, runWorkspace, perTier, attachmentIds } = opts

  const systemMessages: Message[] = []

  // Section 1: system_anchor — base prompt + environment (NEVER dropped)
  const basePrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const envBlock = buildEnvironmentContext()
  systemMessages.push({
    role: "system",
    content: `${basePrompt}\n${envBlock}`,
    section: "system_anchor",
  })

  // Section 1b: ABI sync SME — injected ONLY when the goal is sync-related.
  // Keeping this out of the default system prompt saves 3-5K tokens per call
  // on all non-sync tasks (coding, data analysis, etc.).
  if (isSyncRelatedGoal(goal)) {
    systemMessages.push({
      role: "system",
      content: ABI_SYNC_SECTION,
      section: "system_anchor",
    })
  }

  // Section 2: system_runtime — tool capabilities (droppable)
  const toolCtx = buildToolContext(allTools)
  if (toolCtx) {
    systemMessages.push({
      role: "system",
      content: toolCtx.trim(),
      section: "system_runtime",
    })
  }

  // Section 3: system_runtime — workspace / sandbox context (droppable).
  // Hosted runs get a sandbox-only summary that never leaks the real
  // application source tree. Developer runs keep the existing shallow
  // workspace tree dump for tool-call grounding.
  if (runWorkspace.profile === "hosted") {
    systemMessages.push({
      role:    "system",
      content: buildHostedRuntimeContext({ sandboxRoot: runWorkspace.executionRoot }),
      section: "system_runtime",
    })
  } else if (runWorkspace.executionRoot) {
    const wsContext = await getWorkspaceContext(runWorkspace.executionRoot)
    systemMessages.push({
      role: "system",
      content: [`Workspace: ${runWorkspace.executionRoot}`, wsContext, ""].join("\n"),
      section: "system_runtime",
    })
  }

  // Section 3b: attachments — list of user-supplied assets bound to this run.
  // The agent uses the attachment tools (list_attachments / read_attachment /
  // import_attachment) to inspect or pull these into the sandbox; only
  // metadata is included here so prompt size stays bounded.
  const attachmentBlock = buildAttachmentManifest(attachmentIds ?? [])
  if (attachmentBlock) {
    systemMessages.push({
      role: "system",
      content: attachmentBlock,
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
    //
    // Also exclude "punt" answers — runs where the agent gave up and asked for
    // clarification rather than delivering real results. These look "completed" but
    // are not reliable positive evidence. Recognizable by qualifying language in the answer.
    const PUNT_PATTERNS = [
      "please provide more details",
      "please clarify",
      "if you meant",
      "could you clarify",
      "i wasn't able to",
      "unable to find",
      "no tables explicitly mention",
      "if it refers to",
      "let me know which",
      "please let me know",
    ]
    const episodicAnswerSection = perTier.episodic.match(/Answer:([\s\S]+?)(?=\nGoal:|\s*$)/i)?.[1] ?? ""
    const hasPuntAnswer = PUNT_PATTERNS.some(p => episodicAnswerSection.toLowerCase().includes(p))

    const episodicHasCompletedEntry =
      perTier.episodic.includes("Status: completed") &&
      !perTier.episodic.includes("Answer: Task FAILED") &&
      !hasPuntAnswer

    const episodicContent = episodicHasCompletedEntry
      ? [
          "⚠️ MEMORY HIT — prior completed run found for this goal.",
          "SHORTCUT: For tables/columns/queries already confirmed in the Answer below, use them",
          "directly — skip redundant search_catalog or explore_mssql_schema calls for those.",
          "The 'NEVER skip search_catalog' rule is satisfied — memory IS the prior evidence.",
          "",
          "IMPORTANT EXCEPTION — Tool Orchestration override:",
          "If the goal involves an unfamiliar technical term (SQL Server internals like 'tombstone',",
          "'ghost records', 'WAL', 'fill factor', 'spinlock', etc.), ALWAYS use fetch_url to search",
          "the internet FIRST, regardless of what memory shows. Prior runs may have guessed wrong",
          "about what those terms mean. Memory shortcuts apply to table/column names, not to the",
          "interpretation of unfamiliar domain concepts.",
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

// ── Attachments manifest ──────────────────────────────────────────

/**
 * Render the per-run attachment manifest as a compact, deterministic
 * block. One line per attachment with stable fields. Returns the empty
 * string when there are no resolvable attachments (so the caller can
 * skip pushing an empty system message).
 *
 * Important: only metadata is rendered here. Bytes and text extracts
 * stay out of the system prompt so context budgets are not consumed by
 * incidentally-large uploads. The agent pulls content via the
 * attachment tools (Phase 4 milestone 4) when it actually needs it.
 */
function buildAttachmentManifest(ids: string[]): string {
  if (ids.length === 0) return ""
  const rows: AttachmentRow[] = []
  for (const id of ids) {
    const row = getAttachment(id)
    if (row) rows.push(row)
  }
  if (rows.length === 0) return ""
  const header = "Attached files for this run (use attachment tools to inspect or import):"
  const lines = rows.map((r) =>
    `  - id=${r.id}  name=${r.normalized_name}  type=${r.media_type}  size=${r.size_bytes}B  mode=${r.ingestion_mode}`,
  )
  return [header, ...lines].join("\n")
}
