import type { PriorTurn } from "../data-blocks/prior-turns.js"

export function renderPriorTurnsBlock(turns: readonly PriorTurn[]): string {
  const lines: string[] = [
    "<prior_turns>",
    "Prior assistant NARRATIVE from earlier turns in THIS session (newest first).",
    "This is the assistant's own paraphrase, NOT a data source. If you need",
    "specific numbers, rows, or chart values, ground them on <prior_results>",
    "(actual tool payloads) or call recall_prior_result(...). Quoting figures",
    "out of this prose is a doctrine violation — re-run the tool instead.",
    ""
  ]
  turns.forEach((t, i) => {
    const label = `Turn -${i + 1}`
    const ts = t.ranAt ? ` (${t.ranAt})` : ""
    const statusTag = t.status === "failed" ? " [FAILED]" : ""
    lines.push(`${label}${ts}${statusTag}`)
    lines.push(`  Goal: ${oneLine(t.goal)}`)
    const answerBody = t.answer == null || t.answer.trim().length === 0 ? "(no answer recorded)" : t.answer
    lines.push("  Answer:")
    for (const ln of answerBody.split("\n")) lines.push(`    ${ln}`)
    lines.push("")
  })
  lines.push(
    'When the user uses pronouns or anaphora ("it", "this", "that", "those",',
    '"the data", "the result", "the report") they almost always refer to',
    "Turn -1's answer. Do NOT ask the user what they mean \u2014 act on it.",
    "</prior_turns>"
  )
  return lines.join("\n")
}

function oneLine(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim()
  return trimmed.length > 400 ? trimmed.slice(0, 397) + "\u2026" : trimmed
}
