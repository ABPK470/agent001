import type { ConfigureAgentOptions } from "@mia/agent"
import type { BootHostDeps } from "../../ports/orchestration.js"

/**
 * Normalize boot-time host deps into one canonical configureAgent input.
 * This keeps per-run host construction and boot-tool construction aligned.
 */
export function bootHostDepsToConfigureAgentOptions(bootHostDeps: BootHostDeps): Partial<ConfigureAgentOptions> {
  return {
    ...(bootHostDeps.attachments ? { attachments: bootHostDeps.attachments } : {}),
    ...(bootHostDeps.browserContextReader ? { browserContextReader: bootHostDeps.browserContextReader } : {}),
    ...(bootHostDeps.browserCredentialReader ? { browserCredentialReader: bootHostDeps.browserCredentialReader } : {}),
    ...(bootHostDeps.browserHandoffStore ? { browserHandoffStore: bootHostDeps.browserHandoffStore } : {}),
    ...(bootHostDeps.shell
      ? {
          shellMode: bootHostDeps.shell.mode,
          shellClient: bootHostDeps.shell.client ?? null,
          shellSandboxStrict: bootHostDeps.shell.sandboxStrict ?? false,
        }
      : {}),
    ...(bootHostDeps.browserCheckClient ? { browserCheckClient: bootHostDeps.browserCheckClient } : {}),
    ...(bootHostDeps.mssqlDatabases ? { mssqlDatabases: bootHostDeps.mssqlDatabases } : {}),
    ...(bootHostDeps.mssqlDefaultConnection ? { mssqlDefaultConnection: bootHostDeps.mssqlDefaultConnection } : {}),
    ...(bootHostDeps.catalogInstances ? { catalogInstances: bootHostDeps.catalogInstances } : {}),
    ...(bootHostDeps.catalogDefaultCachePath ? { catalogDefaultCachePath: bootHostDeps.catalogDefaultCachePath } : {}),
    ...(bootHostDeps.syncState ? { syncState: bootHostDeps.syncState } : {}),
  }
}