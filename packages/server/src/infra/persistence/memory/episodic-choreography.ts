/**
 * Episodic choreography — ordered tool sequences stored on episodic summaries.
 *
 * Successful runs record the tool ladder they used (search → profile → query).
 * Retrieval surfaces it as a hint when the episodic row is shortcut-eligible.
 * Goal-class tags live on the same episodic row for cross-shape FTS recall.
 */

/** Tools that are not part of a warehouse discovery / execution ladder. */
const CHOREOGRAPHY_EXCLUDED_TOOLS = new Set([
  "ask_user",
  "note",
  "send_message",
  "check_messages",
  "wait_for_response"
])

export function extractOrderedToolSequence(
  trace: ReadonlyArray<{ kind: string; tool?: string }>
): string[] {
  const seq: string[] = []
  for (const entry of trace) {
    if (entry.kind !== "tool-call" || !entry.tool) continue
    if (CHOREOGRAPHY_EXCLUDED_TOOLS.has(entry.tool)) continue
    seq.push(entry.tool)
  }
  return seq
}

export function formatChoreographyLine(toolSequence: readonly string[]): string {
  if (toolSequence.length < 2) return ""
  return `Choreography: ${toolSequence.join(" → ")}`
}

/** Compact arrow form for prompt hints (no label prefix). */
export function formatChoreographyHint(toolSequence: readonly string[]): string {
  if (toolSequence.length < 2) return ""
  return toolSequence.join(" → ")
}

export function readEpisodicToolSequence(metadata: Record<string, unknown> | undefined): string[] | null {
  const raw = metadata?.["toolSequence"]
  if (!Array.isArray(raw)) return null
  const seq = raw.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
  return seq.length >= 2 ? seq : null
}

export function pickEpisodicChoreographyHint(
  items: ReadonlyArray<{ entry: { metadata: Record<string, unknown> } }>
): string | undefined {
  for (const item of items) {
    const seq = readEpisodicToolSequence(item.entry.metadata)
    if (seq) return formatChoreographyHint(seq)
  }
  return undefined
}
