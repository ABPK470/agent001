/**
 * Domain knowledge sections injected when the goal looks data/sync/chart-shaped.
 * Skipped for generic coding tasks to save tokens (persona, ABI sync, charts, ETL).
 */

import {
  ABI_SYNC_SECTION,
  BIG_TABLE_ETL_SECTION,
  buildPromptVars,
  CHART_CATALOGUE_SECTION,
  getCatalog,
  MIA_DATA_PERSONA_SECTION,
  MessageRole,
  renderPromptVars,
  type Message
} from "@mia/agent"
import type { BuildContext } from "./types.js"

export function buildKnowledgeSections(ctx: BuildContext): Message[] {
  const { opts, decision, syncOperationIntent } = ctx
  const messages: Message[] = []
  const promptVars = buildPromptVars({
    accessor: () => (opts.host ? getCatalog(opts.host, "default") : null)
  })

  if (decision.includeDataPersona) {
    messages.push({
      role: MessageRole.System,
      content: renderPromptVars(MIA_DATA_PERSONA_SECTION, promptVars),
      section: "system_anchor"
    })
  }

  if (decision.includeAbiSync || syncOperationIntent) {
    messages.push({
      role: MessageRole.System,
      content: renderPromptVars(ABI_SYNC_SECTION, promptVars),
      section: "system_anchor"
    })
  }

  if (decision.includeChartCatalogue) {
    messages.push({
      role: MessageRole.System,
      content: renderPromptVars(CHART_CATALOGUE_SECTION, promptVars),
      section: "system_runtime"
    })
  }

  if (decision.includeBigTableEtl) {
    messages.push({
      role: MessageRole.System,
      content: renderPromptVars(BIG_TABLE_ETL_SECTION, promptVars),
      section: "system_anchor"
    })
  }

  return messages
}
