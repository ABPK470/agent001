/**
 * Policy / governance enums.
 *
 * Every value the policy engine reasons about lives here so selector
 * rules, audit log entries, and DB-stored policy rows all reference
 * the same canonical enum (no parallel string-typed contracts).
 */

export const PolicyEffect = {
  Allow: "allow",
  RequireApproval: "require_approval",
  Deny: "deny"
} as const

export type PolicyEffect = (typeof PolicyEffect)[keyof typeof PolicyEffect]

export const POLICY_EFFECTS: ReadonlyArray<PolicyEffect> = Object.values(PolicyEffect)

export const isPolicyEffect = (value: unknown): value is PolicyEffect =>
  typeof value === "string" && (POLICY_EFFECTS as readonly string[]).includes(value)

/** Run profile that drives default-deny semantics. Hosted runs are
 *  default-deny; developer runs are default-allow with audit. */
export const PolicyRunMode = {
  Developer: "developer",
  Hosted: "hosted"
} as const

export type PolicyRunMode = (typeof PolicyRunMode)[keyof typeof PolicyRunMode]

export const POLICY_RUN_MODES: ReadonlyArray<PolicyRunMode> = Object.values(PolicyRunMode)

export const isPolicyRunMode = (value: unknown): value is PolicyRunMode =>
  typeof value === "string" && (POLICY_RUN_MODES as readonly string[]).includes(value)

/** Caller role used by selector rules. */
export const PolicyRole = {
  Admin: "admin",
  HostedUser: "hosted_user",
  Visitor: "visitor"
} as const

export type PolicyRole = (typeof PolicyRole)[keyof typeof PolicyRole]

export const POLICY_ROLES: ReadonlyArray<PolicyRole> = Object.values(PolicyRole)

export const isPolicyRole = (value: unknown): value is PolicyRole =>
  typeof value === "string" && (POLICY_ROLES as readonly string[]).includes(value)

/** Scope axis on a selector rule (which "world" the action targets). */
export const PolicyScope = {
  Sandbox: "sandbox",
  AttachmentStore: "attachment_store",
  AppWorkspace: "app_workspace",
  System: "system"
} as const

export type PolicyScope = (typeof PolicyScope)[keyof typeof PolicyScope]

export const POLICY_SCOPES: ReadonlyArray<PolicyScope> = Object.values(PolicyScope)

export const isPolicyScope = (value: unknown): value is PolicyScope =>
  typeof value === "string" && (POLICY_SCOPES as readonly string[]).includes(value)

/** MSSQL environment a DB operation targets. */
export const PolicyDbEnvironment = {
  Dev: "dev",
  Uat: "uat",
  Prod: "prod"
} as const

export type PolicyDbEnvironment = (typeof PolicyDbEnvironment)[keyof typeof PolicyDbEnvironment]

export const POLICY_DB_ENVIRONMENTS: ReadonlyArray<PolicyDbEnvironment> = Object.values(PolicyDbEnvironment)

export const isPolicyDbEnvironment = (value: unknown): value is PolicyDbEnvironment =>
  typeof value === "string" && (POLICY_DB_ENVIRONMENTS as readonly string[]).includes(value)

/** Categorical DB operation a policy can match against. */
export const PolicyDbOperation = {
  QueryRead: "query_read",
  SyncPreview: "sync_preview",
  SyncExecute: "sync_execute",
  SyncCustomSql: "sync_custom_sql",
  SyncShellExecute: "sync_shell_execute",
  Ddl: "ddl",
  Dml: "dml"
} as const

export type PolicyDbOperation = (typeof PolicyDbOperation)[keyof typeof PolicyDbOperation]

export const POLICY_DB_OPERATIONS: ReadonlyArray<PolicyDbOperation> = Object.values(PolicyDbOperation)

export const isPolicyDbOperation = (value: unknown): value is PolicyDbOperation =>
  typeof value === "string" && (POLICY_DB_OPERATIONS as readonly string[]).includes(value)

/** Network capability tier for a tool — `None` means the tool may not
 *  reach the network at all; `Allow` permits egress. */
export const PolicyNetwork = {
  None: "none",
  Allow: "allow"
} as const

export type PolicyNetwork = (typeof PolicyNetwork)[keyof typeof PolicyNetwork]

export const POLICY_NETWORK_VALUES: ReadonlyArray<PolicyNetwork> = Object.values(PolicyNetwork)

export const isPolicyNetwork = (value: unknown): value is PolicyNetwork =>
  typeof value === "string" && (POLICY_NETWORK_VALUES as readonly string[]).includes(value)
