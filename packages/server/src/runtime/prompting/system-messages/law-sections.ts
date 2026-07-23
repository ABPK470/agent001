/**
 * system_law sections — highest-priority rules the model must not ignore.
 * Catalog-resolved facts and clarification blocks (must_clarify / resolved).
 */

import {
  detectAmbiguities,
  filterFindingsForSyncIntent,
  getCatalog,
  getCatalogSchemaFingerprint,
  getTenantConfig,
  MessageRole,
  resolveEffectiveMssqlConnection,
  runLlmPlanner,
  shouldInvokePlanner,
  type Message
} from "@mia/agent"
import { buildSyncOperationalVocabularyForHost, formatSyncDriftIntentBlock, formatSyncOperationIntentBlock } from "@mia/sync"
import { listResolvedTerms } from "../../../../infra/persistence/memory.js"
import { buildClarificationBlock } from "../clarification-block.js"
import { buildResolvedFactsBlock } from "../data-blocks/resolved-facts-block.js"
import type { BuildContext } from "./types.js"

/**
 * Build the learned term→table map for this run, scoped to the effective
 * connection and filtered to mappings whose qname still resolves in the live
 * catalog. Stale mappings (table dropped/renamed since) are dropped so they
 * never suppress a genuinely-needed clarification. Returns null when no
 * catalog is available (CLI / tests) or the store is empty.
 */
function buildLearnedTermMappings(
  connection: string,
  catalog: ReturnType<typeof getCatalog>
): Map<string, string> | null {
  if (!catalog) return null
  let rows
  try {
    rows = listResolvedTerms({ connection })
  } catch {
    return null
  }
  const out = new Map<string, string>()
  for (const r of rows) {
    if (catalog.getTable(r.qname)) out.set(r.term.toLowerCase(), r.qname)
  }
  return out.size > 0 ? out : null
}

/**
 * Render a compact `<learned_terms>` advisory block listing the learned
 * mappings that apply to tokens in this goal. This is the "downgrade to
 * advisory" surface: the blocking `ask_user` is suppressed (via
 * entity-canonical), and this one-liner tells the agent — and the user,
 * via the prompt — which assumptions are being reused so they can be
 * corrected ("say otherwise to change"). Only terms that actually appear
 * in the goal are listed, keeping the block tight.
 */
function buildLearnedTermsBlock(
  goal: string,
  learned: Map<string, string>
): string {
  const goalLc = goal.toLowerCase()
  const lines: string[] = []
  for (const [term, qname] of learned) {
    // Match the term OR its singular/plural variant at a word boundary, so a
    // learned "product" still surfaces when the goal says "products" (and
    // vice-versa). The suppression path (entity-canonical) already tolerates
    // this drift; the advisory block should too so the user sees the reused
    // assumption either way.
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const variants = [esc, esc.endsWith("s") ? esc.slice(0, -1) : `${esc}s`]
    const re = new RegExp(`\\b(${variants.join("|")})\\b`)
    if (re.test(goalLc)) {
      lines.push(`  • "${term}" → ${qname}`)
    }
  }
  if (lines.length === 0) return ""
  return [
    "<learned_terms>",
    "Reusing your prior answers for these terms (say otherwise to change):",
    ...lines,
    "</learned_terms>"
  ].join("\n")
}

export async function buildLawSections(ctx: BuildContext): Promise<Message[]> {
  const messages: Message[] = []
  const { opts, runId, goal, decision, syncOperationIntent, syncDriftIntent } = ctx

  const effectiveConnection = opts.host ? resolveEffectiveMssqlConnection(opts.host, goal) : "default"

  try {
    const catalog = opts.host ? getCatalog(opts.host, effectiveConnection) : null
    const fingerprint = opts.host ? getCatalogSchemaFingerprint(opts.host, effectiveConnection) : null
    const block = buildResolvedFactsBlock({ goal, catalog, schemaFingerprint: fingerprint })
    if (block.length > 0) {
      messages.push({ role: MessageRole.System, content: block, section: "system_law" })
    }
  } catch (err) {
    console.warn(`[run ${runId}] resolvedFacts assembly failed:`, (err as Error).message)
  }

  if (!opts.clarifications) return messages

  try {
    const catalog = opts.host ? getCatalog(opts.host, effectiveConnection) : null
    const tenant = getTenantConfig()
    const resolved = opts.clarifications.getResolved(runId)
    const learnedTermMappings = buildLearnedTermMappings(effectiveConnection, catalog)
    const synthMessages: Message[] = []
    for (let i = ctx.priorTurns.length - 1; i >= 0; i--) {
      const t = ctx.priorTurns[i]!
      synthMessages.push({ role: MessageRole.User, content: t.goal })
      synthMessages.push({
        role: MessageRole.Assistant,
        content: t.answer ?? "(no answer recorded)"
      })
    }
    const domainVocabulary =
      (decision.includeAbiSync || syncOperationIntent || syncDriftIntent) && opts.host
        ? { reservedTokens: buildSyncOperationalVocabularyForHost(opts.host) }
        : undefined
    const clarCtx = {
      goal,
      catalog,
      tenant,
      messages: synthMessages as readonly Message[],
      resolved,
      round: 0,
      priorResultsCount: ctx.priorResults.length,
      ...(domainVocabulary ? { domainVocabulary } : {}),
      ...(syncOperationIntent ? { syncOperationIntent } : {}),
      ...(syncDriftIntent ? { syncDriftIntent } : {}),
      ...(learnedTermMappings ? { learnedTermMappings } : {})
    }

    // Advisory: surface the learned mappings reused for this goal so the
    // agent (and user) can see the assumptions and correct them. Emitted
    // before the must_clarify block so it reads as context, not a question.
    if (learnedTermMappings) {
      const learnedBlock = buildLearnedTermsBlock(goal, learnedTermMappings)
      if (learnedBlock.length > 0) {
        messages.push({ role: MessageRole.System, content: learnedBlock, section: "system_law" })
      }
    }

    if (syncOperationIntent) {
      messages.push({
        role: MessageRole.System,
        content: formatSyncOperationIntentBlock(syncOperationIntent),
        section: "system_law"
      })
    }

    if (syncDriftIntent && !syncOperationIntent) {
      messages.push({
        role: MessageRole.System,
        content: formatSyncDriftIntentBlock(syncDriftIntent),
        section: "system_law"
      })
    }

    let findings = filterFindingsForSyncIntent(detectAmbiguities(clarCtx), syncOperationIntent ?? undefined)
    if (
      decision.includeDataPersona &&
      findings.length === 0 &&
      opts.llmForClarification &&
      shouldInvokePlanner(clarCtx, findings)
    ) {
      findings = await runLlmPlanner(clarCtx, opts.llmForClarification)
      opts.onClarificationTrace?.({ kind: "planner-invoked", findingsCount: findings.length })
    }

    if (findings.length > 0) {
      opts.clarifications.recordEmitted(runId, 0, findings)
      for (const f of findings) opts.onClarificationTrace?.({ kind: "detected", finding: f })
      const block = buildClarificationBlock({ findings, resolved })
      if (block.length > 0) {
        messages.push({ role: MessageRole.System, content: block, section: "system_law" })
      }
    } else if (resolved.length > 0) {
      const block = buildClarificationBlock({ findings: [], resolved })
      if (block.length > 0) {
        messages.push({ role: MessageRole.System, content: block, section: "system_law" })
      }
    }
  } catch (err) {
    console.warn(`[run ${runId}] clarification block failed:`, (err as Error).message)
  }

  return messages
}
