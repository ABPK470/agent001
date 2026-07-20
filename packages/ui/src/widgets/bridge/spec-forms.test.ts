import { describe, expect, it } from "vitest"
import {
  buildReadSpec,
  buildWriteSpec,
  emptyReadSpec,
  emptyWriteSpec,
  parseJsonOpt,
  readSpecKindFor,
  writeSpecKindFor,
} from "./spec-forms"

describe("readSpecKindFor / writeSpecKindFor", () => {
  it("maps SQL kinds to the sql spec", () => {
    expect(readSpecKindFor("mssql")).toBe("sql")
    expect(readSpecKindFor("postgres")).toBe("sql")
    expect(readSpecKindFor("hive")).toBe("sql")
    expect(readSpecKindFor("databricks")).toBe("sql")
    expect(writeSpecKindFor("mssql")).toBe("sql")
    expect(writeSpecKindFor("databricks")).toBe("sql")
  })
  it("maps httpApi / webhdfs / denodo / object stores / aqueduct", () => {
    expect(readSpecKindFor("httpApi")).toBe("httpApi")
    expect(writeSpecKindFor("httpApi")).toBe("httpApi")
    expect(readSpecKindFor("webhdfs")).toBe("webhdfs")
    expect(writeSpecKindFor("webhdfs")).toBe("webhdfs")
    expect(readSpecKindFor("denodo")).toBe("denodo")
    expect(readSpecKindFor("aws")).toBe("aws")
    expect(writeSpecKindFor("aws")).toBe("aws")
    expect(readSpecKindFor("azure")).toBe("azure")
    expect(readSpecKindFor("ftp")).toBe("ftp")
    expect(readSpecKindFor("aqueduct")).toBe("aqueduct")
  })
  it("denodo and aqueduct have no write path", () => {
    expect(writeSpecKindFor("denodo")).toBeNull()
    expect(writeSpecKindFor("aqueduct")).toBeNull()
  })
  it("hive has no movement port until thrift binding lands", () => {
    expect(readSpecKindFor("hive")).toBe("sql")
    expect(writeSpecKindFor("hive")).toBe("sql")
  })
})

describe("emptyReadSpec / emptyWriteSpec", () => {
  it("seeds sensible defaults per kind", () => {
    expect(emptyReadSpec("mssql")).toEqual({ sql: "" })
    expect(emptyReadSpec("httpApi")).toEqual({ method: "GET", path: "/", jsonPath: "" })
    expect(emptyReadSpec("webhdfs")).toEqual({ path: "/", format: "csv" })
    expect(emptyReadSpec("aws")).toEqual({ path: "/", format: "csv" })
    expect(emptyReadSpec("aqueduct")).toEqual({ params: "" })
    expect(emptyReadSpec("denodo")).toEqual({ view: "", params: "" })
    expect(emptyWriteSpec("mssql")).toEqual({
      table: "",
      mode: "append",
      batchSize: "",
      allowIdentityInsert: false,
      relaxConstraints: false,
    })
    expect(emptyWriteSpec("webhdfs")).toEqual({ path: "/", format: "csv", mode: "replace" })
    expect(emptyWriteSpec("denodo")).toEqual({})
  })
})

describe("buildReadSpec", () => {
  it("builds a sql read spec", () => {
    expect(buildReadSpec("postgres", { sql: "SELECT 1" })).toEqual({ kind: "sql", sql: "SELECT 1" })
  })
  it("builds an httpApi read spec, parsing optional JSON fields", () => {
    const spec = buildReadSpec("httpApi", {
      method: "POST",
      path: "/items",
      jsonPath: "data.items",
      body: '{"filter":"x"}',
      headers: '{"X-Tenant":"acme"}',
    }) as { kind: string; method: string; path: string; jsonPath: string; body?: unknown; headers?: unknown }
    expect(spec.kind).toBe("httpApi")
    expect(spec.method).toBe("POST")
    expect(spec.jsonPath).toBe("data.items")
    expect(spec.body).toEqual({ filter: "x" })
    expect(spec.headers).toEqual({ "X-Tenant": "acme" })
  })
  it("omits empty optional JSON fields", () => {
    const spec = buildReadSpec("httpApi", { method: "GET", path: "/x", jsonPath: "", body: "", headers: "" }) as unknown as Record<string, unknown>
    expect(spec["body"]).toBeUndefined()
    expect(spec["headers"]).toBeUndefined()
    expect(spec["jsonPath"]).toBeUndefined()
  })
  it("builds object-store read specs", () => {
    expect(buildReadSpec("aws", { path: "a.csv", format: "json" })).toEqual({ kind: "aws", path: "a.csv", format: "json" })
    expect(buildWriteSpec("ftp", { path: "/o.csv", format: "csv", mode: "append" })).toEqual({
      kind: "ftp",
      path: "/o.csv",
      format: "csv",
      mode: "append",
    })
  })
  it("builds an aqueduct read spec with params", () => {
    const spec = buildReadSpec("aqueduct", { params: '{"limit":"10"}' }) as { kind: string; params?: Record<string, string> }
    expect(spec.kind).toBe("aqueduct")
    expect(spec.params).toEqual({ limit: "10" })
  })
  it("builds a denodo read spec with params", () => {
    const spec = buildReadSpec("denodo", { view: "db/v", params: '{"limit":"10"}' }) as { kind: string; view: string; params?: Record<string, string> }
    expect(spec.kind).toBe("denodo")
    expect(spec.view).toBe("db/v")
    expect(spec.params).toEqual({ limit: "10" })
  })
})

describe("buildWriteSpec", () => {
  it("builds a sql write spec with optional batch size", () => {
    expect(buildWriteSpec("mssql", { table: "t", mode: "replace", batchSize: "500" })).toEqual({
      kind: "sql",
      table: "t",
      mode: "replace",
      batchSize: 500,
    })
  })
  it("omits batch size when empty", () => {
    const spec = buildWriteSpec("mssql", { table: "t", mode: "append", batchSize: "" }) as unknown as Record<string, unknown>
    expect(spec["batchSize"]).toBeUndefined()
  })
  it("includes mssql/postgres power-ups only when opted in", () => {
    expect(
      buildWriteSpec("mssql", {
        table: "t",
        mode: "append",
        allowIdentityInsert: true,
        relaxConstraints: true,
      }),
    ).toEqual({
      kind: "sql",
      table: "t",
      mode: "append",
      allowIdentityInsert: true,
      relaxConstraints: true,
    })
    const plain = buildWriteSpec("postgres", {
      table: "t",
      mode: "append",
      allowIdentityInsert: false,
      relaxConstraints: false,
    }) as unknown as Record<string, unknown>
    expect(plain["allowIdentityInsert"]).toBeUndefined()
    expect(plain["relaxConstraints"]).toBeUndefined()
  })
  it("builds an httpApi write spec", () => {
    const spec = buildWriteSpec("httpApi", { method: "PUT", path: "/up", body: '{"source":"etl"}' }) as unknown as Record<string, unknown>
    expect(spec["kind"]).toBe("httpApi")
    expect(spec["method"]).toBe("PUT")
    expect(spec["body"]).toEqual({ source: "etl" })
  })
  it("builds a webhdfs write spec", () => {
    expect(buildWriteSpec("webhdfs", { path: "/o.csv", format: "csv", mode: "append" })).toEqual({
      kind: "webhdfs",
      path: "/o.csv",
      format: "csv",
      mode: "append",
    })
  })
  it("builds parquet read/write specs for object stores", () => {
    expect(buildReadSpec("aws", { path: "/data/x.parquet", format: "parquet" })).toEqual({
      kind: "aws",
      path: "/data/x.parquet",
      format: "parquet",
    })
    expect(buildWriteSpec("webhdfs", { path: "/out.parquet", format: "parquet", mode: "replace" })).toEqual({
      kind: "webhdfs",
      path: "/out.parquet",
      format: "parquet",
      mode: "replace",
    })
  })
})

describe("parseJsonOpt", () => {
  it("returns undefined for empty text", () => {
    expect(parseJsonOpt("")).toEqual({ value: undefined })
    expect(parseJsonOpt("   ")).toEqual({ value: undefined })
  })
  it("parses valid JSON", () => {
    expect(parseJsonOpt('{"a":1}')).toEqual({ value: { a: 1 } })
  })
  it("returns an error for invalid JSON", () => {
    const res = parseJsonOpt("{not json")
    expect("error" in res).toBe(true)
  })
})
