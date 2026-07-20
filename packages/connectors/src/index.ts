/**
 * @mia/connectors — connector-adapter framework + streaming Bridge engine.
 */

export {
  applyTransform,
  moveData,
  makeSummary,
  type MoveOptions,
  type MoveSource,
  type MoveTarget,
} from "./engine.js"

export { parseParquet, serializeParquet } from "./parquet.js"

export {
  AdapterRegistry,
  buildConnectorPort,
  connectorInfo,
  type ConnectorPort,
  type ConnectorPortMoveOptions,
  type ConnectorPortMoveSource,
  type ConnectorPortMoveTarget,
  type ConnectorSource,
} from "./registry.js"

export { listTablesSql, tableNameFromRow } from "./list-tables.js"
export {
  quoteMssqlIdent,
  quoteMssqlTable,
  quoteOracleIdent,
  quoteOracleTable,
  quotePgIdent,
  quotePgTable,
  splitOracleTable,
} from "./sql-idents.js"

export {
  createMssqlAdapter,
  type MssqlAdapterOptions,
  type MssqlDriver,
  type MssqlTransaction,
} from "./adapters/mssql.js"

export {
  createPostgresAdapter,
  type PostgresAdapterOptions,
  type PostgresDriver,
  type PostgresInsertOptions,
  type PostgresTransaction,
} from "./adapters/postgres.js"

export {
  createOracleAdapter,
  type OracleAdapterOptions,
  type OracleDriver,
  type OracleInsertOptions,
  type OracleTransaction,
} from "./adapters/oracle.js"

export {
  createHttpApiAdapter,
  type HttpApiAdapterOptions,
  type HttpDriver,
  extractRows as extractHttpRows,
} from "./adapters/http-api.js"

export {
  createDenodoAdapter,
  type DenodoAdapterOptions,
  type DenodoDriver,
} from "./adapters/denodo.js"

export {
  createHiveAdapter,
  type HiveAdapterOptions,
  type HiveClient,
  type HiveDriver,
  type HiveTransaction,
  defaultHiveDriver,
} from "./adapters/hive.js"

export {
  createWebhdfsAdapter,
  type WebhdfsAdapterOptions,
  type WebHdfsDriver,
  parseCsv as parseWebhdfsCsv,
  serializeRows as serializeWebhdfsRows,
} from "./adapters/webhdfs.js"

export {
  createObjectFileAdapter,
  type ObjectFileAdapterOptions,
  type FileTransferDriver,
} from "./adapters/object-file.js"

export {
  createDatabricksAdapter,
  type DatabricksAdapterOptions,
  type DatabricksDriver,
} from "./adapters/databricks.js"

export {
  createAqueductAdapter,
  type AqueductAdapterOptions,
  type AqueductDriver,
} from "./adapters/aqueduct.js"

export {
  defaultMssqlDriver,
  defaultPostgresDriver,
  defaultOracleDriver,
  createOraclePool,
  oracleConnectString,
  defaultHttpDriver,
  defaultDenodoDriver,
  defaultWebhdfsDriver,
  defaultAwsDriver,
  defaultAzureDriver,
  defaultFtpDriver,
  defaultDatabricksDriver,
  defaultAqueductDriver,
  type OraclePool,
} from "./adapters/drivers.js"
