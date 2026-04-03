/**
 * Seed the AgentDWH test database.
 *
 * Usage: npx tsx deploy/mssql/seed.ts
 *
 * Reads seed-dwh.sql, splits on GO, and executes each batch.
 */

import sql from "mssql"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const config: sql.config = {
  server: process.env["MSSQL_HOST"] ?? "localhost",
  port: Number(process.env["MSSQL_PORT"] ?? 1433),
  user: process.env["MSSQL_USER"] ?? "sa",
  password: process.env["MSSQL_PASSWORD"] ?? "Agent001_Test!",
  database: "master",
  options: { encrypt: true, trustServerCertificate: true },
  requestTimeout: 60_000,
}

async function main() {
  console.log(`Connecting to ${config.server}:${config.port}...`)

  // Phase 1: connect to master, ensure database exists
  const masterPool = new sql.ConnectionPool(config)
  await masterPool.connect()
  console.log("Connected to master.")

  await masterPool.request().query(`
    IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'AgentDWH')
      CREATE DATABASE AgentDWH;
  `)
  console.log("Database AgentDWH ensured.")
  await masterPool.close()

  // Phase 2: reconnect directly to AgentDWH
  const dwhPool = new sql.ConnectionPool({ ...config, database: "AgentDWH" })
  await dwhPool.connect()
  console.log("Connected to AgentDWH.")

  const sqlFile = readFileSync(resolve(new URL(".", import.meta.url).pathname, "seed-dwh.sql"), "utf-8")

  // Split on GO statements (must be on their own line)
  // Skip the CREATE DATABASE and USE batches — we already handled them
  const batches = sqlFile
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .filter((b) => !/^\s*(IF NOT EXISTS.*CREATE DATABASE|USE\s+AgentDWH)/i.test(b))

  console.log(`Executing ${batches.length} batches...`)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const preview = batch.slice(0, 80).replace(/\n/g, " ")
    try {
      await dwhPool.request().query(batch)
      console.log(`  [${i + 1}/${batches.length}] OK — ${preview}...`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  [${i + 1}/${batches.length}] FAIL — ${preview}`)
      console.error(`    Error: ${msg}`)
    }
  }

  // Verify
  const result = await dwhPool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `)
  console.log("\n✅ Tables created:")
  for (const row of result.recordset) {
    console.log(`  ${row.TABLE_SCHEMA}.${row.TABLE_NAME} (${row.TABLE_TYPE})`)
  }

  // Row counts
  const counts = await dwhPool.request().query(`
    SELECT 'dwh.DimDate' AS t, COUNT(*) AS c FROM dwh.DimDate
    UNION ALL SELECT 'dwh.DimCustomer', COUNT(*) FROM dwh.DimCustomer
    UNION ALL SELECT 'dwh.DimProduct', COUNT(*) FROM dwh.DimProduct
    UNION ALL SELECT 'dwh.DimStore', COUNT(*) FROM dwh.DimStore
    UNION ALL SELECT 'dwh.FactSales', COUNT(*) FROM dwh.FactSales
    UNION ALL SELECT 'dwh.FactInventory', COUNT(*) FROM dwh.FactInventory
    UNION ALL SELECT 'staging.RawSalesImport', COUNT(*) FROM staging.RawSalesImport
    UNION ALL SELECT 'meta.ETLJobLog', COUNT(*) FROM meta.ETLJobLog
  `)
  console.log("\n📊 Row counts:")
  for (const row of counts.recordset) {
    console.log(`  ${row.t}: ${row.c}`)
  }

  await dwhPool.close()
  console.log("\nDone.")
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
