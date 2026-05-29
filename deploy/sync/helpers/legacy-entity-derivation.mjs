const ALLOWED_SCHEMAS = new Set(["core", "coreArchive", "gate", "gateArchive", "master"])

const ENTRY_SPROC_HINTS = {
  "core.uspSyncContentObjectsTran": { entityId: "content", displayName: "Content", rootTable: "gate.Content" },
  "core.uspSyncDataListObjectsTran": { entityId: "gateMetadata", displayName: "Gate Metadata", rootTable: "gate.MetaTable" },
  "core.uspSyncCoreObjectsTran": { entityId: "contract", displayName: "Contract", rootTable: "core.Contract" },
  "core.uspSyncRuleObjectsTran": { entityId: "rule", displayName: "Rule", rootTable: "core.Rule" },
  "core.uspSyncDatasetObjectsTran": { entityId: "dataset", displayName: "Dataset", rootTable: "core.Dataset" },
  "core.uspSyncPipelineObjectsTran": { entityId: "pipelineActivity", displayName: "Pipeline & Activities", rootTable: "core.Pipeline" },
}

export function extractSyncObjectCalls(body) {
  const hits = []
  const needle = /uspSyncObjectTran/gi
  let match
  while ((match = needle.exec(body)) !== null) {
    const start = Math.max(0, match.index - 120)
    const chunk = body.slice(start, Math.min(body.length, match.index + 1400))
    const idName = chunk.match(/@idName\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    const idsExpression = chunk.match(/@ids\s*=\s*'''''+\s*([\s\S]*?)\s*\+\s*'''''/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null
    const tableName = chunk.match(/@name\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    const schemaName = chunk.match(/@schema\s*=\s*''''([^']+)''''/i)?.[1] ?? null
    if (!idName || !tableName || !schemaName) continue
    const idsVarMatch = idsExpression?.match(/@([A-Za-z][A-Za-z0-9_]*)/)
    hits.push({
      qualifiedName: `${schemaName}.${tableName}`,
      idName,
      idsExpression,
      idsVar: idsVarMatch ? idsVarMatch[1] : null,
    })
  }
  return hits.filter((hit, index, all) => all.findIndex((other) => other.qualifiedName.toLowerCase() === hit.qualifiedName.toLowerCase()) === index)
}

export function buildCatalogIndexFromQueryResults(columns, foreignKeys) {
  const tables = new Map()
  for (const row of columns) {
    const qualifiedName = `${row.schemaName}.${row.tableName}`
    const key = qualifiedName.toLowerCase()
    if (!tables.has(key)) {
      tables.set(key, { qualifiedName, schema: row.schemaName, name: row.tableName, columns: [], fkOutgoing: [], fkIncoming: [] })
    }
    tables.get(key).columns.push({ name: row.columnName, isPK: Boolean(row.isPrimaryKey) })
  }
  for (const edge of foreignKeys) {
    const childKey = `${edge.childSchema}.${edge.childTable}`.toLowerCase()
    const parentKey = `${edge.parentSchema}.${edge.parentTable}`.toLowerCase()
    if (tables.has(childKey)) {
      tables.get(childKey).fkOutgoing.push({ fromSchema: edge.childSchema, fromTable: edge.childTable, fromColumn: edge.childColumn, toSchema: edge.parentSchema, toTable: edge.parentTable, toColumn: edge.parentColumn })
    }
    if (tables.has(parentKey)) {
      tables.get(parentKey).fkIncoming.push({ fromSchema: edge.childSchema, fromTable: edge.childTable, fromColumn: edge.childColumn, toSchema: edge.parentSchema, toTable: edge.parentTable, toColumn: edge.parentColumn })
    }
  }
  return { tables }
}

export function deriveSyncDefinitions(pipelines, catalogIndex, generatedAt, sourceArtifact = "deploy/sync/generators/generate-entities-from-legacy-pipelines.mjs") {
  const fkEdges = buildFkEdges(catalogIndex)
  return pipelines.map((pipeline) => deriveSyncDefinition(pipeline, catalogIndex, fkEdges, generatedAt, sourceArtifact))
}

export function buildCatalogIndex(snapshot) {
  const tables = new Map()
  for (const table of snapshot.tables ?? []) {
    const qualifiedName = `${table.schema}.${table.name}`
    const columns = Array.isArray(table.columns)
      ? table.columns.map((column) => ({ ...column }))
      : []
    const fkOutgoing = Array.isArray(table.fkOutgoing)
      ? table.fkOutgoing.map((edge) => ({ ...edge }))
      : []
    const fkIncoming = Array.isArray(table.fkIncoming)
      ? table.fkIncoming.map((edge) => ({ ...edge }))
      : []
    tables.set(qualifiedName.toLowerCase(), {
      qualifiedName,
      schema: table.schema,
      name: table.name,
      columns,
      fkOutgoing,
      fkIncoming,
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
  const pipelineCalls = normalizePipelineCalls(pipeline.syncObjectCalls ?? [], rootKey)
  const fkTables = fkClosure(hint.rootTable, rootKey, fkEdges)
  const tables = reconcileTables(pipelineCalls, fkTables, entrySproc)
  const executionOrder = [...pipelineCalls.map((call) => canonicalizeQualifiedName(call.qualifiedName, catalogIndex)), ...tables.filter((table) => table.source === "fk-only").map((table) => table.name)]
    .filter((name, index, values) => values.indexOf(name) === index)
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
      entrySproc,
    },
    governance: {
      approvalPolicyId: null,
      freezeWindowIds: [],
      riskMultiplier: 1,
    },
    strategy: {
      strategyId: "mymi-scd2",
      strategyVersion: "latest",
    },
    bindings: {
      serviceProfileRef: "default",
      environmentPolicyRef: "default",
    },
    ownership: {
      team: "sync-platform",
      owner: null,
      reviewStatus: tables.some((table) => !table.verified) ? "legacy-review-required" : "reviewed",
      notes: [
        "Bootstrapped from legacy pipeline ground truth.",
        tables.some((table) => !table.verified) ? "Contains FK-inferred optional scope that still needs deliberate review." : "All current legacy sync tables were derived directly from pipeline evidence.",
      ],
    },
    metadata: {
      tables,
      executionOrder,
      reverseOrder,
      discrepancies: [],
    },
    executionFlow: {
      steps: [],
    },
    provenance: {
      kind: "legacy-migration",
      sourceArtifact,
      sourceVersion: generatedAt,
    },
  }
}

function selectEntrySproc(pipeline) {
  const entry = (pipeline.activities ?? []).find((activity) => typeof activity.storedProcedure === "string" && /^core\.uspSync.*ObjectsTran$/i.test(activity.storedProcedure))
  if (!entry?.storedProcedure) throw new Error(`Pipeline ${pipeline.pipelineId} does not expose a legacy sync entry stored procedure.`)
  return entry.storedProcedure
}

function normalizePipelineCalls(calls, rootKey) {
  return calls.map((call) => ({
    ...call,
    predicate: call.idsVar === rootKey ? `${call.idName} = {id}` : null,
  }))
}

function reconcileTables(pipelineCalls, fkTables, entrySproc) {
  const pipelineMap = new Map(pipelineCalls.map((call) => [call.qualifiedName.toLowerCase(), call]))
  const fkMap = new Map([...fkTables.entries()].map(([name, info]) => [name.toLowerCase(), { name, ...info }]))
  const names = [...new Set([...pipelineMap.keys(), ...fkMap.keys()])]
  return names.map((name) => {
    const call = pipelineMap.get(name)
    const fkInfo = fkMap.get(name)
    if (call && fkInfo) {
      return {
        name: fkInfo.name,
        scopeColumn: fkInfo.scopeColumn ?? call.idName,
        predicate: fkInfo.predicate,
        source: "fk+pipeline",
        verified: true,
        groundedByPipeline: true,
        enabledByDefault: true,
        userControllable: false,
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
        note: call.predicate === null ? `Predicate unresolved from legacy pipeline variable @${call.idsVar ?? "?"}. Verify against ${entrySproc} body.` : undefined,
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
      note: `Predicate inferred from FK graph. Verify against ${entrySproc} body.`,
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
        childColumn: fk.fromColumn,
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
    adjacency.get(parent).push({ child: `${edge.childSchema}.${edge.childTable}`, childColumn: edge.childColumn, parentColumn: edge.parentColumn })
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
  const selfJoin = table.fkOutgoing.find((edge) => edge.toSchema === table.schema && edge.toTable === table.name && edge.fromColumn !== rootKey)
  return selfJoin?.fromColumn ?? null
}

function canonicalizeQualifiedName(name, catalogIndex) {
  return catalogIndex.tables.get(name.toLowerCase())?.qualifiedName ?? name
}