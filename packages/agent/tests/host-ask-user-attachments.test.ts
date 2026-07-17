/**
 * Phase 4 items 1+2 — ask_user + attachments via the new AgentHost surface.
 *
 * Proves that:
 *   1. `createAskUserTool(host)` calls the host-provided `userInput`
 *      function with `(question, options, sensitive)` and returns its
 *      string response. With no `userInput`, it returns a friendly error.
 *   2. `createListAttachmentsTool(host)` and `createReadAttachmentTool(host)`
 *      call the host-provided `attachments` store. With no store, they
 *      throw a friendly error explaining wiring.
 *   3. Two hosts with different stubs do not interfere — the proof that
 *      ambient state has been removed for this cluster.
 *
 * See docs/doctrine.md and docs/runtime-inventory.md §7.
 */
import { describe, expect, it } from "vitest"
import type {
  AttachmentMetadata,
  AttachmentStore,
  UserInputReader
} from "../src/runtime/runtime.js"
import { configureAgent } from "../src/runtime/runtime.js"
import { createAskUserTool } from "../src/tools/ask-user.js"
import {
  createImportAttachmentTool,
  createListAttachmentsTool,
  createPromoteAttachmentTool,
  createReadAttachmentTool
} from "../src/tools/attachments.js"

// ── Fixtures ─────────────────────────────────────────────────────

function stubMetadata(over: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: "att-1",
    scope: "run",
    originalName: "Sales Report.csv",
    normalizedName: "sales-report.csv",
    mediaType: "text/csv",
    sizeBytes: 42,
    sha256: "deadbeef",
    ingestionMode: "user",
    purposeTags: [],
    blobKey: "blob/att-1",
    createdAt: 0,
    ...over
  }
}

function fakeStore(over: Partial<AttachmentStore> = {}): AttachmentStore {
  return {
    list: async () => [stubMetadata()],
    get: async () => stubMetadata(),
    read: async () => ({
      kind: "text",
      text: "col1,col2\n1,2\n",
      truncated: false,
      sizeBytes: 14,
      offset: 0,
      nextOffset: null
    }),
    importToSandbox: async (_id, sandboxRelPath) => ({ sandboxPath: sandboxRelPath, sizeBytes: 14 }),
    promoteFromSandbox: async () => stubMetadata({ id: "att-2", ingestionMode: "agent" }),
    ...over
  }
}

// ── ask_user ─────────────────────────────────────────────────────

describe("createAskUserTool — Phase 4 item 1", () => {
  it("forwards (question, options, sensitive) to host.userInput and returns its answer", async () => {
    const seen: Array<[string, string[] | undefined, boolean | undefined]> = []
    const userInput: UserInputReader = async (q, opts, sensitive) => {
      seen.push([q, opts, sensitive])
      return "user-answer"
    }

    const host = configureAgent({ userInput })
    const tool = createAskUserTool(host)

    const result = await tool.execute({
      question: "What is your favourite colour?",
      options: ["red", "blue"],
      sensitive: false
    })

    expect(result).toBe("user-answer")
    expect(seen).toEqual([["What is your favourite colour?", ["red", "blue"], false]])
  })

  it("returns a friendly error when host.userInput is null", async () => {
    const host = configureAgent({})
    const tool = createAskUserTool(host)

    const result = await tool.execute({ question: "anything?" })

    expect(result).toMatch(/User input is not available/i)
  })

  it("two hosts with different resolvers do not share state", async () => {
    const hostA = configureAgent({ userInput: async () => "A" })
    const hostB = configureAgent({ userInput: async () => "B" })
    const toolA = createAskUserTool(hostA)
    const toolB = createAskUserTool(hostB)

    const [a, b] = await Promise.all([toolA.execute({ question: "?" }), toolB.execute({ question: "?" })])

    expect(a).toBe("A")
    expect(b).toBe("B")
  })
})

// ── attachments ──────────────────────────────────────────────────

describe("create*AttachmentTool — Phase 4 item 2", () => {
  it("list_attachments reads host.attachments.list and renders rows", async () => {
    const host = configureAgent({ attachments: fakeStore() })
    const tool = createListAttachmentsTool(host)

    const result = await tool.execute({})

    expect(result).toContain("Attachments (1)")
    expect(result).toContain("sales-report.csv")
    expect(result).toContain("text/csv")
  })

  it("read_attachment returns a friendly text payload with byte header", async () => {
    const host = configureAgent({ attachments: fakeStore() })
    const tool = createReadAttachmentTool(host)

    const result = await tool.execute({ id: "att-1" })

    expect(result).toContain("Attachment att-1")
    expect(result).toContain("col1,col2")
    expect(result).toContain("EOF")
  })

  it("import_attachment delegates to host.attachments.importToSandbox", async () => {
    const seen: Array<[string, string]> = []
    const store = fakeStore({
      importToSandbox: async (id, dest) => {
        seen.push([id, dest])
        return { sandboxPath: dest, sizeBytes: 14 }
      }
    })
    const host = configureAgent({ attachments: store })
    const tool = createImportAttachmentTool(host)

    const result = await tool.execute({ id: "att-1", destination: "report.csv" })

    expect(seen).toEqual([["att-1", "report.csv"]])
    expect(result).toContain("Imported att-1 → report.csv")
  })

  it("promote_attachment delegates to host.attachments.promoteFromSandbox", async () => {
    const host = configureAgent({ attachments: fakeStore() })
    const tool = createPromoteAttachmentTool(host)

    const result = await tool.execute({ sandboxPath: "out/notes.txt" })

    expect(result).toContain("Promoted out/notes.txt")
    expect(result).toContain("id=att-2")
  })

  it("each tool throws a friendly error when host.attachments is null", async () => {
    const host = configureAgent({})

    await expect(createListAttachmentsTool(host).execute({})).rejects.toThrow(
      /Attachment service is not configured on this AgentHost/
    )
    await expect(createReadAttachmentTool(host).execute({ id: "x" })).rejects.toThrow(
      /Attachment service is not configured on this AgentHost/
    )
    await expect(createImportAttachmentTool(host).execute({ id: "x", destination: "y" })).rejects.toThrow(
      /Attachment service is not configured on this AgentHost/
    )
    await expect(createPromoteAttachmentTool(host).execute({ sandboxPath: "y" })).rejects.toThrow(
      /Attachment service is not configured on this AgentHost/
    )
  })

  it("two hosts with different stores do not share state", async () => {
    const hostA = configureAgent({
      attachments: fakeStore({ list: async () => [stubMetadata({ id: "A" })] })
    })
    const hostB = configureAgent({
      attachments: fakeStore({ list: async () => [stubMetadata({ id: "B" })] })
    })

    const [a, b] = await Promise.all([
      createListAttachmentsTool(hostA).execute({}),
      createListAttachmentsTool(hostB).execute({})
    ])

    expect(a).toContain("id=A")
    expect(b).toContain("id=B")
    expect(a).not.toContain("id=B")
    expect(b).not.toContain("id=A")
  })
})
