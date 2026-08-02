/**
 * ask_user work/tool detail — extract human Q&A from notes + tool I/O without duplication.
 */

import type { TraceToolCall, TraceWorkNote } from "./build-trace-dag"

export function isAskUserToolName(name: string): boolean {
  return name === "ask_user"
}

export function askUserQuestionFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ["question", "q", "prompt", "message"]) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

export function extractAskUserQuestion(
  args: Record<string, unknown>,
  notes: TraceWorkNote[],
): string | null {
  const waiting = notes.find((n) => n.label === "Waiting on user")
  if (waiting?.text?.trim()) return waiting.text.trim()
  return askUserQuestionFromArgs(args)
}

export function extractAskUserAnswer(
  resultText: string | null | undefined,
  notes: TraceWorkNote[],
): string | null {
  const answered = notes.find((n) => n.label === "User answered")
  if (answered?.text?.trim()) return answered.text.trim()
  if (resultText?.trim()) return resultText.trim()
  return null
}

/** Notes rendered inside the interaction card — omit from the flat note list. */
export function askUserConsumedNoteIds(notes: TraceWorkNote[]): Set<string> {
  return new Set(
    notes
      .filter((n) => n.label === "Waiting on user" || n.label === "User answered")
      .map((n) => n.id),
  )
}

export function isAskUserTool(tool: TraceToolCall): boolean {
  return isAskUserToolName(tool.name)
}
