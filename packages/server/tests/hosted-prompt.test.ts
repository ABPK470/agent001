/**
 * Hosted-prompt redaction tests.
 *
 * Verifies the system-prompt builder emits a sandbox-only runtime block for
 * hosted runs (no real workspace path / no source tree dump) and keeps the
 * developer-mode behavior unchanged.
 */

import type { Tool } from "@mia/agent"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildSystemMessages } from "../src/orchestrator/system-messages.js"
import type { RunWorkspaceContext } from "../src/run-workspace.js"

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function createWorkspaceWithSecrets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "promptctx-"))
  created.push(dir)
  await mkdir(join(dir, "src", "secret-internal"), { recursive: true })
  await mkdir(join(dir, "config"), { recursive: true })
  await writeFile(join(dir, "src", "secret-internal", "leak.ts"), "export const leak = true\n")
  return dir
}

function emptyTier() {
  return { working: "", episodic: "", semantic: "" }
}

describe("hosted prompt redaction", () => {
  it("hosted profile prompt omits the real workspace path and source tree", async () => {
    const sourceRoot = await createWorkspaceWithSecrets()
    const sandboxRoot = await mkdtemp(join(tmpdir(), "sandbox-"))
    created.push(sandboxRoot)

    const runWorkspace: RunWorkspaceContext = {
      runId:         "run-1",
      sourceRoot,
      executionRoot: sandboxRoot,
      taskType:      "analysis_or_chat",
      isolated:      true,
      profile:       "hosted",
    }

    const messages = await buildSystemMessages({
      goal:         "summarize the dataset",
      systemPrompt: undefined,
      allTools:     [] as Tool[],
      runWorkspace,
      perTier:      emptyTier(),
      runId:        "run-1",
    })

    const joined = messages.map((m) => m.content).join("\n---\n")
    // Real source tree must not appear.
    expect(joined).not.toContain(sourceRoot)
    expect(joined).not.toContain("secret-internal")
    expect(joined).not.toMatch(/Structure:\n/)
    // Hosted runtime hint must appear.
    expect(joined).toContain("Hosted runtime:")
    expect(joined).toMatch(/sandbox:\/\//)
    expect(joined).toMatch(/UAT and PROD are read-only/i)
  })

  it("developer admin prompt keeps the workspace path and tree", async () => {
    const sourceRoot = await createWorkspaceWithSecrets()

    const runWorkspace: RunWorkspaceContext = {
      runId:         "run-2",
      sourceRoot,
      executionRoot: sourceRoot,
      taskType:      "analysis_or_chat",
      isolated:      false,
      profile:       "developer",
    }

    const messages = await buildSystemMessages({
      goal:         "summarize the dataset",
      systemPrompt: undefined,
      allTools:     [] as Tool[],
      runWorkspace,
      perTier:      emptyTier(),
      runId:        "run-2",
      isAdmin:      true,
    })

    const joined = messages.map((m) => m.content).join("\n---\n")
    expect(joined).toContain(`Workspace: ${sourceRoot}`)
    expect(joined).toContain("secret-internal")
    expect(joined).toMatch(/Structure:\n/)
    expect(joined).not.toContain("Hosted runtime:")
  })

  it("developer non-admin prompt omits the workspace path and tree", async () => {
    const sourceRoot = await createWorkspaceWithSecrets()

    const runWorkspace: RunWorkspaceContext = {
      runId:         "run-3",
      sourceRoot,
      executionRoot: sourceRoot,
      taskType:      "analysis_or_chat",
      isolated:      false,
      profile:       "developer",
    }

    const messages = await buildSystemMessages({
      goal:         "summarize the dataset",
      systemPrompt: undefined,
      allTools:     [] as Tool[],
      runWorkspace,
      perTier:      emptyTier(),
      runId:        "run-3",
      isAdmin:      false,
    })

    const joined = messages.map((m) => m.content).join("\n---\n")
    expect(joined).not.toContain(`Workspace: ${sourceRoot}`)
    expect(joined).not.toContain("secret-internal")
    expect(joined).not.toMatch(/Structure:\n/)
    expect(joined).not.toContain("Hosted runtime:")
  })
})
