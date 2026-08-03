import { describe, expect, it } from "vitest"
import type { AdminAuditItem } from "../../client/index"
import {
  actionVerbClass,
  actionVerbKind,
  auditChangeHints,
  auditSummary,
  auditTarget,
} from "./audit-log-view"

function entry(partial: Partial<AdminAuditItem> & Pick<AdminAuditItem, "action">): AdminAuditItem {
  return {
    id: 1,
    scopeType: "admin",
    scopeId: "sync-environments",
    runId: null,
    threadId: null,
    threadTitle: null,
    user: "pka",
    detail: {},
    timestamp: "2026-07-19T22:23:40.000Z",
    run: null,
    ...partial,
  }
}

describe("actionVerbKind", () => {
  it("classifies create / publish", () => {
    expect(actionVerbKind("sync_env.create")).toBe("create")
    expect(actionVerbKind("sync.defs.published")).toBe("create")
  })

  it("classifies update / delete / deny", () => {
    expect(actionVerbKind("sync_env.update")).toBe("update")
    expect(actionVerbKind("policy.delete")).toBe("delete")
    expect(actionVerbKind("policy.revoke")).toBe("delete")
    expect(actionVerbKind("tool.blocked")).toBe("deny")
    expect(actionVerbKind("approval.denied")).toBe("deny")
  })

  it("maps accents to theme tokens", () => {
    expect(actionVerbClass("create")).toContain("success")
    expect(actionVerbClass("update")).toContain("info")
    expect(actionVerbClass("delete")).toContain("warning")
    expect(actionVerbClass("deny")).toContain("error")
  })
})

describe("auditTarget / auditSummary", () => {
  it("prefers detail.name as target", () => {
    expect(
      auditTarget(entry({ action: "sync_env.create", detail: { name: "test111" } })),
    ).toBe("test111")
  })

  it("summarizes sync_env.create", () => {
    expect(
      auditSummary(
        entry({
          action: "sync_env.create",
          detail: { name: "test111", defaultAccessMode: "read_write" },
        }),
      ),
    ).toBe('Created environment "test111" (mode: read_write)')
  })

  it("summarizes policy.delete", () => {
    expect(
      auditSummary(entry({ action: "policy.delete", detail: { name: "policy-append_file" } })),
    ).toBe('Deleted policy "policy-append_file"')
  })

  it("summarizes update with fields array", () => {
    expect(
      auditSummary(
        entry({
          action: "sync_env.update",
          detail: { name: "staging", fields: ["defaultAccessMode", "allowedOperations"] },
        }),
      ),
    ).toBe("2 fields changed (defaultAccessMode, allowedOperations)")
  })

  it("never dumps raw JSON as summary", () => {
    const s = auditSummary(
      entry({
        action: "sync_env.create",
        detail: { nested: { a: 1, b: 2 }, fields: { displayName: "x" } },
      }),
    )
    expect(s).not.toContain("{")
    expect(s).not.toContain("nested")
  })
})

describe("auditChangeHints", () => {
  it("lists field keys and scalar highlights", () => {
    const hints = auditChangeHints({
      name: "test111",
      fields: { defaultAccessMode: "read_write", displayName: "test111" },
    })
    expect(hints.some((h) => h.label === "Fields" && h.value.includes("defaultAccessMode"))).toBe(
      true,
    )
    expect(hints.some((h) => h.label === "defaultAccessMode" && h.value === "read_write")).toBe(
      true,
    )
    expect(hints.some((h) => h.label === "name" && h.value === "test111")).toBe(true)
  })
})
