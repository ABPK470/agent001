import type { ConfigureAgentOptions } from "@mia/agent"
import type { BootHostDeps } from "../ports/orchestration.js"

/**
 * Normalize boot-time host deps into one canonical configureAgent input.
 * This keeps per-run host construction and boot-tool construction aligned.
 */
export function bootHostDepsToConfigureAgentOptions(
  bootHostDeps: BootHostDeps
): Partial<ConfigureAgentOptions> {
  return {
    ...(bootHostDeps.attachments ? { attachments: bootHostDeps.attachments } : {}),
    ...(bootHostDeps.browser ? { browser: bootHostDeps.browser } : {}),
    ...(bootHostDeps.shell
      ? {
          shellMode: bootHostDeps.shell.mode,
          shellClient: bootHostDeps.shell.client ?? null,
          shellSandboxStrict: bootHostDeps.shell.sandboxStrict ?? false
        }
      : {}),
    ...(bootHostDeps.browserCheck
      ? {
          browserCheckMode: bootHostDeps.browserCheck.mode,
          browserCheckClient: bootHostDeps.browserCheck.client ?? null
        }
      : {}),
    ...(bootHostDeps.mssql
      ? {
          mssqlDatabases: bootHostDeps.mssql.databases,
          mssqlDefaultConnection: bootHostDeps.mssql.defaultConnection
        }
      : {}),
    ...(bootHostDeps.catalog
      ? {
          catalogInstances: bootHostDeps.catalog.instances,
          catalogDefaultCachePath: bootHostDeps.catalog.defaultCachePath
        }
      : {}),
    ...(bootHostDeps.sync ? { sync: bootHostDeps.sync } : {})
  }
}
