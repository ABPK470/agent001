import { RunStatus } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { EpisodicAnswerKind } from "../src/shared/enums/memory.js"
import { classifyEpisodicRun } from "../src/platform/persistence/memory/episodic-quality.js"

describe("classifyEpisodicRun", () => {
  it("marks substantive warehouse runs as shortcut-eligible", () => {
    const result = classifyEpisodicRun({
      answer: "Revenue by region is in publish.Revenue.",
      status: RunStatus.Completed,
      tools: ["search_catalog", "query_mssql"],
      trace: [
        { kind: "tool-call", tool: "search_catalog" },
        { kind: "tool-call", tool: "query_mssql" }
      ],
      hasCorrections: false
    })
    expect(result).toEqual({
      answerKind: EpisodicAnswerKind.Substantive,
      shortcutEligible: true
    })
  })

  it("rejects ask_user-only clarification runs", () => {
    const result = classifyEpisodicRun({
      answer: "Which table did you mean — contracts or orders?",
      status: RunStatus.Completed,
      tools: ["ask_user"],
      trace: [{ kind: "tool-call", tool: "ask_user" }],
      hasCorrections: false
    })
    expect(result).toEqual({
      answerKind: EpisodicAnswerKind.Clarification,
      shortcutEligible: false
    })
  })

  it("rejects failed and internal-failure answers", () => {
    expect(
      classifyEpisodicRun({
        answer: "Task FAILED: verification error",
        status: RunStatus.Completed,
        tools: ["query_mssql"],
        trace: [],
        hasCorrections: false
      })
    ).toMatchObject({ answerKind: EpisodicAnswerKind.Failure, shortcutEligible: false })

    expect(
      classifyEpisodicRun({
        answer: null,
        status: RunStatus.Failed,
        tools: [],
        trace: [],
        hasCorrections: false
      })
    ).toMatchObject({ answerKind: EpisodicAnswerKind.Failure, shortcutEligible: false })
  })

  it("rejects substantive-looking runs with tool corrections", () => {
    const result = classifyEpisodicRun({
      answer: "Used dbo.MissingTable",
      status: RunStatus.Completed,
      tools: ["query_mssql"],
      trace: [{ kind: "tool-call", tool: "query_mssql" }],
      hasCorrections: true
    })
    expect(result).toEqual({
      answerKind: EpisodicAnswerKind.Substantive,
      shortcutEligible: false
    })
  })

  it("allows text-only completed answers with no tools", () => {
    const result = classifyEpisodicRun({
      answer: "Here is a concise explanation of WAL checkpoints.",
      status: RunStatus.Completed,
      tools: [],
      trace: [],
      hasCorrections: false
    })
    expect(result).toEqual({
      answerKind: EpisodicAnswerKind.Substantive,
      shortcutEligible: true
    })
  })
})
