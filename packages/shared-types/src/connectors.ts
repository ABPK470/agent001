/**
 * Connectors — typed connections to external data sources.
 *
 * A connector is a UI-managed, persisted connection to an external system
 * (MSSQL, postgres, oracle, databricks, object stores, HTTP, …). Each
 * connector instance belongs to a `kind`; each kind declares the config
 * fields its create/edit form renders and the server validates against.
 *
 * Storage: SQLite `connectors` table (plaintext body_json, admin-only API).
 * Seeding: `deploy/connectors/connectors.json` if present; else synthesise
 * one `mssql` connector per MSSQL connection registered at boot (the
 * migration bridge that lets the DB become the source of truth).
 */

export type ConnectorKindId =
  | "mssql"
  | "postgres"
  | "oracle"
  | "databricks"
  | "azure"
  | "aws"
  | "denodo"
  | "httpApi"
  | "ftp"
  | "aqueduct"
  | "hive"
  | "webhdfs"

export type ConnectorConfigFieldType = "text" | "password" | "number" | "boolean" | "url"

export interface ConnectorConfigField {
  /** Stable key used inside `config`. */
  key: string
  label: string
  type: ConnectorConfigFieldType
  required?: boolean
  placeholder?: string
  help?: string
  default?: string | number | boolean
}

export interface ConnectorKind {
  id: ConnectorKindId
  displayName: string
  /** Short roadmap note shown under greyed-out kinds. */
  description: string
  /** Lucide icon name — UI maps it to a component. */
  icon: string
  /** When false, the kind is visible but not creatable (greyed out). */
  enabled: boolean
  configSchema: ConnectorConfigField[]
}

export interface Connector {
  /** Stable unique slug (kebab-case). */
  id: string
  kind: ConnectorKindId
  name: string
  displayName: string
  /** Kind-specific config values keyed by `ConnectorConfigField.key`. */
  config: Record<string, string | number | boolean | null>
  enabled: boolean
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

/**
 * Connector as returned by the admin API. Secret (password) fields are
 * masked with {@link SECRET_MASK} so the wire payload never echoes a
 * stored secret unless the caller explicitly requests export with secrets.
 */
export interface ConnectorAdmin extends Omit<Connector, "config"> {
  config: Record<string, string | number | boolean | null>
  kindEnabled: boolean
  builtIn?: boolean
}

/** Sentinel substituted for secret values in API responses. */
export const SECRET_MASK = "••••••••"

const mssqlConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com" },
  { key: "port", label: "Port", type: "number", default: 1433 },
  { key: "database", label: "Database", type: "text", required: true, placeholder: "master" },
  { key: "user", label: "User", type: "text", default: "sa" },
  { key: "password", label: "Password", type: "password" },
  { key: "domain", label: "Domain (AD)", type: "text" },
  { key: "encrypt", label: "Encrypt", type: "boolean", default: true },
  { key: "trustServerCertificate", label: "Trust server certificate", type: "boolean", default: true },
  { key: "knowledgePath", label: "Knowledge file path", type: "text", placeholder: "./deploy/mssql/mymi-knowledge.md", help: "Optional markdown loaded as SQL-generation guidance for this connection." },
]

const postgresConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "Host", type: "text", required: true },
  { key: "port", label: "Port", type: "number", default: 5432 },
  { key: "database", label: "Database", type: "text", required: true },
  { key: "user", label: "User", type: "text" },
  { key: "password", label: "Password", type: "password" },
  { key: "ssl", label: "SSL", type: "boolean", default: false },
]

const oracleConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com" },
  { key: "port", label: "Port", type: "number", default: 1521 },
  {
    key: "serviceName",
    label: "Service name",
    type: "text",
    required: true,
    placeholder: "ORCL",
    help: "Oracle service name (EZCONNECT). Prefer service name over SID.",
  },
  { key: "user", label: "User", type: "text", required: true },
  { key: "password", label: "Password", type: "password" },
  {
    key: "connectString",
    label: "Connect string (optional override)",
    type: "text",
    placeholder: "host:1521/ORCL",
    help: "When set, used instead of host/port/service name (full Easy Connect or TNS).",
  },
]

const databricksConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "Workspace URL", type: "url", required: true, placeholder: "https://dbc-….cloud.databricks.com" },
  { key: "httpPath", label: "SQL warehouse HTTP path", type: "text", required: true, placeholder: "/sql/1.0/warehouses/…" },
  { key: "token", label: "Personal access token", type: "password", required: true },
  { key: "catalog", label: "Catalog", type: "text" },
]

const azureConfigSchema: ConnectorConfigField[] = [
  { key: "account", label: "Storage account", type: "text", required: true },
  { key: "container", label: "Container", type: "text", required: true },
  { key: "connectionString", label: "Connection string", type: "password" },
]

const awsConfigSchema: ConnectorConfigField[] = [
  { key: "region", label: "Region", type: "text", required: true, placeholder: "us-east-1" },
  { key: "accessKeyId", label: "Access key id", type: "text", required: true },
  { key: "secretAccessKey", label: "Secret access key", type: "password", required: true },
  { key: "bucket", label: "Bucket", type: "text", required: true },
]

const denodoConfigSchema: ConnectorConfigField[] = [
  { key: "baseUrl", label: "Server URL", type: "url", required: true },
  { key: "user", label: "User", type: "text" },
  { key: "password", label: "Password", type: "password" },
]

const httpApiConfigSchema: ConnectorConfigField[] = [
  { key: "baseUrl", label: "Base URL", type: "url", required: true },
  { key: "apiKey", label: "API key", type: "password" },
  { key: "headers", label: "Extra headers (JSON)", type: "text", placeholder: "{\"X-Tenant\":\"acme\"}" },
]

const ftpConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "Host", type: "text", required: true },
  { key: "port", label: "Port", type: "number", default: 21 },
  { key: "username", label: "Username", type: "text" },
  { key: "password", label: "Password", type: "password" },
  { key: "path", label: "Default remote directory", type: "text", placeholder: "/exports" },
  { key: "secure", label: "Use SFTP (SSH)", type: "boolean", default: false },
]

const aqueductConfigSchema: ConnectorConfigField[] = [
  { key: "baseUrl", label: "API URL", type: "url", placeholder: "https://api.aqueducthq.com" },
  { key: "apiKey", label: "API key", type: "password", required: true },
  { key: "pipelineId", label: "Pipeline id", type: "text", required: true },
]

const hiveConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "HiveServer2 host", type: "text", required: true, placeholder: "hive.example.com" },
  { key: "port", label: "Port", type: "number", default: 10000 },
  { key: "database", label: "Database", type: "text" },
  { key: "user", label: "User", type: "text" },
  { key: "password", label: "Password", type: "password" },
  { key: "transport", label: "Transport", type: "text", default: "binary", placeholder: "binary | http" },
]

const webhdfsConfigSchema: ConnectorConfigField[] = [
  { key: "host", label: "NameNode host", type: "text", required: true, placeholder: "nn.example.com" },
  { key: "port", label: "Port", type: "number", default: 50070 },
  { key: "user", label: "Proxy user (doAs)", type: "text" },
  { key: "token", label: "Bearer token", type: "password", help: "Optional — sent as Authorization: Bearer for HA / token-auth clusters." },
  { key: "ssl", label: "SSL", type: "boolean", default: false },
]

export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  { id: "mssql", displayName: "SQL Server", description: "Microsoft SQL Server.", icon: "Database", enabled: true, configSchema: mssqlConfigSchema },
  { id: "postgres", displayName: "PostgreSQL", description: "PostgreSQL — streaming SELECT and batched INSERT.", icon: "Database", enabled: true, configSchema: postgresConfigSchema },
  { id: "oracle", displayName: "Oracle", description: "Oracle Database — streaming SELECT and batched INSERT via node-oracledb.", icon: "Database", enabled: true, configSchema: oracleConfigSchema },
  { id: "databricks", displayName: "Databricks", description: "Databricks SQL warehouse — SELECT / INSERT over the SQL Statements API.", icon: "Database", enabled: true, configSchema: databricksConfigSchema },
  { id: "azure", displayName: "Azure Blob / Data Lake", description: "Read/write CSV or JSON blobs in Azure Storage.", icon: "Cloud", enabled: true, configSchema: azureConfigSchema },
  { id: "aws", displayName: "AWS S3", description: "Read/write CSV or JSON objects in S3.", icon: "Cloud", enabled: true, configSchema: awsConfigSchema },
  { id: "denodo", displayName: "Denodo", description: "Data virtualization layer — read views over REST.", icon: "Network", enabled: true, configSchema: denodoConfigSchema },
  { id: "httpApi", displayName: "HTTP API", description: "Generic REST endpoint (read JSON arrays, write per-row POST/PUT).", icon: "Webhook", enabled: true, configSchema: httpApiConfigSchema },
  { id: "ftp", displayName: "FTP / SFTP", description: "Read/write CSV or JSON files over FTP or SFTP.", icon: "FolderTree", enabled: true, configSchema: ftpConfigSchema },
  { id: "aqueduct", displayName: "Aqueduct", description: "Fetch pipeline preview rows from the Aqueduct API.", icon: "Waves", enabled: true, configSchema: aqueductConfigSchema },
  { id: "hive", displayName: "Hive (HiveServer2)", description: "SQL over Hadoop via HiveServer2 — adapter ready, thrift client binding pending.", icon: "Database", enabled: false, configSchema: hiveConfigSchema },
  { id: "webhdfs", displayName: "HDFS (WebHDFS)", description: "Read/write files on Hadoop HDFS over the WebHDFS REST API (CSV / JSON).", icon: "HardDrive", enabled: true, configSchema: webhdfsConfigSchema },
]

const KIND_INDEX: ReadonlyMap<ConnectorKindId, ConnectorKind> = new Map(
  CONNECTOR_KINDS.map((kind) => [kind.id, kind]),
)

export function getConnectorKind(id: ConnectorKindId): ConnectorKind | undefined {
  return KIND_INDEX.get(id)
}

export function isConnectorKindId(value: unknown): value is ConnectorKindId {
  return typeof value === "string" && KIND_INDEX.has(value as ConnectorKindId)
}

export const ENABLED_CONNECTOR_KINDS: readonly ConnectorKind[] = CONNECTOR_KINDS.filter(
  (kind) => kind.enabled,
)

export function connectorSecretKeys(kind: ConnectorKindId): string[] {
  return (getConnectorKind(kind)?.configSchema ?? [])
    .filter((field) => field.type === "password")
    .map((field) => field.key)
}

/** Mask every secret field of `config` with {@link SECRET_MASK}. */
export function maskConnectorConfig(
  kind: ConnectorKindId,
  config: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = { ...config }
  for (const key of connectorSecretKeys(kind)) {
    if (out[key] !== undefined && out[key] !== null && out[key] !== "") {
      out[key] = SECRET_MASK
    }
  }
  return out
}

export interface ConnectorConfigValidation {
  ok: boolean
  /** First missing required field, or null. */
  error: string | null
  missing: string[]
}

/**
 * Validate a config map against a kind's schema. Pure — usable on both
 * client (live form feedback) and server (before persist).
 */
export function validateConnectorConfig(
  kind: ConnectorKindId,
  config: Record<string, string | number | boolean | null>,
): ConnectorConfigValidation {
  const schema = getConnectorKind(kind)?.configSchema ?? []
  const missing: string[] = []
  for (const field of schema) {
    if (!field.required) continue
    const value = config[field.key]
    if (value === undefined || value === null || value === "") {
      missing.push(field.key)
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required field: ${missing[0]}`,
      missing,
    }
  }
  return { ok: true, error: null, missing: [] }
}

/** Apply schema defaults to a partial config (used on create). */
export function withConnectorConfigDefaults(
  kind: ConnectorKindId,
  config: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const schema = getConnectorKind(kind)?.configSchema ?? []
  const out: Record<string, string | number | boolean | null> = {}
  for (const field of schema) {
    const value = config[field.key]
    if (value !== undefined && value !== null) {
      out[field.key] = value
    } else if (field.default !== undefined) {
      out[field.key] = field.default
    } else {
      out[field.key] = field.type === "boolean" ? false : null
    }
  }
  return out
}

/** Slugify a free-text label into a connector id (kebab-case). */
export function toConnectorId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// ── Bridge (connector row streaming) ──────────────────────────────
//
// Pure domain types for the connector-adapter framework. These are wire/contract
// types shared by @mia/agent (the opaque host port), @mia/connectors (the engine
// + adapter implementations), and @mia/server (boot wiring). No runtime deps here.

/** JSON-ish value carried in a movement row. */
export type MovementValue =
  | string
  | number
  | boolean
  | null
  | MovementValue[]
  | { [key: string]: MovementValue }

/** A single moved record. Keys are column/field names. */
export type Row = Record<string, MovementValue>

export type WriteMode = "append" | "replace"

/** File formats for object-store / WebHDFS Bridge specs. */
export type FileFormat = "csv" | "json" | "parquet"

export type MovementStatus = "completed" | "partial" | "failed"

/** What an adapter can do. Non-SQL kinds set `query`/`write` false as appropriate. */
export interface AdapterCapabilities {
  readonly read: boolean
  readonly write: boolean
  /** SQL-like `SELECT` supported (drives the `query` read spec). */
  readonly query: boolean
}

/** Options forwarded from the Bridge engine into adapter `write`. */
export interface WriteOptions {
  /** Append-mode / non-transactional writers: stop at first row error (default true). */
  readonly stopOnError?: boolean
  readonly signal?: AbortSignal
}

// ── Read specs (discriminated by kind) ───────────────────────────

export interface SqlReadSpec {
  readonly kind: "sql"
  readonly sql: string
}

export interface HttpApiReadSpec {
  readonly kind: "httpApi"
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: unknown
  readonly headers?: Record<string, string>
  /** Dot-path into the JSON response to find the rows array, e.g. "data.items". */
  readonly jsonPath?: string
}

export interface WebhdfsReadSpec {
  readonly kind: "webhdfs"
  readonly path: string
  readonly format: FileFormat
}

export interface DenodoReadSpec {
  readonly kind: "denodo"
  readonly view: string
  readonly params?: Record<string, string>
}

export interface AwsReadSpec {
  readonly kind: "aws"
  readonly path: string
  readonly format: FileFormat
}

export interface AzureReadSpec {
  readonly kind: "azure"
  readonly path: string
  readonly format: FileFormat
}

export interface FtpReadSpec {
  readonly kind: "ftp"
  readonly path: string
  readonly format: FileFormat
}

export interface AqueductReadSpec {
  readonly kind: "aqueduct"
  readonly params?: Record<string, string>
}

export type ReadSpec =
  | SqlReadSpec
  | HttpApiReadSpec
  | WebhdfsReadSpec
  | DenodoReadSpec
  | AwsReadSpec
  | AzureReadSpec
  | FtpReadSpec
  | AqueductReadSpec

// ── Write specs (discriminated by kind) ──────────────────────────

export interface SqlWriteSpec {
  readonly kind: "sql"
  readonly table: string
  readonly mode: WriteMode
  readonly batchSize?: number
  /**
   * Opt-in: insert explicit values into identity / generated columns.
   * MSSQL → `SET IDENTITY_INSERT`; Postgres / Oracle → `OVERRIDING SYSTEM VALUE`.
   * Ignored by hive / databricks. Default off.
   */
  readonly allowIdentityInsert?: boolean
  /**
   * Opt-in: temporarily skip CHECK / FK enforcement for this write.
   * MSSQL → `NOCHECK` / `CHECK CONSTRAINT ALL` on the target table.
   * Postgres → `SET LOCAL session_replication_role = replica` (needs privileges).
   * Oracle → disable then re-enable table constraints (CHECK / FK / UNIQUE).
   * Ignored by hive / databricks. Default off. Always restored after the write.
   */
  readonly relaxConstraints?: boolean
}

export interface HttpApiWriteSpec {
  readonly kind: "httpApi"
  readonly method: "POST" | "PUT"
  readonly path: string
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

export interface WebhdfsWriteSpec {
  readonly kind: "webhdfs"
  readonly path: string
  readonly format: FileFormat
  readonly mode: WriteMode
}

export interface AwsWriteSpec {
  readonly kind: "aws"
  readonly path: string
  readonly format: FileFormat
  readonly mode: WriteMode
}

export interface AzureWriteSpec {
  readonly kind: "azure"
  readonly path: string
  readonly format: FileFormat
  readonly mode: WriteMode
}

export interface FtpWriteSpec {
  readonly kind: "ftp"
  readonly path: string
  readonly format: FileFormat
  readonly mode: WriteMode
}

export type WriteSpec =
  | SqlWriteSpec
  | HttpApiWriteSpec
  | WebhdfsWriteSpec
  | AwsWriteSpec
  | AzureWriteSpec
  | FtpWriteSpec

// ── Transform (declarative, adapter-agnostic, applied row-by-row) ──

export type CastKind = "string" | "number" | "boolean" | "date" | "datetime" | "json"

export interface TransformColumn {
  /** Source column name. */
  readonly from: string
  /** Target column name (defaults to `from` if omitted). */
  readonly to: string
  /** Optional cast applied in the engine (no source-side pushdown). */
  readonly cast?: CastKind
  /** If source is null/undefined/empty, use this value before cast. */
  readonly default?: MovementValue
}

export interface TransformDerive {
  /** Target column name to add. */
  readonly to: string
  /** `${field}` interpolation template — no eval. */
  readonly template: string
}

export interface TransformDefault {
  /** Column to fill when missing/null/empty after projection. */
  readonly column: string
  readonly value: MovementValue
}

export type TransformFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "exists"
  | "empty"

/** Keep a row only when every filter predicate passes (AND). */
export interface TransformFilter {
  readonly column: string
  readonly op: TransformFilterOp
  readonly value?: MovementValue | readonly MovementValue[]
}

export interface Transform {
  /** Column projection + rename + cast. An empty list passes rows through unchanged. */
  readonly columns?: TransformColumn[]
  /** Derived columns appended to each row. */
  readonly derive?: TransformDerive[]
  /** Fill missing/null/empty columns after projection + derive. */
  readonly defaults?: TransformDefault[]
  /** Row keep/drop predicates (AND). Applied after projection/derive/defaults. */
  readonly filter?: TransformFilter[]
}

// ── Movement summary ────────────────────────────────────────────

export interface MovementError {
  readonly row: number
  readonly message: string
}

export interface MoveSummary {
  readonly status: MovementStatus
  readonly rowsRead: number
  readonly rowsWritten: number
  readonly errors: MovementError[]
  /** 0-based index of the row at which the move stopped (set on partial/failed). */
  readonly failedAtRow: number | null
}

// ── Adapter contract ───────────────────────────────────────────

/**
 * A connection to an external system. `read` streams row batches lazily; `write`
 * consumes a row-batch stream. Neither side may buffer the full dataset — the
 * engine relies on this for memory-bounded movement of arbitrary-size data.
 */
export interface ConnectorAdapter {
  readonly kind: ConnectorKindId
  readonly capabilities: AdapterCapabilities
  /** The adapter closes over its connector at factory time, so open takes no args. */
  open(): Promise<void>
  close(): Promise<void>
  read(spec: ReadSpec): AsyncGenerator<Row[]>
  write(
    spec: WriteSpec,
    rows: AsyncGenerator<Row[]>,
    options?: WriteOptions,
  ): Promise<MoveSummary>
}

/** Builds an adapter for one connector instance from its persisted config. */
export type AdapterFactory = (connector: Connector) => ConnectorAdapter

/** A connector + its resolved adapter, for UI/API listing. */
export interface ConnectorInfo {
  readonly id: string
  readonly kind: ConnectorKindId
  readonly name: string
  readonly displayName: string
  readonly enabled: boolean
  readonly capabilities: AdapterCapabilities
}
