import { describe, expect, it } from "vitest"
import {
  canAccessOwned,
  canMutatePersonal,
  type ViewingAs,
} from "./viewing-as.js"
import type { CurrentSession } from "../../../ports/session.js"

function session(over: Partial<CurrentSession> = {}): CurrentSession {
  return {
    sid: "s1",
    displayName: "Admin",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "test",
    ...over,
  }
}

function viewingAs(over: Partial<ViewingAs> = {}): ViewingAs {
  const s = over.session ?? session()
  return {
    viewingAsUpn: s.upn,
    isMe: true,
    session: s,
    ...over,
  }
}

describe("Viewing as Personal access", () => {
  it("canAccessOwned matches Viewing as UPN case-insensitively", () => {
    const va = viewingAs({ viewingAsUpn: "user@example.com", isMe: false })
    expect(canAccessOwned(va, "USER@example.com")).toBe(true)
    expect(canAccessOwned(va, "other@example.com")).toBe(false)
    expect(canAccessOwned(va, null)).toBe(false)
  })

  it("canMutatePersonal only when Me", () => {
    expect(canMutatePersonal(viewingAs({ isMe: true }))).toBe(true)
    expect(canMutatePersonal(viewingAs({ isMe: false, viewingAsUpn: "x@y.z" }))).toBe(false)
  })
})
