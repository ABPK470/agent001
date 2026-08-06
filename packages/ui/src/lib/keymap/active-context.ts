/**
 * Resolve the keymap sheet “Active Context” banner from workspace + Trace pane.
 */

import type { TracePane } from "./resolve-trace-pane-keyboard"

export function resolveKeymapActiveContext(opts: {
  spaceName: string | null
  widgetLabel: string | null
  maximized: boolean
  zen: boolean
  /** When focused widget is Trace, which pane owns keys. */
  tracePane: TracePane | null
}): { title: string; override: boolean } {
  const parts: string[] = []
  if (opts.spaceName) parts.push(opts.spaceName)
  if (opts.widgetLabel) parts.push(opts.widgetLabel)

  let override = false
  if (opts.widgetLabel === "Trace" && opts.tracePane) {
    parts.push(opts.tracePane === "detail" ? "Detail pane" : "Tree pane")
    override = true
  }

  if (opts.zen) parts.push("Zen")
  else if (opts.maximized) parts.push("Maximized")

  if (parts.length === 0) {
    return { title: "Workspace", override: false }
  }
  return { title: parts.join(" · "), override }
}
