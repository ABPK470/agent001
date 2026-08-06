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
    expect(readSpecKindFor("oracle")).toBe("sql")
    expect(readSpecKindFor("hive")).toBe("sql")
    expect(readSpecKindFor("databricks")).toBe("sql")
    expect(writeSpecKindFor("mssql")).toBe("sql")
    expect(writeSpecKindFor("oracle")).toBe("sql")
    expect(writeSpecKindFor("databricks")).toBe("sql")
  })
  it("maps webhdfs and object stores", () => {
    expect(readSpecKindFor("webhdfs")).toBe("webhdfs")
    expect(writeSpecKindFor("webhdfs")).toBe("webhdfs")
    expect(readSpecKindFor("aws")).toBe("aws")
    expect(writeSpecKindFor("aws")).toBe("aws")
    expect(readSpecKindFor("azure")).toBe("azure")
    expect(readSpecKindFor("ftp")).toBe("ftp")
  })
  it("hive has no movement port until thrift binding lands", () => {
    expect(readSpecKindFor("hive")).toBe("sql")
    expect(writeSpecKindFor("hive")).toBe("sql")
  })
})

describe("emptyReadSpec / emptyWriteSpec", () => {
  it("seeds sensible defaults per kind", () => {
    expect(emptyReadSpec("mssql")).toEqual({ sql: "" })
    expect(emptyReadSpec("webhdfs")).toEqual({ path: "/", format: "csv" })
    expect(emptyReadSpec("aws")).toEqual({ path: "/", format: "csv" })
    expect(emptyWriteSpec("mssql")).toEqual({
      table: "",
      mode: "append",
      batchSize: "",
      allowIdentityInsert: false,
      relaxConstraints: false,
    })
    expect(emptyWriteSpec("webhdfs")).toEqual({ path: "/", format: "csv", mode: "replace" })
  })
})

describe("buildReadSpec", () => {
  it("builds a sql read spec", () => {
    expect(buildReadSpec("postgres", { sql: "SELECT 1" })).toEqual({ kind: "sql", sql: "SELECT 1" })
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
  it("treats truthy power-up bags as opted in", () => {
    const spec = buildWriteSpec("mssql", {
      table: "t",
      mode: "append",
      allowIdentityInsert: 1,
      relaxConstraints: "yes",
    }) as unknown as Record<string, unknown>
    expect(spec["allowIdentityInsert"]).toBe(true)
    expect(spec["relaxConstraints"]).toBe(true)
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
