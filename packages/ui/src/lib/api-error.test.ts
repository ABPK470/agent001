import { describe, expect, it } from "vitest"

import { asApiError, formatApiError } from "./api-error.js"

describe("formatApiError", () => {
  it("formats structured policy_denied for sync_publish", () => {
    const err = Object.assign(
      new Error("Policy 'hosted_default_deny' violated: no policy rule allows tool sync_publish in hosted mode."),
      { code: "policy_denied", policyName: "hosted_default_deny", toolName: "sync_publish", status: 403 },
    )
    expect(formatApiError(err)).toBe(
      "Catalog publish is not allowed by policy. Add an allow rule for this action in Policies, or ask an admin.",
    )
  })

  it("formats named policy denials", () => {
    const err = Object.assign(new Error("denied"), {
      code: "policy_denied",
      policyName: "hosted_deny_prod_dml",
      toolName: "sync_execute",
    })
    expect(formatApiError(err)).toBe('Sync execute was blocked by policy “hosted_deny_prod_dml”.')
  })

  it("formats approval_required", () => {
    const err = Object.assign(new Error("need approval"), {
      code: "approval_required",
      policyName: "hosted_require_approval_sync_execute_prod",
      toolName: "sync_execute",
    })
    expect(formatApiError(err)).toBe(
      'Sync execute needs approval before it can continue (policy “hosted_require_approval_sync_execute_prod”).',
    )
  })

  it("parses bare PolicyViolation messages without code", () => {
    expect(
      formatApiError(
        new Error("Policy 'hosted_default_deny' violated: no policy rule allows tool \"query_mssql\" in hosted mode"),
      ),
    ).toMatch(/not allowed by policy/i)
  })

  it("passes through ordinary messages", () => {
    expect(formatApiError(new Error("Refusing to publish \"dataset\": invalid flow"))).toBe(
      'Refusing to publish "dataset": invalid flow',
    )
  })

  it("asApiError reads client enrichment fields", () => {
    const err = Object.assign(new Error("x"), { code: "policy_denied", toolName: "sync_publish" })
    expect(asApiError(err).toolName).toBe("sync_publish")
    expect(asApiError("plain").message).toBe("plain")
  })
})
