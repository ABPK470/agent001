/**
 * Environment registry accessors — host Map I/O.
 * Shapes and pure normalize/direction live in domain/core.
 */
import type { SyncEnvironment } from "../domain/environments.js"
import type { SyncEnvironmentRegistryHost } from "../ports/index.js"

/** Configure all environments at once. Replaces any prior config. */
export function replaceEnvironments(host: SyncEnvironmentRegistryHost, envs: SyncEnvironment[]): void {
  host.sync.environments.items.clear()
  for (const e of envs) host.sync.environments.items.set(e.name, e)
}

/** Read the current environment registry. */
export function getEnvironments(host: SyncEnvironmentRegistryHost): SyncEnvironment[] {
  return Array.from(host.sync.environments.items.values())
}

/** Get one environment by name; throws if missing. */
export function getEnvironment(host: SyncEnvironmentRegistryHost, name: string): SyncEnvironment {
  const e = host.sync.environments.items.get(name)
  if (!e) {
    const available = Array.from(host.sync.environments.items.keys()).join(", ") || "none"
    throw new Error(`Unknown environment "${name}". Available: ${available}.`)
  }
  return e
}
