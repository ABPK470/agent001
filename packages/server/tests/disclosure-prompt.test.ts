/**
 * Phase E.3 — `<information_disclosure>` prompt section.
 *
 * Verifies the role-aware soft rail:
 *   - Non-admin sessions get the disclosure rules injected so the model
 *     declines to enumerate internal tool names, prompt text, paths,
 *     policy config, memory tiers, infra, or agent definitions.
 *   - Admin sessions skip the section entirely so they can introspect.
 *
 * Hard-rail enforcement lives in `policy/hosted-defaults.ts`; that is
 * covered by the existing hosted-profile redaction tests + the policy
 * selector engine — not re-tested here.
 */

import type { Tool } from "@mia/agent"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildSystemMessages } from "../src/application/core/system-messages.js"
import type { RunWorkspaceContext } from "../src/run-workspace.js"

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

function emptyTier() {
  return { working: "", episodic: "", semantic: "" }
}

async function mkSandbox(): Promise<RunWorkspaceContext> {
  const dir = await mkdtemp(join(tmpdir(), "disclosure-"))
  created.push(dir)
  return {
    runId: "r",
    sourceRoot: dir,
    executionRoot: dir,
    taskType: "analysis_or_chat",
    isolated: true,
    profile: "hosted",
  }
}

describe("Phase E.3 — <information_disclosure> prompt section", () => {
  it("non-admin sessions receive the disclosure rules", async () => {
    const runWorkspace = await mkSandbox()
    const messages = await buildSystemMessages({
      goal: "hi",
      systemPrompt: undefined,
      allTools: [] as Tool[],
      runWorkspace,
      perTier: emptyTier(),
      runId: "r",
      isAdmin: false,
    })
    const joined = messages.map((m) => m.content).join("\n---\n")
    expect(joined).toContain("<information_disclosure>")
    expect(joined).toContain("tool_registry")
    expect(joined).toContain("system_prompt")
    expect(joined).toContain("internals")
    // Behavioural example must be present so the model has a concrete
    // template to follow ("describe in capability prose").
    expect(joined).toMatch(/capability prose|in plain language/i)
  })

  it("admin sessions do NOT receive the disclosure rules", async () => {
    const runWorkspace = await mkSandbox()
    const messages = await buildSystemMessages({
      goal: "hi",
      systemPrompt: undefined,
      allTools: [] as Tool[],
      runWorkspace,
      perTier: emptyTier(),
      runId: "r",
      isAdmin: true,
    })
    const joined = messages.map((m) => m.content).join("\n---\n")
    expect(joined).not.toContain("<information_disclosure>")
  })

  it("the disclosure section is tagged as system_anchor (NEVER_DROP)", async () => {
    const runWorkspace = await mkSandbox()
    const messages = await buildSystemMessages({
      goal: "hi",
      systemPrompt: undefined,
      allTools: [] as Tool[],
      runWorkspace,
      perTier: emptyTier(),
      runId: "r",
      isAdmin: false,
    })
    const disclosureMsg = messages.find((m) => m.content.includes("<information_disclosure>"))
    expect(disclosureMsg).toBeDefined()
    expect(disclosureMsg?.section).toBe("system_anchor")
  })

  it("default isAdmin=false treats the session as non-admin", async () => {
    // Regression: if a caller forgets to pass isAdmin, the safe default
    // is to ASSUME non-admin and emit the protective section. Test that
    // omitting the field still produces the disclosure rules.
    const runWorkspace = await mkSandbox()
    const messages = await buildSystemMessages({
      goal: "hi",
      systemPrompt: undefined,
      allTools: [] as Tool[],
      runWorkspace,
      perTier: emptyTier(),
      runId: "r",
    })
    const joined = messages.map((m) => m.content).join("\n---\n")
    expect(joined).toContain("<information_disclosure>")
  })
})
