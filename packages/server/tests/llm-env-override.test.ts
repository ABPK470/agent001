import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyLlmEnvOverride } from "../src/infra/llm/env-override.js"

let db: Database.Database
const envBackup = { ...process.env }

function readRow(): { provider: string; model: string } {
  return db.prepare("SELECT provider, model FROM llm_config WHERE id = 1").get() as {
    provider: string
    model: string
  }
}

beforeEach(() => {
  db = new Database(":memory:")
  db.exec(`
    CREATE TABLE llm_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO llm_config (id, provider, model, api_key, base_url, updated_at)
    VALUES (1, 'databricks', 'databricks-gpt-5-4', '', '', datetime('now'));
  `)
  delete process.env["MIA_SKIP_SETUP"]
  delete process.env["LLM_MODEL"]
})

afterEach(() => {
  process.env = { ...envBackup }
  db.close()
})

describe("applyLlmEnvOverride", () => {
  it("throws when LLM_PROVIDER is unset on normal boot", () => {
    delete process.env["LLM_PROVIDER"]
    expect(() => applyLlmEnvOverride(db)).toThrow(/LLM_PROVIDER is not set/)
    expect(readRow().provider).toBe("databricks")
  })

  it("skips when MIA_SKIP_SETUP is set (tests)", () => {
    delete process.env["LLM_PROVIDER"]
    process.env["MIA_SKIP_SETUP"] = "1"
    expect(applyLlmEnvOverride(db)).toBe(false)
    expect(readRow().provider).toBe("databricks")
  })

  it("overwrites llm_config from .env when LLM_PROVIDER is set", () => {
    process.env["LLM_PROVIDER"] = "copilot-chat"
    process.env["LLM_MODEL"] = "gpt-5.4"

    expect(applyLlmEnvOverride(db)).toBe(true)

    const row = readRow()
    expect(row.provider).toBe("copilot-chat")
    expect(row.model).toBe("gpt-5.4")
  })

  it("uses databricks default when LLM_MODEL is unset", () => {
    process.env["LLM_PROVIDER"] = "databricks"

    expect(applyLlmEnvOverride(db)).toBe(true)
    expect(readRow().model).toBe("databricks-gpt-5-4")
  })

  it("uses LLM_MODEL as-is for databricks", () => {
    process.env["LLM_PROVIDER"] = "databricks"
    process.env["LLM_MODEL"] = "corp-gpt-endpoint"

    expect(applyLlmEnvOverride(db)).toBe(true)
    expect(readRow().model).toBe("corp-gpt-endpoint")
  })

  it("throws on invalid LLM_PROVIDER", () => {
    process.env["LLM_PROVIDER"] = "openai"
    expect(() => applyLlmEnvOverride(db)).toThrow(/Invalid LLM_PROVIDER/)
  })
})
