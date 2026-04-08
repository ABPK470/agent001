/**
 * Context compaction tests — verify progressive message compaction.
 *
 * The compaction system prevents LLM degeneration by replacing stale
 * tool results with compact summaries. These tests verify:
 *   1. Superseded reads are compacted (file read, then later written)
 *   2. Superseded writes are compacted (file written multiple times)
 *   3. Old large tool results are compacted (>3 iterations ago)
 *   4. Recent results are preserved verbatim
 *   5. Small results are never compacted
 */
import { describe, expect, it } from "vitest"
import { compactMessages } from "../src/agent.js"
import type { Message } from "../src/types.js"

// ── Helpers ──────────────────────────────────────────────────────

let toolCallCounter = 0
function tc(name: string, args: Record<string, unknown>) {
  return { id: `tc_${++toolCallCounter}`, name, arguments: args }
}

function assistantWithTools(...calls: ReturnType<typeof tc>[]): Message {
  return { role: "assistant", content: "thinking...", toolCalls: calls, section: "history" }
}

function toolResult(call: ReturnType<typeof tc>, content: string): Message {
  return { role: "tool", toolCallId: call.id, content, section: "history" }
}

const BIG_FILE = "function foo() { return 1; }\n".repeat(50) // ~1400 chars
const SMALL_RESULT = "ok" // < 500 chars, never compacted

// ── Tests ────────────────────────────────────────────────────────

describe("Context compaction", () => {
  it("compacts superseded read_file results", () => {
    // Iteration 1: read game.js
    const readCall = tc("read_file", { path: "game.js" })
    // Iteration 2: write game.js (supersedes the read)
    const writeCall = tc("write_file", { path: "game.js" })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Build a game", section: "user" },
      assistantWithTools(readCall),
      toolResult(readCall, BIG_FILE),
      assistantWithTools(writeCall),
      toolResult(writeCall, "File written: game.js"),
    ]

    const result = compactMessages(messages)

    // The read result should be compacted (it's stale)
    const readResult = result.find(m => m.toolCallId === readCall.id)!
    expect(readResult.content).toContain("[compacted")
    expect(readResult.content).toContain("superseded")
    expect(readResult.content).not.toContain("function foo")
  })

  it("compacts superseded write_file results", () => {
    // Iteration 1: write game.js
    const write1 = tc("write_file", { path: "game.js" })
    // Iteration 2: write game.js again (supersedes)
    const write2 = tc("write_file", { path: "game.js" })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Build a game", section: "user" },
      assistantWithTools(write1),
      toolResult(write1, BIG_FILE),
      assistantWithTools(write2),
      toolResult(write2, "function bar() { return 2; }\n".repeat(30)),
    ]

    const result = compactMessages(messages)

    // First write compacted, second preserved
    const write1Result = result.find(m => m.toolCallId === write1.id)!
    expect(write1Result.content).toContain("[compacted")
    expect(write1Result.content).toContain("superseded")

    const write2Result = result.find(m => m.toolCallId === write2.id)!
    expect(write2Result.content).toContain("function bar")
  })

  it("compacts old large tool results (>3 iterations ago)", () => {
    // Build 5 iterations so that iteration 1 is old enough to compact
    const calls = [
      tc("read_file", { path: "a.js" }),
      tc("read_file", { path: "b.js" }),
      tc("read_file", { path: "c.js" }),
      tc("read_file", { path: "d.js" }),
      tc("read_file", { path: "e.js" }),
    ]

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Read files", section: "user" },
    ]

    // Each read is a separate iteration
    for (const call of calls) {
      messages.push(assistantWithTools(call))
      messages.push(toolResult(call, BIG_FILE))
    }

    const result = compactMessages(messages)

    // First call (4 iterations ago → compacted)
    const firstResult = result.find(m => m.toolCallId === calls[0].id)!
    expect(firstResult.content).toContain("[compacted")

    // Last call (0 iterations ago → preserved)
    const lastResult = result.find(m => m.toolCallId === calls[4].id)!
    expect(lastResult.content).toContain("function foo")
  })

  it("never compacts small results", () => {
    const call = tc("read_file", { path: "tiny.js" })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Read", section: "user" },
      // Many iterations to make it "old"
      assistantWithTools(tc("write_file", { path: "x1.js" })),
      toolResult(tc("write_file", { path: "x1.js" }), "ok"),
      assistantWithTools(tc("write_file", { path: "x2.js" })),
      toolResult(tc("write_file", { path: "x2.js" }), "ok"),
      assistantWithTools(tc("write_file", { path: "x3.js" })),
      toolResult(tc("write_file", { path: "x3.js" }), "ok"),
      assistantWithTools(tc("write_file", { path: "x4.js" })),
      toolResult(tc("write_file", { path: "x4.js" }), "ok"),
      assistantWithTools(call),
      toolResult(call, SMALL_RESULT),
    ]

    const result = compactMessages(messages)

    // Small result preserved even if old
    const readResult = result.find(m => m.toolCallId === call.id)!
    expect(readResult.content).toBe(SMALL_RESULT)
  })

  it("preserves recent results verbatim", () => {
    // Only 2 iterations, so everything is "recent"
    const read1 = tc("read_file", { path: "game.js" })
    const read2 = tc("read_file", { path: "game.js" })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Read", section: "user" },
      assistantWithTools(read1),
      toolResult(read1, BIG_FILE),
      assistantWithTools(read2),
      toolResult(read2, BIG_FILE),
    ]

    const result = compactMessages(messages)

    // Both should be preserved — only 2 iterations
    const r1 = result.find(m => m.toolCallId === read1.id)!
    expect(r1.content).toContain("function foo")
    const r2 = result.find(m => m.toolCallId === read2.id)!
    expect(r2.content).toContain("function foo")
  })

  it("compacts run_command results to head+tail", () => {
    const call = tc("run_command", { command: "npm test" })
    const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i}: test result`).join("\n")

    // Build enough iterations to make this old
    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Test", section: "user" },
      assistantWithTools(call),
      toolResult(call, longOutput),
      // 4 more iterations to push the first one out of recency window
      assistantWithTools(tc("read_file", { path: "a.js" })),
      toolResult(tc("read_file", { path: "a.js" }), "a"),
      assistantWithTools(tc("read_file", { path: "b.js" })),
      toolResult(tc("read_file", { path: "b.js" }), "b"),
      assistantWithTools(tc("read_file", { path: "c.js" })),
      toolResult(tc("read_file", { path: "c.js" }), "c"),
      assistantWithTools(tc("read_file", { path: "d.js" })),
      toolResult(tc("read_file", { path: "d.js" }), "d"),
    ]

    const result = compactMessages(messages)
    const cmdResult = result.find(m => m.toolCallId === call.id)!
    expect(cmdResult.content).toContain("[compacted] run_command")
    expect(cmdResult.content).toContain("line 0")  // head preserved
    expect(cmdResult.content).toContain("line 99")  // tail preserved
    expect(cmdResult.content.length).toBeLessThan(longOutput.length)
  })

  it("preserves message count (no drops, only content replacement)", () => {
    const read1 = tc("read_file", { path: "game.js" })
    const write1 = tc("write_file", { path: "game.js" })

    const messages: Message[] = [
      { role: "system", content: "System", section: "system_anchor" },
      { role: "user", content: "Goal", section: "user" },
      assistantWithTools(read1),
      toolResult(read1, BIG_FILE),
      assistantWithTools(write1),
      toolResult(write1, BIG_FILE),
    ]

    const result = compactMessages(messages)
    // Compaction never DROPS messages — only replaces content
    expect(result.length).toBe(messages.length)
  })

  it("compacts old assistant write_file arguments", () => {
    // write_file args contain full file content — this bloats assistant messages
    const write1 = tc("write_file", { path: "game.js", content: BIG_FILE })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Build", section: "user" },
      assistantWithTools(write1),
      toolResult(write1, "File written: game.js"),
      // 4 more iterations to age it
      assistantWithTools(tc("read_file", { path: "a.js" })),
      toolResult(tc("read_file", { path: "a.js" }), "a"),
      assistantWithTools(tc("read_file", { path: "b.js" })),
      toolResult(tc("read_file", { path: "b.js" }), "b"),
      assistantWithTools(tc("read_file", { path: "c.js" })),
      toolResult(tc("read_file", { path: "c.js" }), "c"),
      assistantWithTools(tc("read_file", { path: "d.js" })),
      toolResult(tc("read_file", { path: "d.js" }), "d"),
    ]

    const result = compactMessages(messages)

    // The assistant message's write_file arguments should be compacted
    const assistantMsg = result[2] // assistant message with write_file
    const compactedArgs = assistantMsg.toolCalls![0].arguments as Record<string, unknown>
    expect(compactedArgs.content).toContain("[compacted")
    expect(compactedArgs.content).not.toContain("function foo")
    // Path is preserved — only content is compacted
    expect(compactedArgs.path).toBe("game.js")
  })

  it("compacts superseded write_file arguments even if recent", () => {
    // If game.js is written, then rewritten, the FIRST write's args are stale
    const write1 = tc("write_file", { path: "game.js", content: BIG_FILE })
    const write2 = tc("write_file", { path: "game.js", content: "new content\n".repeat(50) })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Build", section: "user" },
      assistantWithTools(write1),
      toolResult(write1, "File written"),
      assistantWithTools(write2),
      toolResult(write2, "File written"),
    ]

    const result = compactMessages(messages)

    // First write's arguments should be compacted (superseded)
    const first = result[2].toolCalls![0].arguments as Record<string, unknown>
    expect(first.content).toContain("[compacted")

    // Second write's arguments should be preserved (latest)
    const second = result[4].toolCalls![0].arguments as Record<string, unknown>
    expect(second.content).toContain("new content")
  })

  it("preserves recent assistant arguments when not superseded", () => {
    // A recent write_file to a unique file should keep full arguments
    const write1 = tc("write_file", { path: "game.js", content: BIG_FILE })

    const messages: Message[] = [
      { role: "system", content: "You are an agent", section: "system_anchor" },
      { role: "user", content: "Build", section: "user" },
      assistantWithTools(write1),
      toolResult(write1, "File written"),
    ]

    const result = compactMessages(messages)

    // Only 1 iteration, not superseded → args preserved
    const args = result[2].toolCalls![0].arguments as Record<string, unknown>
    expect(args.content).toContain("function foo")
  })
})
