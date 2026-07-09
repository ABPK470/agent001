/**
 * Operator-facing binding labels — short names for pickers and execute previews.
 */

import type { SyncHandlerInput } from "./handler-input.js"
import { isStepBoundHandlerSlot } from "./flow-step-bindings.js"
import type { CustomValueSourceCatalog } from "./custom-value-source.js"
import { formatValueSourcePreview } from "./value-source.js"

export type BindingSourceLabelCatalog = Record<string, string>

/** @deprecated Use BindingSourceLabelCatalog */
export type CustomValueSourceLabelCatalog = BindingSourceLabelCatalog

/** Short hint for execute preview — not the full runtime resolution chain. */
export function formatHandlerInputPreviewHint(
  slot: Pick<SyncHandlerInput, "name" | "source">,
  options: {
    customCatalog?: CustomValueSourceCatalog
    customLabels?: BindingSourceLabelCatalog
  },
): string {
  if (isStepBoundHandlerSlot(slot)) {
    return "per flow step"
  }
  return formatValueSourcePreview(slot.source, {
    customCatalog: options.customCatalog,
    customLabels: options.customLabels,
  })
}

/** @deprecated Use formatHandlerInputPreviewHint with customCatalog */
export function formatPlanBindingSourceDisplayLabel(
  _definition: { query: string },
  label: string,
  id: string,
): string {
  const trimmed = label.trim() || id
  const tagged = `Query: ${trimmed}`
  return trimmed.startsWith("Query:") ? trimmed : tagged
}

/** @deprecated */
export function formatStepFieldDisplayLabel(label: string, id: string): string {
  const trimmed = label.trim() || id
  return trimmed.startsWith("Text:") ? trimmed : `Text: ${trimmed}`
}

/** @deprecated */
export function planBindingKindDisplayPrefix(): "Query" {
  return "Query"
}
