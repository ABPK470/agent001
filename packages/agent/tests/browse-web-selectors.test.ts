/**
 * Selector prefix routing — verifies resolveLocator dispatches to the
 * right Playwright API for each prefix and falls back to CSS otherwise.
 *
 * No real browser is needed: a tiny mock target captures the calls.
 */

import { describe, expect, it } from "vitest"

import { resolveLocator } from "../src/tools/browse-web/selectors.js"

interface MockCall {
  method: "locator" | "getByText" | "getByRole"
  arg1: string
  arg2?: unknown
}

function mockTarget(): { calls: MockCall[]; target: Parameters<typeof resolveLocator>[0] } {
  const calls: MockCall[] = []
  const sentinel = { __isMockLocator: true } as unknown as import("playwright").Locator
  const target = {
    locator: (s: string): unknown => {
      calls.push({ method: "locator", arg1: s })
      return sentinel
    },
    getByText: (s: string): unknown => {
      calls.push({ method: "getByText", arg1: s })
      return sentinel
    },
    getByRole: (role: string, opts?: unknown): unknown => {
      calls.push({ method: "getByRole", arg1: role, arg2: opts })
      return sentinel
    }
  } as unknown as Parameters<typeof resolveLocator>[0]
  return { calls, target }
}

describe("resolveLocator", () => {
  it("treats unprefixed strings as CSS", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "button.primary")
    expect(calls).toEqual([{ method: "locator", arg1: "button.primary" }])
  })

  it("strips the css: prefix", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "css: a.link")
    expect(calls).toEqual([{ method: "locator", arg1: "a.link" }])
  })

  it("rewrites xpath: as a Playwright xpath= engine string", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "xpath://button[@id='go']")
    expect(calls).toEqual([{ method: "locator", arg1: "xpath=//button[@id='go']" }])
  })

  it("uses getByText for text:", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "text:Sign in")
    expect(calls).toEqual([{ method: "getByText", arg1: "Sign in" }])
  })

  it("uses getByRole for role: without name", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "role:button")
    expect(calls).toEqual([{ method: "getByRole", arg1: "button", arg2: undefined }])
  })

  it("uses getByRole with accessible name", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "role:button[name=Submit]")
    expect(calls).toEqual([{ method: "getByRole", arg1: "button", arg2: { name: "Submit" } }])
  })

  it("falls back to CSS when role expression is malformed", () => {
    const { target, calls } = mockTarget()
    resolveLocator(target, "role:!!!")
    expect(calls).toEqual([{ method: "locator", arg1: "role:!!!" }])
  })
})
