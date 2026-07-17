/** Shipped sync target names — lowercase MSSQL connection ids from sync-environments.json. */
export const BUILTIN_SYNC_ENVIRONMENT_NAMES = ["dev", "uat", "prod"] as const

export type BuiltinSyncEnvironmentName = (typeof BUILTIN_SYNC_ENVIRONMENT_NAMES)[number]

export function isBuiltinSyncEnvironment(name: string): boolean {
  return (BUILTIN_SYNC_ENVIRONMENT_NAMES as readonly string[]).includes(name.toLowerCase())
}
