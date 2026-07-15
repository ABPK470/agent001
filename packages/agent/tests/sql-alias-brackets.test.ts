import { describe, expect, it } from "vitest"
import {
  detectAliasBracketViolations,
  normalizeMssqlAliasBrackets,
  prepareMssqlQueryAliases,
  validateAliasBracketConvention
} from "../src/tools/mssql/sql-alias-brackets.js"

describe("normalizeMssqlAliasBrackets", () => {
  it("rewrites dim.Officer off → AS [off] and brackets column refs", () => {
    const input = [
      "SELECT off.OfficerName, off.pkOfficer",
      "FROM dim.Officer off",
      "WHERE off.pkOfficer = 1"
    ].join("\n")
    const { query, changed, aliases } = normalizeMssqlAliasBrackets(input)
    expect(changed).toBe(true)
    expect(aliases).toContain("off")
    expect(query).toMatch(/FROM dim\.Officer AS \[off\]/i)
    expect(query).toContain("[off].[OfficerName]")
    expect(query).toContain("[off].[pkOfficer]")
    expect(query).not.toMatch(/\boff\./i)
  })

  it("rewrites AS off to AS [off]", () => {
    const input = "SELECT off.FullName FROM dim.Officer AS off"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toBe("SELECT [off].[FullName] FROM dim.Officer AS [off]")
  })

  it("leaves already-bracketed aliases unchanged", () => {
    const input = "SELECT [o].[OfficerName] FROM dim.Officer AS [o]"
    const { query, changed } = normalizeMssqlAliasBrackets(input)
    expect(changed).toBe(false)
    expect(query).toBe(input)
  })

  it("brackets short aliases like r on publish.Revenue", () => {
    const input = "SELECT r.pkClient FROM publish.Revenue r WHERE r.pkMonth = 202501"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("FROM publish.Revenue AS [r]")
    expect(query).toContain("[r].[pkClient]")
    expect(query).toContain("[r].[pkMonth]")
  })

  it("is idempotent", () => {
    const input = "SELECT off.FullName FROM dim.Officer off"
    const once = normalizeMssqlAliasBrackets(input).query
    const twice = normalizeMssqlAliasBrackets(once)
    expect(twice.changed).toBe(false)
    expect(twice.query).toBe(once)
  })

  it("does not rewrite inside string literals", () => {
    const input = "SELECT 'off.FullName' AS x FROM dim.Officer AS [off]"
    const { query, changed } = normalizeMssqlAliasBrackets(input)
    expect(changed).toBe(false)
    expect(query).toContain("'off.FullName'")
  })

  it("brackets alias refs in ON, WHERE, GROUP BY, ORDER BY", () => {
    const input = [
      "SELECT off.FullName, r.Amount",
      "FROM dim.Officer off",
      "INNER JOIN publish.Revenue r ON r.pkOfficer = off.pkOfficer",
      "WHERE off.pkOfficer > 0",
      "GROUP BY off.Region",
      "ORDER BY off.Region"
    ].join("\n")
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("ON [r].[pkOfficer] = [off].[pkOfficer]")
    expect(query).toContain("WHERE [off].[pkOfficer] > 0")
    expect(query).toContain("GROUP BY [off].[Region]")
    expect(query).toContain("ORDER BY [off].[Region]")
    expect(query).not.toMatch(/\boff\./i)
    expect(query).not.toMatch(/\br\./i)
  })

  it("brackets comma-joined table aliases", () => {
    const input =
      "SELECT off.x, r.y FROM dim.Officer off, publish.Revenue r WHERE off.id = r.id"
    const { query, aliases } = normalizeMssqlAliasBrackets(input)
    expect(aliases).toEqual(expect.arrayContaining(["off", "r"]))
    expect(query).toContain("FROM dim.Officer AS [off], publish.Revenue AS [r]")
    expect(query).toContain("WHERE [off].[id] = [r].[id]")
  })

  it("brackets subquery table aliases", () => {
    const input = "SELECT sq.x FROM (SELECT pkOfficer AS x FROM dim.Officer) sq"
    const { query, aliases } = normalizeMssqlAliasBrackets(input)
    expect(aliases).toContain("sq")
    expect(query).toContain(") AS [sq]")
    expect(query).toContain("[sq].[x]")
  })

  it("brackets UPDATE target alias refs", () => {
    const input = "UPDATE o SET o.Name = 'x' FROM dim.Officer o WHERE o.pk = 1"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("UPDATE [o] SET [o].[Name]")
    expect(query).toContain("FROM dim.Officer AS [o] WHERE [o].[pk] = 1")
  })

  it("brackets refs inside CASE expressions", () => {
    const input =
      "SELECT CASE WHEN off.Region = 'X' THEN off.FullName ELSE off.ShortName END FROM dim.Officer off"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("WHEN [off].[Region]")
    expect(query).toContain("THEN [off].[FullName]")
    expect(query).toContain("ELSE [off].[ShortName]")
  })

  it("brackets CTE names in WITH, SELECT, and FROM", () => {
    const input =
      "WITH off AS (SELECT pkOfficer, FullName FROM dim.Officer) SELECT off.FullName FROM off"
    const { query, aliases } = normalizeMssqlAliasBrackets(input)
    expect(aliases).toContain("off")
    expect(query).toMatch(/WITH \[off\] AS/i)
    expect(query).toContain("SELECT [off].[FullName] FROM [off]")
  })

  it("brackets multiple CTEs and JOIN between them", () => {
    const input =
      "WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT a.x, b.y FROM a JOIN b ON a.x = b.y"
    const { query, aliases } = normalizeMssqlAliasBrackets(input)
    expect(aliases).toEqual(expect.arrayContaining(["a", "b"]))
    expect(query).toMatch(/WITH \[a\] AS/i)
    expect(query).toMatch(/,\s*\[b\] AS/i)
    expect(query).toContain("SELECT [a].[x], [b].[y] FROM [a] JOIN [b] ON [a].[x] = [b].[y]")
  })

  it("brackets outer CTE refs while fixing inner table aliases", () => {
    const input =
      "WITH cte AS (SELECT off.FullName FROM dim.Officer off) SELECT cte.FullName FROM cte"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("WITH [cte] AS")
    expect(query).toContain("SELECT [cte].[FullName] FROM [cte]")
    expect(query).toContain("dim.Officer AS [off]")
    expect(query).toContain("[off].[FullName]")
  })
})

describe("validateAliasBracketConvention", () => {
  it("returns null for normalized SQL", () => {
    const { query } = normalizeMssqlAliasBrackets("SELECT off.x FROM dim.Officer off")
    expect(validateAliasBracketConvention(query)).toBeNull()
  })
})

describe("prepareMssqlQueryAliases", () => {
  it("auto-fixes and returns no error for off alias", () => {
    const prep = prepareMssqlQueryAliases("SELECT off.FullName FROM dim.Officer off")
    expect(prep.error).toBeNull()
    expect(prep.changed).toBe(true)
    expect(prep.query).toContain("AS [off]")
  })
})

describe("detectAliasBracketViolations", () => {
  it("flags bare off before normalization", () => {
    const v = detectAliasBracketViolations("SELECT off.FullName FROM dim.Officer off")
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((x) => x.text.includes("off"))).toBe(true)
  })
})
