import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearViewingAs,
  getViewingAsTarget,
  getViewingAsUpn,
  isViewingAsMe,
  isViewingAsOther,
  resetViewingAsMemory,
  setViewingAs,
  syncViewingAsForSession,
} from "./viewing-as"

const ADMIN = "admin@example.com"
const OPERATOR = "operator@example.com"
const OTHER = "other@example.com"

/** Minimal sessionStorage for Node vitest (no DOM). */
function installSessionStorage(): void {
  const map = new Map<string, string>()
  const api: Storage = {
    get length() { return map.size },
    clear() { map.clear() },
    getItem(key) { return map.has(key) ? map.get(key)! : null },
    key(index) { return [...map.keys()][index] ?? null },
    removeItem(key) { map.delete(key) },
    setItem(key, value) { map.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: api,
  })
}

describe("viewing-as chrome scope", () => {
  beforeEach(() => {
    installSessionStorage()
    sessionStorage.clear()
    resetViewingAsMemory()
  })

  afterEach(() => {
    sessionStorage.clear()
    resetViewingAsMemory()
  })

  it("starts as Me — no header UPN", () => {
    expect(isViewingAsMe()).toBe(true)
    expect(isViewingAsOther()).toBe(false)
    expect(getViewingAsUpn()).toBeNull()
  })

  it("admin viewing another user is Other and stamps header UPN", () => {
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    setViewingAs({ upn: OPERATOR, displayName: "Operator" }, ADMIN)

    expect(isViewingAsMe()).toBe(false)
    expect(isViewingAsOther()).toBe(true)
    expect(getViewingAsUpn()).toBe(OPERATOR)
    expect(getViewingAsTarget()?.displayName).toBe("Operator")
  })

  it("normalizes viewing as self to Me", () => {
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    setViewingAs({ upn: ADMIN, displayName: "Admin" }, ADMIN)

    expect(isViewingAsMe()).toBe(true)
    expect(getViewingAsUpn()).toBeNull()
    expect(sessionStorage.getItem(`mia.viewingAs:${ADMIN.toLowerCase()}`)).toBeNull()
  })

  it("regression: admin Viewing as operator → logout → operator login is Me (chat must not stay read-only)", () => {
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    setViewingAs({ upn: OPERATOR, displayName: "Operator" }, ADMIN)
    expect(isViewingAsOther()).toBe(true)

    // Logout — memory cleared; admin persistence may remain for admin's next login.
    resetViewingAsMemory()
    expect(isViewingAsMe()).toBe(true)
    expect(getViewingAsUpn()).toBeNull()

    // Operator signs in on the same SPA tab.
    syncViewingAsForSession({ upn: OPERATOR, isAdmin: false })
    expect(isViewingAsMe()).toBe(true)
    expect(isViewingAsOther()).toBe(false)
    expect(getViewingAsUpn()).toBeNull()
    expect(getViewingAsTarget()).toBeNull()
  })

  it("regression: leftover in-memory Other survives skipped logout reset until operator sync", () => {
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    setViewingAs({ upn: OPERATOR, displayName: "Operator" }, ADMIN)
    expect(isViewingAsOther()).toBe(true)

    // Pretend logout forgot resetViewingAsMemory — store still points at operator.
    syncViewingAsForSession({ upn: OPERATOR, isAdmin: false })
    expect(isViewingAsOther()).toBe(false)
    expect(getViewingAsUpn()).toBeNull()
  })

  it("regression: viewing-as-self UPN never counts as Other", () => {
    syncViewingAsForSession({ upn: OPERATOR, isAdmin: true })
    setViewingAs({ upn: "OPERATOR@example.com", displayName: "Op" }, OPERATOR)
    expect(isViewingAsMe()).toBe(true)
    expect(getViewingAsUpn()).toBeNull()
  })
  it("operator sync always forces Me even if sessionStorage has junk under operator key", () => {
    sessionStorage.setItem(
      `mia.viewingAs:${OPERATOR.toLowerCase()}`,
      JSON.stringify({ upn: OTHER, displayName: "Other" }),
    )
    syncViewingAsForSession({ upn: OPERATOR, isAdmin: false })
    expect(isViewingAsMe()).toBe(true)
    expect(getViewingAsUpn()).toBeNull()
  })

  it("admin restore reloads persisted other user; self-persisted entry is cleared", () => {
    sessionStorage.setItem(
      `mia.viewingAs:${ADMIN.toLowerCase()}`,
      JSON.stringify({ upn: OPERATOR, displayName: "Operator" }),
    )
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    expect(getViewingAsUpn()).toBe(OPERATOR)

    clearViewingAs(ADMIN)
    sessionStorage.setItem(
      `mia.viewingAs:${ADMIN.toLowerCase()}`,
      JSON.stringify({ upn: ADMIN, displayName: "Admin" }),
    )
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    expect(isViewingAsMe()).toBe(true)
    expect(sessionStorage.getItem(`mia.viewingAs:${ADMIN.toLowerCase()}`)).toBeNull()
  })

  it("admin logout then admin login restores Viewing as other", () => {
    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    setViewingAs({ upn: OPERATOR, displayName: "Operator" }, ADMIN)
    resetViewingAsMemory()
    expect(getViewingAsUpn()).toBeNull()

    syncViewingAsForSession({ upn: ADMIN, isAdmin: true })
    expect(getViewingAsUpn()).toBe(OPERATOR)
    expect(isViewingAsOther()).toBe(true)
  })
})
