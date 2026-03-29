import { PolicyEffect } from "../src/engine/index.js"
import { describe, expect, it } from "vitest"
import {
    createEngineServices,
    runGoverned
} from "../src/governance.js"
import type { LLMClient, LLMResponse, Tool } from "../src/types.js"

// ── Test helpers ─────────────────────────────────────────────────

/** A simple tool that returns its input as a string. */
function echoTool(name = "echo"): Tool {
  return {
    name,
    description: `Echo tool: ${name}`,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args) {
      return `echoed: ${String(args.text)}`
    },
  }
}

/** A tool that always throws. */
function failingTool(): Tool {
  return {
    name: "fail_tool",
    description: "Always fails",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      throw new Error("tool broke")
    },
  }
}

/**
 * Mock LLM that follows a scripted sequence of responses.
 * Each call to chat() returns the next response in the script.
 */
function scriptedLLM(responses: LLMResponse[]): LLMClient {
  let callIndex = 0
  return {
    async chat() {
      if (callIndex >= responses.length) {
        return { content: "out of script", toolCalls: [] }
      }
      return responses[callIndex++]
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("Governance integration", () => {
  describe("run tracking", () => {
    it("creates a run that completes when agent finishes", async () => {
      const llm = scriptedLLM([
        { content: "I'll use echo", toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }] },
        { content: "Done: echoed hello", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("say hello", llm, [echoTool()], services)

      expect(result.run.status).toBe("completed")
      expect(result.answer).toBe("Done: echoed hello")
    })

    it("tracks each tool call as a step in the run", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "one" } }] },
        { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "two" } }] },
        { content: "final answer", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("count", llm, [echoTool()], services)

      expect(result.run.steps).toHaveLength(2)
      expect(result.run.steps[0].action).toBe("echo")
      expect(result.run.steps[0].status).toBe("completed")
      expect(result.run.steps[1].action).toBe("echo")
      expect(result.run.steps[1].status).toBe("completed")
    })

    it("marks run as failed when agent throws", async () => {
      const llm: LLMClient = {
        async chat() {
          throw new Error("LLM exploded")
        },
      }
      const services = createEngineServices()

      const result = await runGoverned("boom", llm, [echoTool()], services)

      expect(result.run.status).toBe("failed")
      expect(result.answer).toContain("Agent failed")
    })

    it("persists the run to the repo", async () => {
      const llm = scriptedLLM([
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("simple", llm, [], services)
      const saved = await services.runRepo.get(result.run.id)

      expect(saved).not.toBeNull()
      expect(saved!.status).toBe("completed")
    })
  })

  describe("audit trail", () => {
    it("logs agent.started and agent.completed", async () => {
      const llm = scriptedLLM([
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("test goal", llm, [], services)

      const actions = result.auditTrail.map((e) => e.action)
      expect(actions).toContain("agent.started")
      expect(actions).toContain("agent.completed")
    })

    it("logs tool.invoked and tool.completed for each tool call", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("use echo", llm, [echoTool()], services)

      const actions = result.auditTrail.map((e) => e.action)
      expect(actions).toContain("tool.invoked")
      expect(actions).toContain("tool.completed")
    })

    it("logs tool.failed when a tool throws", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "fail_tool", arguments: {} }] },
        { content: "it failed, moving on", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("try fail", llm, [failingTool()], services)

      const actions = result.auditTrail.map((e) => e.action)
      expect(actions).toContain("tool.failed")
    })

    it("records the actor in audit entries", async () => {
      const llm = scriptedLLM([
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned("test", llm, [], services, {
        actor: "test-agent",
        verbose: false,
      })

      expect(result.auditTrail.every((e) => e.actor === "test-agent")).toBe(true)
    })
  })

  describe("policies", () => {
    it("blocks a tool when policy denies it", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
        { content: "tool was blocked, giving up", toolCalls: [] },
      ])
      const services = createEngineServices()
      services.policyEvaluator.addRule({
        name: "no_echo",
        effect: PolicyEffect.Deny,
        condition: "action:echo",
        parameters: {},
      })

      const result = await runGoverned("try echo", llm, [echoTool()], services, { verbose: false })

      // The step should be failed (denied)
      expect(result.run.steps[0].status).toBe("failed")
      expect(result.run.steps[0].error).toContain("Denied by policy")

      // Audit trail should show denial
      const actions = result.auditTrail.map((e) => e.action)
      expect(actions).toContain("tool.denied")
    })

    it("blocks a tool when policy requires approval", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
        { content: "blocked, done", toolCalls: [] },
      ])
      const services = createEngineServices()
      services.policyEvaluator.addRule({
        name: "approve_echo",
        effect: PolicyEffect.RequireApproval,
        condition: "action:echo",
        parameters: {},
      })

      const result = await runGoverned("try echo", llm, [echoTool()], services, { verbose: false })

      expect(result.run.steps[0].status).toBe("failed")
      expect(result.run.steps[0].error).toContain("Blocked by policy")

      const actions = result.auditTrail.map((e) => e.action)
      expect(actions).toContain("tool.blocked")
    })

    it("allows tools that have no matching policy", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
        { content: "echoed hi", toolCalls: [] },
      ])
      const services = createEngineServices()
      // Policy only blocks "dangerous_tool", not "echo"
      services.policyEvaluator.addRule({
        name: "no_danger",
        effect: PolicyEffect.Deny,
        condition: "action:dangerous_tool",
        parameters: {},
      })

      const result = await runGoverned("use echo", llm, [echoTool()], services, { verbose: false })

      expect(result.run.steps[0].status).toBe("completed")
    })
  })

  describe("execution records / stats", () => {
    it("records execution metrics in the learner", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "a" } }] },
        { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "b" } }] },
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      await runGoverned("two echoes", llm, [echoTool()], services, { verbose: false })

      const stats = await services.learner.statsFor("echo")
      expect(stats.total).toBe(2)
      expect(stats.successes).toBe(2)
      expect(stats.failures).toBe(0)
    })

    it("records failures in learner stats", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "fail_tool", arguments: {} }] },
        { content: "it failed", toolCalls: [] },
      ])
      const services = createEngineServices()

      await runGoverned("fail", llm, [failingTool()], services, { verbose: false })

      const stats = await services.learner.statsFor("fail_tool")
      expect(stats.total).toBe(1)
      expect(stats.failures).toBe(1)
    })

    it("returns per-tool stats in the governed result", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "alpha", arguments: { text: "x" } }] },
        { content: null, toolCalls: [{ id: "tc2", name: "beta", arguments: { text: "y" } }] },
        { content: null, toolCalls: [{ id: "tc3", name: "alpha", arguments: { text: "z" } }] },
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      const result = await runGoverned(
        "multi",
        llm,
        [echoTool("alpha"), echoTool("beta")],
        services,
        { verbose: false },
      )

      expect(result.stats.get("alpha")!.calls).toBe(2)
      expect(result.stats.get("beta")!.calls).toBe(1)
    })
  })

  describe("domain events", () => {
    it("emits run.started and run.completed events", async () => {
      const llm = scriptedLLM([
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      await runGoverned("test", llm, [], services, { verbose: false })

      const types = services.eventBus.history.map((e) => e.type)
      expect(types).toContain("run.started")
      expect(types).toContain("run.completed")
    })

    it("emits step.started and step.completed for each tool call", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hi" } }] },
        { content: "done", toolCalls: [] },
      ])
      const services = createEngineServices()

      await runGoverned("use tool", llm, [echoTool()], services, { verbose: false })

      const types = services.eventBus.history.map((e) => e.type)
      expect(types).toContain("step.started")
      expect(types).toContain("step.completed")
    })

    it("emits step.failed when a tool throws", async () => {
      const llm = scriptedLLM([
        { content: null, toolCalls: [{ id: "tc1", name: "fail_tool", arguments: {} }] },
        { content: "failed", toolCalls: [] },
      ])
      const services = createEngineServices()

      await runGoverned("fail", llm, [failingTool()], services, { verbose: false })

      const types = services.eventBus.history.map((e) => e.type)
      expect(types).toContain("step.failed")
    })

    it("emits run.failed when agent fails", async () => {
      const llm: LLMClient = {
        async chat() { throw new Error("boom") },
      }
      const services = createEngineServices()

      await runGoverned("explode", llm, [], services, { verbose: false })

      const types = services.eventBus.history.map((e) => e.type)
      expect(types).toContain("run.failed")
    })
  })
})
