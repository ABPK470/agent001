/**
 * Explicit open/fold state for the Trace outline.
 * One object — no nested closure state.
 *
 * Tool rows reuse the same toolCallId under Call (proposed) and Work
 * (executed). Open keys MUST be parent-scoped or one toggle opens both.
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
  /** Parent-scoped tool keys — see callToolOpenKey / workToolOpenKey. */
  tools: Set<string>
  phases: Set<string>
  work: Set<string>
  foldMode: FoldMode
}

/** Proposed tool under Call → Received. */
export function callToolOpenKey(callIndex: number, toolId: string): string {
  return `call:${callIndex}:tool:${toolId}`
}

/** Executed tool under a Work card. */
export function workToolOpenKey(workId: string, toolId: string): string {
  return `${workId}:tool:${toolId}`
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
