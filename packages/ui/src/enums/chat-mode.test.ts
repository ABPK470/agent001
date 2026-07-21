import { describe, expect, it } from "vitest"
import { ChatMode, CHAT_MODES, isChatMode } from "./chat-mode.js"

describe("ChatMode enum", () => {
  it("exposes simple + detailed and guards unknown values", () => {
    expect(CHAT_MODES).toEqual([ChatMode.Simple, ChatMode.Detailed])
    expect(isChatMode("simple")).toBe(true)
    expect(isChatMode("detailed")).toBe(true)
    expect(isChatMode("verbose")).toBe(false)
    expect(isChatMode(1)).toBe(false)
  })
})
