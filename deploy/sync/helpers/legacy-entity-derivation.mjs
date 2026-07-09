const ALLOWED_SCHEMAS = new Set(["core", "coreArchive", "gate", "gateArchive", "master"])

const ENTRY_SPROC_HINTS = {
  "core.uspSyncContentObjectsTran": {
    entityId: "content",
    displayName: "Content",
    rootTable: "gate.Content"
  },
  "core.uspSyncDataListObjectsTran": {
    entityId: "gateMetadata",
    displayName: "Gate Metadata",
    rootTable: "gate.MetaTable"
  },
  "core.uspSyncCoreObjectsTran": {
    entityId: "contract",
    displayName: "Contract",
    rootTable: "core.Contract"
  },
  "core.uspSyncRuleObjectsTran": { entityId: "rule", displayName: "Rule", rootTable: "core.Rule" },
  "core.uspSyncDatasetObjectsTran": {
    entityId: "dataset",
    displayName: "Dataset",
    rootTable: "core.Dataset"
  },
  "core.uspSyncPipelineObjectsTran": {
    entityId: "pipelineActivity",
    displayName: "Pipeline & Activities",
    rootTable: "core.Pipeline"
  }
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim()
}

function stripSqlLineComments(sql) {
  return sql.replace(/--.*?(?=\r?\n|$)/g, " ")
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripQualifier(identifier) {
  return (
    identifier
      .replace(/[\[\]]/g, "")
      .split(".")
      .at(-1) ?? identifier
  )
}

function normalizeDynamicSqlInterpolations(sql) {
  return normalizeSql(
    stripSqlLineComments(sql)
      .replace(/'\s*\+\s*@([A-Za-z][A-Za-z0-9_]*)\s*\+\s*'/g, "@$1")
      .replace(/\(\s*'\s*\+\s*@([A-Za-z][A-Za-z0-9_]*)\s*\+\s*'\s*\)/g, "(@$1)")
      .replace(/''/g, "'")
  )
}

function resolveRuleTreeIdsQuery(body, idsVar) {
  if (idsVar !== "rulesIds") return null
  if (!/uspSyncRuleObjectsTran/i.test(body)) return null
  return {
    selectedColumn: "ruleId",
    query: "SELECT [ruleId] FROM [core].[fRule](@ruleId)"
  }
}

function resolveConcatIdsQuery(body, idsVar, cache) {
  const escapedVar = escapeRegex(idsVar)
  const match = body.match(
    new RegExp(
      `SET\\s+@${escapedVar}\\s*=\\s*COALESCE\\(\\s*@([A-Za-z][A-Za-z0-9_]*)\\s*\\+\\s*'[^']*'\\s*,\\s*'[^']*'\\s*\\)\\s*\\+\\s*@([A-Za-z][A-Za-z0-9_]*)`,
      "i"
    )
  )
  if (!match) return null

  const left = resolveIdsQuery(body, match[1], cache)
  const right = resolveIdsQuery(body, match[2], cache)
  if (!left || !right) return null

  return {
    selectedColumn: "value",
    query:
      "SELECT [value] FROM (" +
      `SELECT [${stripQualifier(left.selectedColumn)}] AS [value] FROM (${left.query}) AS __mia_left ` +
      "UNION " +
      `SELECT [${stripQualifier(right.selectedColumn)}] AS [value] FROM (${right.query}) AS __mia_right` +
      ") AS __mia_union"
  }
}

function resolveDirectIdsQuery(body, idsVar) {
  const escapedVar = escapeRegex(idsVar)
  const start = body.search(new RegExp(`SELECT\\s+@${escapedVar}\\s*=\\s*STUFF\\(`, "i"))
  if (start < 0) return null

  const chunk = body.slice(start, Math.min(body.length, start + 6000))
  const stringLiteral = `N?'(?:[^']|'')*'`
  const selectedExpr = `((?:\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)(?:\\.(?:\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*))?)`
  const convertExpr = `CONVERT\\([^,]+,\\s*(?:t\\.)?${selectedExpr}\\s*\\)`
  const wrappedMatch = chunk.match(
    new RegExp(
      `SELECT\\s+@${escapedVar}\\s*=\\s*STUFF\\(\\s*\\(\\s*SELECT\\s+(?:DISTINCT\\s+)?${stringLiteral}\\s*\\+\\s*${convertExpr}\\s+FROM\\s+\\(\\s*(SELECT[\\s\\S]*?)\\s*\\)\\s+AS\\s+t\\s+FOR\\s+XML\\s+PATH`,
      "i"
    )
  )
  if (wrappedMatch) {
    return {
      selectedColumn: stripQualifier(wrappedMatch[1]),
      query: normalizeDynamicSqlInterpolations(wrappedMatch[2])
    }
  }

  const directMatch = chunk.match(
    new RegExp(
      `SELECT\\s+@${escapedVar}\\s*=\\s*STUFF\\(\\s*\\(\\s*SELECT\\s+(?:DISTINCT\\s+)?${stringLiteral}\\s*\\+\\s*${convertExpr}\\s+FROM\\s+([\\s\\S]*?)\\s+FOR\\s+XML\\s+PATH`,
      "i"
    )
  )
  if (!directMatch) return null

  const selectedExpression = directMatch[1]
  const selectedColumn = stripQualifier(selectedExpression)
  const fromClause = normalizeDynamicSqlInterpolations(directMatch[2])

  return {
    selectedColumn,
    query: `SELECT ${selectedExpression} AS [${selectedColumn}] FROM ${fromClause}`
  }
}

function substituteIdsQueryDependencies(query, body, cache, currentVar) {
  let resolved = query
  const refs = [...new Set([...resolved.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]))]
  for (const refVar of refs) {
    if (refVar === currentVar) continue
    const refQuery = resolveIdsQuery(body, refVar, cache)
    if (!refQuery) continue
    const selectColumn = stripQualifier(refQuery.selectedColumn)
    resolved = resolved.replace(
      new RegExp(`IN\\s*\\(\\s*@${escapeRegex(refVar)}\\s*\\)`, "gi"),
      `IN (SELECT [${selectColumn}] FROM (${refQuery.query}) AS __mia_dep_${refVar})`
    )
  }
  return normalizeSql(resolved)
}

function resolveIdsQuery(body, idsVar, cache = new Map()) {
  if (cache.has(idsVar)) return cache.get(idsVar)

  const ruleTreeQuery = resolveRuleTreeIdsQuery(body, idsVar)
  if (ruleTreeQuery) {
    cache.set(idsVar, ruleTreeQuery)
    return ruleTreeQuery
  }

  const concatQuery = resolveConcatIdsQuery(body, idsVar, cache)
  if (concatQuery) {
    cache.set(idsVar, concatQuery)
    return concatQuery
  }

  const directQuery = resolveDirectIdsQuery(body, idsVar)
  if (!directQuery) {
    cache.set(idsVar, null)
    return null
  }

  const resolved = {
    selectedColumn: directQuery.selectedColumn,
    query: substituteIdsQueryDependencies(directQuery.query, body, cache, idsVar)
  }
  cache.set(idsVar, resolved)
  return resolved
}

function resolveRuleFlowPredicate(call) {
  const tableRef = quoteTable(call.qualifiedName)
  switch (call.qualifiedName) {
    case "core.Rule":
    case "core.RuleColumn":
    case "core.RuleCondition":
    case "core.RuleLink":
      return (
        `EXISTS (SELECT 1 FROM [core].[fRule]({id}) AS __mia_scope ` +
        `WHERE __mia_scope.[ruleId] = ${tableRef}.[ruleId])`
      )
    case "core.RuleConditionValue":
      return (
        `EXISTS (SELECT 1 FROM [core].[RuleCondition] rc ` +
        `INNER JOIN [core].[fRule]({id}) AS __mia_scope ON __mia_scope.[ruleId] = rc.[ruleId] ` +
        `WHERE rc.[ruleConditionId] = ${tableRef}.[ruleConditionId])`
      )
    case "core.RuleType":
      return (
        `EXISTS (SELECT 1 FROM [core].[fRule]({id}) AS __mia_scope ` +
        `WHERE __mia_scope.[ruleTypeId] = ${tableRef}.[ruleTypeId])`
      )
    case "core.RuleLinkType":
      return (
        `EXISTS (SELECT 1 FROM [core].[RuleLink] rl ` +
        `INNER JOIN [core].[fRule]({id}) AS __mia_scope ON __mia_scope.[ruleId] = rl.[ruleId] ` +
        `WHERE rl.[ruleLinkTypeId] = ${tableRef}.[ruleLinkTypeId])`
      )
    case "core.Dataset":
    case "core.DatasetColumn":
      return (
        `EXISTS (SELECT 1 FROM [core].[fRule]({id}) AS __mia_scope ` +
        `WHERE __mia_scope.[inputDatasetId] = ${tableRef}.[datasetId] ` +
        `OR __mia_scope.[outputDatasetId] = ${tableRef}.[datasetId])`
      )
    case "core.DatasetMapping":
    case "core.DatasetMappingColumn":
      return (
        `EXISTS (SELECT 1 FROM [core].[DatasetMapping] dm ` +
        `INNER JOIN [core].[fRule]({id}) AS __mia_scope ` +
        `ON __mia_scope.[inputDatasetId] = dm.[datasetId_Left] ` +
        `OR __mia_scope.[outputDatasetId] = dm.[datasetId_Left] ` +
        `WHERE dm.[datasetMappingId] = ${tableRef}.[datasetMappingId])`
      )
    default:
      return null
  }
}

function resolveDatasetFlowPredicate(call) {
  const tableRef = quoteTable(call.qualifiedName)
  switch (call.qualifiedName.toLowerCase()) {
    case "core.dataset":
      return "datasetId = {id}"
    case "core.datasetcolumn":
      return "datasetId = {id}"
    case "core.datasetmapping":
      return "datasetId_Left = {id}"
    case "core.pipeline":
      return "datasetId = {id}"
    case "core.activity":
      return (
        `EXISTS (SELECT 1 FROM [core].[Pipeline] p ` +
        `WHERE p.[pipelineId] = ${tableRef}.[pipelineId] AND p.[datasetId] = {id})`
      )
    case "core.datasetmappingcolumn":
      return (
        `EXISTS (SELECT 1 FROM [core].[DatasetMapping] dm ` +
        `WHERE dm.[datasetMappingId] = ${tableRef}.[datasetMappingId] ` +
        `AND dm.[datasetId_Left] = {id})`
      )
    default:
      return null
  }
}

function resolveGateMetadataFlowPredicate(call) {
  const tableRef = quoteTable(call.qualifiedName)
  switch (call.qualifiedName.toLowerCase()) {
    case "gate.metatable":
      return null
    case "gate.metaview":
      return "tableId = {id}"
    case "gate.metacolumn":
      return (
        `EXISTS (SELECT 1 FROM [gate].[MetaView] mv ` +
        `WHERE mv.[viewId] = ${tableRef}.[viewId] AND mv.[tableId] = {id})`
      )
    case "gate.jsonschema":
      return (
        `EXISTS (SELECT 1 FROM [gate].[MetaColumn] mc ` +
        `INNER JOIN [gate].[MetaView] mv ON mv.[viewId] = mc.[viewId] ` +
        `WHERE mv.[tableId] = {id} AND mc.[jsonSchemaId] = ${tableRef}.[jsonSchemaId])`
      )
    default:
      return null
  }
}

function resolvePipelinePredicate(call, rootKey, entrySproc) {
  if (entrySproc === "core.uspSyncRuleObjectsTran") {
    const rulePredicate = resolveRuleFlowPredicate(call)
    if (rulePredicate) return rulePredicate
  }
  if (entrySproc === "core.uspSyncDatasetObjectsTran") {
    const datasetPredicate = resolveDatasetFlowPredicate(call)
    if (datasetPredicate) return datasetPredicate
  }
  if (entrySproc === "core.uspSyncDataListObjectsTran") {
    const gateMetadataPredicate = resolveGateMetadataFlowPredicate(call)
    if (gateMetadataPredicate) return gateMetadataPredicate
  }
  if (call.idsVar === rootKey) return `${call.idName} = {id}`
  if (!call.idsQuery || !call.idsSelectColumn) return null

  const scopeQuery = call.idsQuery.replace(new RegExp(`@${escapeRegex(rootKey)}\\b`, "gi"), "{id}")
  if (/@[A-Za-z][A-Za-z0-9_]*/.test(scopeQuery)) return null

  return (
    `EXISTS (SELECT 1 FROM (${scopeQuery}) AS __mia_scope ` +
    `WHERE __mia_scope.[${call.idsSelectColumn}] = ${quoteTable(call.qualifiedName)}.[${call.idName}])`
  )
}

export function extractSyncObjectCalls(body) {
  const hits = []
  const needle = /uspSyncObjectTran/gi
  let match
  while ((match = needle.exec(body)) !== null) {
    const start = match.index
    const chunk = body.slice(start, Math.min(body.length, match.index + 1400))
    const idName = chunk.match(/@idName\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    const idsExpression =
      chunk
        .match(/@ids\s*=\s*'''''+\s*([\s\S]*?)\s*\+\s*'''''/i)?.[1]
        ?.replace(/\s+/g, " ")
        .trim() ?? null
    const tableName = chunk.match(/@name\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    const schemaName = chunk.match(/@schema\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    if (!idName || !tableName || !schemaName) continue
    const idsVarMatch = idsExpression?.match(/@([A-Za-z][A-Za-z0-9_]*)/)
    hits.push({
      qualifiedName: `${schemaName}.${tableName}`,
      idName,
      idsExpression,
      idsVar: idsVarMatch ? idsVarMatch[1] : null
    })
  }

  const idsQueryCache = new Map()
  const idsQueries = new Map(
    [...new Set(hits.map((hit) => hit.idsVar).filter(Boolean))].map((idsVar) => [
      idsVar,
      resolveIdsQuery(body, idsVar, idsQueryCache)
    ])
  )

  return hits
    .filter(
      (hit, index, all) =>
        all.findIndex((other) => other.qualifiedName.toLowerCase() === hit.qualifiedName.toLowerCase()) ===
        index
    )
    .map((hit) => {
      const idsQuery = hit.idsVar ? (idsQueries.get(hit.idsVar) ?? null) : null
      return {
        ...hit,
        idsQuery: idsQuery?.query ?? null,
        idsSelectColumn: idsQuery?.selectedColumn ?? null
      }
    })
}

export function buildCatalogIndexFromQueryResults(columns, foreignKeys) {
  const tables = new Map()
  for (const row of columns) {
    const qualifiedName = `${row.schemaName}.${row.tableName}`
    const key = qualifiedName.toLowerCase()
    if (!tables.has(key)) {
      tables.set(key, {
        qualifiedName,
        schema: row.schemaName,
        name: row.tableName,
        columns: [],
        fkOutgoing: [],
        fkIncoming: []
      })
    }
    tables.get(key).columns.push({ name: row.columnName, isPK: Boolean(row.isPrimaryKey) })
  }
  for (const edge of foreignKeys) {
    const childKey = `${edge.childSchema}.${edge.childTable}`.toLowerCase()
    const parentKey = `${edge.parentSchema}.${edge.parentTable}`.toLowerCase()
    if (tables.has(childKey)) {
      tables.get(childKey).fkOutgoing.push({
        fromSchema: edge.childSchema,
        fromTable: edge.childTable,
        fromColumn: edge.childColumn,
        toSchema: edge.parentSchema,
        toTable: edge.parentTable,
        toColumn: edge.parentColumn
      })
    }
    if (tables.has(parentKey)) {
      tables.get(parentKey).fkIncoming.push({
        fromSchema: edge.childSchema,
        fromTable: edge.childTable,
        fromColumn: edge.childColumn,
        toSchema: edge.parentSchema,
        toTable: edge.parentTable,
        toColumn: edge.parentColumn
      })
    }
  }
  return { tables }
}

export function deriveSyncDefinitions(
  pipelines,
  catalogIndex,
  generatedAt,
  sourceArtifact = "deploy/sync/generators/refresh-from-legacy.mjs"
) {
  const fkEdges = buildFkEdges(catalogIndex)
  return pipelines.map((pipeline) =>
    deriveSyncDefinition(pipeline, catalogIndex, fkEdges, generatedAt, sourceArtifact)
  )
}

export function buildCatalogIndex(snapshot) {
  const tables = new Map()
  for (const table of snapshot.tables ?? []) {
    const qualifiedName = `${table.schema}.${table.name}`
    const columns = Array.isArray(table.columns) ? table.columns.map((column) => ({ ...column })) : []
    const fkOutgoing = Array.isArray(table.fkOutgoing)
      ? table.fkOutgoing.map((edge) => ({
          fromSchema: edge.fromSchema ?? table.schema,
          fromTable: edge.fromTable ?? table.name,
          fromColumn: edge.fromColumn,
          toSchema: edge.toSchema,
          toTable: edge.toTable,
          toColumn: edge.toColumn
        }))
      : []
    const fkIncoming = Array.isArray(table.fkIncoming)
      ? table.fkIncoming.map((edge) => ({
          fromSchema: edge.fromSchema,
          fromTable: edge.fromTable,
          fromColumn: edge.fromColumn,
          toSchema: edge.toSchema ?? table.schema,
          toTable: edge.toTable ?? table.name,
          toColumn: edge.toColumn
        }))
      : []
    tables.set(qualifiedName.toLowerCase(), {
      qualifiedName,
      schema: table.schema,
      name: table.name,
      columns,
      fkOutgoing,
      fkIncoming
    })
  }
  return { tables }
}

function deriveSyncDefinition(pipeline, catalogIndex, fkEdges, generatedAt, sourceArtifact) {
  const entrySproc = selectEntrySproc(pipeline)
  const hint = ENTRY_SPROC_HINTS[entrySproc]
  if (!hint) throw new Error(`Unsupported legacy entry stored procedure ${entrySproc}.`)
  const root = getTable(catalogIndex, hint.rootTable)
  const rootKey = findPrimaryKeyColumn(root)
  const labelColumn = findLabelColumn(root)
  const selfJoinColumn = findSelfJoinColumn(root, rootKey)
  const pipelineCalls = normalizePipelineCalls(
    (pipeline.syncObjectCalls ?? []).map((call) => ({ ...call, entrySproc })),
    rootKey
  )
  const fkTables = fkClosure(hint.rootTable, rootKey, fkEdges)
  const tables = reconcileTables(pipelineCalls, fkTables, entrySproc)
  const preferredOrder = [
    ...pipelineCalls.map((call) => canonicalizeQualifiedName(call.qualifiedName, catalogIndex)),
    ...tables.filter((table) => table.source === "fk-only").map((table) => table.name)
  ].filter((name, index, values) => values.indexOf(name) === index)
  const executionOrder = orderTablesByCatalogDependencies(preferredOrder, hint.rootTable, fkEdges)
  const reverseOrder = [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: hint.entityId,
    displayName: hint.displayName,
    description: `${hint.displayName} sync definition bootstrapped from legacy pipeline ground truth.`,
    rootTable: hint.rootTable,
    idColumn: rootKey,
    labelColumn,
    selfJoinColumn,
    legacy: {
      pipelineId: pipeline.pipelineId,
      entrySproc
    },
    governance: {
      approvalPolicyId: null,
      freezeWindowIds: []
    },
    strategy: {
      strategyId: "mymi-scd2",
      strategyVersion: "latest"
    },
    bindings: {
      serviceProfileRef: "default",
      environmentPolicyRef: "default"
    },
    ownership: {
      team: "sync-platform",
      owner: null,
      reviewStatus: tables.some((table) => !table.verified) ? "legacy-review-required" : "reviewed",
      notes: [
        "Bootstrapped from legacy pipeline ground truth.",
        tables.some((table) => !table.verified)
          ? "Contains FK-inferred optional scope that still needs deliberate review."
          : "All current legacy sync tables were derived directly from pipeline evidence."
      ]
    },
    metadata: {
      tables,
      executionOrder,
      reverseOrder,
      discrepancies: []
    },
    executionFlow: {
      steps: []
    },
    provenance: {
      kind: "legacy-migration",
      sourceArtifact,
      sourceVersion: generatedAt
    }
  }
}

function selectEntrySproc(pipeline) {
  const entry = (pipeline.activities ?? []).find(
    (activity) =>
      typeof activity.storedProcedure === "string" &&
      /^core\.uspSync.*ObjectsTran$/i.test(activity.storedProcedure)
  )
  if (!entry?.storedProcedure)
    throw new Error(`Pipeline ${pipeline.pipelineId} does not expose a legacy sync entry stored procedure.`)
  return entry.storedProcedure
}

function normalizePipelineCalls(calls, rootKey) {
  return calls.map((call) => ({
    ...call,
    predicate: resolvePipelinePredicate(call, rootKey, call.entrySproc)
  }))
}

function reconcileTables(pipelineCalls, fkTables, entrySproc) {
  const pipelineMap = new Map(pipelineCalls.map((call) => [call.qualifiedName.toLowerCase(), call]))
  const fkMap = new Map(
    [...fkTables.entries()].map(([name, info]) => [name.toLowerCase(), { name, ...info }])
  )
  const names = [...new Set([...pipelineMap.keys(), ...fkMap.keys()])]
  return names.map((name) => {
    const call = pipelineMap.get(name)
    const fkInfo = fkMap.get(name)
    if (call && fkInfo) {
      const resolvedFromPipeline = call.predicate !== null
      return {
        name: fkInfo.name,
        scopeColumn: call.idName ?? fkInfo.scopeColumn,
        predicate: resolvedFromPipeline ? call.predicate : fkInfo.predicate,
        source: resolvedFromPipeline ? "fk+pipeline" : "pipeline-only",
        verified: resolvedFromPipeline,
        groundedByPipeline: true,
        enabledByDefault: true,
        userControllable: false,
        note: resolvedFromPipeline
          ? undefined
          : `Predicate unresolved from legacy pipeline variable @${call.idsVar ?? "?"}. Verify against ${entrySproc} body.`
      }
    }
    if (call) {
      return {
        name: call.qualifiedName,
        scopeColumn: call.idName,
        predicate: call.predicate ?? `${call.idName} IN (/* review ${call.idsVar ?? "unknown"} */)`,
        source: "pipeline-only",
        verified: call.predicate !== null,
        groundedByPipeline: true,
        enabledByDefault: true,
        userControllable: false,
        note:
          call.predicate === null
            ? `Predicate unresolved from legacy pipeline variable @${call.idsVar ?? "?"}. Verify against ${entrySproc} body.`
            : undefined
      }
    }
    return {
      name: fkInfo.name,
      scopeColumn: fkInfo.scopeColumn,
      predicate: fkInfo.predicate,
      source: "fk-only",
      verified: false,
      groundedByPipeline: false,
      enabledByDefault: false,
      userControllable: true,
      note: `Predicate inferred from FK graph. Verify against ${entrySproc} body.`
    }
  })
}

function buildFkEdges(catalogIndex) {
  const edges = []
  for (const table of catalogIndex.tables.values()) {
    for (const fk of table.fkOutgoing) {
      if (!ALLOWED_SCHEMAS.has(fk.fromSchema) || !ALLOWED_SCHEMAS.has(fk.toSchema)) continue
      edges.push({
        parentSchema: fk.toSchema,
        parentTable: fk.toTable,
        parentColumn: fk.toColumn,
        childSchema: fk.fromSchema,
        childTable: fk.fromTable,
        childColumn: fk.fromColumn
      })
    }
  }
  return edges
}

function fkClosure(rootTable, rootKey, edges) {
  const adjacency = new Map()
  for (const edge of edges) {
    const parent = `${edge.parentSchema}.${edge.parentTable}`
    if (!adjacency.has(parent)) adjacency.set(parent, [])
    adjacency.get(parent).push({
      child: `${edge.childSchema}.${edge.childTable}`,
      childColumn: edge.childColumn,
      parentColumn: edge.parentColumn
    })
  }
  const visited = new Map()
  visited.set(rootTable, { scopeColumn: rootKey, predicate: `${rootKey} = {id}`, hasRootKey: true })
  const queue = [rootTable]
  while (queue.length) {
    const current = queue.shift()
    const currentInfo = visited.get(current)
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.child)) continue
      const [schemaName] = edge.child.split(".")
      if (!ALLOWED_SCHEMAS.has(schemaName)) continue
      let predicate
      let scopeColumn
      let hasRootKey
      if (edge.parentColumn === rootKey) {
        predicate = `${edge.childColumn} = {id}`
        scopeColumn = edge.childColumn
        hasRootKey = true
      } else if (currentInfo.hasRootKey) {
        predicate = `EXISTS (SELECT 1 FROM ${quoteTable(current)} p WHERE p.${edge.parentColumn} = ${quoteTable(edge.child)}.${edge.childColumn} AND p.${rootKey} = {id})`
        scopeColumn = null
        hasRootKey = false
      } else {
        predicate = `EXISTS (SELECT 1 FROM ${quoteTable(current)} p WHERE p.${edge.parentColumn} = ${quoteTable(edge.child)}.${edge.childColumn})`
        scopeColumn = null
        hasRootKey = false
      }
      visited.set(edge.child, { scopeColumn, predicate, hasRootKey })
      queue.push(edge.child)
    }
  }
  return visited
}

function quoteTable(qualifiedName) {
  const [schemaName, tableName] = qualifiedName.split(".")
  return `[${schemaName}].[${tableName}]`
}

function getTable(catalogIndex, qualifiedName) {
  const table = catalogIndex.tables.get(qualifiedName.toLowerCase())
  if (!table) throw new Error(`Table ${qualifiedName} not found in schema metadata.`)
  return table
}

function findPrimaryKeyColumn(table) {
  const pk = table.columns.find((column) => column.isPK)
  if (!pk) throw new Error(`Table ${table.qualifiedName} has no primary key metadata.`)
  return pk.name
}

function findLabelColumn(table) {
  const preferred = table.columns.find((column) => /^(name|title|displayName)$/i.test(column.name))
  return preferred?.name ?? findPrimaryKeyColumn(table)
}

function findSelfJoinColumn(table, rootKey) {
  const selfJoin = table.fkOutgoing.find(
    (edge) => edge.toSchema === table.schema && edge.toTable === table.name && edge.fromColumn !== rootKey
  )
  return selfJoin?.fromColumn ?? null
}

function canonicalizeQualifiedName(name, catalogIndex) {
  return catalogIndex.tables.get(name.toLowerCase())?.qualifiedName ?? name
}

function orderTablesByCatalogDependencies(names, rootTable, fkEdges) {
  const canonicalNames = [...new Set(names.map((name) => name.toLowerCase()))]
  const included = new Set(canonicalNames)
  const preferredIndex = new Map(names.map((name, index) => [name.toLowerCase(), index]))
  const outgoing = new Map()
  const indegree = new Map(canonicalNames.map((name) => [name, 0]))

  for (const edge of fkEdges) {
    const parent = `${edge.parentSchema}.${edge.parentTable}`.toLowerCase()
    const child = `${edge.childSchema}.${edge.childTable}`.toLowerCase()
    if (!included.has(parent) || !included.has(child) || parent === child) continue
    let children = outgoing.get(parent)
    if (!children) {
      children = new Set()
      outgoing.set(parent, children)
    }
    if (children.has(child)) continue
    children.add(child)
    indegree.set(child, (indegree.get(child) ?? 0) + 1)
  }

  const compare = (left, right) => {
    const leftRoot = left === rootTable.toLowerCase() ? -1 : 0
    const rightRoot = right === rootTable.toLowerCase() ? -1 : 0
    return (
      leftRoot - rightRoot ||
      (preferredIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (preferredIndex.get(right) ?? Number.MAX_SAFE_INTEGER) ||
      left.localeCompare(right)
    )
  }

  const ready = canonicalNames.filter((name) => (indegree.get(name) ?? 0) === 0).sort(compare)
  const ordered = []

  while (ready.length > 0) {
    const current = ready.shift()
    ordered.push(current)
    const children = outgoing.get(current)
    if (!children) continue
    for (const child of children) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1)
      if ((indegree.get(child) ?? 0) === 0) {
        ready.push(child)
        ready.sort(compare)
      }
    }
  }

  if (ordered.length !== canonicalNames.length) {
    const remaining = canonicalNames.filter((name) => !ordered.includes(name)).sort(compare)
    ordered.push(...remaining)
  }

  const canonicalToOriginal = new Map(names.map((name) => [name.toLowerCase(), name]))
  return ordered.map((name) => canonicalToOriginal.get(name) ?? name)
}
