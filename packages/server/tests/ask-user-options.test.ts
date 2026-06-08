import { describe, expect, it } from "vitest"
import { enforceClarificationUiOptions } from "../src/application/shell/execution/ask-user-options.js"

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
