import { describe, expect, it } from "vitest"
import { emptyPlatformImportImpact, type PlatformImportGateResult } from "@mia/shared-types"
import { canApply, canValidate, fingerprintPayload, previewMatchesPayload } from "./import-gate"

function okPreview(): PlatformImportGateResult {
  return {
    ok: true,
    dryRun: true,
    applied: false,
    errors: [],
    warnings: [],
    impact: emptyPlatformImportImpact(),
    counts: { entities: 1 },
  }
}

describe("import-gate enablement", () => {
  it("requires a non-empty payload to validate", () => {
    expect(canValidate(null)).toBe(false)
    expect(canValidate("")).toBe(false)
    expect(canValidate("{}")).toBe(true)
  })

  it("stales preview when fingerprint changes", () => {
    const a = fingerprintPayload("aaa")
    const b = fingerprintPayload("bbb")
    expect(previewMatchesPayload(okPreview(), a, a)).toBe(true)
    expect(previewMatchesPayload(okPreview(), a, b)).toBe(false)
  })

  it("requires ok preview, matching fingerprint, and reason to apply", () => {
    const fp = fingerprintPayload("payload")
    expect(
      canApply({
        preview: okPreview(),
        payloadFingerprint: fp,
        currentFingerprint: fp,
        reason: "restore prod",
      }),
    ).toBe(true)
    expect(
      canApply({
        preview: okPreview(),
        payloadFingerprint: fp,
        currentFingerprint: fp,
        reason: "  ",
      }),
    ).toBe(false)
    expect(
      canApply({
        preview: { ...okPreview(), ok: false },
        payloadFingerprint: fp,
        currentFingerprint: fp,
        reason: "ok",
      }),
    ).toBe(false)
  })
})
