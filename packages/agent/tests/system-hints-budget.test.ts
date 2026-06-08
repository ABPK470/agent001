/**
 * Gap 11: capRuntimeHints drops oldest hint:true messages keeping
 * only the most recent N (default 4).
 */
import { describe, expect, it } from "vitest"
import { capRuntimeHints } from "../src/application/shell/agent-cluster/iteration-prepare.js"
import { MessageRole } from "../src/domain/enums/message.js"
import type { Message } from "../src/domain/agent-types.js"

const sys = (content: string, hint = false): Message => ({
  role: MessageRole.System,
  content,
  section: "history",
  ...(hint ? { hint: true } : {})
})

describe("capRuntimeHints", () => {
  it("returns same array reference when at or below the cap", () => {
    const msgs: Message[] = [sys("a"), sys("b", true), sys("c", true)]
    expect(capRuntimeHints(msgs, 4)).toBe(msgs)
  })

  it("drops oldest hints, keeps newest N, preserves non-hints", () => {
    const msgs: Message[] = [
      sys("a"),
      sys("h1", true),
      sys("b"),
      sys("h2", true),
      sys("h3", true),
      sys("h4", true),
      sys("h5", true),
      sys("c")
    ]
    const out = capRuntimeHints(msgs, 3)
    const hintsKept = out.filter((m) => m.hint).map((m) => m.content)
    expect(hintsKept).toEqual(["h3", "h4", "h5"])
    // Non-hint messages preserved in order
    expect(out.filter((m) => !m.hint).map((m) => m.content)).toEqual(["a", "b", "c"])
  })

  it("default cap is 4", () => {
    const msgs: Message[] = Array.from({ length: 6 }, (_, i) => sys(`h${i + 1}`, true))
    const out = capRuntimeHints(msgs)
    expect(out.length).toBe(4)
    expect(out.map((m) => m.content)).toEqual(["h3", "h4", "h5", "h6"])
  })
})
