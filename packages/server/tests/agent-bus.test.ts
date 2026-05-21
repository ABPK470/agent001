/**
 * Inter-agent bus tests.
 *
 * Covers (Phase B.6):
 *   1. AgentBus persists every publish to `agent_messages` (B.1).
 *   2. BusProtocol enum is enforced via the CHECK constraint (B.2).
 *   3. Sibling spawned mid-tree replays history into its inbox (B.2).
 *   4. wait_for_response resolves when an Answer arrives (B.2).
 *   5. wait_for_response fast-paths a pre-existing Answer in DB (B.2).
 *   6. wait_for_response respects the timeout (B.2).
 *   7. Help protocol fires AgentHelpRequested SSE (B.3).
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seedRun } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-bus-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  vi.restoreAllMocks()
})

async function bootstrap(): Promise<{ rootRunId: string }> {
  const { _setDb, _migrate } = await import("../src/db/index.js")
  _migrate(testDb)
  _setDb(testDb)
  const rootRunId = "00000000-0000-0000-0000-000000000001"
  seedRun(testDb, rootRunId, { goal: "test" })
  return { rootRunId }
}

describe("AgentBus persistence (B.1)", () => {
  it("writes every publish to the agent_messages table", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    bus.publish({ topic: "channel-a", fromRunId: rootRunId, fromAgent: "Parent", content: "hi", protocol: BusProtocol.Status })
    bus.publish({ topic: "channel-b", fromRunId: rootRunId, fromAgent: "Parent", content: "done", protocol: BusProtocol.Result })

    const rows = testDb.prepare(`SELECT topic, protocol, content FROM agent_messages WHERE root_run_id = ? ORDER BY created_at ASC`).all(rootRunId) as Array<{ topic: string; protocol: string; content: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ topic: "channel-a", protocol: "status", content: "hi" })
    expect(rows[1]).toMatchObject({ topic: "channel-b", protocol: "result", content: "done" })
  })

  it("rejects an unknown protocol literal at the DB CHECK boundary (B.2)", async () => {
    const { rootRunId } = await bootstrap()
    expect(() => {
      testDb.prepare(`
        INSERT INTO agent_messages (id, root_run_id, from_run_id, from_agent, protocol, topic, content, created_at)
        VALUES ('x', ?, ?, 'P', 'invalid-protocol', 't', 'c', datetime('now'))
      `).run(rootRunId, rootRunId)
    }).toThrow(/CHECK constraint/i)
  })

  it("cascade-deletes messages when the root run is removed", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")
    new AgentBus(rootRunId).publish({ topic: "t", fromRunId: rootRunId, fromAgent: "P", content: "c", protocol: BusProtocol.Broadcast })

    testDb.prepare(`DELETE FROM runs WHERE id = ?`).run(rootRunId)
    const remaining = testDb.prepare(`SELECT COUNT(*) AS n FROM agent_messages`).get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})

describe("AgentBus history replay (B.2)", () => {
  it("a sibling spawned mid-tree sees prior messages in its initial inbox", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    bus.publish({ topic: "research", fromRunId: "child-1", fromAgent: "Researcher", content: "found X", protocol: BusProtocol.Status })
    bus.publish({ topic: "research", fromRunId: "child-1", fromAgent: "Researcher", content: "found Y", protocol: BusProtocol.Status })

    // Sibling spawned later — should still see the prior research updates.
    const siblingTools = createBusTools(bus, "child-2", "Writer")
    const checkMessages = siblingTools.find((t) => t.name === "check_messages")!
    const out = await checkMessages.execute({}) as string
    expect(out).toContain("found X")
    expect(out).toContain("found Y")
    expect(out).toContain("Researcher")
  })

  it("does not include the agent's own messages in its inbox", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    bus.publish({ topic: "t", fromRunId: "me", fromAgent: "Me", content: "self-talk", protocol: BusProtocol.Broadcast })
    bus.publish({ topic: "t", fromRunId: "other", fromAgent: "Other", content: "external", protocol: BusProtocol.Broadcast })

    const tools = createBusTools(bus, "me", "Me")
    const out = await tools.find((t) => t.name === "check_messages")!.execute({}) as string
    expect(out).toContain("external")
    expect(out).not.toContain("self-talk")
  })
})

describe("wait_for_response (B.2)", () => {
  it("resolves when an Answer arrives after subscription", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    const askerTools = createBusTools(bus, "asker", "Asker")
    const responderTools = createBusTools(bus, "responder", "Responder")

    const sendMessage = askerTools.find((t) => t.name === "send_message")!
    const sendResult = await sendMessage.execute({ topic: "q1", content: "what is x?", protocol: BusProtocol.Question }) as string
    const messageId = sendResult.match(/Message ([0-9a-f-]+) sent/)?.[1]
    expect(messageId).toBeTruthy()

    const waitTool = askerTools.find((t) => t.name === "wait_for_response")!
    const waitPromise = waitTool.execute({ message_id: messageId, timeout_ms: 2_000 })

    // Responder posts an Answer asynchronously
    setTimeout(() => {
      void responderTools.find((t) => t.name === "send_message")!.execute({
        topic: "q1",
        content: "x = 42",
        protocol: BusProtocol.Answer,
        reply_to: messageId,
      })
    }, 20)

    const text = await waitPromise as string
    expect(text).toContain("x = 42")
    expect(text).toContain("Responder")
  })

  it("fast-paths a pre-existing Answer in the DB", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    const question = bus.publish({ topic: "q", fromRunId: "asker", fromAgent: "Asker", content: "?", protocol: BusProtocol.Question })
    bus.publish({ topic: "q", fromRunId: "responder", fromAgent: "Responder", content: "answer-text", protocol: BusProtocol.Answer, replyTo: question.id })

    // wait_for_response is called AFTER the answer is already persisted.
    const askerTools = createBusTools(bus, "asker", "Asker")
    const text = await askerTools.find((t) => t.name === "wait_for_response")!.execute({ message_id: question.id, timeout_ms: 5_000 }) as string
    expect(text).toContain("answer-text")
  })

  it("returns a timeout marker when no answer arrives", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")

    const bus = new AgentBus(rootRunId)
    const tools = createBusTools(bus, "asker", "Asker")
    const text = await tools.find((t) => t.name === "wait_for_response")!.execute({
      message_id: "00000000-0000-0000-0000-000000000999",
      timeout_ms: 1_000,
    }) as string
    expect(text).toMatch(/Timeout/i)
  })

  it("rejects an Answer without reply_to via send_message", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")

    const bus = new AgentBus(rootRunId)
    const tools = createBusTools(bus, "responder", "Responder")
    const result = await tools.find((t) => t.name === "send_message")!.execute({
      topic: "t",
      content: "answer-without-target",
      protocol: BusProtocol.Answer,
    }) as string
    expect(result).toMatch(/requires reply_to/i)
  })
})

describe("Help protocol routing (B.3)", () => {
  it("emits AgentHelpRequested SSE in addition to AgentBusMessage", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")
    const { subscribeToEvents } = await import("../src/event-broadcaster.js")

    const seen: string[] = []
    const unsubscribe = subscribeToEvents((ev) => { seen.push(ev.type) })
    try {
      const bus = new AgentBus(rootRunId)
      bus.publish({ topic: "t", fromRunId: "child", fromAgent: "Child", content: "I'm stuck", protocol: BusProtocol.Help })
    } finally {
      unsubscribe()
    }
    expect(seen).toContain("agent.bus.message")
    expect(seen).toContain("agent.help.requested")
  })

  it("does NOT emit AgentHelpRequested for non-Help protocols", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus } = await import("../src/agent-bus.js")
    const { BusProtocol } = await import("../src/enums/bus.js")
    const { subscribeToEvents } = await import("../src/event-broadcaster.js")

    const seen: string[] = []
    const unsubscribe = subscribeToEvents((ev) => { seen.push(ev.type) })
    try {
      const bus = new AgentBus(rootRunId)
      bus.publish({ topic: "t", fromRunId: "child", fromAgent: "Child", content: "just an update", protocol: BusProtocol.Status })
    } finally {
      unsubscribe()
    }
    expect(seen).toContain("agent.bus.message")
    expect(seen).not.toContain("agent.help.requested")
  })
})

/**
 * Per-child bus identity (B.3) — each spawned child must publish under
 * its OWN runId/agentName, not the parent's. Regression guard for the
 * old `extraChildTools` shape that injected a single set of bus tools
 * (bound to parent identity) into every child.
 */
describe("Per-child bus identity (B.3)", () => {
  it("createBusTools binds runId+agentName per call so children publish as themselves", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    seedRun(testDb, "child-A", { goal: "a" })
    seedRun(testDb, "child-B", { goal: "b" })

    const bus = new AgentBus(rootRunId)
    const toolsA = createBusTools(bus, "child-A", "Worker A")
    const toolsB = createBusTools(bus, "child-B", "Worker B")

    const sendA = toolsA.find((t) => t.name === "send_message")!
    const sendB = toolsB.find((t) => t.name === "send_message")!

    await sendA.execute({ topic: "shared", content: "hello from A", protocol: "status" })
    await sendB.execute({ topic: "shared", content: "hello from B", protocol: "status" })

    const rows = testDb
      .prepare(`SELECT from_run_id, from_agent, content FROM agent_messages WHERE root_run_id = ? ORDER BY created_at ASC`)
      .all(rootRunId) as Array<{ from_run_id: string; from_agent: string; content: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ from_run_id: "child-A", from_agent: "Worker A" })
    expect(rows[1]).toMatchObject({ from_run_id: "child-B", from_agent: "Worker B" })
  })

  it("a child's inbox does not echo its own messages but DOES see siblings'", async () => {
    const { rootRunId } = await bootstrap()
    const { AgentBus, createBusTools } = await import("../src/agent-bus.js")
    seedRun(testDb, "child-A", { goal: "a" })
    seedRun(testDb, "child-B", { goal: "b" })

    const bus = new AgentBus(rootRunId)
    const toolsA = createBusTools(bus, "child-A", "Worker A")
    const toolsB = createBusTools(bus, "child-B", "Worker B")

    const sendA = toolsA.find((t) => t.name === "send_message")!
    const sendB = toolsB.find((t) => t.name === "send_message")!
    const checkA = toolsA.find((t) => t.name === "check_messages")!

    await sendA.execute({ topic: "shared", content: "from A", protocol: "status" })
    await sendB.execute({ topic: "shared", content: "from B", protocol: "status" })

    const observed = await checkA.execute({}) as string
    expect(observed).toContain("from B")
    expect(observed).not.toContain("from A")
  })
})

/**
 * Auto-Status throttle (B.3) — verifies the per-child counter so a long
 * run with many delegations doesn't drown the bus while still emitting
 * a heartbeat every Nth iteration. The throttle lives in run-executor;
 * we verify the algorithm here in isolation against the contract:
 *   - iteration 1 always publishes
 *   - subsequent iterations publish only when (current - last) >= N
 *   - state is per childRunId
 */
describe("Auto-Status throttle (B.3)", () => {
  it("publishes on iteration 1 and every Nth iteration after, per child", () => {
    const STATUS_THROTTLE = 5
    const lastStatusIter = new Map<string, number>()
    const published: Array<{ child: string; iter: number }> = []

    const tick = (childRunId: string, iteration: number) => {
      const last = lastStatusIter.get(childRunId) ?? 0
      if (iteration !== 1 && iteration - last < STATUS_THROTTLE) return
      lastStatusIter.set(childRunId, iteration)
      published.push({ child: childRunId, iter: iteration })
    }

    // Child A: iterations 1..12
    for (let i = 1; i <= 12; i++) tick("A", i)
    // Child B running on its own clock — should not affect A's throttle
    for (let i = 1; i <= 7; i++) tick("B", i)

    expect(published).toEqual([
      { child: "A", iter: 1 },
      { child: "A", iter: 6 },
      { child: "A", iter: 11 },
      { child: "B", iter: 1 },
      { child: "B", iter: 6 },
    ])
  })
})
