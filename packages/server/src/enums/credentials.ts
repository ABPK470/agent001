/**
 * Server-only enums for the `credentials` domain.
 */

/** Stored credential kind under tenant browser_credentials. */
export const CredentialKind = {
  Password: "password",
  Totp: "totp",
  CookieJar: "cookie_jar"
} as const

export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind]

export const CREDENTIAL_KINDS: ReadonlyArray<CredentialKind> = Object.values(CredentialKind)

export const isCredentialKind = (value: unknown): value is CredentialKind =>
  typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value)
