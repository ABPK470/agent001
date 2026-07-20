/**
 * adapters/drivers.ts — default driver implementations wrapping the real
 * `mssql` and `pg` / `pg-query-stream` drivers.
 *
 * These are the production bindings, exercised against live backends. The
 * adapter unit tests use mock drivers instead (see tests/adapters/*.test.ts),
 * so a live SQL Server / Postgres is not required to verify the framework.
 */

import sql from "mssql"
import QueryStream from "pg-query-stream"
import { Readable, Writable } from "node:stream"
import type { Pool, PoolClient } from "pg"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { BlobServiceClient } from "@azure/storage-blob"
import { Client as FtpClient } from "basic-ftp"
import type { Connector, MoveSummary, Row } from "@mia/shared-types"
import { makeSummary } from "../engine.js"
import {
  quoteMssqlIdent,
  quoteMssqlTable,
  quotePgIdent,
  quotePgTable,
} from "../sql-idents.js"
import type { MssqlDriver, MssqlTransaction } from "./mssql.js"
import type {
  PostgresDriver,
  PostgresInsertOptions,
  PostgresTransaction,
} from "./postgres.js"
import type { DenodoDriver } from "./denodo.js"
import type { HttpDriver } from "./http-api.js"
import type { WebHdfsDriver } from "./webhdfs.js"
import type { AqueductDriver } from "./aqueduct.js"
import type { DatabricksDriver } from "./databricks.js"
import type { FileTransferDriver } from "./object-file.js"

type RowBatch = Row[]

// ── mssql ───────────────────────────────────────────────────────

export function defaultMssqlDriver(pool: sql.ConnectionPool): MssqlDriver {
  return {
    async *streamQuery(querySql, batchSize) {
      const request = new sql.Request(pool)
      request.stream = true
      const queue: RowBatch[] = []
      let resolveNext: (() => void) | null = null
      let finished = false
      let finishErr: Error | null = null
      const waitNext = () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      request.on("row", (row) => {
        if (queue.length === 0) queue.push([])
        queue[queue.length - 1]!.push(row as Row)
        if (queue[queue.length - 1]!.length >= batchSize) queue.push([])
        if (resolveNext) {
          const fn = resolveNext
          resolveNext = null
          fn()
        }
      })
      request.on("done", () => {
        finished = true
        if (resolveNext) {
          const fn = resolveNext
          resolveNext = null
          fn()
        }
      })
      request.on("error", (e) => {
        finishErr = e instanceof Error ? e : new Error(String(e))
        finished = true
        if (resolveNext) {
          const fn = resolveNext
          resolveNext = null
          fn()
        }
      })
      request.query(querySql)
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!
        } else if (finished) {
          if (finishErr) throw finishErr
          return
        } else {
          await waitNext()
        }
      }
    },
    async beginTransaction() {
      // pool.transaction() only constructs; node-mssql requires begin() before Request.
      const txCtx = pool.transaction()
      await txCtx.begin()
      return makeMssqlTransaction(pool, txCtx)
    },
    async insertBatches(table, rows) {
      return mssqlInsertBatches(pool, null, table, rows)
    },
    async close() {
      // Pools are owned by the boot host; do not close here.
    },
  }
}

function makeMssqlTransaction(pool: sql.ConnectionPool, txCtx: sql.Transaction): MssqlTransaction {
  return {
    async truncate(table) {
      await new sql.Request(txCtx).query(`TRUNCATE TABLE ${quoteMssqlTable(table)}`)
    },
    async setIdentityInsert(table, on) {
      const flag = on ? "ON" : "OFF"
      await new sql.Request(txCtx).query(`SET IDENTITY_INSERT ${quoteMssqlTable(table)} ${flag}`)
    },
    async setConstraintsChecked(table, checked) {
      const verb = checked ? "CHECK" : "NOCHECK"
      await new sql.Request(txCtx).query(
        `ALTER TABLE ${quoteMssqlTable(table)} ${verb} CONSTRAINT ALL`,
      )
    },
    async insertBatches(table, rows) {
      return mssqlInsertBatches(pool, txCtx, table, rows)
    },
    async commit() {
      await txCtx.commit()
    },
    async rollback() {
      await txCtx.rollback()
    },
  }
}

async function mssqlInsertBatches(
  pool: sql.ConnectionPool,
  txCtx: sql.Transaction | null,
  table: string,
  rows: AsyncGenerator<RowBatch>,
): Promise<MoveSummary> {
  let rowsWritten = 0
  for await (const batch of rows) {
    if (batch.length === 0) continue
    const cols = Object.keys(batch[0]!)
    const values = batch
      .map((r) => `(${cols.map((c) => quoteLit(r[c])).join(",")})`)
      .join(",")
    const stmt = `INSERT INTO ${quoteMssqlTable(table)} (${cols.map(quoteMssqlIdent).join(",")}) VALUES ${values}`
    const req = txCtx ? new sql.Request(txCtx) : new sql.Request(pool)
    await req.query(stmt)
    rowsWritten += batch.length
  }
  return makeSummary("completed", rowsWritten, rowsWritten, [], null)
}

// ── postgres ────────────────────────────────────────────────────

export function defaultPostgresDriver(pool: Pool): PostgresDriver {
  return {
    async *streamQuery(querySql, batchSize) {
      const client = await pool.connect()
      try {
        const stream = client.query(new QueryStream(querySql, [], { batchSize }))
        let batch: Row[] = []
        for await (const row of stream as AsyncIterable<Row>) {
          batch.push(row)
          if (batch.length >= batchSize) {
            yield batch
            batch = []
          }
        }
        if (batch.length > 0) yield batch
      } finally {
        client.release()
      }
    },
    async beginTransaction() {
      const client = await pool.connect()
      await client.query("BEGIN")
      return makePostgresTransaction(client)
    },
    async insertBatches(table, rows, options) {
      return pgInsertBatches(pool, table, rows, options)
    },
    async close() {
      await pool.end()
    },
  }
}

function makePostgresTransaction(client: PoolClient): PostgresTransaction {
  return {
    async truncate(table) {
      await client.query(`TRUNCATE TABLE ${quotePgTable(table)}`)
    },
    async setReplicationRole(replica) {
      await client.query(
        replica
          ? "SET LOCAL session_replication_role = replica"
          : "SET LOCAL session_replication_role = DEFAULT",
      )
    },
    async insertBatches(table, rows, options) {
      return pgInsertBatches(client, table, rows, options)
    },
    async commit() {
      await client.query("COMMIT")
      client.release()
    },
    async rollback() {
      await client.query("ROLLBACK")
      client.release()
    },
  }
}

async function pgInsertBatches(
  db: Pool | PoolClient,
  table: string,
  rows: AsyncGenerator<RowBatch>,
  options?: PostgresInsertOptions,
): Promise<MoveSummary> {
  let rowsWritten = 0
  const overriding = options?.overridingSystemValue ? " OVERRIDING SYSTEM VALUE" : ""
  for await (const batch of rows) {
    if (batch.length === 0) continue
    const cols = Object.keys(batch[0]!)
    const paramRows = batch.map(
      (_, i) => `(${cols.map((_, c) => `$${i * cols.length + c + 1}`).join(",")})`,
    )
    const values = batch.flatMap((r) => cols.map((c) => r[c]))
    const stmt =
      `INSERT INTO ${quotePgTable(table)} (${cols.map(quotePgIdent).join(",")})` +
      `${overriding} VALUES ${paramRows.join(",")}`
    await db.query(stmt, values)
    rowsWritten += batch.length
  }
  return makeSummary("completed", rowsWritten, rowsWritten, [], null)
}

// ── shared SQL helpers ──────────────────────────────────────────

function quoteLit(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

// ── httpApi ─────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function parseExtraHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v)
      }
      return out
    }
  } catch {
    /* ignore malformed headers JSON */
  }
  return {}
}

/** Build a fetch-based HTTP driver from a persisted httpApi connector. */
export function defaultHttpDriver(connector: Connector): HttpDriver {
  const baseUrl = asString(connector.config["baseUrl"]) ?? ""
  const apiKey = asString(connector.config["apiKey"])
  const baseHeaders = parseExtraHeaders(connector.config["headers"])
  return {
    async request(method, path, body, headers) {
      const url = joinUrl(baseUrl, path)
      const finalHeaders: Record<string, string> = { ...baseHeaders, ...(headers ?? {}) }
      if (apiKey && !finalHeaders["Authorization"] && !finalHeaders["authorization"]) {
        finalHeaders["Authorization"] = `Bearer ${apiKey}`
      }
      const init: RequestInit = { method, headers: finalHeaders }
      if (body !== undefined && method !== "GET") {
        init.body = typeof body === "string" ? body : JSON.stringify(body)
        if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
          finalHeaders["Content-Type"] = "application/json"
        }
      }
      const res = await fetch(url, init)
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`httpApi ${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
      }
      const ct = res.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) return await res.json()
      const text = await res.text()
      if (text === "") return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    },
    async close() {
      /* stateless */
    },
  }
}

// ── denodo ──────────────────────────────────────────────────────

/** Build a fetch-based Denodo REST driver from a persisted denodo connector. */
export function defaultDenodoDriver(connector: Connector): DenodoDriver {
  const baseUrl = asString(connector.config["baseUrl"]) ?? ""
  const user = asString(connector.config["user"])
  const password = asString(connector.config["password"])
  const auth =
    user !== undefined || password !== undefined
      ? "Basic " + Buffer.from(`${user ?? ""}:${password ?? ""}`).toString("base64")
      : undefined
  return {
    async get(view, params) {
      const qs = params && Object.keys(params).length > 0
        ? "?" + new URLSearchParams(params).toString()
        : ""
      const url = joinUrl(baseUrl, `/server/${view}${qs}`)
      const init: RequestInit = { method: "GET" }
      if (auth) init.headers = { Authorization: auth }
      const res = await fetch(url, init)
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`denodo GET ${view} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
      }
      return await res.json()
    },
    async close() {
      /* stateless */
    },
  }
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  const b = base.replace(/\/+$/, "")
  const p = path.startsWith("/") ? path : `/${path}`
  return `${b}${p}`
}

// ── webhdfs ─────────────────────────────────────────────────────

/** Build a fetch-based WebHDFS driver from a persisted webhdfs connector. */
export function defaultWebhdfsDriver(connector: Connector): WebHdfsDriver {
  const host = asString(connector.config["host"]) ?? ""
  const port = asNumber(connector.config["port"]) ?? 50070
  const ssl = asBoolean(connector.config["ssl"], false)
  const user = asString(connector.config["user"])
  const token = asString(connector.config["token"])
  const base = `${ssl ? "https" : "http"}://${host}:${port}/webhdfs/v1`

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const userParam = user ? `&user.name=${encodeURIComponent(user)}` : ""
  const normPath = (p: string) => (p.startsWith("/") ? p : `/${p}`)

  async function readBytes(path: string): Promise<Uint8Array> {
    const url = `${base}${normPath(path)}?op=OPEN${userParam}`
    const res = await fetch(url, { method: "GET", headers: authHeaders, redirect: "follow" })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`webhdfs OPEN ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    async readText(path) {
      return new TextDecoder().decode(await readBytes(path))
    },
    readBytes,
    async putText(path, mode, body) {
      const op = mode === "replace" ? "CREATE&overwrite=true" : "APPEND"
      const url = `${base}${normPath(path)}?op=${op}${userParam}`
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", ...authHeaders },
        body,
        redirect: "follow",
        duplex: "half",
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`webhdfs ${op.split("&")[0]} ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
      }
      await res.text().catch(() => {})
    },
    async putBytes(path, _mode, body) {
      const url = `${base}${normPath(path)}?op=CREATE&overwrite=true${userParam}`
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", ...authHeaders },
        body,
        redirect: "follow",
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`webhdfs CREATE ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
      }
      await res.text().catch(() => {})
    },
    async close() {
      /* stateless */
    },
  }
}

// ── aws (S3) ────────────────────────────────────────────────────

export function defaultAwsDriver(connector: Connector): FileTransferDriver {
  const region = asString(connector.config["region"]) ?? "us-east-1"
  const bucket = asString(connector.config["bucket"]) ?? ""
  const accessKeyId = asString(connector.config["accessKeyId"]) ?? ""
  const secretAccessKey = asString(connector.config["secretAccessKey"]) ?? ""
  const client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })

  return {
    async readText(path) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizeKey(path) }))
      return (await res.Body?.transformToString()) ?? ""
    },
    async readBytes(path) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizeKey(path) }))
      const bytes = await res.Body?.transformToByteArray()
      return bytes ? new Uint8Array(bytes) : new Uint8Array()
    },
    async putText(path, mode, body) {
      const key = normalizeKey(path)
      if (mode === "replace") {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
        return
      }
      let existing = ""
      try {
        const cur = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        existing = (await cur.Body?.transformToString()) ?? ""
      } catch {
        /* new object */
      }
      const merged = Readable.from(concatTextStream(existing, body))
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: merged }))
    },
    async putBytes(path, _mode, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: normalizeKey(path),
          Body: body,
          ContentType: "application/vnd.apache.parquet",
        }),
      )
    },
    async close() {
      client.destroy()
    },
  }
}

// ── azure (Blob) ────────────────────────────────────────────────

export function defaultAzureDriver(connector: Connector): FileTransferDriver {
  const connectionString = asString(connector.config["connectionString"])
  const container = asString(connector.config["container"]) ?? ""
  if (!connectionString) throw new Error("azure connector requires connectionString in config")
  const service = BlobServiceClient.fromConnectionString(connectionString)
  const containerClient = service.getContainerClient(container)

  return {
    async readText(path) {
      const blob = containerClient.getBlockBlobClient(normalizeKey(path))
      const buf = await blob.downloadToBuffer()
      return buf.toString("utf8")
    },
    async readBytes(path) {
      const blob = containerClient.getBlockBlobClient(normalizeKey(path))
      const buf = await blob.downloadToBuffer()
      return new Uint8Array(buf)
    },
    async putText(path, mode, body) {
      const blob = containerClient.getBlockBlobClient(normalizeKey(path))
      if (mode === "replace") {
        await blob.uploadStream(Readable.fromWeb(body))
        return
      }
      let existing = ""
      try {
        existing = (await blob.downloadToBuffer()).toString("utf8")
      } catch {
        /* new blob */
      }
      const merged = Readable.from(concatTextStream(existing, body))
      await blob.uploadStream(merged)
    },
    async putBytes(path, _mode, body) {
      const blob = containerClient.getBlockBlobClient(normalizeKey(path))
      await blob.uploadData(body, {
        blobHTTPHeaders: { blobContentType: "application/vnd.apache.parquet" },
      })
    },
    async close() {
      /* stateless */
    },
  }
}

// ── ftp / sftp ──────────────────────────────────────────────────

export function defaultFtpDriver(connector: Connector): FileTransferDriver {
  const host = asString(connector.config["host"]) ?? ""
  const port = asNumber(connector.config["port"]) ?? 21
  const user = asString(connector.config["username"]) ?? ""
  const password = asString(connector.config["password"]) ?? ""
  const secure = asBoolean(connector.config["secure"], false)
  const baseDir = asString(connector.config["path"]) ?? ""

  return {
    async readText(path) {
      const bytes = await readFtpBytes(host, port, user, password, secure, baseDir, path)
      return new TextDecoder().decode(bytes)
    },
    async readBytes(path) {
      return readFtpBytes(host, port, user, password, secure, baseDir, path)
    },
    async putText(path, mode, body) {
      const client = new FtpClient()
      try {
        await client.access({ host, port, user, password, secure })
        if (baseDir) await client.cd(baseDir)
        const remote = remotePath(path)
        if (mode === "append") {
          let existing = ""
          try {
            const chunks: Buffer[] = []
            const writable = new Writable({
              write(chunk, _enc, cb) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                cb()
              },
            })
            await client.downloadTo(writable, remote)
            existing = Buffer.concat(chunks).toString("utf8")
          } catch {
            /* new file */
          }
          const merged = Readable.from(concatTextStream(existing, body))
          await client.uploadFrom(merged, remote)
          return
        }
        await client.uploadFrom(Readable.fromWeb(body), remote)
      } finally {
        client.close()
      }
    },
    async putBytes(path, _mode, body) {
      const client = new FtpClient()
      try {
        await client.access({ host, port, user, password, secure })
        if (baseDir) await client.cd(baseDir)
        await client.uploadFrom(Readable.from([Buffer.from(body)]), remotePath(path))
      } finally {
        client.close()
      }
    },
    async close() {
      /* per-call client */
    },
  }
}

async function readFtpBytes(
  host: string,
  port: number,
  user: string,
  password: string,
  secure: boolean,
  baseDir: string,
  path: string,
): Promise<Uint8Array> {
  const client = new FtpClient()
  try {
    await client.access({ host, port, user, password, secure })
    if (baseDir) await client.cd(baseDir)
    const chunks: Buffer[] = []
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        cb()
      },
    })
    await client.downloadTo(writable, remotePath(path))
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    client.close()
  }
}

// ── databricks (SQL Statements API) ───────────────────────────

export function defaultDatabricksDriver(connector: Connector): DatabricksDriver {
  const host = (asString(connector.config["host"]) ?? "").replace(/\/+$/, "")
  const token = asString(connector.config["token"]) ?? ""
  const httpPath = asString(connector.config["httpPath"]) ?? ""
  const catalog = asString(connector.config["catalog"])
  const warehouseId = warehouseIdFromHttpPath(httpPath)

  async function executeSql(sql: string): Promise<Row[]> {
    const res = await fetch(`${host}/api/2.0/sql/statements`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouse_id: warehouseId,
        statement: sql,
        wait_timeout: "50s",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        ...(catalog ? { catalog } : {}),
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`databricks SQL → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`)
    }
    const payload = (await res.json()) as DatabricksStatementResponse
    const state = payload.status?.state
    if (state !== "SUCCEEDED") {
      throw new Error(`databricks SQL failed: ${state ?? "unknown"} — ${payload.status?.error?.message ?? ""}`)
    }
    return rowsFromDatabricksResult(payload)
  }

  return {
    async *streamQuery(sql, batchSize) {
      const rows = await executeSql(sql)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize)
      }
    },
    async insertBatches(table, mode, rows) {
      if (mode === "replace") {
        await executeSql(`TRUNCATE TABLE ${quotePgTable(table)}`)
      }
      let rowsWritten = 0
      for await (const batch of rows) {
        if (batch.length === 0) continue
        const cols = Object.keys(batch[0]!)
        const values = batch
          .map((r) => `(${cols.map((c) => quoteLit(r[c])).join(",")})`)
          .join(",")
        const stmt = `INSERT INTO ${quotePgTable(table)} (${cols.map(quotePgIdent).join(",")}) VALUES ${values}`
        await executeSql(stmt)
        rowsWritten += batch.length
      }
      return makeSummary("completed", rowsWritten, rowsWritten, [], null)
    },
    async close() {
      /* stateless */
    },
  }
}

// ── aqueduct ────────────────────────────────────────────────────

const DEFAULT_AQUEDUCT_BASE = "https://api.aqueducthq.com"

export function defaultAqueductDriver(connector: Connector): AqueductDriver {
  const baseUrl = (asString(connector.config["baseUrl"]) ?? DEFAULT_AQUEDUCT_BASE).replace(/\/+$/, "")
  const apiKey = asString(connector.config["apiKey"]) ?? ""
  const pipelineId = asString(connector.config["pipelineId"]) ?? ""

  return {
    async fetchPreview(params) {
      const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : ""
      const url = `${baseUrl}/api/v1/preview/${encodeURIComponent(pipelineId)}${qs}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`aqueduct preview → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`)
      }
      const json = await res.json()
      if (Array.isArray(json)) return json as Row[]
      if (json && typeof json === "object" && Array.isArray((json as { rows?: unknown }).rows)) {
        return (json as { rows: Row[] }).rows
      }
      if (json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)) {
        return (json as { data: Row[] }).data
      }
      throw new Error("aqueduct preview: expected a JSON array of rows")
    },
    async close() {
      /* stateless */
    },
  }
}

// ── object-file helpers ─────────────────────────────────────────

function normalizeKey(path: string): string {
  return path.replace(/^\/+/, "")
}

function remotePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`
}

async function* concatTextStream(prefix: string, body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder()
  if (prefix) yield enc.encode(prefix)
  const reader = body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) yield value
  }
}

interface DatabricksStatementResponse {
  status?: { state?: string; error?: { message?: string } }
  manifest?: { schema?: { columns?: Array<{ name?: string }> } }
  result?: { data_array?: unknown[][] }
}

function warehouseIdFromHttpPath(httpPath: string): string {
  const parts = httpPath.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? httpPath
}

function rowsFromDatabricksResult(payload: DatabricksStatementResponse): Row[] {
  const cols = payload.manifest?.schema?.columns?.map((c) => c.name ?? "") ?? []
  const data = payload.result?.data_array ?? []
  return data.map((arr) => {
    const row: Row = {}
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]!] = arr[i] as Row[string]
    }
    return row
  })
}
