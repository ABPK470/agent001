import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { hasBlockingErrors, runSetupChecks } from "../src/cli/setup/checks.js"
import { mergeEnvFile, parseEnvFile } from "../src/cli/setup/env-file.js"
import type { SetupLayout } from "../src/cli/setup/types.js"

function makeLayout(root: string, overrides: Partial<SetupLayout> = {}): SetupLayout {
  return {
    projectRoot: root,
    envPath: join(root, ".env"),
    envExamplePath: join(root, ".env.example"),
    packaged: false,
    isProduction: false,
    ...overrides,
  }
}

describe("setup checks", () => {
  let tempRoot: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mia-setup-"))
    mkdirSync(resolve(tempRoot, "deploy/sync/artifacts"), { recursive: true })
    process.env = { ...originalEnv }
    delete process.env.MIA_DATA_DIR
    delete process.env.MIA_COOKIE_SECRET
    delete process.env.MIA_PACKAGE_ROOT
    delete process.env.NODE_ENV
    delete process.env.LLM_PROVIDER
    delete process.env.DATABRICKS_HOST
  })

  afterEach(() => {
    process.env = originalEnv
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it("blocks when .env is missing", () => {
    const report = runSetupChecks(makeLayout(tempRoot))
    expect(hasBlockingErrors(report)).toBe(true)
    expect(report.checks.find((c) => c.id === "env-file")?.severity).toBe("error")
  })

  it("blocks when MIA_DATA_DIR is missing even in dev", () => {
    writeFileSync(join(tempRoot, ".env"), "LLM_PROVIDER=copilot-chat\n")
    process.env.LLM_PROVIDER = "copilot-chat"
    const report = runSetupChecks(makeLayout(tempRoot))
    expect(report.checks.find((c) => c.id === "mia-data-dir")?.severity).toBe("error")
  })

  it("passes when .env has required keys", () => {
    writeFileSync(
      join(tempRoot, ".env"),
      "MIA_DATA_DIR=/tmp/mia-test-data\nLLM_PROVIDER=copilot-chat\n",
    )
    process.env.MIA_DATA_DIR = "/tmp/mia-test-data"
    process.env.LLM_PROVIDER = "copilot-chat"

    const report = runSetupChecks(makeLayout(tempRoot))
    expect(hasBlockingErrors(report)).toBe(false)
  })

  it("requires LLM_PROVIDER in .env", () => {
    writeFileSync(join(tempRoot, ".env"), "MIA_DATA_DIR=/tmp/mia\n")
    process.env.MIA_DATA_DIR = "/tmp/mia"
    const report = runSetupChecks(makeLayout(tempRoot))
    expect(report.checks.find((c) => c.id === "llm-provider")?.severity).toBe("error")
  })

  it("requires databricks credentials when LLM_PROVIDER=databricks", () => {
    writeFileSync(join(tempRoot, ".env"), "MIA_DATA_DIR=/tmp/mia\nLLM_PROVIDER=databricks\n")
    process.env.MIA_DATA_DIR = "/tmp/mia"
    process.env.LLM_PROVIDER = "databricks"
    const report = runSetupChecks(makeLayout(tempRoot))
    expect(report.checks.find((c) => c.id === "llm-databricks")?.severity).toBe("error")
  })

  it("accepts databricks when credentials are in .env", () => {
    writeFileSync(
      join(tempRoot, ".env"),
      [
        "MIA_DATA_DIR=/tmp/mia",
        "LLM_PROVIDER=databricks",
        "DATABRICKS_HOST=https://dbc.example.com",
        "DATABRICKS_CLIENT_ID=id",
        "DATABRICKS_CLIENT_SECRET=secret",
      ].join("\n") + "\n",
    )
    process.env.MIA_DATA_DIR = "/tmp/mia"
    process.env.LLM_PROVIDER = "databricks"
    process.env.DATABRICKS_HOST = "https://dbc.example.com"
    process.env.DATABRICKS_CLIENT_ID = "id"
    process.env.DATABRICKS_CLIENT_SECRET = "secret"

    const report = runSetupChecks(makeLayout(tempRoot))
    expect(hasBlockingErrors(report)).toBe(false)
    expect(report.checks.find((c) => c.id === "llm-databricks")?.severity).toBe("ok")
  })

  it("requires cookie secret in production", () => {
    writeFileSync(
      join(tempRoot, ".env"),
      "MIA_DATA_DIR=/tmp/mia\nLLM_PROVIDER=copilot-chat\n",
    )
    process.env.MIA_DATA_DIR = "/tmp/mia"
    process.env.LLM_PROVIDER = "copilot-chat"
    const report = runSetupChecks(makeLayout(tempRoot, { isProduction: true }))
    expect(report.checks.find((c) => c.id === "cookie-secret")?.severity).toBe("error")
  })

  it("warns when MSSQL is configured but sync bundle is not published yet", () => {
    writeFileSync(
      join(tempRoot, ".env"),
      "MIA_DATA_DIR=/tmp/mia-test-data\nLLM_PROVIDER=copilot-chat\nMSSQL_HOST=db.example\n",
    )
    process.env.MIA_DATA_DIR = "/tmp/mia-test-data"
    process.env.LLM_PROVIDER = "copilot-chat"
    process.env.MSSQL_HOST = "db.example"

    const report = runSetupChecks(makeLayout(tempRoot))
    expect(report.checks.find((c) => c.id === "published-sync-definitions")?.severity).toBe("warn")
  })
})

describe("mergeEnvFile", () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mia-merge-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it("does not wipe existing secrets with empty updates", () => {
    const envPath = join(tempRoot, ".env")
    writeFileSync(envPath, "DATABRICKS_HOST=https://old\nDATABRICKS_CLIENT_SECRET=keep-me\n")
    mergeEnvFile(envPath, { DATABRICKS_HOST: "", DATABRICKS_CLIENT_SECRET: "" })
    expect(parseEnvFile(envPath).get("DATABRICKS_CLIENT_SECRET")).toBe("keep-me")
    expect(parseEnvFile(envPath).get("DATABRICKS_HOST")).toBe("https://old")
  })

  it("updates only provided non-empty keys", () => {
    const envPath = join(tempRoot, ".env")
    writeFileSync(envPath, "MIA_DATA_DIR=/old\nLLM_PROVIDER=copilot-chat\n")
    mergeEnvFile(envPath, { MIA_DATA_DIR: "/new" })
    const file = parseEnvFile(envPath)
    expect(file.get("MIA_DATA_DIR")).toBe("/new")
    expect(file.get("LLM_PROVIDER")).toBe("copilot-chat")
  })
})

describe("setup gate", () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it("skips when MIA_SKIP_SETUP is set", async () => {
    process.env = { ...originalEnv, MIA_SKIP_SETUP: "1" }
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit)
    const { ensureSetupReady } = await import("../src/cli/setup/gate.js")
    ensureSetupReady()
    expect(exit).not.toHaveBeenCalled()
  })
})
