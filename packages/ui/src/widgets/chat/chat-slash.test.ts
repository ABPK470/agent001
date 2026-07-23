import { describe, expect, it, vi } from "vitest"
import {
  buildChatSlashCatalog,
  coerceSlashOnlyInput,
  dispatchChatSlashInput,
  matchChatSlash,
  parseSlashInput,
  parseTraceExportFormat,
  parseTraceExportOptions,
  type ChatCommandContext,
  type ChatSlashCommand,
} from "./commands.js"
import { helpEntriesFromCommands } from "./commandConsoleModel.js"
import {
  autofillSlashCommand,
  filterSlashCommands,
  nextSelectableSlashIndex,
  slashCommandQuery,
  slashPaletteVisible,
} from "./slashPaletteUtils.js"
import {
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composerDraftStorage.js"

const idleCtx: ChatCommandContext = {
  busy: false,
  activeThreadId: "t1",
  lastRunId: "r1",
  lastRunStatus: "completed",
  lastRunHasCheckpoint: false,
  lastRunRollbackAvailable: false,
  hasPendingInput: false,
}

function catalogDeps(overrides: Partial<ChatCommandContext> = {}) {
  return {
    ctx: { ...idleCtx, ...overrides },
    downloadLastRunTrace: vi.fn(async () => {}),
    downloadThreadTrace: vi.fn(async () => {}),
    listArtifacts: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    rerunRun: vi.fn(async () => {}),
    resumeRun: vi.fn(async () => {}),
    rollbackRun: vi.fn(async () => {}),
    showStatus: vi.fn(),
    createThread: vi.fn(async () => {}),
    openThreads: vi.fn(),
    openAttach: vi.fn(),
    openTableExport: vi.fn(),
  }
}

describe("slash parse / match", () => {
  it("parses command + args", () => {
    expect(parseSlashInput("hello")).toBeNull()
    expect(parseSlashInput("/Trace --json")).toEqual({
      command: "trace",
      args: "--json",
    })
    expect(parseSlashInput("/cancel")).toEqual({ command: "cancel", args: "" })
  })

  it("matches longest slash first", () => {
    const commands: ChatSlashCommand[] = [
      { id: "trace", label: "t", slash: "trace", run: () => {} },
      { id: "trace-thread", label: "tt", slash: "trace-thread", run: () => {} },
    ]
    expect(matchChatSlash("/trace-thread --txt", commands)?.id).toBe("trace-thread")
    expect(matchChatSlash("/trace", commands)?.id).toBe("trace")
  })

  it("parses trace export format flags", () => {
    expect(parseTraceExportFormat("--json")).toBe("json")
    expect(parseTraceExportFormat("--txt")).toBe("txt")
    expect(parseTraceExportFormat("")).toBe("txt")
  })

  it("parses /trace --no-code", () => {
    expect(parseTraceExportOptions("--no-code")).toEqual({ format: "txt", omitCode: true })
    expect(parseTraceExportOptions("--json --no-code")).toEqual({
      format: "json",
      omitCode: true,
    })
    expect(parseTraceExportOptions("--txt")).toEqual({ format: "txt", omitCode: false })
  })

  it("while busy, only allows slash input", () => {
    expect(coerceSlashOnlyInput("hi", "/", true)).toBe("/")
    expect(coerceSlashOnlyInput("/cancel", "", true)).toBe("/cancel")
    expect(coerceSlashOnlyInput("", "x", true)).toBe("")
    expect(coerceSlashOnlyInput("hi", "", false)).toBe("hi")
  })
})

describe("slash catalog + dispatch", () => {
  it("gates cancel to busy runs and trace to lastRunId", () => {
    const idle = buildChatSlashCatalog(catalogDeps({ busy: false, lastRunId: null }))
    expect(idle.find((c) => c.id === "cancel")?.available).toBe(false)
    expect(idle.find((c) => c.id === "trace")?.available).toBe(false)

    const busy = buildChatSlashCatalog(catalogDeps({ busy: true, lastRunId: "r1" }))
    expect(busy.find((c) => c.id === "cancel")?.available).toBe(true)
    expect(busy.find((c) => c.id === "thread")?.available).toBe(false)
  })

  it("dispatches available commands and rejects unknown / unavailable", async () => {
    const deps = catalogDeps({ busy: true })
    const cat = buildChatSlashCatalog(deps)
    expect(await dispatchChatSlashInput("plain", cat)).toEqual({ handled: false })
    expect(await dispatchChatSlashInput("/nope", cat)).toMatchObject({
      handled: true,
      message: expect.stringMatching(/unknown/i),
    })
    expect(await dispatchChatSlashInput("/thread", cat)).toMatchObject({
      handled: true,
      message: expect.stringMatching(/unavailable|active/i),
    })
    const ok = await dispatchChatSlashInput("/cancel", cat)
    expect(ok).toEqual({ handled: true })
    expect(deps.cancelRun).toHaveBeenCalledOnce()
  })

  it("projects help entries from the catalog", () => {
    const help = helpEntriesFromCommands(buildChatSlashCatalog(catalogDeps()))
    expect(help?.some((h) => h.slash === "trace")).toBe(true)
  })
})

describe("slash palette utils", () => {
  const cmds = buildChatSlashCatalog(catalogDeps())

  it("queries only before the first space", () => {
    expect(slashCommandQuery("hello")).toBeNull()
    expect(slashCommandQuery("/tr")).toBe("tr")
    expect(slashCommandQuery("/trace ")).toBeNull()
  })

  it("filters + autofills + navigates available rows", () => {
    expect(filterSlashCommands(cmds, null)).toEqual([])
    expect(filterSlashCommands(cmds, "tra").every((c) => c.slash.startsWith("tra"))).toBe(true)
    const trace = cmds.find((c) => c.slash === "trace")!
    expect(autofillSlashCommand(trace)).toBe("/trace ")
    expect(slashPaletteVisible("/t", false)).toBe(true)
    expect(slashPaletteVisible("/t", true)).toBe(false)

    const withUnavailable = cmds.map((c, i) =>
      i === 0 ? { ...c, available: false } : c,
    )
    const next = nextSelectableSlashIndex(withUnavailable, 0, 1)
    expect(withUnavailable[next]?.available).toBe(true)
  })
})

describe("composer draft storage", () => {
  it("keys per thread and round-trips through a mock store", () => {
    expect(composerDraftStorageKey(null)).toBeNull()
    expect(composerDraftStorageKey("t1")).toBe("mia:composer-draft:t1")

    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
      removeItem: (k: string) => {
        map.delete(k)
      },
    }
    writeComposerDraft("t1", "hello", storage)
    expect(readComposerDraft("t1", storage)).toBe("hello")
    writeComposerDraft("t1", "", storage)
    expect(readComposerDraft("t1", storage)).toBe("")
  })
})
