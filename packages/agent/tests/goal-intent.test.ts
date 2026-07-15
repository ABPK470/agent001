import { MessageRole } from "../src/domain/enums/message.js"
import type { Message } from "../src/domain/agent-types.js"
import {
  extractPriorAssistantNarrative,
  extractTurnMinusOneAnswer,
  isClarificationExemptGoal,
  isConversationalNoToolGoal,
  isDirectDialogueGoal,
  isDirectSyncExecuteCommand
} from "../src/application/core/goal-intent.js"

function priorTurnsMessage(answer: string, goal = "how many LOCs?"): Message {
  const answerLines = answer
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
  return {
    role: MessageRole.System,
    section: "system_anchor",
    content: [
      "<prior_turns>",
      "Prior assistant NARRATIVE from earlier turns in THIS session (newest first).",
      "",
      "Turn -1",
      `  Goal: ${goal}`,
      "  Answer:",
      answerLines,
      "",
      'When the user uses pronouns or anaphora ("it", "this", "that", "those",',
      '"the data", "the result", "the report") they almost always refer to',
      "Turn -1's answer. Do NOT ask the user what they mean — act on it.",
      "</prior_turns>"
    ].join("\n")
  }
}

describe("extractTurnMinusOneAnswer", () => {
  it("parses Turn -1 answer from a prior_turns block", () => {
    const block = priorTurnsMessage(
      "Total LOC is 70,617.\nIf you want, I can also split it into src vs tests LOC."
    ).content as string
    expect(extractTurnMinusOneAnswer(block)).toBe(
      "Total LOC is 70,617.\nIf you want, I can also split it into src vs tests LOC."
    )
  })
})

describe("isDirectDialogueGoal", () => {
  it("treats greetings and thanks as dialogue", () => {
    expect(isDirectDialogueGoal("Hi")).toBe(true)
    expect(isDirectDialogueGoal("Hello!")).toBe(true)
    expect(isDirectDialogueGoal("Thanks")).toBe(true)
  })

  it("treats session meta questions as dialogue", () => {
    expect(isDirectDialogueGoal("What are we doing?")).toBe(true)
    expect(isDirectDialogueGoal("Catch me up")).toBe(true)
  })

  it("treats passive acknowledgements as dialogue", () => {
    expect(isDirectDialogueGoal("Got it.")).toBe(true)
    expect(isDirectDialogueGoal("Thanks!")).toBe(true)
  })

  it("treats bare assent as dialogue when there is no prior offer", () => {
    expect(isDirectDialogueGoal("ok")).toBe(true)
    expect(isDirectDialogueGoal("yes")).toBe(true)
    expect(isDirectDialogueGoal("sounds good")).toBe(true)
  })

  it("treats assent as task continuation when the prior turn offered work", () => {
    const messages = [
      priorTurnsMessage(
        "Total LOC is 70,617.\nIf you want, I can also split it into src vs tests LOC."
      )
    ]
    expect(isDirectDialogueGoal("ok", { messages })).toBe(false)
    expect(isDirectDialogueGoal("yes", { messages })).toBe(false)
    expect(isDirectDialogueGoal("go ahead", { messages })).toBe(false)
    expect(isDirectDialogueGoal("sounds good", { messages })).toBe(false)
  })

  it("treats assent with explicit follow-up text as a task", () => {
    const messages = [
      priorTurnsMessage("I can also split it into src vs tests LOC.")
    ]
    expect(isDirectDialogueGoal("yes, split src vs tests", { messages })).toBe(false)
  })

  it("uses the latest assistant message when prior_turns is absent", () => {
    const messages: Message[] = [
      {
        role: MessageRole.Assistant,
        section: "history",
        content: "Done. Would you like me to run the tests as well?"
      }
    ]
    expect(isDirectDialogueGoal("ok", { messages })).toBe(false)
  })

  it("does NOT treat task goals as dialogue", () => {
    expect(isDirectDialogueGoal("Create a file with the number 42")).toBe(false)
    expect(isDirectDialogueGoal("how many LOCs agent package has?")).toBe(false)
  })

  it("does NOT treat greeting + explicit action as dialogue", () => {
    expect(isDirectDialogueGoal("Hello, build the dashboard widget")).toBe(false)
  })
})

describe("isConversationalNoToolGoal", () => {
  it("includes direct dialogue goals", () => {
    expect(isConversationalNoToolGoal("Hello!")).toBe(true)
  })

  it("treats bare test as a check-in, not a task", () => {
    expect(isConversationalNoToolGoal("test")).toBe(true)
    expect(isConversationalNoToolGoal("test!")).toBe(true)
  })

  it("does NOT treat explicit test work as conversational", () => {
    expect(isConversationalNoToolGoal("run the test suite")).toBe(false)
    expect(isConversationalNoToolGoal("test rules in publish schema")).toBe(false)
  })
})

describe("extractPriorAssistantNarrative", () => {
  it("prefers prior_turns Turn -1 over older assistant messages", () => {
    const messages: Message[] = [
      {
        role: MessageRole.Assistant,
        section: "history",
        content: "Stale offer from an old in-run message."
      },
      priorTurnsMessage("Fresh offer: I can also generate a chart.")
    ]
    expect(extractPriorAssistantNarrative(messages)).toContain("Fresh offer")
  })
})

describe("isDirectSyncExecuteCommand", () => {
  it("recognises the canonical agent-emitted execute command", () => {
    expect(isDirectSyncExecuteCommand("sync_execute planId=2134-124-24-124 confirm=true")).toBe(true)
    expect(
      isDirectSyncExecuteCommand('sync_execute planId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" confirm=true')
    ).toBe(true)
  })

  it("tolerates a leading assent prefix", () => {
    expect(isDirectSyncExecuteCommand("ok, sync_execute planId=2134-124-24-124 confirm=true")).toBe(true)
    expect(isDirectSyncExecuteCommand("yes sync_execute planId=2134 confirm=true")).toBe(true)
    expect(isDirectSyncExecuteCommand("go ahead: sync_execute planId=2134-124-24-124 confirm=true")).toBe(true)
  })

  it("does not match questions about the command", () => {
    expect(isDirectSyncExecuteCommand("what does sync_execute planId=2134 confirm=true do?")).toBe(false)
    expect(isDirectSyncExecuteCommand("should I run sync_execute planId=2134 confirm=true?")).toBe(false)
  })

  it("does not match a bare sync_preview / natural-language sync goal", () => {
    expect(isDirectSyncExecuteCommand("sync metadata from dev to uat")).toBe(false)
    expect(isDirectSyncExecuteCommand("sync_preview contract 1234 from dev to uat")).toBe(false)
  })
})

describe("isClarificationExemptGoal (direct sync execute command)", () => {
  it("skips clarification for the direct execute command — no questions asked", () => {
    expect(isClarificationExemptGoal("sync_execute planId=2134-124-24-124 confirm=true")).toBe(true)
    expect(isClarificationExemptGoal("ok, sync_execute planId=2134-124-24-124 confirm=true")).toBe(true)
  })

  it("still loads tools for the direct execute command (it is NOT conversational-no-tool)", () => {
    // The command is a task, not dialogue — tools must remain available.
    expect(isConversationalNoToolGoal("sync_execute planId=2134-124-24-124 confirm=true")).toBe(false)
  })
})
