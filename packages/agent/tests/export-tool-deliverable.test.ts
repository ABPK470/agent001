/**
 * export_query_to_file deliverable promotion logic.
 *
 * The tool writes the file to the sandbox, then (when deliverable=true)
 * promotes it to a durable, user-downloadable attachment. These tests
 * exercise the promotion decision helper directly: default-promote,
 * opt-out, size cap, failure tolerance, and no-attachment-backend skip.
 */

import { describe, expect, it, vi } from "vitest"
import { promoteExportedFile } from "../src/tools/mssql/export-tool.js"
import type { AgentHost, AttachmentMetadata } from "../src/application/shell/runtime.js"

function fakeHost(attachments: AgentHost["attachments"]): AgentHost {
  return { attachments } as unknown as AgentHost
}

function fakeMeta(overrides: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: "att-1",
    scope: "workspace_asset" as AttachmentMetadata["scope"],
    originalName: "out.csv",
    normalizedName: "out.csv",
    mediaType: "text/csv",
    sizeBytes: 1234,
    contentHash: "abc",
    ingestionMode: "text_retrieval" as AttachmentMetadata["ingestionMode"],
    uploadedAt: "2026-01-01T00:00:00Z",
    purposeTag: null,
    ...overrides
  }
}

describe("promoteExportedFile", () => {
  it("promotes when deliverable=true and returns a download note with the attachment id", async () => {
    const promote = vi.fn(async () => fakeMeta({ id: "att-xyz", normalizedName: "uat_top5.csv", sizeBytes: 9_200_000 }))
    const res = await promoteExportedFile({
      host: fakeHost({ promoteFromSandbox: promote } as unknown as AgentHost["attachments"]),
      sandboxRelPath: "outputs/uat_top5.csv",
      mediaType: "text/csv",
      deliverable: true,
      byteSize: 9_200_000,
      purposeTag: null
    })
    expect(promote).toHaveBeenCalledWith("outputs/uat_top5.csv", { mediaType: "text/csv" })
    expect(res.note).toContain("downloadable")
    expect(res.note).toContain("att-xyz")
    expect(res.note).toContain("uat_top5.csv")
  })

  it("passes purposeTag through when provided", async () => {
    const promote = vi.fn(async () => fakeMeta())
    await promoteExportedFile({
      host: fakeHost({ promoteFromSandbox: promote } as unknown as AgentHost["attachments"]),
      sandboxRelPath: "out.csv",
      mediaType: "text/csv",
      deliverable: true,
      byteSize: 100,
      purposeTag: "top-5-clients"
    })
    expect(promote).toHaveBeenCalledWith("out.csv", { mediaType: "text/csv", purposeTag: "top-5-clients" })
  })

  it("does NOT promote when deliverable=false (staging file)", async () => {
    const promote = vi.fn(async () => fakeMeta())
    const res = await promoteExportedFile({
      host: fakeHost({ promoteFromSandbox: promote } as unknown as AgentHost["attachments"]),
      sandboxRelPath: "staging.csv",
      mediaType: "text/csv",
      deliverable: false,
      byteSize: 100,
      purposeTag: null
    })
    expect(promote).not.toHaveBeenCalled()
    expect(res.note).toContain("deliverable=false")
  })

  it("skips promotion when there is no attachment backend (CLI/tests)", async () => {
    const res = await promoteExportedFile({
      host: fakeHost(null),
      sandboxRelPath: "out.csv",
      mediaType: "text/csv",
      deliverable: true,
      byteSize: 100,
      purposeTag: null
    })
    expect(res.note).toContain("no attachment backend")
  })

  it("skips promotion above the 64MB cap and tells the agent to split", async () => {
    const promote = vi.fn(async () => fakeMeta())
    const huge = 64 * 1024 * 1024 + 1
    const res = await promoteExportedFile({
      host: fakeHost({ promoteFromSandbox: promote } as unknown as AgentHost["attachments"]),
      sandboxRelPath: "big.csv",
      mediaType: "text/csv",
      deliverable: true,
      byteSize: huge,
      purposeTag: null
    })
    expect(promote).not.toHaveBeenCalled()
    expect(res.note).toContain("NOT promoted")
    expect(res.note).toContain("split")
  })

  it("never throws when promote fails — returns a warning note instead", async () => {
    const promote = vi.fn(async () => {
      throw new Error("quota exceeded")
    })
    const res = await promoteExportedFile({
      host: fakeHost({ promoteFromSandbox: promote } as unknown as AgentHost["attachments"]),
      sandboxRelPath: "out.csv",
      mediaType: "text/csv",
      deliverable: true,
      byteSize: 100,
      purposeTag: null
    })
    expect(res.note).toContain("could not promote")
    expect(res.note).toContain("quota exceeded")
  })
})
