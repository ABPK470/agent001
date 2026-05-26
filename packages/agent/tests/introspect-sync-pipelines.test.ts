/**
 * Unit tests for scripts/introspect-sync-pipelines.mjs
 *
 * Tests every pure function using real-life sproc fragments captured from the
 * live ABI UAT database.  Each pipeline (contract, dataset, rule, pipelineActivity,
 * gateMetadata, content) has dedicated test cases covering:
 *   - extractSyncObjectCalls: parsing EXEC core.uspSyncObjectTran call sites
 *   - extractVariableDerivations: STUFF/COALESCE/CTE/sp_executesql patterns
 *   - parseSingleDerivationBlock: CAST/CONVERT column extraction
 *   - resolveIdsPredicate: end-to-end predicate generation
 *   - normalizePredicate: paren-balancing, whitespace, alias stripping
 *   - fkClosure: FK graph traversal
 *   - qtable: bracket-quoting
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
    detectSelfJoinColumn,
    extractSyncObjectCalls,
    extractVariableDerivations,
    fkClosure,
    normalizePredicate,
    parseSingleDerivationBlock,
    qtable,
    resolveDerivationToSubquery,
    resolveIdsPredicate,
    resolveSinglePart,
} from "../../../scripts/introspect-sync-pipelines.mjs"

// ═══════════════════════════════════════════════════════════════════
//  qtable
// ═══════════════════════════════════════════════════════════════════
describe("qtable", () => {
  it("bracket-quotes a simple schema.table", () => {
    expect(qtable("core.Contract")).toBe("[core].[Contract]")
  })
  it("bracket-quotes a single identifier", () => {
    expect(qtable("Contract")).toBe("[Contract]")
  })
  it("handles gate schema", () => {
    expect(qtable("gate.MetaTable")).toBe("[gate].[MetaTable]")
  })
})

// ═══════════════════════════════════════════════════════════════════
//  normalizePredicate
// ═══════════════════════════════════════════════════════════════════
describe("normalizePredicate", () => {
  it("collapses whitespace", () => {
    expect(normalizePredicate("x  IN  (  SELECT y )")).toBe("x IN ( SELECT y )")
  })
  it("strips ) AS alias", () => {
    expect(normalizePredicate("x IN (SELECT y FROM t) AS sub")).toBe("x IN (SELECT y FROM t)")
  })
  it("balances missing closing paren", () => {
    expect(normalizePredicate("x IN (SELECT y FROM (t WHERE z = 1)")).toBe(
      "x IN (SELECT y FROM (t WHERE z = 1))"
    )
  })
  it("strips excess trailing close parens", () => {
    expect(normalizePredicate("x IN (SELECT y FROM t))")).toBe("x IN (SELECT y FROM t)")
  })
  it("leaves balanced parens alone", () => {
    const pred = "ruleId IN (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})"
    expect(normalizePredicate(pred)).toBe(pred)
  })
  it("handles deep nesting with correct balance", () => {
    const pred = "a IN (SELECT b FROM t WHERE c IN (SELECT d FROM u WHERE e IN (SELECT f FROM v)))"
    expect(normalizePredicate(pred)).toBe(pred)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  extractSyncObjectCalls — real sproc fragments
// ═══════════════════════════════════════════════════════════════════
describe("extractSyncObjectCalls", () => {
  // ── Pipeline 798: pipelineActivity (simplest — 2 calls) ──────
  it("pipeline 798: extracts 2 calls from uspSyncPipelineObjectsTran", () => {
    // Real fragment from core.uspSyncPipelineObjectsTran (after '''' → ' normalisation)
    const body = `
      SET @sql = 'EXEC core.uspSyncObjectTran
        @idName = 'pipelineId'
        ,@ids = '' + CONVERT(VARCHAR(100), @pipelineId) + ''
        ,@idsUnsync = '' + ISNULL(@deletedPipelineIds,'-') + ''
        ,@name = 'Activity'
        ,@schema = 'core'
        ,@srcServer = '' +@srcServer+'''

      SET @sql2 = 'EXEC core.uspSyncObjectTran
        @idName = 'pipelineId'
        ,@ids = '' + CONVERT(VARCHAR(100), @pipelineId) + ''
        ,@idsUnsync = '' + ISNULL(@deletedPipelineIds,'-') + ''
        ,@name = 'Pipeline'
        ,@schema = 'core'
        ,@srcServer = '' +@srcServer+'''
    `
    const calls = extractSyncObjectCalls(body)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ idName: "pipelineId", idsVar: "pipelineId", name: "Activity", schema: "core", qualified: "core.Activity" })
    expect(calls[1]).toMatchObject({ idName: "pipelineId", idsVar: "pipelineId", name: "Pipeline", schema: "core", qualified: "core.Pipeline" })
  })

  // ── Pipeline 692: content (4 calls) ──────────────────────────
  it("pipeline 692: extracts all 4 content calls", () => {
    const body = `
      EXEC core.uspSyncObjectTran
        @idName = 'contentId'
        ,@ids = '' + CONVERT(VARCHAR(MAX), @contentId) + ''
        ,@name = 'Content'
        ,@schema = 'gate'

      EXEC core.uspSyncObjectTran
        @idName = 'contentId'
        ,@ids = '' + CONVERT(VARCHAR(MAX), @contentId) + ''
        ,@name = 'ContentLink'
        ,@schema = 'gate'

      EXEC core.uspSyncObjectTran
        @idName = 'contentTypeId'
        ,@ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@contentTypeIds,0)) + ''
        ,@name = 'ContentType'
        ,@schema = 'gate'

      EXEC core.uspSyncObjectTran
        @idName = 'contentLinkTypeId'
        ,@ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@contentLinkTypeIds,0)) + ''
        ,@name = 'ContentLinkType'
        ,@schema = 'gate'
    `
    const calls = extractSyncObjectCalls(body)
    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({ idName: "contentId", idsVar: "contentId", qualified: "gate.Content" })
    expect(calls[1]).toMatchObject({ idName: "contentId", idsVar: "contentId", qualified: "gate.ContentLink" })
    expect(calls[2]).toMatchObject({ idName: "contentTypeId", idsVar: "contentTypeIds", qualified: "gate.ContentType" })
    expect(calls[3]).toMatchObject({ idName: "contentLinkTypeId", idsVar: "contentLinkTypeIds", qualified: "gate.ContentLinkType" })
  })

  // ── Pipeline 780: gateMetadata (4 calls, mixed schemas) ─────
  it("pipeline 780: extracts gate.jsonSchema call with correct idsVar", () => {
    const body = `
      EXEC core.uspSyncObjectTran
        @idName = 'jsonSchemaId'
        ,@ids = '' +CONVERT(VARCHAR(1000),ISNULL(@jsonSchemaIds,0)) + ''
        ,@name = 'jsonSchema'
        ,@schema = 'gate'
    `
    const calls = extractSyncObjectCalls(body)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ idName: "jsonSchemaId", idsVar: "jsonSchemaIds", qualified: "gate.jsonSchema" })
  })

  // ── Pipeline 788: contract (9 calls) ────────────────────────
  it("pipeline 788: extracts CONVERT-wrapped @ids correctly", () => {
    const body = `
      EXEC core.uspSyncObjectTran
        @idName = 'datasetId_Left'
        ,@ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + ''
        ,@name = 'DatasetMapping'
        ,@schema = 'core'
    `
    const calls = extractSyncObjectCalls(body)
    expect(calls[0]).toMatchObject({ idName: "datasetId_Left", idsVar: "datasetIds", qualified: "core.DatasetMapping" })
  })

  it("returns empty for null body", () => {
    expect(extractSyncObjectCalls(null)).toEqual([])
  })

  it("returns empty for body with no EXEC calls", () => {
    expect(extractSyncObjectCalls("CREATE PROCEDURE dbo.doNothing AS SELECT 1")).toEqual([])
  })

  it("skips calls missing @name or @schema", () => {
    const body = `EXEC core.uspSyncObjectTran @idName = 'foo', @ids = '' + @bar + ''`
    expect(extractSyncObjectCalls(body)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
//  parseSingleDerivationBlock
// ═══════════════════════════════════════════════════════════════════
describe("parseSingleDerivationBlock", () => {
  it("parses CONVERT(type, col) FROM table WHERE cond", () => {
    const block = `SELECT N', ' + CONVERT(NVARCHAR(MAX), datasetId) FROM core.Dataset WHERE contractId = @contractId`
    const d = parseSingleDerivationBlock(block)
    expect(d).toMatchObject({
      column: "datasetId",
      fromTable: "core.Dataset",
      whereClause: "contractId = @contractId",
      isUdf: false,
    })
  })

  it("parses CAST(col AS type) FROM table WHERE cond", () => {
    const block = `SELECT ',' + CAST(ruleId AS VARCHAR(MAX)) FROM core.Rule WHERE ruleId = @ruleId`
    const d = parseSingleDerivationBlock(block)
    expect(d).toMatchObject({ column: "ruleId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId" })
  })

  it("parses UDF form: FROM schema.func(@param)", () => {
    const block = `SELECT ',' + CAST(ruleId AS VARCHAR(MAX)) FROM core.fDeletedRulesTree(@ruleId)`
    const d = parseSingleDerivationBlock(block)
    expect(d).toMatchObject({ column: "ruleId", fromTable: "core.fDeletedRulesTree", isUdf: true, udfParam: "ruleId" })
  })

  it("parses FROM table alias with dotted column", () => {
    const block = `SELECT N', ' + CONVERT(NVARCHAR(MAX), r.inputDatasetId) FROM core.Rule r WHERE r.ruleId IN (@rulesIds)`
    const d = parseSingleDerivationBlock(block)
    expect(d).toMatchObject({ column: "inputDatasetId", fromTable: "core.Rule", isUdf: false })
    expect(d!.whereClause).toMatch(/ruleId IN \(@rulesIds\)/)
  })

  it("parses FROM-only (no WHERE)", () => {
    const block = `SELECT N', ' + CONVERT(NVARCHAR(MAX), viewId) FROM gate.MetaView`
    const d = parseSingleDerivationBlock(block)
    expect(d).toMatchObject({ column: "viewId", fromTable: "gate.MetaView", whereClause: null })
  })

  it("returns null when no CAST/CONVERT found", () => {
    expect(parseSingleDerivationBlock("SELECT col FROM t WHERE x = 1")).toBeNull()
  })

  it("strips CONVERT/ISNULL wrappers from WHERE clause", () => {
    const block = `SELECT N', ' + CONVERT(NVARCHAR(MAX), pipelineId) FROM core.Pipeline WHERE datasetId IN ( CONVERT(VARCHAR(MAX), @datasetIds) )`
    const d = parseSingleDerivationBlock(block)
    expect(d!.whereClause).toBe("datasetId IN ( @datasetIds )")
  })

  it("handles STUFF(COALESCE(...)) in WHERE clause", () => {
    const block = `SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), t.datasetMappingId) FROM (
      SELECT datasetMappingId FROM core.DatasetMapping
      WHERE datasetId_Left IN (STUFF(COALESCE(', ' + @datasetIds,'') + COALESCE(', '+@deletedDatasetIds,''),1,1,''))
    ) AS t`
    const d = parseSingleDerivationBlock(block)
    // STUFF/COALESCE should be replaced with @datasetIds (deletedDatasetIds filtered out)
    expect(d!.whereClause).toMatch(/@datasetIds/)
    expect(d!.whereClause).not.toMatch(/STUFF/)
    expect(d!.whereClause).not.toMatch(/COALESCE/)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  extractVariableDerivations — real sproc patterns
// ═══════════════════════════════════════════════════════════════════
describe("extractVariableDerivations", () => {
  // ── Pipeline 788 (contract): standard SELECT @x = STUFF pattern ──
  it("pipeline 788: extracts @datasetIds from contract sproc", () => {
    const body = `
      SELECT @datasetIds = STUFF(
        (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), datasetId)
         FROM core.Dataset
         WHERE contractId = @contractId
         FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')
    `
    const derivations = extractVariableDerivations(body)
    expect(derivations.has("datasetids")).toBe(true)
    const d = derivations.get("datasetids")
    expect(d).toMatchObject({ column: "datasetId", fromTable: "core.Dataset", whereClause: expect.stringContaining("contractId = @contractId") })
  })

  // ── Pipeline 791 (rule): CTE + STUFF ──
  it("pipeline 791: resolves CTE reference to base table", () => {
    const body = `
      ;WITH cte (ruleId) AS (
        SELECT ruleId FROM core.Rule WHERE ruleId = @ruleId
        UNION ALL
        SELECT r.ruleId FROM core.Rule r INNER JOIN cte c ON r.parentRuleId = c.ruleId
      )
      SELECT @rulesIds = STUFF(
        (SELECT ',' + CAST(ruleId AS VARCHAR(MAX))
         FROM cte
         FOR XML PATH('')),1,1,'')
    `
    const derivations = extractVariableDerivations(body)
    expect(derivations.has("rulesids")).toBe(true)
    const d = derivations.get("rulesids")
    // CTE 'cte' → resolved to core.Rule WHERE ruleId = @ruleId
    expect(d).toMatchObject({ column: "ruleId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId" })
  })

  // ── Pipeline 791 (rule): UNION derivation ──
  it("pipeline 791: extracts UNION derivation (input + output datasetIds)", () => {
    const body = `
      SELECT @ruleInputDatasetIds = STUFF(
        (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.inputDatasetId)
         FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
         FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

      SELECT @ruleOutputDatasetIds = STUFF(
        (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.outputDatasetId)
         FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
         FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

      SET @ruleDatasetIds = COALESCE(@ruleOutputDatasetIds + ', ','') + @ruleInputDatasetIds
    `
    const derivations = extractVariableDerivations(body)
    expect(derivations.has("ruleinputdatasetids")).toBe(true)
    expect(derivations.has("ruleoutputdatasetids")).toBe(true)
    expect(derivations.has("ruledatasetids")).toBe(true)

    // COALESCE concatenation → UNION of the two parts
    const union = derivations.get("ruledatasetids")
    expect(union).toHaveProperty("parts")
    expect(union.parts).toHaveLength(2)
    expect(union.parts[0]).toMatchObject({ column: "outputDatasetId", fromTable: "core.Rule" })
    expect(union.parts[1]).toMatchObject({ column: "inputDatasetId", fromTable: "core.Rule" })
  })

  // ── Pipeline 780 (gateMetadata): sp_executesql alias chain ──
  it("pipeline 780: sp_executesql creates alias from @jsonSchemaIds to inner var", () => {
    const body = `
      SET @sqlMetaViewIds =
      'SELECT @metaViewIds = STUFF(
        (SELECT N'', '' + CONVERT(NVARCHAR(MAX),viewId)
         FROM gate.MetaView
         WHERE tableId IN ( ' + CONVERT(NVARCHAR(50), @tableId) + ')
         FOR XML PATH(''),TYPE).value(''text()[1]'',''NVARCHAR(MAX)''),1,2,N'')'

      EXEC sp_executesql @sqlMetaViewIds, N'@metaViewIds VARCHAR(MAX) out', @metaViewIds OUT

      SET @sqlJsonSchemaIds =
      'SELECT @contentJsonSchemaIds = STUFF(
        (SELECT N'', '' + CONVERT(NVARCHAR(MAX),jsonSchemaId)
         FROM gate.MetaColumn
         WHERE columnId IN ( '+ @metaColumnIds +')
         FOR XML PATH(''),TYPE).value(''text()[1]'',''NVARCHAR(MAX)''),1,2,N'')'

      EXEC sp_executesql @sqlJsonSchemaIds, N'@contentJsonSchemaIds VARCHAR(MAX) out', @jsonSchemaIds OUT
    `
    const derivations = extractVariableDerivations(body)
    // Inner STUFF variable @metaViewIds should be captured
    expect(derivations.has("metaviewids")).toBe(true)
    // Inner STUFF variable @contentJsonSchemaIds should be captured
    expect(derivations.has("contentjsonschemaids")).toBe(true)
    // sp_executesql should create alias: @jsonSchemaIds → @contentJsonSchemaIds
    expect(derivations.has("jsonschemaids")).toBe(true)
    const alias = derivations.get("jsonschemaids")
    expect(alias).toMatchObject({ alias: "contentjsonschemaids" })
  })

  // ── SET alias detection ──
  it("detects SET @x = @y alias", () => {
    const body = `SET @datasetIds = @allDatasetIds`
    const derivations = extractVariableDerivations(body)
    expect(derivations.get("datasetids")).toMatchObject({ alias: "alldatasetids" })
  })

  // ── Comment stripping ──
  it("ignores commented-out STUFF blocks", () => {
    const body = `
      --SELECT @deletedRuleIds = STUFF(
      --(SELECT ',' + CAST(ruleId AS VARCHAR(MAX)) FROM core.Rule FOR XML PATH('')),1,1,'')

      SELECT @ruleIds = STUFF(
        (SELECT ',' + CAST(ruleId AS VARCHAR(MAX))
         FROM core.Rule WHERE ruleId = @ruleId
         FOR XML PATH('')),1,1,'')
    `
    const derivations = extractVariableDerivations(body)
    expect(derivations.size).toBe(1)
    expect(derivations.has("ruleids")).toBe(true)
    expect(derivations.has("deletedruleids")).toBe(false)
  })

  // ── Empty/null body ──
  it("returns empty map for null body", () => {
    expect(extractVariableDerivations(null).size).toBe(0)
  })

  it("skips SET @sqlXxx = N'...' dynamic SQL assignments", () => {
    const body = `
      SET @sqlDeletedPipelineIds = N'
        SELECT @deletedPipelineIds = STUFF(
          (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), ap.pipelineId)
           FROM coreArchive.Pipeline AS ap
           FOR XML PATH ('''')),1,1,'''')'
    `
    const derivations = extractVariableDerivations(body)
    // Should capture the inner STUFF (@deletedPipelineIds) but NOT @sqlDeletedPipelineIds
    expect(derivations.has("sqldeletedpipelineids")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  resolveIdsPredicate — end-to-end per pipeline
// ═══════════════════════════════════════════════════════════════════
describe("resolveIdsPredicate", () => {
  // ── Case 1: @ids = @rootParam → direct equality ──
  it("direct equality: idName=contractId, idsVar=contractId, root=contractId", () => {
    const result = resolveIdsPredicate("contractId", "contractId", new Map(), "contractId", "contractId")
    expect(result).toBe("contractId = {id}")
  })

  // ── Case 1b: plural param convention ──
  it("plural convention: idsVar=datasetIds when rootKey=datasetId (no derivation)", () => {
    const result = resolveIdsPredicate("datasetId", "datasetIds", new Map(), "datasetId", "datasetId")
    expect(result).toBe("datasetId = {id}")
  })

  it("plural convention not used when derivation exists", () => {
    const derivations = new Map([
      ["datasetids", { column: "datasetId", fromTable: "core.Dataset", whereClause: "contractId = @contractId", isUdf: false, udfParam: null }]
    ])
    const result = resolveIdsPredicate("datasetId", "datasetIds", derivations, "contractId", "contractId")
    expect(result).toContain("SELECT datasetId FROM")
    expect(result).toContain("contractId = {id}")
  })

  // ── Case 2: alias chain ──
  it("alias chain: @idsVar → @alias → derivation", () => {
    const derivations = new Map([
      ["innervar", { column: "col", fromTable: "core.Tbl", whereClause: "k = @rootKey", isUdf: false, udfParam: null }],
      ["outervar", { alias: "innervar" }],
    ])
    const result = resolveIdsPredicate("col", "outerVar", derivations, "rootKey", "rootKey")
    expect(result).toContain("SELECT col FROM [core].[Tbl] WHERE k = {id}")
  })

  // ── Case 3: UNION derivation ──
  it("UNION: builds combined subquery", () => {
    const derivations = new Map([
      ["combinedids", {
        parts: [
          { column: "outputDatasetId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId", isUdf: false, udfParam: null },
          { column: "inputDatasetId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId", isUdf: false, udfParam: null },
        ]
      }],
    ])
    const result = resolveIdsPredicate("datasetId", "combinedIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("UNION")
    expect(result).toContain("outputDatasetId")
    expect(result).toContain("inputDatasetId")
    expect(result).toContain("{id}")
    // Parens must be balanced
    const opens = (result!.match(/\(/g) || []).length
    const closes = (result!.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  // ── Case 4: UDF derivation ──
  it("UDF: generates function call predicate", () => {
    const derivations = new Map([
      ["deletedruleids", { column: "ruleId", fromTable: "core.fDeletedRulesTree", isUdf: true, udfParam: "ruleId", whereClause: null }],
    ])
    const result = resolveIdsPredicate("ruleId", "deletedRuleIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("[core].[fDeletedRulesTree]")
    expect(result).toContain("{id}")
  })

  // ── null idsVar ──
  it("returns null when idsVar is null", () => {
    expect(resolveIdsPredicate("x", null, new Map(), "k", "k")).toBeNull()
  })

  // ── unresolvable ──
  it("returns null when idsVar has no derivation and is not root-related", () => {
    expect(resolveIdsPredicate("x", "unknownVar", new Map(), "rootKey", "rootKey")).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  resolveSinglePart + resolveDerivationToSubquery
// ═══════════════════════════════════════════════════════════════════
describe("resolveSinglePart", () => {
  it("resolves standard derivation with root param replacement", () => {
    const d = { column: "datasetId", fromTable: "core.Dataset", whereClause: "contractId = @contractId", isUdf: false, udfParam: null }
    const result = resolveSinglePart(d, "contractId", new Map())
    expect(result).toBe("SELECT datasetId FROM [core].[Dataset] WHERE contractId = {id}")
  })

  it("resolves plural root param (@datasetIds → {id})", () => {
    const d = { column: "pipelineId", fromTable: "core.Pipeline", whereClause: "datasetId IN ( @datasetIds )", isUdf: false, udfParam: null }
    const result = resolveSinglePart(d, "datasetId", new Map())
    expect(result).toBe("SELECT pipelineId FROM [core].[Pipeline] WHERE datasetId IN ( {id} )")
  })

  it("resolves UDF derivation", () => {
    const d = { column: "ruleId", fromTable: "core.fDeletedRulesTree", isUdf: true, udfParam: "ruleId", whereClause: null }
    const result = resolveSinglePart(d, "ruleId", new Map())
    expect(result).toBe("SELECT ruleId FROM [core].[fDeletedRulesTree]({id})")
  })

  it("resolves bare FROM (no WHERE)", () => {
    const d = { column: "viewId", fromTable: "gate.MetaView", whereClause: null, isUdf: false, udfParam: null }
    const result = resolveSinglePart(d, "tableId", new Map())
    expect(result).toBe("SELECT viewId FROM [gate].[MetaView]")
  })

  it("resolves nested @variable via derivation map", () => {
    const inner = { column: "ruleId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId", isUdf: false, udfParam: null }
    const derivations = new Map([["rulesids", inner]])
    const d = { column: "ruleConditionId", fromTable: "core.RuleCondition", whereClause: "ruleId IN (@rulesIds)", isUdf: false, udfParam: null }
    const result = resolveSinglePart(d, "ruleId", derivations)
    expect(result).toContain("ruleId IN ((SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})")
  })
})

describe("resolveDerivationToSubquery", () => {
  it("resolves alias chain", () => {
    const inner = { column: "x", fromTable: "t", whereClause: "k = @root", isUdf: false, udfParam: null }
    const derivations = new Map([
      ["inner", inner],
      ["outer", { alias: "inner" }],
    ])
    const result = resolveDerivationToSubquery(derivations.get("outer")!, "root", derivations)
    expect(result).toBe("SELECT x FROM [t] WHERE k = {id}")
  })

  it("resolves UNION parts", () => {
    const d = {
      parts: [
        { column: "a", fromTable: "s.T1", whereClause: "k = @root", isUdf: false, udfParam: null },
        { column: "b", fromTable: "s.T2", whereClause: "k = @root", isUdf: false, udfParam: null },
      ]
    }
    const result = resolveDerivationToSubquery(d, "root", new Map())
    expect(result).toContain("UNION")
    expect(result).toContain("SELECT a FROM [s].[T1]")
    expect(result).toContain("SELECT b FROM [s].[T2]")
  })
})

// ═══════════════════════════════════════════════════════════════════
//  fkClosure — FK graph traversal
// ═══════════════════════════════════════════════════════════════════
describe("fkClosure", () => {
  const edges = [
    { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "core", childTable: "Pipeline", childColumn: "contractId" },
    { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "core", childTable: "Dataset", childColumn: "contractId" },
    { parentSchema: "core", parentTable: "Pipeline", parentColumn: "pipelineId", childSchema: "core", childTable: "Step", childColumn: "pipelineId" },
    { parentSchema: "core", parentTable: "Pipeline", parentColumn: "pipelineId", childSchema: "core", childTable: "Activity", childColumn: "pipelineId" },
    { parentSchema: "core", parentTable: "Dataset", parentColumn: "datasetId", childSchema: "core", childTable: "DatasetColumn", childColumn: "datasetId" },
    // Multi-hop: DatasetColumn → RuleCondition → RuleConditionValue
    { parentSchema: "core", parentTable: "DatasetColumn", parentColumn: "datasetColumnId", childSchema: "core", childTable: "RuleCondition", childColumn: "inputDatasetColumnId" },
    { parentSchema: "core", parentTable: "RuleCondition", parentColumn: "ruleConditionId", childSchema: "core", childTable: "RuleConditionValue", childColumn: "ruleConditionId" },
    // Cross-schema: gate table referencing itself
    { parentSchema: "gate", parentTable: "MetaTable", parentColumn: "tableId", childSchema: "gate", childTable: "MetaView", childColumn: "tableId" },
    // Disallowed schema
    { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "dbo", childTable: "Audit", childColumn: "contractId" },
  ]

  it("finds root table with direct predicate", () => {
    const result = fkClosure("core.Contract", "contractId", edges)
    expect(result.get("core.Contract")).toMatchObject({ predicate: "contractId = {id}", source: "fk-only" })
  })

  it("finds direct children with FK column = rootKey", () => {
    const result = fkClosure("core.Contract", "contractId", edges)
    expect(result.get("core.Pipeline")).toMatchObject({ scopeColumn: "contractId", predicate: "contractId = {id}" })
    expect(result.get("core.Dataset")).toMatchObject({ scopeColumn: "contractId", predicate: "contractId = {id}" })
  })

  it("finds grandchildren with EXISTS predicate", () => {
    const result = fkClosure("core.Contract", "contractId", edges)
    const step = result.get("core.Step")
    expect(step).toBeDefined()
    expect(step!.predicate).toContain("EXISTS")
    expect(step!.predicate).toContain("[core].[Pipeline]")
    expect(step!.predicate).toContain("contractId = {id}")
  })

  it("excludes disallowed schemas (dbo.Audit)", () => {
    const result = fkClosure("core.Contract", "contractId", edges)
    expect(result.has("dbo.Audit")).toBe(false)
  })

  it("traverses gate schema correctly", () => {
    const result = fkClosure("gate.MetaTable", "tableId", edges)
    expect(result.get("gate.MetaView")).toMatchObject({ scopeColumn: "tableId", predicate: "tableId = {id}" })
  })

  it("returns only root when no FK children exist", () => {
    const result = fkClosure("gate.MetaView", "viewId", edges)
    expect(result.size).toBe(1)
    expect(result.has("gate.MetaView")).toBe(true)
  })

  it("builds multi-hop JOIN predicate when intermediate table lacks rootKey", () => {
    // core.RuleCondition is 2 hops from root (Contract → Dataset → DatasetColumn → RuleCondition)
    // DatasetColumn does NOT have contractId, so a simple p.contractId = {id} would be wrong.
    const result = fkClosure("core.Contract", "contractId", edges)
    const rc = result.get("core.RuleCondition")
    expect(rc).toBeDefined()
    expect(rc!.predicate).toContain("EXISTS")
    expect(rc!.predicate).toContain("INNER JOIN")
    expect(rc!.predicate).toContain("[core].[Dataset]")
    expect(rc!.predicate).toContain("contractId = {id}")
    // contractId must be on the joined Dataset alias, not on DatasetColumn's p alias
    expect(rc!.predicate).toMatch(/_p\d+\.contractId/)
    expect(rc!.predicate).not.toMatch(/\bp\.contractId/)
  })

  it("builds deeper multi-hop JOIN for 3+ hops without rootKey", () => {
    // core.RuleConditionValue is 3 hops from root:
    //   Contract → Dataset → DatasetColumn → RuleCondition → RuleConditionValue
    // Neither RuleCondition nor DatasetColumn have contractId.
    const result = fkClosure("core.Contract", "contractId", edges)
    const rcv = result.get("core.RuleConditionValue")
    expect(rcv).toBeDefined()
    expect(rcv!.predicate).toContain("EXISTS")
    expect(rcv!.predicate).toContain("INNER JOIN")
    // Should join through DatasetColumn AND Dataset to reach contractId
    expect(rcv!.predicate).toContain("[core].[DatasetColumn]")
    expect(rcv!.predicate).toContain("[core].[Dataset]")
    expect(rcv!.predicate).toContain("contractId = {id}")
  })
})

// ═══════════════════════════════════════════════════════════════════
//  End-to-end pipeline predicate generation
// ═══════════════════════════════════════════════════════════════════
describe("end-to-end: pipeline 788 (contract)", () => {
  // Simulates what the script does: extract calls + derivations → resolve predicates
  const contractSproc = `
    SELECT @datasetIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), datasetId)
       FROM core.Dataset WHERE contractId = @contractId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @pipelineIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), pipelineId)
       FROM core.Pipeline WHERE contractId = @contractId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @datasetMappingIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), datasetMappingId)
       FROM core.DatasetMapping WHERE datasetId_Left IN (SELECT datasetId FROM core.Dataset WHERE contractId = @contractId)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'ContractColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Contract', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId_Left', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Dataset', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@pipelineIds,0)) + '', @name = 'Activity', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Pipeline', @schema = 'core'
  `

  it("extracts 8 EXEC calls", () => {
    expect(extractSyncObjectCalls(contractSproc)).toHaveLength(8)
  })

  it("resolves ContractColumn: contractId = {id}", () => {
    const derivations = extractVariableDerivations(contractSproc)
    const result = resolveIdsPredicate("contractId", "contractId", derivations, "contractId", "contractId")
    expect(result).toBe("contractId = {id}")
  })

  it("resolves DatasetColumn: datasetId IN (subquery)", () => {
    const derivations = extractVariableDerivations(contractSproc)
    const result = resolveIdsPredicate("datasetId", "datasetIds", derivations, "contractId", "contractId")
    expect(result).toContain("SELECT datasetId FROM [core].[Dataset]")
    expect(result).toContain("contractId = {id}")
  })

  it("resolves Activity: pipelineId IN (subquery)", () => {
    const derivations = extractVariableDerivations(contractSproc)
    const result = resolveIdsPredicate("pipelineId", "pipelineIds", derivations, "contractId", "contractId")
    expect(result).toContain("SELECT pipelineId FROM [core].[Pipeline]")
    expect(result).toContain("contractId = {id}")
  })

  it("resolves DatasetMapping: datasetId_Left IN (subquery)", () => {
    const derivations = extractVariableDerivations(contractSproc)
    const result = resolveIdsPredicate("datasetId_Left", "datasetIds", derivations, "contractId", "contractId")
    expect(result).toContain("SELECT datasetId FROM [core].[Dataset]")
    expect(result).toContain("contractId = {id}")
  })

  it("resolves DatasetMappingColumn: nested subquery with balanced parens", () => {
    const derivations = extractVariableDerivations(contractSproc)
    const result = resolveIdsPredicate("datasetMappingId", "datasetMappingIds", derivations, "contractId", "contractId")
    expect(result).toContain("SELECT datasetMappingId FROM [core].[DatasetMapping]")
    const opens = (result!.match(/\(/g) || []).length
    const closes = (result!.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  it("all predicates have balanced parentheses", () => {
    const calls = extractSyncObjectCalls(contractSproc)
    const derivations = extractVariableDerivations(contractSproc)
    for (const c of calls) {
      const pred = resolveIdsPredicate(c.idName, c.idsVar, derivations, "contractId", "contractId")
      if (!pred) continue
      const opens = (pred.match(/\(/g) || []).length
      const closes = (pred.match(/\)/g) || []).length
      expect(opens, `Unbalanced parens in ${c.qualified}: ${pred}`).toBe(closes)
    }
  })
})

describe("end-to-end: pipeline 791 (rule)", () => {
  const ruleSproc = `
    ;WITH cte (ruleId) AS (
      SELECT ruleId FROM core.Rule WHERE ruleId = @ruleId
      UNION ALL
      SELECT r.ruleId FROM core.Rule r INNER JOIN cte c ON r.parentRuleId = c.ruleId
    )
    SELECT @rulesIds = STUFF(
      (SELECT ',' + CAST(ruleId AS VARCHAR(MAX))
       FROM cte
       FOR XML PATH('')),1,1,'')

    SELECT @ruleConditionIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleConditionId)
       FROM core.RuleCondition WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleInputDatasetIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.inputDatasetId)
       FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleOutputDatasetIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.outputDatasetId)
       FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SET @ruleDatasetIds = COALESCE(@ruleOutputDatasetIds + ', ','') + @ruleInputDatasetIds

    SELECT @datasetMappingIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), datasetMappingId)
       FROM core.DatasetMapping WHERE datasetId_Left IN (@ruleDatasetIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleLinkTypeIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleLinkTypeId)
       FROM core.RuleLink WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleTypeIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleTypeId)
       FROM core.Rule WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleDatasetIds,0)) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleDatasetIds,0)) + '', @name = 'Dataset', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleLinkTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleLinkTypeIds,0)) + '', @name = 'RuleLinkType', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleLink', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleConditionId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleConditionIds,0)) + '', @name = 'RuleConditionValue', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleCondition', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleTypeIds,0)) + '', @name = 'RuleType', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'Rule', @schema = 'core'
  `

  it("extracts 11 EXEC calls", () => {
    expect(extractSyncObjectCalls(ruleSproc)).toHaveLength(11)
  })

  it("resolves CTE-based @rulesIds to ruleId from core.Rule", () => {
    const derivations = extractVariableDerivations(ruleSproc)
    const d = derivations.get("rulesids")
    expect(d).toMatchObject({ column: "ruleId", fromTable: "core.Rule", whereClause: "ruleId = @ruleId" })
  })

  it("resolves Rule: ruleId IN (subquery from CTE)", () => {
    const derivations = extractVariableDerivations(ruleSproc)
    const result = resolveIdsPredicate("ruleId", "rulesIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}")
  })

  it("resolves RuleConditionValue: nested subquery via @ruleConditionIds", () => {
    const derivations = extractVariableDerivations(ruleSproc)
    const result = resolveIdsPredicate("ruleConditionId", "ruleConditionIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("SELECT ruleConditionId FROM [core].[RuleCondition]")
    expect(result).toContain("{id}")
    const opens = (result!.match(/\(/g) || []).length
    const closes = (result!.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  it("resolves Dataset: UNION of output+input datasetIds", () => {
    const derivations = extractVariableDerivations(ruleSproc)
    const result = resolveIdsPredicate("datasetId", "ruleDatasetIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("UNION")
    expect(result).toContain("outputDatasetId")
    expect(result).toContain("inputDatasetId")
  })

  it("resolves DatasetMapping: nested into UNION subquery", () => {
    const derivations = extractVariableDerivations(ruleSproc)
    const result = resolveIdsPredicate("datasetMappingId", "datasetMappingIds", derivations, "ruleId", "ruleId")
    expect(result).toContain("SELECT datasetMappingId FROM [core].[DatasetMapping]")
    expect(result).toContain("UNION")
    const opens = (result!.match(/\(/g) || []).length
    const closes = (result!.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  it("all predicates have balanced parentheses", () => {
    const calls = extractSyncObjectCalls(ruleSproc)
    const derivations = extractVariableDerivations(ruleSproc)
    for (const c of calls) {
      const pred = resolveIdsPredicate(c.idName, c.idsVar, derivations, "ruleId", "ruleId")
      if (!pred) continue
      const opens = (pred.match(/\(/g) || []).length
      const closes = (pred.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${c.qualified}: ${pred}`).toBe(closes)
    }
  })

  it("no predicate contains STUFF or COALESCE artifacts", () => {
    const calls = extractSyncObjectCalls(ruleSproc)
    const derivations = extractVariableDerivations(ruleSproc)
    for (const c of calls) {
      const pred = resolveIdsPredicate(c.idName, c.idsVar, derivations, "ruleId", "ruleId")
      if (!pred) continue
      expect(pred, `STUFF/COALESCE in ${c.qualified}`).not.toMatch(/STUFF|COALESCE/)
    }
  })
})

describe("end-to-end: pipeline 792 (dataset)", () => {
  // Dataset sproc: @datasetIds is a PARAMETER not a derived variable
  const datasetSproc = `
    CREATE PROCEDURE [core].[uspSyncDatasetObjectsTran]
      @datasetIds VARCHAR(MAX)
      ,@linkedService VARCHAR(100)
      ,@pipelineRunId INT
    AS
    SET NOCOUNT ON

    DECLARE @pipelineIds VARCHAR(MAX) = NULL

    SET @sqlPipelineIds = N'
    SELECT @pipelineIds = STUFF(
      (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), t.pipelineId) FROM (
        SELECT pipelineId FROM core.Pipeline WHERE datasetId IN ('+ @datasetIds +')
      ) AS t
    FOR XML PATH ('''')),1,1,'''')'

    EXEC sys.sp_executesql @sqlPipelineIds, N'@pipelineIds VARCHAR(MAX) OUT', @pipelineIds OUT

    SET @sqlDatasetMappingIds = N'
    SELECT @datasetMappingIds = STUFF(
      (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), t.datasetMappingId) FROM (
        SELECT datasetMappingId FROM core.DatasetMapping
        WHERE datasetId_Left IN ('+STUFF(COALESCE(', ' + @datasetIds,'') + COALESCE(', '+@deletedDatasetIds,''),1,1,'') +')
      ) AS t
    FOR XML PATH ('''')),1,1,'''')'

    EXEC sys.sp_executesql @sqlDatasetMappingIds, N'@datasetMappingIds VARCHAR(MAX) OUT', @datasetMappingIds OUT

    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + '', @name = 'Activity', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + '', @name = 'Pipeline', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'Dataset', @schema = 'core'
  `

  it("extracts 6 EXEC calls", () => {
    expect(extractSyncObjectCalls(datasetSproc)).toHaveLength(6)
  })

  it("resolves Dataset/DatasetColumn: direct equality via plural param convention", () => {
    const derivations = extractVariableDerivations(datasetSproc)
    const result = resolveIdsPredicate("datasetId", "datasetIds", derivations, "datasetId", "datasetId")
    expect(result).toBe("datasetId = {id}")
  })

  it("resolves Pipeline: pipelineId via sp_executesql alias", () => {
    const derivations = extractVariableDerivations(datasetSproc)
    const result = resolveIdsPredicate("pipelineId", "pipelineIds", derivations, "datasetId", "datasetId")
    expect(result).toContain("SELECT pipelineId FROM [core].[Pipeline]")
    expect(result).toContain("{id}")
  })

  it("resolves DatasetMapping: STUFF/COALESCE cleaned", () => {
    const derivations = extractVariableDerivations(datasetSproc)
    const result = resolveIdsPredicate("datasetMappingId", "datasetMappingIds", derivations, "datasetId", "datasetId")
    if (result) {
      expect(result).not.toContain("STUFF")
      expect(result).not.toContain("COALESCE")
      const opens = (result.match(/\(/g) || []).length
      const closes = (result.match(/\)/g) || []).length
      expect(opens).toBe(closes)
    }
  })

  it("all predicates have balanced parentheses", () => {
    const calls = extractSyncObjectCalls(datasetSproc)
    const derivations = extractVariableDerivations(datasetSproc)
    for (const c of calls) {
      const pred = resolveIdsPredicate(c.idName, c.idsVar, derivations, "datasetId", "datasetId")
      if (!pred) continue
      const opens = (pred.match(/\(/g) || []).length
      const closes = (pred.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${c.qualified}: ${pred}`).toBe(closes)
    }
  })
})

describe("end-to-end: pipeline 798 (pipelineActivity)", () => {
  const pipelineSproc = `
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(100), @pipelineId) + '', @name = 'Activity', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(100), @pipelineId) + '', @name = 'Pipeline', @schema = 'core'
  `

  it("extracts 2 calls both with pipelineId = pipelineId", () => {
    const calls = extractSyncObjectCalls(pipelineSproc)
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.idName).toBe("pipelineId")
      expect(c.idsVar).toBe("pipelineId")
    }
  })

  it("resolves to direct equality for both tables", () => {
    const derivations = extractVariableDerivations(pipelineSproc)
    const r1 = resolveIdsPredicate("pipelineId", "pipelineId", derivations, "pipelineId", "pipelineId")
    expect(r1).toBe("pipelineId = {id}")
  })
})

describe("end-to-end: pipeline 780 (gateMetadata)", () => {
  const gateSproc = `
    SET @sqlMetaViewIds =
    'SELECT @metaViewIds = STUFF(
      (SELECT N'', '' + CONVERT(NVARCHAR(MAX), viewId)
       FROM gate.MetaView
       WHERE tableId IN ( ' + CONVERT(NVARCHAR(50), @tableId) + ')
       FOR XML PATH(''),TYPE).value(''text()[1]'',''NVARCHAR(MAX)''),1,2,N'')'

    EXEC sp_executesql @sqlMetaViewIds, N'@metaViewIds VARCHAR(MAX) out', @metaViewIds OUT

    SET @sqlMetaColumnIds =
    'SELECT @metaColumnIds = STUFF(
      (SELECT N'', '' + CONVERT(NVARCHAR(MAX), columnId)
       FROM gate.MetaColumn
       WHERE viewId IN ( ' + @metaViewIds + ')
       FOR XML PATH(''),TYPE).value(''text()[1]'',''NVARCHAR(MAX)''),1,2,N'')'

    EXEC sp_executesql @sqlMetaColumnIds, N'@metaColumnIds VARCHAR(MAX) out', @metaColumnIds OUT

    SET @sqlJsonSchemaIds =
    'SELECT @contentJsonSchemaIds = STUFF(
      (SELECT N'', '' + CONVERT(NVARCHAR(MAX), jsonSchemaId)
       FROM gate.MetaColumn
       WHERE columnId IN ( '+ @metaColumnIds +')
       FOR XML PATH(''),TYPE).value(''text()[1]'',''NVARCHAR(MAX)''),1,2,N'')'

    EXEC sp_executesql @sqlJsonSchemaIds, N'@contentJsonSchemaIds VARCHAR(MAX) out', @jsonSchemaIds OUT

    EXEC core.uspSyncObjectTran @idName = 'jsonSchemaId', @ids = '' + CONVERT(VARCHAR(1000),ISNULL(@jsonSchemaIds,0)) + '', @name = 'jsonSchema', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'viewId', @ids = '' + CONVERT(VARCHAR(1000),ISNULL(@metaViewIds,0)) + '', @name = 'metaColumn', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'viewId', @ids = '' + CONVERT(VARCHAR(1000),ISNULL(@metaViewIds,0)) + '', @name = 'metaView', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'tableId', @ids = '' + CONVERT(VARCHAR(100), @tableId) + '', @name = 'metaTable', @schema = 'gate'
  `

  it("extracts 4 EXEC calls", () => {
    expect(extractSyncObjectCalls(gateSproc)).toHaveLength(4)
  })

  it("resolves metaTable: direct equality via root param", () => {
    const derivations = extractVariableDerivations(gateSproc)
    const result = resolveIdsPredicate("tableId", "tableId", derivations, "tableId", "tableId")
    expect(result).toBe("tableId = {id}")
  })

  it("resolves metaView/metaColumn: viewId via @metaViewIds → sp_executesql alias", () => {
    const derivations = extractVariableDerivations(gateSproc)
    const result = resolveIdsPredicate("viewId", "metaViewIds", derivations, "tableId", "tableId")
    expect(result).toContain("SELECT viewId FROM [gate].[MetaView]")
    expect(result).toContain("{id}")
  })

  it("resolves jsonSchema: deep chain @jsonSchemaIds → @contentJsonSchemaIds → @metaColumnIds → @metaViewIds", () => {
    const derivations = extractVariableDerivations(gateSproc)
    // @jsonSchemaIds is aliased to @contentJsonSchemaIds via sp_executesql
    expect(derivations.get("jsonschemaids")).toMatchObject({ alias: "contentjsonschemaids" })
    const result = resolveIdsPredicate("jsonSchemaId", "jsonSchemaIds", derivations, "tableId", "tableId")
    expect(result).toContain("jsonSchemaId IN")
    expect(result).toContain("[gate].[MetaColumn]")
    expect(result).not.toContain("UNRESOLVED")
    const opens = (result!.match(/\(/g) || []).length
    const closes = (result!.match(/\)/g) || []).length
    expect(opens).toBe(closes)
  })

  it("all predicates have balanced parentheses and no artifacts", () => {
    const calls = extractSyncObjectCalls(gateSproc)
    const derivations = extractVariableDerivations(gateSproc)
    for (const c of calls) {
      const pred = resolveIdsPredicate(c.idName, c.idsVar, derivations, "tableId", "tableId")
      if (!pred) continue
      const opens = (pred.match(/\(/g) || []).length
      const closes = (pred.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${c.qualified}: ${pred}`).toBe(closes)
      expect(pred).not.toContain("STUFF")
      expect(pred).not.toContain("COALESCE")
      expect(pred).not.toContain("UNRESOLVED")
    }
  })
})

describe("deployed gateMetadata recipe", () => {
  it("scopes ContentLink and UserGroupPermission via MetaView instead of Content.tableId", () => {
    const bundle = JSON.parse(
      readFileSync(resolve(process.cwd(), "../../deploy/mssql/sync-recipes.json"), "utf-8"),
    ) as {
      recipes: {
        gateMetadata: {
          tables: Array<{ name: string; predicate: string; source: string; userControllable?: boolean; enabledByDefault?: boolean }>
        }
      }
    }

    const contentLink = bundle.recipes.gateMetadata.tables.find((table) => table.name === "gate.ContentLink")
    const userGroupPermission = bundle.recipes.gateMetadata.tables.find((table) => table.name === "gate.UserGroupPermission")

    expect(contentLink?.predicate).toContain("JOIN [gate].[MetaView]")
    expect(contentLink?.predicate).toContain("viewId = p.viewId")
    expect(contentLink?.predicate).toContain("tableId = {id}")
    expect(contentLink?.predicate).not.toContain("p.tableId = {id}")
    expect(contentLink?.source).toBe("fk-only")
    expect(contentLink?.userControllable).toBe(true)
    expect(contentLink?.enabledByDefault).toBe(false)

    expect(userGroupPermission?.predicate).toContain("JOIN [gate].[MetaView]")
    expect(userGroupPermission?.predicate).toContain("viewId = p.viewId")
    expect(userGroupPermission?.predicate).toContain("tableId = {id}")
    expect(userGroupPermission?.predicate).not.toContain("p.tableId = {id}")
    expect(userGroupPermission?.source).toBe("fk-only")
    expect(userGroupPermission?.userControllable).toBe(true)
    expect(userGroupPermission?.enabledByDefault).toBe(false)
  })
})

describe("end-to-end: pipeline 692 (content)", () => {
  const contentSproc = `
    SELECT @contentTypeIds = STUFF(
      (SELECT DISTINCT N', ' + CONVERT(NVARCHAR(MAX), contentTypeId)
       FROM gate.Content WHERE contentId = @contentId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @contentLinkTypeIds = STUFF(
      (SELECT DISTINCT N', ' + CONVERT(NVARCHAR(MAX), contentLinkTypeId)
       FROM gate.ContentLink WHERE contentId = @contentId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    EXEC core.uspSyncObjectTran @idName = 'contentId', @ids = '' + CONVERT(VARCHAR(MAX), @contentId) + '', @name = 'Content', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'contentId', @ids = '' + CONVERT(VARCHAR(MAX), @contentId) + '', @name = 'ContentLink', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'contentTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@contentTypeIds,0)) + '', @name = 'ContentType', @schema = 'gate'
    EXEC core.uspSyncObjectTran @idName = 'contentLinkTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@contentLinkTypeIds,0)) + '', @name = 'ContentLinkType', @schema = 'gate'
  `

  it("extracts 4 calls in correct order", () => {
    const calls = extractSyncObjectCalls(contentSproc)
    expect(calls.map(c => c.qualified)).toEqual([
      "gate.Content", "gate.ContentLink", "gate.ContentType", "gate.ContentLinkType"
    ])
  })

  it("resolves Content: direct equality", () => {
    const derivations = extractVariableDerivations(contentSproc)
    const result = resolveIdsPredicate("contentId", "contentId", derivations, "contentId", "contentId")
    expect(result).toBe("contentId = {id}")
  })

  it("resolves ContentType: contentTypeId from gate.Content subquery", () => {
    const derivations = extractVariableDerivations(contentSproc)
    const result = resolveIdsPredicate("contentTypeId", "contentTypeIds", derivations, "contentId", "contentId")
    expect(result).toContain("SELECT contentTypeId FROM [gate].[Content]")
    expect(result).toContain("contentId = {id}")
  })

  it("resolves ContentLinkType: contentLinkTypeId from gate.ContentLink subquery", () => {
    const derivations = extractVariableDerivations(contentSproc)
    const result = resolveIdsPredicate("contentLinkTypeId", "contentLinkTypeIds", derivations, "contentId", "contentId")
    expect(result).toContain("SELECT contentLinkTypeId FROM [gate].[ContentLink]")
    expect(result).toContain("contentId = {id}")
  })
})

// ═══════════════════════════════════════════════════════════════════
//  detectSelfJoinColumn
// ═══════════════════════════════════════════════════════════════════

describe("detectSelfJoinColumn", () => {
  const fkEdges = [
    // Self-referencing FK: core.Rule.parentRuleId → core.Rule.ruleId
    { childSchema: "core", childTable: "Rule", childColumn: "parentRuleId", parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId" },
    // Normal FK: core.RuleColumn.ruleId → core.Rule.ruleId (not self-join)
    { childSchema: "core", childTable: "RuleColumn", childColumn: "ruleId", parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId" },
    // Normal FK: core.Contract.contractTypeId → core.ContractType.contractTypeId
    { childSchema: "core", childTable: "Contract", childColumn: "contractTypeId", parentSchema: "core", parentTable: "ContractType", parentColumn: "contractTypeId" },
  ]

  it("detects self-referencing FK on core.Rule", () => {
    expect(detectSelfJoinColumn("core.Rule", "ruleId", fkEdges)).toBe("parentRuleId")
  })

  it("returns null for tables without self-referencing FK", () => {
    expect(detectSelfJoinColumn("core.Contract", "contractId", fkEdges)).toBeNull()
    expect(detectSelfJoinColumn("core.RuleColumn", "ruleColumnId", fkEdges)).toBeNull()
  })

  it("returns null for empty FK edges", () => {
    expect(detectSelfJoinColumn("core.Rule", "ruleId", [])).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  instantiatePredicateWithTree
// ═══════════════════════════════════════════════════════════════════

describe("instantiatePredicateWithTree", async () => {
  // Import from recipes.ts
  const { instantiatePredicateWithTree } = await import("../../sync/src/recipes.js")

  it("substitutes {ids} with expanded tree IDs", () => {
    const result = instantiatePredicateWithTree("ruleId IN ({ids})", 100, [100, 200, 300])
    expect(result).toBe("ruleId IN (100, 200, 300)")
  })

  it("substitutes {id} with root ID only", () => {
    const result = instantiatePredicateWithTree("contractId = {id}", 42, [100, 200])
    expect(result).toBe("contractId = 42")
  })

  it("handles both {id} and {ids} in same predicate", () => {
    const result = instantiatePredicateWithTree(
      "ruleId IN ({ids}) AND rootId = {id}",
      10,
      [10, 20, 30],
    )
    expect(result).toBe("ruleId IN (10, 20, 30) AND rootId = 10")
  })

  it("falls back to single ID when expandedIds is null", () => {
    const result = instantiatePredicateWithTree("ruleId IN ({ids})", 42, null)
    expect(result).toBe("ruleId IN (42)")
  })

  it("falls back to single ID when expandedIds is empty", () => {
    const result = instantiatePredicateWithTree("ruleId IN ({ids})", 42, [])
    expect(result).toBe("ruleId IN (42)")
  })

  it("handles string IDs with quoting", () => {
    const result = instantiatePredicateWithTree("contentId IN ({ids})", "abc", ["abc", "def"])
    expect(result).toBe("contentId IN ('abc', 'def')")
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Full pipeline simulation — mimics buildRecipe() reconciliation
// ═══════════════════════════════════════════════════════════════════
//
// These tests run the EXACT same logic as the introspection script:
//   1. Parse the real sproc body → extractSyncObjectCalls + extractVariableDerivations
//   2. resolveIdsPredicate for each EXEC call → pipeline-derived predicates
//   3. fkClosure with real FK edges → FK-derived predicates
//   4. Reconcile both sets → verify every predicate is valid
//
// Real FK edges from the live ABI UAT database (verified 2026-04-29).

const REAL_FK_EDGES = [
  // ── Contract entity ──
  { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "core", childTable: "Pipeline", childColumn: "contractId" },
  { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "core", childTable: "Dataset", childColumn: "contractId" },
  { parentSchema: "core", parentTable: "Contract", parentColumn: "contractId", childSchema: "core", childTable: "ContractColumn", childColumn: "contractId" },
  { parentSchema: "core", parentTable: "Pipeline", parentColumn: "pipelineId", childSchema: "core", childTable: "Step", childColumn: "pipelineId" },
  { parentSchema: "core", parentTable: "Pipeline", parentColumn: "pipelineId", childSchema: "core", childTable: "Activity", childColumn: "pipelineId" },
  { parentSchema: "core", parentTable: "Dataset", parentColumn: "datasetId", childSchema: "core", childTable: "DatasetColumn", childColumn: "datasetId" },
  { parentSchema: "core", parentTable: "Dataset", parentColumn: "datasetId", childSchema: "core", childTable: "DatasetMapping", childColumn: "datasetId_Left" },
  { parentSchema: "core", parentTable: "DatasetMapping", parentColumn: "datasetMappingId", childSchema: "core", childTable: "DatasetMappingColumn", childColumn: "datasetMappingId" },
  { parentSchema: "core", parentTable: "Dataset", parentColumn: "datasetId", childSchema: "core", childTable: "Rule", childColumn: "inputDatasetId" },
  { parentSchema: "core", parentTable: "Dataset", parentColumn: "datasetId", childSchema: "core", childTable: "Rule", childColumn: "outputDatasetId" },
  { parentSchema: "core", parentTable: "DatasetColumn", parentColumn: "datasetColumnId", childSchema: "core", childTable: "RuleColumn", childColumn: "inputDatasetColumnId" },
  { parentSchema: "core", parentTable: "DatasetColumn", parentColumn: "datasetColumnId", childSchema: "core", childTable: "RuleCondition", childColumn: "inputDatasetColumnId" },
  { parentSchema: "core", parentTable: "DatasetColumn", parentColumn: "datasetColumnId", childSchema: "core", childTable: "RuleLink", childColumn: "outputDatasetColumnId" },
  { parentSchema: "core", parentTable: "RuleCondition", parentColumn: "ruleConditionId", childSchema: "core", childTable: "RuleConditionValue", childColumn: "ruleConditionId" },
  // Rule self-join
  { parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId", childSchema: "core", childTable: "Rule", childColumn: "parentRuleId" },
  // Rule direct FK children
  { parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId", childSchema: "core", childTable: "RuleColumn", childColumn: "ruleId" },
  { parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId", childSchema: "core", childTable: "RuleCondition", childColumn: "ruleId" },
  { parentSchema: "core", parentTable: "Rule", parentColumn: "ruleId", childSchema: "core", childTable: "RuleLink", childColumn: "ruleId" },
  // RuleLink → RuleLinkType
  { parentSchema: "core", parentTable: "RuleLinkType", parentColumn: "ruleLinkTypeId", childSchema: "core", childTable: "RuleLink", childColumn: "ruleLinkTypeId" },
  // Rule → RuleType
  { parentSchema: "core", parentTable: "RuleType", parentColumn: "ruleTypeId", childSchema: "core", childTable: "Rule", childColumn: "ruleTypeId" },
  // ── Gate entity ──
  { parentSchema: "gate", parentTable: "MetaTable", parentColumn: "tableId", childSchema: "gate", childTable: "MetaView", childColumn: "tableId" },
  { parentSchema: "gate", parentTable: "MetaView", parentColumn: "viewId", childSchema: "gate", childTable: "MetaColumn", childColumn: "viewId" },
  { parentSchema: "gate", parentTable: "MetaColumn", parentColumn: "jsonSchemaId", childSchema: "gate", childTable: "jsonSchema", childColumn: "jsonSchemaId" },
  // Content
  { parentSchema: "gate", parentTable: "Content", parentColumn: "contentId", childSchema: "gate", childTable: "ContentLink", childColumn: "contentId" },
  { parentSchema: "gate", parentTable: "Content", parentColumn: "contentId", childSchema: "gate", childTable: "UserGroupPermission", childColumn: "contentId" },
]

/** Known columns per table — used to verify predicates don't reference invalid columns. */
const TABLE_COLUMNS: Record<string, Set<string>> = {
  "core.Contract":            new Set(["contractId", "name", "validFrom", "validTo"]),
  "core.ContractColumn":      new Set(["contractColumnId", "contractId", "name"]),
  "core.Pipeline":            new Set(["pipelineId", "contractId", "datasetId", "name"]),
  "core.Step":                new Set(["stepId", "pipelineId", "name"]),
  "core.Activity":            new Set(["activityId", "pipelineId", "name"]),
  "core.Dataset":             new Set(["datasetId", "contractId", "name"]),
  "core.DatasetColumn":       new Set(["datasetColumnId", "datasetId", "name"]),
  "core.DatasetMapping":      new Set(["datasetMappingId", "datasetId_Left", "datasetId_Right"]),
  "core.DatasetMappingColumn": new Set(["datasetMappingColumnId", "datasetMappingId"]),
  "core.Rule":                new Set(["ruleId", "parentRuleId", "inputDatasetId", "outputDatasetId", "ruleTypeId", "name"]),
  "core.RuleColumn":          new Set(["ruleColumnId", "ruleId", "inputDatasetColumnId"]),
  "core.RuleCondition":       new Set(["ruleConditionId", "ruleId", "inputDatasetColumnId"]),
  "core.RuleConditionValue":  new Set(["ruleConditionValueId", "ruleConditionId"]),
  "core.RuleLink":            new Set(["ruleLinkId", "ruleId", "outputDatasetColumnId", "ruleLinkTypeId"]),
  "core.RuleLinkType":        new Set(["ruleLinkTypeId", "name"]),
  "core.RuleType":            new Set(["ruleTypeId", "name"]),
  "gate.MetaTable":           new Set(["tableId", "name"]),
  "gate.MetaView":            new Set(["viewId", "tableId"]),
  "gate.MetaColumn":          new Set(["columnId", "viewId", "jsonSchemaId"]),
  "gate.jsonSchema":          new Set(["jsonSchemaId"]),
  "gate.Content":             new Set(["contentId", "contentTypeId", "viewId", "tableId"]),
  "gate.ContentLink":         new Set(["contentLinkId", "contentId", "contentLinkTypeId"]),
  "gate.ContentType":         new Set(["contentTypeId", "name"]),
  "gate.ContentLinkType":     new Set(["contentLinkTypeId", "name"]),
  "gate.UserGroupPermission": new Set(["userGroupPermissionId", "contentId"]),
}

/**
 * Validate that a predicate only references columns that actually exist on the
 * tables it queries. Catches the exact bug class we fixed: e.g. referencing
 * `contractId` on `core.DatasetColumn` which doesn't have that column.
 */
function validatePredicateColumns(predicate: string, _tableName: string): string[] {
  const errors: string[] = []

  // Check direct column references: `[schema].[Table].column` pattern (bracket-quoted)
  // e.g. "[core].[RuleConditionValue].ruleConditionId"
  const bracketColRe = /\[(\w+)\]\.\[(\w+)\]\.(\w+)/g
  let m
  while ((m = bracketColRe.exec(predicate)) !== null) {
    const table = `${m[1]}.${m[2]}`
    const col = m[3]
    const known = TABLE_COLUMNS[table]
    if (known && !known.has(col)) {
      errors.push(`${table} does not have column '${col}' — referenced in predicate`)
    }
  }

  // Also check unbracketed outer refs (legacy/pipeline predicates): `schema.Table.column`
  const dotColRe = /(?<!\[)(\w+\.\w+)\.(\w+)/g
  while ((m = dotColRe.exec(predicate)) !== null) {
    const table = m[1]
    const col = m[2]
    const known = TABLE_COLUMNS[table]
    if (known && !known.has(col)) {
      errors.push(`${table} does not have column '${col}' — referenced in predicate`)
    }
  }

  // Check unaliased column references in WHERE clause for the outer table
  // Works with both bracketed and unbracketed FROM: "FROM [schema].[Table] p" or "FROM schema.Table p"
  const aliasedRe = /FROM\s+(?:\[(\w+)\]\.\[(\w+)\]|(\w+\.\w+))\s+p\b/g
  while ((m = aliasedRe.exec(predicate)) !== null) {
    const aliasedTable = m[1] ? `${m[1]}.${m[2]}` : m[3]
    // Find all p.column references
    const pColRe = /\bp\.(\w+)/g
    let pm
    while ((pm = pColRe.exec(predicate)) !== null) {
      const col = pm[1]
      const known = TABLE_COLUMNS[aliasedTable]
      if (known && !known.has(col)) {
        errors.push(`Alias 'p' (${aliasedTable}) does not have column '${col}'`)
      }
    }
  }

  // Check _p1, _p2, etc. alias references (bracketed or unbracketed JOIN targets)
  const numAliasRe = /INNER JOIN\s+(?:\[(\w+)\]\.\[(\w+)\]|(\w+\.\w+))\s+(_p\d+)/g
  while ((m = numAliasRe.exec(predicate)) !== null) {
    const joinTable = m[1] ? `${m[1]}.${m[2]}` : m[3]
    const alias = m[4]
    const aliasColRe = new RegExp(`\\b${alias}\\.(\\w+)`, "g")
    let am
    while ((am = aliasColRe.exec(predicate)) !== null) {
      const col = am[1]
      const known = TABLE_COLUMNS[joinTable]
      if (known && !known.has(col)) {
        errors.push(`Alias '${alias}' (${joinTable}) does not have column '${col}'`)
      }
    }
  }

  return errors
}

/** Helper: run buildRecipe logic offline (extract + FK + reconcile). */
function simulateBuildRecipe(
  sproc: string,
  rootTable: string,
  rootKey: string,
  fkEdges: typeof REAL_FK_EDGES,
) {
  const calls = extractSyncObjectCalls(sproc)
  const derivations = extractVariableDerivations(sproc)
  const fkTables = fkClosure(rootTable, rootKey, fkEdges)

  const pipelineTables = new Map<string, { scopeColumn: string; predicate: string; predicateResolved: boolean }>()
  for (const c of calls) {
    if (pipelineTables.has(c.qualified)) continue
    const resolved = resolveIdsPredicate(c.idName, c.idsVar, derivations, rootKey, rootKey)
    pipelineTables.set(c.qualified, {
      scopeColumn: c.idName,
      predicate: resolved ?? `${c.idName} = UNRESOLVED`,
      predicateResolved: !!resolved,
    })
  }

  // Reconcile (simplified version of buildRecipe logic)
  const fkLowerMap = new Map<string, string>()
  for (const t of fkTables.keys()) fkLowerMap.set(t.toLowerCase(), t)
  const pipeLowerMap = new Map<string, string>()
  for (const t of pipelineTables.keys()) pipeLowerMap.set(t.toLowerCase(), t)

  const allKeys = new Set([...fkLowerMap.keys(), ...pipeLowerMap.keys()])
  const result = new Map<string, { predicate: string; source: string }>()

  for (const lk of allKeys) {
    const name = fkLowerMap.get(lk) ?? pipeLowerMap.get(lk)!
    const fkKey = fkLowerMap.get(lk)
    const pipeKey = pipeLowerMap.get(lk)
    const fkInfo = fkKey ? fkTables.get(fkKey) : null
    const pipeInfo = pipeKey ? pipelineTables.get(pipeKey) : null

    if (fkInfo && pipeInfo) {
      result.set(name, { predicate: pipeInfo.predicateResolved ? pipeInfo.predicate : fkInfo.predicate, source: "fk+pipeline" })
    } else if (fkInfo) {
      result.set(name, { predicate: fkInfo.predicate, source: "fk-only" })
    } else if (pipeInfo) {
      result.set(name, { predicate: pipeInfo.predicate, source: "pipeline-only" })
    }
  }

  return result
}

describe("full pipeline simulation: contract (788)", () => {
  const contractSproc = `
    SELECT @datasetIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), datasetId)
       FROM core.Dataset WHERE contractId = @contractId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @pipelineIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), pipelineId)
       FROM core.Pipeline WHERE contractId = @contractId
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @datasetMappingIds = STUFF(
      (SELECT DISTINCT N',' + CONVERT(NVARCHAR(MAX), datasetMappingId)
       FROM core.DatasetMapping WHERE datasetId_Left IN (SELECT datasetId FROM core.Dataset WHERE contractId = @contractId)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'ContractColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Contract', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId_Left', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Dataset', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@pipelineIds,0)) + '', @name = 'Activity', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'contractId', @ids = '' + CONVERT(VARCHAR(MAX), @contractId) + '', @name = 'Pipeline', @schema = 'core'
  `

  const recipe = simulateBuildRecipe(contractSproc, "core.Contract", "contractId", REAL_FK_EDGES)

  it("includes all expected tables (pipeline + FK-only)", () => {
    // Pipeline-derived tables
    for (const t of ["core.Contract", "core.ContractColumn", "core.Pipeline", "core.Dataset",
                     "core.DatasetColumn", "core.DatasetMapping", "core.DatasetMappingColumn", "core.Activity"]) {
      expect(recipe.has(t), `Missing pipeline table ${t}`).toBe(true)
    }
    // FK-only tables (NOT in sproc, but reachable via FK graph)
    for (const t of ["core.Step", "core.Rule", "core.RuleColumn", "core.RuleCondition",
                     "core.RuleLink", "core.RuleConditionValue"]) {
      expect(recipe.has(t), `Missing FK-only table ${t}`).toBe(true)
    }
  })

  it("no predicate references invalid columns on any table", () => {
    for (const [table, info] of recipe) {
      const errors = validatePredicateColumns(info.predicate, table)
      expect(errors, `${table}: ${info.predicate}\n${errors.join(", ")}`).toHaveLength(0)
    }
  })

  it("no predicate contains UNRESOLVED or leftover @variables", () => {
    for (const [table, info] of recipe) {
      expect(info.predicate, `UNRESOLVED in ${table}`).not.toContain("UNRESOLVED")
      expect(info.predicate, `@var in ${table}`).not.toMatch(/@\w+/)
    }
  })

  it("FK-only tables use multi-hop JOINs where needed", () => {
    // core.RuleColumn reaches contractId via: DatasetColumn → Dataset
    const rc = recipe.get("core.RuleColumn")!
    expect(rc.source).toBe("fk-only")
    expect(rc.predicate).toContain("INNER JOIN")
    expect(rc.predicate).toContain("[core].[Dataset]")
    expect(rc.predicate).toContain("contractId = {id}")

    // core.RuleConditionValue reaches contractId via: RuleCondition → DatasetColumn → Dataset
    const rcv = recipe.get("core.RuleConditionValue")!
    expect(rcv.source).toBe("fk-only")
    expect(rcv.predicate).toContain("INNER JOIN")
    expect(rcv.predicate).toContain("contractId = {id}")
  })

  it("all predicates have balanced parentheses", () => {
    for (const [table, info] of recipe) {
      const opens = (info.predicate.match(/\(/g) || []).length
      const closes = (info.predicate.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${table}: ${info.predicate}`).toBe(closes)
    }
  })
})

describe("full pipeline simulation: rule (791)", () => {
  const ruleSproc = `
    ;WITH cte (ruleId) AS (
      SELECT ruleId FROM core.Rule WHERE ruleId = @ruleId
      UNION ALL
      SELECT r.ruleId FROM core.Rule r INNER JOIN cte c ON r.parentRuleId = c.ruleId
    )
    SELECT @rulesIds = STUFF(
      (SELECT ',' + CAST(ruleId AS VARCHAR(MAX))
       FROM cte
       FOR XML PATH('')),1,1,'')

    SELECT @ruleConditionIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleConditionId)
       FROM core.RuleCondition WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleInputDatasetIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.inputDatasetId)
       FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleOutputDatasetIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), r.outputDatasetId)
       FROM core.Rule r WHERE r.ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SET @ruleDatasetIds = COALESCE(@ruleOutputDatasetIds + ', ','') + @ruleInputDatasetIds

    SELECT @datasetMappingIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), datasetMappingId)
       FROM core.DatasetMapping WHERE datasetId_Left IN (@ruleDatasetIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleLinkTypeIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleLinkTypeId)
       FROM core.RuleLink WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    SELECT @ruleTypeIds = STUFF(
      (SELECT N', ' + CONVERT(NVARCHAR(MAX), ruleTypeId)
       FROM core.Rule WHERE ruleId IN (@rulesIds)
       FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleDatasetIds,0)) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleDatasetIds,0)) + '', @name = 'Dataset', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleLinkTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleLinkTypeIds,0)) + '', @name = 'RuleLinkType', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleLink', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleConditionId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleConditionIds,0)) + '', @name = 'RuleConditionValue', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleCondition', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleTypeId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@ruleTypeIds,0)) + '', @name = 'RuleType', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'RuleColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'ruleId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@rulesIds,0)) + '', @name = 'Rule', @schema = 'core'
  `

  const recipe = simulateBuildRecipe(ruleSproc, "core.Rule", "ruleId", REAL_FK_EDGES)

  it("includes all 11 pipeline tables", () => {
    expect(recipe.size).toBeGreaterThanOrEqual(11)
    for (const table of [
      "core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleConditionValue",
      "core.RuleLink", "core.RuleLinkType", "core.RuleType",
      "core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.DatasetMappingColumn",
    ]) {
      expect(recipe.has(table), `Missing ${table}`).toBe(true)
    }
  })

  it("no predicate references invalid columns", () => {
    for (const [table, info] of recipe) {
      const errors = validatePredicateColumns(info.predicate, table)
      expect(errors, `${table}: ${info.predicate}\n${errors.join(", ")}`).toHaveLength(0)
    }
  })

  it("no predicate contains UNRESOLVED or leftover @variables", () => {
    for (const [table, info] of recipe) {
      expect(info.predicate, `UNRESOLVED in ${table}`).not.toContain("UNRESOLVED")
      expect(info.predicate, `@var in ${table}`).not.toMatch(/@\w+/)
    }
  })

  it("RuleConditionValue uses nested subquery from RuleCondition", () => {
    const rcv = recipe.get("core.RuleConditionValue")!
    expect(rcv.predicate).toContain("ruleConditionId IN")
    expect(rcv.predicate).toContain("[core].[RuleCondition]")
    expect(rcv.predicate).toContain("{id}")
  })

  it("Dataset uses UNION of output+input datasets", () => {
    const ds = recipe.get("core.Dataset")!
    expect(ds.predicate).toContain("UNION")
    expect(ds.predicate).toContain("outputDatasetId")
    expect(ds.predicate).toContain("inputDatasetId")
  })

  it("all predicates have balanced parentheses", () => {
    for (const [table, info] of recipe) {
      const opens = (info.predicate.match(/\(/g) || []).length
      const closes = (info.predicate.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${table}: ${info.predicate}`).toBe(closes)
    }
  })
})

describe("full pipeline simulation: dataset (792)", () => {
  const datasetSproc = `
    CREATE PROCEDURE [core].[uspSyncDatasetObjectsTran]
      @datasetIds VARCHAR(MAX)
    AS
    SET NOCOUNT ON

    DECLARE @pipelineIds VARCHAR(MAX) = NULL

    SET @sqlPipelineIds = N'
    SELECT @pipelineIds = STUFF(
      (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), t.pipelineId) FROM (
        SELECT pipelineId FROM core.Pipeline WHERE datasetId IN ('+ @datasetIds +')
      ) AS t
    FOR XML PATH ('''')),1,1,'''')'

    EXEC sys.sp_executesql @sqlPipelineIds, N'@pipelineIds VARCHAR(MAX) OUT', @pipelineIds OUT

    SET @sqlDatasetMappingIds = N'
    SELECT @datasetMappingIds = STUFF(
      (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), t.datasetMappingId) FROM (
        SELECT datasetMappingId FROM core.DatasetMapping
        WHERE datasetId_Left IN ('+STUFF(COALESCE(', ' + @datasetIds,'') + COALESCE(', '+@deletedDatasetIds,''),1,1,'') +')
      ) AS t
    FOR XML PATH ('''')),1,1,'''')'

    EXEC sys.sp_executesql @sqlDatasetMappingIds, N'@datasetMappingIds VARCHAR(MAX) OUT', @datasetMappingIds OUT

    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + '', @name = 'Activity', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'pipelineId', @ids = '' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + '', @name = 'Pipeline', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMappingColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetMappingId', @ids = '' + CONVERT(VARCHAR(MAX), ISNULL(@datasetMappingIds,0)) + '', @name = 'DatasetMapping', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'DatasetColumn', @schema = 'core'
    EXEC core.uspSyncObjectTran @idName = 'datasetId', @ids = '' + CONVERT(VARCHAR(MAX), @datasetIds) + '', @name = 'Dataset', @schema = 'core'
  `

  const recipe = simulateBuildRecipe(datasetSproc, "core.Dataset", "datasetId", REAL_FK_EDGES)

  it("includes pipeline tables + FK-only tables", () => {
    for (const t of ["core.Dataset", "core.DatasetColumn", "core.Pipeline", "core.Activity",
                     "core.DatasetMapping", "core.DatasetMappingColumn"]) {
      expect(recipe.has(t), `Missing pipeline table ${t}`).toBe(true)
    }
    // FK-only reachable tables
    for (const t of ["core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleConditionValue"]) {
      expect(recipe.has(t), `Missing FK-only table ${t}`).toBe(true)
    }
  })

  it("no predicate references invalid columns", () => {
    for (const [table, info] of recipe) {
      const errors = validatePredicateColumns(info.predicate, table)
      expect(errors, `${table}: ${info.predicate}\n${errors.join(", ")}`).toHaveLength(0)
    }
  })

  it("FK-only RuleConditionValue uses multi-hop JOIN (not invalid column)", () => {
    const rcv = recipe.get("core.RuleConditionValue")!
    expect(rcv.source).toBe("fk-only")
    expect(rcv.predicate).toContain("INNER JOIN")
    // Must NOT reference datasetId on RuleCondition directly
    expect(rcv.predicate).not.toMatch(/\bp\.datasetId\b/)
  })

  it("all predicates have balanced parentheses and no artifacts", () => {
    for (const [table, info] of recipe) {
      const opens = (info.predicate.match(/\(/g) || []).length
      const closes = (info.predicate.match(/\)/g) || []).length
      expect(opens, `Unbalanced in ${table}: ${info.predicate}`).toBe(closes)
      expect(info.predicate, `UNRESOLVED in ${table}`).not.toContain("UNRESOLVED")
    }
  })
})
