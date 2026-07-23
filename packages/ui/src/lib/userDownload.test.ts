import { describe, expect, it, vi, afterEach } from "vitest"
import { downloadAuthenticated, downloadBlob } from "./userDownload"

function installMinimalDom() {
  const clicks: Array<{ download: string; href: string }> = []
  const anchors: Array<{
    href: string
    download: string
    rel: string
    style: { display: string }
    click: () => void
    remove: () => void
  }> = []
  const body = {
    appendChild(node: (typeof anchors)[number]) {
      anchors.push(node)
      return node
    },
  }
  vi.stubGlobal("document", {
    body,
    createElement(tag: string) {
      if (tag !== "a") throw new Error(`unexpected ${tag}`)
      const anchor = {
        href: "",
        download: "",
        rel: "",
        style: { display: "" },
        click() {
          clicks.push({ download: this.download, href: this.href })
        },
        remove: vi.fn(),
      }
      return anchor
    },
  })
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal("window", {
    setTimeout: vi.fn((fn: () => void) => {
      // Keep blob URL alive in production; do not auto-fire in unit tests.
      void fn
      return 0
    }),
  })
  return { clicks, anchors }
}

describe("downloadBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("appends an <a download> and clicks it", () => {
    const { clicks, anchors } = installMinimalDom()
    downloadBlob(new Blob(["hello"]), "agent-loop.txt")
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.download).toBe("agent-loop.txt")
    expect(clicks).toEqual([{ download: "agent-loop.txt", href: "blob:mock" }])
  })
})

describe("downloadAuthenticated", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fetches the attachment and triggers a blob download", async () => {
    const { clicks } = installMinimalDom()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name === "content-disposition" ? 'attachment; filename="agent-loop-demo.txt"' : null,
        },
        blob: async () => new Blob(["trace"]),
        json: async () => ({}),
      })),
    )
    const result = await downloadAuthenticated("/api/runs/r1/export/trace", "fallback.txt")
    expect(result).toEqual({ filename: "agent-loop-demo.txt", bytes: 5 })
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.download).toBe("agent-loop-demo.txt")
  })
})
