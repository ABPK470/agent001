/**
 * Auth-domain enums.
 *
 * `UserSource` discriminates how a user account was provisioned —
 * either created locally (password / dev account) or federated via
 * SSO (SAML / OIDC). Persisted in the `users.source` column.
 *
 * @module
 */

export const UserSource = {
  Local: "local",
  Sso: "sso"
} as const

export type UserSource = (typeof UserSource)[keyof typeof UserSource]

export const USER_SOURCES: ReadonlyArray<UserSource> = Object.values(UserSource)

export const isUserSource = (value: unknown): value is UserSource =>
  typeof value === "string" && (USER_SOURCES as readonly string[]).includes(value)
