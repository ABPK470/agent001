import { describe, expect, it } from "vitest"
import {
  askUserConsumedNoteIds,
  askUserQuestionFromArgs,
  extractAskUserAnswer,
  extractAskUserQuestion,
  isAskUserToolName,
} from "./trace-ask-user"

describe("trace-ask-user", () => {
  it("detects ask_user tool name", () => {
    expect(isAskUserToolName("ask_user")).toBe(true)
    expect(isAskUserToolName("query_mssql")).toBe(false)
  })

  it("prefers waiting-on-user note over argument shorthand", () => {
    const notes = [
      { id: "w", label: "Waiting on user", text: "Which brand colors should the contact form use?" },
    ]
    expect(extractAskUserQuestion({ question: "Which brand colors?" }, notes)).toBe(
      "Which brand colors should the contact form use?",
    )
  })

  it("falls back to argument question", () => {
    expect(extractAskUserQuestion({ question: "Which brand colors?" }, [])).toBe(
      "Which brand colors?",
    )
    expect(askUserQuestionFromArgs({ q: "Hi?" })).toBe("Hi?")
  })

  it("prefers user answered note over tool result text", () => {
    const notes = [{ id: "a", label: "User answered", text: "Use navy and cream." }]
    expect(extractAskUserAnswer("Use navy and cream.", notes)).toBe("Use navy and cream.")
  })

  it("marks waiting and answered notes as consumed", () => {
    const notes = [
      { id: "w", label: "Waiting on user", text: "Q?" },
      { id: "a", label: "User answered", text: "A." },
      { id: "n", label: "Nudge", text: "retry" },
    ]
    const consumed = askUserConsumedNoteIds(notes)
    expect(consumed.has("w")).toBe(true)
    expect(consumed.has("a")).toBe(true)
    expect(consumed.has("n")).toBe(false)
  })
})
