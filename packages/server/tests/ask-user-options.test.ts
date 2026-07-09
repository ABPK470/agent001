import { describe, expect, it } from "vitest"
import {
  compactAskUserQuestion,
  enforceClarificationUiOptions,
  resolveAskUserPresentation
} from "../src/features/runs/execution/ask-user-options.js"

describe("enforceClarificationUiOptions", () => {
  it("leaves options untouched when ask_user is not tied to a clarification finding", () => {
    expect(enforceClarificationUiOptions(["A", "B"], null)).toEqual(["A", "B"])
  })

  it("strips options for matched findings without uiOptions", () => {
    expect(
      enforceClarificationUiOptions(["publish.Revenue", "mart.RevenueRecognition"], {
        findingId: "schema-match:revenue",
        kind: "schema-match",
        subject: "Revenue",
        suggestedQuestion: "Which Revenue table do you mean?",
        round: 0
      })
    ).toBeUndefined()
  })

  it("replaces model-supplied options with the finding's uiOptions", () => {
    expect(
      enforceClarificationUiOptions(["wrong", "values"], {
        findingId: "output-format:overview",
        kind: "output-format",
        subject: "overview",
        suggestedQuestion: "How would you like the overview delivered?",
        uiOptions: ["short narrative", "data table", "chart"],
        round: 0
      })
    ).toEqual(["short narrative", "data table", "chart"])
  })
})

describe("resolveAskUserPresentation", () => {
  it("compacts multi-line clarification questions to the first line", () => {
    const result = resolveAskUserPresentation(
      'When you say "revenue", which of these did you mean?\n  • publish.Revenue\n  • mart.Revenue',
      ["publish.Revenue", "mart.Revenue"],
      {
        findingId: "schema-match:revenue",
        kind: "schema-match",
        subject: "revenue",
        suggestedQuestion: 'When you say "revenue", which did you mean?',
        uiOptions: ["publish.Revenue", "mart.Revenue"],
        round: 0
      }
    )
    expect(result.question).toBe('When you say "revenue", which did you mean?')
    expect(result.options).toEqual(["publish.Revenue", "mart.Revenue"])
  })

  it("keeps sync-style model options when there is no clarification match", () => {
    expect(
      resolveAskUserPresentation("Which entity type?", ["pipelineActivity", "contract"], null)
    ).toEqual({
      question: "Which entity type?",
      options: ["pipelineActivity", "contract"]
    })
  })

  it("dedupes and trims option labels", () => {
    expect(
      resolveAskUserPresentation("Pick one", ["  a  ", "a", "", "b"], null)
    ).toEqual({
      question: "Pick one",
      options: ["a", "b"]
    })
  })
})

describe("compactAskUserQuestion", () => {
  it("returns the first non-empty line", () => {
    expect(compactAskUserQuestion("Pick one:\n  • A\n  • B")).toBe("Pick one:")
  })
})
