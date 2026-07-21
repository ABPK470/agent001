/**
 * Explicit open/fold state for the Trace outline.
 * One object — no nested closure state.
 */

export type FoldMode = "expanded" | "collapsed"

export type OpenState = {
  preamble: boolean
  /** Context subsections — collapse Prompt / Tools as wholes. */
  contextPrompt: boolean
  contextTools: boolean
  calls: Set<number>
  sent: Set<number>
  received: Set<number>
  messages: Set<string>
  tools: Set<string>
  phases: Set<string>
  work: Set<string>
  foldMode: FoldMode
}

export function emptyOpen(): OpenState {
  return {
    preamble: false,
    contextPrompt: false,
    contextTools: false,
    calls: new Set(),
    sent: new Set(),
    received: new Set(),
    messages: new Set(),
    tools: new Set(),
    phases: new Set(),
    work: new Set(),
    foldMode: "collapsed",
  }
}

export function seedLatest(callCount: number): OpenState {
  const next = emptyOpen()
  if (callCount === 0) return next
  next.calls.add(callCount - 1)
  return next
}
