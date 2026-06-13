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
  runLlmPlanner,
  shouldInvokePlanner,
  type Message
} from "@mia/agent"
import { buildSyncOperationalVocabularyForHost, formatSyncOperationIntentBlock } from "@mia/sync"
import { buildClarificationBlock } from "../clarification-block.js"
import { buildResolvedFactsBlock } from "../data-blocks/resolved-facts-block.js"
import type { BuildContext } from "./types.js"

export async function buildLawSections(ctx: BuildContext): Promise<Message[]> {
  const messages: Message[] = []
  const { opts, runId, goal, decision, syncOperationIntent } = ctx

  try {
    const catalog = opts.host ? getCatalog(opts.host) : null
    const fingerprint = opts.host ? getCatalogSchemaFingerprint(opts.host) : null
    const block = buildResolvedFactsBlock({ goal, catalog, schemaFingerprint: fingerprint })
    if (block.length > 0) {
      messages.push({ role: MessageRole.System, content: block, section: "system_law" })
    }
  } catch (err) {
    console.warn(`[run ${runId}] resolvedFacts assembly failed:`, (err as Error).message)
  }

  if (!opts.clarifications) return messages

  try {
    const catalog = opts.host ? getCatalog(opts.host) : null
    const tenant = getTenantConfig()
    const resolved = opts.clarifications.getResolved(runId)
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
      (decision.includeAbiSync || syncOperationIntent) && opts.host
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
      ...(syncOperationIntent ? { syncOperationIntent } : {})
    }

    if (syncOperationIntent) {
      messages.push({
        role: MessageRole.System,
        content: formatSyncOperationIntentBlock(syncOperationIntent),
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
