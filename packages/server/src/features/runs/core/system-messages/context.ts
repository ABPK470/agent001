/**
 * Normalize run options once and log which optional sections will be injected.
 * Avoids repeating opts?.foo ?? default in every section builder.
 */

import { parseSyncOperationIntentForHost } from "@mia/sync"
import { decideSections } from "../decide-sections.js"
import type { BuildContext, BuildSystemMessagesOptions } from "./types.js"

export function createBuildContext(opts: BuildSystemMessagesOptions): BuildContext {
  return {
    opts,
    runId: opts.runId,
    goal: opts.goal,
    isAdmin: opts.isAdmin ?? false,
    hasSiblings: opts.hasSiblings ?? false,
    siblingProgressDigest: opts.siblingProgressDigest ?? "",
    coordinationTopic: opts.coordinationTopic ?? "",
    priorTurns: opts.priorTurns ?? [],
    knownObjects: opts.knownObjects ?? [],
    knownVerdicts: opts.knownVerdicts ?? [],
    priorResults: opts.priorResults ?? [],
    decision: decideSections({ goal: opts.goal, memory: opts.perTier }),
    syncOperationIntent: opts.host ? parseSyncOperationIntentForHost(opts.goal, opts.host) : null
  }
}

export function logSectionDecision(ctx: BuildContext): void {
  const goalPreview =
    ctx.goal.length > 60
      ? `${ctx.goal.slice(0, 60).replace(/\n/g, " ")}\u2026`
      : ctx.goal.replace(/\n/g, " ")
  // eslint-disable-next-line no-console
  console.log(
    `[sections] run=${ctx.runId} goal="${goalPreview}" ` +
      `dbScore=${ctx.decision.dbScore ?? 0} ` +
      `persona=${ctx.decision.includeDataPersona ? 1 : 0} ` +
      `sync=${ctx.decision.includeAbiSync ? 1 : 0} ` +
      `chart=${ctx.decision.includeChartCatalogue ? 1 : 0} ` +
      `etl=${ctx.decision.includeBigTableEtl ? 1 : 0} ` +
      `mssqlKnow=${ctx.decision.includeMssqlKnowledge ? ctx.decision.mssqlKnowledgeMode : "off"} ` +
      `mssqlCat=${ctx.decision.includeMssqlCatalog ? 1 : 0} ` +
      `mssqlGuide=${ctx.decision.includeMssqlGuidance ? 1 : 0} ` +
      `memGuide=${ctx.decision.includeMemoryGuidance ? 1 : 0} ` +
      `priorTurns=${ctx.priorTurns.length} ` +
      `knownObjects=${ctx.knownObjects.length} ` +
      `knownVerdicts=${ctx.knownVerdicts.length} ` +
      `admin=${ctx.isAdmin ? 1 : 0}`
  )
}
