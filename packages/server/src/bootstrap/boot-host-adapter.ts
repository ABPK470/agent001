import type { ConfigureAgentOptions } from "@mia/agent"
import type { BootHostDeps } from "../ports/orchestration.js"

/** Map boot-time host deps into configureAgent options for per-run host construction. */
export function bootHostDepsToConfigureAgentOptions(
  bootHostDeps: BootHostDeps
): Partial<ConfigureAgentOptions> {
  return {
    ...(bootHostDeps.attachments ? { attachments: bootHostDeps.attachments } : {}),
    ...(bootHostDeps.shell
      ? {
          shellMode: bootHostDeps.shell.mode,
          shellClient: bootHostDeps.shell.client ?? null,
          shellSandboxStrict: bootHostDeps.shell.sandboxStrict ?? false
        }
      : {}),
    ...(bootHostDeps.mssql
      ? {
          mssqlDatabases: bootHostDeps.mssql.databases,
          mssqlDefaultConnection: bootHostDeps.mssql.defaultConnection,
          ...(bootHostDeps.mssql.pools ? { mssqlPools: bootHostDeps.mssql.pools } : {})
        }
      : {}),
    ...(bootHostDeps.catalog
      ? {
          catalogInstances: bootHostDeps.catalog.instances,
          catalogDefaultCachePath: bootHostDeps.catalog.defaultCachePath
        }
      : {}),
    ...(bootHostDeps.sync ? { sync: bootHostDeps.sync } : {}),
    ...(bootHostDeps.connectors ? { connectors: bootHostDeps.connectors.port.value } : {})
  }
}
